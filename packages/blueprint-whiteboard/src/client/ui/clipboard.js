// @ts-check
// Copy, cut and paste of board objects, and plain text as sticky notes.
//
// The gadget iframe is sandboxed: the async Clipboard API (navigator.clipboard) is blocked, so
// this uses the DOM's own copy / cut / paste events (event.clipboardData), which the browser fires
// for Ctrl/⌘+C, X and V. What was copied is also kept in memory, so the menu's Paste works even
// though a page cannot read the system clipboard on its own. Clipboard content is only ever read
// as our JSON format or as plain text: HTML and SVG on the clipboard are never looked at.
//
// Copied objects travel as CLIPBOARD_MIME (src/shared/backup.js). On paste every id is new,
// references are remapped, untrusted fields are dropped, and the objects are created through the
// store (one undo step, the normal validation on the server) near the pointer or the view centre.

import { LIMITS, newId } from "../../shared/protocol.js";
import { center } from "../../shared/geometry.js";
import {
  BACKUP_FORMAT, BACKUP_LIMITS, CLIPBOARD_MIME, buildClipboard, offsetToCenter, parseBackup, planCreates,
  plainTextOf, textToEntries, codeFenceToEntry,
} from "../../shared/backup.js";
import { detectLanguage, languageLabel } from "../../shared/code/languages.js";
import { expandMoveIds, frameAtPoint, validIds } from "./canvas/model.js";

/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../../shared/backup.js").Entry} Entry */
/** @typedef {import("../../shared/backup.js").BackupDocument} BackupDocument */

/** Offset of each repeated paste of the same content at the same spot. */
export const PASTE_STEP = 20;

/**
 * Places entries on a board: centred on `at`, with new ids, at most `max` objects (and no more
 * than the board has room for). Objects that came without their frame join the frame their
 * centre lands in, as a moved object would. Pure.
 * @param {Entry[]} entries
 * @param {{objects: Record<string, WhiteboardObject>, at: {x: number, y: number}, max?: number, makeId?: () => string}} opts
 * @returns {{creates: Array<Record<string, any>>, ids: string[], dropped: number}}
 */
export function placeEntries(entries, { objects, at, max = BACKUP_LIMITS.pasteObjects, makeId = () => newId("object") }) {
  const room = Math.max(0, LIMITS.objects - Object.keys(objects).length);
  const { dx, dy } = offsetToCenter(entries, at);
  const { creates, dropped } = planCreates(entries, { newId: makeId, dx, dy, max: Math.min(max, room) });
  /** @type {Record<string, any>} */
  const world = { ...objects };
  for (const c of creates) if (c.type === "frame") world[c.id] = c;
  for (const c of creates) {
    if (c.type === "frame" || c.type === "connector" || c.frameId) continue;
    c.frameId = frameAtPoint(world, center(/** @type {any} */ (c)));
  }
  return { creates, ids: creates.map((c) => c.id), dropped };
}

/**
 * What a copy of `ids` puts on the clipboard: frames bring their members, connectors come along
 * when both ends do. Null when nothing is copyable.
 * @param {Record<string, WhiteboardObject>} objects @param {string[]} ids
 * @returns {{doc: BackupDocument, json: string, text: string}|null}
 */
export function clipboardPayload(objects, ids) {
  const chosen = new Set(validIds(objects, ids));
  for (const id of expandMoveIds(objects, chosen)) chosen.add(id);
  for (const o of Object.values(objects)) {
    if (o.type === "connector" && o.from && o.to && chosen.has(o.from) && chosen.has(o.to)) chosen.add(o.id);
  }
  const doc = buildClipboard([...chosen].map((id) => objects[id]), objects);
  if (!doc.objects.length) return null;
  const text = plainTextOf(doc.objects);
  return { doc, json: JSON.stringify(doc), text };
}

/**
 * Reads what a paste offers, in order of preference: our format (its own type, or JSON text in
 * our format), the in-memory copy when the text is exactly what we last copied, else plain text.
 * @param {{json?: string, text?: string}} data
 * @param {{doc: BackupDocument, text: string}|null} memory
 * A fenced Markdown code block (```lang ... ```) becomes one code block in that language.
 * @returns {{kind: "objects", entries: Entry[], skipped: number}|{kind: "text", entries: Entry[], truncated: number}|{kind: "code", entries: Entry[]}|{kind: "none"}|{kind: "error", message: string}}
 */
export function readPaste({ json, text }, memory) {
  if (json) {
    const parsed = parseBackup(json);
    if ("error" in parsed) return { kind: "error", message: parsed.error };
    return { kind: "objects", entries: parsed.entries, skipped: parsed.skipped };
  }
  if (memory && typeof text === "string" && text === memory.text && memory.text) {
    const parsed = parseBackup(memory.doc);
    if (!("error" in parsed)) return { kind: "objects", entries: parsed.entries, skipped: parsed.skipped };
  }
  if (typeof text === "string" && text.trimStart().startsWith("{") && text.includes(BACKUP_FORMAT)) {
    const parsed = parseBackup(text);
    if (!("error" in parsed)) return { kind: "objects", entries: parsed.entries, skipped: parsed.skipped };
  }
  if (typeof text === "string" && text.trim()) {
    const fence = codeFenceToEntry(text, detectLanguage);
    if (fence) return { kind: "code", entries: [fence] };
    const { entries, truncated } = textToEntries(text);
    if (entries.length) return { kind: "text", entries, truncated };
  }
  if (memory && !text) {
    const parsed = parseBackup(memory.doc);
    if (!("error" in parsed)) return { kind: "objects", entries: parsed.entries, skipped: parsed.skipped };
  }
  return { kind: "none" };
}

/**
 * Puts `text` (and optionally `json` as CLIPBOARD_MIME) on the system clipboard through a copy
 * command, the one route open to a sandboxed frame. Must run inside a user gesture. Returns
 * whether the browser accepted it.
 * @param {string} text @param {string} [json]
 */
export function writeClipboard(text, json) {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  let written = false;
  const onCopy = (/** @type {ClipboardEvent} */ e) => {
    e.stopImmediatePropagation();
    if (!e.clipboardData) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
    if (json) e.clipboardData.setData(CLIPBOARD_MIME, json);
    written = true;
  };
  document.addEventListener("copy", onCopy, true);
  try {
    if (!document.execCommand("copy")) written = false;
  } catch {
    written = false;
  } finally {
    document.removeEventListener("copy", onCopy, true);
  }
  return written;
}

/** @param {EventTarget|null} t */
function isTextField(t) {
  const el = t instanceof Element ? t : null;
  return !!el?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])");
}

/**
 * @param {import("./app.js").App} app
 * @param {{showToast: (message: string) => void}} ui
 */
export function createClipboard(app, { showToast }) {
  const { store, canvas } = app;
  /** @type {{doc: BackupDocument, text: string}|null} */
  let memory = null;
  /** @type {{key: string, count: number}} */
  let repeat = { key: "", count: 0 };

  const objects = () => store.getState().board.objects;

  /** @param {string[]} ids */
  function copyIds(ids) {
    const payload = clipboardPayload(objects(), ids);
    if (!payload) return null;
    memory = { doc: payload.doc, text: payload.text };
    repeat = { key: "", count: 0 };
    return payload;
  }

  /** @param {number} n */
  const objectsWord = (n) => (n === 1 ? "1 object" : `${n} objects`);

  /**
   * Creates `entries` near the pointer (or the view centre), as one undo step, and selects them.
   * @param {Entry[]} entries @param {{what?: "objects"|"text"|"code", skipped?: number, truncated?: number}} [info]
   */
  function place(entries, { what = "objects", skipped = 0, truncated = 0 } = {}) {
    if (!entries.length) return [];
    const vp = canvas.getViewport();
    const base = canvas.getPointer() ?? { x: vp.x + vp.w / 2, y: vp.y + vp.h / 2 };
    const key = `${Math.round(base.x)},${Math.round(base.y)}:${entries.length}:${entries[0]?.ref}`;
    repeat = key === repeat.key ? { key, count: repeat.count + 1 } : { key, count: 0 };
    const at = { x: base.x + repeat.count * PASTE_STEP, y: base.y + repeat.count * PASTE_STEP };
    const { creates, dropped } = placeEntries(entries, { objects: objects(), at });
    if (!creates.length) {
      showToast(`Nothing was pasted: the whiteboard holds at most ${LIMITS.objects} objects.`);
      return [];
    }
    const ids = store.createObjects(/** @type {any} */ (creates));
    canvas.setSelection(ids);
    const left = dropped + truncated;
    app.announce(what === "code"
      ? `Added a ${languageLabel(entries[0]?.object.language ?? "plain")} code block from the pasted text`
      : what === "text"
      ? `Added ${ids.length === 1 ? "1 sticky note" : `${ids.length} sticky notes`} from the pasted text`
      : `Pasted ${objectsWord(ids.length)}`);
    if (left || skipped) {
      showToast(`${left + skipped} ${left + skipped === 1 ? "item was" : "items were"} not pasted: ` +
        (skipped ? "some were not valid whiteboard objects" : `one paste adds at most ${BACKUP_LIMITS.pasteObjects} objects or ${BACKUP_LIMITS.textStickies} notes, and the board holds at most ${LIMITS.objects}`) + ".");
    }
    return ids;
  }

  /** @param {{json?: string, text?: string}} data @returns {boolean} whether anything was handled */
  function paste(data) {
    const r = readPaste(data, memory);
    if (r.kind === "none") return false;
    if (r.kind === "error") { showToast(r.message); return true; }
    if (r.kind === "text") place(r.entries, { what: "text", truncated: r.truncated });
    else if (r.kind === "code") place(r.entries, { what: "code" });
    else place(r.entries, { skipped: r.skipped });
    return true;
  }

  /** @param {ClipboardEvent} e */
  function boardTarget(e) {
    if (isTextField(e.target)) return false;
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest?.(".modal-scrim, .menu")) return false;
    const onCanvas = !!t && canvas.element.contains(t);
    if (onCanvas) return true;
    // Elsewhere, leave the browser's own copy of selected page text alone.
    const sel = typeof document.getSelection === "function" ? document.getSelection() : null;
    return !sel || sel.isCollapsed;
  }

  /** @param {ClipboardEvent} e @param {boolean} cut */
  function onCopy(e, cut) {
    if (e.defaultPrevented || !boardTarget(e)) return;
    const ids = canvas.getSelection();
    if (!ids.length) return;
    const payload = copyIds(ids);
    if (!payload) return;
    e.preventDefault();
    if (e.clipboardData) {
      e.clipboardData.setData("text/plain", payload.text);
      e.clipboardData.setData(CLIPBOARD_MIME, payload.json);
    }
    if (cut) removeCut(ids, payload.doc.objects.length);
    else app.announce(`Copied ${objectsWord(payload.doc.objects.length)}`);
  }

  /** @param {string[]} ids @param {number} n */
  function removeCut(ids, n) {
    store.deleteObjects(validIds(objects(), ids));
    canvas.setSelection([]);
    app.announce(`Cut ${objectsWord(n)}`);
  }

  /** @param {ClipboardEvent} e */
  function onPaste(e) {
    if (e.defaultPrevented || !boardTarget(e)) return;
    const cd = e.clipboardData;
    // Only our own format and plain text are read; text/html and image/svg+xml are ignored.
    const json = cd ? cd.getData(CLIPBOARD_MIME) : "";
    const text = cd ? cd.getData("text/plain") : "";
    if (paste({ json, text })) e.preventDefault();
  }

  const copyListener = (/** @type {Event} */ e) => onCopy(/** @type {ClipboardEvent} */ (e), false);
  const cutListener = (/** @type {Event} */ e) => onCopy(/** @type {ClipboardEvent} */ (e), true);
  const pasteListener = (/** @type {Event} */ e) => onPaste(/** @type {ClipboardEvent} */ (e));
  document.addEventListener("copy", copyListener);
  document.addEventListener("cut", cutListener);
  document.addEventListener("paste", pasteListener);

  return {
    /** Menu path of Copy: in memory always, on the system clipboard when the browser allows it. */
    copySelection(cut = false) {
      const ids = canvas.getSelection();
      const payload = copyIds(ids);
      if (!payload) return false;
      writeClipboard(payload.text, payload.json);
      if (cut) removeCut(ids, payload.doc.objects.length);
      else app.announce(`Copied ${objectsWord(payload.doc.objects.length)}`);
      return true;
    },
    /** Menu path of Paste: what was last copied here (the page cannot read the system clipboard). */
    pasteCopied() {
      if (!memory) return false;
      return paste({ json: JSON.stringify(memory.doc) });
    },
    hasCopied: () => !!memory,
    /** Text as sticky notes (the "Paste text" dialog). @param {string} text */
    pasteText(text) {
      const { entries, truncated } = textToEntries(text);
      return place(entries, { what: "text", truncated });
    },
    /** @param {Entry[]} entries */
    place,
    destroy() {
      document.removeEventListener("copy", copyListener);
      document.removeEventListener("cut", cutListener);
      document.removeEventListener("paste", pasteListener);
    },
  };
}
