// @ts-check
// Top right: who else is here (click or Enter on an avatar follows that person's viewport), and
// your own name and colour. Plus the "Following X — Stop" chip.

import { h, avatar } from "./dom.js";
import { nameDialog } from "./dialogs.js";

/** @typedef {import("./app.js").App} App */
/** @typedef {import("../store-contract.js").ClientState} ClientState */

const MAX_SHOWN = 6;

/** @param {App} app */
export function createPeople(app) {
  const { store, canvas } = app;
  const list = h("div", { class: "people", role: "group", "aria-label": "Nobody else is here" });
  const meBtn = h("button", {
    type: "button", class: "btn me-btn", title: "Change your name or colour", "aria-label": "Change your name or colour",
  });
  meBtn.addEventListener("click", async () => {
    const viewer = store.getState().viewer;
    const result = await nameDialog({ name: viewer.name, color: viewer.color, title: "Your name", skippable: false });
    if (result) store.setViewer(result.name, result.color);
  });
  const el = h("div", { class: "wb-float wb-topright" }, list, meBtn);

  const followName = h("strong", { class: "follow-name" });
  const stopBtn = h("button", {
    type: "button", class: "btn small outline follow-stop", onclick: () => { canvas.follow(null); render(store.getState()); },
  }, "Stop");
  const chip = h("div", { class: "wb-float follow-chip", role: "status", hidden: true },
    h("span", null, "Following ", followName), stopBtn);

  let listKey = "";
  let meKey = "";
  let chipKey = "";

  /** @param {ClientState} state */
  function render(state) {
    const following = canvas.getFollowing();
    if (following && !state.peers.has(following)) {
      // The person left: stop following rather than freezing on their last viewport.
      canvas.follow(null);
      app.announce("Stopped following: they left the whiteboard");
    }
    const followingNow = canvas.getFollowing();
    const peers = [...state.peers.values()].sort((a, b) => (a.clientId < b.clientId ? -1 : 1));
    const key = peers.map((p) => `${p.clientId}:${p.name}:${p.color}`).join("|") + "#" + followingNow;
    if (key !== listKey) {
      listKey = key;
      const active = /** @type {HTMLElement|null} */ (document.activeElement);
      const focusedClient = active && list.contains(active) ? active.dataset.client : null;
      const shown = peers.slice(0, MAX_SHOWN);
      list.replaceChildren(
        ...shown.map((p) => {
          const name = p.name || "Guest";
          const on = p.clientId === followingNow;
          const b = h("button", {
            type: "button", class: "peer", "aria-pressed": String(on), dataset: { client: p.clientId },
            title: on ? `${name} (following; click to stop)` : `${name}: click to follow`,
            "aria-label": on ? `Stop following ${name}` : `Follow ${name}`,
            onclick: () => {
              if (canvas.getFollowing() === p.clientId) canvas.follow(null);
              else { canvas.follow(p.clientId); app.announce(`Following ${name}`); }
              render(store.getState());
            },
          }, avatar(name, p.color, "peer-avatar"));
          // The avatar's own role/label would double up inside the button.
          const a = /** @type {HTMLElement} */ (b.firstChild);
          a.removeAttribute("role");
          a.removeAttribute("aria-label");
          a.setAttribute("aria-hidden", "true");
          return b;
        }),
        peers.length > shown.length ? h("span", {
          class: "avatar more", style: { background: "var(--border)" }, role: "img",
          title: peers.slice(MAX_SHOWN).map((p) => p.name || "Guest").join(", "),
          "aria-label": `and ${peers.length - MAX_SHOWN} more: ${peers.slice(MAX_SHOWN).map((p) => p.name || "Guest").join(", ")}`,
        }, `+${peers.length - MAX_SHOWN}`) : "",
      );
      list.setAttribute("aria-label", peers.length ? `Also here: ${peers.map((p) => p.name || "Guest").join(", ")}` : "Nobody else is here");
      if (focusedClient) /** @type {HTMLElement|null} */ (list.querySelector(`[data-client="${focusedClient}"]`))?.focus();
    }

    const v = state.viewer;
    const mk = v.name + v.color;
    if (mk !== meKey) {
      meKey = mk;
      meBtn.replaceChildren(avatar(v.name || "Guest", v.color, "me"), h("span", { class: "me-name" }, v.name || "Guest"));
    }

    const peer = followingNow ? state.peers.get(followingNow) : null;
    const ck = peer ? `${peer.clientId}:${peer.name}:${peer.color}` : "";
    if (ck !== chipKey) {
      const wasFocused = chip.contains(document.activeElement);
      chipKey = ck;
      chip.hidden = !peer;
      app.root.classList.toggle("following", !!peer);
      if (peer) {
        followName.textContent = peer.name || "Guest";
        chip.style.borderColor = peer.color;
      } else if (wasFocused) {
        canvas.element.focus?.({ preventScroll: true });
      }
    }
  }

  return { el, chip, render };
}
