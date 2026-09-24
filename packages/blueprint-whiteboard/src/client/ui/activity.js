// @ts-check
// The Activity panel: recent changes from the server history, newest first, with Undo where the
// server recorded an inverse.
//
// The list is virtualised like the Objects panel (./virtual-list.js): rows near the scrolled
// window only, aria-setsize/aria-posinset on each, one Tab stop with arrow-key movement, and focus
// kept on the same entry's Undo button across updates.

import { h, icon, formatTime } from "./dom.js";
import { showToast } from "./dialogs.js";
import { createVirtualList } from "./virtual-list.js";

/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("./app.js").App} App */

/** Row height before the first row is measured (summary line, time line, padding). */
const ROW_HEIGHT = 58;

/** @param {App} app */
export function createActivity(app) {
  const { store } = app;
  /** @type {HTMLElement|null} */
  let drawer = null;
  /** @type {HTMLElement|null} */
  let list = null;
  /** @type {ReturnType<typeof createVirtualList>|null} */
  let vlist = null;
  let loading = false;
  /** @type {import("../store-contract.js").HistoryEntry[]} */
  let entries = [];
  /** @type {Set<string>} */
  const undoing = new Set();

  function open() {
    if (drawer) return;
    const closeBtn = h("button", { type: "button", class: "btn icon-only activity-close", "aria-label": "Close activity", onclick: () => close() }, icon("close", 18));
    list = h("ol", { class: "panel-list activity-list", "aria-label": "Recent changes", tabindex: "-1" });
    drawer = h("aside", { class: "wb-panel activity", "aria-label": "Activity", tabindex: "-1" },
      h("div", { class: "panel-head" }, h("h2", null, "Activity"), closeBtn),
      list);
    drawer.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    });
    vlist = createVirtualList({
      list,
      rowHeight: ROW_HEIGHT,
      rowKey: (i) => entries[i].id,
      rowStamp: (i) => entries[i].id + (undoing.has(entries[i].id) ? "u" : ""),
      renderRow: (i) => rowFor(entries[i]),
      fallbackFocus: () => drawer,
    });
    document.body.appendChild(drawer);
    app.activityOpen = true;
    loading = true;
    render(store.getState());
    closeBtn.focus();
    store.loadHistory(50).then(() => { loading = false; render(store.getState()); }, (err) => {
      loading = false;
      showToast("Couldn't load activity: " + (err?.message ?? err));
      render(store.getState());
    });
    app.refreshChrome();
  }

  function close() {
    if (!drawer) return;
    drawer.remove();
    drawer = null;
    list = null;
    vlist = null;
    entries = [];
    app.activityOpen = false;
    app.refreshChrome();
    /** @type {HTMLElement|null} */ (document.querySelector(".activity-toggle"))?.focus();
  }

  /** @param {import("../store-contract.js").HistoryEntry} entry */
  function rowFor(entry) {
    return h("li", { class: "activity-item", dataset: { historyId: entry.id } },
      h("div", { class: "summary" },
        h("div", { class: "what", title: entry.summary }, entry.summary),
        h("div", { class: "when" }, `${entry.by || "Someone"} · ${formatTime(entry.at)}`)),
      entry.inverse ? h("button", {
        type: "button", class: "btn small outline undo-history-btn", disabled: undoing.has(entry.id),
        "aria-label": "Undo: " + entry.summary,
        onclick: async () => {
          undoing.add(entry.id);
          render(store.getState());
          try {
            await store.undoHistory(entry.id);
          } catch (err) {
            showToast("Undo failed: " + (/** @type {any} */ (err)?.message ?? err));
          } finally {
            undoing.delete(entry.id);
            render(store.getState());
          }
        },
      }, icon("undo", 14), "Undo") : null,
    );
  }

  /** @param {ClientState} state */
  function render(state) {
    if (!list || !vlist) return;
    entries = [...state.history].reverse();
    vlist.update(entries.length, entries.length ? null : h("li", { class: "muted" }, loading ? "Loading…" : "No activity yet."));
  }

  return {
    toggle: () => (drawer ? close() : open()),
    open, close, render,
    get isOpen() { return !!drawer; },
    /** The virtual list (tests). */
    get list() { return vlist; },
  };
}
