// @ts-check
// The Objects panel: every object as a list (type and a text excerpt) with Select and Show
// buttons, so keyboard and screen-reader users can find, select and reach any object without
// pointing at the canvas. Type filtering and additive selection keep multi-object editing
// available without dragging or modifier keys.
//
// Like the Activity panel, it is a non-modal side panel (a complementary landmark): the board stays
// usable beside it, Tab moves in and out of it freely, and Escape or the close button closes it.
//
// The list is virtualised (./virtual-list.js): every object is listed and counted, but only the
// rows near the scrolled window are in the DOM. Rows carry aria-setsize/aria-posinset; Tab reaches
// one row, the arrow keys move between rows. Select pans the object into view (without animation)
// before focus moves to the style bar, so an off-screen object is on screen when its controls are.

import { sortedObjects, TYPE_DEFAULTS } from "../../shared/protocol.js";
import { h, icon } from "./dom.js";
import { typeLabel } from "./stylebar.js";
import { languageLabel } from "../../shared/code/languages.js";
import { getIcon } from "../../shared/icons/registry.js";
import { createVirtualList } from "./virtual-list.js";

/** @typedef {import("./app.js").App} App */
/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../store-contract.js").ClientState} ClientState */

/** Row height before the first row is measured (kind line, excerpt line, padding). */
const ROW_HEIGHT = 58;

/**
 * @param {WhiteboardObject} o
 * @param {Record<string, WhiteboardObject>} objects
 */
export function describeObject(o, objects) {
  if (o.type === "connector") {
    const from = o.from ? objects[o.from] : null;
    const to = o.to ? objects[o.to] : null;
    const name = (/** @type {WhiteboardObject|null} */ x) => (x ? excerpt(x.text) || typeLabel(x.type).toLowerCase() : "?");
    return `${o.text ? excerpt(o.text) + ": " : ""}from ${name(from)} to ${name(to)}`;
  }
  if (o.type === "code") {
    // "Python — def main():"
    const first = String(o.text || "").split("\n").find((l) => l.trim()) ?? "";
    return `${languageLabel(o.language ?? "plain")}${first ? " — " + excerpt(first) : ""}${o.filename ? ` (${excerpt(o.filename)})` : ""}`;
  }
  if (o.type === "table") {
    const cells = Array.isArray(o.cells) ? o.cells : [];
    const first = cells.flat().find((t) => String(t).trim()) ?? "";
    return `${cells.length} × ${cells[0]?.length ?? 0} table${first ? " — " + excerpt(String(first)) : ""}`;
  }
  if (o.type === "diagram") {
    const first = String(o.text || "").split("\n").find((l) => l.trim()) ?? "";
    return `${o.syntax === "mermaid" ? "Mermaid" : "D2"} diagram${first ? " — " + excerpt(first) : ""}`;
  }
  if (o.type === "icon") {
    // Named by its icon, so a list of icons reads "Database", "User: Customer", ...
    const name = getIcon(o.packId, o.iconId)?.label ?? "unknown icon";
    return o.text ? `${name}: ${excerpt(o.text)}` : name;
  }
  return excerpt(o.text) || (o.type === "pen" ? "freehand stroke" : "no text");
}

/** @param {string} text */
function excerpt(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 57) + "…" : t;
}

/**
 * The rows the panel lists for filter `query`: top of the stack first.
 * @param {Record<string, WhiteboardObject>} objects @param {string} query @param {string} [type]
 */
export function outlineRows(objects, query, type = "") {
  const q = query.trim().toLowerCase();
  const all = sortedObjects(objects).reverse();
  const candidates = type ? all.filter((o) => o.type === type) : all;
  const rows = q ? candidates.filter((o) => typeLabel(o.type).toLowerCase().includes(q) || String(o.text || "").toLowerCase().includes(q) ||
    ((o.type === "icon" || o.type === "code") && describeObject(o, objects).toLowerCase().includes(q))) : candidates;
  return { all: all.length, rows };
}

/** @param {App} app */
export function createOutline(app) {
  const { store, canvas } = app;
  /** @type {HTMLElement|null} */
  let panel = null;
  /** @type {HTMLElement|null} */
  let list = null;
  /** @type {HTMLInputElement|null} */
  let filter = null;
  /** @type {HTMLSelectElement|null} */
  let typeFilter = null;
  /** @type {HTMLElement|null} */
  let selectionActions = null;
  /** @type {ReturnType<typeof createVirtualList>|null} */
  let vlist = null;
  /** @type {WhiteboardObject[]} */
  let rows = [];
  /** @type {Record<string, WhiteboardObject>} */
  let objects = {};
  /** @type {Set<string>} */
  let selection = new Set();
  /** @type {HTMLElement|null} */
  let returnFocus = null;

  function open() {
    if (panel) { filter?.focus(); return; }
    returnFocus = /** @type {HTMLElement|null} */ (document.activeElement);
    const closeBtn = h("button", { type: "button", class: "btn icon-only outline-close", "aria-label": "Close objects list", onclick: () => close() }, icon("close", 18));
    filter = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "outline-filter", placeholder: "Filter by text or type", "aria-label": "Filter objects", autocomplete: "off" }));
    filter.addEventListener("input", () => { if (list) list.scrollTop = 0; render(store.getState()); });
    typeFilter = /** @type {HTMLSelectElement} */ (h("select", { class: "outline-type", "aria-label": "Filter by object type" },
      h("option", { value: "" }, "All types"),
      Object.keys(TYPE_DEFAULTS).map((type) => h("option", { value: type }, typeLabel(type)))));
    typeFilter.addEventListener("change", () => { if (list) list.scrollTop = 0; render(store.getState()); announceResults(); });
    filter.addEventListener("keydown", (e) => {
      if ((e.key === "ArrowDown" || e.key === "Enter") && rows.length) { e.preventDefault(); vlist?.focusRow(0, 0); }
    });
    const done = h("button", { type: "button", class: "btn small primary outline-edit-selection", onclick: () => {
      const ids = canvas.getSelection();
      if (!ids.length) return;
      canvas.focusObjects(ids, { animate: false });
      close(false);
      app.focusStyleBar();
    } }, "Edit selection");
    const clear = h("button", { type: "button", class: "btn small outline outline-clear-selection", onclick: () => {
      if (!canvas.getSelection().length) return;
      canvas.setSelection([]); render(store.getState()); app.announce("Selection cleared");
    } }, "Clear selection");
    selectionActions = h("div", { class: "outline-selection-actions" }, done, clear);
    const hint = h("p", { id: "outline-hint", class: "sr-only" }, "Up and down arrows move between objects; Home and End jump to the first and last. Use Include in selection to select several objects, then Edit selection.");
    list = h("ul", { class: "panel-list outline-list", "aria-label": "Objects", "aria-describedby": "outline-hint", tabindex: "-1" });
    panel = h("aside", { class: "wb-panel outline-panel", "aria-label": "Objects", tabindex: "-1" },
      h("div", { class: "panel-head" }, h("h2", null, "Objects"), h("span", { class: "muted outline-count", role: "status", "aria-live": "polite", "aria-atomic": "true" }), closeBtn),
      h("div", { class: "panel-filter" }, filter, typeFilter),
      selectionActions,
      hint,
      list);
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    vlist = createVirtualList({
      list,
      rowHeight: ROW_HEIGHT,
      rowKey: (i) => rows[i].id,
      rowStamp: (i) => stampOf(rows[i]),
      renderRow: (i) => rowFor(rows[i]),
      fallbackFocus: () => filter,
    });
    document.body.appendChild(panel);
    app.outlineOpen = true;
    render(store.getState());
    filter.focus();
    app.refreshChrome();
  }

  /** @param {boolean} [restoreFocus] */
  function close(restoreFocus = true) {
    if (!panel) return;
    panel.remove();
    panel = null;
    list = null;
    filter = null;
    typeFilter = null;
    selectionActions = null;
    vlist = null;
    rows = [];
    app.outlineOpen = false;
    app.refreshChrome();
    if (restoreFocus) {
      const target = returnFocus?.isConnected ? returnFocus : document.querySelector(".outline-toggle");
      /** @type {HTMLElement|null} */ (target)?.focus();
    }
  }

  function announceResults() {
    app.announce(`${rows.length} ${rows.length === 1 ? "object" : "objects"} found`);
  }

  /** What a row shows: rebuild when it changes. @param {WhiteboardObject} o */
  function stampOf(o) {
    let s = `${o.version}:${selection.has(o.id) ? 1 : 0}`;
    if (o.type === "connector") s += `:${o.from ? objects[o.from]?.version : ""}:${o.to ? objects[o.to]?.version : ""}`;
    return s;
  }

  /** @param {WhiteboardObject} o */
  function rowFor(o) {
    const label = `${typeLabel(o.type)}: ${describeObject(o, objects)}`;
    return h("li", { class: "outline-item", dataset: { id: o.id }, "aria-current": selection.has(o.id) ? "true" : null },
      h("span", { class: "summary" },
        h("span", { class: "kind" }, typeLabel(o.type)),
        h("span", { class: "excerpt" }, describeObject(o, objects))),
      h("button", {
        type: "button", class: "btn small outline outline-show", "aria-label": "Show " + label,
        onclick: () => canvas.focusObjects([o.id]),
      }, "Show"),
      h("button", {
        type: "button", class: "btn small primary outline-select", "aria-label": "Select " + label,
        onclick: () => {
          canvas.setSelection([o.id]);
          // Camera first (no animation), so the object is on screen before focus moves on.
          canvas.focusObjects([o.id], { animate: false });
          close(false);
          app.announce(`Selected ${label}`);
          // Straight to the selection's actions (style, move, delete).
          app.focusStyleBar();
        },
      }, "Select"),
      h("button", {
        type: "button", class: "btn small outline outline-toggle-selection",
        "aria-label": "Include in selection: " + label, "aria-pressed": String(selection.has(o.id)),
        onclick: () => {
          const ids = canvas.getSelection();
          const selected = ids.includes(o.id);
          canvas.setSelection(selected ? ids.filter((id) => id !== o.id) : [...ids, o.id]);
          render(store.getState());
          app.announce(`${selected ? "Removed" : "Added"} ${label}. ${canvas.getSelection().length} selected.`);
        },
      }, selection.has(o.id) ? "−" : "+"),
    );
  }

  /** @param {ClientState} state */
  function render(state) {
    if (!panel || !list || !vlist) return;
    objects = state.board.objects;
    selection = new Set(canvas.getSelection());
    const result = outlineRows(objects, filter?.value ?? "", typeFilter?.value ?? "");
    rows = result.rows;
    const countEl = panel.querySelector(".outline-count");
    const text = rows.length === result.all ? `${result.all} objects` : `${rows.length} of ${result.all} objects`;
    if (selectionActions) {
      const done = selectionActions.querySelector(".outline-edit-selection");
      const clear = selectionActions.querySelector(".outline-clear-selection");
      done?.setAttribute("aria-disabled", String(!selection.size));
      clear?.setAttribute("aria-disabled", String(!selection.size));
      if (done) done.textContent = selection.size ? `Edit selection (${selection.size})` : "Edit selection";
    }
    if (countEl && countEl.textContent !== text) countEl.textContent = text;
    vlist.update(rows.length, rows.length ? null : h("li", { class: "muted" }, result.all ? "No objects match." : "The whiteboard is empty."));
  }

  return {
    toggle: () => (panel ? close() : open()),
    open, close, render,
    get isOpen() { return !!panel; },
    /** The virtual list (tests). */
    get list() { return vlist; },
  };
}
