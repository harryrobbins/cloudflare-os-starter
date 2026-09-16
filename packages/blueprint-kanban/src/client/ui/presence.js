// @ts-check
// Presence decorations: header avatars, rings on cards peers have open, dashed ghosts on cards
// peers are dragging, and a dashed border on the column a peer is dragging over.

import { h, avatar } from "./dom.js";

/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").Peer} Peer */
/** @typedef {import("./app.js").App} App */

/** @type {Set<HTMLElement>} */
const decorated = new Set();

/**
 * @param {App} app
 * @param {ClientState} state
 */
export function applyPresence(app, state) {
  /** @type {Map<string, Peer[]>} */
  const openers = new Map();
  /** @type {Map<string, Peer>} */
  const draggers = new Map();
  /** @type {Map<string, Peer>} */
  const hovers = new Map();
  for (const peer of state.peers.values()) {
    if (peer.openCardId) openers.set(peer.openCardId, [...(openers.get(peer.openCardId) ?? []), peer]);
    if (peer.dragCardId) draggers.set(peer.dragCardId, peer);
    if (peer.dragCardId && peer.hoverColumnId) hovers.set(peer.hoverColumnId, peer);
  }

  const next = new Set();
  for (const [cardId, peers] of openers) {
    const el = app.cardEls.get(cardId);
    if (!el) continue;
    next.add(el);
    const rings = peers.map((p, i) => `0 0 0 ${2 + i * 2}px ${p.color}`).join(", ");
    el.style.setProperty("--ring", rings);
    el.classList.add("peer-open");
    let badges = /** @type {HTMLElement|null} */ (el.querySelector(".peer-badges"));
    const key = peers.map((p) => p.clientId + p.name + p.color).join("|");
    if (!badges) { badges = h("span", { class: "peer-badges" }); el.appendChild(badges); }
    if (badges.dataset.key !== key) {
      badges.dataset.key = key;
      badges.replaceChildren(...peers.map((p) => avatar(p.name || "Guest", p.color, "small")));
      badges.title = peers.map((p) => p.name || "Guest").join(", ") + " viewing";
    }
  }
  for (const [cardId, peer] of draggers) {
    const el = app.cardEls.get(cardId);
    if (!el) continue;
    next.add(el);
    el.style.setProperty("--ghost", peer.color);
    el.classList.add("peer-drag");
    el.dataset.peerDrag = peer.name || "Guest";
  }
  for (const view of app.boardView?.views.values() ?? []) {
    const peer = hovers.get(view.el.dataset.columnId || "");
    if (peer) {
      next.add(view.el);
      view.el.classList.add("peer-hover");
      view.el.style.borderColor = peer.color;
    }
  }
  for (const el of decorated) {
    if (next.has(el)) {
      const id = el.dataset.cardId;
      if (id && !openers.has(id)) clearOpen(el);
      if (id && !draggers.has(id)) clearDrag(el);
      if (el.dataset.columnId && !hovers.has(el.dataset.columnId)) clearHover(el);
      continue;
    }
    clearOpen(el);
    clearDrag(el);
    clearHover(el);
  }
  decorated.clear();
  for (const el of next) decorated.add(el);

  renderAvatars(app, state);
  app.panel?.renderViewers(state);
}

/** @param {HTMLElement} el */
function clearOpen(el) {
  el.classList.remove("peer-open");
  el.style.removeProperty("--ring");
  el.querySelector(".peer-badges")?.remove();
}
/** @param {HTMLElement} el */
function clearDrag(el) {
  el.classList.remove("peer-drag");
  el.style.removeProperty("--ghost");
  delete el.dataset.peerDrag;
}
/** @param {HTMLElement} el */
function clearHover(el) {
  if (!el.classList.contains("peer-hover")) return;
  el.classList.remove("peer-hover");
  el.style.borderColor = "";
}

/**
 * @param {App} app
 * @param {ClientState} state
 */
function renderAvatars(app, state) {
  const host = app.avatarsEl;
  if (!host) return;
  const peers = [...state.peers.values()].sort((a, b) => a.clientId < b.clientId ? -1 : 1);
  const key = peers.map((p) => `${p.clientId}:${p.name}:${p.color}`).join("|");
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  const shown = peers.slice(0, 6);
  host.replaceChildren(
    ...shown.map((p) => {
      const a = avatar(p.name || "Guest", p.color, "peer");
      a.dataset.clientId = p.clientId;
      return a;
    }),
    peers.length > shown.length ? h("span", { class: "avatar", style: { background: "var(--border)" }, title: peers.slice(6).map((p) => p.name).join(", ") }, `+${peers.length - 6}`) : "",
  );
  host.setAttribute("aria-label", peers.length
    ? `Also here: ${peers.map((p) => p.name || "Guest").join(", ")}`
    : "Nobody else is here");
}
