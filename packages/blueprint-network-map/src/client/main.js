// @ts-check
// Client entry point. Runs inside the gadget's sandboxed iframe, which has no HTML of its own:
// everything is built here. Provided by the platform: `gadget` (RPC stub to the Gadget Durable
// Object), `gadgetViewer` (the signed-in user; our fork's patch) and `RpcTarget`, declared as
// module-scope bindings in a prefix the platform prepends to this file (NOT properties of
// globalThis). All are read as free identifiers behind `typeof` guards.
//
// Recovery (as the whiteboard's): after a facet restart the platform never replaces this frame's
// `gadget` stub; only a frame reload gets a fresh one. The store asks to reload when the stub is
// dead and nothing is unsaved; with unsaved changes the recovery screen offers them as a download
// first. window.name carries the viewer's colour and the auto-reload budget across reloads.

import { createStore } from "./sync/store.js";
import { mountApp } from "./ui/app.js";
import { injectStyles } from "./ui/styles.js";
import { PALETTE } from "./ui/dom.js";
import { showRecoveryScreen } from "./ui/recovery.js";
import { TERMINAL_RECOVERY_MS, recoveryAction } from "./sync/connection.js";

/* global gadget, gadgetViewer, RpcTarget */
// @ts-ignore provided by the platform prefix
const platformGadget = typeof gadget !== "undefined" ? gadget : undefined;
// @ts-ignore provided by the platform prefix
const platformRpcTarget = typeof RpcTarget !== "undefined" ? RpcTarget : undefined;
// @ts-ignore provided by the platform prefix: {id, displayName, role} of the signed-in user
const platformViewer = typeof gadgetViewer !== "undefined" ? gadgetViewer : undefined;

const WINDOW_NAME_PREFIX = "network-map:";
const MAX_AUTO_RELOADS = 3;
const AUTO_RELOAD_WINDOW_MS = 60_000;

/** @returns {{color: string|null, reloads: number[]}} */
function readCarried() {
  const empty = { color: null, reloads: [] };
  try {
    const raw = window.name;
    if (typeof raw !== "string" || !raw.startsWith(WINDOW_NAME_PREFIX)) return empty;
    const data = JSON.parse(raw.slice(WINDOW_NAME_PREFIX.length));
    return {
      color: typeof data?.color === "string" && /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : null,
      reloads: Array.isArray(data?.reloads) ? data.reloads.filter((/** @type {unknown} */ t) => typeof t === "number") : [],
    };
  } catch {
    return empty;
  }
}

/** @param {{color: string|null, reloads: number[]}} data */
function writeCarried(data) {
  try { window.name = WINDOW_NAME_PREFIX + JSON.stringify(data); } catch { /* ignore */ }
}

/** The signed-in account's display name; changes are attributed to it and nobody is asked. */
function accountName() {
  const v = platformViewer;
  const name = typeof v?.displayName === "string" && v.displayName.trim() ? v.displayName : v?.id;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function randomClientId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** @param {string} text @param {boolean} [busy] */
function showOverlay(text, busy = true) {
  let el = document.getElementById("nm-connection-overlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "nm-connection-overlay";
    el.setAttribute("role", busy ? "status" : "alert");
    el.style.cssText = "position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: rgba(15, 18, 24, .45); font: 15px system-ui, sans-serif;";
    const box = document.createElement("div");
    box.style.cssText = "background: #fff; color: #1d2230; padding: 16px 22px; border-radius: 10px; box-shadow: 0 8px 30px rgba(0, 0, 0, .25);";
    el.appendChild(box);
    document.body.appendChild(el);
  }
  /** @type {HTMLElement} */ (el.firstChild).textContent = text;
}

if (!document.documentElement.lang) document.documentElement.lang = "en";
if (!document.head.querySelector("meta[name=viewport]")) {
  const meta = document.createElement("meta");
  meta.name = "viewport";
  meta.content = "width=device-width, initial-scale=1";
  document.head.appendChild(meta);
}
document.title = "Network map";
injectStyles();
const root = document.createElement("div");
root.id = "nm-root";
document.body.appendChild(root);

const carried = readCarried();
const color = carried.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)];
writeCarried({ color, reloads: carried.reloads });
const viewer = { clientId: randomClientId(), name: accountName() ?? "Guest", color };

/** @param {boolean} counted counts towards the auto-reload budget */
const reloadFrame = (counted) => {
  const now = Date.now();
  const recent = readCarried().reloads.filter((t) => now - t < AUTO_RELOAD_WINDOW_MS);
  writeCarried({ color, reloads: counted ? [...recent, now] : recent });
  showOverlay("Reconnecting…");
  setTimeout(() => location.reload(), 300);
};

const recentReloads = () => readCarried().reloads.filter((t) => Date.now() - t < AUTO_RELOAD_WINDOW_MS).length;

const store = createStore({
  gadget: platformGadget, RpcTarget: platformRpcTarget, viewer,
  onReloadRequest: () => {
    if (recentReloads() >= MAX_AUTO_RELOADS) return false;
    reloadFrame(true);
    return true;
  },
});

/** @type {{screen: ReturnType<typeof showRecoveryScreen>, since: number, timer: any}|null} */
let recovery = null;
store.subscribe((change) => {
  if (change.type !== "status") return;
  const s = store.status;
  if (recovery && (s.connection === "live" || s.connection === "saving")) {
    clearTimeout(recovery.timer);
    recovery.screen.close();
    recovery = null;
    return;
  }
  if (recovery) {
    recovery.screen.update(/** @type {any} */ (s));
    if (!s.pendingCount) reloadFrame(true);
    return;
  }
  if (s.connection !== "recovery-required") return;
  const action = recoveryAction({ pendingCount: s.pendingCount, heldForMs: 0, recentReloads: recentReloads(), maxReloads: MAX_AUTO_RELOADS });
  if (action === "reload") { reloadFrame(true); return; }
  if (action === "stop") { showOverlay("The map lost its connection. Reload the page.", false); return; }
  const screen = showRecoveryScreen({
    getState: () => /** @type {any} */ (store.status),
    getData: () => /** @type {any} */ (store.getRecoveryData()),
    onReload: () => reloadFrame(false),
    autoReloadMinutes: Math.round(TERMINAL_RECOVERY_MS / 60_000),
  });
  recovery = { screen, since: Date.now(), timer: setTimeout(() => reloadFrame(true), TERMINAL_RECOVERY_MS) };
});

if (!platformGadget) {
  root.textContent = "This page runs inside a Cloudflare OS gadget.";
} else {
  const app = mountApp(root, store);
  store.start();
  /** @type {any} */ (globalThis).networkMap = { store, app };
}
