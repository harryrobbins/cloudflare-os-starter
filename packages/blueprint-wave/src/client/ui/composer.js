// @ts-check
// The editor (stream C1): a textarea over a blip's Y.Text, used both for edit mode on an existing
// blip and as the reply composer. A composer is an editor whose blip does not exist yet: the blip
// is created on the first keystroke (store.createBlip, then openBlip), so others see the reply as
// it is written; an editor closed on an empty blip deletes it. Binding to the Y.Text and remote
// carets come from src/client/editor (stream B); presence is published through the store.

import * as Y from "yjs";
import { encodeBytes } from "../../shared/protocol.js";
import { bindTextarea } from "../editor/binding.js";
import { createCaretLayer } from "../editor/carets.js";
import { button, el } from "./render.js";

/** @typedef {import("../store-contract.js").Store} Store */
/** @typedef {import("../store-contract.js").TextHandle} TextHandle */
/** @typedef {import("../store-contract.js").Peer} Peer */
/** @typedef {import("../../shared/protocol.js").Anchor} Anchor */

/** Transaction origin of this client's edits (the binding's undo manager tracks it). */
export const LOCAL_ORIGIN = "local-editor";

/**
 * @typedef {object} EditorOptions
 * @property {Store} store
 * @property {string|null} blipId        the blip to edit, or null for a composer
 * @property {string|null} [parentId]    composer: the parent
 * @property {Anchor} [anchor]           composer: where the reply goes (default end)
 * @property {string} [initialText]      text to show until the Y.Text is open (edit mode)
 * @property {string} [placeholder]
 * @property {string} [label]            aria-label of the textarea
 * @property {(result: {id: string|null, created: boolean, deleted: boolean}) => void} onClose
 * @property {(id: string) => void} [onCreated]   composer: the blip now exists
 * @property {(message: string) => void} [onError]
 * @property {any} [timers]              {setTimeout, clearTimeout, ...} for the binding
 */

/**
 * @typedef {object} Editor
 * @property {HTMLElement} element         wrapper: caret host, textarea, Done bar
 * @property {HTMLTextAreaElement} textarea
 * @property {() => string|null} id        the blip being edited (null until a composer's first keystroke)
 * @property {() => boolean} isOpen
 * @property {() => void} focus
 * @property {() => void} close            Done: unbind, clear presence, delete if empty, onClose
 * @property {() => void} undo
 * @property {() => void} redo
 * @property {(peers: Peer[]) => void} updateCarets   peers already filtered to this blip
 * @property {() => void} restoreFocus     after the element moved in the DOM
 */

/**
 * A relative position (base64) at `index` of `text`.
 * @param {Y.Text} text @param {number} index
 */
export function encodePosition(text, index) {
  const len = text.length;
  const i = Math.max(0, Math.min(len, index | 0));
  return encodeBytes(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, i)));
}

/**
 * @param {EditorOptions} opts
 * @returns {Editor}
 */
export function createEditor(opts) {
  const { store } = opts;
  const timers = opts.timers ?? { setTimeout: (/** @type {any} */ f, /** @type {number} */ ms) => setTimeout(f, ms), clearTimeout: (/** @type {any} */ t) => clearTimeout(t) };
  const composer = opts.blipId === null;
  /** @type {string|null} */
  let id = opts.blipId;
  /** @type {TextHandle|null} */
  let handle = null;
  /** @type {ReturnType<typeof bindTextarea>|null} */
  let binding = null;
  /** @type {{update(peers: Peer[]): void, destroy(): void}|null} */
  let carets = null;
  /** @type {Peer[]} */
  let lastPeers = [];
  let open = true;
  let created = false;
  let closing = false;
  let selection = { start: 0, end: 0 };

  const textarea = /** @type {HTMLTextAreaElement} */ (el("textarea", {
    class: "blip-editor", rows: "1", spellcheck: "true", "aria-label": opts.label ?? (composer ? "Reply" : "Edit text"),
    placeholder: opts.placeholder ?? (composer ? "Reply…" : ""), "data-composer": composer ? "1" : null,
  }));
  if (!composer) {
    textarea.value = opts.initialText ?? "";
    textarea.readOnly = true; // until the Y.Text is open and bound
    textarea.setAttribute("aria-busy", "true");
  }
  // The caret layer's host must contain the textarea (it positions a mirror over it) and be
  // position: relative (the shell's stylesheet).
  const caretHost = el("div", { class: "caret-host" }, textarea);
  const bar = el("div", { class: "editor-bar" },
    button("Done", () => close(), { class: "done-btn" }),
    el("span", { class: "editor-hint" }, "Ctrl+Enter to finish, Esc to cancel"));
  const element = el("div", { class: "editor" + (composer ? " editor-composer" : ""), "data-editing": id ?? "" }, caretHost, bar);

  textarea.addEventListener("input", () => {
    resize();
    if (composer && !created) createNow();
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
  textarea.addEventListener("blur", () => { store.flushPresence?.(); });
  // Selection changes reach publishSelection through the binding's onSelectionChange (throttled).

  function resize() {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }

  /** The composer's first keystroke: create the blip, then open and bind it. */
  function createNow() {
    created = true;
    try {
      id = store.createBlip({ parentId: opts.parentId ?? null, anchor: opts.anchor ?? { type: "end" } });
    } catch (err) {
      created = false;
      opts.onError?.(err instanceof Error ? err.message : String(err));
      return;
    }
    element.setAttribute("data-editing", id);
    opts.onCreated?.(id);
    void attach(id, true);
  }

  /**
   * Opens the Y.Text and binds the textarea. `seed`: the composer typed before the blip existed;
   * its text goes into the (empty) Y.Text first so the binding starts from a matching state.
   * @param {string} blipId @param {boolean} seed
   */
  async function attach(blipId, seed) {
    /** @type {TextHandle} */
    let h;
    try {
      h = await store.openBlip(blipId);
    } catch (err) {
      if (!open) return;
      opts.onError?.(errorMessage(err));
      close();
      return;
    }
    if (!open || id !== blipId) { h.close(); return; }
    handle = h;
    if (seed) {
      const typed = textarea.value;
      if (typed) h.doc.transact(() => { h.text.insert(h.text.length, typed); }, LOCAL_ORIGIN);
    } else {
      const remembered = { start: textarea.selectionStart, end: textarea.selectionEnd, focused: document.activeElement === textarea };
      textarea.value = h.text.toString();
      textarea.readOnly = false;
      textarea.removeAttribute("aria-busy");
      const len = textarea.value.length;
      if (remembered.focused) textarea.setSelectionRange(Math.min(remembered.start, len), Math.min(remembered.end, len));
    }
    binding = bindTextarea(textarea, h, {
      origin: LOCAL_ORIGIN, timers,
      onSelectionChange: (/** @type {any} */ a, /** @type {any} */ b) => publishSelection(a, b),
    });
    try {
      carets = createCaretLayer(textarea, caretHost, { doc: h.doc, text: h.text });
      carets.update(lastPeers);
    } catch {
      carets = null;
    }
    h.text.observe(onRemote);
    store.setPresence({ blipId, editing: true, anchor: encodePosition(h.text, textarea.selectionStart), head: encodePosition(h.text, textarea.selectionEnd) });
    resize();
  }

  function onRemote() {
    resize();
  }

  /**
   * Publishes the selection as relative positions. The binding passes (anchorBase64, headBase64);
   * indexes, an object, or nothing (then the textarea's own selection is read) also work.
   * @param {any} [a] @param {any} [b]
   */
  function publishSelection(a, b) {
    if (!open || !handle || !id) return;
    /** @type {string|null} */
    let anchor = null;
    /** @type {string|null} */
    let head = null;
    if (typeof a === "string") {
      anchor = a;
      head = typeof b === "string" ? b : a;
    } else if (a && typeof a === "object" && !(a instanceof Event)) {
      if (typeof a.anchor === "number") { anchor = encodePosition(handle.text, a.anchor); head = encodePosition(handle.text, typeof a.head === "number" ? a.head : a.anchor); }
      else if (typeof a.anchor === "string" || a.anchor === null) { anchor = a.anchor ?? null; head = typeof a.head === "string" ? a.head : anchor; }
      else if (typeof a.start === "number") { anchor = encodePosition(handle.text, a.start); head = encodePosition(handle.text, typeof a.end === "number" ? a.end : a.start); }
    } else if (typeof a === "number") {
      anchor = encodePosition(handle.text, a);
      head = encodePosition(handle.text, typeof b === "number" ? b : a);
    }
    if (anchor === null) {
      const start = textarea.selectionStart ?? 0;
      const end = textarea.selectionEnd ?? start;
      if (start === selection.start && end === selection.end && a === undefined) return;
      selection = { start, end };
      anchor = encodePosition(handle.text, start);
      head = encodePosition(handle.text, end);
    }
    store.setPresence({ blipId: id, editing: true, anchor, head });
  }

  function close() {
    if (!open || closing) return;
    closing = true;
    open = false;
    const blipId = id;
    let deleted = false;
    try {
      handle?.text.unobserve(onRemote);
      carets?.destroy();
      carets = null;
      binding?.destroy();
      binding = null;
      if (blipId) {
        const text = handle ? handle.text.toString() : textarea.value;
        // Clear presence in the same tick as the editor closes.
        store.setPresence({ blipId, editing: false, anchor: null, head: null });
        if (composer && text.trim() === "") {
          store.deleteBlip(blipId);
          deleted = true;
        }
      }
      handle?.close();
      handle = null;
    } finally {
      closing = false;
      opts.onClose({ id: blipId, created, deleted });
    }
  }

  function restoreFocus() {
    if (!open) return;
    const { selectionStart, selectionEnd } = textarea;
    textarea.focus({ preventScroll: true });
    try { textarea.setSelectionRange(selectionStart, selectionEnd); } catch { /* not focusable yet */ }
  }

  if (!composer && id) void attach(id, false);
  queueMicrotask(resize);

  return {
    element,
    textarea,
    id: () => id,
    isOpen: () => open,
    focus: () => { textarea.focus({ preventScroll: true }); },
    close,
    undo: () => { binding?.undo?.(); },
    redo: () => { binding?.redo?.(); },
    updateCarets: (peers) => { lastPeers = peers; carets?.update(peers); },
    restoreFocus,
  };
}

/** @param {unknown} err */
function errorMessage(err) {
  if (err && typeof err === "object" && "message" in err && typeof (/** @type {any} */ (err)).message === "string") return (/** @type {any} */ (err)).message;
  if (err && typeof err === "object" && "error" in err) return String((/** @type {any} */ (err)).error);
  return String(err);
}
