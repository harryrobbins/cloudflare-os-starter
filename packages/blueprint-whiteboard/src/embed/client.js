// @ts-check
// Client side of the embeddable whiteboard: mounts the full whiteboard UI for one drawing inside
// another app's page (Docs), and takes it all away again on destroy().
//
// The host passes a `gadget`-shaped adapter whose methods reach this drawing on the host's server
// (subscribe, applyOperation, updatePresence, leavePresence, undo, getHistory). The store and UI
// are the Whiteboard gadget's own, unchanged: only what they add to the page is scoped here.
//   * Styles are injected on mount and removed on destroy, because both apps style html/body and
//     :root, so the host's page keeps its look while no drawing is open.
//   * Panels, menus, toasts and the live region the UI appends to <body> are removed on destroy.

import { createStore } from "../client/sync/store.js";
import { mountApp, injectStyles } from "../client/ui/app.js";
import { PALETTE } from "../client/ui/dom.js";

export { PALETTE };

/**
 * @typedef {object} EmbeddedWhiteboard
 * @property {import("../client/store-contract.js").Store} store
 * @property {HTMLElement} topbar   the title bar; the host may add its own controls to it
 * @property {() => void} destroy   removes the UI and its styles and leaves the drawing's presence
 */

/**
 * @param {HTMLElement} root  an element the whiteboard may fill; it should cover the viewport
 * @param {object} options
 * @param {any} options.gadget  adapter with the Whiteboard gadget's live methods, scoped to one drawing
 * @param {any} options.RpcTarget
 * @param {{clientId: string, name: string, color: string}} options.viewer
 * @param {() => void} [options.onUnrecoverable]  the connection cannot be restored without a reload
 * @returns {Promise<EmbeddedWhiteboard>}
 */
export async function mountWhiteboard(root, { gadget, RpcTarget, viewer, onUnrecoverable }) {
  const before = new Set(document.body.children);
  const hadStyles = Boolean(document.getElementById("wb-styles"));
  injectStyles();
  let store;
  try {
    store = await createStore({ gadget, RpcTarget, viewer, onUnrecoverable: onUnrecoverable ?? (() => {}) });
  } catch (err) {
    if (!hadStyles) document.getElementById("wb-styles")?.remove();
    throw err;
  }
  const live = store;
  const { app, destroy: destroyApp } = mountApp(root, live, { embedded: true });
  const syncVisibility = () => live.setVisibility(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", syncVisibility, { signal: app.signal });
  syncVisibility();
  if (!document.activeElement || document.activeElement === document.body) {
    app.canvas.element.focus({ preventScroll: true });
  }
  let destroyed = false;
  return {
    store: live,
    topbar: /** @type {HTMLElement} */ (root.querySelector(".wb-topbar")),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      destroyApp();
      live.dispose();
      for (const child of [...document.body.children]) {
        if (!before.has(child) && child !== root && !child.contains(root)) child.remove();
      }
      if (!hadStyles) document.getElementById("wb-styles")?.remove();
    },
  };
}
