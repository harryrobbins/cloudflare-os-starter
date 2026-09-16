// @ts-check
// The Activity drawer: recent changes newest first, with Undo where the server recorded an inverse.

import { h, icon, formatTime, trapTab } from "./dom.js";
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
    const closeBtn = h("button", { type: "button", class: "btn icon-only", "aria-label": "Close activity", onclick: () => close() }, icon("close", 18));
    list = h("ol", { class: "activity-list", "aria-live": "polite" });
    drawer = h("aside", { class: "activity", role: "dialog", "aria-label": "Activity", tabindex: "-1" },
      h("div", { class: "panel-head" }, h("h2", { style: { margin: "0", fontSize: "16px", flex: "1" } }, "Activity"), closeBtn),
      list);
    drawer.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      trapTab(/** @type {HTMLElement} */ (drawer), e);
    });
    document.body.appendChild(drawer);
    app.activityOpen = true;
    key = "";
    loading = true;
    render(store.getState());
    closeBtn.focus();
    store.loadHistory(50).then(() => { loading = false; render(store.getState()); }, (err) => {
      loading = false;
      showToast("Couldn't load activity: " + (err?.message ?? err));
      render(store.getState());
    });
    app.header?.render(store.getState());
  }

  function close() {
    if (!drawer) return;
    drawer.remove();
    drawer = null;
    list = null;
    app.activityOpen = false;
    app.header?.render(store.getState());
    /** @type {HTMLElement|null} */ (document.querySelector(".activity-toggle"))?.focus();
  }

  /** @param {ClientState} state */
  function render(state) {
    if (!list) return;
    const entries = [...state.history].reverse();
    const k = (loading ? "L" : "") + entries.map((e) => e.id + (undoing.has(e.id) ? "u" : "")).join(",");
    if (k === key) return;
    key = k;
    if (!entries.length) {
      list.replaceChildren(h("li", { class: "muted", style: { padding: "12px 4px" } }, loading ? "Loading…" : "No activity yet."));
      return;
    }
    list.replaceChildren(...entries.map((entry) => h("li", { class: "activity-item", dataset: { historyId: entry.id } },
      h("div", { class: "summary" },
        h("div", null, entry.summary),
        h("div", { class: "when" }, `${entry.by || "Someone"} · ${formatTime(entry.at)}`)),
      entry.inverse ? h("button", {
        type: "button", class: "btn small outline undo-btn", disabled: undoing.has(entry.id),
        "aria-label": "Undo: " + entry.summary,
        onclick: async () => {
          undoing.add(entry.id);
          key = "";
          render(store.getState());
          try {
            await store.undo(entry.id);
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
  }

  return {
    toggle: () => (drawer ? close() : open()),
    open,
    close,
    render,
    get isOpen() { return !!drawer; },
  };
}
