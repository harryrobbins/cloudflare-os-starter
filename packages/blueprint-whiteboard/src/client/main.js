// @ts-check
// Client entry point. Runs inside the gadget's sandboxed iframe, which has no HTML of its own:
// everything is built here. Provided by the platform: `gadget` (RPC stub to the Gadget Durable
// Object) and `RpcTarget`, declared as module-scope bindings in a prefix the platform prepends to
// this file (NOT properties of globalThis), and during HTML/PDF export `gadgetExportFormatId`
// (a global). All are read as free identifiers behind `typeof` guards.

import { createStore } from "./sync/store.js";
import { mountApp, injectStyles } from "./ui/app.js";
import { renderExport } from "./ui/export.js";
import { nameDialog } from "./ui/dialogs.js";
import { PALETTE } from "./ui/dom.js";

/* global gadget, RpcTarget, gadgetExportFormatId */
// @ts-ignore provided by the platform prefix
const platformGadget = typeof gadget !== "undefined" ? gadget : undefined;
// @ts-ignore provided by the platform prefix
const platformRpcTarget = typeof RpcTarget !== "undefined" ? RpcTarget : undefined;
// @ts-ignore provided by the platform in export mode
const exportFormatId = typeof gadgetExportFormatId !== "undefined" ? gadgetExportFormatId : undefined;

/** window.name survives reloads of the same browsing context; used to carry the viewer across. */
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
      reloads: Array.isArray(data?.reloads) ? data.reloads.filter((t) => typeof t === "number") : [],
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
    name: carried.name ?? "",
    color: carried.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)],
  };
  // Ask for a name while the whiteboard connects behind the dialog, unless a reload carried it over.
  const namePromise = carried.name
    ? Promise.resolve({ name: carried.name, color: viewer.color })
    : nameDialog({ name: "", color: viewer.color });
  /** @type {import("./store-contract.js").Store|undefined} */
  let store;
  const onUnrecoverable = () => {
    // The platform never replaces this frame's `gadget` stub after a facet restart; a reload of
    // the frame gets a fresh one. Unsent local changes are lost with the dead connection.
    const now = Date.now();
    const recent = readCarried().reloads.filter((t) => now - t < AUTO_RELOAD_WINDOW_MS);
    const current = store?.getState().viewer ?? viewer;
    if (recent.length >= MAX_AUTO_RELOADS) {
      showOverlay("The whiteboard lost its connection. Reload the page.", false);
      return;
    }
    writeCarried({ name: current.name || null, color: current.color, reloads: [...recent, now] });
    showOverlay("Reconnecting…");
    setTimeout(() => location.reload(), 300);
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
  mountApp(root, store);
  const liveStore = store;
  liveStore.subscribe((state, change) => {
    if (change.kind === "connection" && state.connection === "live") {
      document.getElementById("wb-connection-overlay")?.remove();
    }
  });
  namePromise.then((result) => {
    liveStore.setViewer(result?.name || "Guest", result?.color || viewer.color);
  });
  /** @type {any} */ (globalThis).whiteboardStore = store;
}
