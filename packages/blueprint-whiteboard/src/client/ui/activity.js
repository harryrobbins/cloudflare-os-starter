// @ts-check
// The Activity panel: recent changes from the server history, newest first, with Undo where the
// server recorded an inverse.

import { h, icon, formatTime } from "./dom.js";
import { showToast } from "./dialogs.js";

/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("./app.js").App} App */

/** @param {App} app */
export function createActivity(app) {
  const { store } = app;
  /** @type {HTMLElement|null} */
  let drawer = null;
  /** @type {HTMLElement|null} */
  let list = null;
  let loading = false;
  let key = "";
  /** @type {Set<string>} */
  const undoing = new Set();

  function open() {
    if (drawer) return;
    const closeBtn = h("button", { type: "button", class: "btn icon-only activity-close", "aria-label": "Close activity", onclick: () => close() }, icon("close", 18));
    list = h("ol", { class: "panel-list activity-list" });
    drawer = h("aside", { class: "wb-panel activity", "aria-label": "Activity", tabindex: "-1" },
      h("div", { class: "panel-head" }, h("h2", null, "Activity"), closeBtn),
      list);
    drawer.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    document.body.appendChild(drawer);
    app.activityOpen = true;
    key = "";
    loading = true;
    render(store.getState());
    closeBtn.focus();
    store.loadHistory(50).then(() => { loading = false; key = ""; render(store.getState()); }, (err) => {
      loading = false;
      showToast("Couldn't load activity: " + (err?.message ?? err));
      key = "";
      render(store.getState());
    });
    app.refreshChrome();
  }

  function close() {
    if (!drawer) return;
    drawer.remove();
    drawer = null;
    list = null;
    app.activityOpen = false;
    app.refreshChrome();
    /** @type {HTMLElement|null} */ (document.querySelector(".activity-toggle"))?.focus();
  }

  /** @param {ClientState} state */
  function render(state) {
    if (!list) return;
    const entries = [...state.history].reverse();
    const k = (loading ? "L" : "") + entries.map((e) => e.id + (undoing.has(e.id) ? "u" : "")).join(",");
    if (k === key) return;
    key = k;
    const hadFocus = !!drawer && drawer.contains(document.activeElement);
    if (!entries.length) {
      list.replaceChildren(h("li", { class: "muted" }, loading ? "Loading…" : "No activity yet."));
      return;
    }
    list.replaceChildren(...entries.map((entry) => h("li", { class: "activity-item", dataset: { historyId: entry.id } },
      h("div", { class: "summary" },
        h("div", null, entry.summary),
        h("div", { class: "when" }, `${entry.by || "Someone"} · ${formatTime(entry.at)}`)),
      entry.inverse ? h("button", {
        type: "button", class: "btn small outline undo-history-btn", disabled: undoing.has(entry.id),
        "aria-label": "Undo: " + entry.summary,
        onclick: async () => {
          undoing.add(entry.id);
          key = "";
          render(store.getState());
          try {
            await store.undoHistory(entry.id);
          } catch (err) {
            showToast("Undo failed: " + (/** @type {any} */ (err)?.message ?? err));
          } finally {
            undoing.delete(entry.id);
            key = "";
            render(store.getState());
          }
        },
      }, icon("undo", 14), "Undo") : null,
    )));
    // A rebuilt list drops focus from a button in it; keep it inside the panel.
    if (hadFocus && drawer && !drawer.contains(document.activeElement)) drawer.focus();
  }

  return {
    toggle: () => (drawer ? close() : open()),
    open, close, render,
    get isOpen() { return !!drawer; },
  };
}
