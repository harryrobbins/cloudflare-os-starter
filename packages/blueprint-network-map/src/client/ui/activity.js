// @ts-check
// The Activity panel: the map's server history, newest first, with per-change undo and undo of a
// whole import (docs/plans/network-map-blueprint.md §8.1: undo is conflict-aware, so what others
// changed since is kept and reported), and the people here now, with follow.

import { h, clear, formatTime, avatar } from "./dom.js";
import { ensureStyle } from "./css.js";
import { groupUndoState, historyBadges, undoMessage } from "./data-logic.js";

/** The server keeps at most this many history entries. */
const MAX_ENTRIES = 200;

const STYLE = String.raw`
.nm-activity { display: flex; flex-direction: column; margin: -12px; }
.nm-activity .nm-section { padding: 12px; gap: 8px; }
.nm-activity .nm-section:last-child { border-bottom: 0; }
.nm-activity ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.nm-activity .people li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.nm-activity .people .who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.nm-activity .people .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm-activity .people .where { font-size: 12px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm-activity .history li { padding: 8px 0; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 4px; }
.nm-activity .history li:last-child { border-bottom: 0; }
.nm-activity .history li[data-undone] .summary { color: var(--text-3); text-decoration: line-through; text-decoration-color: var(--border-strong); }
.nm-activity .summary { overflow-wrap: anywhere; }
.nm-activity .meta { font-size: 12px; color: var(--text-3); display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
.nm-activity .chip { font-size: 11px; padding: 0 6px; }
.nm-activity .chip[data-badge="undone"] { color: var(--text-3); }
.nm-activity .chip[data-badge="not-undoable"] { color: var(--warn); border-color: var(--warn); }
.nm-activity .chip[data-badge="group"] { color: var(--accent); border-color: var(--accent); }
.nm-activity .actions { display: flex; gap: 6px; flex-wrap: wrap; }
.nm-activity .status-line { font-size: 13px; margin: 0; color: var(--text-2); }
.nm-activity .status-line:empty { display: none; }
.nm-activity .status-line.error { color: var(--danger); }
`;

/** Whom this pane follows, when the app does not keep it (see `follow` below). */
let followingFallback = /** @type {string|null} */ (null);

/**
 * @param {HTMLElement} host
 * @param {any} app
 */
export function mountActivity(host, app) {
  ensureStyle("nm-activity", STYLE);
  const store = app.store;
  let destroyed = false;
  /** @type {Set<string>} */
  const busy = new Set();

  const peopleList = h("ul", { class: "people", "aria-label": "People here now" });
  const historyList = h("ul", { class: "history", "aria-label": "Changes, newest first" });
  const status = h("p", { class: "status-line", role: "status", "aria-live": "polite" });
  const error = h("p", { class: "status-line error", role: "alert" });
  const loading = h("p", { class: "muted" }, "Loading the history…");

  const root = h("div", { class: "nm-activity" },
    h("section", { class: "nm-section", "aria-labelledby": "nm-activity-people" }, h("h3", { id: "nm-activity-people" }, "People here now"), peopleList),
    h("section", { class: "nm-section", "aria-labelledby": "nm-activity-history" },
      h("h3", { id: "nm-activity-history" }, "Activity"),
      h("p", { class: "muted", style: { margin: 0 } }, "Undo restores only what is unchanged since; anything changed later is kept."),
      status, error, loading, historyList));
  host.appendChild(root);

  // --- People ---------------------------------------------------------------------------------

  const followingNow = () => (typeof app.following === "string" || app.following === null ? app.following : followingFallback);

  /** @param {string|null} clientId */
  function follow(clientId) {
    // app.follow (when the shell offers it) also moves the camera with the person; presence alone
    // only tells the others.
    if (typeof app.follow === "function") app.follow(clientId);
    else { followingFallback = clientId; store.setPresence({ following: clientId }); }
    renderPeople();
  }

  function renderPeople() {
    if (destroyed) return;
    const focusKey = /** @type {HTMLElement|null} */ (document.activeElement)?.dataset?.key;
    clear(peopleList);
    const peers = [...store.peers.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (!peers.length) { peopleList.append(h("li", { class: "muted" }, "Only you are here.")); return; }
    const mine = followingNow();
    for (const p of peers) {
      const view = p.viewId ? store.objects.get(p.viewId)?.name : null;
      const followed = p.following ? (p.following === store.viewer.clientId ? "you" : store.peers.get(p.following)?.name ?? "someone") : null;
      const where = [view ? `viewing ${view}` : null, followed ? `following ${followed}` : null].filter(Boolean).join(" · ");
      const on = mine === p.clientId;
      peopleList.append(h("li", { dataset: { client: p.clientId } },
        avatar(p.name ?? "Someone", p.color ?? "#6b7280"),
        h("span", { class: "who" }, h("span", { class: "name" }, p.name ?? "Someone"), where ? h("span", { class: "where" }, where) : null),
        h("button", {
          type: "button", class: "btn small outline", "aria-pressed": String(on), dataset: { key: `follow:${p.clientId}` },
          "aria-label": on ? `Stop following ${p.name}` : `Follow ${p.name}`,
          onclick: () => follow(on ? null : p.clientId),
        }, on ? "Following" : "Follow")));
    }
    const el = focusKey ? /** @type {HTMLElement|null} */ (peopleList.querySelector(`[data-key="${focusKey.replace(/["\\]/g, "\\$&")}"]`)) : null;
    el?.focus();
  }

  // --- History --------------------------------------------------------------------------------

  /** @param {string|undefined} groupId */
  const groupName = (groupId) => {
    if (!groupId) return null;
    const m = store.changesets.get(groupId);
    return m ? `Import “${m.name}”` : "Import";
  };

  function renderHistory() {
    if (destroyed) return;
    const focusKey = /** @type {HTMLElement|null} */ (document.activeElement)?.dataset?.key;
    clear(historyList);
    const entries = [...store.history].sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0)).slice(0, MAX_ENTRIES);
    if (!entries.length) { historyList.append(h("li", { class: "muted" }, "No changes yet.")); return; }
    for (const e of entries) {
      const badges = historyBadges(e);
      const group = groupName(e.groupId);
      const actions = [];
      if (e.undoable && !e.undoneBy) {
        actions.push(h("button", {
          type: "button", class: "btn small outline", disabled: busy.has(e.id), dataset: { key: `undo:${e.id}` },
          "aria-label": `${e.undoOf ? "Redo" : "Undo"}: ${e.summary}`, onclick: () => undoEntry(e),
        }, e.undoOf ? "Redo" : "Undo"));
      }
      if (e.groupId && groupUndoState(e.groupId, store.history) !== "undone" && !e.undoOf) {
        actions.push(h("button", {
          type: "button", class: "btn small", disabled: busy.has(e.groupId), dataset: { key: `group:${e.id}` },
          onclick: () => undoGroup(e.groupId),
        }, "Undo whole import"));
      }
      historyList.append(h("li", { dataset: { entry: e.id, ...(e.undoneBy ? { undone: "" } : {}) } },
        h("span", { class: "summary" }, e.summary || "Change"),
        h("span", { class: "meta" },
          h("span", null, e.by ?? "Someone"),
          h("time", { datetime: e.at ? new Date(e.at).toISOString() : undefined, title: e.at ? new Date(e.at).toLocaleString() : undefined }, formatTime(e.at)),
          group ? h("span", { class: "chip", dataset: { badge: "group" } }, group) : null,
          badges.map((b) => h("span", { class: "chip", dataset: { badge: b.key } }, b.label))),
        actions.length ? h("span", { class: "actions" }, actions) : null));
    }
    if (focusKey) /** @type {HTMLElement|null} */ (historyList.querySelector(`[data-key="${focusKey.replace(/["\\]/g, "\\$&")}"]`))?.focus();
  }

  /** @param {any} e */
  async function undoEntry(e) {
    busy.add(e.id);
    status.textContent = "";
    error.textContent = "";
    renderHistory();
    const result = await store.undo(e.id, { quiet: true });
    busy.delete(e.id);
    const msg = undoMessage(result);
    (msg.ok ? status : error).textContent = msg.message;
    app.announce(msg.message);
    renderHistory();
  }

  /** @param {string} groupId */
  async function undoGroup(groupId) {
    busy.add(groupId);
    status.textContent = "";
    error.textContent = "";
    renderHistory();
    try {
      const msg = undoMessage(await store.call("undoGroup", { groupId, senderId: store.viewer.clientId, by: app.by }));
      (msg.ok ? status : error).textContent = msg.message;
      app.announce(msg.message);
    } catch (err) {
      error.textContent = "Could not undo the import: " + String(/** @type {any} */ (err)?.message ?? err).slice(0, 200);
    }
    busy.delete(groupId);
    renderHistory();
  }

  const unsubscribe = store.subscribe((/** @type {any} */ change) => {
    if (destroyed) return;
    if (change.type === "history" || change.type === "changesets") renderHistory();
    else if (change.type === "presence") renderPeople();
    else if (change.type === "snapshot") { renderHistory(); renderPeople(); }
  });
  const offView = typeof app.on === "function" ? app.on("view", () => renderPeople()) : () => {};
  // Relative times ("5 min ago") age.
  const tick = setInterval(renderHistory, 30_000);

  renderPeople();
  renderHistory();
  store.ensureHistory().then(() => { loading.remove(); renderHistory(); }, () => { loading.textContent = "The history could not be loaded."; });

  return {
    destroy() {
      destroyed = true;
      unsubscribe();
      offView();
      clearInterval(tick);
      root.remove();
    },
  };
}
