// @ts-check
// Pending local operations: their shape, how they apply optimistically, how they coalesce, which
// may share a request, and how they are written on the wire.

import { patchMatches } from "./rebase.js";

/** @typedef {import("../../shared/protocol.js").BoardSnapshot} BoardSnapshot */
/** @typedef {import("../../shared/protocol.js").Card} Card */
/** @typedef {import("../../shared/protocol.js").CardOp} CardOp */
/** @typedef {import("../../shared/protocol.js").ColumnOp} ColumnOp */
/** @typedef {import("../../shared/protocol.js").LabelOp} LabelOp */
/** @typedef {import("../../shared/protocol.js").OperationRequest} OperationRequest */

/**
 * @typedef {(
 *   {type: "card.create", cardId: string, columnId: string, fields: Partial<Card>, createdAt: number, createdBy: string}
 * | {type: "card.patch", cardId: string, patch: Partial<Card>, pinnedBase?: number}
 * | {type: "card.move", cardId: string, toColumnId: string, order: string}
 * | {type: "card.delete", cardId: string}
 * | {type: "column.create", columnId: string, name: string, index?: number}
 * | {type: "column.rename", columnId: string, name: string}
 * | {type: "column.collapse", columnId: string, collapsed: boolean}
 * | {type: "column.move", columnId: string, index: number}
 * | {type: "column.delete", columnId: string}
 * | {type: "label.upsert", labelId: string, label: {name: string, color: string}}
 * | {type: "label.delete", labelId: string}
 * | {type: "title", title: string}
 * )} OpBody
 */

/**
 * @typedef {object} OpMeta
 * @property {number} seq
 * @property {boolean} inflight   part of the request currently awaiting a result
 * @property {number} retries     automatic conflict retries so far
 * @property {boolean} replayed   sent before, outcome unknown (request failed or server restarted)
 * @property {number} [sendFailures]  requests carrying this op that failed outright
 * @property {Card|null} [baseCard]  the server card this op was last sent against; a replay
 *   of the same request keeps it (and its version as baseVersion)
 */

/** @typedef {OpBody & OpMeta} PendingOp */

const CARD_FIELDS = ["title", "description", "labels", "assignee", "due", "checklist", "order"];

/**
 * Only the editable card fields that are present.
 * @param {Partial<Card>} fields
 * @returns {Partial<Card>}
 */
export function pickCardFields(fields) {
  /** @type {Record<string, unknown>} */
  const out = {};
  const src = /** @type {Record<string, unknown>} */ (fields ?? {});
  for (const k of CARD_FIELDS) if (k in src && src[k] !== undefined) out[k] = src[k];
  return /** @type {Partial<Card>} */ (out);
}

/**
 * @param {OpBody} op
 * @returns {string|null} card id for card ops
 */
export function cardIdOf(op) {
  return op.type.startsWith("card.") ? /** @type {any} */ (op).cardId : null;
}

// -------------------------------------------------------------------------------------------
// Optimistic apply
// -------------------------------------------------------------------------------------------

/**
 * A shallow working copy of a board whose maps and arrays may be replaced (never mutated in
 * place on the original).
 * @param {BoardSnapshot} board
 * @returns {BoardSnapshot}
 */
export function draftOf(board) {
  return {
    ...board,
    cards: { ...board.cards },
    columns: { ...board.columns },
    columnOrder: board.columnOrder.slice(),
    labels: { ...board.labels },
  };
}

/**
 * Applies one pending op to a draft (from draftOf). Card and column objects are replaced, not
 * mutated.
 * @param {BoardSnapshot} d
 * @param {OpBody} op
 */
export function applyOpToDraft(d, op) {
  switch (op.type) {
    case "card.create": {
      const existing = d.cards[op.cardId];
      d.cards[op.cardId] = existing
        ? { ...existing, ...op.fields, columnId: existing.columnId }
        : {
          id: op.cardId, columnId: op.columnId, order: "a0", title: "", description: "",
          labels: [], assignee: "", due: null, checklist: [], version: 0,
          createdAt: op.createdAt, updatedAt: op.createdAt, createdBy: op.createdBy,
          ...op.fields,
        };
      break;
    }
    case "card.patch": {
      const card = d.cards[op.cardId];
      if (card) d.cards[op.cardId] = { ...card, ...op.patch };
      break;
    }
    case "card.move": {
      const card = d.cards[op.cardId];
      if (card) d.cards[op.cardId] = { ...card, columnId: op.toColumnId, order: op.order };
      break;
    }
    case "card.delete":
      delete d.cards[op.cardId];
      break;
    case "column.create": {
      const existing = d.columns[op.columnId];
      d.columns[op.columnId] = existing
        ? { ...existing, name: op.name }
        : { id: op.columnId, name: op.name, version: 0, collapsed: false };
      if (!d.columnOrder.includes(op.columnId)) {
        const i = op.index == null ? d.columnOrder.length
          : Math.max(0, Math.min(op.index, d.columnOrder.length));
        d.columnOrder.splice(i, 0, op.columnId);
      }
      break;
    }
    case "column.rename": {
      const col = d.columns[op.columnId];
      if (col) d.columns[op.columnId] = { ...col, name: op.name };
      break;
    }
    case "column.collapse": {
      const col = d.columns[op.columnId];
      if (col) d.columns[op.columnId] = { ...col, collapsed: op.collapsed };
      break;
    }
    case "column.move": {
      const from = d.columnOrder.indexOf(op.columnId);
      if (from < 0) break;
      d.columnOrder.splice(from, 1);
      const i = Math.max(0, Math.min(op.index, d.columnOrder.length));
      d.columnOrder.splice(i, 0, op.columnId);
      break;
    }
    case "column.delete": {
      delete d.columns[op.columnId];
      d.columnOrder = d.columnOrder.filter((id) => id !== op.columnId);
      for (const [id, card] of Object.entries(d.cards)) {
        if (card.columnId === op.columnId) delete d.cards[id];
      }
      break;
    }
    case "label.upsert":
      d.labels[op.labelId] = { id: op.labelId, name: op.label.name, color: op.label.color };
      break;
    case "label.delete":
      delete d.labels[op.labelId];
      break;
    case "title":
      d.title = op.title;
      break;
  }
}

/**
 * The optimistic view: server state with every pending op re-applied in order.
 * @param {BoardSnapshot} server
 * @param {Iterable<OpBody>} ops
 * @returns {BoardSnapshot}
 */
export function deriveBoard(server, ops) {
  const d = draftOf(server);
  for (const op of ops) applyOpToDraft(d, op);
  return d;
}

// -------------------------------------------------------------------------------------------
// Dependencies: which ops may share a request, and which may be merged across others
// -------------------------------------------------------------------------------------------

/**
 * @param {OpBody} op
 * @returns {{writes: string[], reads: string[]}}
 */
export function keysOf(op) {
  switch (op.type) {
    case "card.create":
      return {
        writes: ["card:" + op.cardId],
        reads: ["column:" + op.columnId, ...(op.fields.labels ?? []).map((l) => "label:" + l)],
      };
    case "card.patch":
      return {
        writes: ["card:" + op.cardId],
        reads: (op.patch.labels ?? []).map((l) => "label:" + l),
      };
    case "card.move":
      return { writes: ["card:" + op.cardId], reads: ["column:" + op.toColumnId] };
    case "card.delete":
      return { writes: ["card:" + op.cardId], reads: [] };
    case "column.create":
    case "column.delete":
      return { writes: ["column:" + op.columnId, "columnOrder"], reads: [] };
    case "column.rename":
    case "column.collapse":
      return { writes: ["column:" + op.columnId], reads: [] };
    case "column.move":
      return { writes: ["columnOrder"], reads: ["column:" + op.columnId] };
    case "label.upsert":
    case "label.delete":
      return { writes: ["label:" + op.labelId], reads: [] };
    case "title":
      return { writes: ["title"], reads: [] };
  }
}

/**
 * True when `b` depends on or overlaps `a`, so they must not share a request (or be reordered).
 * @param {OpBody} a
 * @param {OpBody} b
 */
export function dependsOn(a, b) {
  const ka = keysOf(a);
  const kb = keysOf(b);
  const aw = new Set(ka.writes);
  if (kb.writes.some((k) => aw.has(k)) || kb.reads.some((k) => aw.has(k))) return true;
  const ar = new Set(ka.reads);
  return kb.writes.some((k) => ar.has(k));
}

/**
 * Merges `next` into `target` when the two can travel as one op. Returns the merged body, the
 * string "cancel" when both vanish (create then delete), or null when they can't merge.
 * @param {OpBody} target
 * @param {OpBody} next
 * @returns {OpBody|"cancel"|null}
 */
export function mergeOps(target, next) {
  if (target.type === "card.create" && cardIdOf(next) === target.cardId) {
    if (next.type === "card.patch") {
      return { ...target, fields: { ...target.fields, ...next.patch } };
    }
    if (next.type === "card.move") {
      return { ...target, columnId: next.toColumnId, fields: { ...target.fields, order: next.order } };
    }
    if (next.type === "card.delete") return "cancel";
    return null;
  }
  if (target.type === "card.patch" && next.type === "card.patch" && target.cardId === next.cardId &&
      target.pinnedBase === next.pinnedBase) {
    return { ...target, patch: { ...target.patch, ...next.patch } };
  }
  if (target.type === "card.move" && next.type === "card.move" && target.cardId === next.cardId) {
    return next;
  }
  if (target.type === "column.create" && "columnId" in next && next.columnId === target.columnId) {
    if (next.type === "column.rename") return { ...target, name: next.name };
    return null;
  }
  if (target.type === next.type) {
    if (target.type === "column.rename" && next.type === "column.rename" &&
        target.columnId === next.columnId) return next;
    if (target.type === "column.collapse" && next.type === "column.collapse" &&
        target.columnId === next.columnId) return next;
    if (target.type === "label.upsert" && next.type === "label.upsert" &&
        target.labelId === next.labelId) return next;
    if (target.type === "title") return next;
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// Wire format
// -------------------------------------------------------------------------------------------

/**
 * @typedef {object} WireRef
 * @property {"cardOps"|"columnOps"|"labelOps"|"structure"} array
 * @property {number} index   -1 for structure
 */

/**
 * Builds one OperationRequest. Card and column versions are read from server state at send
 * time through `ctx`, except that a replayed card op (its earlier send had an unknown outcome)
 * keeps the version of the card it was originally sent against, so a change made meanwhile by
 * someone else comes back as a conflict instead of being overwritten.
 * @param {PendingOp[]} ops
 * @param {{senderId: string, by: string, requestId?: string, cardVersion: (id: string) => number,
 *   columnVersion: (id: string) => number}} ctx
 * @returns {{request: OperationRequest, refs: Map<PendingOp, WireRef>}}
 */
export function buildRequest(ops, ctx) {
  /** @type {CardOp[]} */
  const cardOps = [];
  /** @type {ColumnOp[]} */
  const columnOps = [];
  /** @type {LabelOp[]} */
  const labelOps = [];
  /** @type {OperationRequest} */
  const request = { senderId: ctx.senderId, by: ctx.by };
  if (ctx.requestId) /** @type {any} */ (request).requestId = ctx.requestId;
  /** @param {PendingOp} op @param {string} cardId */
  const cardVersion = (op, cardId) =>
    op.replayed && op.baseCard !== undefined ? op.baseCard?.version ?? 0 : ctx.cardVersion(cardId);
  /** @type {Map<PendingOp, WireRef>} */
  const refs = new Map();
  /**
   * @param {PendingOp} op
   * @param {"cardOps"|"columnOps"|"labelOps"} array
   * @param {any[]} list
   * @param {any} wire
   */
  const push = (op, array, list, wire) => {
    refs.set(op, { array, index: list.length });
    list.push(wire);
  };
  for (const op of ops) {
    switch (op.type) {
      case "card.create":
        push(op, "cardOps", cardOps, {
          op: "upsert", cardId: op.cardId, columnId: op.columnId, baseVersion: 0,
          card: { ...op.fields },
        });
        break;
      case "card.patch":
        push(op, "cardOps", cardOps, {
          op: "upsert", cardId: op.cardId,
          baseVersion: op.pinnedBase ?? cardVersion(op, op.cardId), card: { ...op.patch },
        });
        break;
      case "card.move":
        push(op, "cardOps", cardOps, {
          op: "move", cardId: op.cardId, baseVersion: cardVersion(op, op.cardId),
          toColumnId: op.toColumnId, order: op.order,
        });
        break;
      case "card.delete":
        push(op, "cardOps", cardOps, {
          op: "delete", cardId: op.cardId, baseVersion: cardVersion(op, op.cardId),
        });
        break;
      case "column.create": {
        /** @type {ColumnOp} */
        const wire = { op: "upsert", columnId: op.columnId, baseVersion: 0, column: { name: op.name } };
        if (op.index != null) wire.index = op.index;
        push(op, "columnOps", columnOps, wire);
        break;
      }
      case "column.rename":
        push(op, "columnOps", columnOps, {
          op: "upsert", columnId: op.columnId, baseVersion: ctx.columnVersion(op.columnId),
          column: { name: op.name },
        });
        break;
      case "column.collapse":
        push(op, "columnOps", columnOps, {
          op: "upsert", columnId: op.columnId, baseVersion: ctx.columnVersion(op.columnId),
          column: { collapsed: op.collapsed },
        });
        break;
      case "column.move":
        push(op, "columnOps", columnOps, { op: "move", columnId: op.columnId, index: op.index });
        break;
      case "column.delete":
        push(op, "columnOps", columnOps, {
          op: "delete", columnId: op.columnId, baseVersion: ctx.columnVersion(op.columnId),
        });
        break;
      case "label.upsert":
        push(op, "labelOps", labelOps, { op: "upsert", labelId: op.labelId, label: { ...op.label } });
        break;
      case "label.delete":
        push(op, "labelOps", labelOps, { op: "delete", labelId: op.labelId });
        break;
      case "title":
        refs.set(op, { array: "structure", index: -1 });
        request.structure = { title: op.title };
        break;
    }
  }
  if (cardOps.length) request.cardOps = cardOps;
  if (columnOps.length) request.columnOps = columnOps;
  if (labelOps.length) request.labelOps = labelOps;
  return { request, refs };
}

/**
 * For an op whose earlier send has an unknown outcome: true when the server state already shows
 * its effect, so it must not be sent again.
 * @param {OpBody} op
 * @param {BoardSnapshot} server
 */
export function alreadyApplied(op, server) {
  switch (op.type) {
    case "card.create":
      return Boolean(server.cards[op.cardId]);
    case "card.patch":
      return patchMatches(op.patch, server.cards[op.cardId], server.labels);
    case "card.move": {
      const card = server.cards[op.cardId];
      return Boolean(card && card.columnId === op.toColumnId && card.order === op.order);
    }
    case "card.delete":
      return !server.cards[op.cardId];
    case "column.create":
      return Boolean(server.columns[op.columnId]);
    case "column.rename":
      return server.columns[op.columnId]?.name === op.name;
    case "column.collapse":
      return server.columns[op.columnId]?.collapsed === op.collapsed;
    case "column.delete":
      return !server.columns[op.columnId];
    default:
      return false; // last-writer-wins ops are idempotent; resend
  }
}
