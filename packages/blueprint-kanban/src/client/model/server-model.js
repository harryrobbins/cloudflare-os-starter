// @ts-check
// The client's copy of authoritative server state, updated from snapshots, broadcast events,
// acknowledgements and conflict payloads.
//
// Ordering: results and events can arrive in either order (a request's own broadcast may come
// before or after its result, and another client's event may overtake our result). Every update
// is tagged with the board revision it reflects, and each entity remembers the revision its
// current value came from. An update only lands when its revision is newer, which makes applying
// the same change twice (ack plus echo) a no-op and stops an older state from overwriting a newer
// one. Card upserts are additionally refused if their version is lower than the one held.
//
// Objects in the model are never mutated after being stored: every change replaces the object, so
// derived views can diff by reference.

import { clone } from "./equal.js";

/** @typedef {import("../../shared/protocol.js").BoardSnapshot} BoardSnapshot */
/** @typedef {import("../../shared/protocol.js").Card} Card */
/** @typedef {import("../../shared/protocol.js").Column} Column */
/** @typedef {import("../../shared/protocol.js").Label} Label */
/** @typedef {import("../../shared/protocol.js").StructureState} StructureState */

/**
 * @typedef {object} ServerModel
 * @property {BoardSnapshot} board
 * @property {number} baseRevision                 revision of the snapshot this model started from
 * @property {Map<string, number>} cardRev         revision each card's current state (or deletion) came from
 * @property {number} structureRev
 * @property {number} labelsRev
 */

/**
 * @typedef {object} BoardUpdate
 * @property {Card[]} [upserts]
 * @property {{cardId: string}[]} [deletes]
 * @property {StructureState|null} [structure]
 * @property {Record<string, Label>|null} [labels]
 * @property {number} [lastModified]
 */

/**
 * @param {BoardSnapshot} snapshot
 * @returns {ServerModel}
 */
export function createServerModel(snapshot) {
  const board = clone(snapshot);
  board.cards ??= {};
  board.columns ??= {};
  board.columnOrder ??= [];
  board.labels ??= {};
  board.revision ??= 0;
  return {
    board,
    baseRevision: board.revision,
    cardRev: new Map(),
    structureRev: board.revision,
    labelsRev: board.revision,
  };
}

/**
 * @param {ServerModel} model
 * @param {string} cardId
 */
function lastCardRev(model, cardId) {
  return model.cardRev.get(cardId) ?? model.baseRevision;
}

/**
 * Sets one card's authoritative state (null = gone) as of `revision`.
 * @param {ServerModel} model
 * @param {string} cardId
 * @param {Card|null} card
 * @param {number} revision
 * @returns {boolean} true when the model changed
 */
export function applyCardState(model, cardId, card, revision) {
  if (revision <= lastCardRev(model, cardId)) return false;
  const existing = model.board.cards[cardId];
  if (card) {
    if (existing && typeof card.version === "number" && card.version < existing.version) {
      return false;
    }
    model.cardRev.set(cardId, revision);
    model.board.cards = { ...model.board.cards, [cardId]: clone(card) };
    return true;
  }
  model.cardRev.set(cardId, revision);
  if (!existing) return false;
  const cards = { ...model.board.cards };
  delete cards[cardId];
  model.board.cards = cards;
  return true;
}

/**
 * Applies an event or acknowledgement: deletes, then upserts, then structure and labels.
 * @param {ServerModel} model
 * @param {BoardUpdate} update
 * @param {number} revision
 * @returns {{cards: string[], structure: boolean, labels: boolean}}
 */
export function applyUpdate(model, update, revision) {
  /** @type {string[]} */
  const cards = [];
  // A card both deleted and upserted in one update (not expected) resolves to the upsert.
  const upserted = new Set((update.upserts ?? []).map((c) => c.id));
  for (const d of update.deletes ?? []) {
    if (upserted.has(d.cardId)) continue;
    if (applyCardState(model, d.cardId, null, revision)) cards.push(d.cardId);
  }
  for (const card of update.upserts ?? []) {
    if (applyCardState(model, card.id, card, revision)) cards.push(card.id);
  }
  let structure = false;
  if (update.structure && revision > model.structureRev) {
    model.structureRev = revision;
    const s = clone(update.structure);
    model.board.title = s.title;
    model.board.columnOrder = s.columnOrder;
    model.board.columns = s.columns;
    structure = true;
  }
  let labels = false;
  if (update.labels && revision > model.labelsRev) {
    model.labelsRev = revision;
    model.board.labels = clone(update.labels);
    labels = true;
  }
  if (revision > model.board.revision) {
    model.board.revision = revision;
    if (typeof update.lastModified === "number") model.board.lastModified = update.lastModified;
  }
  return { cards, structure, labels };
}

/**
 * A column from a conflict payload. Not revision-tagged, so it lands only when its version is
 * newer; column order is left alone.
 * @param {ServerModel} model
 * @param {string} columnId
 * @param {Column|null} column
 * @returns {boolean}
 */
export function applyColumnState(model, columnId, column) {
  const existing = model.board.columns[columnId];
  if (column) {
    if (existing && column.version <= existing.version) return false;
    model.board.columns = { ...model.board.columns, [columnId]: clone(column) };
    if (!model.board.columnOrder.includes(columnId)) {
      model.board.columnOrder = [...model.board.columnOrder, columnId];
    }
    return true;
  }
  if (!existing) return false;
  const columns = { ...model.board.columns };
  delete columns[columnId];
  model.board.columns = columns;
  model.board.columnOrder = model.board.columnOrder.filter((id) => id !== columnId);
  return true;
}
