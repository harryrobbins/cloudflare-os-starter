// @ts-check
// The board: columns in order, "+ Add column", and the phone-width tab strip.

import { cardsInColumn, LIMITS } from "../../shared/protocol.js";
import { h, icon } from "./dom.js";
import { createColumnView } from "./column.js";

/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("./app.js").App} App */

/** @param {App} app */
export function createBoardView(app) {
  const { store } = app;
  /** @type {Map<string, ReturnType<typeof createColumnView>>} */
  const views = new Map();

  const boardEl = h("div", { class: "board", "aria-label": "Board columns" });
  const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Columns" });

  // + Add column
  const addColumnBtn = h("button", { type: "button", class: "btn add-column-btn", onclick: () => openAddColumn() },
    icon("plus"), "Add column");
  const addColumn = h("div", { class: "add-column" }, addColumnBtn);
  boardEl.appendChild(addColumn);

  function openAddColumn() {
    const input = /** @type {HTMLInputElement} */ (h("input", {
      type: "text", placeholder: "Column name", "aria-label": "New column name", maxlength: LIMITS.columnName,
    }));
    const close = () => { form.replaceWith(addColumnBtn); addColumnBtn.focus(); };
    const add = () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      const id = store.createColumn(name);
      input.value = "";
      app.activeColumnId = id;
      renderAll(store.getState());
      input.focus();
      boardEl.scrollLeft = boardEl.scrollWidth;
    };
    const form = h("div", { class: "add-column-form" }, input,
      h("div", { class: "composer-actions" },
        h("button", { type: "button", class: "btn primary small add-column-submit", onclick: add }, "Add column"),
        h("button", { type: "button", class: "btn icon-only", "aria-label": "Cancel", onclick: close }, icon("close")),
      ),
    );
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); add(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    addColumnBtn.replaceWith(form);
    input.focus();
  }

  const el = h("div", { class: "board-wrap" }, tabs, boardEl);

  /** @param {ClientState} state */
  function ensureActive(state) {
    const order = state.board.columnOrder;
    if (!app.activeColumnId || !order.includes(app.activeColumnId)) app.activeColumnId = order[0] ?? null;
  }

  /** @param {ClientState} state */
  function renderTabs(state) {
    const order = state.board.columnOrder;
    const buttons = order.map((id) => {
      const col = state.board.columns[id];
      const selected = id === app.activeColumnId;
      return h("button", {
        type: "button", role: "tab", class: "tab", "aria-selected": String(selected), dataset: { tabColumnId: id },
        tabindex: selected ? "0" : "-1",
        onclick: () => setActive(id),
      }, col?.name ?? "", h("span", { class: "count" }, String(cardsInColumn(state.board.cards, id).length)));
    });
    buttons.push(h("button", {
      type: "button", role: "tab", class: "tab", "aria-selected": String(app.activeColumnId === "__add"),
      onclick: () => { setActive("__add"); openAddColumn(); },
      "aria-label": "Add column",
    }, "+"));
    const focusedTab = document.activeElement instanceof HTMLElement && tabs.contains(document.activeElement)
      ? document.activeElement.dataset.tabColumnId : null;
    tabs.replaceChildren(...buttons);
    if (focusedTab) /** @type {HTMLElement|null} */ (tabs.querySelector(`[data-tab-column-id="${focusedTab}"]`))?.focus();
    updateTabOverflow();
  }

  function updateTabOverflow() {
    tabs.classList.toggle("overflow-end", tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 1);
  }
  tabs.addEventListener("scroll", updateTabOverflow, { passive: true });
  window.addEventListener("resize", updateTabOverflow);

  // Keyboard alternative to dragging: Alt+Arrow on a focused card.
  boardEl.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const target = /** @type {HTMLElement} */ (e.target);
    if (!target.classList?.contains("card") || !target.dataset.cardId) return;
    const moves = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const delta = /** @type {Record<string, number[]>} */ (moves)[e.key];
    if (!delta) return;
    e.preventDefault(); // Alt+Left/Right would otherwise navigate history
    e.stopPropagation();
    moveCardBy(target.dataset.cardId, delta[0], delta[1]);
  });

  /**
   * Moves a card one step: dy within its column, dx to the neighbouring column (keeping its index).
   * Focus stays on the card.
   * @param {string} cardId
   * @param {number} dx
   * @param {number} dy
   */
  function moveCardBy(cardId, dx, dy) {
    const state = store.getState();
    const card = state.board.cards[cardId];
    if (!card) return;
    const order = state.board.columnOrder;
    const siblings = cardsInColumn(state.board.cards, card.columnId);
    const index = siblings.findIndex((c) => c.id === cardId);
    const columnName = (/** @type {string} */ id) => state.board.columns[id]?.name ?? "";
    if (dy) {
      const to = index + dy;
      if (to < 0 || to >= siblings.length) {
        app.announce(dy < 0 ? "Already at the top" : "Already at the bottom");
        return;
      }
      const others = siblings.filter((c) => c.id !== cardId);
      store.moveCard(cardId, card.columnId, others[to]?.id ?? null);
      app.announce(`"${card.title}" moved to position ${to + 1} of ${siblings.length} in ${columnName(card.columnId)}`);
    } else {
      const toColumnId = order[order.indexOf(card.columnId) + dx];
      if (!toColumnId) {
        app.announce(dx < 0 ? "Already in the first column" : "Already in the last column");
        return;
      }
      if (state.board.columns[toColumnId]?.collapsed) store.setColumnCollapsed(toColumnId, false);
      const targets = cardsInColumn(store.getState().board.cards, toColumnId);
      const before = targets[Math.min(index, targets.length)]?.id ?? null;
      store.moveCard(cardId, toColumnId, before);
      if (app.activeColumnId !== "__add" && app.activeColumnId !== toColumnId) setActive(toColumnId);
      const position = Math.min(index, targets.length) + 1;
      app.announce(`"${card.title}" moved to ${columnName(toColumnId)}, position ${position} of ${targets.length + 1}`);
    }
    const el = app.cardEls.get(cardId);
    if (el && document.activeElement !== el) el.focus();
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  tabs.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const list = [...tabs.querySelectorAll(".tab")];
    const i = list.indexOf(/** @type {any} */ (document.activeElement));
    const next = /** @type {HTMLElement} */ (list[(i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length]);
    next?.click();
    next?.focus();
  });

  /** @param {string} id */
  function setActive(id) {
    app.activeColumnId = id;
    applyMobileVisibility();
    renderTabs(store.getState());
  }

  function applyMobileVisibility() {
    for (const [id, view] of views) view.el.classList.toggle("mobile-hidden", id !== app.activeColumnId);
    addColumn.classList.toggle("mobile-hidden", app.activeColumnId !== "__add");
  }

  /** @param {ClientState} state */
  function renderAll(state) {
    const order = state.board.columnOrder.filter((id) => state.board.columns[id]);
    if (app.activeColumnId !== "__add") ensureActive(state);
    for (const [id, view] of views) {
      if (!state.board.columns[id]) { view.el.remove(); views.delete(id); }
    }
    /** @type {HTMLElement[]} */
    const desired = [];
    for (const id of order) {
      let view = views.get(id);
      if (!view) { view = createColumnView(app, id); views.set(id, view); }
      view.render(state);
      desired.push(view.el);
    }
    let current = /** @type {HTMLElement[]} */ ([...boardEl.children]).filter((c) => c.classList.contains("column") && !c.classList.contains("drag-ghost"));
    for (let i = 0; i < desired.length; i++) {
      if (current[i] === desired[i]) continue;
      boardEl.insertBefore(desired[i], current[i] ?? addColumn);
      const at = current.indexOf(desired[i]);
      if (at !== -1) current.splice(at, 1);
      current.splice(i, 0, desired[i]);
    }
    if (addColumn.parentNode !== boardEl || boardEl.lastElementChild !== addColumn) boardEl.appendChild(addColumn);
    // Drop cards whose elements outlived them.
    for (const [cardId, cardEl] of app.cardEls) {
      if (!state.board.cards[cardId]) { cardEl.remove(); app.cardEls.delete(cardId); }
    }
    applyMobileVisibility();
    renderTabs(state);
  }

  /**
   * @param {string[]} columnIds
   * @param {ClientState} state
   */
  function renderColumns(columnIds, state) {
    for (const id of columnIds) {
      if (!state.board.columns[id] && !views.has(id)) continue;
      if (!views.has(id) || !state.board.columns[id]) { renderAll(state); return; }
    }
    for (const id of new Set(columnIds)) views.get(id)?.render(state);
    for (const [cardId, cardEl] of app.cardEls) {
      if (!state.board.cards[cardId]) { cardEl.remove(); app.cardEls.delete(cardId); }
    }
    renderTabs(state);
  }

  return { el, boardEl, views, renderAll, renderColumns, setActive, tabs, moveCardBy, addColumnBtn };
}
