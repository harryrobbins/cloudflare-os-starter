// @ts-check
// Binds a plain <textarea> to a blip's Y.Text (a TextHandle from the store).
//
//   Local edits   on `input`, the previous value is diffed against textarea.value by common prefix
//                 and suffix (surrogate pairs never split; when both sides changed the result is
//                 one delete and one insert) and applied in one doc.transact(fn, origin).
//   Remote edits  any transaction with another origin (a peer's update, the UndoManager) sets the
//                 value from the Y.Text and restores the selection through relative positions
//                 captured before the change. During IME composition they queue and apply on
//                 compositionend.
//   Undo          one Y.UndoManager per binding (trackedOrigins {origin}, captureTimeout 500),
//                 driven by a capture-phase keydown for Ctrl/Cmd+Z, Shift+Z and Y so the
//                 browser's native undo never touches the textarea.
//   Presence      onSelectionChange(anchorBase64, headBase64) with the selection as relative
//                 positions, at most once per animation frame (or 33 ms without one).
//
// No innerHTML, no clipboard API: paste is the textarea's own, seen as an `input`.

import * as Y from "yjs";
import { encodeBytes } from "../../shared/protocol.js";

/** @typedef {import("../store-contract.js").TextHandle} TextHandle */

export const DEFAULT_ORIGIN = "local";
export const UNDO_CAPTURE_MS = 500;
export const SELECTION_THROTTLE_MS = 33;

/**
 * The smallest edit turning `prev` into `next`: one deletion at `index` of `removed` characters
 * and one insertion of `inserted` there. Common prefix and suffix are left alone; a boundary
 * inside a surrogate pair is moved out so the edit never splits a character.
 * @param {string} prev
 * @param {string} next
 * @returns {{index: number, removed: number, inserted: string}}
 */
export function diffStrings(prev, next) {
  if (prev === next) return { index: 0, removed: 0, inserted: "" };
  const max = Math.min(prev.length, next.length);
  let prefix = 0;
  while (prefix < max && prev.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++;
  // Do not end the prefix between a high and a low surrogate.
  if (prefix > 0 && prefix < max && isHigh(prev.charCodeAt(prefix - 1))) prefix--;
  let suffix = 0;
  const room = max - prefix; // the guard for both sides changed: the suffix never eats the prefix
  while (suffix < room && prev.charCodeAt(prev.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)) suffix++;
  if (suffix > 0 && suffix < room && isLow(prev.charCodeAt(prev.length - suffix))) suffix--;
  return {
    index: prefix,
    removed: prev.length - prefix - suffix,
    inserted: next.slice(prefix, next.length - suffix),
  };
}

/** @param {number} code */
function isHigh(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/** @param {number} code */
function isLow(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Relative position (base64) of a code-unit index in the text.
 * @param {Y.Text} text
 * @param {number} index
 */
export function relativeAt(text, index) {
  const clamped = Math.max(0, Math.min(index, text.length));
  return encodeBytes(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, clamped)));
}

/**
 * @param {any} textarea  a <textarea> (or a fake with value, selectionStart, selectionEnd,
 *   addEventListener, removeEventListener, setSelectionRange)
 * @param {TextHandle} handle
 * @param {{origin?: unknown, timers?: {setTimeout: Function, clearTimeout: Function},
 *   onSelectionChange?: (anchor: string, head: string) => void,
 *   requestAnimationFrame?: ((fn: () => void) => any)|null}} [options]
 */
export function bindTextarea(textarea, handle, options = {}) {
  const { doc, text } = handle;
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const timers = options.timers ?? { setTimeout: (/** @type {any} */ fn, /** @type {number} */ ms) => globalThis.setTimeout(fn, ms), clearTimeout: (/** @type {any} */ id) => globalThis.clearTimeout(id) };
  const raf = options.requestAnimationFrame === undefined
    ? (typeof globalThis.requestAnimationFrame === "function" ? globalThis.requestAnimationFrame.bind(globalThis) : null)
    : options.requestAnimationFrame;

  let previous = text.toString();
  /** The key the text is shared under, to find the same type in a clone of the doc. */
  const textName = [...doc.share].find(([, type]) => type === text)?.[0] ?? "t";
  let composing = false;
  let remoteQueued = false;
  /**
   * The doc as `previous` described it, cloned when the first remote change lands during a
   * composition. The composed diff is computed against `previous`, so its indices are mapped
   * through relative positions taken in this clone (item ids are shared with the live doc).
   * @type {Y.Doc|null}
   */
  let composeBase = null;
  let destroyed = false;
  /** @type {{anchor: Y.RelativePosition, head: Y.RelativePosition}|null} */
  let captured = null;
  /** @type {string|null} */
  let lastSelection = null;
  let selectionScheduled = false;

  textarea.value = previous;

  const undoManager = new Y.UndoManager(text, { trackedOrigins: new Set([origin]), captureTimeout: UNDO_CAPTURE_MS });

  /** Applies whatever the textarea holds now as one transaction. */
  function applyLocal() {
    if (destroyed) return;
    const value = String(textarea.value ?? "");
    if (value === previous) return;
    const { index, removed, inserted } = diffStrings(previous, value);
    previous = value;
    if (composeBase) {
      // Only on flush or destroy mid-composition: the editor is closing, so no caret to keep.
      applyMapped(composeBase, index, removed, inserted);
      composeBase.destroy();
      composeBase = null;
      previous = text.toString();
      return;
    }
    doc.transact(() => {
      if (removed) text.delete(index, removed);
      if (inserted) text.insert(index, inserted);
    }, origin);
    scheduleSelection();
  }

  /**
   * Applies a diff computed against `base` (the doc as `previous` described it) to the live doc,
   * which remote changes have moved on from, and returns a function mapping an index in the edited
   * value to the live text. Ranges are located by relative positions, so they land on the same text.
   * @param {Y.Doc} base @param {number} index @param {number} removed @param {string} inserted
   * @returns {(i: number) => number}
   */
  function applyMapped(base, index, removed, inserted) {
    const baseText = base.get(textName, Y.Text);
    /** An index in `base`'s text to the live text. @param {number} i @param {number} assoc */
    const locate = (i, assoc) => {
      const rel = Y.createRelativePositionFromTypeIndex(baseText, Math.min(i, baseText.length), assoc);
      const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
      return abs && abs.type === text ? abs.index : Math.min(i, text.length);
    };
    const start = locate(index, 0);
    const end = removed ? Math.max(start, locate(index + removed, -1)) : start;
    doc.transact(() => {
      if (end > start) text.delete(start, end - start);
      if (inserted) text.insert(start, inserted);
    }, origin);
    // Resolved after the edit, so positions outside it already account for the local change.
    return (i) => {
      if (i < index) return locate(i, 0);
      if (i <= index + inserted.length) return start + (i - index);
      return locate(i - inserted.length + removed, 0);
    };
  }

  function onInput() {
    if (composing) return;
    applyLocal();
  }

  function onCompositionStart() {
    composing = true;
  }

  function onCompositionEnd() {
    composing = false;
    if (!composeBase) {
      applyLocal();
      if (remoteQueued) {
        remoteQueued = false;
        setValueFromDoc();
      }
      return;
    }
    // Remote changes arrived mid-composition: map the composed edit and the caret onto them.
    const base = composeBase;
    composeBase = null;
    const value = String(textarea.value ?? "");
    const caret = Math.min(textarea.selectionEnd ?? value.length, value.length);
    const { index, removed, inserted } = diffStrings(previous, value);
    const map = applyMapped(base, index, removed, inserted);
    const at = map(caret);
    base.destroy();
    remoteQueued = false;
    captured = null;
    previous = text.toString();
    textarea.value = previous;
    const clamped = Math.max(0, Math.min(at, previous.length));
    try { textarea.setSelectionRange(clamped, clamped); } catch { /* detached */ }
    scheduleSelection();
  }

  /** Sets the textarea from the doc, keeping the selection where the text it was on went. */
  function setValueFromDoc() {
    if (destroyed) return;
    const value = text.toString();
    if (composing) {
      remoteQueued = true;
      return;
    }
    let start = textarea.selectionStart ?? value.length;
    let end = textarea.selectionEnd ?? value.length;
    if (captured) {
      const a = Y.createAbsolutePositionFromRelativePosition(captured.anchor, doc);
      const h = Y.createAbsolutePositionFromRelativePosition(captured.head, doc);
      if (a && a.type === text) start = a.index;
      if (h && h.type === text) end = h.index;
      captured = null;
    }
    if (value !== previous) {
      previous = value;
      textarea.value = value;
    }
    start = Math.max(0, Math.min(start, value.length));
    end = Math.max(0, Math.min(end, value.length));
    try {
      textarea.setSelectionRange(Math.min(start, end), Math.max(start, end));
    } catch {
      // detached or unsupported: nothing to restore
    }
    scheduleSelection();
  }

  /** @param {Y.Transaction} txn */
  function beforeTransaction(txn) {
    if (txn.origin === origin || destroyed) return;
    if (composing && !composeBase) {
      // The live text still equals `previous` here: nothing remote has been applied since.
      composeBase = new Y.Doc({ gc: false });
      Y.applyUpdateV2(composeBase, Y.encodeStateAsUpdateV2(doc));
    }
    // Remember where the selection is relative to the text, before the text moves under it.
    // The end (and a collapsed caret) sticks to the character before it (assoc -1): text a peer
    // inserts exactly at the caret lands after it, so the caret stays after what this person just
    // typed instead of jumping past the peer's text (which would split the word being typed). The
    // start of a range sticks to the character after it, so the range never grows over new text.
    const start = Math.min(textarea.selectionStart ?? 0, text.length);
    const end = Math.min(textarea.selectionEnd ?? 0, text.length);
    captured = {
      anchor: Y.createRelativePositionFromTypeIndex(text, start, start === end ? -1 : 0),
      head: Y.createRelativePositionFromTypeIndex(text, end, -1),
    };
  }

  /** @param {Y.YTextEvent} _event @param {Y.Transaction} txn */
  function observe(_event, txn) {
    if (txn.origin === origin) {
      captured = null;
      return;
    }
    setValueFromDoc();
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
    if (key === "z") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) redo();
      else undo();
    } else if (key === "y") {
      event.preventDefault();
      event.stopPropagation();
      redo();
    }
  }

  function undo() {
    if (destroyed) return;
    // An edit the input event has not reported yet is part of history, but not a composition in progress.
    if (!composing) applyLocal();
    undoManager.stopCapturing();
    undoManager.undo();
  }

  function redo() {
    if (destroyed) return;
    undoManager.redo();
  }

  function scheduleSelection() {
    if (!options.onSelectionChange || selectionScheduled || destroyed) return;
    selectionScheduled = true;
    const run = () => {
      selectionScheduled = false;
      reportSelection();
    };
    if (raf) raf(run);
    else timers.setTimeout(run, SELECTION_THROTTLE_MS);
  }

  function reportSelection() {
    if (destroyed || !options.onSelectionChange) return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    // The textarea reports start <= end; `selectionDirection` says which is the anchor.
    const backward = textarea.selectionDirection === "backward";
    const anchor = relativeAt(text, backward ? end : start);
    const head = relativeAt(text, backward ? start : end);
    const key = anchor + "|" + head;
    if (key === lastSelection) return;
    lastSelection = key;
    options.onSelectionChange(anchor, head);
  }

  const onSelect = () => scheduleSelection();
  const listeners = [
    ["input", onInput, false],
    ["compositionstart", onCompositionStart, false],
    ["compositionend", onCompositionEnd, false],
    ["keydown", onKeydown, true],
    ["keyup", onSelect, false],
    ["mouseup", onSelect, false],
    ["touchend", onSelect, false],
    ["select", onSelect, false],
    ["focus", onSelect, false],
  ];
  for (const [type, fn, capture] of listeners) textarea.addEventListener(type, fn, capture);
  const ownerDocument = textarea.ownerDocument;
  if (ownerDocument?.addEventListener) ownerDocument.addEventListener("selectionchange", onSelect);

  doc.on("beforeTransaction", beforeTransaction);
  text.observe(observe);
  scheduleSelection();

  return {
    undo,
    redo,
    canUndo: () => undoManager.canUndo(),
    canRedo: () => undoManager.canRedo(),
    setValueFromDoc,
    applyRemote: setValueFromDoc,
    /** Applies a pending local edit now (before closing the editor). */
    flush: applyLocal,
    destroy() {
      if (destroyed) return;
      applyLocal();
      destroyed = true;
      for (const [type, fn, capture] of listeners) textarea.removeEventListener?.(type, fn, capture);
      if (ownerDocument?.removeEventListener) ownerDocument.removeEventListener("selectionchange", onSelect);
      doc.off("beforeTransaction", beforeTransaction);
      text.unobserve(observe);
      undoManager.destroy();
    },
  };
}
