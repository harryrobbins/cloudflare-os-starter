// @ts-check
// Client entry point. Runs inside the gadget's sandboxed iframe, which has no HTML of its own:
// everything is built here. Globals provided by the platform: `gadget` (RPC stub to the Gadget
// Durable Object), `RpcTarget`, and during HTML/PDF export `gadgetExportFormatId`.

import { createStore } from "./sync/store.js";
import { mountApp, injectStyles } from "./ui/app.js";
import { renderExport } from "./ui/export.js";
import { nameDialog } from "./ui/dialogs.js";
import { PALETTE } from "./ui/dom.js";

const g = /** @type {any} */ (globalThis);

function rootElement() {
  let root = document.getElementById("kanban-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "kanban-root";
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

if (typeof g.gadgetExportFormatId !== "undefined") {
  // Export mode: the platform captures the page once top-level await settles.
  const board = await g.gadget.getBoard();
  renderExport(rootElement(), board);
} else {
  injectStyles();
  const root = rootElement();
  const viewer = {
    clientId: randomClientId(),
    name: "",
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
  };
  // Ask for a name while the board connects behind the dialog.
  const namePromise = nameDialog({ name: "", color: viewer.color });
  let store;
  try {
    store = await createStore({ gadget: g.gadget, RpcTarget: g.RpcTarget, viewer });
  } catch (err) {
    const message = document.createElement("p");
    message.style.cssText = "padding: 24px; font: 14px system-ui, sans-serif;";
    message.textContent = "The board could not be loaded: " + (/** @type {any} */ (err)?.message ?? err);
    root.replaceChildren(message);
    throw err;
  }
  mountApp(root, store);
  namePromise.then((result) => {
    store.setViewer(result?.name || "Guest", result?.color || viewer.color);
  });
  g.kanbanStore = store;
}
