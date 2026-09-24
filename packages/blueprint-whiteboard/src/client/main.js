// @ts-check
// Client entry point. Runs inside the gadget's sandboxed iframe, which has no HTML of its own:
// everything is built here. Provided by the platform: `gadget` (RPC stub to the Gadget Durable
// Object), `gadgetViewer` (the signed-in user; our fork's patch) and `RpcTarget`, declared as
// module-scope bindings in a prefix the platform prepends to
// this file (NOT properties of globalThis), and during HTML/PDF export `gadgetExportFormatId`
// (a global). All are read as free identifiers behind `typeof` guards.

import { createStore } from "./sync/store.js";
import { mountApp, injectStyles } from "./ui/app.js";
import { renderExport } from "./ui/export.js";
import { PALETTE } from "./ui/dom.js";
import { showRecoveryScreen } from "./ui/recovery.js";
import { TERMINAL_RECOVERY_MS, recoveryAction } from "./sync/connection.js";

/* global gadget, gadgetViewer, RpcTarget, gadgetExportFormatId */
// @ts-ignore provided by the platform prefix
const platformGadget = typeof gadget !== "undefined" ? gadget : undefined;
// @ts-ignore provided by the platform prefix
const platformRpcTarget = typeof RpcTarget !== "undefined" ? RpcTarget : undefined;
// @ts-ignore provided by the platform prefix: {id, displayName, role} of the signed-in user
const platformViewer = typeof gadgetViewer !== "undefined" ? gadgetViewer : undefined;
// @ts-ignore provided by the platform in export mode
const exportFormatId = typeof gadgetExportFormatId !== "undefined" ? gadgetExportFormatId : undefined;

/**
 * window.name survives reloads of the same browsing context; used to carry the viewer's name and
 * colour and the auto-reload budget across. Never board content or the recovery payload.
 */
const WINDOW_NAME_PREFIX = "whiteboard:";
const MAX_AUTO_RELOADS = 3;
const AUTO_RELOAD_WINDOW_MS = 60_000;

/** @returns {{name: string|null, color: string|null, reloads: number[]}} */
function readCarried() {
  const empty = { name: null, color: null, reloads: [] };
  try {
    const raw = window.name;
    if (typeof raw !== "string" || !raw.startsWith(WINDOW_NAME_PREFIX)) return empty;
    const data = JSON.parse(raw.slice(WINDOW_NAME_PREFIX.length));
    return {
      name: typeof data?.name === "string" && data.name ? data.name : null,
      color: typeof data?.color === "string" && /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : null,
      reloads: Array.isArray(data?.reloads) ? data.reloads.filter((/** @type {unknown} */ t) => typeof t === "number") : [],
    };
  } catch {
    return empty;
  }
}

/** @param {{name: string|null, color: string|null, reloads: number[]}} data */
function writeCarried(data) {
  try {
    window.name = WINDOW_NAME_PREFIX + JSON.stringify(data);
  } catch { /* ignore */ }
}

/**
 * The signed-in account's display name. Every change is attributed to it; nobody is asked for a
 * name. Null when the host did not say who is viewing (an older platform).
 * @returns {string|null}
 */
function accountName() {
  const v = platformViewer;
  const name = typeof v?.displayName === "string" && v.displayName.trim() ? v.displayName : v?.id;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** @param {string} text @param {boolean} [busy] */
function showOverlay(text, busy = true) {
  let el = document.getElementById("wb-connection-overlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "wb-connection-overlay";
    el.setAttribute("role", busy ? "status" : "alert");
    el.style.cssText = "position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; " +
      "justify-content: center; background: rgba(15, 18, 24, .45); font: 15px system-ui, sans-serif;";
    const box = document.createElement("div");
    box.className = "overlay-message";
    box.style.cssText = "background: #fff; color: #1d2230; padding: 16px 22px; border-radius: 10px; " +
      "box-shadow: 0 8px 30px rgba(0, 0, 0, .25);";
    el.appendChild(box);
    document.body.appendChild(el);
  }
  el.dataset.state = busy ? "reloading" : "failed";
  /** @type {HTMLElement} */ (el.firstChild).textContent = text;
}

function rootElement() {
  let root = document.getElementById("wb-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "wb-root";
    document.body.appendChild(root);
  }
  return root;
}

function randomClientId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ensureDocument() {
  if (!document.documentElement.lang) document.documentElement.lang = "en";
  if (!document.head.querySelector("meta[name=viewport]")) {
    const meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = "width=device-width, initial-scale=1";
    document.head.appendChild(meta);
  }
}

ensureDocument();

if (exportFormatId !== undefined) {
  // Export mode: the platform captures the page once top-level await settles.
  // Rendering happens before top-level await settles, so the capture sees the finished board.
  const board = await platformGadget.getBoard();
  await renderExport(rootElement(), board);
} else {
  injectStyles();
  const root = rootElement();
  const carried = readCarried();
  const viewer = {
    clientId: randomClientId(),
    name: accountName() ?? carried.name ?? "Guest",
    color: carried.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)],
  };
  /** @type {import("./store-contract.js").Store|undefined} */
  let store;
  /**
   * The recovery screen while it shows: unacknowledged changes kept us from reloading.
   * @type {{screen: ReturnType<typeof showRecoveryScreen>, since: number, timer: any, unsubscribe: () => void}|null}
   */
  let recovery = null;

  const closeRecovery = () => {
    if (!recovery) return;
    clearTimeout(recovery.timer);
    recovery.unsubscribe();
    recovery.screen.close();
    recovery = null;
  };

  /** @param {boolean} counted  counts towards the auto-reload budget (false: the user chose it) */
  const reloadFrame = (counted) => {
    const now = Date.now();
    const recent = readCarried().reloads.filter((t) => now - t < AUTO_RELOAD_WINDOW_MS);
    const current = store?.getState().viewer ?? viewer;
    writeCarried({ name: current.name || null, color: current.color, reloads: counted ? [...recent, now] : recent });
    closeRecovery();
    showOverlay("Reconnecting…");
    setTimeout(() => location.reload(), 300);
  };

  // Interim, until the host can replace the RPC target (store.replaceTarget): the platform never
  // replaces this frame's `gadget` stub after a facet restart, and only a reload of the frame gets
  // a fresh one. A reload loses unacknowledged changes, so it happens on its own only when there
  // are none, or once the recovery screen has shown for TERMINAL_RECOVERY_MS.
  const onUnrecoverable = () => {
    const now = Date.now();
    const state = store?.getState();
    const action = recoveryAction({
      pendingCount: state?.pendingCount ?? 0,
      heldForMs: recovery ? now - recovery.since : 0,
      recentReloads: readCarried().reloads.filter((t) => now - t < AUTO_RELOAD_WINDOW_MS).length,
      maxReloads: MAX_AUTO_RELOADS,
    });
    if (action === "reload") {
      reloadFrame(true);
      return;
    }
    if (action === "stop") {
      // Out of auto-reloads: the user reloads. The recovery screen, if up, already says so and
      // keeps its download.
      if (!recovery) showOverlay("The whiteboard lost its connection. Reload the page.", false);
      return;
    }
    if (recovery || !store) return;
    const live = store;
    const screen = showRecoveryScreen({
      getState: () => live.getState(),
      getData: () => live.getRecoveryData(),
      onReload: () => reloadFrame(false),
      autoReloadMinutes: Math.round(TERMINAL_RECOVERY_MS / 60_000),
    });
    const unsubscribe = live.subscribe((s, change) => {
      if (!recovery) return;
      if (s.connection === "live" || s.connection === "saving") {
        closeRecovery(); // reconnected after all; the queue drains by itself
        return;
      }
      if (change.kind === "connection" || change.kind === "objects" || change.kind === "snapshot") screen.update(s);
      if (s.pendingCount === 0) onUnrecoverable(); // nothing left to lose: reload is safe now
    });
    recovery = { screen, since: now, unsubscribe, timer: setTimeout(onUnrecoverable, TERMINAL_RECOVERY_MS) };
  };
  try {
    store = await createStore({ gadget: platformGadget, RpcTarget: platformRpcTarget, viewer, onUnrecoverable });
  } catch (err) {
    const message = document.createElement("p");
    message.style.cssText = "padding: 24px; font: 14px system-ui, sans-serif;";
    message.textContent = "The whiteboard could not be loaded: " + (/** @type {any} */ (err)?.message ?? err);
    root.replaceChildren(message);
    throw err;
  }
  const { app } = mountApp(root, store);
  if (!document.activeElement || document.activeElement === document.body) {
    app.canvas.element.focus({ preventScroll: true });
  }
  const liveStore = store;
  liveStore.subscribe((state, change) => {
    if (change.kind === "connection" && (state.connection === "live" || state.connection === "saving")) {
      document.getElementById("wb-connection-overlay")?.remove();
    }
  });
  // A hidden tab clears its cursor and gesture ghosts once, then sends heartbeats only.
  const syncVisibility = () => liveStore.setVisibility(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", syncVisibility);
  syncVisibility();
  /** @type {any} */ (globalThis).whiteboardStore = store;
}
