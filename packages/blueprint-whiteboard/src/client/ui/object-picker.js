// @ts-check
// A searchable object picker (modal): the keyboard path for choosing an object on the board, used
// by "Reconnect start" and "Reconnect end". A text field filters by type and text; the arrow keys
// move through the matches (a combobox with a listbox, aria-activedescendant), Enter or a click
// chooses, Escape cancels. Focus returns to where it was.

import { sortedObjects } from "../../shared/protocol.js";
import { h } from "./dom.js";
import { modal } from "./dialogs.js";
import { describeObject } from "./outline.js";
import { typeLabel } from "./stylebar.js";

/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {{id: string, label: string, current?: boolean}} PickerOption */

/** Most matches listed at once; typing narrows the rest. */
export const PICKER_MAX = 200;

/**
 * Choices for reconnecting one end of `conn`: every non-connector object except the connector's
 * other endpoint (no self-links), top of the stack first, the current endpoint marked.
 * @param {Record<string, WhiteboardObject>} objects @param {WhiteboardObject} conn @param {"from"|"to"} end
 * @returns {PickerOption[]}
 */
export function reconnectOptions(objects, conn, end) {
  const other = end === "from" ? conn.to : conn.from;
  return sortedObjects(objects).reverse()
    .filter((o) => o.type !== "connector" && o.id !== other)
    .map((o) => ({
      id: o.id,
      label: `${typeLabel(o.type)}: ${describeObject(o, objects)}${o.id === conn[end] ? " (current)" : ""}`,
      current: o.id === conn[end],
    }));
}

/**
 * Options whose label contains every word of `query` (case-insensitive), in their given order.
 * @param {PickerOption[]} options @param {string} query
 */
export function filterOptions(options, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((o) => {
    const label = o.label.toLowerCase();
    return words.every((w) => label.includes(w));
  });
}

let pickers = 0;

/**
 * @param {{title: string, options: PickerOption[], returnFocus?: HTMLElement|null,
 *   searchLabel?: string, placeholder?: string, empty?: string}} opts
 *   searchLabel, placeholder, empty: the search field's name and hint and the no-match message
 *   (default: worded for objects), so other lists (code languages) can reuse the picker
 * @returns {Promise<string|null>}  the chosen id, or null when cancelled
 */
export function openObjectPicker({ title, options, returnFocus = null, searchLabel = "Search objects", placeholder = "Search by text or type", empty = "No objects match." }) {
  const uid = ++pickers;
  return modal((close) => {
    const listId = `wb-picker-list-${uid}`;
    const input = /** @type {HTMLInputElement} */ (h("input", {
      type: "text", class: "picker-filter", role: "combobox", "aria-expanded": "true", "aria-controls": listId,
      "aria-autocomplete": "list", "aria-label": searchLabel, placeholder,
      autocomplete: "off", "data-autofocus": "",
    }));
    const list = h("ul", { id: listId, class: "panel-list picker-list", role: "listbox", "aria-label": title });
    const status = h("p", { class: "muted picker-status", role: "status" });
    /** @type {PickerOption[]} */
    let shown = [];
    let active = 0;

    function render() {
      const matches = filterOptions(options, input.value);
      shown = matches.slice(0, PICKER_MAX);
      active = Math.max(0, Math.min(active, shown.length - 1));
      list.replaceChildren(...shown.map((o, i) => h("li", {
        id: `${listId}-${i}`, role: "option", class: "picker-option" + (i === active ? " active" : ""),
        "aria-selected": String(i === active), dataset: { id: o.id },
        onpointerdown: (/** @type {Event} */ e) => e.preventDefault(),
        onclick: () => close(o.id),
      }, o.label)));
      if (shown.length) input.setAttribute("aria-activedescendant", `${listId}-${active}`);
      else input.removeAttribute("aria-activedescendant");
      status.textContent = !matches.length ? empty
        : matches.length > shown.length ? `${matches.length} matches; showing ${shown.length}. Type to narrow down.`
          : `${matches.length} ${matches.length === 1 ? "match" : "matches"}`;
    }

    /** @param {number} i */
    function move(i) {
      if (!shown.length) return;
      active = (i + shown.length) % shown.length;
      render();
      document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
    }

    input.addEventListener("input", () => { active = 0; render(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); move(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(active - 1); }
      else if (e.key === "Home" && e.ctrlKey) { e.preventDefault(); move(0); }
      else if (e.key === "End" && e.ctrlKey) { e.preventDefault(); move(shown.length - 1); }
      else if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        if (shown[active]) close(shown[active].id);
      }
    });
    active = Math.max(0, options.findIndex((o) => o.current));
    render();
    return h("div", { class: "modal object-picker", "aria-label": title },
      h("h2", null, title),
      input, status, list,
      h("div", { class: "modal-actions" },
        h("button", { type: "button", class: "btn outline", onclick: () => close(null) }, "Cancel"),
      ),
    );
  }, /** @type {string|null} */ (null), returnFocus);
}
