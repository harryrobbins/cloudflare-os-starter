// @ts-check
// Helpers for local undo: the "actions" a store call is made of, and what reverses them.
//
// An action list is applied against the optimistic view at the time it is applied (not when it
// was recorded), and applying one yields the list that reverses it, which is what makes undo and
// redo symmetric:
//   create X        <-> delete X
//   update X patch  <-> update X {previous values of the patched fields; style key by key}
//   delete X        <-> create X (the full object), plus creates of the connectors the delete
//                       cascaded to, endpoints first

import { deepEqual } from "./equal.js";

/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../../shared/protocol.js").ObjectPatch} ObjectPatch */

/**
 * @typedef {(
 *   {kind: "create", object: Partial<WhiteboardObject> & {id: string, type: WhiteboardObject["type"]}}
 * | {kind: "update", id: string, patch: ObjectPatch}
 * | {kind: "delete", id: string}
 * )} Action
 */

/** Undo and redo stacks keep at most this many steps. */
export const UNDO_LIMIT = 100;

/**
 * The fields of `patch` whose values differ from `obj` (style key by key). Returns null when
 * nothing would change.
 * @param {WhiteboardObject} obj
 * @param {ObjectPatch} patch
 * @returns {ObjectPatch|null}
 */
export function effectivePatch(obj, patch) {
  /** @type {Record<string, any>} */
  const out = {};
  const o = /** @type {Record<string, any>} */ (obj);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "style") {
      /** @type {Record<string, any>} */
      const style = {};
      for (const [k, v] of Object.entries(value)) if (!deepEqual(obj.style?.[/** @type {keyof typeof obj.style} */ (k)], v)) style[k] = v;
      if (Object.keys(style).length) out.style = style;
      continue;
    }
    if (!deepEqual(o[key] ?? (key === "frameId" ? null : undefined), value)) out[key] = value;
  }
  return Object.keys(out).length ? /** @type {ObjectPatch} */ (out) : null;
}

/**
 * The current values of the fields `patch` would change.
 * @param {WhiteboardObject} obj
 * @param {ObjectPatch} patch
 * @returns {ObjectPatch}
 */
export function previousValues(obj, patch) {
  /** @type {Record<string, any>} */
  const out = {};
  const o = /** @type {Record<string, any>} */ (obj);
  for (const key of Object.keys(patch)) {
    if (key === "style") {
      /** @type {Record<string, any>} */
      const style = {};
      for (const k of Object.keys(/** @type {any} */ (patch).style)) style[k] = /** @type {any} */ (obj.style)[k];
      out.style = style;
    } else {
      out[key] = o[key] ?? (key === "frameId" ? null : o[key]);
    }
  }
  return /** @type {ObjectPatch} */ (out);
}
