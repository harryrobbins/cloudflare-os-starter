// @ts-check
// Header (board title, presence avatars, connection, identity) and toolbar (filters, search,
// activity toggle).

import { LIMITS } from "../../shared/protocol.js";
import { h, icon, avatar, inlineEditable } from "./dom.js";
import { nameDialog } from "./dialogs.js";
import { UNASSIGNED } from "./filters.js";

/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("./app.js").App} App */

/** @param {App} app */
export function createHeader(app) {
  const { store } = app;

  const title = inlineEditable({
    className: "board-title",
    label: "Board title",
    maxLength: LIMITS.boardTitle,
    getValue: () => store.getState().board.title,
    onSave: (value) => store.setTitle(value),
  });

  const conn = h("span", { class: "conn", role: "status", "aria-live": "polite" },
    h("span", { class: "conn-dot" }), h("span", { class: "conn-text" }, "Connecting"));
  const avatars = h("div", { class: "avatars", "aria-label": "Nobody else is here" });
  app.avatarsEl = avatars;

  const meBtn = h("button", { type: "button", class: "btn me-btn", title: "Change your name or colour", "aria-label": "Change your name or colour" });
  meBtn.addEventListener("click", async () => {
    const viewer = store.getState().viewer;
    const result = await nameDialog({ name: viewer.name, color: viewer.color, title: "Your name", skippable: false });
    if (result) store.setViewer(result.name, result.color);
  });

  const header = h("header", { class: "header" },
    h("div", { class: "header-title" }, title.el),
    h("div", { class: "header-right" }, conn, avatars, meBtn),
  );

  // Toolbar
  const search = /** @type {HTMLInputElement} */ (h("input", {
    type: "search", placeholder: "Search titles", "aria-label": "Search card titles", class: "search-input",
  }));
  search.addEventListener("input", () => { app.filters.text = search.value; app.refilter(); });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) { e.stopPropagation(); search.value = ""; app.filters.text = ""; app.refilter(); }
  });
  const labelSelect = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Filter by label", class: "label-filter" }));
  labelSelect.addEventListener("change", () => { app.filters.label = labelSelect.value; app.refilter(); });
  const assigneeSelect = /** @type {HTMLSelectElement} */ (h("select", { "aria-label": "Filter by assignee", class: "assignee-filter" }));
  assigneeSelect.addEventListener("change", () => { app.filters.assignee = assigneeSelect.value; app.refilter(); });
  const clearBtn = h("button", {
    type: "button", class: "btn small clear-filters", hidden: true,
    onclick: () => {
      app.filters.label = ""; app.filters.assignee = ""; app.filters.text = "";
      search.value = ""; labelSelect.value = ""; assigneeSelect.value = "";
      app.refilter();
    },
  }, "Clear filters");
  const activityBtn = h("button", {
    type: "button", class: "btn outline activity-toggle", "aria-pressed": "false",
    onclick: () => app.toggleActivity(),
  }, icon("activity"), "Activity");

  const toolbar = h("div", { class: "toolbar", role: "toolbar", "aria-label": "Filters" },
    h("label", { class: "search" }, icon("search", 14), search),
    labelSelect, assigneeSelect, clearBtn,
    h("span", { class: "spacer" }),
    activityBtn,
  );

  /** @param {ClientState} state */
  function renderOptions(state) {
    const labels = Object.values(state.board.labels).sort((a, b) => a.name.localeCompare(b.name));
    const labelKey = labels.map((l) => l.id + l.name).join("|");
    if (labelSelect.dataset.key !== labelKey) {
      labelSelect.dataset.key = labelKey;
      labelSelect.replaceChildren(
        h("option", { value: "" }, "All labels"),
        ...labels.map((l) => h("option", { value: l.id }, l.name)),
      );
      if (app.filters.label && !state.board.labels[app.filters.label]) { app.filters.label = ""; }
      labelSelect.value = app.filters.label;
    }
    const names = new Map();
    for (const card of Object.values(state.board.cards)) {
      if (card.assignee) names.set(card.assignee.toLowerCase(), card.assignee);
    }
    if (app.filters.assignee && app.filters.assignee !== UNASSIGNED) names.set(app.filters.assignee.toLowerCase(), app.filters.assignee);
    const sorted = [...names.values()].sort((a, b) => a.localeCompare(b));
    const assigneeKey = sorted.join("|");
    if (assigneeSelect.dataset.key !== assigneeKey) {
      assigneeSelect.dataset.key = assigneeKey;
      assigneeSelect.replaceChildren(
        h("option", { value: "" }, "All assignees"),
        h("option", { value: UNASSIGNED }, "Unassigned"),
        ...sorted.map((n) => h("option", { value: n }, n)),
      );
      assigneeSelect.value = app.filters.assignee;
    }
    clearBtn.hidden = !(app.filters.label || app.filters.assignee || app.filters.text);
  }

  /** @param {ClientState} state */
  function render(state) {
    title.refresh();
    const s = state.connection;
    if (conn.dataset.state !== s) {
      conn.dataset.state = s;
      /** @type {HTMLElement} */ (conn.querySelector(".conn-text")).textContent =
        s === "live" ? "Live" : s === "reconnecting" ? "Reconnecting…" : "Connecting…";
    }
    const v = state.viewer;
    const meKey = v.name + v.color;
    if (meBtn.dataset.key !== meKey) {
      meBtn.dataset.key = meKey;
      meBtn.replaceChildren(avatar(v.name || "Guest", v.color, "me"), h("span", { class: "me-name" }, v.name || "Guest"));
    }
    renderOptions(state);
    activityBtn.setAttribute("aria-pressed", String(app.activityOpen));
    if (document.title !== state.board.title) document.title = state.board.title;
  }

  return { header, toolbar, render, renderOptions };
}
