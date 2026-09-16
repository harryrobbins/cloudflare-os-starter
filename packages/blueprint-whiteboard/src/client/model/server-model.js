// @ts-check
// The client's copy of authoritative server state, updated from snapshots, broadcast events,
// acknowledgements and conflict payloads.
//
// Ordering: results and events can arrive in either order (a request's own broadcast may come
// before or after its result, and another client's event may overtake our result). Every update
// is tagged with the board revision it reflects, and each object remembers the revision its
// current value (or deletion) came from. An update only lands when its revision is newer, which
// makes applying the same change twice (ack plus echo) a no-op and stops an older state from
// overwriting a newer one. The revision tag alone decides; as a belt-and-braces check an upsert is
// also refused when its version is lower than the one held for the SAME incarnation of the object
// (equal createdAt). A delete-then-recreate (a local undo of a delete re-creates the id at version
// 1) is a new incarnation, so its lower version must not stop it landing.
//
// Cost: every update is O(objects it names). The objects record is mutated in place (keys set and
// deleted); stored objects themselves are never mutated, only replaced.

import { DEFAULT_TITLE, SCHEMA_VERSION } from "../../shared/protocol.js";

/** @typedef {import("../../shared/protocol.js").BoardSnapshot} BoardSnapshot */
/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */

/**
 * @typedef {object} ServerModel
 * @property {BoardSnapshot} board
 * @property {number} baseRevision              revision of the snapshot this model started from
 * @property {Map<string, number>} objRev        revision each object's current state (or deletion) came from
 * @property {number} structureRev
 */

/**
 * @typedef {object} BoardUpdate
 * @property {WhiteboardObject[]} [upserts]
 * @property {string[]} [deletes]
 * @property {{title: string, background: BoardSnapshot["background"]}|null} [structure]
 * @property {number} [lastModified]
 */

/**
 * @param {Partial<BoardSnapshot>|null|undefined} snapshot
 * @returns {ServerModel}
 */
export function createServerModel(snapshot) {
  const s = snapshot ?? {};
  /** @type {BoardSnapshot} */
  const board = {
    schemaVersion: s.schemaVersion ?? SCHEMA_VERSION,
    revision: s.revision ?? 0,
    title: s.title ?? DEFAULT_TITLE,
    background: s.background ?? "dots",
    objects: { ...(s.objects ?? {}) },
    lastModified: s.lastModified ?? 0,
  };
  return { board, baseRevision: board.revision, objRev: new Map(), structureRev: board.revision };
}

/**
 * Sets one object's authoritative state (null = gone) as of `revision`.
 * @param {ServerModel} model
 * @param {string} id
 * @param {WhiteboardObject|null} obj
 * @param {number} revision
 * @returns {boolean} true when the model changed
 */
export function applyObjectState(model, id, obj, revision) {
  if (revision <= (model.objRev.get(id) ?? model.baseRevision)) return false;
  const objects = model.board.objects;
  const existing = objects[id];
  if (obj) {
    if (existing && existing.createdAt === obj.createdAt && typeof obj.version === "number" &&
        obj.version < existing.version) return false;
    model.objRev.set(id, revision);
    objects[id] = obj;
    return true;
  }
  model.objRev.set(id, revision);
  if (!existing) return false;
  delete objects[id];
  return true;
}

/**
 * Applies an event or acknowledgement: deletes, then upserts, then structure.
 * @param {ServerModel} model
 * @param {BoardUpdate} update
 * @param {number} revision
 * @returns {{objects: string[], structure: boolean}}
 */
export function applyUpdate(model, update, revision) {
  /** @type {string[]} */
  const objects = [];
  if (typeof revision !== "number") return { objects, structure: false };
  const upserts = Array.isArray(update.upserts) ? update.upserts : [];
  const deletes = Array.isArray(update.deletes) ? update.deletes : [];
  /** @type {Set<string>|null} */
  const upserted = deletes.length && upserts.length ? new Set(upserts.map((o) => o.id)) : null;
  for (const id of deletes) {
    if (typeof id !== "string" || upserted?.has(id)) continue;
    if (applyObjectState(model, id, null, revision)) objects.push(id);
  }
  for (const obj of upserts) {
    if (!obj || typeof obj.id !== "string") continue;
    if (applyObjectState(model, obj.id, obj, revision)) objects.push(obj.id);
  }
  let structure = false;
  if (update.structure && revision > model.structureRev) {
    model.structureRev = revision;
    if (typeof update.structure.title === "string") model.board.title = update.structure.title;
    if (typeof update.structure.background === "string") model.board.background = update.structure.background;
    structure = true;
  }
  if (revision > model.board.revision) {
    model.board.revision = revision;
    if (typeof update.lastModified === "number") model.board.lastModified = update.lastModified;
  }
  return { objects, structure };
}
