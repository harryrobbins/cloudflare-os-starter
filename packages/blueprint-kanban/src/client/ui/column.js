// @ts-check
// One column: header (rename, count, collapse, menu), card list, and the add-card composer.
// The column element persists across renders; only changed parts of it are touched.

import { cardsInColumn, LIMITS } from "../../shared/protocol.js";
import { h, icon, inlineEditable } from "./dom.js";
import { createCardEl, updateCardEl } from "./card.js";
import { confirmDialog, openMenu } from "./dialogs.js";
import { matches, isActive } from "./filters.js";

/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("./app.js").App} App */

/**
 * @param {App} app
 * @param {string} columnId
 */
export function createColumnView(app, columnId) {
  const { store } = app;
  const column = () => store.getState().board.columns[columnId];

  const name = inlineEditable({
    className: "column-name",
    label: "Column name",
    maxLength: LIMITS.columnName,
    getValue: () => column()?.name ?? "",
    onSave: (value) => store.renameColumn(columnId, value),
  });
  const count = h("span", { class: "count", "aria-label": "Cards" }, "0");
  const collapseBtn = h("button", {
    type: "button", class: "btn icon-only collapse-btn", "aria-label": "Collapse column", title: "Collapse column",
    onclick: () => store.setColumnCollapsed(columnId, !column()?.collapsed),
  }, icon("collapse"));
  const menuBtn = h("button", {
    type: "button", class: "btn icon-only col-menu-btn", "aria-label": "Column actions", "aria-haspopup": "menu", title: "Column actions",
  }, icon("more"));
  menuBtn.addEventListener("click", () => {
    openMenu(menuBtn, [
      { label: "Add card", onSelect: () => openComposer() },
      { label: column()?.collapsed ? "Expand column" : "Collapse column", onSelect: () => store.setColumnCollapsed(columnId, !column()?.collapsed) },
      { label: "Rename column", onSelect: () => name.start() },
      {
        label: "Delete column…", danger: true, onSelect: async () => {
          const col = column();
          if (!col) return;
          const n = cardsInColumn(store.getState().board.cards, columnId).length;
          const ok = await confirmDialog({
            title: `Delete "${col.name}"?`,
            message: n ? `This deletes the column and its ${n} card${n === 1 ? "" : "s"} for everyone.` : "This deletes the column for everyone.",
            confirmLabel: "Delete column", danger: true,
          });
          if (ok) store.deleteColumn(columnId);
        },
      },
    ]);
  });

  const head = h("div", { class: "column-head", dataset: { columnHead: columnId } },
    name.el, count, collapseBtn, menuBtn);
  const list = h("div", { class: "cards", role: "list", dataset: { columnList: columnId } });

  // Composer
  const addBtn = h("button", { type: "button", class: "btn add-card-btn", onclick: () => openComposer() },
    icon("plus"), "Add card");
  const foot = h("div", { class: "column-foot" }, addBtn);
  /** @type {HTMLTextAreaElement|null} */
  let composerInput = null;

  function openComposer() {
    if (column()?.collapsed) store.setColumnCollapsed(columnId, false);
    if (composerInput) { composerInput.focus(); return; }
    const input = /** @type {HTMLTextAreaElement} */ (h("textarea", {
      class: "composer-input", placeholder: "Card title — Enter to add, Esc to close", "aria-label": "New card title",
      maxlength: LIMITS.cardTitle, rows: 2,
    }));
    composerInput = input;
    const submit = () => {
      const title = input.value.replace(/\s+/g, " ").trim();
      if (!title) { input.focus(); return; }
      store.createCard(columnId, { title });
      input.value = "";
      input.focus();
      requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    };
    const close = () => {
      composerInput = null;
      form.replaceWith(addBtn);
      addBtn.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    const form = h("form", { class: "composer" }, input,
      h("div", { class: "composer-actions" },
        h("button", { type: "submit", class: "btn primary small" }, "Add card"),
        h("button", { type: "button", class: "btn icon-only", "aria-label": "Cancel", onclick: close }, icon("close")),
      ),
    );
    form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
    addBtn.replaceWith(form);
    input.focus();
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  const el = h("section", { class: "column", dataset: { columnId }, "aria-label": "Column" }, head, list, foot);

  /** @param {ClientState} state */
  function render(state) {
    const col = state.board.columns[columnId];
    if (!col) return;
    el.classList.toggle("collapsed", !!col.collapsed);
    el.setAttribute("aria-label", "Column " + col.name);
    collapseBtn.replaceChildren(icon(col.collapsed ? "expand" : "collapse"));
    collapseBtn.setAttribute("aria-label", col.collapsed ? "Expand column" : "Collapse column");
    collapseBtn.title = col.collapsed ? "Expand column" : "Collapse column";
    name.refresh();

    const cards = cardsInColumn(state.board.cards, columnId);
    const filtering = isActive(app.filters);
    let shown = 0;
    /** @type {HTMLElement[]} */
    const desired = [];
    for (const card of cards) {
      let cardEl = app.cardEls.get(card.id);
      if (!cardEl) {
        cardEl = createCardEl(card, state.board.labels, app.openCard);
        app.cardEls.set(card.id, cardEl);
      } else {
        updateCardEl(cardEl, card, state.board.labels);
      }
      const ok = !filtering || matches(app.filters, card);
      if (ok) shown++;
      cardEl.classList.toggle("dim", !ok);
      desired.push(cardEl);
    }
    // Remove card elements that no longer belong here (moved or deleted).
    const desiredSet = new Set(desired);
    for (const child of /** @type {HTMLElement[]} */ ([...list.children])) {
      if (child.classList.contains("card") && !desiredSet.has(child)) child.remove();
    }
    // Order with minimal DOM moves so a focused card that stays put keeps focus.
    let current = /** @type {HTMLElement[]} */ ([...list.children]).filter((c) => c.classList.contains("card"));
    for (let i = 0; i < desired.length; i++) {
      if (current[i] === desired[i]) continue;
      list.insertBefore(desired[i], current[i] ?? null);
      const at = current.indexOf(desired[i]);
      if (at !== -1) current.splice(at, 1);
      current.splice(i, 0, desired[i]);
    }
    count.textContent = filtering ? `${shown}/${cards.length}` : String(cards.length);
    count.setAttribute("aria-label", filtering ? `${shown} of ${cards.length} cards match` : `${cards.length} cards`);
  }

  return { el, head, list, render, openComposer, name };
}
