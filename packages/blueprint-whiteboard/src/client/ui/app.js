// @ts-check
// The app shell: a full-viewport canvas with floating chrome (title and connection, tools, style
// bar, people and follow, zoom and minimap, objects and activity panels, toasts, live region).
// It routes each store Change and canvas event to the narrowest re-render. The canvas
// (./canvas/**) owns the <svg> and every gesture on it; see ./ui-contract.js.

import { LIMITS, DEFAULT_TITLE } from "../../shared/protocol.js";
import { createCanvas, CANVAS_CSS } from "./canvas/index.js";
import { h, inlineEditable } from "./dom.js";
import { SHELL_CSS } from "./styles.js";
import { createToolbar } from "./toolbar.js";
import { createStyleBar } from "./stylebar.js";
import { createPeople } from "./people.js";
import { createMinimap } from "./minimap.js";
import { createOutline } from "./outline.js";
import { createActivity } from "./activity.js";
import { createIconPicker } from "./icon-picker.js";
import { showToast, ensureToastHost, closeMenu } from "./dialogs.js";
import { ConnectionAnnouncer, statusText } from "../sync/connection.js";
import { keyAction } from "./canvas/keymap.js";
import { mountShare, SHARE_CSS } from "./share.js";

/** @typedef {import("../store-contract.js").Store} Store */
/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").Change} Change */
/** @typedef {import("./ui-contract.js").CanvasController} CanvasController */

/**
 * Shared shell context passed to every chrome component.
 * @typedef {object} App
 * @property {Store} store             wrapped: calls through it are marked as this viewer's own
 * @property {CanvasController} canvas
 * @property {HTMLElement} root        the .wb-app element
 * @property {boolean} outlineOpen
 * @property {boolean} activityOpen
 * @property {(message: string) => void} announce  polite screen-reader announcement
 * @property {() => void} toggleOutline
 * @property {() => void} toggleActivity
 * @property {() => void} refreshChrome
 * @property {() => void} focusStyleBar
 * @property {(visible: boolean) => void} [onStyleBarToggle]
 * @property {(type: import("../../shared/protocol.js").ObjectType) => Partial<import("../../shared/protocol.js").Style>} toolStyle
 *   colours new objects of `type` get: the last fill / line / text colour chosen for that type
 * @property {(types: Set<string>, colours: Partial<import("../../shared/protocol.js").Style>) => void} rememberStyle
 * @property {(objs: import("../../shared/protocol.js").WhiteboardObject[]) => {label: string, onSelect: () => void, danger?: boolean, className?: string}[]} [contextItems]
 *   extra context-menu items (copy, cut, paste, links, present) from ./share.js
 * @property {boolean} [iconPickerOpen]
 * @property {() => void} [toggleIconPicker]  opens or closes the icon and shape picker (I)
 * @property {() => void} [openEmojiPicker]   opens the picker on its Emoji & symbols tab (Ctrl/⌘+.)
 */

/** Gap between announcements of other people's changes. */
const REMOTE_ANNOUNCE_MS = 2000;
/** A history entry by this viewer's name within this long of a local change is treated as ours. */
const OWN_HISTORY_WINDOW_MS = 15000;

export function injectStyles() {
  if (document.getElementById("wb-styles")) return;
  document.head.appendChild(h("style", { id: "wb-styles" }, SHELL_CSS + "\n" + (CANVAS_CSS ?? "") + "\n" + SHARE_CSS));
}

/**
 * The polite live region, created once.
 * @returns {(message: string) => void}
 */
function createAnnouncer() {
  let live = /** @type {HTMLElement|null} */ (document.body.querySelector(".live-region"));
  if (!live) {
    live = h("div", { class: "sr-only live-region", "aria-live": "polite", "aria-atomic": "true" });
    document.body.appendChild(live);
  }
  const liveEl = live;
  /** @type {any} */
  let timer = null;
  return (message) => {
    if (!message) return;
    clearTimeout(timer);
    liveEl.textContent = "";
    // A short gap so repeating the same text is still announced.
    timer = setTimeout(() => { liveEl.textContent = message; }, 60);
  };
}

/** @param {string} s */
function lowerFirst(s) {
  return s && /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

/**
 * @param {HTMLElement} root
 * @param {Store} store
 */
export function mountApp(root, store) {
  injectStyles();
  ensureToastHost();
  const announce = createAnnouncer();

  // Calls made through the UI are this viewer's own; remote-change announcements skip them.
  let lastLocalAt = 0;
  /**
   * @template {(...args: any[]) => any} F
   * @param {F} fn
   * @returns {F}
   */
  const local = (fn) => /** @type {F} */ ((...args) => { lastLocalAt = Date.now(); return fn(...args); });
  /** @type {Store} */
  const uiStore = {
    ...store,
    createObjects: local(store.createObjects),
    updateObjects: local(store.updateObjects),
    deleteObjects: local(store.deleteObjects),
    reorder: local(store.reorder),
    setStructure: local(store.setStructure),
    undo: local(store.undo),
    redo: local(store.redo),
    undoHistory: local(store.undoHistory),
  };

  const appEl = h("div", { class: "wb-app" });
  const canvasHost = h("div", { class: "wb-canvas-host" });
  /** Last colours chosen in the style bar, per object type; new objects of that type use them. @type {Map<string, Record<string, any>>} */
  const lastColours = new Map();
  /** @type {App["toolStyle"]} */
  const toolStyle = (type) => ({ ...(lastColours.get(type) ?? {}) });
  const canvas = createCanvas(uiStore, { announce, toolStyle });
  canvasHost.appendChild(canvas.element);
  // Debug and test handle, like window.whiteboardStore.
  /** @type {any} */ (globalThis).whiteboardCanvas = canvas;

  /** @type {App} */
  const app = {
    store: uiStore,
    canvas,
    root: appEl,
    outlineOpen: false,
    activityOpen: false,
    announce,
    toggleOutline: () => outline.toggle(),
    toggleActivity: () => activity.toggle(),
    refreshChrome: () => toolbar.render(),
    focusStyleBar: () => styleBar.focusFirst(),
    toolStyle,
    rememberStyle(types, colours) {
      for (const type of types) {
        /** @type {Record<string, any>} */
        const next = { ...(lastColours.get(type) ?? {}), ...colours };
        // Sticky notes and pen strokes need a real colour; "none" is not remembered for them.
        for (const [k, v] of Object.entries(next)) {
          if (v === "none" && (type === "sticky" || type === "pen" || type === "connector")) delete next[k];
        }
        lastColours.set(type, next);
      }
    },
  };

  // ---- top left: title, connection and save status
  const title = inlineEditable({
    className: "board-title",
    label: "Whiteboard title",
    maxLength: LIMITS.boardTitle,
    getValue: () => uiStore.getState().board.title || DEFAULT_TITLE,
    onSave: (value) => uiStore.setStructure({ title: value }),
  });
  // Not a live region: it changes on every save. Meaningful transitions are announced instead.
  const conn = h("span", { class: "conn", dataset: { state: "connecting" } },
    h("span", { class: "conn-dot", "aria-hidden": "true" }), h("span", { class: "conn-text", "aria-hidden": "true" }, "Connecting…"),
    h("span", { class: "conn-detail sr-only" }, "Connecting to the whiteboard."));
  const connAnnouncer = new ConnectionAnnouncer(announce);
  const topbar = h("div", { class: "wb-float wb-topbar" }, h("h1", { style: { margin: "0", font: "inherit", display: "flex", minWidth: "0" } }, title.el), conn);

  const toolbar = createToolbar(app);
  const styleBar = createStyleBar(app);
  app.onStyleBarToggle = (visible) => appEl.classList.toggle("has-selection", visible);
  const people = createPeople(app);
  const minimap = createMinimap(app);
  const outline = createOutline(app);
  const activity = createActivity(app);
  const iconPicker = createIconPicker(app);
  app.toggleIconPicker = () => iconPicker.toggle();
  app.openEmojiPicker = () => iconPicker.open("unicode");

  // The style bar follows the canvas in DOM (and Tab) order: selecting on the canvas, then Tab,
  // reaches the selection's actions first.
  appEl.append(canvasHost, styleBar.el, topbar, toolbar.el, toolbar.history, people.el, people.chip, minimap.el, minimap.zoom);
  root.replaceChildren(appEl);

  // Clipboard, backup, templates, help, onboarding, deep links, presentation (./share.js).
  const share = mountShare(app, { topbar });
  app.contextItems = share.contextItems;
  /** @param {string} command a keymap.js ShellCommand */
  const runCommand = (command) => {
    if (command === "addMenu") toolbar.openAddMenu();
    else if (command === "outline") outline.toggle();
    else if (command === "icons") iconPicker.toggle();
    else if (command === "code") canvas.addAtCenter("code");
    else if (command === "emoji") iconPicker.open("unicode");
    else share.command(command);
  };

  // ---- canvas events
  canvas.on((event) => {
    switch (event.kind) {
      case "tool":
        toolbar.render(/** @type {any} */ (event));
        break;
      case "camera":
        minimap.invalidate();
        minimap.renderZoom();
        break;
      case "selection":
        styleBar.render();
        outline.render(uiStore.getState());
        break;
      case "editing":
        styleBar.render();
        break;
      case "follow":
        people.render(uiStore.getState());
        break;
      case "command":
        runCommand(/** @type {any} */ (event).command);
        break;
    }
  });
  // Long-press on touch (and right-click) opens the selection's actions as a menu.
  canvas.element.addEventListener("wb-contextmenu", (e) => {
    const d = /** @type {CustomEvent} */ (e).detail ?? {};
    const x = d.clientX ?? d.x ?? window.innerWidth / 2;
    const y = d.clientY ?? d.y ?? window.innerHeight / 2;
    styleBar.openContextMenu({ x, y, pointerType: d.pointerType, rect: d.rect ?? null });
  });

  // ---- global shortcuts that are the shell's (the canvas handles its own when focused)
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const t = /** @type {HTMLElement|null} */ (e.target);
    if (t && (t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") || t.closest(".modal-scrim"))) return;
    // The shell's commands come from the same table as the canvas's keys (keymap.js).
    const action = keyAction(e);
    if (action?.type !== "command" || t?.closest(".menu")) return;
    e.preventDefault();
    runCommand(action.command);
  });

  // ---- store changes
  let lastErrorShown = /** @type {string|null} */ (null);
  const seenHistory = new Set(store.getState().history.map((e) => e.id));
  const mountedAt = Date.now();
  /** @type {{by: string, summary: string}[]} */
  let remoteQueue = [];
  /** @type {any} */
  let remoteTimer = null;
  let lastRemoteAnnounce = 0;
  let lastFlashAnnounce = 0;

  function flushRemote() {
    remoteTimer = null;
    if (!remoteQueue.length) return;
    const last = remoteQueue[remoteQueue.length - 1];
    const extra = remoteQueue.length - 1;
    remoteQueue = [];
    lastRemoteAnnounce = Date.now();
    announce(`${last.by || "Someone"} ${lowerFirst(last.summary)}${extra ? `, and ${extra} more ${extra === 1 ? "change" : "changes"}` : ""}`);
  }

  /** @param {ClientState} state */
  function noteHistory(state) {
    const viewerName = state.viewer.name;
    for (const entry of state.history) {
      if (seenHistory.has(entry.id)) continue;
      seenHistory.add(entry.id);
      const own = entry.by === (viewerName || "Guest") && Date.now() - lastLocalAt < OWN_HISTORY_WINDOW_MS;
      // Old entries arrive when the Activity panel loads history; they are not news.
      if (own || !entry.summary || entry.at < mountedAt - 5000) continue;
      remoteQueue.push({ by: entry.by, summary: entry.summary });
    }
    if (remoteQueue.length && !remoteTimer) {
      remoteTimer = setTimeout(flushRemote, Math.max(250, REMOTE_ANNOUNCE_MS - (Date.now() - lastRemoteAnnounce)));
    }
  }

  /** @param {ClientState} state */
  function renderHeader(state) {
    title.refresh();
    const status = statusText(state);
    conn.dataset.state = state.connection;
    conn.dataset.count = String(state.pendingCount);
    conn.classList.toggle("conn-warn", status.warn);
    const text = /** @type {HTMLElement} */ (conn.querySelector(".conn-text"));
    if (text.textContent !== status.label) text.textContent = status.label;
    const detail = /** @type {HTMLElement} */ (conn.querySelector(".conn-detail"));
    if (detail.textContent !== status.detail) detail.textContent = status.detail;
    if (conn.title !== status.detail) conn.title = status.detail;
    connAnnouncer.update(state);
    const t = state.board.title || DEFAULT_TITLE;
    if (document.title !== t) document.title = t;
  }

  /**
   * @param {ClientState} state
   * @param {Change} change
   */
  function onChange(state, change) {
    switch (change.kind) {
      case "snapshot":
        renderHeader(state);
        styleBar.render();
        outline.render(state);
        activity.render(state);
        people.render(state);
        minimap.invalidateObjects();
        toolbar.render();
        break;
      case "objects": {
        const sel = new Set(canvas.getSelection());
        if (change.objects?.some((id) => sel.has(id)) ?? true) styleBar.render();
        outline.render(state);
        minimap.invalidateObjects();
        renderHeader(state);
        toolbar.render();
        break;
      }
      case "structure":
        renderHeader(state);
        break;
      case "presence":
        people.render(state);
        minimap.invalidate();
        break;
      case "connection":
      case "viewer":
        renderHeader(state);
        people.render(state);
        break;
      case "history":
        activity.render(state);
        noteHistory(state);
        break;
      case "undo":
        toolbar.render();
        renderHeader(state);
        break;
      case "flash":
        if (Date.now() - lastFlashAnnounce > REMOTE_ANNOUNCE_MS) {
          lastFlashAnnounce = Date.now();
          announce("Someone else changed or deleted that object at the same time; their version was kept.");
        }
        break;
      case "error":
        break;
      default:
        renderHeader(state);
        toolbar.render();
    }
    if (state.lastError && state.lastError !== lastErrorShown) {
      showToast(state.lastError);
      lastErrorShown = state.lastError;
    }
    if (!state.lastError) lastErrorShown = null;
    share.onChange(state, change);
  }

  const initial = uiStore.getState();
  renderHeader(initial);
  toolbar.render();
  people.render(initial);
  minimap.renderZoom();
  minimap.invalidate();
  share.render();
  const unsubscribe = uiStore.subscribe(onChange);

  // Leave presence promptly when the iframe goes away.
  window.addEventListener("pagehide", () => { closeMenu(); store.dispose(); });

  return { app, unsubscribe };
}
