// @ts-check
// Top right: who else is here (click or Enter on an avatar follows that person's viewport), and
// your own name and colour. Plus the "Following X — Stop" chip. When more people are here than
// fit (6 avatars, 3 on phones), a "+N" button lists everyone in a menu, each with Follow.

import { h, avatar } from "./dom.js";
import { colorDialog, openMenu } from "./dialogs.js";

/** @typedef {import("./app.js").App} App */
/** @typedef {import("../store-contract.js").ClientState} ClientState */

const MAX_SHOWN = 6;
const MAX_SHOWN_PHONE = 3;

/**
 * How many avatars to show for `count` people when `max` fit: all of them, or max - 1 plus the
 * "+N" button (so the button never hides just one person).
 * @param {number} count @param {number} max
 */
export function shownPeople(count, max) {
  return count <= max ? count : Math.max(1, max - 1);
}

/** @param {App} app */
export function createPeople(app) {
  const { store, canvas } = app;
  const list = h("div", { class: "people", role: "group", "aria-label": "Nobody else is here" });
  const meBtn = h("button", {
    type: "button", class: "btn me-btn", title: "Change your colour", "aria-label": "Change your colour",
  });
  meBtn.addEventListener("click", async () => {
    const viewer = store.getState().viewer;
    const color = await colorDialog({ name: viewer.name, color: viewer.color });
    if (color) store.setViewer(viewer.name, color);
  });
  const el = h("div", { class: "wb-float wb-topright" }, list, meBtn);

  const followName = h("strong", { class: "follow-name" });
  const stopBtn = h("button", {
    type: "button", class: "btn small outline follow-stop", onclick: () => { canvas.follow(null); render(store.getState()); },
  }, "Stop");
  const chip = h("div", { class: "wb-float follow-chip", role: "status", hidden: true },
    h("span", null, "Following ", followName), stopBtn);

  const phone = typeof matchMedia === "function" ? matchMedia("(max-width: 600px)") : null;
  phone?.addEventListener?.("change", () => { listKey = ""; render(store.getState()); });

  /** @param {string} clientId @param {string} name */
  function toggleFollow(clientId, name) {
    if (canvas.getFollowing() === clientId) canvas.follow(null);
    else { canvas.follow(clientId); app.announce(`Following ${name}`); }
    render(store.getState());
  }

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
    const max = phone?.matches ? MAX_SHOWN_PHONE : MAX_SHOWN;
    const key = peers.map((p) => `${p.clientId}:${p.name}:${p.color}`).join("|") + "#" + followingNow + "#" + max;
    if (key !== listKey) {
      listKey = key;
      const active = /** @type {HTMLElement|null} */ (document.activeElement);
      const focusedClient = active && list.contains(active) ? active.dataset.client : null;
      const moreFocused = !!active?.classList.contains("more-people");
      const shown = peers.slice(0, shownPeople(peers.length, max));
      const hiddenCount = peers.length - shown.length;
      list.replaceChildren(
        ...shown.map((p) => {
          const name = p.name || "Guest";
          const on = p.clientId === followingNow;
          const b = h("button", {
            type: "button", class: "peer", "aria-pressed": String(on), dataset: { client: p.clientId },
            title: on ? `${name} (following; click to stop)` : `${name}: click to follow`,
            "aria-label": on ? `Stop following ${name}` : `Follow ${name}`,
            onclick: () => toggleFollow(p.clientId, name),
          }, avatar(name, p.color, "peer-avatar"));
          // The avatar's own role/label would double up inside the button.
          const a = /** @type {HTMLElement} */ (b.firstChild);
          a.removeAttribute("role");
          a.removeAttribute("aria-label");
          a.setAttribute("aria-hidden", "true");
          return b;
        }),
        hiddenCount > 0 ? morePeopleButton(hiddenCount, peers.length) : "",
      );
      list.setAttribute("aria-label", peers.length ? `Also here: ${peers.map((p) => p.name || "Guest").join(", ")}` : "Nobody else is here");
      if (focusedClient) /** @type {HTMLElement|null} */ (list.querySelector(`[data-client="${focusedClient}"]`))?.focus();
      else if (moreFocused) /** @type {HTMLElement|null} */ (list.querySelector(".more-people"))?.focus();
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

  /** @param {number} hiddenCount @param {number} total */
  function morePeopleButton(hiddenCount, total) {
    const b = h("button", {
      type: "button", class: "peer more-people", "aria-haspopup": "menu",
      "aria-label": `${hiddenCount} more ${hiddenCount === 1 ? "person" : "people"}: list all ${total} and follow`,
      title: "Everyone here",
    }, h("span", { class: "avatar more", "aria-hidden": "true" }, `+${hiddenCount}`));
    b.addEventListener("click", () => {
      const following = canvas.getFollowing();
      const everyone = [...store.getState().peers.values()].sort((x, y) => (x.clientId < y.clientId ? -1 : 1));
      openMenu(b, everyone.map((p) => {
        const name = p.name || "Guest";
        return {
          label: p.clientId === following ? `Stop following ${name}` : `Follow ${name}`,
          className: "follow-item",
          onSelect: () => toggleFollow(p.clientId, name),
        };
      }), { label: "Everyone here" });
    });
    return b;
  }

  return { el, chip, render };
}
