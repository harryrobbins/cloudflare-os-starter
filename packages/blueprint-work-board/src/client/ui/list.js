// @ts-check
// The list layout: an ARIA grid of the same filtered items, grouped by the view's column property
// with collapsible group rows, sortable column headers (aria-sort), a roving cell focus
// (arrows, Home/End, PageUp/PageDown), and windowing for long lists.

import { h, reconcile, focus as focusEl, shortDate, relativeTime, setChildren } from "./dom.js";
import { icon, priorityIcon } from "./icons.js";
import { actorTitle, avatar, fitChips, itemStateIcon, stateOf, pendingLabel } from "./card.js";
import { PRIORITIES } from "../../shared/model/work.js";
import { personName } from "../../shared/model/index.js";
import { property } from "../../shared/model/properties.js";

export const ROW_H = 40;
const WINDOW_MIN = 150;

/**
 * @typedef {import("../../shared/model/index.js").ItemView} ItemView
 * @typedef {import("../../shared/model/index.js").WorkIndex} WorkIndex
 * @typedef {{ id: string, label: string, sort?: string, width: string, render: (item: ItemView, m: ListModel) => (Node|string|null)[]|Node|string|null, text?: (item: ItemView, m: ListModel) => string }} Column
 * @typedef {{ kind: "group", key: string, label: string, count: number, collapsed: boolean, color?: string }
 *   | { kind: "item", key: string, item: ItemView, pending: import("../store/store.js").Change|null }} Row
 * @typedef {{
 *   items: ItemView[], index: WorkIndex, today: string, now: number, groupBy: string|null, columns: string[],
 *   sort: { field: string, dir: "asc"|"desc" }[], collapsed: Set<string>, focus: { row: string, col: number }|null,
 *   selected: Set<string>, pendingFor: (id: string) => import("../store/store.js").Change|null, label: string,
 *   ctx: { index: WorkIndex, today: string, viewer: string|null }, canWrite: boolean,
 * }} ListModel
 */

/** @type {Record<string, Column>} */
export const LIST_COLUMNS = {
  key: { id: "key", label: "Key", sort: "key", width: "92px", render: (i) => h("span", { class: "card-key" }, i.key) },
  title: { id: "title", label: "Title", sort: "title", width: "minmax(220px, 1fr)", render: (i, m) => [
    m.canWrite ? h("label", { class: "check-hit row-check", "data-action": "select" }, h("input", { type: "checkbox", tabindex: "-1", checked: m.selected.has(i.id), "aria-label": `Select ${i.key}` })) : null,
    h("span", { class: "row-title" }, i.title || "Untitled")] },
  state: { id: "state", label: "State", sort: "state", width: "150px", render: (i, m) => [itemStateIcon(i, m.index, { size: 13 }), h("span", null, stateOf(i, m.index)?.name ?? i.state)], text: (i, m) => stateOf(i, m.index)?.name ?? "" },
  priority: { id: "priority", label: "Priority", sort: "priority", width: "120px", render: (i) => (i.priority ? [priorityIcon(i.priority), h("span", null, PRIORITIES[i.priority].name)] : h("span", { class: "muted" }, "—")) },
  assignee: { id: "assignee", label: "Assignee", sort: "assignee", width: "170px", render: (i, m) => (i.assignee ? [avatar(i.assignee, m.index, 18), h("span", { class: "ellipsis", title: actorTitle(i.assignee, personName(m.index, i.assignee)) }, personName(m.index, i.assignee))] : h("span", { class: "muted" }, "Unassigned")) },
  labels: { id: "labels", label: "Labels", width: "minmax(160px, 1fr)", render: (i, m) => {
    if (!i.labels.length) return null;
    const names = i.labels.map((l) => m.index.labelByKey.get(l)?.name ?? l);
    const n = fitChips(names, 170);
    const rest = names.slice(n).join(", ");
    return [...names.slice(0, n).map((name, k) => h("span", { class: "chip label" }, h("span", { class: "dot", style: { background: m.index.labelByKey.get(i.labels[k])?.color ?? "#8a8f98" } }), name)),
      n < names.length ? h("span", { class: "chip more", title: rest, "aria-label": `${names.length - n} more labels: ${rest}` }, `+${names.length - n}`) : null];
  } },
  estimate: { id: "estimate", label: "Estimate", sort: "estimate", width: "84px", render: (i) => (i.estimate === null ? h("span", { class: "muted" }, "—") : String(i.estimate)) },
  due: { id: "due", label: "Due", sort: "due", width: "96px", render: (i, m) => (i.due ? h("span", { class: i.due < m.today && i.category !== "done" ? "overdue" : "" }, shortDate(i.due, m.today), i.due < m.today && i.category !== "done" ? h("span", { class: "sr-only" }, ", overdue") : null) : h("span", { class: "muted" }, "—")) },
  project: { id: "project", label: "Project", sort: "project", width: "150px", render: (i, m) => (i.project ? h("span", { class: "ellipsis" }, m.index.projectById.get(i.project)?.name ?? "") : h("span", { class: "muted" }, "—")) },
  cycle: { id: "cycle", label: "Cycle", sort: "cycle", width: "110px", render: (i, m) => (i.cycle ? m.index.cycleById.get(i.cycle)?.name ?? "" : h("span", { class: "muted" }, "—")) },
  updated: { id: "updated", label: "Updated", sort: "updated", width: "110px", render: (i, m) => (i.updated ? relativeTime(i.updated, m.now) : h("span", { class: "muted" }, "—")) },
  created: { id: "created", label: "Created", sort: "created", width: "110px", render: (i, m) => (i.created ? relativeTime(i.created, m.now) : h("span", { class: "muted" }, "—")) },
  created_by: { id: "created_by", label: "Creator", width: "150px", render: (i, m) => (i.created_by ? h("span", { class: "ellipsis" }, personName(m.index, i.created_by)) : "—") },
};

/** @param {ListModel} m @returns {Row[]} */
function buildRows(m) {
  const prop = m.groupBy ? property(m.groupBy) : null;
  if (!prop) return m.items.map((item) => ({ kind: "item", key: item.id, item, pending: m.pendingFor(item.id) }));
  const groups = prop.groups(m.ctx, m.items);
  /** @type {Map<string, ItemView[]>} */
  const by = new Map(groups.map((g) => [g.key, []]));
  for (const item of m.items) for (const k of prop.keysOf(item, m.ctx)) (by.get(k) ?? by.set(k, []).get(k))?.push(item);
  /** @type {Row[]} */
  const out = [];
  for (const g of groups) {
    const list = by.get(g.key) ?? [];
    if (!list.length) continue;
    const collapsed = m.collapsed.has(`list:${g.key}`);
    out.push({ kind: "group", key: `g:${g.key}`, label: g.label, count: list.length, collapsed, color: g.color });
    if (!collapsed) for (const item of list) out.push({ kind: "item", key: prop.multi ? `${item.id}@${g.key}` : item.id, item, pending: m.pendingFor(item.id) });
  }
  return out;
}

/** @param {{ doc: Document, onAction: (type: string, payload?: any) => void }} opts */
export function createListView({ doc, onAction }) {
  const head = h("div", { class: "lg-head", role: "row" });
  const body = h("div", { class: "lg-body", role: "rowgroup" });
  const table = h("div", { class: "list-grid", role: "grid", "aria-multiselectable": "true" }, h("div", { role: "rowgroup", class: "lg-headgroup" }, head), body);
  const scroller = h("div", { class: "list-scroll" }, table);
  const el = h("div", { class: "list-view" }, scroller);
  /** @type {ListModel|null} */
  let model = null;
  /** @type {Row[]} */
  let rows = [];
  let raf = 0;

  /** @param {ListModel} m */
  function columnsOf(m) {
    const cols = m.columns.map((c) => LIST_COLUMNS[c]).filter(Boolean);
    if (!cols.some((c) => c.id === "title")) cols.unshift(LIST_COLUMNS.title);
    return m.index.planning ? cols : cols.filter((c) => ["key", "title", "state", "updated", "created", "created_by"].includes(c.id));
  }

  /** @param {ListModel} m */
  function update(m) {
    model = m;
    const cols = columnsOf(m);
    const template = cols.map((c) => c.width).join(" ");
    table.style.setProperty("--lg-cols", template);
    table.setAttribute("aria-label", m.label);
    table.setAttribute("aria-colcount", String(cols.length));
    reconcile(head, cols, {
      key: (c) => c.id,
      create: () => h("div", { role: "columnheader", class: "lg-th" }),
      update: (node, c) => {
        const s = m.sort.find((x) => x.field === c.sort);
        const primary = m.sort[0]?.field === c.sort;
        node.setAttribute("aria-sort", primary && s ? (s.dir === "asc" ? "ascending" : "descending") : "none");
        const sig = `${c.id}|${primary ? s?.dir : ""}`;
        if (/** @type {HTMLElement} */ (node).dataset.sig === sig) return;
        /** @type {HTMLElement} */ (node).dataset.sig = sig;
        setChildren(node, c.sort
          ? h("button", { type: "button", class: "th-btn", onclick: () => onAction("sort", c.sort), title: `Sort by ${c.label.toLowerCase()}` }, c.label,
            primary && s ? h("span", { class: "sort-dir", "aria-hidden": "true" }, s.dir === "asc" ? "↑" : "↓") : null)
          : h("span", { class: "th-text" }, c.label));
      },
    });
    rows = buildRows(m);
    table.setAttribute("aria-rowcount", String(rows.length + 1));
    renderRows();
  }

  function renderRows() {
    if (!model) return;
    const m = model;
    const cols = columnsOf(m);
    let start = 0, end = rows.length;
    if (rows.length > WINDOW_MIN) {
      const view = scroller.getBoundingClientRect();
      const height = scroller.clientHeight || view.height || 800;
      start = Math.max(0, Math.floor(scroller.scrollTop / ROW_H) - 10);
      end = Math.min(rows.length, Math.ceil((scroller.scrollTop + height) / ROW_H) + 10);
      // A focused row outside the window is brought back by focusCurrent() (it scrolls there).
    }
    let padTop = start * ROW_H, padBottom = (rows.length - end) * ROW_H;
    const focusRow = m.focus?.row ?? null;
    /** @type {{ r: Row, i: number }[]} */
    let shown = rows.slice(start, end).map((r, i) => ({ r, i: start + i }));
    // The focused row stays in the DOM when scrolled out of the window (pinned beside it).
    const fi = focusRow ? rows.findIndex((r) => r.key === focusRow) : -1;
    if (fi >= 0 && fi < start) { shown = [{ r: rows[fi], i: fi }, ...shown]; padTop -= ROW_H; }
    else if (fi >= end) { shown = [...shown, { r: rows[fi], i: fi }]; padBottom -= ROW_H; }
    body.style.paddingTop = `${padTop}px`;
    body.style.paddingBottom = `${padBottom}px`;
    reconcile(body, shown, {
      key: ({ r }) => r.key,
      create: ({ r }) => h("div", { role: "row", class: r.kind === "group" ? "lg-group" : "lg-row" }),
      update: (node, { r, i }) => {
        const row = /** @type {HTMLElement} */ (node);
        row.setAttribute("aria-rowindex", String(i + 2));
        if (r.kind === "group") {
          const sig = `${r.label}|${r.count}|${r.collapsed}|${focusRow === r.key}`;
          if (row.dataset.sig === sig) return;
          row.dataset.sig = sig;
          setChildren(row, h("div", { role: "rowheader", class: "lg-grouphead", "aria-colspan": String(cols.length) },
            h("button", { type: "button", class: "lane-toggle", tabindex: focusRow === r.key ? "0" : "-1", "data-row": r.key, "data-col": "0", "aria-expanded": String(!r.collapsed), onclick: () => onAction("toggleGroup", r.key.slice(2)) },
              h("span", { class: "chev", "aria-hidden": "true" }, icon(r.collapsed ? "chevronRight" : "chevronDown")),
              r.color ? h("span", { class: "dot", style: { background: r.color } }) : null,
              h("span", { class: "lane-name" }, r.label), h("span", { class: "lane-count" }, String(r.count)), h("span", { class: "sr-only" }, " items"))));
          return;
        }
        const item = r.item;
        const selected = m.selected.has(item.id);
        const focusCol = focusRow === r.key ? m.focus?.col ?? 0 : -1;
        const sig = `${item.revision}|${item.key}|${r.pending?.status ?? ""}|${selected}|${focusCol}|${cols.map((c) => c.id).join(",")}|${m.today}|${Math.floor(m.now / 60000)}`;
        row.setAttribute("aria-selected", String(selected));
        row.dataset.id = item.id;
        if (row.dataset.sig === sig) return;
        row.dataset.sig = sig;
        row.classList.toggle("pending", Boolean(r.pending));
        row.classList.toggle("selected", selected);
        setChildren(row, ...cols.map((c, ci) => {
          const content = c.render(item, m);
          return h("div", { role: "gridcell", class: `lg-td col-${c.id}`, tabindex: ci === focusCol ? "0" : "-1", "data-row": r.key, "data-col": String(ci) },
            content, ci === 1 && r.pending ? h("span", { class: `pending-chip ${r.pending.status}`, title: pendingLabel(r.pending, false) }, r.pending.status === "pending" ? "Pending" : r.pending.status === "saving" ? "Sending…" : "Saved") : null);
        }));
      },
    });
  }

  scroller.addEventListener("scroll", () => {
    if (raf || rows.length <= WINDOW_MIN) return;
    raf = requestAnimationFrame(() => { raf = 0; renderRows(); });
  }, { passive: true });

  body.addEventListener("click", (event) => {
    const e = /** @type {MouseEvent} */ (event);
    const t = /** @type {HTMLElement} */ (e.target);
    const cell = /** @type {HTMLElement|null} */ (t.closest("[data-row]"));
    if (!cell || !model) return;
    const rowKey = /** @type {string} */ (cell.dataset.row);
    const r = rows.find((x) => x.key === rowKey);
    onAction("focusRow", { row: rowKey, col: Number(cell.dataset.col ?? 0), silent: true });
    if (!r || r.kind !== "item") return;
    if (t.closest("[data-action=select]")) { e.preventDefault(); onAction("select", { item: r.item, toggle: true, range: e.shiftKey }); }
    else if (e.shiftKey) onAction("select", { item: r.item, range: true });
    else if (e.metaKey || e.ctrlKey) onAction("select", { item: r.item, toggle: true });
    else onAction("open", { item: r.item });
  });
  body.addEventListener("mouseover", (event) => {
    const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (event.target).closest(".lg-row"));
    onAction("hover", row?.dataset.id ?? null);
  });

  /** @param {string} dir */
  function navigate(dir) {
    if (!model || !rows.length) return false;
    const cols = columnsOf(model).length;
    let ri = model.focus ? rows.findIndex((r) => r.key === model?.focus?.row) : -1;
    let ci = model.focus?.col ?? 1;
    if (ri < 0) { ri = rows.findIndex((r) => r.kind === "item"); if (ri < 0) ri = 0; }
    else switch (dir) {
      case "down": ri = Math.min(rows.length - 1, ri + 1); break;
      case "up": ri = Math.max(0, ri - 1); break;
      case "right": ci = Math.min(cols - 1, ci + 1); break;
      case "left": ci = Math.max(0, ci - 1); break;
      case "first": ci = 0; break;
      case "last": ci = cols - 1; break;
      case "home": ri = 0; break;
      case "end": ri = rows.length - 1; break;
      case "pageDown": ri = Math.min(rows.length - 1, ri + 10); break;
      case "pageUp": ri = Math.max(0, ri - 10); break;
    }
    if (rows[ri].kind === "group") ci = 0;
    onAction("focusRow", { row: rows[ri].key, col: ci });
    return true;
  }

  function focusCurrent({ scroll = true } = {}) {
    if (!model?.focus) return false;
    const i = rows.findIndex((r) => r.key === model?.focus?.row);
    if (i < 0) return false;
    if (rows.length > WINDOW_MIN) {
      const top = i * ROW_H;
      if (top < scroller.scrollTop || top > scroller.scrollTop + scroller.clientHeight - ROW_H * 2) { scroller.scrollTop = Math.max(0, top - scroller.clientHeight / 3); renderRows(); }
    }
    const row = rows[i];
    const col = row.kind === "group" ? 0 : model.focus.col;
    const target = /** @type {HTMLElement|null} */ (body.querySelector(`[data-row="${row.key.replace(/["\\]/g, "\\$&")}"][data-col="${col}"]`));
    if (!target) return false;
    target.tabIndex = 0;
    focusEl(target, { scroll });
    return true;
  }

  function focusedItem() {
    if (!model?.focus) return null;
    const r = rows.find((x) => x.key === model?.focus?.row);
    return r && r.kind === "item" ? r.item : null;
  }

  /** Items between two ids in row order (range selection). @param {string} a @param {string} b */
  function between(a, b) {
    const ids = rows.filter((r) => r.kind === "item").map((r) => /** @type {any} */ (r).item);
    const i = ids.findIndex((x) => x.id === a), j = ids.findIndex((x) => x.id === b);
    if (i < 0 || j < 0) return [];
    return ids.slice(Math.min(i, j), Math.max(i, j) + 1);
  }

  return { el, scroller, update, navigate, focusCurrent, focusedItem, between, get rows() { return rows; } };
}
