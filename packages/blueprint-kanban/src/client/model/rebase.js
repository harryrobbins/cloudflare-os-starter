// @ts-check
// Deciding what to do with a card op the server rejected as stale.

import { deepEqual } from "./equal.js";

/** @typedef {import("../../shared/protocol.js").Card} Card */
/** @typedef {import("../../shared/protocol.js").ChecklistItem} ChecklistItem */

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
 * @returns {PatchDecision}
 */
export function decidePatchConflict(mine, base, theirs, retries) {
  if (!theirs) return { action: "conflict" };
  const t = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (theirs));
  const fields = Object.keys(mine);
  const m = /** @type {Record<string, unknown>} */ (mine);
  if (fields.every((f) => deepEqual(t[f], m[f]))) return { action: "ack" };

  if (fields.length === 1 && fields[0] === "checklist" && base && retries === 0) {
    return {
      action: "retry",
      patch: { checklist: mergeChecklist(base.checklist ?? [], mine.checklist ?? [], theirs.checklist ?? []) },
    };
  }
  if (!base || retries >= MAX_CONTENT_RETRIES) return { action: "conflict" };
  const b = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (base));
  const untouched = fields.every((f) => deepEqual(t[f], m[f]) || deepEqual(t[f], b[f]));
  return untouched ? { action: "retry", patch: mine } : { action: "conflict" };
}
