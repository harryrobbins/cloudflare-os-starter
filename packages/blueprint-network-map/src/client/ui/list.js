// @ts-check
// List mode: the map as a spreadsheet-like grid, the accessible alternative to the canvas. Tabs for
// elements, connections and loops; sortable columns; a filter; "only visible in this view"; and
// selection shared with the canvas both ways.
//
// The grid is windowed with one fixed row height: only the rows in and near the scrolled window
// exist in the DOM (absolutely positioned in a body as tall as all rows), so 10,000 rows cost
// about fifty DOM rows. Focus stays on the grid itself; aria-activedescendant names the active
// row, which is always rendered because moving it scrolls it into view.
//
// Keyboard: Up/Down/Home/End/PageUp/PageDown move the active row and select it (Shift extends,
// Space toggles), Enter opens it in the Profile panel, Delete deletes the selection, F2 (or a
// double-click) renames it in place: Enter or leaving the field saves, Escape cancels.

import { h, clear, debounce } from "./dom.js";
import { ensureStyle } from "./css.js";
import { LIMITS, cleanLine, derivedLoopPolarity, fieldApplies, normalizeLabel } from "../../shared/protocol.js";
import { chunk, deleteOps, formatFieldValue, sortRows } from "./profile-logic.js";

const ROW_HEIGHT = 32;
const OVERSCAN = 10;
const FIELD_COLUMNS = 8;
const TABS = /** @type {const} */ ([["elements", "Elements"], ["connections", "Connections"], ["loops", "Loops"]]);
/** @typedef {"elements"|"connections"|"loops"} Tab */

/**
 * @typedef {object} Column
 * @property {string} key         row property shown and sorted by
 * @property {string} title
 * @property {number} width       px
 * @property {boolean} [numeric]
 * @property {(row: any) => any} [cell]  content (default: the value as text)
 */

const STYLE = String.raw`
/* Above the stage's floating status and banners, which belong to the map. */
.nm-list-host { z-index: 6; }
.nml { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--surface); }
.nml-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.nml-tabs { display: flex; gap: 2px; }
.nml-bar input[type="search"] { width: 220px; }
.nml-bar .nml-check { display: inline-flex; gap: 6px; align-items: center; color: var(--text-2); font-size: 13px; }
.nml-count { margin-left: auto; font-size: 12px; color: var(--text-3); white-space: nowrap; }
.nml-grid { flex: 1; min-height: 0; overflow: auto; position: relative; outline: none; font-size: 13px; }
.nml-grid:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.nml-row { display: grid; grid-template-columns: var(--nml-cols); min-width: var(--nml-width); width: 100%; height: ${ROW_HEIGHT}px; align-items: stretch; }
.nml-head { position: sticky; top: 0; z-index: 2; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.nml-head [role="columnheader"] { display: flex; align-items: stretch; min-width: 0; border-right: 1px solid var(--border); }
.nml-head button {
  flex: 1; display: flex; align-items: center; gap: 4px; min-width: 0; border: 0; background: transparent; padding: 0 8px;
  font-weight: 600; color: var(--text-2); text-align: left; font-size: 12px;
}
.nml-head button:hover { background: rgba(127, 127, 127, .14); color: var(--text); }
.nml-head .num button { justify-content: flex-end; }
.nml-head .nml-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nml-sort { width: 10px; flex: none; color: var(--accent); }
.nml-body { position: relative; min-width: var(--nml-width); }
.nml-body .nml-row { position: absolute; left: 0; right: 0; border-bottom: 1px solid var(--border); cursor: default; }
.nml-body .nml-row:hover { background: rgba(127, 127, 127, .07); }
.nml-body .nml-row[aria-selected="true"] { background: var(--accent-soft); }
.nml-body .nml-row.active { box-shadow: inset 3px 0 0 var(--accent); }
.nml-grid:focus .nml-row.active { box-shadow: inset 3px 0 0 var(--accent), inset 0 0 0 1px var(--accent); }
.nml-row [role="gridcell"] { display: flex; align-items: center; gap: 6px; padding: 0 8px; min-width: 0; overflow: hidden; white-space: nowrap; }
.nml-row [role="gridcell"] > .nml-text { overflow: hidden; text-overflow: ellipsis; }
.nml-row .num { justify-content: flex-end; font-variant-numeric: tabular-nums; }
.nml-row .nml-label { font-weight: 550; color: var(--text); }
.nml-row .muted { font-size: 12px; }
.nml-row input.nml-edit { width: 100%; height: 26px; padding: 2px 6px; font-weight: 550; }
.nml-row .chip { font-size: 11px; padding: 0 6px; }
.nml-dir { justify-content: center; color: var(--text-3); }
.nml-pol-plus { color: var(--ok); font-weight: 700; }
.nml-pol-minus { color: var(--danger); font-weight: 700; }
.nml-empty { padding: 24px; color: var(--text-3); text-align: center; }
@media (max-width: 760px) {
  .nml-bar input[type="search"] { width: 100%; order: 3; }
  .nml-count { margin-left: 0; }
}
`;

/** @param {HTMLElement} host @param {any} app */
export function mountList(host, app) {
  ensureStyle("list", STYLE);
  const store = app.store;
  const get = (/** @type {string} */ id) => store.objects.get(id);

  /** @type {Tab} */
  let tab = "elements";
  /** @type {Record<Tab, {key: string, dir: "ascending"|"descending"}>} */
  const sorts = { elements: { key: "label", dir: "ascending" }, connections: { key: "from", dir: "ascending" }, loops: { key: "label", dir: "ascending" } };
  let query = "";
  let onlyVisible = false;
  /** @type {Column[]} */
  let columns = [];
  /** @type {any[]} */
  let rows = [];
  /** @type {Map<string, number>} id -> row index */
  let rowIndex = new Map();
  /** Bumped whenever rows or columns are recomputed; row elements built earlier are stale. */
  let generation = 0;
  /** @type {Map<string, {el: HTMLElement, stamp: string}>} rendered rows by id */
  let built = new Map();
  let active = 0;
  /** @type {number|null} Shift range anchor */
  let anchor = null;
  /** @type {{id: string, input: HTMLInputElement}|null} */
  let editing = null;
  let stale = true;
  /** Set while this list changes the selection, so the echo does not scroll. */
  let selecting = false;

  // --- DOM ---------------------------------------------------------------------------------------

  const tabButtons = TABS.map(([id, label]) => h("button", {
    type: "button", class: "btn small", role: "tab", "aria-selected": String(id === tab), "aria-controls": "nml-grid",
    onclick: () => setTab(id),
  }, label));
  const tabsEl = h("div", { class: "nml-tabs", role: "tablist", "aria-label": "What to list" }, tabButtons);
  tabsEl.addEventListener("keydown", (e) => {
    const i = tabButtons.indexOf(/** @type {any} */ (e.target));
    if (i < 0 || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
    e.preventDefault();
    const next = (i + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    tabButtons[next].focus();
    setTab(TABS[next][0]);
  });
  const applyFilter = debounce(() => { query = normalizeLabel(filterInput.value); refresh(); }, 120);
  const filterInput = /** @type {HTMLInputElement} */ (h("input", { type: "search", placeholder: "Filter…", "aria-label": "Filter rows", oninput: applyFilter }));
  filterInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { applyFilter.flush(); grid.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); applyFilter.flush(); grid.focus(); }
  });
  const visibleBox = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", onchange: () => { onlyVisible = visibleBox.checked; refresh(); } }));
  const countEl = h("span", { class: "nml-count" });
  const bar = h("div", { class: "nml-bar" }, tabsEl, filterInput, h("label", { class: "nml-check" }, visibleBox, "Only visible in this view"), countEl);

  const head = h("div", { class: "nml-row nml-head", role: "row", "aria-rowindex": "1" });
  const body = h("div", { class: "nml-body", role: "rowgroup" });
  const emptyEl = h("div", { class: "nml-empty", hidden: true });
  const grid = h("div", {
    class: "nml-grid", id: "nml-grid", role: "grid", tabindex: "0", "aria-multiselectable": "true",
  }, h("div", { role: "rowgroup" }, head), body, emptyEl);
  const root = h("div", { class: "nml" }, bar, grid);
  clear(host).appendChild(root);

  // --- Rows ----------------------------------------------------------------------------------------

  /** Columns of the current tab. @returns {Column[]} */
  function columnsFor() {
    const m = app.model;
    const viewCol = { key: "hidden", title: "In view", width: 90, cell: (/** @type {any} */ r) => (r.hidden ? h("span", { class: "chip", title: "Hidden by this view" }, "Hidden") : h("span", { class: "muted" }, "Shown")) };
    if (tab === "elements") {
      const defs = [...m.index.fields.values()].filter((d) => fieldApplies(d, "element")).slice(0, FIELD_COLUMNS);
      return [
        { key: "label", title: "Label", width: 220, cell: (r) => h("span", { class: "nml-text nml-label" }, r.label) },
        { key: "type", title: "Type", width: 130, cell: (r) => [r.color ? h("span", { class: "swatch-dot", style: { background: r.color } }) : null, h("span", { class: "nml-text" }, r.type)] },
        { key: "degree", title: "Connections", width: 104, numeric: true },
        { key: "tags", title: "Tags", width: 160 },
        ...defs.map((d) => ({
          key: `f:${d.id}`, title: d.name, width: d.kind === "longtext" ? 200 : 130, numeric: d.kind === "number",
          cell: (/** @type {any} */ r) => h("span", { class: "nml-text" }, formatFieldValue(d, r[`f:${d.id}`])),
        })),
        viewCol,
      ];
    }
    if (tab === "connections") {
      return [
        { key: "from", title: "From", width: 190, cell: (r) => h("span", { class: "nml-text nml-label" }, r.from) },
        { key: "dir", title: "Dir.", width: 52, cell: (r) => h("span", { "aria-label": r.direction }, r.dir) },
        { key: "to", title: "To", width: 190, cell: (r) => h("span", { class: "nml-text nml-label" }, r.to) },
        { key: "type", title: "Type", width: 120, cell: (r) => [r.color ? h("span", { class: "swatch-dot", style: { background: r.color } }) : null, h("span", { class: "nml-text" }, r.type)] },
        { key: "label", title: "Label", width: 170 },
        { key: "polarity", title: "Polarity", width: 84, cell: (r) => h("span", { class: r.polarity === "+" ? "nml-pol-plus" : r.polarity === "−" ? "nml-pol-minus" : "muted", "aria-label": r.polarityName }, r.polarity) },
        { key: "strength", title: "Strength", width: 90, numeric: true },
        viewCol,
      ];
    }
    return [
      { key: "label", title: "Label", width: 260, cell: (r) => h("span", { class: "nml-text nml-label" }, r.label) },
      { key: "steps", title: "Steps", width: 80, numeric: true },
      { key: "cls", title: "Class", width: 120 },
    ];
  }

  /** Every row of the current tab, unfiltered. */
  function buildRows() {
    const m = app.model;
    const typeOf = (/** @type {any} */ o) => (o.typeId ? m.index.types.get(o.typeId) : null);
    if (tab === "elements") {
      const defs = [...m.index.fields.values()].filter((d) => fieldApplies(d, "element")).slice(0, FIELD_COLUMNS);
      return [...m.index.elements.values()].map((e) => {
        const t = typeOf(e);
        /** @type {Record<string, any>} */
        const r = {
          id: e.id, label: e.label, type: t?.name ?? "", color: t?.color ?? null, degree: m.index.degrees.get(e.id)?.degree ?? 0,
          tags: (e.tags ?? []).join(", "), hidden: !m.nodes.has(e.id),
        };
        for (const d of defs) {
          const v = e.fields?.[d.id];
          r[`f:${d.id}`] = d.kind === "number" ? v : v === undefined ? "" : typeof v === "string" ? v : formatFieldValue(d, v);
        }
        r.search = normalizeLabel([e.label, ...(e.aliases ?? []), r.type, r.tags].join(" "));
        return r;
      });
    }
    if (tab === "connections") {
      return [...m.index.connections.values()].map((c) => {
        const t = typeOf(c);
        const from = get(c.from)?.label ?? "?", to = get(c.to)?.label ?? "?";
        const polarity = c.polarity === "+" ? "+" : c.polarity === "-" ? "−" : "?";
        return {
          id: c.id, from, to, direction: c.direction, dir: c.direction === "mutual" ? "↔" : c.direction === "undirected" ? "—" : "→",
          type: t?.name ?? "", color: t?.color ?? null, label: c.label ?? "", polarity,
          polarityName: polarity === "+" ? "positive" : polarity === "−" ? "negative" : "unknown",
          strength: c.strength, hidden: !m.edges.has(c.id), search: normalizeLabel(`${from} ${to} ${c.label ?? ""} ${t?.name ?? ""}`),
        };
      });
    }
    return [...m.loops.values()].map((l) => {
      const derived = derivedLoopPolarity(l.steps ?? [], get);
      const cls = l.classification ?? null;
      return {
        id: l.id, label: l.label, steps: (l.steps ?? []).length, hidden: false, search: normalizeLabel(l.label),
        cls: cls ? `${cls}${derived && derived !== cls ? ` (derived ${derived})` : ""}` : derived ? `— (derived ${derived})` : "—",
      };
    });
  }

  /** Recomputes the rows (filter and sort) and renders. */
  function refresh() {
    if (!app.model) return;
    if (editing) { stale = true; return; }
    stale = false;
    const activeId = rows[active]?.id ?? null;
    columns = columnsFor();
    let list = buildRows();
    if (onlyVisible) list = list.filter((r) => !r.hidden);
    if (query) list = list.filter((r) => r.search.includes(query));
    const sort = sorts[tab];
    if (!columns.some((c) => c.key === sort.key)) sort.key = columns[0].key;
    rows = sortRows(list, sort.key, sort.dir);
    rowIndex = new Map(rows.map((r, i) => [r.id, i]));
    generation++;
    active = activeId !== null && rowIndex.has(activeId) ? /** @type {number} */ (rowIndex.get(activeId)) : Math.min(active, Math.max(0, rows.length - 1));
    const total = tab === "elements" ? app.model.index.elements.size : tab === "connections" ? app.model.index.connections.size : app.model.loops.size;
    countEl.textContent = rows.length === total ? `${total.toLocaleString()} ${tab}` : `${rows.length.toLocaleString()} of ${total.toLocaleString()} ${tab}`;
    grid.setAttribute("aria-label", `${TABS.find(([id]) => id === tab)?.[1]}: ${countEl.textContent}`);
    grid.setAttribute("aria-rowcount", String(rows.length + 1));
    grid.setAttribute("aria-colcount", String(columns.length));
    grid.style.setProperty("--nml-cols", columns.map((c, i) => (i === 0 ? `minmax(${c.width}px, 1fr)` : `${c.width}px`)).join(" "));
    grid.style.setProperty("--nml-width", `${columns.reduce((n, c) => n + c.width, 0)}px`);
    renderHead();
    body.style.height = `${rows.length * ROW_HEIGHT}px`;
    emptyEl.hidden = rows.length > 0;
    emptyEl.textContent = query || onlyVisible ? "No rows match." : tab === "loops" ? "No loops yet. Select the connections of a cycle and use Create loop in the Profile panel." : `No ${tab} yet.`;
    renderRows();
  }

  function renderHead() {
    const sort = sorts[tab];
    head.replaceChildren(...columns.map((c, i) => {
      const dir = sort.key === c.key ? sort.dir : "none";
      return h("div", { role: "columnheader", "aria-colindex": String(i + 1), "aria-sort": dir, class: c.numeric ? "num" : null },
        h("button", { type: "button", title: `Sort by ${c.title}`, onclick: () => sortBy(c.key) },
          h("span", { class: "nml-title" }, c.title),
          h("span", { class: "nml-sort", "aria-hidden": "true" }, dir === "ascending" ? "▲" : dir === "descending" ? "▼" : "")));
    }));
  }

  /** @param {string} key */
  function sortBy(key) {
    const sort = sorts[tab];
    sort.dir = sort.key === key && sort.dir === "ascending" ? "descending" : "ascending";
    sort.key = key;
    refresh();
    app.announce(`Sorted by ${columns.find((c) => c.key === key)?.title}, ${sort.dir}`);
  }

  /**
   * Renders the rows in and near the scrolled window. A row's element is kept while its content
   * is unchanged (selection and the active mark are updated in place), so a click never replaces
   * the row under the pointer and a double-click reaches it.
   */
  function renderRows() {
    const viewport = grid.clientHeight || ROW_HEIGHT * 20;
    const top = Math.max(0, grid.scrollTop - ROW_HEIGHT);
    const start = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(rows.length, Math.ceil((top + viewport) / ROW_HEIGHT) + OVERSCAN);
    const wanted = [];
    for (let i = start; i < end; i++) wanted.push(i);
    const editIndex = editing ? rowIndex.get(editing.id) : undefined;
    if (editIndex !== undefined && (editIndex < start || editIndex >= end)) wanted.push(editIndex);
    /** @type {Map<string, {el: HTMLElement, stamp: string}>} */
    const next = new Map();
    const out = wanted.map((i) => {
      const r = rows[i];
      const stamp = `${generation}:${i}:${editing?.id === r.id}`;
      let entry = built.get(r.id);
      if (!entry || entry.stamp !== stamp) entry = { el: renderRow(i), stamp };
      next.set(r.id, entry);
      entry.el.setAttribute("aria-selected", String(app.selection.has(r.id)));
      entry.el.classList.toggle("active", i === active);
      return entry.el;
    });
    built = next;
    const current = body.children;
    if (current.length !== out.length || out.some((el, i) => current[i] !== el)) body.replaceChildren(...out);
    if (rows[active]) grid.setAttribute("aria-activedescendant", rowDomId(rows[active].id));
    else grid.removeAttribute("aria-activedescendant");
  }

  /** @param {string} id */
  const rowDomId = (id) => `nml-row-${id}`;

  /** @param {number} i */
  function renderRow(i) {
    const r = rows[i];
    const el = h("div", {
      class: "nml-row", role: "row", id: rowDomId(r.id), "aria-rowindex": String(i + 2),
      dataset: { id: r.id, index: String(i) }, style: { top: `${i * ROW_HEIGHT}px` },
    });
    const edit = editing?.id === r.id ? editing : null;
    columns.forEach((c, ci) => {
      const cell = h("div", { role: "gridcell", "aria-colindex": String(ci + 1), class: c.numeric ? "num" : null });
      if (ci === 0 && edit) cell.appendChild(edit.input);
      else {
        const content = c.cell ? c.cell(r) : r[c.key] === undefined || r[c.key] === null ? "" : String(r[c.key]);
        if (typeof content === "string") cell.appendChild(h("span", { class: "nml-text" }, content));
        else cell.append(...[content].flat().filter(Boolean));
      }
      el.appendChild(cell);
    });
    return el;
  }

  // --- Navigation and selection ------------------------------------------------------------------

  /** Scrolls row `i` into the window. @param {number} i */
  function reveal(i) {
    const headH = head.offsetHeight || ROW_HEIGHT;
    const y = i * ROW_HEIGHT;
    const view = grid.clientHeight - headH;
    if (y < grid.scrollTop) grid.scrollTop = y;
    else if (view > 0 && y + ROW_HEIGHT > grid.scrollTop + view) grid.scrollTop = y + ROW_HEIGHT - view;
  }

  /** @param {Iterable<string>} ids @param {{add?: boolean}} [opts] */
  function select(ids, opts = {}) {
    selecting = true;
    try { app.select(ids, opts); } finally { selecting = false; }
  }

  /** @param {number} i @param {{extend?: boolean, keepSelection?: boolean}} [opts] */
  function moveTo(i, opts = {}) {
    if (!rows.length) return;
    active = Math.max(0, Math.min(rows.length - 1, i));
    reveal(active);
    if (opts.extend && anchor !== null) {
      const [a, b] = anchor < active ? [anchor, active] : [active, anchor];
      select(rows.slice(a, b + 1).map((r) => r.id));
    } else if (!opts.keepSelection) {
      anchor = active;
      select([rows[active].id]);
    }
    renderRows();
  }

  grid.addEventListener("keydown", (e) => {
    if (editing || e.target !== grid) return;
    const page = Math.max(1, Math.floor((grid.clientHeight - ROW_HEIGHT) / ROW_HEIGHT) - 1);
    const extend = e.shiftKey;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); moveTo(active + 1, { extend }); break;
      case "ArrowUp": e.preventDefault(); moveTo(active - 1, { extend }); break;
      case "PageDown": e.preventDefault(); moveTo(active + page, { extend }); break;
      case "PageUp": e.preventDefault(); moveTo(active - page, { extend }); break;
      case "Home": e.preventDefault(); moveTo(0, { extend }); break;
      case "End": e.preventDefault(); moveTo(rows.length - 1, { extend }); break;
      case " ":
        if (!rows[active]) return;
        e.preventDefault();
        anchor = active;
        select([rows[active].id], { add: true });
        break;
      case "Enter":
        if (!rows[active]) return;
        e.preventDefault();
        openInProfile(rows[active].id);
        break;
      case "F2":
        e.preventDefault();
        startEdit(active);
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        deleteSelection();
        break;
      case "Escape":
        if (app.selection.size) { e.preventDefault(); select([]); }
        break;
      default:
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
          e.preventDefault();
          select(rows.map((r) => r.id));
          app.announce(`Selected ${rows.length} rows`);
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
          e.preventDefault();
          if (e.shiftKey) store.redo(); else store.undo();
        }
    }
  });

  /** @param {string} id */
  function openInProfile(id) {
    if (!app.selection.has(id) || app.selection.size !== 1) select([id]);
    app.setPanel("profile");
    app.announce("Opened in the Profile panel");
  }

  function deleteSelection() {
    const ops = deleteOps(app.selection, get);
    if (!ops.length) return;
    for (const part of chunk(ops)) app.apply(part);
    select([]);
    app.announce(`Deleted ${ops.length} item${ops.length === 1 ? "" : "s"}`);
  }

  /** @param {MouseEvent} e */
  const rowAt = (e) => /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest?.(".nml-body .nml-row"));
  body.addEventListener("click", (e) => {
    const el = rowAt(e);
    if (!el || editing?.id === el.dataset.id) return;
    const i = Number(el.dataset.index);
    if (e.shiftKey && anchor !== null) {
      active = i;
      moveTo(i, { extend: true });
    } else if (e.ctrlKey || e.metaKey) {
      active = i;
      anchor = i;
      select([rows[i].id], { add: true });
      renderRows();
    } else moveTo(i);
    grid.focus({ preventScroll: true });
  });
  body.addEventListener("dblclick", (e) => {
    const el = rowAt(e);
    if (el) startEdit(Number(el.dataset.index));
  });

  // --- Inline rename -----------------------------------------------------------------------------

  /** @param {number} i */
  function startEdit(i) {
    const r = rows[i];
    if (!r || editing) return;
    const o = get(r.id);
    if (!o) return;
    active = i;
    reveal(i);
    const input = /** @type {HTMLInputElement} */ (h("input", {
      type: "text", class: "nml-edit", maxlength: LIMITS.label, "aria-label": r.id[0] === "c" ? "Connection label" : "Label",
    }));
    input.value = o.label ?? "";
    let done = false;
    const finish = (/** @type {boolean} */ save) => {
      if (done) return;
      done = true;
      const value = cleanLine(input.value, LIMITS.label);
      const current = get(r.id);
      editing = null;
      if (save && current && value !== (current.label ?? "")) {
        if (value || r.id[0] === "c") app.apply([{ op: "update", id: r.id, patch: { label: value || null } }]);
        else app.toast("A label cannot be empty.");
      }
      if (stale) refresh(); else renderRows();
      grid.focus({ preventScroll: true });
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("dblclick", (e) => e.stopPropagation());
    editing = { id: r.id, input };
    renderRows();
    input.focus();
    input.select();
  }

  // --- Tabs and wiring ---------------------------------------------------------------------------

  /** @param {Tab} next */
  function setTab(next) {
    if (next === tab) return;
    tab = next;
    tabButtons.forEach((b, i) => b.setAttribute("aria-selected", String(TABS[i][0] === tab)));
    active = 0;
    anchor = null;
    grid.scrollTop = 0;
    refresh();
    followSelection();
  }

  /** Makes the first selected row of this tab the active one and scrolls to it. */
  function followSelection() {
    for (const id of app.selection) {
      const i = rowIndex.get(id);
      if (i === undefined) continue;
      active = i;
      anchor = i;
      reveal(i);
      break;
    }
    renderRows();
  }

  let scrollQueued = false;
  grid.addEventListener("scroll", () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; renderRows(); });
  });

  const shown = () => app.mode === "list" && !host.hidden;
  const offModel = app.on("model", () => { if (shown()) refresh(); else stale = true; });
  const offSelection = app.on("selection", () => {
    if (!shown()) return;
    if (selecting) renderRows();
    else followSelection();
  });
  const offMode = app.on("mode", () => { if (shown()) { if (stale || !rows.length) refresh(); followSelection(); } });
  const offView = app.on("view", () => { if (shown()) refresh(); else stale = true; });
  refresh();
  followSelection();

  return {
    destroy() {
      offModel(); offSelection(); offMode(); offView();
      applyFilter.cancel();
      root.remove();
    },
  };
}
