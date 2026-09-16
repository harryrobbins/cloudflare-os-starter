// @ts-check
// Deciding what to do with a card op the server rejected as stale.

import { LIMITS, cleanCardPatch, cleanLabelIds, isId } from "../../shared/protocol.js";
import { deepEqual } from "./equal.js";

/** @typedef {import("../../shared/protocol.js").Card} Card */
/** @typedef {import("../../shared/protocol.js").ChecklistItem} ChecklistItem */
/** @typedef {import("../../shared/protocol.js").Label} Label */

// -------------------------------------------------------------------------------------------
// Comparing a local patch with server state. The server cleans every value it stores (trimming,
// dropping unknown labels, normalising newlines...), so a patch is compared in its cleaned form:
// "Same  " and "Same" are the same save.
// -------------------------------------------------------------------------------------------

/**
 * The patch as the server would store it. Checklist items the server would give a fresh id get
 * `id: null`, which matches any id. With `labels` null, label ids are left as sent.
 * @param {Partial<Card>} patch
 * @param {Record<string, Label>|null|undefined} labels
 * @returns {Partial<Card>}
 */
export function comparablePatch(patch, labels) {
  const raw = /** @type {Record<string, any>} */ (patch ?? {});
  const out = cleanCardPatch(raw, labels ?? {});
  if (!labels && "labels" in raw) out.labels = raw.labels;
  if (Array.isArray(raw.checklist) && out.checklist) {
    /** @type {boolean[]} whether each kept item carried a valid id of its own */
    const ownIds = [];
    const seen = new Set();
    for (const item of raw.checklist) {
      if (!item || typeof item !== "object") continue;
      if (isId(item.id, "item")) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        ownIds.push(true);
      } else {
        ownIds.push(false);
      }
      if (ownIds.length >= LIMITS.checklistItems) break;
    }
    if (ownIds.length === out.checklist.length) {
      out.checklist = out.checklist.map((item, i) => (ownIds[i] ? item : { ...item, id: /** @type {any} */ (null) }));
    }
  }
  return out;
}

/**
 * Equality of one field of a comparable patch (`mine`) with a stored value.
 * @param {string} field
 * @param {unknown} stored
 * @param {unknown} mine
 * @param {Record<string, Label>|null|undefined} labels
 */
export function fieldMatches(field, stored, mine, labels) {
  if (field === "labels" && labels && Array.isArray(stored)) {
    return deepEqual(cleanLabelIds(stored, labels), mine);
  }
  if (field === "checklist" && Array.isArray(stored) && Array.isArray(mine)) {
    return stored.length === mine.length && mine.every((m, i) => {
      const s = stored[i];
      return s && m && (m.id === null || m.id === s.id) && s.text === m.text && s.done === m.done;
    });
  }
  return deepEqual(stored, mine);
}

/**
 * True when `card` already holds every value of `patch` (after cleaning).
 * @param {Partial<Card>} patch
 * @param {Card|null|undefined} card
 * @param {Record<string, Label>|null|undefined} labels
 */
export function patchMatches(patch, card, labels) {
  if (!card) return false;
  const mine = /** @type {Record<string, unknown>} */ (comparablePatch(patch, labels));
  const c = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (card));
  return Object.keys(mine).every((f) => fieldMatches(f, c[f], mine[f], labels));
}

/** Automatic retries of a content patch whose fields nobody else touched. */
export const MAX_CONTENT_RETRIES = 3;

/**
 * Re-applies the checklist changes made between `base` and `mine` onto `theirs`, by item id:
 * toggles and text edits land on the matching item, items I added are appended, items I removed
 * are removed. Item order follows theirs.
 * @param {ChecklistItem[]} base
 * @param {ChecklistItem[]} mine
 * @param {ChecklistItem[]} theirs
 * @returns {ChecklistItem[]}
 */
export function mergeChecklist(base, mine, theirs) {
  const baseById = new Map(base.map((i) => [i.id, i]));
  const mineById = new Map(mine.map((i) => [i.id, i]));
  const theirIds = new Set(theirs.map((i) => i.id));
  /** @type {ChecklistItem[]} */
  const out = [];
  for (const item of theirs) {
    const b = baseById.get(item.id);
    const m = mineById.get(item.id);
    if (b && !m) continue; // I removed it
    if (b && m) {
      const next = { ...item };
      if (m.done !== b.done) next.done = m.done;
      if (m.text !== b.text) next.text = m.text;
      out.push(next);
    } else {
      out.push(item);
    }
  }
  for (const m of mine) {
    if (!baseById.has(m.id) && !theirIds.has(m.id)) out.push(m); // I added it
  }
  return out;
}

/**
 * @typedef {(
 *   {action: "ack"}
 * | {action: "retry", patch: Partial<Card>}
 * | {action: "conflict"}
 * )} PatchDecision
 */

/**
 * A content patch conflicted. `base` is the card it was sent against (null if unknown).
 * @param {Partial<Card>} mine
 * @param {Card|null} base
 * @param {Card|null} theirs
 * @param {number} retries  automatic retries already made for this op
 * @param {Record<string, Label>|null} [labels]  current board labels, for cleaning label ids
 * @returns {PatchDecision}
 */
export function decidePatchConflict(mine, base, theirs, retries, labels = null) {
  if (!theirs) return { action: "conflict" };
  const t = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (theirs));
  const m = /** @type {Record<string, unknown>} */ (comparablePatch(mine, labels));
  const fields = Object.keys(m);
  if (fields.every((f) => fieldMatches(f, t[f], m[f], labels))) return { action: "ack" };

  if (fields.length === 1 && fields[0] === "checklist" && base && retries === 0) {
    return {
      action: "retry",
      patch: { checklist: mergeChecklist(base.checklist ?? [], mine.checklist ?? [], theirs.checklist ?? []) },
    };
  }
  if (!base || retries >= MAX_CONTENT_RETRIES) return { action: "conflict" };
  const b = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (base));
  const untouched = fields.every((f) => fieldMatches(f, t[f], m[f], labels) || deepEqual(t[f], b[f]));
  return untouched ? { action: "retry", patch: mine } : { action: "conflict" };
}
