// @ts-check
// The Objects panel: every object as a list (type and a text excerpt) with Select and Show
// buttons, so keyboard and screen-reader users can find, select and reach any object without
// pointing at the canvas.
//
// Like the Activity panel, it is a non-modal side panel (a complementary landmark): the board stays
// usable beside it, Tab moves in and out of it freely, and Escape or the close button closes it.

import { sortedObjects } from "../../shared/protocol.js";
import { h, icon } from "./dom.js";
import { typeLabel } from "./stylebar.js";
import { getIcon } from "../../shared/icons/registry.js";

/** @typedef {import("./app.js").App} App */
/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../store-contract.js").ClientState} ClientState */

const MAX_ROWS = 300;

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

/** @param {App} app */
export function createOutline(app) {
  const { store, canvas } = app;
  /** @type {HTMLElement|null} */
  let panel = null;
  /** @type {HTMLElement|null} */
  let list = null;
  /** @type {HTMLInputElement|null} */
  let filter = null;
  let key = "";
  /** @type {HTMLElement|null} */
  let returnFocus = null;

  function open() {
    if (panel) { filter?.focus(); return; }
    returnFocus = /** @type {HTMLElement|null} */ (document.activeElement);
    const closeBtn = h("button", { type: "button", class: "btn icon-only outline-close", "aria-label": "Close objects list", onclick: () => close() }, icon("close", 18));
    filter = /** @type {HTMLInputElement} */ (h("input", { type: "text", class: "outline-filter", placeholder: "Filter by text or type", "aria-label": "Filter objects", autocomplete: "off" }));
    filter.addEventListener("input", () => { key = ""; render(store.getState()); });
    list = h("ul", { class: "panel-list outline-list", "aria-label": "Objects" });
    panel = h("aside", { class: "wb-panel outline-panel", "aria-label": "Objects", tabindex: "-1" },
      h("div", { class: "panel-head" }, h("h2", null, "Objects"), h("span", { class: "muted outline-count" }), closeBtn),
      h("div", { class: "panel-filter" }, filter),
      list);
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    document.body.appendChild(panel);
    app.outlineOpen = true;
    key = "";
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
    app.outlineOpen = false;
    app.refreshChrome();
    if (restoreFocus) {
      const target = returnFocus?.isConnected ? returnFocus : document.querySelector(".outline-toggle");
      /** @type {HTMLElement|null} */ (target)?.focus();
    }
  }

  /** @param {ClientState} state */
  function render(state) {
    if (!panel || !list) return;
    const q = (filter?.value ?? "").trim().toLowerCase();
    const objects = state.board.objects;
    const selection = new Set(canvas.getSelection());
    const all = sortedObjects(objects).reverse(); // top of the stack first
    const rows = all.filter((o) => !q || typeLabel(o.type).toLowerCase().includes(q) || String(o.text || "").toLowerCase().includes(q) ||
      (o.type === "icon" && describeObject(o, objects).toLowerCase().includes(q)));
    const shown = rows.slice(0, MAX_ROWS);
    const k = q + "#" + shown.map((o) => `${o.id}:${o.version}:${selection.has(o.id) ? 1 : 0}`).join(",") + "#" + rows.length;
    if (k === key) return;
    key = k;
    const countEl = panel.querySelector(".outline-count");
    if (countEl) countEl.textContent = rows.length === all.length ? `${all.length}` : `${rows.length} of ${all.length}`;
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    const focusKey = active && list.contains(active) ? active.dataset.key ?? null : null;
    if (!shown.length) {
      list.replaceChildren(h("li", { class: "muted" }, all.length ? "No objects match." : "The whiteboard is empty."));
    } else {
      list.replaceChildren(...shown.map((o) => {
        const label = `${typeLabel(o.type)}: ${describeObject(o, objects)}`;
        return h("li", { class: "outline-item", dataset: { id: o.id }, "aria-current": selection.has(o.id) ? "true" : null },
          h("span", { class: "summary" },
            h("span", { class: "kind" }, typeLabel(o.type)),
            h("span", { class: "excerpt" }, describeObject(o, objects))),
          h("button", {
            type: "button", class: "btn small outline outline-show", "aria-label": "Show " + label, dataset: { key: "show-" + o.id },
            onclick: () => canvas.focusObjects([o.id]),
          }, "Show"),
          h("button", {
            type: "button", class: "btn small primary outline-select", "aria-label": "Select " + label, dataset: { key: "select-" + o.id },
            onclick: () => {
              canvas.setSelection([o.id]);
              canvas.focusObjects([o.id]);
              close(false);
              app.announce(`Selected ${label}`);
              // Straight to the selection's actions (style, move, delete).
              app.focusStyleBar();
            },
          }, "Select"),
        );
      }), rows.length > shown.length ? h("li", { class: "muted" }, `${rows.length - shown.length} more; filter to narrow down.`) : "");
    }
    if (focusKey) /** @type {HTMLElement|null} */ (list.querySelector(`[data-key="${focusKey}"]`))?.focus();
  }

  return {
    toggle: () => (panel ? close() : open()),
    open, close, render,
    get isOpen() { return !!panel; },
  };
}
