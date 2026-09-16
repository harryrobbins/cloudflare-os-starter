// @ts-check
// Conflict policy for a stale update (see store-contract "Conflicts"). Pure.
//
//   geometry (x, y, w, h, rot) changed by them: my delta (mine - base) is re-applied on top of
//     theirs (sizes clamped, rotation mod 360)
//   z, frameId: mine is kept
//   text, style keys, points, from, to, fromSide, toSide, routing changed by them: mine is dropped,
//     theirs kept, and the object flashes
//   fields only I changed: kept as they are
//   a field already equal to theirs is dropped (nothing to write)
//
// Values compared are already cleaned (patches are cleaned with the protocol sanitisers when
// queued; server objects are cleaned by the server), so server-side rounding never looks like a
// concurrent change.

import { cleanCoord, cleanRotation, cleanSize } from "../../shared/protocol.js";
import { deepEqual } from "./equal.js";

/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../../shared/protocol.js").ObjectPatch} ObjectPatch */

const GEOMETRY = new Set(["x", "y", "w", "h", "rot"]);
const MINE_WINS = new Set(["z", "frameId"]);

/**
 * @param {string} field
 * @param {number} value
 */
export function cleanGeometry(field, value) {
  if (field === "w" || field === "h") return cleanSize(value);
  if (field === "rot") return cleanRotation(value);
  return cleanCoord(value);
}

/**
 * @param {ObjectPatch} patch     what I sent
 * @param {WhiteboardObject|null|undefined} base  the server object it was sent against
 * @param {WhiteboardObject} theirs  the authoritative object now
 * @returns {{patch: ObjectPatch, flash: boolean, shifts: Record<string, number>}}
 *   `patch` to retry (may be empty: nothing left to write); `shifts` is theirs - base for each
 *   geometry field that was rebased, so later unsent edits of the same object can follow.
 */
export function rebasePatch(patch, base, theirs) {
  /** @type {Record<string, any>} */
  const out = {};
  /** @type {Record<string, number>} */
  const shifts = {};
  let flash = false;
  const b = /** @type {Record<string, any>} */ (base ?? theirs);
  const t = /** @type {Record<string, any>} */ (theirs);
  for (const [field, mine] of Object.entries(patch)) {
    if (mine === undefined) continue;
    if (field === "style") {
      /** @type {Record<string, any>} */
      const style = {};
      for (const [key, value] of Object.entries(mine)) {
        const theirValue = t.style?.[key];
        if (deepEqual(value, theirValue)) continue;
        if (!deepEqual(b.style?.[key], theirValue)) {
          flash = true;
          continue;
        }
        style[key] = value;
      }
      if (Object.keys(style).length) out.style = style;
      continue;
    }
    const theirValue = t[field];
    if (deepEqual(mine, theirValue)) continue;
    const changedByThem = !deepEqual(b[field], theirValue);
    if (!changedByThem || MINE_WINS.has(field)) {
      out[field] = mine;
      continue;
    }
    if (GEOMETRY.has(field) && typeof mine === "number" && typeof b[field] === "number" &&
        typeof theirValue === "number") {
      const next = cleanGeometry(field, theirValue + (mine - b[field]));
      shifts[field] = theirValue - b[field];
      if (next !== null && next !== theirValue) out[field] = next;
      continue;
    }
    flash = true;
  }
  return { patch: /** @type {ObjectPatch} */ (out), flash, shifts };
}

/**
 * Shifts the geometry fields of a later, unsent patch by `shifts` (theirs - base), so a second
 * unsent drag of the same object keeps both people's movement.
 * @param {ObjectPatch} patch
 * @param {Record<string, number>} shifts
 * @returns {ObjectPatch}
 */
export function shiftPatch(patch, shifts) {
  /** @type {Record<string, any>} */
  const out = { ...patch };
  let changed = false;
  for (const [field, d] of Object.entries(shifts)) {
    const v = /** @type {any} */ (patch)[field];
    if (typeof v !== "number" || !d) continue;
    const next = cleanGeometry(field, v + d);
    if (next !== null) {
      out[field] = next;
      changed = true;
    }
  }
  return changed ? /** @type {ObjectPatch} */ (out) : patch;
}
