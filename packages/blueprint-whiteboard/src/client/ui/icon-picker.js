// @ts-check
// The icon picker: a non-modal side panel listing the icon and stencil packs
// (src/shared/icons/registry.js) with search, a category filter, recently used icons and keyboard
// navigation. Click, Enter or Space adds an icon at the centre of the view; dragging one onto the
// board adds it where it is dropped. Previews are drawn by the shared renderer from the compiled
// geometry, exactly as the board and the SVG export draw it; nothing is fetched or parsed.
//
// Keyboard: the search field is focused on open; Down moves into the results and Enter there adds
// the best match. The results are one Tab stop: arrow keys move by cell and row, Home/End jump to
// the ends. Escape closes the panel and returns focus to where it was.

import { h, icon } from "./dom.js";
import { PACKS, searchIcons, resolveIcon } from "../../shared/icons/registry.js";
import { objectNode } from "../../shared/render.js";
import { buildNode, svgEl } from "./canvas/layers.js";

/** @typedef {import("./app.js").App} App */
/** @typedef {import("../../shared/icons/registry.js").IconEntry} IconEntry */

/** Drag-and-drop type carrying "packId/iconId" from the picker to the canvas. */
export const ICON_DRAG_TYPE = "application/x-whiteboard-icon";
/** Recently used icons remembered (per viewer, in this browser). */
export const RECENT_MAX = 12;
const RECENT_KEY = "wb-recent-icons";
const SEARCH_ANNOUNCE_MS = 500;
/** Side of a preview, in CSS pixels. */
const PREVIEW = 32;

/** @param {IconEntry} e */
export const iconKey = (e) => e.packId + "/" + e.id;

/**
 * The picker's shortcut: a plain I (no modifiers, not typing into a field or a menu). It does not
 * clash with the tool keys (V H N R O T F C P), A, Shift+O or the browser's own shortcuts.
 * @param {{key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean, isComposing?: boolean}} e
 */
export function isPickerShortcut(e) {
  return (e.key === "i" || e.key === "I") && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;
}

/** @param {IconEntry} e  "Database shape", "User icon" */
export function iconName(e) {
  return `${e.label} ${e.kind === "stencil" ? "shape" : "icon"}`;
}

/**
 * `key` moved to the front of the recent list, without duplicates, at most `max` long.
 * @param {string[]} list @param {string} key @param {number} [max]
 */
export function pushRecent(list, key, max = RECENT_MAX) {
  return [key, ...list.filter((k) => k !== key)].slice(0, max);
}

/**
 * The index focus moves to in a grid of `count` cells, `columns` wide, for a navigation key; null
 * for other keys.
 * @param {number} index @param {string} key @param {number} count @param {number} columns
 * @returns {number|null}
 */
export function gridMove(index, key, count, columns) {
  if (count <= 0) return null;
  const cols = Math.max(1, columns);
  const i = Math.max(0, Math.min(count - 1, index));
  switch (key) {
    case "ArrowRight": return Math.min(count - 1, i + 1);
    case "ArrowLeft": return Math.max(0, i - 1);
    case "ArrowDown": return i + cols < count ? i + cols : i;
    case "ArrowUp": return i - cols >= 0 ? i - cols : i;
    case "Home": return 0;
    case "End": return count - 1;
    case "PageDown": return Math.min(count - 1, i + cols * 4);
    case "PageUp": return Math.max(0, i - cols * 4);
  }
  return null;
}

/**
 * What the picker lists for a query and filter ("all", "recent", or "<packId>:<category>").
 * @param {string} query @param {string} filter @param {string[]} recent
 * @returns {IconEntry[]}
 */
export function pickerResults(query, filter, recent) {
  if (filter === "recent") {
    const entries = /** @type {IconEntry[]} */ (recent.map((k) => resolveIcon(k)).filter(Boolean));
    if (!query.trim()) return entries;
    const matches = new Set(searchIcons(query, { limit: 500 }));
    return entries.filter((e) => matches.has(e));
  }
  if (filter !== "all" && filter.includes(":")) {
    const [packId, category] = filter.split(":");
    return searchIcons(query, { packId, category, limit: 500 });
  }
  return searchIcons(query, { limit: 500 });
}

/**
 * A preview <svg> drawn by the shared renderer.
 * @param {IconEntry} e
 */
export function previewSvg(e) {
  const [vw, vh] = e.vb;
  const stencil = e.kind === "stencil";
  const k = (stencil ? 40 : 24) / Math.max(vw, vh);
  const w = vw * k, hh = vh * k;
  const node = objectNode(/** @type {any} */ ({
    id: "o_000000000000", type: "icon", packId: e.packId, iconId: e.id, x: 0, y: 0, w, h: hh, rot: 0, z: "a0",
    frameId: null, text: "",
    // currentColor follows the theme; stencils preview as outlines.
    style: { fill: "none", stroke: "currentColor", strokeWidth: stencil ? 1.6 : 2, textColor: "currentColor", fontSize: 16, align: "center", arrowStart: "none", arrowEnd: "none" },
  }), () => undefined);
  const pad = 2;
  const side = Math.max(w, hh) + 2 * pad;
  const svg = svgEl("svg", {
    viewBox: `${(w - side) / 2} ${(hh - side) / 2} ${side} ${side}`, width: PREVIEW, height: PREVIEW,
    "aria-hidden": "true", focusable: "false", class: "icon-preview",
  });
  if (node) svg.appendChild(buildNode(node));
  return svg;
}

/** @returns {string[]} */
function loadRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((k) => typeof k === "string" && resolveIcon(k)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** @param {string[]} list */
function saveRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* storage may be blocked in the sandbox */ }
}

export const ICON_PICKER_CSS = `
.icon-picker .picker-controls { display: flex; flex-direction: column; gap: 8px; margin: 10px 12px 0; }
.icon-picker .picker-controls input, .icon-picker .picker-controls select { width: 100%; min-height: 34px; }
.icon-picker select {
  font: inherit; color: var(--text); background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 5px 8px;
}
.icon-picker .picker-scroll { flex: 1; overflow-y: auto; padding-bottom: 16px; }
.icon-picker h3 { margin: 12px 14px 4px; font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; color: var(--text-3); }
.icon-picker .icon-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 4px; padding: 4px 10px; }
.icon-picker .icon-pick {
  flex-direction: column; gap: 2px; min-height: 64px; min-width: 44px; padding: 6px 2px 4px; white-space: normal;
  color: var(--text); cursor: grab;
}
.icon-picker .icon-pick .icon-name {
  font-size: 11px; font-weight: 400; line-height: 1.2; color: var(--text-2); text-align: center; max-width: 100%;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.icon-picker .icon-count { margin: 6px 14px 0; }
@media (max-width: 600px) { .icon-picker .icon-pick { min-height: 64px; } }
`;

/**
 * @param {App} app
 */
export function createIconPicker(app) {
  const { canvas } = app;
  let recent = loadRecent();
  /** @type {HTMLElement|null} */
  let panel = null;
  /** @type {HTMLInputElement|null} */
  let search = null;
  /** @type {HTMLSelectElement|null} */
  let filter = null;
  /** @type {HTMLElement|null} */
  let body = null;
  /** @type {HTMLElement|null} */
  let countEl = null;
  /** @type {HTMLElement|null} */
  let returnFocus = null;
  /** @type {any} */
  let announceTimer = null;
  /** @type {IconEntry[]} */
  let shown = [];

  // A drag from the picker lands on the canvas as an icon at the drop point.
  canvas.element.addEventListener("dragover", (e) => {
    const dt = /** @type {DragEvent} */ (e).dataTransfer;
    if (!dt || ![...dt.types].includes(ICON_DRAG_TYPE)) return;
    e.preventDefault();
    dt.dropEffect = "copy";
  });
  canvas.element.addEventListener("drop", (e) => {
    const d = /** @type {DragEvent} */ (e);
    const ref = d.dataTransfer?.getData(ICON_DRAG_TYPE);
    if (!ref) return;
    e.preventDefault();
    const entry = resolveIcon(ref);
    if (entry) insert(entry, { clientX: d.clientX, clientY: d.clientY });
  });

  // The shortcut, shell-wide like the Add menu's A: from the canvas, the page or the picker itself.
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || !isPickerShortcut(e)) return;
    const t = /** @type {HTMLElement|null} */ (e.target instanceof HTMLElement ? e.target : null);
    if (t && (t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") || t.closest(".modal-scrim, .menu"))) return;
    e.preventDefault();
    if (panel) close(); else open();
  });

  function injectCss() {
    if (document.getElementById("wb-icon-picker-styles")) return;
    document.head.appendChild(h("style", { id: "wb-icon-picker-styles" }, ICON_PICKER_CSS));
  }

  /** @param {IconEntry} entry @param {{clientX: number, clientY: number}} [at] */
  function insert(entry, at) {
    const id = canvas.addIcon({ packId: entry.packId, iconId: entry.id }, at);
    if (!id) return;
    recent = pushRecent(recent, iconKey(entry));
    saveRecent(recent);
    app.announce(`Added ${iconName(entry).toLowerCase()}`);
    // On a phone the panel covers the board: close it so the new icon is visible.
    const phone = typeof matchMedia === "function" && matchMedia("(max-width: 600px)").matches;
    if (phone && !at) close(false);
    // Keep the grid (and focus in it) steady; the recent list catches up on the next render.
    else if (panel && !body?.contains(document.activeElement)) render();
  }

  function open() {
    if (panel) { search?.focus(); return; }
    injectCss();
    returnFocus = /** @type {HTMLElement|null} */ (document.activeElement);
    const closeBtn = h("button", { type: "button", class: "btn icon-only icon-picker-close", "aria-label": "Close icons and shapes", onclick: () => close() }, icon("close", 18));
    search = /** @type {HTMLInputElement} */ (h("input", {
      type: "search", class: "icon-search", placeholder: "Search: database, user, cloud…", "aria-label": "Search icons and shapes",
      autocomplete: "off", spellcheck: "false",
    }));
    filter = /** @type {HTMLSelectElement} */ (h("select", { class: "icon-filter", "aria-label": "Category" },
      h("option", { value: "all" }, "All icons and shapes"),
      h("option", { value: "recent" }, "Recently used"),
      PACKS.map((p) => h("optgroup", { label: p.name },
        p.categories.map((c) => h("option", { value: `${p.id}:${c.id}` }, c.label)))),
    ));
    countEl = h("p", { class: "muted icon-count", "aria-hidden": "true" });
    body = h("div", { class: "picker-scroll" });
    const hintId = "wb-icon-picker-hint";
    panel = h("aside", { class: "wb-panel icon-picker", "aria-label": "Icons and shapes", tabindex: "-1" },
      h("div", { class: "panel-head" }, h("h2", null, "Icons and shapes"), closeBtn),
      h("div", { class: "picker-controls" }, search, filter),
      h("p", { class: "sr-only", id: hintId },
        "Arrow keys move between icons. Enter adds the icon to the middle of the board; you can also drag one onto the board."),
      countEl, body);
    search.setAttribute("aria-describedby", hintId);
    search.addEventListener("input", () => { render(); announceCount(); });
    search.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        focusFirstResult();
      } else if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        if (shown[0]) insert(shown[0]);
      }
    });
    filter.addEventListener("change", () => { render(); announceCount(); });
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    document.body.appendChild(panel);
    app.iconPickerOpen = true;
    render();
    search.focus();
    app.refreshChrome();
  }

  /** @param {boolean} [restoreFocus] */
  function close(restoreFocus = true) {
    if (!panel) return;
    clearTimeout(announceTimer);
    panel.remove();
    panel = search = filter = body = countEl = null;
    app.iconPickerOpen = false;
    app.refreshChrome();
    const target = restoreFocus && returnFocus?.isConnected && returnFocus !== document.body ? returnFocus : canvas.element;
    target.focus({ preventScroll: true });
  }

  function announceCount() {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      app.announce(shown.length ? `${shown.length} ${shown.length === 1 ? "icon" : "icons"}` : "No icons match");
    }, SEARCH_ANNOUNCE_MS);
  }

  function focusFirstResult() {
    const first = /** @type {HTMLElement|null} */ (body?.querySelector(".icon-grid [tabindex='0']") ?? body?.querySelector(".icon-pick"));
    first?.focus();
  }

  /** @param {IconEntry} e */
  function cell(e) {
    const btn = h("button", {
      type: "button", class: "btn icon-pick", tabindex: "-1", draggable: "true",
      "aria-label": iconName(e), title: `${e.label} (${e.pack.name})`, dataset: { key: iconKey(e) },
      onclick: () => insert(e),
    }, previewSvg(e), h("span", { class: "icon-name", "aria-hidden": "true" }, e.label));
    btn.addEventListener("dragstart", (ev) => {
      const dt = /** @type {DragEvent} */ (ev).dataTransfer;
      if (!dt) return;
      dt.setData(ICON_DRAG_TYPE, iconKey(e));
      dt.effectAllowed = "copy";
    });
    return btn;
  }

  /**
   * A roving-focus grid of icons.
   * @param {IconEntry[]} entries @param {string} label
   */
  function grid(entries, label) {
    const el = h("div", { class: "icon-grid", role: "group", "aria-label": label }, entries.map(cell));
    const buttons = () => /** @type {HTMLElement[]} */ ([...el.querySelectorAll(".icon-pick")]);
    const first = buttons()[0];
    if (first) first.tabIndex = 0;
    el.addEventListener("keydown", (e) => {
      const list = buttons();
      const i = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      if (i < 0) return;
      const top = list[0].offsetTop;
      const columns = Math.max(1, list.findIndex((b) => b.offsetTop !== top) === -1 ? list.length : list.findIndex((b) => b.offsetTop !== top));
      const next = gridMove(i, e.key, list.length, columns);
      if (next === null) return;
      e.preventDefault();
      list[i].tabIndex = -1;
      list[next].tabIndex = 0;
      list[next].focus();
    });
    el.addEventListener("focusin", (e) => {
      for (const b of buttons()) b.tabIndex = b === e.target ? 0 : -1;
    });
    return el;
  }

  function render() {
    if (!panel || !body || !search || !filter) return;
    const query = search.value;
    const f = filter.value;
    shown = pickerResults(query, f, recent);
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    const focusKey = active && body.contains(active) ? active.dataset.key ?? null : null;
    /** @type {HTMLElement[]} */
    const parts = [];
    const recentEntries = /** @type {IconEntry[]} */ (recent.map((k) => resolveIcon(k)).filter(Boolean));
    if (f === "all" && !query.trim() && recentEntries.length) {
      parts.push(h("h3", null, "Recently used"), grid(recentEntries, "Recently used"));
      parts.push(h("h3", null, "All icons and shapes"));
    }
    if (shown.length) parts.push(grid(shown, query.trim() ? "Search results" : "Icons and shapes"));
    else parts.push(h("p", { class: "muted", style: { margin: "12px 14px" } },
      f === "recent" && !recent.length ? "Icons you add appear here." : "No icons match. Try another word, such as server or person."));
    body.replaceChildren(...parts);
    if (countEl) countEl.textContent = `${shown.length} ${shown.length === 1 ? "icon" : "icons"}`;
    if (focusKey) {
      const again = /** @type {HTMLElement|null} */ (body.querySelector(`[data-key="${CSS.escape(focusKey)}"]`));
      if (again) { again.tabIndex = 0; again.focus({ preventScroll: true }); }
    }
  }

  return {
    open, close, toggle: () => (panel ? close() : open()),
    get isOpen() { return !!panel; },
  };
}
