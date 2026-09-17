// @ts-check
// The platform's HTML/PDF export: a read view of the whole Wave, threads expanded, no controls,
// no presence, with print CSS. It renders the conversation in exportMode through the same code as
// the live view, over a read-only store facade (createExportStore) that never subscribes, so an
// export capture never shows up as a presence "join" to the people in the Wave.

import * as Y from "yjs";
import { DEFAULT_TITLE, DEFAULT_COLOR, decodeBytes } from "../../shared/protocol.js";
import { createConversation } from "./conversation.js";
import { injectStyles } from "./styles.js";
import { el } from "./dom.js";

/** @typedef {import("../store-contract.js").Store} Store */
/** @typedef {import("../store-contract.js").ClientState} ClientState */
/** @typedef {import("../store-contract.js").TextHandle} TextHandle */

/** Blips opened at once while warming the export (about 45 RPC/s on the platform). */
const OPEN_BATCH = 8;

/**
 * A read-only Store over the gadget's reads (getWave, openBlip): getState, a no-op subscribe,
 * openBlip returning a shared Y.Doc per blip; every write rejects. Enough for the conversation in
 * exportMode and nothing else.
 * @param {any} gadget
 * @returns {Promise<Store>}
 */
export async function createExportStore(gadget) {
  const wave = await gadget.getWave();
  /** @type {ClientState} */
  const state = {
    meta: wave.meta,
    blips: wave.blips ?? {},
    runs: Object.fromEntries((wave.runs ?? []).map((/** @type {any} */ r) => [r.id, r])),
    seq: wave.seq ?? wave.meta?.seq ?? 0,
    capabilities: wave.capabilities ?? { model: false },
    viewer: { clientId: "export", participantId: "export", name: "", color: DEFAULT_COLOR },
    peers: new Map(),
    connection: "live",
    pending: 0,
    text: {},
    saving: "saved",
    lastError: null,
  };
  /** @type {Map<string, Promise<{doc: Y.Doc, text: Y.Text}>>} */
  const docs = new Map();
  const refuse = () => Promise.reject(new Error("read-only export view"));
  const noop = () => {};
  return /** @type {Store} */ (/** @type {unknown} */ ({
    getState: () => state,
    subscribe: () => noop,
    createBlip: () => { throw new Error("read-only export view"); },
    deleteBlip: noop, restoreBlip: noop, setTitle: noop,
    applyTemplate: refuse,
    async openBlip(id) {
      const blip = state.blips[id];
      if (!blip) return Promise.reject({ error: "unknown_blip", message: "unknown blip" });
      let pending = docs.get(id);
      if (!pending) {
        pending = (async () => {
          const doc = new Y.Doc();
          const result = await gadget.openBlip({ blipId: id });
          if (result && !("error" in result) && result.update) {
            const bytes = decodeBytes(result.update);
            if (bytes) Y.applyUpdateV2(doc, bytes);
          }
          return { doc, text: doc.getText("t") };
        })();
        docs.set(id, pending);
      }
      const { doc, text } = await pending;
      /** @type {TextHandle} */
      const handle = { doc, text, blipId: id, whenSaved: () => Promise.resolve(), close: noop };
      return handle;
    },
    flushText: () => Promise.resolve(),
    pendingText: () => null,
    pendingUpdate: () => null,
    askAgent: refuse, cancelRun: refuse, retryRun: refuse, reviewProposal: refuse, recordDecision: refuse, reply: refuse,
    getChanges: (afterSeq, limit) => gadget.getChanges({ afterSeq, limit }),
    getPlayback: (blipId, fromSeq, toSeq) => gadget.getPlayback({ blipId, fromSeq, toSeq }),
    exportMarkdown: (args) => gadget.exportMarkdown(args ?? {}),
    getWaveMarkdown: (args) => gadget.getWaveMarkdown(args ?? {}),
    setPresence: noop, flushPresence: noop, setViewer: noop, dispose: noop,
  }));
}

const EXPORT_CSS = String.raw`
html, body { margin: 0; height: auto; background: #ffffff; color-scheme: light; }
body.export-mode { overflow: auto; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; }
.wave-export { max-width: 820px; margin: 0 auto; padding: 24px 16px 48px; }
.wave-export h1.export-title { margin: 0 0 4px; font-size: 24px; }
.wave-export .export-meta { margin: 0 0 20px; color: #555; font-size: 13px; }
.wave-export .wave-blip { break-inside: avoid; }
.wave-export .blip-actions, .wave-export .reply-btn, .wave-export .edit-btn, .wave-export .para-reply-btn,
.wave-export .record-decision-btn, .wave-export .proposal-accept, .wave-export .proposal-reject, .wave-export .agent-discard,
.wave-export .editing-chip, .wave-export .remote-caret { display: none !important; }
@media print {
  .wave-export { max-width: none; padding: 0; }
  a { color: inherit; text-decoration: underline; }
}
`;

/**
 * @param {HTMLElement} root
 * @param {Store} store  a live store, or createExportStore(gadget)
 */
export async function renderExport(root, store) {
  injectStyles();
  const style = document.createElement("style");
  style.textContent = EXPORT_CSS;
  document.head.appendChild(style);
  document.body.classList.add("export-mode");
  const state = store.getState();
  const title = state.meta.title || DEFAULT_TITLE;
  document.title = title;

  // Warm every live blip's text so the conversation renders complete cards synchronously.
  const ids = Object.values(state.blips).filter((b) => b && !b.deleted).map((b) => b.id);
  for (let i = 0; i < ids.length; i += OPEN_BATCH) {
    await Promise.all(ids.slice(i, i + OPEN_BATCH).map((id) => store.openBlip(id).catch(() => null)));
  }

  /** @type {import("./ui-contract.js").Shell} */
  const shell = {
    announce: () => {},
    openDialog: () => Promise.resolve(null),
    askAgent: () => {},
    recordDecision: () => {},
    openPanel: () => {},
    isHistoryMode: () => false,
  };
  const conversation = createConversation(store, shell, { exportMode: true });
  const decisions = Object.values(state.blips).filter((b) => b && !b.deleted && b.kind === "decision").length;
  const threads = state.meta.rootOrder.filter((id) => state.blips[id] && !state.blips[id].deleted).length;
  const main = el("main", { class: "wave-export" },
    el("h1", { class: "export-title" }, title),
    el("p", { class: "export-meta" },
      `Exported ${new Date().toLocaleString()} · ${threads} ${threads === 1 ? "thread" : "threads"} · ${decisions} ${decisions === 1 ? "decision" : "decisions"} · version ${state.seq}`),
    ids.length ? conversation.element : el("p", { class: "muted" }, "This Wave is empty."),
  );
  root.replaceChildren(main);
  // Let the conversation's own async text loads and the browser's layout settle before the
  // capture (rAF does not run in a hidden page, so a timeout bounds the wait).
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => { requestAnimationFrame(() => resolve(undefined)); setTimeout(resolve, 60); });
  }
}
