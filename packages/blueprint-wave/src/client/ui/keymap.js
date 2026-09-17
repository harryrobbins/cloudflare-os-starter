// @ts-check
// Keyboard map of the conversation as a pure function from a key event plus context to an action
// name, and the since-marker walk. The conversation (conversation.js) applies the actions; the
// shell's help and the README quote KEYS from ui-contract.js.

import { KEYS } from "./ui-contract.js";

/**
 * @typedef {"next"|"prev"|"first"|"last"|"nextChanged"|"prevChanged"|"reply"|"edit"|"focusThread"|"back"|"delete"|"done"|"undo"|"redo"|"menu"} KeyActionName
 */

/**
 * @typedef {object} KeyContext
 * @property {boolean} onCard        focus is on a blip card (not on a button inside it)
 * @property {boolean} inEditor      focus is in a textarea or input (editor or composer)
 * @property {boolean} [historyMode] History mode: write actions are off and Esc is the shell's
 * @property {boolean} [threadOpen]  the focus view is showing one thread
 * @property {boolean} [locked]      the focused card is a decision (no edit, no delete)
 * @property {boolean} [composing]   an IME composition is in progress (ignore everything)
 */

/**
 * @param {{key: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean, isComposing?: boolean}} e
 * @param {KeyContext} ctx
 * @returns {KeyActionName|null}
 */
export function keyAction(e, ctx) {
  if (ctx.composing || e.isComposing) return null;
  const mod = !!(e.ctrlKey || e.metaKey);
  const key = e.key;
  const lower = key.length === 1 ? key.toLowerCase() : key;

  if (mod) {
    if (e.altKey) return null;
    if (lower === "z") return ctx.inEditor ? (e.shiftKey ? "redo" : "undo") : null;
    if (lower === "y") return ctx.inEditor ? "redo" : null;
    if (key === "Enter" && ctx.inEditor) return "done";
    return null;
  }
  if (ctx.inEditor) {
    if (key === KEYS.back) return "done";
    return null;
  }
  if (e.altKey) return null;

  // Keys that work anywhere inside the conversation (a card or a button in it).
  if (key === KEYS.back) return ctx.historyMode ? null : "back";
  if (!ctx.onCard) return null;

  switch (key) {
    case "ArrowDown": return "next";
    case "ArrowUp": return "prev";
    case "Home": return "first";
    case "End": return "last";
    case KEYS.focusThread: return "focusThread";
    case KEYS.delete: return ctx.historyMode || ctx.locked ? null : "delete";
    case KEYS.prevChanged: return "prevChanged";
    case "ContextMenu": return "menu";
    case "F10": return e.shiftKey ? "menu" : null;
  }
  if (e.shiftKey) return null;
  switch (lower) {
    case KEYS.nextBlip: return "next";
    case KEYS.prevBlip: return "prev";
    case KEYS.nextChanged: return "nextChanged";
    case KEYS.reply: return ctx.historyMode ? null : "reply";
    case KEYS.edit: return ctx.historyMode || ctx.locked ? null : "edit";
  }
  return null;
}

/**
 * The next changed id after `focusId` in `direction` (1 forwards, -1 backwards), with no wrap;
 * null when there is none. With no focus (or a focus not in `ids`) the walk starts from the
 * beginning (forwards) or the end (backwards).
 * @param {string[]} ids        visible ids in reading order
 * @param {string|null} focusId
 * @param {1|-1} direction
 * @param {Set<string>|{has: (id: string) => boolean}} changedSet
 * @returns {string|null}
 */
export function nextChanged(ids, focusId, direction, changedSet) {
  const at = focusId === null ? -1 : ids.indexOf(focusId);
  if (direction === 1) {
    for (let i = at + 1; i < ids.length; i++) if (changedSet.has(ids[i])) return ids[i];
    return null;
  }
  const start = at === -1 ? ids.length - 1 : at - 1;
  for (let i = start; i >= 0; i--) if (changedSet.has(ids[i])) return ids[i];
  return null;
}

/**
 * The id `step` cards away from `focusId` in `ids`, clamped to the ends; the first or last id when
 * nothing is focused; null for an empty list.
 * @param {string[]} ids
 * @param {string|null} focusId
 * @param {number} step
 */
export function stepFocus(ids, focusId, step) {
  if (ids.length === 0) return null;
  const at = focusId === null ? -1 : ids.indexOf(focusId);
  if (at === -1) return step >= 0 ? ids[0] : ids[ids.length - 1];
  const next = Math.min(ids.length - 1, Math.max(0, at + step));
  return ids[next];
}

/** One line for the shell's help and for aria-describedby on the conversation. */
export const SHORTCUTS_HINT =
  "Conversation. J and K move between blips, N and Shift+N jump to the next and previous changed " +
  "blip, R replies, E edits, Enter focuses a thread, Escape returns, Delete removes a blip. " +
  "Inside an editor, Ctrl+Enter or Escape finishes; Ctrl+Z and Ctrl+Shift+Z undo and redo.";
