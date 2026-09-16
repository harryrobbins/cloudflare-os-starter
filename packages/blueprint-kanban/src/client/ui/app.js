// @ts-check
// Wires the store to the views and routes each Change to the narrowest re-render.

import { h } from "./dom.js";
import { CSS } from "./styles.js";
import { createHeader } from "./toolbar.js";
import { createBoardView } from "./board.js";
import { createPanel } from "./panel.js";
import { createActivity } from "./activity.js";
import { installDnd } from "./dnd.js";
import { applyPresence } from "./presence.js";
import { emptyFilters } from "./filters.js";
import { showToast } from "./dialogs.js";

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
  /** @type {App} */
  const app = {
    store,
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
  };

  const header = createHeader(app);
  app.header = header;
  const boardView = createBoardView(app);
  app.boardView = boardView;
  const panel = createPanel(app);
  app.panel = panel;
  const activity = createActivity(app);

  root.replaceChildren(h("div", { class: "app" }, header.header, header.toolbar, boardView.el));
  installDnd(app);

  /** @type {string|null} */
  let lastErrorShown = null;

  /**
   * @param {ClientState} state
   * @param {Change} change
   */
  function onChange(state, change) {
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
    if (boardTouched) applyPresence(app, state);
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
