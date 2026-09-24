// @ts-check
// The Profile panel: what is selected, editable. One element, one connection, one loop, several
// items (bulk edit, merge, loop from connections) or nothing (map title, description, help).
//
// Rendering: the panel is rebuilt from the store on "selection" and, when something it shows
// changed, on "model" (a cheap reference comparison of the objects it depends on decides). A text
// control the user is typing in (its value differs from what was last committed) is never rebuilt
// under them: the rebuild waits until focus leaves it. Other controls get their focus back after a
// rebuild (matched by data-pk). Text commits on blur or Enter, never per keystroke; a selection
// change commits a pending edit first.
//
// Pure logic (merge planning, loop ordering, bulk ops, parsing) lives in ./profile-logic.js.

import { h, clear, icon, formatTime } from "./dom.js";
import { modal, showToast } from "./dialogs.js";
import { ensureStyle } from "./css.js";
import {
  DIRECTIONS, FIELD_KINDS, LIMITS, PALETTE, cleanLine, cleanText, derivedLoopPolarity, fieldApplies, normalizeLabel,
  cleanUrl,
} from "../../shared/protocol.js";
import {
  bulkOps, chunk, deleteOps, formatFieldValue, groupConnections, mergeOps, orderLoop, parseAliases, parseChoices,
  parseFieldInput, parseTags, planMerge, searchElements,
} from "./profile-logic.js";

const CONNECTIONS_SHOWN = 100;
const MERGE_MAX = 50;
const NEW_TYPE = "__new__";
const DIRECTION_NAMES = { directed: "Directed (→)", undirected: "Undirected (—)", mutual: "Mutual (↔)" };
const POLARITY_NAMES = { "+": "+ Positive", "-": "− Negative", unknown: "Unknown" };
const KIND_NAMES = {
  text: "Text", longtext: "Long text", number: "Number", date: "Date", daterange: "Date range", bool: "Yes / no",
  choice: "Choice", multichoice: "Multiple choice", url: "Web address",
};

const STYLE = String.raw`
.nmp { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.nmp-head { display: flex; flex-direction: column; gap: 6px; }
.nmp-kicker { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-3); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.nmp-kicker .chip { text-transform: none; letter-spacing: 0; }
.nmp-label-input { font-size: 16px; font-weight: 650; width: 100%; }
.nmp-sec { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid var(--border); }
.nmp-sec > h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-3); }
.nmp textarea { min-height: 64px; }
.nmp .field-row > label, .nmp .nmp-lbl { display: flex; align-items: center; gap: 6px; color: var(--text-2); font-size: 13px; }
.nmp fieldset.field-row { border: 0; padding: 0; margin: 0; min-width: 0; }
.nmp fieldset.field-row > legend { padding: 0; margin-bottom: 4px; color: var(--text-2); font-size: 13px; }
.nmp-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.nmp-pair > input { width: 100%; }
.nmp-checks { display: flex; flex-wrap: wrap; gap: 4px 12px; border: 0; padding: 0; margin: 0; }
.nmp-checks label, .nmp-check { display: inline-flex; gap: 6px; align-items: center; color: var(--text); font-size: 13px; }
.nmp-type { display: flex; gap: 6px; align-items: center; }
.nmp-type > select, .nmp-type > input { flex: 1; min-width: 0; }
.nmp-value { display: flex; }
.nmp-value > select, .nmp-value > input, .nmp-value > textarea, .nmp-value > .nmp-pair { flex: 1; min-width: 0; }
.nmp-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
.nmp-list .btn, .nmp-steps .btn { width: 100%; justify-content: flex-start; font-weight: 400; text-align: left; white-space: normal; }
.nmp-list .nmp-other { font-weight: 600; color: var(--text); }
.nmp-list .nmp-meta { color: var(--text-3); }
.nmp-arrow { flex: none; width: 18px; text-align: center; color: var(--text-3); }
.nmp-group { font-size: 12px; color: var(--text-3); margin-top: 2px; }
.nmp-ends { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 6px; align-items: center; }
.nmp-ends .btn { justify-content: flex-start; overflow: hidden; text-overflow: ellipsis; font-weight: 600; color: var(--text); }
.nmp-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.nmp-combo { position: relative; }
.nmp-combo > input { width: 100%; }
.nmp-listbox {
  position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 2px); margin: 0; padding: 4px; list-style: none;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: var(--shadow-2); max-height: 260px; overflow-y: auto;
}
.nmp-listbox li { padding: 5px 8px; border-radius: var(--radius-sm); cursor: pointer; display: flex; justify-content: space-between; gap: 8px; }
.nmp-listbox li[aria-selected="true"] { background: var(--accent-soft); color: var(--accent-hover); }
.nmp-prov { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; font-size: 13px; }
.nmp-prov dt { color: var(--text-3); }
.nmp-prov dd { margin: 0; overflow-wrap: anywhere; }
.nmp-help { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; color: var(--text-2); }
.nmp kbd { font: 12px ui-monospace, monospace; background: var(--surface-2); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; white-space: nowrap; }
.nmp-counts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.nmp-count { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 8px; display: flex; flex-direction: column; }
.nmp-count strong { font-size: 18px; font-variant-numeric: tabular-nums; }
.nmp-count span { font-size: 12px; color: var(--text-3); }
.nmp-problem { color: var(--danger); font-size: 13px; margin: 0; }
.nmp-sec p, .nmp > p { margin: 0; }
.nmp-steps { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 1px; }
.nmp-derived { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 13px; }
.nmp-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; border-radius: 11px; font-weight: 700; font-size: 12px; padding: 0 6px; background: var(--surface-2); border: 1px solid var(--border); }
.nmp-badge.r { background: #dcefe0; color: #1f5f2c; border-color: #b7dcc0; }
.nmp-badge.b { background: #fbe3cf; color: #8a3d0a; border-color: #f0c29b; }
@media (prefers-color-scheme: dark) {
  .nmp-badge.r { background: #1f3a26; color: #9be0ae; border-color: #2f5a3a; }
  .nmp-badge.b { background: #45301e; color: #f5c291; border-color: #6a4527; }
}
.nmp-open { font-size: 12px; white-space: nowrap; color: var(--accent); margin-left: auto; }
.nmp-merge { display: flex; flex-direction: column; gap: 12px; }
.nmp-merge section { display: flex; flex-direction: column; gap: 6px; }
.nmp-merge h3, .nmp-radios legend { font-size: 13px; font-weight: 600; color: var(--text); padding: 0; margin: 0 0 4px; }
.nmp-merge p { overflow-wrap: anywhere; }
.nmp-merge-list { max-height: 180px; overflow-y: auto; margin: 0; padding-left: 18px; font-size: 13px; color: var(--text-2); }
.nmp-merge-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; }
.nmp-merge-grid select { width: 100%; }
.nmp-radios { display: flex; flex-direction: column; gap: 4px; border: 0; padding: 0; margin: 0; max-height: 180px; overflow-y: auto; }
.nmp-radios .muted { margin-left: 4px; }
`;

let uidSeq = 0;
const uid = () => `nmp-${++uidSeq}`;

/**
 * @typedef {object} Entry  a text control's commit state
 * @property {() => boolean} dirty   the value differs from what was last committed
 * @property {() => void} commit
 */

/** @param {HTMLElement} host @param {any} app */
export function mountProfile(host, app) {
  ensureStyle("profile", STYLE);
  const root = h("div", { class: "nmp" });
  host.appendChild(root);
  const store = app.store;
  const get = (/** @type {string} */ id) => store.objects.get(id);

  /** @type {WeakMap<Element, Entry>} */
  const entries = new WeakMap();
  /** Selection key and dependencies of what is shown. */
  let shownKey = "\0";
  /** @type {unknown[]} */
  let shownDeps = [];
  let deferred = false;
  /** @type {string|null} element whose label should be focused once shown */
  let pendingLabel = null;
  /** @type {string|null} control to focus after the next rebuild */
  let pendingFocus = null;

  const selected = () => [...app.selection].filter((id) => store.objects.has(id));

  /** @param {Element|null} el */
  const isEntry = (el) => !!el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["checkbox", "radio"].includes(/** @type {HTMLInputElement} */ (el).type)));
  const focusedEntry = () => {
    const a = document.activeElement;
    return a && root.contains(a) && isEntry(a) ? a : null;
  };

  /** @param {boolean} force */
  function render(force) {
    if (!app.model) {
      clear(root).appendChild(h("p", { class: "muted" }, "Loading the map…"));
      shownKey = "\0";
      return;
    }
    const ids = selected();
    const key = ids.join(",");
    const deps = dependencies(ids);
    const sameKey = key === shownKey;
    if (!force && sameKey && sameList(deps, shownDeps)) return;
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    const inside = !!active && root.contains(active);
    if (inside && isEntry(active)) {
      const entry = entries.get(/** @type {HTMLElement} */ (active));
      if (sameKey && entry?.dirty()) { deferred = true; return; }
      if (!sameKey) entry?.commit();
    }
    deferred = false;
    shownKey = key;
    shownDeps = deps;
    const pk = inside && sameKey ? active?.dataset.pk ?? null : null;
    const caret = pk && isEntry(active) ? selectionOf(/** @type {HTMLInputElement} */ (active)) : null;
    root.replaceChildren(...build(ids));
    const target = pendingFocus ?? pk;
    pendingFocus = null;
    if (target) {
      const twin = /** @type {HTMLElement|null} */ (root.querySelector(`[data-pk="${CSS.escape(target)}"]`));
      if (twin) {
        twin.focus({ preventScroll: true });
        if (caret) restoreSelection(/** @type {HTMLInputElement} */ (twin), caret);
      }
    }
    if (pendingLabel && ids.length === 1 && ids[0] === pendingLabel) focusLabel();
  }

  function focusLabel() {
    const input = /** @type {HTMLInputElement|null} */ (root.querySelector('[data-pk="label"]'));
    if (!input) return;
    pendingLabel = null;
    input.focus();
    input.select();
  }

  /**
   * The objects (by reference) and numbers a rendering of `ids` depends on.
   * @param {string[]} ids
   */
  function dependencies(ids) {
    const m = app.model;
    /** @type {unknown[]} */
    const deps = [m.view, app.mode, ...m.index.types.values(), ...m.index.fields.values()];
    if (!ids.length) {
      deps.push(store.meta, m.index.elements.size, m.index.connections.size, m.loops.size, m.nodes.size);
      return deps;
    }
    for (const id of ids) deps.push(get(id));
    if (ids.length > 1) return deps;
    const o = get(ids[0]);
    if (o.id[0] === "e") {
      deps.push(m.nodes.has(o.id));
      for (const cid of m.index.adjacency.get(o.id) ?? []) {
        const c = get(cid);
        deps.push(c, get(c?.from === o.id ? c?.to : c?.from));
      }
    } else if (o.id[0] === "c") {
      deps.push(get(o.from), get(o.to), m.edges.has(o.id));
      for (const l of m.loops.values()) if (l.steps?.some((/** @type {any} */ s) => s.c === o.id)) deps.push(l);
    } else if (o.id[0] === "l") {
      for (const s of o.steps ?? []) {
        const c = get(s.c);
        deps.push(c, get(c?.from), get(c?.to));
      }
    }
    return deps;
  }

  /** @param {string[]} ids @returns {HTMLElement[]} */
  function build(ids) {
    if (!ids.length) return buildNothing();
    if (ids.length > 1) return buildMany(ids);
    const o = get(ids[0]);
    if (o.id[0] === "e") return buildElement(o);
    if (o.id[0] === "c") return buildConnection(o);
    if (o.id[0] === "l") return buildLoop(o);
    return [h("p", { class: "muted" }, "Views are edited in the Design tab.")];
  }

  // --- Controls -------------------------------------------------------------------------------

  /**
   * A single- or multi-line text control that commits on blur or Enter (Ctrl+Enter in a
   * multi-line one); Escape restores the committed value.
   * @param {{pk: string, value: string, label: string, onCommit: (value: string) => void,
   *   multiline?: boolean, type?: string, placeholder?: string, className?: string, maxLength?: number}} o
   */
  function textControl(o) {
    const el = /** @type {HTMLInputElement} */ (h(o.multiline ? "textarea" : "input", {
      type: o.multiline ? null : o.type ?? "text", class: o.className ?? null,
      "aria-label": o.label, placeholder: o.placeholder ?? null, maxlength: o.maxLength ?? null, dataset: { pk: o.pk },
    }));
    el.value = o.value;
    let committed = o.value;
    const commit = () => {
      if (el.value === committed) return;
      committed = el.value;
      o.onCommit(el.value);
    };
    entries.set(el, { dirty: () => el.value !== committed, commit });
    el.addEventListener("blur", commit);
    if (o.type === "date") el.addEventListener("change", commit);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (!o.multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
      else if (e.key === "Escape" && el.value !== committed) { e.preventDefault(); e.stopPropagation(); el.value = committed; }
    });
    return el;
  }

  /** An input whose value is read by a button (never committed on its own). @param {HTMLInputElement} el */
  const scratch = (el) => { entries.set(el, { dirty: () => el.value.trim() !== "", commit: () => {} }); return el; };

  /**
   * A labelled row: visible text tied to its control.
   * @param {string} text @param {HTMLElement} control @param {...any} extra  after the label text
   */
  function row(text, control, ...extra) {
    const target = control.matches("input, select, textarea") ? control : control.querySelector("input, select, textarea");
    const id = target ? target.id || (target.id = uid()) : null;
    target?.removeAttribute("aria-label");
    return h("div", { class: "field-row" }, h("label", { for: id }, text, ...extra), control);
  }

  /** @param {string} title @param {...any} children */
  const section = (title, ...children) => h("section", { class: "nmp-sec", "aria-label": title }, h("h3", null, title), ...children);

  /**
   * @param {string} label @param {() => void} onclick
   * @param {{icon?: any, danger?: boolean, pk?: string, disabled?: boolean, title?: string}} [o]
   */
  const button = (label, onclick, o = {}) => h("button", {
    type: "button", class: `btn small outline${o.danger ? " danger-text" : ""}`,
    onclick, dataset: o.pk ? { pk: o.pk } : null, disabled: o.disabled, title: o.title ?? null,
  }, o.icon ? icon(o.icon, 14) : null, label);

  /** @param {string} id @param {Record<string, unknown>} patch */
  const update = (id, patch) => app.apply([{ op: "update", id, patch }]);

  /**
   * The type picker (with "New type…"), for elements or connections.
   * @param {any} o @param {"element"|"connection"} kind
   */
  function typeControl(o, kind) {
    const types = [...app.model.index.types.values()].filter((t) => t.appliesTo === kind);
    const select = /** @type {HTMLSelectElement} */ (h("select", { dataset: { pk: "type" } },
      h("option", { value: "" }, "Untyped"),
      types.map((t) => h("option", { value: t.id }, t.name)),
      app.model.index.types.size < LIMITS.types ? h("option", { value: NEW_TYPE }, "New type…") : null));
    select.value = o.typeId ?? "";
    select.addEventListener("change", async () => {
      if (select.value !== NEW_TYPE) { update(o.id, { typeId: select.value || null }); return; }
      select.value = o.typeId ?? "";
      const made = await typeDialog(kind);
      if (!made) return;
      const id = app.newId("type");
      app.apply([
        { op: "create", object: { id, name: made.name, appliesTo: kind, color: made.color } },
        { op: "update", id: o.id, patch: { typeId: id } },
      ]);
      pendingFocus = "type";
    });
    const color = o.typeId ? app.model.index.types.get(o.typeId)?.color : null;
    return h("div", { class: "nmp-type" }, color ? h("span", { class: "swatch-dot", style: { background: color } }) : null, select);
  }

  /** @param {any} o */
  const tagsControl = (o) => textControl({
    pk: "tags", label: "Tags", value: (o.tags ?? []).join(", "), placeholder: "Comma-separated",
    onCommit: (v) => update(o.id, { tags: parseTags(v) }),
  });

  /** @param {any} o */
  const descriptionControl = (o) => textControl({
    pk: "description", label: "Description", value: o.description ?? "", multiline: true, maxLength: LIMITS.description,
    placeholder: "Plain text; Ctrl+Enter saves", onCommit: (v) => update(o.id, { description: cleanText(v, LIMITS.description) }),
  });

  // --- Custom fields ----------------------------------------------------------------------------

  /** @param {any} o @param {"element"|"connection"} kind */
  function fieldsSection(o, kind) {
    const defs = [...app.model.index.fields.values()].filter((d) => fieldApplies(d, kind));
    const add = button("Add field", () => addField(kind), { icon: "plus", pk: "add-field", disabled: app.model.index.fields.size >= LIMITS.fields });
    return section("Fields", ...(defs.length ? defs.map((def) => fieldRow(o, def)) : [h("p", { class: "muted" }, "No fields yet.")]), h("div", { class: "nmp-actions" }, add));
  }

  /**
   * Commits a field value from its control; a bad value is reported and the control restored.
   * @param {any} o @param {any} def @param {unknown} raw
   */
  function commitField(o, def, raw) {
    const parsed = parseFieldInput(def, raw);
    if ("error" in parsed) { showToast(parsed.error); render(true); return; }
    update(o.id, { fields: { [def.id]: parsed.value } });
  }

  /** @param {any} o @param {any} def */
  function fieldRow(o, def) {
    const v = o.fields?.[def.id];
    const pk = `field:${def.id}`;
    const name = def.name;
    const onCommit = (/** @type {unknown} */ raw) => commitField(o, def, raw);
    switch (def.kind) {
      case "longtext":
        return row(name, textControl({ pk, label: name, value: v ?? "", multiline: true, onCommit }));
      case "number":
      case "date":
      case "text":
        return row(name, textControl({ pk, label: name, value: v === undefined || v === null ? "" : String(v), type: def.kind === "text" ? "text" : def.kind, onCommit }));
      case "url": {
        // Only http(s) links are opened, whatever the stored value claims to be.
        const safe = typeof v === "string" ? cleanUrl(v) : null;
        const link = safe ? h("a", { class: "nmp-open", href: safe, target: "_blank", rel: "noopener noreferrer", "aria-label": `Open ${name} in a new tab` }, "Open ↗") : null;
        return row(name, textControl({ pk, label: name, value: v ?? "", type: "url", placeholder: "https://…", onCommit }), link);
      }
      case "daterange": {
        const cur = { from: v?.from ?? "", to: v?.to ?? "" };
        const from = textControl({ pk: `${pk}:from`, label: `${name} from`, value: cur.from, type: "date", onCommit: (s) => onCommit({ ...cur, from: s }) });
        const to = textControl({ pk: `${pk}:to`, label: `${name} to`, value: cur.to, type: "date", onCommit: (s) => onCommit({ ...cur, to: s }) });
        return h("fieldset", { class: "field-row" }, h("legend", null, name), h("div", { class: "nmp-pair" }, from, to));
      }
      case "bool": {
        const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: v === true, dataset: { pk }, onchange: () => onCommit(box.checked) }));
        return h("label", { class: "nmp-check" }, box, name);
      }
      case "choice": {
        const select = /** @type {HTMLSelectElement} */ (h("select", { dataset: { pk }, onchange: () => onCommit(select.value) },
          h("option", { value: "" }, "—"), (def.choices ?? []).map((/** @type {string} */ c) => h("option", { value: c }, c))));
        select.value = typeof v === "string" ? v : "";
        return row(name, select);
      }
      case "multichoice": {
        const chosen = new Set(Array.isArray(v) ? v : []);
        const boxes = /** @type {string[]} */ (def.choices ?? []).map((c, i) =>
          /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", value: c, checked: chosen.has(c), dataset: { pk: `${pk}:${i}` } })));
        for (const b of boxes) b.addEventListener("change", () => onCommit(boxes.filter((x) => x.checked).map((x) => x.value)));
        return h("fieldset", { class: "field-row" }, h("legend", null, name),
          h("div", { class: "nmp-checks" }, boxes.map((b) => h("label", null, b, b.value))));
      }
      default:
        return row(name, h("span", { class: "muted" }, formatFieldValue(def, v)));
    }
  }

  /** @param {"element"|"connection"} kind */
  async function addField(kind) {
    const made = await fieldDialog(kind);
    if (!made) return;
    const id = app.newId("field");
    app.apply([{ op: "create", object: { id, ...made } }]);
    pendingFocus = made.kind === "multichoice" ? `field:${id}:0` : made.kind === "daterange" ? `field:${id}:from` : `field:${id}`;
  }

  // --- Provenance ---------------------------------------------------------------------------------

  /** @param {any} o */
  function provenanceSection(o) {
    const p = o.provenance;
    const refs = o.externalRefs ?? [];
    if (!p && !refs.length) return null;
    /** @type {HTMLElement[]} */
    const items = [];
    const add = (/** @type {string} */ k, /** @type {string} */ v) => { if (v) items.push(h("dt", null, k), h("dd", null, v)); };
    if (p) {
      add("Origin", { import: "Imported", source: "From a source", agent: "Proposed by an agent", manual: "Added by hand" }[/** @type {"import"} */ (p.origin)] ?? p.origin);
      add("Source", p.sourceName ?? "");
      add("Accepted by", p.acceptedBy ?? "");
      add("Accepted", p.at ? `${new Date(p.at).toLocaleDateString()} (${formatTime(p.at)})` : "");
    }
    for (const r of refs) add("External ref", `${r.sourceId}: ${r.key}`);
    return section("Provenance", h("dl", { class: "nmp-prov" }, items));
  }

  // --- Nothing selected -----------------------------------------------------------------------------

  function buildNothing() {
    const m = app.model;
    const meta = store.meta ?? {};
    const title = textControl({
      pk: "map-title", label: "Map title", value: meta.title ?? "", maxLength: LIMITS.title,
      onCommit: (v) => { const t = cleanLine(v, LIMITS.title); if (t) app.apply([], { structure: { title: t } }); else render(true); },
    });
    const description = textControl({
      pk: "map-description", label: "Map description", value: meta.description ?? "", multiline: true, maxLength: LIMITS.description,
      placeholder: "What this map is about", onCommit: (v) => app.apply([], { structure: { description: cleanText(v, LIMITS.description) } }),
    });
    const hidden = m.index.elements.size - m.nodes.size;
    const count = (/** @type {number} */ n, /** @type {string} */ what) => h("div", { class: "nmp-count" }, h("strong", null, n.toLocaleString()), h("span", null, what));
    return [
      h("div", { class: "nmp-kicker" }, "Map"),
      row("Title", title),
      row("Description", description),
      h("div", { class: "nmp-counts", role: "group", "aria-label": "Counts" },
        count(m.index.elements.size, "elements"), count(m.index.connections.size, "connections"), count(m.loops.size, "loops")),
      hidden ? h("p", { class: "muted" }, `${hidden.toLocaleString()} element${hidden === 1 ? " is" : "s are"} hidden by this view.`) : null,
      section("Getting started",
        h("ul", { class: "nmp-help" },
          h("li", null, "Double-click the canvas to add an element; double-click an element to rename it."),
          h("li", null, "Shift-drag from one element to another to connect them."),
          h("li", null, "Type ", h("kbd", null, "Farms -> Market, Shops"), " in the bar below: ", h("kbd", null, "->"), " directed, ", h("kbd", null, "<->"), " mutual, ", h("kbd", null, "--"), " undirected."),
          h("li", null, "Select an element or connection to edit it here. Shift-click to select several for bulk edits, merging or a loop."),
          h("li", null, "List mode (top bar) shows everything as a sortable table."))),
    ].filter(/** @returns {x is HTMLElement} */ (x) => !!x);
  }

  // --- One element ------------------------------------------------------------------------------------

  /** @param {any} e */
  function buildElement(e) {
    const m = app.model;
    const hidden = !m.nodes.has(e.id);
    const label = textControl({
      pk: "label", label: "Label", value: e.label, className: "nmp-label-input", maxLength: LIMITS.label,
      onCommit: (v) => { const t = cleanLine(v, LIMITS.label); if (t) update(e.id, { label: t }); else render(true); },
    });
    const aliases = textControl({
      pk: "aliases", label: "Aliases", value: (e.aliases ?? []).join(", "), placeholder: "Other names, comma-separated",
      onCommit: (v) => update(e.id, { aliases: parseAliases(v) }),
    });
    const degree = (m.index.adjacency.get(e.id) ?? []).length;
    return [
      h("div", { class: "nmp-head" },
        h("div", { class: "nmp-kicker" }, "Element", hidden ? h("span", { class: "chip", title: "A rule, the filter or the focus of this view hides it" }, "Hidden in this view") : null),
        row("Label", label)),
      row("Type", typeControl(e, "element")),
      row("Description", descriptionControl(e)),
      row("Tags", tagsControl(e)),
      row("Aliases", aliases),
      fieldsSection(e, "element"),
      provenanceSection(e),
      connectionsSection(e),
      h("div", { class: "nmp-actions" },
        button("Center on map", () => app.centerOn(e.id), { icon: "fit", pk: "center", disabled: hidden || app.mode !== "map" }),
        button("Focus on this", () => focusOn(e.id), { icon: "focus", pk: "focus", disabled: !app.view }),
        button("Delete", () => deleteElement(e, degree), { icon: "trash", danger: true, pk: "delete" })),
    ].filter(/** @returns {x is HTMLElement} */ (x) => !!x);
  }

  /** @param {string} id */
  function focusOn(id) {
    const v = app.view;
    if (!v) return;
    update(v.id, { focus: { roots: [id], depth: 1, direction: "both" } });
    app.announce("Showing this element and its neighbours");
  }

  /** @param {any} e @param {number} degree */
  async function deleteElement(e, degree) {
    if (degree > 0) {
      const ok = await confirmDialog(`Delete “${e.label}”?`, `This also deletes ${degree} connection${degree === 1 ? "" : "s"}${loopsNote([e.id])}. You can undo it.`, "Delete");
      if (!ok) return;
    }
    removeIds([e.id]);
  }

  /** " and N loops": the loops deleting these ids takes with it. @param {string[]} ids */
  function loopsNote(ids) {
    const conns = new Set();
    for (const id of ids) {
      if (id[0] === "c") conns.add(id);
      for (const c of app.model.index.adjacency.get(id) ?? []) conns.add(c);
    }
    const chosen = new Set(ids);
    let n = 0;
    for (const l of app.model.loops.values()) if (!chosen.has(l.id) && l.steps?.some((/** @type {any} */ s) => conns.has(s.c))) n++;
    return n ? ` and ${n} loop${n === 1 ? "" : "s"}` : "";
  }

  /** @param {string[]} ids */
  function removeIds(ids) {
    const ops = deleteOps(ids, get);
    for (const part of chunk(ops)) app.apply(part);
    app.select([]);
    app.announce(`Deleted ${ops.length} item${ops.length === 1 ? "" : "s"}`);
  }

  /** @param {any} e */
  function connectionsSection(e) {
    const m = app.model;
    const groups = groupConnections(e.id, m.index.adjacency.get(e.id) ?? [], get);
    const name = (/** @type {string} */ id) => (id === e.id ? "itself" : get(id)?.label ?? "?");
    /** @param {string} title @param {{conn: any, other: string}[]} list @param {string} arrow */
    const group = (title, list, arrow) => {
      if (!list.length) return null;
      const shown = list.slice(0, CONNECTIONS_SHOWN);
      return [
        h("div", { class: "nmp-group" }, `${title} (${list.length})`),
        h("ul", { class: "nmp-list", "aria-label": title },
          shown.map(({ conn, other }) => {
            const meta = [conn.label, conn.typeId ? m.index.types.get(conn.typeId)?.name : null].filter(Boolean).join(" · ");
            return h("li", null, h("button", {
              type: "button", class: "btn small", dataset: { pk: `conn:${conn.id}` }, onclick: () => app.select([conn.id]),
              "aria-label": `${title}: ${name(other)}${meta ? `, ${meta}` : ""}`,
            }, h("span", { class: "nmp-arrow", "aria-hidden": "true" }, arrow),
            h("span", { class: "nmp-other" }, name(other)),
            meta ? h("span", { class: "nmp-meta" }, `· ${meta}`) : null));
          }),
          list.length > shown.length ? h("li", { class: "muted" }, `and ${list.length - shown.length} more (see list mode)`) : null),
      ];
    };
    const total = groups.outgoing.length + groups.incoming.length + groups.undirected.length;
    return section(`Connections (${total})`,
      total ? null : h("p", { class: "muted" }, "Not connected yet."),
      group("Outgoing", groups.outgoing, "→"),
      group("Incoming", groups.incoming, "←"),
      group("Both ways", groups.undirected, "↔"),
      connectCombo(e));
  }

  /** A combobox that finds an element by label or alias and connects to it on Enter. @param {any} e */
  function connectCombo(e) {
    const listId = uid();
    const input = scratch(/** @type {HTMLInputElement} */ (h("input", {
      type: "text", role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": listId,
      "aria-label": "Connect to an element", placeholder: "Connect to…", dataset: { pk: "connect" }, autocomplete: "off",
    })));
    const list = h("ul", { id: listId, role: "listbox", class: "nmp-listbox", hidden: true, "aria-label": "Matching elements" });
    /** @type {any[]} */
    let results = [];
    let active = -1;
    const draw = () => {
      clear(list);
      results.forEach((r, i) => {
        const type = r.typeId ? app.model.index.types.get(r.typeId)?.name : "";
        list.appendChild(h("li", {
          id: `${listId}-${i}`, role: "option", "aria-selected": String(i === active),
          onpointerdown: (/** @type {Event} */ ev) => ev.preventDefault(), onclick: () => choose(i),
        }, h("span", null, r.label), type ? h("span", { class: "muted" }, type) : null));
      });
      const open = results.length > 0;
      list.hidden = !open;
      input.setAttribute("aria-expanded", String(open));
      if (open && active >= 0) {
        input.setAttribute("aria-activedescendant", `${listId}-${active}`);
        list.children[active]?.scrollIntoView({ block: "nearest" });
      } else input.removeAttribute("aria-activedescendant");
    };
    const close = () => { results = []; active = -1; draw(); };
    /** @param {number} i */
    const choose = (i) => {
      const target = results[i];
      if (!target) return;
      app.apply([{ op: "create", object: { id: app.newId("connection"), from: e.id, to: target.id, direction: "directed" } }]);
      app.announce(`Connected ${e.label} to ${target.label}`);
      input.value = "";
      close();
    };
    input.addEventListener("input", () => {
      results = searchElements(app.model.index.elements.values(), input.value, { exclude: new Set([e.id]) });
      active = results.length ? 0 : -1;
      draw();
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        if (!results.length) return;
        ev.preventDefault();
        active = (active + (ev.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
        draw();
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        if (active >= 0) choose(active);
        else if (input.value.trim()) showToast(`No element called “${input.value.trim()}”. Add it with the quick-add bar first.`);
      } else if (ev.key === "Escape" && (results.length || input.value)) {
        ev.preventDefault();
        ev.stopPropagation();
        input.value = "";
        close();
      }
    });
    input.addEventListener("blur", close);
    return h("div", { class: "nmp-combo" }, input, list);
  }

  // --- One connection -----------------------------------------------------------------------------------

  /** @param {any} c */
  function buildConnection(c) {
    const m = app.model;
    const end = (/** @type {any} */ el, /** @type {string} */ role) => h("button", {
      type: "button", class: "btn small outline", dataset: { pk: `end:${role}` }, title: el?.label ?? "",
      "aria-label": `${role} ${el?.label ?? "?"}; select it`, onclick: () => app.select([el.id]),
    }, el?.label ?? "?");
    const arrow = { directed: "→", undirected: "—", mutual: "↔" }[/** @type {"directed"} */ (c.direction)] ?? "→";
    const direction = /** @type {HTMLSelectElement} */ (h("select", { dataset: { pk: "direction" }, onchange: () => update(c.id, { direction: direction.value }) },
      DIRECTIONS.map((d) => h("option", { value: d }, DIRECTION_NAMES[d]))));
    direction.value = c.direction ?? "directed";
    const polarity = /** @type {HTMLSelectElement} */ (h("select", { dataset: { pk: "polarity" }, onchange: () => update(c.id, { polarity: polarity.value }) },
      Object.entries(POLARITY_NAMES).map(([v, name]) => h("option", { value: v }, name))));
    polarity.value = c.polarity ?? "unknown";
    const label = textControl({
      pk: "label", label: "Label", value: c.label ?? "", maxLength: LIMITS.label, placeholder: "e.g. funds, supplies",
      onCommit: (v) => update(c.id, { label: cleanLine(v, LIMITS.label) || null }),
    });
    const strength = textControl({
      pk: "strength", label: "Strength", value: c.strength === undefined || c.strength === null ? "" : String(c.strength), type: "number",
      onCommit: (v) => {
        if (v.trim() === "") { update(c.id, { strength: null }); return; }
        const n = Number(v);
        if (!Number.isFinite(n)) { showToast("Strength needs a number"); render(true); return; }
        update(c.id, { strength: n });
      },
    });
    const loops = [...m.loops.values()].filter((l) => l.steps?.some((/** @type {any} */ s) => s.c === c.id));
    return [
      h("div", { class: "nmp-head" },
        h("div", { class: "nmp-kicker" }, "Connection", m.edges.has(c.id) ? null : h("span", { class: "chip" }, "Hidden in this view")),
        h("div", { class: "nmp-ends" }, end(get(c.from), "From"), h("span", { "aria-hidden": "true" }, arrow), end(get(c.to), "To"))),
      h("div", { class: "nmp-actions" }, button("Swap direction", () => update(c.id, { from: c.to, to: c.from }), { pk: "swap", icon: "rotateCw" })),
      row("Direction", direction),
      row("Type", typeControl(c, "connection")),
      row("Label", label),
      h("div", { class: "nmp-pair" }, row("Polarity", polarity), row("Strength", strength)),
      row("Description", descriptionControl(c)),
      row("Tags", tagsControl(c)),
      fieldsSection(c, "connection"),
      provenanceSection(c),
      loops.length ? section("In loops", h("ul", { class: "nmp-list" }, loops.map((l) => h("li", null,
        h("button", { type: "button", class: "btn small", dataset: { pk: `loop:${l.id}` }, onclick: () => app.select([l.id]) }, l.label))))) : null,
      h("div", { class: "nmp-actions" }, button("Delete", () => removeIds([c.id]), { icon: "trash", danger: true, pk: "delete" })),
    ].filter(/** @returns {x is HTMLElement} */ (x) => !!x);
  }

  // --- One loop -----------------------------------------------------------------------------------------

  /** @param {any} l */
  function buildLoop(l) {
    const label = textControl({
      pk: "label", label: "Label", value: l.label ?? "", maxLength: LIMITS.label,
      onCommit: (v) => { const t = cleanLine(v, LIMITS.label); if (t) update(l.id, { label: t }); else render(true); },
    });
    const cls = /** @type {HTMLSelectElement} */ (h("select", { dataset: { pk: "classification" }, onchange: () => update(l.id, { classification: cls.value || null }) },
      h("option", { value: "" }, "Not classified"), h("option", { value: "R" }, "R · Reinforcing"), h("option", { value: "B" }, "B · Balancing")));
    cls.value = l.classification ?? "";
    const steps = l.steps ?? [];
    const derived = derivedLoopPolarity(steps, get);
    const name = (/** @type {string} */ id) => get(id)?.label ?? "?";
    return [
      h("div", { class: "nmp-head" }, h("div", { class: "nmp-kicker" }, "Loop"), row("Label", label)),
      row("Classification", cls),
      h("p", { class: "nmp-derived" }, h("span", { class: "muted" }, "From the connections’ polarities:"),
        derived ? h("span", { class: `nmp-badge ${derived.toLowerCase()}`, "aria-hidden": "true" }, derived) : null,
        h("span", null, derived === "R" ? "reinforcing" : derived === "B" ? "balancing" : "unknown (some polarities are not set)")),
      section(`Steps (${steps.length})`, h("ol", { class: "nmp-steps" }, steps.map((/** @type {any} */ s) => {
        const c = get(s.c);
        if (!c) return h("li", { class: "muted" }, "Missing connection");
        const [a, b] = s.fwd ? [c.from, c.to] : [c.to, c.from];
        const sign = c.polarity === "+" ? " (+)" : c.polarity === "-" ? " (−)" : "";
        return h("li", null, h("button", { type: "button", class: "btn small", dataset: { pk: `step:${s.c}` }, onclick: () => app.select([c.id]) },
          `${name(a)} → ${name(b)}${c.label ? ` · ${c.label}` : ""}${sign}`));
      }))),
      row("Description", descriptionControl(l)),
      h("div", { class: "nmp-actions" }, button("Delete loop", () => removeIds([l.id]), { icon: "trash", danger: true, pk: "delete" })),
    ];
  }

  // --- Several items ---------------------------------------------------------------------------------------

  /** @param {string[]} ids */
  function buildMany(ids) {
    const objs = ids.map(get);
    const elements = objs.filter((o) => o.id[0] === "e");
    const connections = objs.filter((o) => o.id[0] === "c");
    const loops = objs.filter((o) => o.id[0] === "l");
    const parts = /** @type {[number, string][]} */ ([[elements.length, "element"], [connections.length, "connection"], [loops.length, "loop"]])
      .filter(([n]) => n).map(([n, w]) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`);
    /** @type {(HTMLElement|null)[]} */
    const out = [h("div", { class: "nmp-head" }, h("div", { class: "nmp-kicker" }, "Selection"), h("strong", null, `${ids.length.toLocaleString()} selected: ${parts.join(", ")}`))];
    if (elements.length) out.push(bulkSection(elements));
    if (elements.length >= 2) {
      const tooMany = elements.length > MERGE_MAX;
      out.push(section("Merge",
        h("p", { class: "muted" }, "Combine duplicates into one element: connections move to the one you keep and the other labels become aliases."),
        h("div", { class: "nmp-actions" }, button("Merge elements…", () => mergeElements(elements.map((e) => e.id)), {
          pk: "merge", disabled: tooMany, title: tooMany ? `Merge at most ${MERGE_MAX} elements at a time` : undefined,
        }))));
    }
    if (connections.length && connections.length === ids.length) {
      const problem = h("p", { class: "nmp-problem", role: "alert", hidden: true });
      out.push(section("Loop", h("p", { class: "muted" }, "Name the feedback loop these connections form."),
        h("div", { class: "nmp-actions" }, button("Create loop from selection…", () => createLoop(connections.map((c) => c.id), problem), { pk: "make-loop" })), problem));
    }
    out.push(h("div", { class: "nmp-actions" }, button(`Delete ${ids.length.toLocaleString()} items`, async () => {
      const ok = await confirmDialog(`Delete ${ids.length.toLocaleString()} items?`, `Connections of deleted elements are deleted too${loopsNote(ids)}. You can undo it.`, "Delete");
      if (ok) removeIds(ids);
    }, { icon: "trash", danger: true, pk: "delete" })));
    return /** @type {HTMLElement[]} */ (out.filter(Boolean));
  }

  /** Bulk edit of selected elements: type, tag, field value. @param {any[]} elements */
  function bulkSection(elements) {
    const m = app.model;
    const ids = elements.map((e) => e.id);
    /** @param {import("./profile-logic.js").BulkAction} action @param {string} what */
    const run = (action, what) => {
      const ops = bulkOps(ids.map(get).filter(Boolean), action);
      for (const part of chunk(ops)) app.apply(part);
      if (ops.length) app.announce(`${what} on ${ops.length} element${ops.length === 1 ? "" : "s"}`);
      else showToast("Every selected element already has that.");
    };

    const types = [...m.index.types.values()].filter((t) => t.appliesTo === "element");
    const typeSelect = /** @type {HTMLSelectElement} */ (h("select", { dataset: { pk: "bulk-type" } }, h("option", { value: "" }, "Untyped"), types.map((t) => h("option", { value: t.id }, t.name))));
    const tagInput = scratch(/** @type {HTMLInputElement} */ (h("input", { type: "text", placeholder: "Tag", dataset: { pk: "bulk-tag" }, maxlength: LIMITS.tag })));
    const addTag = () => {
      const [tag] = parseTags(tagInput.value);
      if (!tag) return;
      run({ kind: "tag", tag }, `Added tag “${tag}”`);
      tagInput.value = "";
    };
    tagInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } });

    const defs = [...m.index.fields.values()].filter((d) => fieldApplies(d, "element"));
    const fieldSelect = /** @type {HTMLSelectElement} */ (h("select", { dataset: { pk: "bulk-field" }, "aria-label": "Field" }, defs.map((d) => h("option", { value: d.id }, d.name))));
    const valueHost = h("div", { class: "nmp-value" });
    /** @type {() => unknown} */
    let readValue = () => null;
    const drawValue = () => {
      const def = m.index.fields.get(fieldSelect.value);
      clear(valueHost);
      if (!def) return;
      const control = bulkValueControl(def);
      readValue = control.read;
      valueHost.appendChild(control.el);
    };
    fieldSelect.addEventListener("change", drawValue);
    drawValue();
    const setField = () => {
      const def = m.index.fields.get(fieldSelect.value);
      if (!def) return;
      const parsed = parseFieldInput(def, readValue());
      if ("error" in parsed) { showToast(parsed.error); return; }
      run({ kind: "field", fieldId: def.id, value: parsed.value }, parsed.value === null ? `Cleared ${def.name}` : `Set ${def.name}`);
    };

    return section(`Edit ${elements.length.toLocaleString()} element${elements.length === 1 ? "" : "s"}`,
      row("Type", h("div", { class: "nmp-type" }, typeSelect, button("Set type", () => run({ kind: "type", typeId: typeSelect.value || null }, "Set type"), { pk: "bulk-type-apply" }))),
      row("Add a tag", h("div", { class: "nmp-type" }, tagInput, button("Add tag", addTag, { pk: "bulk-tag-apply" }))),
      defs.length ? h("div", { class: "field-row", role: "group", "aria-label": "Set a field" },
        h("span", { class: "nmp-lbl" }, "Set a field"), fieldSelect, valueHost,
        h("div", { class: "nmp-actions" }, button("Set field", setField, { pk: "bulk-field-apply" }))) : null);
  }

  /**
   * A value control for bulk "set field", read when Set field is pressed.
   * @param {any} def @returns {{el: HTMLElement, read: () => unknown}}
   */
  function bulkValueControl(def) {
    const label = `Value for ${def.name}`;
    switch (def.kind) {
      case "bool": {
        const box = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", dataset: { pk: "bulk-value" } }));
        return { el: h("label", { class: "nmp-check" }, box, "Yes"), read: () => box.checked };
      }
      case "choice": {
        const s = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": label, dataset: { pk: "bulk-value" } },
          h("option", { value: "" }, "— (clear)"), (def.choices ?? []).map((/** @type {string} */ c) => h("option", { value: c }, c))));
        return { el: s, read: () => s.value };
      }
      case "multichoice": {
        const boxes = /** @type {string[]} */ (def.choices ?? []).map((c) => /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", value: c })));
        return {
          el: h("div", { class: "nmp-checks", role: "group", "aria-label": label }, boxes.map((b) => h("label", null, b, b.value))),
          read: () => boxes.filter((b) => b.checked).map((b) => b.value),
        };
      }
      case "daterange": {
        const a = scratch(/** @type {HTMLInputElement} */ (h("input", { type: "date", "aria-label": `${def.name} from` })));
        const b = scratch(/** @type {HTMLInputElement} */ (h("input", { type: "date", "aria-label": `${def.name} to` })));
        return { el: h("div", { class: "nmp-pair" }, a, b), read: () => ({ from: a.value, to: b.value }) };
      }
      default: {
        const type = { number: "number", date: "date", url: "url" }[/** @type {"number"} */ (def.kind)] ?? "text";
        const input = scratch(/** @type {HTMLInputElement} */ (h(def.kind === "longtext" ? "textarea" : "input", {
          type: def.kind === "longtext" ? null : type, "aria-label": label, placeholder: "Leave empty to clear", dataset: { pk: "bulk-value" },
        })));
        return { el: input, read: () => input.value };
      }
    }
  }

  /** @param {string[]} ids @param {HTMLElement} problem */
  async function createLoop(ids, problem) {
    const ordered = orderLoop(ids, get);
    if ("error" in ordered) {
      problem.textContent = ordered.error;
      problem.hidden = false;
      return;
    }
    problem.hidden = true;
    if (app.model.loops.size >= LIMITS.loops) { showToast(`A map may have at most ${LIMITS.loops} loops.`); return; }
    const derived = derivedLoopPolarity(ordered.steps, get);
    const made = await loopDialog(derived);
    if (!made) return;
    const id = app.newId("loop");
    const classification = made.classification === "auto" ? derived : made.classification || null;
    app.apply([{ op: "create", object: { id, label: made.label, steps: ordered.steps, ...(classification ? { classification } : {}) } }]);
    app.select([id]);
    app.announce(`Created the loop ${made.label}`);
  }

  // --- Merge ---------------------------------------------------------------------------------------------

  /** @param {string[]} ids */
  async function mergeElements(ids) {
    const m = app.model;
    const degree = (/** @type {string} */ id) => m.index.adjacency.get(id)?.length ?? 0;
    // Default survivor: the most connected; ties go to the first selected.
    let survivorId = ids.reduce((best, id) => (degree(id) > degree(best) ? id : best), ids[0]);
    const makePlan = () => planMerge({ ids, survivorId, get, connectionsOf: (id) => app.model.index.adjacency.get(id) ?? [], loops: app.model.loops.values() });
    let plan = makePlan();
    /** @type {Record<string, string>} */
    let choices = {};
    const name = (/** @type {string} */ id) => get(id)?.label ?? "?";
    const fieldName = (/** @type {string} */ fid) => m.index.fields.get(fid)?.name ?? fid;
    const ok = await modal((close) => {
      const preview = h("div", { class: "nmp-merge" });
      const mergeBtn = /** @type {HTMLButtonElement} */ (h("button", { type: "button", class: "btn primary", onclick: () => close(true) }, "Merge"));
      const radios = h("fieldset", { class: "nmp-radios" }, h("legend", null, "Keep"),
        ids.map((id) => {
          const r = /** @type {HTMLInputElement} */ (h("input", { type: "radio", name: "nmp-survivor", value: id, checked: id === survivorId, "data-autofocus": id === survivorId || null }));
          r.addEventListener("change", () => { if (r.checked) { survivorId = id; plan = makePlan(); choices = {}; draw(); } });
          return h("label", { class: "nmp-check" }, r, name(id), h("span", { class: "muted" }, `${degree(id)} connection${degree(id) === 1 ? "" : "s"}`));
        }));
      const draw = () => {
        const tooMany = plan.opCount > LIMITS.opsPerRequest;
        mergeBtn.disabled = tooMany;
        const arrow = (/** @type {any} */ c) => (c.direction === "directed" ? "→" : c.direction === "mutual" ? "↔" : "—");
        const dropped = /** @type {[number, string][]} */ ([[plan.dropped.aliases, "aliases"], [plan.dropped.tags, "tags"], [plan.dropped.externalRefs, "external refs"]]).filter(([n]) => n);
        preview.replaceChildren(...[
          h("section", null, h("h3", null, `Connections moved to “${name(survivorId)}” (${plan.repoint.length})`),
            plan.repoint.length ? h("ul", { class: "nmp-merge-list" }, plan.repoint.slice(0, 200).map((r) => h("li", null,
              `${name(r.patch.from ?? r.conn.from)} ${arrow(r.conn)} ${name(r.patch.to ?? r.conn.to)}${r.conn.label ? ` (${r.conn.label})` : ""}${r.selfLink ? " · becomes a self-link" : ""}`)),
            plan.repoint.length > 200 ? h("li", null, `and ${plan.repoint.length - 200} more`) : null) : h("p", null, "None.")),
          plan.conflicts.length ? h("section", null, h("h3", null, "Fields with different values"),
            h("div", { class: "nmp-merge-grid" }, plan.conflicts.flatMap((c) => {
              const s = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": `Value to keep for ${fieldName(c.fieldId)}`, onchange: () => { choices[c.fieldId] = s.value; } },
                c.options.map((o) => h("option", { value: o.elementId }, `${formatFieldValue(m.index.fields.get(c.fieldId), o.value)} (${name(o.elementId)})`))));
              s.value = choices[c.fieldId] ?? c.chosen;
              return [h("span", null, fieldName(c.fieldId)), s];
            }))) : null,
          h("section", null, h("h3", null, "Aliases after the merge"), h("p", null, plan.aliases.join(", ") || "None.")),
          plan.tags.length ? h("section", null, h("h3", null, "Tags after the merge"), h("p", null, plan.tags.join(", "))) : null,
          plan.loops.length ? h("section", null, h("h3", null, "Loops that will run through the kept element"), h("p", null, plan.loops.map((l) => l.label).join(", "))) : null,
          h("section", null, h("h3", null, `Deleted (${plan.others.length})`), h("p", null, plan.others.map((e) => e.label).join(", "))),
          dropped.length ? h("p", { class: "warn-text" }, `Over the limits and not kept: ${dropped.map(([n, w]) => `${n} ${w}`).join(", ")}.`) : null,
          tooMany ? h("p", { class: "error-text" }, `This merge needs ${plan.opCount} changes; one change may have at most ${LIMITS.opsPerRequest}. Merge fewer elements at a time.`) : null,
        ].filter(/** @returns {x is HTMLElement} */ (x) => !!x));
      };
      draw();
      return h("div", { class: "modal wide", "aria-label": "Merge elements" },
        h("h2", null, `Merge ${ids.length} elements`),
        h("p", null, "Everything moves to the element you keep. The merge is one change you can undo."),
        radios, preview,
        h("div", { class: "modal-actions" }, h("button", { type: "button", class: "btn outline", onclick: () => close(false) }, "Cancel"), mergeBtn));
    }, false);
    if (!ok) return;
    // Plan again: the map may have changed while the dialog was open.
    plan = makePlan();
    app.apply(mergeOps(plan, choices, (kind) => app.newId(kind)));
    app.select([survivorId]);
    app.announce(`Merged ${plan.others.length + 1} elements into ${plan.survivor.label}`);
  }

  // --- Dialogs --------------------------------------------------------------------------------------------

  /** @param {string} heading @param {string} body @param {string} action @returns {Promise<boolean>} */
  function confirmDialog(heading, body, action) {
    return modal((close) => h("div", { class: "modal", "aria-label": heading },
      h("h2", null, heading), h("p", null, body),
      h("div", { class: "modal-actions" },
        h("button", { type: "button", class: "btn outline", onclick: () => close(false) }, "Cancel"),
        h("button", { type: "button", class: "btn primary", "data-autofocus": true, onclick: () => close(true) }, action))), false);
  }

  /**
   * Shows `message` in `el` and focuses `focus`.
   * @param {HTMLElement} el @param {string} message @param {HTMLElement} focus
   */
  const problemAt = (el, message, focus) => { el.textContent = message; el.hidden = false; focus.focus(); };

  /** @param {"element"|"connection"} kind @returns {Promise<{name: string, color: string}|null>} */
  function typeDialog(kind) {
    const used = new Set([...app.model.index.types.values()].map((t) => t.color));
    let color = PALETTE.find((c) => !used.has(c)) ?? PALETTE[0];
    return modal((close) => {
      const nameInput = /** @type {HTMLInputElement} */ (h("input", { type: "text", maxlength: LIMITS.typeName, "data-autofocus": true, placeholder: kind === "element" ? "e.g. Organisation" : "e.g. Funds" }));
      const problem = h("p", { class: "error-text", hidden: true, role: "alert" });
      const ok = () => {
        const name = cleanLine(nameInput.value, LIMITS.typeName);
        if (!name) return problemAt(problem, "Give the type a name.", nameInput);
        if ([...app.model.index.types.values()].some((t) => t.appliesTo === kind && normalizeLabel(t.name) === normalizeLabel(name))) {
          return problemAt(problem, `There is already a type called “${name}”.`, nameInput);
        }
        close({ name, color });
      };
      nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok(); } });
      const swatches = h("div", { class: "swatches", role: "radiogroup", "aria-label": "Colour" }, PALETTE.map((c) => h("button", {
        type: "button", class: "swatch", role: "radio", "aria-checked": String(c === color), "aria-label": `Colour ${c}`, style: { background: c },
        onclick: (/** @type {Event} */ e) => {
          color = c;
          for (const b of swatches.children) b.setAttribute("aria-checked", String(b === e.currentTarget));
        },
      })));
      return h("div", { class: "modal", "aria-label": `New ${kind} type` },
        h("h2", null, `New ${kind} type`),
        h("label", { class: "field-row" }, "Name", nameInput),
        h("div", { class: "field-row" }, h("span", { class: "muted" }, "Colour"), swatches),
        problem,
        h("div", { class: "modal-actions" },
          h("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Cancel"),
          h("button", { type: "button", class: "btn primary", onclick: ok }, "Create type")));
    }, /** @type {{name: string, color: string}|null} */ (null));
  }

  /** @param {"element"|"connection"} kind @returns {Promise<Record<string, any>|null>} */
  function fieldDialog(kind) {
    return modal((close) => {
      const nameInput = /** @type {HTMLInputElement} */ (h("input", { type: "text", maxlength: LIMITS.fieldName, "data-autofocus": true, placeholder: "e.g. Budget" }));
      const kindSelect = /** @type {HTMLSelectElement} */ (h("select", null, FIELD_KINDS.map((k) => h("option", { value: k }, KIND_NAMES[k]))));
      const applies = /** @type {HTMLSelectElement} */ (h("select", null,
        h("option", { value: kind }, kind === "element" ? "Elements" : "Connections"), h("option", { value: "both" }, "Elements and connections")));
      const choices = /** @type {HTMLTextAreaElement} */ (h("textarea", { rows: 4, placeholder: "One per line" }));
      const choicesRow = h("label", { class: "field-row", hidden: true }, "Choices", choices);
      const problem = h("p", { class: "error-text", hidden: true, role: "alert" });
      const needsChoices = () => kindSelect.value === "choice" || kindSelect.value === "multichoice";
      kindSelect.addEventListener("change", () => { choicesRow.hidden = !needsChoices(); });
      const ok = () => {
        const name = cleanLine(nameInput.value, LIMITS.fieldName);
        if (!name) return problemAt(problem, "Give the field a name.", nameInput);
        if ([...app.model.index.fields.values()].some((f) => normalizeLabel(f.name) === normalizeLabel(name))) {
          return problemAt(problem, `There is already a field called “${name}”.`, nameInput);
        }
        const list = parseChoices(choices.value);
        if (needsChoices() && !list.length) return problemAt(problem, "Add at least one choice.", choices);
        close({ name, kind: kindSelect.value, appliesTo: applies.value, ...(needsChoices() ? { choices: list } : {}) });
      };
      nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok(); } });
      return h("div", { class: "modal", "aria-label": "Add a field" },
        h("h2", null, "Add a field"),
        h("label", { class: "field-row" }, "Name", nameInput),
        h("div", { class: "nmp-pair" }, h("label", { class: "field-row" }, "Kind", kindSelect), h("label", { class: "field-row" }, "Applies to", applies)),
        choicesRow, problem,
        h("div", { class: "modal-actions" },
          h("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Cancel"),
          h("button", { type: "button", class: "btn primary", onclick: ok }, "Add field")));
    }, /** @type {Record<string, any>|null} */ (null));
  }

  /** @param {"R"|"B"|null} derived @returns {Promise<{label: string, classification: string}|null>} */
  function loopDialog(derived) {
    return modal((close) => {
      const nameInput = /** @type {HTMLInputElement} */ (h("input", { type: "text", maxlength: LIMITS.label, "data-autofocus": true, placeholder: "e.g. Market growth" }));
      const cls = /** @type {HTMLSelectElement} */ (h("select", null,
        h("option", { value: "auto" }, `Automatic: ${derived === "R" ? "reinforcing" : derived === "B" ? "balancing" : "unknown (polarities missing)"}`),
        h("option", { value: "R" }, "R · Reinforcing"), h("option", { value: "B" }, "B · Balancing"), h("option", { value: "" }, "Not classified")));
      const ok = () => close({ label: cleanLine(nameInput.value, LIMITS.label) || "Loop", classification: cls.value });
      nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ok(); } });
      return h("div", { class: "modal", "aria-label": "Create loop" },
        h("h2", null, "Create loop"),
        h("label", { class: "field-row" }, "Name", nameInput),
        h("label", { class: "field-row" }, "Classification", cls),
        h("div", { class: "modal-actions" },
          h("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Cancel"),
          h("button", { type: "button", class: "btn primary", onclick: ok }, "Create loop")));
    }, /** @type {{label: string, classification: string}|null} */ (null));
  }

  // --- Wiring -------------------------------------------------------------------------------------------------

  const offSelection = app.on("selection", () => render(true));
  const offModel = app.on("model", () => render(false));
  const offMode = app.on("mode", () => render(false));
  const offEdit = app.on("editLabel", (/** @type {string} */ id) => {
    pendingLabel = id;
    if (shownKey === id) focusLabel();
  });
  const onFocusOut = () => setTimeout(() => { if (deferred && !focusedEntry()) render(false); });
  root.addEventListener("focusout", onFocusOut);
  render(true);

  return {
    destroy() {
      const a = focusedEntry();
      if (a) entries.get(a)?.commit();
      offSelection(); offModel(); offMode(); offEdit();
      root.removeEventListener("focusout", onFocusOut);
      root.remove();
    },
  };
}

/** @param {unknown[]} a @param {unknown[]} b */
function sameList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** @param {HTMLInputElement} el @returns {[number, number]|null} */
function selectionOf(el) {
  try { return el.selectionStart === null ? null : [el.selectionStart, el.selectionEnd ?? el.selectionStart]; } catch { return null; }
}

/** @param {HTMLInputElement} el @param {[number, number]} range */
function restoreSelection(el, [start, end]) {
  try { el.setSelectionRange(start, end); } catch { /* number and date inputs have no selection */ }
}
