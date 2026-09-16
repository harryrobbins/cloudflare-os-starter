// @ts-check
// Wires the store to the views and routes each Change to the narrowest re-render.

import { h, isVisible } from "./dom.js";
import { CSS } from "./styles.js";
import { createHeader } from "./toolbar.js";
import { createBoardView } from "./board.js";
import { createPanel } from "./panel.js";
import { createActivity } from "./activity.js";
import { installDnd } from "./dnd.js";
import { applyPresence } from "./presence.js";
import { emptyFilters } from "./filters.js";
import { showToast, ensureToastHost } from "./dialogs.js";
import { CARD_HELP_ID } from "./card.js";

/** @typedef {import("../store-contract.js").Store} Store */
/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").Change} Change */

/**
 * Shared UI context passed to every view.
 * @typedef {object} App
 * @property {Store} store
 * @property {import("./filters.js").Filters} filters
 * @property {Map<string, HTMLElement>} cardEls
 * @property {string|null} activeColumnId   phone layout: the column shown
 * @property {boolean} activityOpen
 * @property {boolean} dragging
 * @property {HTMLElement|null} avatarsEl
 * @property {ReturnType<typeof createBoardView>|null} boardView
 * @property {ReturnType<typeof createPanel>|null} panel
 * @property {ReturnType<typeof createHeader>|null} header
 * @property {(cardId: string) => void} openCard
 * @property {() => void} refilter
 * @property {() => void} toggleActivity
 * @property {() => void} refreshPresence
 * @property {(message: string) => void} announce  polite screen-reader announcement
 */

export function injectStyles() {
  if (document.getElementById("kanban-styles")) return;
  document.head.appendChild(h("style", { id: "kanban-styles" }, CSS));
}

/**
 * @param {HTMLElement} root
 * @param {Store} store
 */
export function mountApp(root, store) {
  injectStyles();
  ensureToastHost();

  // One polite live region for the whole app.
  let live = /** @type {HTMLElement|null} */ (document.body.querySelector(".live-region"));
  if (!live) {
    live = h("div", { class: "sr-only live-region", "aria-live": "polite", "aria-atomic": "true" });
    document.body.appendChild(live);
  }
  const liveEl = live;
  /** @type {any} */
  let liveTimer = null;
  /** @param {string} message */
  function announce(message) {
    if (!message) return;
    clearTimeout(liveTimer);
    liveEl.textContent = "";
    // A short gap so repeating the same text is still announced.
    liveTimer = setTimeout(() => { liveEl.textContent = message; }, 60);
  }

  // Operations this viewer starts from the UI are wrapped so remote-change announcements and
  // focus handling can tell them apart from someone else's.
  let localDepth = 0;
  /**
   * @template {(...args: any[]) => any} F
   * @param {F} fn
   * @returns {F}
   */
  const local = (fn) => /** @type {F} */ ((...args) => {
    localDepth++;
    try { return fn(...args); } finally { localDepth--; }
  });
  /** @type {Store} */
  const uiStore = {
    ...store,
    moveCard: local(store.moveCard),
    deleteCard: local(store.deleteCard),
    moveColumn: local(store.moveColumn),
    deleteColumn: local(store.deleteColumn),
    resolveConflict: local(store.resolveConflict),
  };

  /** @type {App} */
  const app = {
    store: uiStore,
    filters: emptyFilters(),
    cardEls: new Map(),
    activeColumnId: null,
    activityOpen: false,
    dragging: false,
    avatarsEl: null,
    boardView: null,
    panel: null,
    header: null,
    openCard: (cardId) => app.panel?.open(cardId),
    refilter: () => {
      const state = store.getState();
      app.boardView?.renderAll(state);
      app.header?.renderOptions(state);
    },
    toggleActivity: () => activity.toggle(),
    refreshPresence: () => applyPresence(app, store.getState()),
    announce,
  };

  const header = createHeader(app);
  app.header = header;
  const boardView = createBoardView(app);
  app.boardView = boardView;
  const panel = createPanel(app);
  app.panel = panel;
  const activity = createActivity(app);

  const cardHelp = h("div", { id: CARD_HELP_ID, hidden: true },
    "Enter opens the card. Alt plus Up or Down arrow moves it within the column; Alt plus Left or Right arrow moves it to the next column.");
  const appEl = h("div", { class: "app" }, header.header, header.toolbar, boardView.el, cardHelp);
  root.replaceChildren(appEl);
  installDnd(app);

  /** @type {string|null} */
  let lastErrorShown = null;
  let prevBoard = store.getState().board;
  /** @type {Set<string>} */
  let knownConflicts = new Set();
  /** @type {{cardId: string, fallback: string, title: string, verb: string, text?: string}|null} */
  let pendingAnnouncement = null;

  /**
   * What had focus inside the board before a render.
   * @returns {{el: HTMLElement, cardId: string|null, columnId: string|null}|null}
   */
  function captureFocus() {
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    if (!active || active === document.body || !appEl.contains(active)) return null;
    const cardId = active.classList.contains("card") ? active.dataset.cardId ?? null : null;
    const columnId = cardId
      ? prevBoard.cards[cardId]?.columnId ?? active.closest(".column")?.getAttribute("data-column-id") ?? null
      : null;
    return { el: active, cardId, columnId };
  }

  /**
   * Puts focus back if a render dropped it (a moved or deleted element), without stealing it
   * from anything that legitimately took it.
   * @param {ReturnType<typeof captureFocus>} before
   * @param {ClientState} state
   */
  function restoreFocus(before, state) {
    if (!before) return;
    const now = document.activeElement;
    if (now === before.el || (now && now !== document.body)) return;
    if (before.cardId) {
      const el = app.cardEls.get(before.cardId);
      if (el && state.board.cards[before.cardId] && isVisible(el)) { el.focus({ preventScroll: true }); return; }
      const views = [before.columnId, app.activeColumnId].map((id) => (id ? boardView.views.get(id) : null));
      const candidates = [
        ...views.map((v) => /** @type {HTMLElement|null} */ (v?.el.querySelector(".column-foot button, .column-foot textarea") ?? null)),
        boardView.addColumnBtn,
      ];
      candidates.find((c) => c && isVisible(c))?.focus({ preventScroll: true });
      return;
    }
    if (isVisible(before.el)) before.el.focus({ preventScroll: true });
  }

  /**
   * Notes someone else moving or deleting the focused card or the card open in the panel.
   * @param {ClientState} state
   * @param {string|null} focusedCardId
   */
  function noteRemoteCardChanges(state, focusedCardId) {
    const ids = new Set([focusedCardId, panel.cardId].filter(Boolean));
    for (const id of /** @type {Set<string>} */ (ids)) {
      const before = prevBoard.cards[id];
      if (!before) continue;
      const after = state.board.cards[id];
      const title = `"${before.title || "Untitled"}"`;
      if (!after) {
        pendingAnnouncement = { cardId: id, title, verb: "deleted", fallback: `${title} was deleted` };
      } else if (after.columnId !== before.columnId) {
        const name = state.board.columns[after.columnId]?.name ?? "another column";
        pendingAnnouncement = { cardId: id, title, verb: "moved", fallback: `${title} was moved to ${name}` };
      } else if (after.order !== before.order && id === focusedCardId) {
        pendingAnnouncement = { cardId: id, title, verb: "moved", fallback: `${title} was moved within ${state.board.columns[after.columnId]?.name ?? "its column"}` };
      } else {
        continue;
      }
      // The history entry for the same operation arrives in the same tick; flush after it.
      setTimeout(flushAnnouncement, 0);
      return;
    }
  }

  function flushAnnouncement() {
    if (!pendingAnnouncement) return;
    const { fallback, text } = pendingAnnouncement;
    pendingAnnouncement = null;
    announce(text || fallback);
  }

  /** @param {ClientState} state */
  function noteConflicts(state) {
    const next = new Set(state.conflicts.keys());
    for (const id of next) {
      if (knownConflicts.has(id)) continue;
      const conflict = state.conflicts.get(id);
      // A deletion is announced by noteRemoteCardChanges when the card leaves the board.
      if (!conflict || conflict.theirs === null) continue;
      const title = `"${state.board.cards[id]?.title || conflict.theirs.title || "a card"}"`;
      announce(`Someone else changed ${title} at the same time. Choose Keep mine or Use theirs.`);
    }
    knownConflicts = next;
  }

  /**
   * @param {ClientState} state
   * @param {Change} change
   */
  function onChange(state, change) {
    const focusBefore = captureFocus();
    const isLocal = localDepth > 0;
    let boardTouched = false;
    if (change.all || change.kind === "snapshot") {
      boardView.renderAll(state);
      boardTouched = true;
    } else {
      const columns = new Set(change.columns ?? []);
      for (const cardId of change.cards ?? []) {
        const card = state.board.cards[cardId];
        if (card) columns.add(card.columnId);
        const el = app.cardEls.get(cardId);
        const fromColumn = el?.closest(".column")?.getAttribute("data-column-id");
        if (fromColumn) columns.add(fromColumn);
      }
      if (columns.size) {
        boardView.renderColumns([...columns], state);
        boardTouched = true;
      }
    }

    switch (change.kind) {
      case "presence":
        applyPresence(app, state);
        break;
      case "connection":
      case "viewer":
        header.render(state);
        break;
      case "comment":
        panel.onChange(state, change);
        break;
      case "history":
        activity.render(state);
        break;
      case "error":
        if (state.lastError) {
          showToast(state.lastError);
          lastErrorShown = state.lastError;
        }
        break;
      default:
        header.render(state);
        panel.onChange(state, change);
        activity.render(state);
    }
    if (change.kind !== "error" && state.lastError && state.lastError !== lastErrorShown) {
      showToast(state.lastError);
      lastErrorShown = state.lastError;
    }
    if (!state.lastError) lastErrorShown = null;
    if (boardTouched) {
      applyPresence(app, state);
      restoreFocus(focusBefore, state);
    }
    if (!isLocal && (change.kind === "operation" || change.kind === "snapshot") && state.board !== prevBoard) {
      noteRemoteCardChanges(state, focusBefore?.cardId ?? null);
    }
    if (change.kind === "history" && pendingAnnouncement && state.history.length) {
      const entry = state.history[state.history.length - 1];
      if (entry?.summary) {
        pendingAnnouncement.text = `${entry.by || "Someone"}: ${entry.summary}`;
      }
    }
    if (change.kind === "conflict" || state.conflicts.size !== knownConflicts.size) noteConflicts(state);
    prevBoard = state.board;
  }

  const initial = store.getState();
  boardView.renderAll(initial);
  header.render(initial);
  applyPresence(app, initial);
  const unsubscribe = store.subscribe(onChange);

  // Leave presence promptly when the iframe goes away.
  window.addEventListener("pagehide", () => store.dispose());

  return { app, unsubscribe };
}
