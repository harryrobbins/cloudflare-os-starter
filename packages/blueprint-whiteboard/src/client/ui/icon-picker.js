// @ts-check
// The icon picker: a non-modal side panel with two tabs.
//
// "Icons & shapes" lists the icon and stencil packs (src/shared/icons/registry.js) with search, a
// category filter, recently used icons and keyboard navigation. Click, Enter or Space adds an icon
// at the centre of the view; dragging one onto the board adds it where it is dropped. Previews are
// drawn by the shared renderer from the compiled geometry, exactly as the board and the SVG export
// draw it; nothing is fetched or parsed.
//
// "Emoji & symbols" lists every current emoji and a curated set of Unicode symbols (./unicode.js)
// with search by name and keywords, categories, recent picks and a skin tone choice. A pick goes
// into the text being edited, at the caret, when an inline text edit is open (the panel is marked
// `data-wb-keeps-editor`, so moving focus into it does not end the edit); otherwise it becomes a
// text object sized for the character. Emoji are plain text drawn by each viewer's system font.
//
// Keyboard: the tabs are one Tab stop (arrow keys, Home and End switch tabs); the search field is
// focused on open; Down moves into the results and Enter there adds the best match. The results
// are one Tab stop: arrow keys move by cell and row, Home/End jump to the ends. Escape closes the
// panel and returns focus to where it was (to the text edit, when one is open). The last tab and
// skin tone are remembered for the session.

import { h, icon } from "./dom.js";
import { PACKS, searchIcons, resolveIcon } from "../../shared/icons/registry.js";
import { objectNode, FONT_FAMILY } from "../../shared/render.js";
import { buildNode, svgEl } from "./canvas/layers.js";
import {
  CHAR_CATEGORIES, SKIN_TONES, applySkinTone, charAccessibleName, charLabel, isSequence, pushRecentChar,
  resolveChar, searchChars, RECENT_CHARS_MAX,
} from "./unicode.js";

/** @typedef {import("./app.js").App} App */
/** @typedef {import("../../shared/icons/registry.js").IconEntry} IconEntry */
/** @typedef {import("./unicode.js").CharEntry} CharEntry */
/** @typedef {"icons"|"unicode"} PickerTab */

/** Drag-and-drop type carrying "packId/iconId" from the picker to the canvas. */
export const ICON_DRAG_TYPE = "application/x-whiteboard-icon";
/** Drag-and-drop type carrying an emoji or symbol, as JSON {text, key}, from the picker to the canvas. */
export const CHAR_DRAG_TYPE = "application/x-whiteboard-char";
/** Recently used icons remembered (per viewer, in this browser). */
export const RECENT_MAX = 12;
const RECENT_KEY = "wb-recent-icons";
const RECENT_CHARS_KEY = "wb-recent-chars";
const TAB_KEY = "wb-picker-tab";
const TONE_KEY = "wb-skin-tone";
const SEARCH_ANNOUNCE_MS = 500;
/** Side of a preview, in CSS pixels. */
const PREVIEW = 32;

/** The picker's tabs, in order. @type {readonly {id: PickerTab, label: string}[]} */
export const PICKER_TABS = Object.freeze([
  { id: "icons", label: "Icons & shapes" },
  { id: "unicode", label: "Emoji & symbols" },
]);

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
 * The tab focus moves to from tab `index` for a key (ARIA tabs: arrows wrap, Home and End jump),
 * or null for other keys.
 * @param {number} index @param {string} key @param {number} count
 * @returns {number|null}
 */
export function tabKeyMove(index, key, count) {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight": return (index + 1) % count;
    case "ArrowLeft": return (index - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
  }
  return null;
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
 * Like gridMove, for cells laid out in rows of different lengths (a grid with section headings):
 * Up and Down go to the cell nearest in x on the previous or next row, Page keys four rows.
 * `cells` are the cells' left and top edges, in order.
 * @param {number} index @param {string} key @param {{x: number, y: number}[]} cells
 * @returns {number|null}
 */
export function gridMoveByPosition(index, key, cells) {
  const count = cells.length;
  if (count <= 0) return null;
  const i = Math.max(0, Math.min(count - 1, index));
  const rows = key === "ArrowDown" || key === "ArrowUp" ? 1 : key === "PageDown" || key === "PageUp" ? 4 : 0;
  if (!rows) return gridMove(i, key, count, 1);
  const down = key === "ArrowDown" || key === "PageDown";
  let best = i;
  let rowY = cells[i].y;
  for (let r = 0; r < rows; r++) {
    // The top of the next row in the direction of travel.
    let next = null;
    for (const c of cells) {
      if (down ? c.y > rowY + 0.5 : c.y < rowY - 0.5) {
        if (next === null || (down ? c.y < next : c.y > next)) next = c.y;
      }
    }
    if (next === null) break;
    rowY = next;
    let bestDx = Infinity;
    cells.forEach((c, k) => {
      if (Math.abs(c.y - /** @type {number} */ (rowY)) > 0.5) return;
      const dx = Math.abs(c.x - cells[i].x);
      if (dx < bestDx) { bestDx = dx; best = k; }
    });
  }
  return best;
}

/**
 * What the icons tab lists for a query and filter ("all", "recent", or "<packId>:<category>").
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
 * What the emoji and symbols tab lists for a query and filter ("all", "recent", "emoji", "symbol"
 * or a CHAR_CATEGORIES id).
 * @param {string} query @param {string} filter @param {string[]} recent  plain (untoned) texts
 * @returns {CharEntry[]}
 */
export function charResults(query, filter, recent) {
  if (filter === "recent") {
    const entries = /** @type {CharEntry[]} */ (recent.map((t) => resolveChar(t)).filter(Boolean));
    if (!query.trim()) return entries;
    const matches = new Set(searchChars(query));
    return entries.filter((e) => matches.has(e));
  }
  return searchChars(query, { category: filter });
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

/** @param {string} key @param {(k: string) => unknown} valid @param {number} max @returns {string[]} */
function loadList(key, valid, max) {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(raw) ? raw.filter((k) => typeof k === "string" && valid(k)).slice(0, max) : [];
  } catch {
    return [];
  }
}

/** @param {string} key @param {string[]} list */
function saveList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* storage may be blocked in the sandbox */ }
}

// The last tab and skin tone, for this session. sessionStorage survives a reload of the frame; the
// module variables cover sandboxes where it is blocked.
/** @type {PickerTab} */
let sessionTab = "icons";
let sessionTone = 0;
/** @param {string} key @returns {string|null} */
function sessionGet(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
/** @param {string} key @param {string} value */
function sessionSet(key, value) {
  try { sessionStorage.setItem(key, value); } catch { /* blocked */ }
}

/**
 * Whether the viewer's fonts draw `text` as one glyph. Only sequences (joined emoji, flags,
 * keycaps) are checked: a font without them draws their parts side by side, much wider than one
 * emoji. Anything that cannot be measured counts as drawable.
 * @type {(text: string) => boolean}
 */
const canDraw = (() => {
  /** @type {Map<string, boolean>} */
  const cache = new Map();
  /** @type {CanvasRenderingContext2D|null|undefined} */
  let ctx;
  let unit = 0;
  return (text) => {
    if (!isSequence(text)) return true;
    const known = cache.get(text);
    if (known !== undefined) return known;
    let ok = true;
    try {
      if (ctx === undefined) {
        ctx = document.createElement("canvas").getContext("2d");
        if (ctx) {
          ctx.font = `32px ${FONT_FAMILY}`;
          unit = ctx.measureText("\u{1F600}").width;
        }
      }
      if (ctx && unit > 0) ok = ctx.measureText(text).width <= unit * 1.5;
    } catch {
      ok = true;
    }
    cache.set(text, ok);
    return ok;
  };
})();

export const ICON_PICKER_CSS = `
.icon-picker .picker-tabs { display: flex; gap: 4px; margin: 10px 12px 0; border-bottom: 1px solid var(--border); }
.icon-picker .picker-tab {
  flex: 1; min-height: 36px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none;
  color: var(--text-2); font: inherit; font-weight: 600; cursor: pointer; padding: 6px 8px;
}
.icon-picker .picker-tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.icon-picker .picker-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.icon-picker .picker-tabpanel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.icon-picker .picker-tabpanel[hidden] { display: none; }
.icon-picker .picker-controls { display: flex; flex-direction: column; gap: 8px; margin: 10px 12px 0; }
.icon-picker .picker-controls input, .icon-picker .picker-controls select { width: 100%; min-height: 34px; }
.icon-picker .picker-row { display: flex; gap: 8px; }
.icon-picker .picker-row select { flex: 1; min-width: 0; }
.icon-picker .picker-row select.skin-tone { flex: 0 0 auto; width: auto; }
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
.icon-picker .char-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(44px, 1fr)); gap: 2px; padding: 4px 10px; }
.icon-picker .char-grid h3 { grid-column: 1 / -1; margin: 10px 4px 2px; }
.icon-picker .char-pick {
  min-width: 44px; min-height: 44px; padding: 0; color: var(--text); cursor: grab;
  font-family: ${FONT_FAMILY}; font-size: 26px; font-weight: 400; line-height: 1;
}
.icon-picker .char-pick .glyph { pointer-events: none; }
.icon-picker .icon-count { margin: 6px 14px 0; }
.icon-picker .picker-note { margin: 4px 14px 0; font-size: 12px; }
@media (max-width: 600px) {
  .icon-picker .icon-pick { min-height: 64px; }
  .icon-picker .picker-tab, .icon-picker .picker-controls input, .icon-picker .picker-controls select { min-height: 44px; }
}
`;

/**
 * @param {App} app
 */
export function createIconPicker(app) {
  const { canvas } = app;
  let recent = loadList(RECENT_KEY, (k) => resolveIcon(k), RECENT_MAX);
  let recentChars = loadList(RECENT_CHARS_KEY, (k) => resolveChar(k), RECENT_CHARS_MAX);
  const storedTab = sessionGet(TAB_KEY);
  if (storedTab === "icons" || storedTab === "unicode") sessionTab = storedTab;
  const storedTone = Number(sessionGet(TONE_KEY));
  if (Number.isInteger(storedTone) && storedTone >= 0 && storedTone < SKIN_TONES.length) sessionTone = storedTone;

  /** @type {HTMLElement|null} */
  let panel = null;
  /** @type {HTMLElement|null} */
  let returnFocus = null;
  /** @type {any} */
  let announceTimer = null;
  /** @type {PickerTab} */
  let tab = sessionTab;
  /** @type {Record<string, HTMLElement>} */
  let tabButtons = {};
  /** @type {Partial<Record<PickerTab, View>>} */
  let views = {};

  /**
   * One tab's content.
   * @typedef {object} View
   * @property {HTMLElement} el          the tabpanel
   * @property {HTMLInputElement} search
   * @property {() => void} render
   * @property {() => void} announce
   * @property {() => void} insertBest
   */

  // A drag from the picker lands on the canvas as an icon (or a text object) at the drop point.
  canvas.element.addEventListener("dragover", (e) => {
    const dt = /** @type {DragEvent} */ (e).dataTransfer;
    if (!dt) return;
    const types = [...dt.types];
    if (!types.includes(ICON_DRAG_TYPE) && !types.includes(CHAR_DRAG_TYPE)) return;
    // Over the text editor, the browser itself inserts the text/plain part where it is dropped.
    if (e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    dt.dropEffect = "copy";
  });
  canvas.element.addEventListener("drop", (e) => {
    const d = /** @type {DragEvent} */ (e);
    if (e.target instanceof HTMLTextAreaElement) return;
    const at = { clientX: d.clientX, clientY: d.clientY };
    const ref = d.dataTransfer?.getData(ICON_DRAG_TYPE);
    if (ref) {
      e.preventDefault();
      const entry = resolveIcon(ref);
      if (entry) insertIcon(entry, at);
      return;
    }
    const raw = d.dataTransfer?.getData(CHAR_DRAG_TYPE);
    if (!raw) return;
    e.preventDefault();
    try {
      const { text, key } = JSON.parse(raw);
      if (typeof text === "string" && text) insertText(text, typeof key === "string" ? resolveChar(key) : null, { at });
    } catch { /* not ours */ }
  });

  // The I shortcut is a keymap.js COMMANDS row; app.js routes it to toggle(), and Ctrl/⌘+. to
  // open("unicode").

  function injectCss() {
    if (document.getElementById("wb-icon-picker-styles")) return;
    document.head.appendChild(h("style", { id: "wb-icon-picker-styles" }, ICON_PICKER_CSS));
  }

  function isPhone() {
    return typeof matchMedia === "function" && matchMedia("(max-width: 600px)").matches;
  }

  /** @param {IconEntry} entry @param {{clientX: number, clientY: number}} [at] */
  function insertIcon(entry, at) {
    const id = canvas.addIcon({ packId: entry.packId, iconId: entry.id }, at);
    if (!id) return;
    recent = pushRecent(recent, iconKey(entry));
    saveList(RECENT_KEY, recent);
    app.announce(`Added ${iconName(entry).toLowerCase()}`);
    afterInsert(!!at);
  }

  /**
   * @param {string} text what to insert (skin tone applied)
   * @param {CharEntry|null} entry
   * @param {{at?: {clientX: number, clientY: number}, pointer?: boolean}} [opts]
   */
  function insertText(text, entry, { at, pointer = false } = {}) {
    const editing = !!canvas.getTextEdit();
    const result = canvas.insertText(text, at ? { at } : {});
    const label = entry ? charLabel(entry) : text;
    if (!result) {
      app.announce(editing && !at ? "The text is at its length limit; nothing was inserted" : `Could not add ${label}`);
      return;
    }
    if (entry) {
      recentChars = pushRecentChar(recentChars, entry.text);
      saveList(RECENT_CHARS_KEY, recentChars);
    }
    if (result.mode === "caret") {
      app.announce(`Inserted ${label}`);
      // A click goes back to typing; from the keyboard, focus stays in the grid for more picks.
      if (pointer) canvas.focusTextEdit();
      else if (panel && !views.unicode?.el.contains(document.activeElement)) views.unicode?.render();
      return;
    }
    app.announce(`Added ${label.toLowerCase()}`);
    afterInsert(!!at);
  }

  /** @param {boolean} dropped */
  function afterInsert(dropped) {
    // On a phone the panel covers the board: close it so the new object is visible.
    if (isPhone() && !dropped) close(false);
    // Keep the grid (and focus in it) steady; the recent list catches up on the next render.
    else if (panel && !views[tab]?.el.contains(document.activeElement)) views[tab]?.render();
  }

  /** @param {PickerTab} [which]  the tab to show (default: the last one this session) */
  function open(which) {
    if (panel) {
      if (which && which !== tab) selectTab(which, false);
      views[tab]?.search.focus();
      return;
    }
    injectCss();
    returnFocus = /** @type {HTMLElement|null} */ (document.activeElement);
    tab = which ?? sessionTab;
    sessionTab = tab;
    sessionSet(TAB_KEY, tab);
    const closeBtn = h("button", { type: "button", class: "btn icon-only icon-picker-close", "aria-label": "Close the picker", onclick: () => close() }, icon("close", 18));
    const tablist = h("div", { class: "picker-tabs", role: "tablist", "aria-label": "What to insert" },
      PICKER_TABS.map((t) => h("button", {
        type: "button", role: "tab", class: "picker-tab", id: `wb-picker-tab-${t.id}`,
        "aria-controls": `wb-picker-panel-${t.id}`, "aria-selected": String(t.id === tab), tabindex: t.id === tab ? "0" : "-1",
        dataset: { tab: t.id }, onclick: () => selectTab(t.id, true),
      }, t.label)));
    tabButtons = Object.fromEntries([...tablist.children].map((b) => [/** @type {HTMLElement} */ (b).dataset.tab ?? "", /** @type {HTMLElement} */ (b)]));
    tablist.addEventListener("keydown", (e) => {
      const order = PICKER_TABS.map((t) => t.id);
      const next = tabKeyMove(order.indexOf(tab), e.key, order.length);
      if (next === null) return;
      e.preventDefault();
      selectTab(order[next], false);
      tabButtons[order[next]].focus();
    });
    views = {};
    panel = h("aside", {
      class: "wb-panel icon-picker", "aria-label": "Icons, shapes, emoji and symbols", tabindex: "-1",
      // Focus moving in here keeps an inline text edit open, so picks go in at its caret.
      "data-wb-keeps-editor": "",
    },
      h("div", { class: "panel-head" }, h("h2", null, "Insert"), closeBtn),
      tablist);
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === ".") { e.preventDefault(); selectTab("unicode", true); }
    });
    // While a text edit is open, a press on a result keeps focus (and the caret) in the editor.
    panel.addEventListener("pointerdown", (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (canvas.getTextEdit() && t.closest?.(".char-pick") && document.activeElement?.classList.contains("wb-editor")) e.preventDefault();
    });
    // Focus leaving the panel for anything but the text editor ends a text edit left open.
    panel.addEventListener("focusout", (e) => {
      const to = /** @type {HTMLElement|null} */ (e.relatedTarget);
      if (!panel || (to && (panel.contains(to) || to.classList?.contains("wb-editor")))) return;
      if (canvas.getTextEdit()) canvas.finishTextEdit();
    });
    document.body.appendChild(panel);
    app.iconPickerOpen = true;
    showTab(tab);
    views[tab]?.search.focus();
    app.refreshChrome();
  }

  /** @param {PickerTab} which @param {boolean} focusSearch */
  function selectTab(which, focusSearch) {
    if (!panel) return;
    tab = which;
    sessionTab = which;
    sessionSet(TAB_KEY, which);
    showTab(which);
    if (focusSearch) views[which]?.search.focus();
  }

  /** @param {PickerTab} which */
  function showTab(which) {
    if (!panel) return;
    for (const t of PICKER_TABS) {
      const btn = tabButtons[t.id];
      btn.setAttribute("aria-selected", String(t.id === which));
      btn.tabIndex = t.id === which ? 0 : -1;
    }
    if (!views[which]) {
      const view = which === "icons" ? iconsView() : unicodeView();
      views[which] = view;
      panel.appendChild(view.el);
      view.render();
    }
    for (const [id, v] of Object.entries(views)) v.el.hidden = id !== which;
  }

  /** @param {boolean} [restoreFocus] */
  function close(restoreFocus = true) {
    if (!panel) return;
    clearTimeout(announceTimer);
    // An edit still open goes back to typing; otherwise focus returns to where it came from.
    const editing = !!canvas.getTextEdit();
    if (editing && restoreFocus) canvas.focusTextEdit();
    const el = panel;
    panel = null;
    views = {};
    el.remove();
    app.iconPickerOpen = false;
    app.refreshChrome();
    if (editing && restoreFocus) return;
    if (editing) canvas.finishTextEdit();
    const target = restoreFocus && returnFocus?.isConnected && returnFocus !== document.body && !returnFocus.classList.contains("wb-editor") ? returnFocus : canvas.element;
    target.focus({ preventScroll: true });
  }

  /** @param {string} message */
  function announceLater(message) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => app.announce(message), SEARCH_ANNOUNCE_MS);
  }

  /**
   * The parts both tabs share: the tabpanel, a search field, the category select and a scroller.
   * @param {PickerTab} id @param {{placeholder: string, searchLabel: string, hint: string}} text
   * @param {HTMLSelectElement} filter @param {HTMLElement[]} [extra]  more controls beside the filter
   */
  function viewShell(id, text, filter, extra = []) {
    const search = /** @type {HTMLInputElement} */ (h("input", {
      type: "search", class: id === "icons" ? "icon-search" : "char-search", placeholder: text.placeholder, "aria-label": text.searchLabel,
      autocomplete: "off", spellcheck: "false",
    }));
    const countEl = h("p", { class: "muted icon-count", "aria-hidden": "true" });
    const note = h("p", { class: "muted picker-note", hidden: true });
    const body = h("div", { class: "picker-scroll" });
    const hintId = `wb-picker-hint-${id}`;
    const el = h("div", { class: "picker-tabpanel", role: "tabpanel", id: `wb-picker-panel-${id}`, "aria-labelledby": `wb-picker-tab-${id}` },
      h("div", { class: "picker-controls" }, search, extra.length ? h("div", { class: "picker-row" }, filter, ...extra) : filter),
      h("p", { class: "sr-only", id: hintId }, text.hint),
      countEl, note, body);
    search.setAttribute("aria-describedby", hintId);
    return { el, search, countEl, note, body };
  }

  /**
   * Roving focus over the cells in `el`: one Tab stop, arrow keys move.
   * @param {HTMLElement} el @param {string} selector @param {boolean} byPosition  rows may differ in length
   */
  function rovingGrid(el, selector, byPosition) {
    const buttons = () => /** @type {HTMLElement[]} */ ([...el.querySelectorAll(selector)]);
    const first = buttons()[0];
    if (first) first.tabIndex = 0;
    el.addEventListener("keydown", (e) => {
      const list = buttons();
      const i = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      if (i < 0) return;
      let next;
      if (byPosition) {
        next = gridMoveByPosition(i, e.key, list.map((b) => ({ x: b.offsetLeft, y: b.offsetTop })));
      } else {
        const top = list[0].offsetTop;
        const columns = Math.max(1, list.findIndex((b) => b.offsetTop !== top) === -1 ? list.length : list.findIndex((b) => b.offsetTop !== top));
        next = gridMove(i, e.key, list.length, columns);
      }
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

  /**
   * Re-focuses the cell that had focus before a re-render, if it is still there.
   * @param {HTMLElement} body @param {string|null} key
   */
  function refocus(body, key) {
    if (!key) return;
    const again = /** @type {HTMLElement|null} */ (body.querySelector(`[data-key="${CSS.escape(key)}"]`));
    if (!again) return;
    for (const b of body.querySelectorAll("[tabindex='0']")) /** @type {HTMLElement} */ (b).tabIndex = -1;
    again.tabIndex = 0;
    again.focus({ preventScroll: true });
  }

  /** @returns {View} */
  function iconsView() {
    const filter = /** @type {HTMLSelectElement} */ (h("select", { class: "icon-filter", "aria-label": "Category" },
      h("option", { value: "all" }, "All icons and shapes"),
      h("option", { value: "recent" }, "Recently used"),
      PACKS.map((p) => h("optgroup", { label: p.name },
        p.categories.map((c) => h("option", { value: `${p.id}:${c.id}` }, c.label)))),
    ));
    const { el, search, countEl, body } = viewShell("icons", {
      placeholder: "Search: database, user, cloud…", searchLabel: "Search icons and shapes",
      hint: "Arrow keys move between icons. Enter adds the icon to the middle of the board; you can also drag one onto the board.",
    }, filter);
    /** @type {IconEntry[]} */
    let shown = [];

    /** @param {IconEntry} e */
    const cell = (e) => {
      const btn = h("button", {
        type: "button", class: "btn icon-pick", tabindex: "-1", draggable: "true",
        "aria-label": iconName(e), title: `${e.label} (${e.pack.name})`, dataset: { key: iconKey(e) },
        onclick: () => insertIcon(e),
      }, previewSvg(e), h("span", { class: "icon-name", "aria-hidden": "true" }, e.label));
      btn.addEventListener("dragstart", (ev) => {
        const dt = /** @type {DragEvent} */ (ev).dataTransfer;
        if (!dt) return;
        dt.setData(ICON_DRAG_TYPE, iconKey(e));
        dt.effectAllowed = "copy";
      });
      return btn;
    };
    /** @param {IconEntry[]} entries @param {string} label */
    const grid = (entries, label) =>
      rovingGrid(h("div", { class: "icon-grid", role: "group", "aria-label": label }, entries.map(cell)), ".icon-pick", false);

    function render() {
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
      countEl.textContent = `${shown.length} ${shown.length === 1 ? "icon" : "icons"}`;
      refocus(body, focusKey);
    }
    /** @type {View} */
    const view = {
      el, search, render,
      announce: () => announceLater(shown.length ? `${shown.length} ${shown.length === 1 ? "icon" : "icons"}` : "No icons match"),
      insertBest: () => { if (shown[0]) insertIcon(shown[0]); },
    };
    wireSearch(view, body, filter);
    return view;
  }

  /** @returns {View} */
  function unicodeView() {
    const emojiCats = CHAR_CATEGORIES.filter((c) => c.kind === "emoji");
    const symbolCats = CHAR_CATEGORIES.filter((c) => c.kind === "symbol");
    const filter = /** @type {HTMLSelectElement} */ (h("select", { class: "char-filter", "aria-label": "Category" },
      h("option", { value: "all" }, "All emoji and symbols"),
      h("option", { value: "recent" }, "Recently used"),
      h("optgroup", { label: "Emoji" }, h("option", { value: "emoji" }, "All emoji"), emojiCats.map((c) => h("option", { value: c.id }, c.label))),
      h("optgroup", { label: "Symbols" }, h("option", { value: "symbol" }, "All symbols"), symbolCats.map((c) => h("option", { value: c.id }, c.label))),
    ));
    const tone = /** @type {HTMLSelectElement} */ (h("select", { class: "skin-tone", "aria-label": "Skin tone", title: "Skin tone for emoji that have one" },
      SKIN_TONES.map((t) => h("option", { value: String(t.tone) }, `✋${t.modifier} ${t.tone ? t.label.replace(/ skin tone$/, "") : "Default"}`))));
    tone.value = String(sessionTone);
    const { el, search, countEl, note, body } = viewShell("unicode", {
      placeholder: "Search: smile, arrow, tick…", searchLabel: "Search emoji and symbols",
      hint: "Arrow keys move between characters. Enter inserts the character into the text you are editing, or adds it to the middle of the board; you can also drag one onto the board.",
    }, filter, [tone]);
    /** @type {CharEntry[]} */
    let shown = [];
    const labelOf = new Map(CHAR_CATEGORIES.map((c) => [c.id, c.label]));

    /** @param {CharEntry} e */
    const cell = (e) => {
      const text = e.kind === "emoji" ? applySkinTone(e, sessionTone) : e.text;
      const btn = h("button", {
        type: "button", class: "btn char-pick", tabindex: "-1", draggable: "true",
        "aria-label": charAccessibleName(e) + (text !== e.text ? `, ${SKIN_TONES[sessionTone].label.toLowerCase()}` : ""),
        title: charLabel(e), dataset: { key: e.text },
        onclick: (/** @type {MouseEvent} */ ev) => insertText(text, e, { pointer: ev.detail > 0 }),
      }, h("span", { class: "glyph", "aria-hidden": "true" }, text));
      btn.addEventListener("dragstart", (ev) => {
        const dt = /** @type {DragEvent} */ (ev).dataTransfer;
        if (!dt) return;
        dt.setData(CHAR_DRAG_TYPE, JSON.stringify({ text, key: e.text }));
        dt.setData("text/plain", text);
        dt.effectAllowed = "copy";
      });
      return btn;
    };

    function render() {
      const query = search.value;
      const q = query.trim();
      const f = filter.value;
      const results = charResults(query, f, recentChars);
      shown = results.filter((e) => canDraw(e.text));
      const hidden = results.length - shown.length;
      const active = /** @type {HTMLElement|null} */ (document.activeElement);
      const focusKey = active && body.contains(active) ? active.dataset.key ?? null : null;
      /** @type {HTMLElement[]} */
      const cells = [];
      const recentEntries = f === "all" && !q
        ? /** @type {CharEntry[]} */ (recentChars.map((t) => resolveChar(t)).filter((e) => e && canDraw(e.text)))
        : [];
      if (recentEntries.length) cells.push(h("h3", null, "Recently used"), ...recentEntries.map(cell));
      if (!q && f !== "recent") {
        // Listed under their category headings.
        let last = "";
        for (const e of shown) {
          if (e.category !== last) { cells.push(h("h3", null, labelOf.get(e.category) ?? "")); last = e.category; }
          cells.push(cell(e));
        }
      } else cells.push(...shown.map(cell));
      body.replaceChildren(shown.length || recentEntries.length
        ? rovingGrid(h("div", { class: "char-grid", role: "group", "aria-label": q ? "Search results" : "Emoji and symbols" }, cells), ".char-pick", true)
        : h("p", { class: "muted", style: { margin: "12px 14px" } },
          f === "recent" && !recentChars.length ? "Emoji and symbols you insert appear here." : "Nothing matches. Try another word, such as smile, arrow or tick."));
      countEl.textContent = `${shown.length} ${shown.length === 1 ? "result" : "results"}`;
      note.hidden = !hidden;
      note.textContent = hidden ? `${hidden} ${hidden === 1 ? "emoji your device cannot draw is" : "emoji your device cannot draw are"} not shown.` : "";
      refocus(body, focusKey);
    }
    tone.addEventListener("change", () => {
      sessionTone = Number(tone.value) || 0;
      sessionSet(TONE_KEY, String(sessionTone));
      render();
      app.announce(SKIN_TONES[sessionTone].label);
    });
    /** @type {View} */
    const view = {
      el, search, render,
      announce: () => announceLater(shown.length ? `${shown.length} ${shown.length === 1 ? "result" : "results"}` : "Nothing matches"),
      insertBest: () => {
        const e = shown[0];
        if (e) insertText(e.kind === "emoji" ? applySkinTone(e, sessionTone) : e.text, e);
      },
    };
    wireSearch(view, body, filter);
    return view;
  }

  /** @param {View} view @param {HTMLElement} body @param {HTMLSelectElement} filter */
  function wireSearch(view, body, filter) {
    view.search.addEventListener("input", () => { view.render(); view.announce(); });
    view.search.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const first = /** @type {HTMLElement|null} */ (body.querySelector("[role='group'] [tabindex='0']") ?? body.querySelector(".icon-pick, .char-pick"));
        first?.focus();
      } else if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        view.insertBest();
      }
    });
    filter.addEventListener("change", () => { view.render(); view.announce(); });
  }

  return {
    open, close,
    toggle: () => (panel ? close() : open()),
    get isOpen() { return !!panel; },
    get tab() { return tab; },
  };
}
