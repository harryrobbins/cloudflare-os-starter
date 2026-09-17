// @ts-check
// Client entry point. Runs inside the gadget's sandboxed iframe, which has no HTML of its own:
// everything is built here. Provided by the platform: `gadget` (RPC stub to the Gadget Durable
// Object), `gadgetViewer` (the signed-in user; our fork's patch) and `RpcTarget`, declared as
// module-scope bindings in a prefix the platform prepends to this file (NOT properties of
// globalThis), and during HTML/PDF export `gadgetExportFormatId` (a global). All are read as free identifiers behind `typeof` guards.
//
// Every change is attributed to the signed-in account's display name (gadgetViewer); nobody is
// asked for a name. window.name carries the viewer across reloads of this frame: colour, the name
// (only a fallback for hosts without gadgetViewer), participantId, the
// since marker, recent self-reload timestamps and, before any reload of the frame (a self-reload or
// a manual one), the open editor's unacknowledged edits: its text (bounded to 16 KiB, shown if it
// cannot be restored) and the Yjs update of the edits the server never acknowledged, which
// "Re-insert unsaved text" re-applies (restoreUpdate in sync/text.js explains why the update and
// not the text: only the unsent part comes back, once, in its place among others' edits).

import { createStore } from "./sync/store.js";
import { restoreUpdate } from "./sync/text.js";
import { mountApp, injectStyles } from "./ui/app.js";
import { renderExport, createExportStore } from "./ui/export.js";
import { showToast, textDialog } from "./ui/dialogs.js";
import { PALETTE, encodeCarry, decodeCarry } from "./ui/dom.js";
import { DEFAULT_NAME } from "../shared/protocol.js";

/* global gadget, gadgetViewer, RpcTarget, gadgetExportFormatId */
// @ts-ignore provided by the platform prefix
const platformGadget = typeof gadget !== "undefined" ? gadget : undefined;
// @ts-ignore provided by the platform prefix
const platformRpcTarget = typeof RpcTarget !== "undefined" ? RpcTarget : undefined;
// @ts-ignore provided by the platform prefix: {id, displayName, role} of the signed-in user
const platformViewer = typeof gadgetViewer !== "undefined" ? gadgetViewer : undefined;
// @ts-ignore provided by the platform in export mode
const exportFormatId = typeof gadgetExportFormatId !== "undefined" ? gadgetExportFormatId : undefined;

const MAX_AUTO_RELOADS = 3;
const AUTO_RELOAD_WINDOW_MS = 60_000;

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
  let overlay = document.getElementById("wave-connection-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "wave-connection-overlay";
    overlay.setAttribute("role", busy ? "status" : "alert");
    overlay.style.cssText = "position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; " +
      "justify-content: center; background: rgba(15, 18, 24, .45); font: 15px system-ui, sans-serif;";
    const box = document.createElement("div");
    box.className = "overlay-message";
    box.style.cssText = "background: #fff; color: #1d2230; padding: 16px 22px; border-radius: 10px; " +
      "box-shadow: 0 8px 30px rgba(0, 0, 0, .25);";
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }
  overlay.dataset.state = busy ? "reloading" : "failed";
  /** @type {HTMLElement} */ (overlay.firstChild).textContent = text;
}

function rootElement() {
  let root = document.getElementById("wave-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "wave-root";
    document.body.appendChild(root);
  }
  return root;
}

/** @param {number} bytes */
function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
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
  // Export mode: the platform captures the page once top-level await settles (plus 250 ms), so
  // the whole read view is rendered before this module's top-level await resolves.
  const exportStore = await createExportStore(platformGadget);
  await renderExport(rootElement(), exportStore);
} else {
  injectStyles();
  const root = rootElement();
  const carried = decodeCarry(window.name);
  const viewer = {
    clientId: randomHex(8),
    participantId: carried.participantId ?? randomHex(6),
    // Set before the store exists, so no change is ever sent without the account's name.
    name: accountName() ?? carried.name ?? DEFAULT_NAME,
    color: carried.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)],
  };
  /** @type {import("./store-contract.js").Store|undefined} */
  let store;
  /** @type {import("./ui/app.js").App|undefined} */
  let app;
  /** What to carry across a reload of this frame. @param {{pending?: boolean}} [opts] */
  const carry = ({ pending = false } = {}) => {
    const current = store?.getState().viewer ?? viewer;
    const editing = pending && app?.editingBlipId ? app.editingBlipId : null;
    const text = editing && store ? store.pendingText(editing) : null;
    const update = editing && text && store ? store.pendingUpdate(editing) : null;
    const previous = decodeCarry(window.name);
    return {
      name: current.name || null,
      color: current.color,
      participantId: current.participantId,
      sinceSeq: app?.sinceSeq ?? null,
      reloads: previous.reloads,
      // The pagehide of a self-reload runs after onUnrecoverable wrote the unsaved text: keep it
      // (the text is cleared from window.name once offered, so a later manual reload has none).
      pending: editing && text ? { blipId: editing, text, update } : previous.pending ?? null,
    };
  };
  const onUnrecoverable = () => {
    // The platform never replaces this frame's `gadget` stub after a facet restart; a reload of
    // the frame gets a fresh one. The open editor's unsent text rides along in window.name.
    const now = Date.now();
    const data = carry({ pending: true });
    const recent = data.reloads.filter((t) => now - t < AUTO_RELOAD_WINDOW_MS);
    if (recent.length >= MAX_AUTO_RELOADS) {
      try { window.name = encodeCarry({ ...data, reloads: recent }); } catch { /* ignore */ }
      showOverlay("The Wave lost its connection. Reload the page.", false);
      return;
    }
    try { window.name = encodeCarry({ ...data, reloads: [...recent, now] }); } catch { /* ignore */ }
    showOverlay("Reloading to reconnect…");
    setTimeout(() => location.reload(), 300);
  };
  try {
    store = await createStore({ gadget: platformGadget, RpcTarget: platformRpcTarget, viewer, onUnrecoverable });
  } catch (err) {
    const message = document.createElement("p");
    message.style.cssText = "padding: 24px; font: 14px system-ui, sans-serif;";
    message.textContent = "The Wave could not be loaded: " + (/** @type {any} */ (err)?.message ?? err);
    root.replaceChildren(message);
    throw err;
  }
  const liveStore = store;
  // Colour, name (fallback only), participant id, the since marker and the open editor's unsaved
  // text survive a reload of this frame, a manual one too (plan T4: "Alice reloads mid-typing;
  // pending text is offered back"), not only the self-reload above. Registered before mountApp:
  // the app's own pagehide listener disposes the store, after which the pending text is gone.
  window.addEventListener("pagehide", () => {
    try { window.name = encodeCarry(carry({ pending: true })); } catch { /* ignore */ }
  });
  const mounted = mountApp(root, liveStore, { sinceSeq: carried.sinceSeq });
  app = mounted.app;
  const { conversation } = mounted;
  if (!document.activeElement || document.activeElement === document.body) {
    /** @type {HTMLElement|null} */ (conversation.element)?.focus?.({ preventScroll: true });
  }
  liveStore.subscribe((state, change) => {
    if (change.kind === "connection" && state.connection === "live") {
      document.getElementById("wave-connection-overlay")?.remove();
    }
  });

  // Unsaved text from before a self-reload: offer it back rather than dropping it.
  if (carried.pending) {
    const { blipId, text, update } = carried.pending;
    try { window.name = encodeCarry({ ...carried, pending: null }); } catch { /* ignore */ }
    const reinsert = async () => {
      const blip = liveStore.getState().blips[blipId];
      if (!blip || blip.deleted || blip.locked) {
        await textDialog("Unsaved text", text, { note: "The blip it belonged to is no longer editable. The text is selected so you can copy it somewhere else." });
        return;
      }
      /** @type {ReturnType<typeof restoreUpdate>|"no_update"} */
      let outcome = "no_update";
      try {
        const handle = await liveStore.openBlip(blipId);
        // Only the edits the server never acknowledged are re-applied (a Yjs update is idempotent:
        // whatever did arrive is not added twice). Appending the editor's text would repeat it.
        if (update) outcome = restoreUpdate(handle.doc, update);
        handle.close();
      } catch (err) {
        await textDialog("Unsaved text", text, { note: "It could not be re-inserted: " + (/** @type {any} */ (err)?.message ?? err) + ". The text is selected so you can copy it." });
        return;
      }
      if (outcome === "applied" || outcome === "unchanged") {
        conversation.openEditor(blipId);
        conversation.focusBlip(blipId, { scroll: true, highlight: true });
        app?.announce(outcome === "applied" ? "Unsaved text re-inserted" : "That text had already been saved");
        return;
      }
      await textDialog("Unsaved text", text, {
        note: "It could not be merged back into the blip automatically. This is the whole text as it was in your editor; the text is selected so you can copy the part that is missing.",
      });
    };
    showToast("The Wave reloaded. Text you were typing was not saved yet.", {
      timeout: 0, action: { label: "Re-insert unsaved text", className: "reinsert-btn", onClick: () => { void reinsert(); } },
    });
  }

  /** @type {any} */ (globalThis).waveStore = store;
  /** @type {any} */ (globalThis).waveApp = app;
}
