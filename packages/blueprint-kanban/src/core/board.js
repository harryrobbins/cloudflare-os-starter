// @ts-check
// Board rules: validation, caps, per-card and per-column versions, moves, history, inverses and
// undo. Storage-agnostic: everything goes through a Repository (src/core/repository.js), so the
// same rules run in the Durable Object, in memory for tests, and in the browser harness.
//
// Every public method is serialised through one promise queue, so each call observes and commits
// one authoritative state in strict order. A throwing call rejects its own promise only.
//
// Processing order inside one request (each op sees the effects of the ops before it):
//   1. labelOps
//   2. columnOps: upsert and move, in array order
//   3. cardOps, in array order
//   4. columnOps: delete, in array order (so a request can move cards out and then delete)
//   5. structure (board title)
// Valid ops commit even when others fail; the whole request is written with ONE repo.commit and
// bumps the revision once. A card's version is bumped once per request that changes it, and an
// op may name either the version from before the request or the one current within it.
//
// Size budget: the stored size of every card is tracked in memory (computed at load), so creates,
// growing edits and undo restores that would push the total past LIMITS.boardBytes fail with
// "limit". Comment counts and bytes per card are cached lazily (the board is the only writer).
// One request may remove at most LIMITS.columnDeleteComments comments, and a column delete is
// refused when the column holds more than LIMITS.columnDeleteCards cards, which keeps each
// commit's key count small enough for one storage transaction.
//
// Idempotency: a request carrying a valid requestId is recorded ("requests", bounded) in the same
// commit as its changes, or in a records-only commit when nothing changed. A replay of a recorded
// requestId returns the recorded outcome with duplicate: true and applies nothing.

import {
  DEFAULT_COLUMNS, DEFAULT_LABELS, DEFAULT_TITLE, LIMITS, SCHEMA_VERSION,
  cleanCardPatch, cleanColor, cleanLabelIds, cleanLine, cleanName, cleanText, compareCards, isId,
  isRequestId, newId as protocolNewId,
} from "../shared/protocol.js";
import { isValidOrderKey, keyBetween } from "../shared/order.js";

/** @typedef {import("../shared/protocol.js").BoardMeta} BoardMeta */
/** @typedef {import("../shared/protocol.js").BoardSnapshot} BoardSnapshot */
/** @typedef {import("../shared/protocol.js").BoardEvent} BoardEvent */
/** @typedef {import("../shared/protocol.js").Card} Card */
/** @typedef {import("../shared/protocol.js").Column} Column */
/** @typedef {import("../shared/protocol.js").Label} Label */
/** @typedef {import("../shared/protocol.js").Comment} Comment */
/** @typedef {import("../shared/protocol.js").HistoryEntry} HistoryEntry */
/** @typedef {import("../shared/protocol.js").OperationResult} OperationResult */
/** @typedef {import("../shared/protocol.js").OpError} OpError */
/** @typedef {import("../shared/protocol.js").Conflict} Conflict */
/** @typedef {import("../shared/protocol.js").RequestRecord} RequestRecord */
/** @typedef {import("./repository.js").Repository} Repository */

const CONTENT_FIELDS = /** @type {const} */ (["title", "description", "labels", "assignee", "due", "checklist"]);
const DEFAULT_LABEL_COLOR = "#6b7280";
const UNTITLED_COLUMN = "Untitled column";
/** A single request record is shrunk (errors, then conflicts halved) to fit in this many bytes. */
const RECORD_MAX_BYTES = 16 * 1024;
const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------------------------

/**
 * Upgrades stored meta to SCHEMA_VERSION and repairs its shape. Returns the same object when
 * nothing needed changing, otherwise a new one (which the caller writes back).
 * @param {BoardMeta} meta
 * @returns {BoardMeta}
 */
export function migrate(meta) {
  let out = meta;
  const edit = () => (out === meta ? (out = { ...meta }) : out);
  if (typeof meta.schemaVersion !== "number" || meta.schemaVersion < SCHEMA_VERSION) {
    // Future: step through versions here, e.g. `if (v < 2) { ... }`.
    edit().schemaVersion = SCHEMA_VERSION;
  }
  const columns = meta.columns && typeof meta.columns === "object" ? meta.columns : {};
  const order = Array.isArray(meta.columnOrder) ? meta.columnOrder : [];
  const fixedOrder = order.filter((id, i) => Object.hasOwn(columns, id) && order.indexOf(id) === i);
  for (const id of Object.keys(columns)) if (!fixedOrder.includes(id)) fixedOrder.push(id);
  if (columns !== meta.columns || fixedOrder.length !== order.length ||
      fixedOrder.some((id, i) => id !== order[i])) {
    edit().columns = columns;
    out.columnOrder = fixedOrder;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** @param {unknown} v */
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** @param {unknown} v @param {number} max */
function cleanId(v, max = 64) {
  return typeof v === "string" ? cleanLine(v, max) : "";
}

/**
 * Upper bound of the stored size of `value`: UTF-8 bytes of its JSON, or two bytes per UTF-16
 * unit when any character is outside Latin-1 (how V8 serialises such strings). Always at least
 * the JSON byte count the LIMITS are specified in.
 * @param {unknown} value
 */
export function storedBytes(value) {
  const json = JSON.stringify(value) ?? "";
  const utf8 = new TextEncoder().encode(json).length;
  return /[^\u0000-\u00ff]/.test(json) ? Math.max(utf8, json.length * 2) : utf8;
}

/** @param {string} text */
function quote(text) {
  const t = text || "Untitled";
  return '"' + (t.length > 60 ? t.slice(0, 59) + "…" : t) + '"';
}

/** @param {Card} card */
function contentOf(card) {
  return {
    title: card.title, description: card.description, labels: card.labels,
    assignee: card.assignee, due: card.due, checklist: card.checklist,
  };
}

/**
 * @param {string} kind @param {number} index @param {string} code @param {string} message
 * @returns {OpError}
 */
function opError(kind, index, code, message) {
  return /** @type {OpError} */ ({ kind, index, code, message });
}

/**
 * baseVersion: undefined when absent, NaN when present but not a non-negative safe integer.
 * @param {unknown} v
 */
function parseBase(v) {
  if (v === undefined) return undefined;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : NaN;
}

/** @param {number} revision @param {OpError[]} errors @returns {OperationResult} */
function emptyResult(revision, errors = [], conflicts = []) {
  return {
    status: conflicts.length ? "conflict" : "unchanged", revision, upserts: [], deletes: [],
    moved: [], structure: null, labels: null, history: null, conflicts, errors,
  };
}

// ---------------------------------------------------------------------------------------------
// createBoard
// ---------------------------------------------------------------------------------------------

/**
 * @param {Repository} repo
 * @param {{now?: () => number, newId?: typeof protocolNewId,
 *   onEvent?: (event: BoardEvent) => void}} [options]
 *   onEvent is called inside the mutation queue right after each successful commit, so events
 *   are emitted in revision order. It must not block; errors it throws are swallowed.
 */
export function createBoard(repo, { now = Date.now, newId = protocolNewId, onEvent } = {}) {
  // --- Mutation queue ------------------------------------------------------------------------
  let queue = /** @type {Promise<unknown>} */ (Promise.resolve());
  /**
   * @template T
   * @param {() => Promise<T>|T} fn
   * @returns {Promise<T>}
   */
  function enqueue(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }

  /** @param {BoardEvent|null} event */
  function emit(event) {
    if (!event || !onEvent) return;
    try { onEvent(event); } catch { /* a broken listener must not fail a committed write */ }
  }

  // --- Cached state --------------------------------------------------------------------------
  // The board is the only writer, so state is loaded once and replaced after each commit. A
  // failed commit drops the cache so the next call reloads from storage.

  /**
   * @typedef {object} State
   * @property {BoardMeta} meta
   * @property {Record<string, Label>} labels
   * @property {Map<string, Card>} cards
   * @property {HistoryEntry[]} history
   * @property {RequestRecord[]} requests
   * @property {Map<string, number>} sizes      storedBytes of each card
   * @property {number} boardBytes              sum of sizes
   * @property {Map<string, {count: number, bytes: number}>} comments  lazily loaded per card
   */
  /** @type {State|null} */
  let state = null;

  /** @returns {Promise<State>} */
  async function load() {
    if (state) return state;
    const stored = await repo.getMeta();
    if (!stored) {
      const at = now();
      /** @type {BoardMeta} */
      const meta = {
        schemaVersion: SCHEMA_VERSION, revision: 0, title: DEFAULT_TITLE, columnOrder: [],
        columns: {}, lastModified: at,
      };
      for (const name of DEFAULT_COLUMNS) {
        const id = newId("column");
        meta.columnOrder.push(id);
        meta.columns[id] = { id, name, version: 1, collapsed: false };
      }
      /** @type {Record<string, Label>} */
      const labels = {};
      for (const { name, color } of DEFAULT_LABELS) {
        const id = newId("label");
        labels[id] = { id, name, color };
      }
      await repo.commit({ meta, labels, history: [] });
      state = { meta, labels, cards: new Map(), history: [], requests: [], sizes: new Map(), boardBytes: 0, comments: new Map() };
      return state;
    }
    const meta = migrate(stored);
    if (meta !== stored) await repo.commit({ meta });
    const [labels, cards, history, requests] = await Promise.all([
      repo.getLabels(), repo.getCards(), repo.getHistory(), repo.getRequests(),
    ]);
    const sizes = new Map();
    let boardBytes = 0;
    for (const [id, card] of Object.entries(cards)) {
      const size = storedBytes(card);
      sizes.set(id, size);
      boardBytes += size;
    }
    state = {
      meta, labels, cards: new Map(Object.entries(cards)), history,
      requests: Array.isArray(requests) ? requests : [], sizes, boardBytes, comments: new Map(),
    };
    return state;
  }

  /**
   * Comment count and bytes of one card, loaded from the repository on first use.
   * @param {State} s @param {string} cardId
   */
  async function commentStats(s, cardId) {
    let stats = s.comments.get(cardId);
    if (!stats) {
      const list = await repo.getComments(cardId);
      stats = { count: list.length, bytes: list.reduce((n, c) => n + storedBytes(c), 0) };
      s.comments.set(cardId, stats);
    }
    return stats;
  }

  // --- Request records (idempotency) ---------------------------------------------------------

  /** @param {unknown} v @returns {string|null} */
  const requestIdOf = (v) => (isRequestId(v) ? v : null);

  /**
   * The request list with `result` recorded under `requestId`, trimmed to the LIMITS.
   * @param {State} s @param {string} requestId @param {OperationResult} result
   * @returns {RequestRecord[]}
   */
  function withRecord(s, requestId, result) {
    /** @type {RequestRecord} */
    const record = structuredClone({
      requestId, revision: result.revision, status: result.status,
      conflicts: result.conflicts.map(({ kind, id }) => ({ kind, id })), errors: result.errors,
    });
    while (storedBytes(record) > RECORD_MAX_BYTES && record.errors.length > 1) {
      record.errors = record.errors.slice(0, Math.ceil(record.errors.length / 2));
    }
    while (storedBytes(record) > RECORD_MAX_BYTES && record.conflicts.length > 1) {
      record.conflicts = record.conflicts.slice(0, Math.ceil(record.conflicts.length / 2));
    }
    const requests = [...s.requests.filter((r) => r.requestId !== requestId), record];
    while (requests.length > LIMITS.requestRecords) requests.shift();
    while (requests.length > 1 && storedBytes(requests) > LIMITS.requestRecordBytes) requests.shift();
    return requests;
  }

  /**
   * The recorded answer for a replayed requestId, or null when it has not been seen.
   * @param {State} s @param {string|null} requestId
   * @returns {OperationResult|null}
   */
  function duplicateOf(s, requestId) {
    if (!requestId) return null;
    const record = s.requests.find((r) => r.requestId === requestId);
    if (!record) return null;
    return structuredClone({
      status: record.status, revision: s.meta.revision, upserts: [], deletes: [], moved: [],
      structure: null, labels: null, history: null,
      conflicts: record.conflicts.map(({ kind, id }) => ({
        kind, id,
        current: (kind === "card" ? s.cards.get(id) : Object.hasOwn(s.meta.columns, id) ? s.meta.columns[id] : null) ?? null,
      })),
      errors: record.errors, duplicate: true,
    });
  }

  /**
   * Records a request that changed nothing (records-only commit, no revision bump) and returns
   * the outcome unchanged.
   * @param {State} s @param {string|null} requestId @param {OperationResult} result
   * @returns {Promise<{result: OperationResult, event: null}>}
   */
  async function finishUnchanged(s, requestId, result) {
    if (requestId) {
      const requests = withRecord(s, requestId, result);
      try {
        await repo.commit({ requests });
      } catch (e) {
        state = null;
        throw e;
      }
      s.requests = requests;
    }
    return { result, event: null };
  }

  /** @param {State} s @returns {BoardSnapshot} */
  function snapshot(s) {
    return structuredClone({
      schemaVersion: s.meta.schemaVersion, revision: s.meta.revision, title: s.meta.title,
      columnOrder: s.meta.columnOrder, columns: s.meta.columns,
      cards: Object.fromEntries(s.cards), labels: s.labels, lastModified: s.meta.lastModified,
    });
  }

  // --- Applying a request --------------------------------------------------------------------

  /**
   * @param {any} rawReq
   * @param {{force?: boolean, summaryPrefix?: string}} [mode]
   *   force: undo mode. No version checks, and a card upsert carrying `columnId` recreates a
   *   missing card (restoring `restore.{createdAt, createdBy, version}`). Never reachable from
   *   the public applyOperation.
   * @returns {Promise<{result: OperationResult, event: BoardEvent|null}>}
   */
  async function applyLocked(rawReq, { force = false, summaryPrefix = "" } = {}) {
    const s = await load();
    const req = isObject(rawReq) ? rawReq : {};
    const requestId = requestIdOf(req.requestId);
    const duplicate = duplicateOf(s, requestId);
    if (duplicate) return { result: duplicate, event: null };
    /** @type {OpError[]} */
    const errors = [];
    /** @type {Conflict[]} */
    const conflicts = [];

    // Request shape and size.
    /** @type {Record<"cardOps"|"columnOps"|"labelOps", any[]>} */
    const lists = { cardOps: [], columnOps: [], labelOps: [] };
    const kindOf = { cardOps: "card", columnOps: "column", labelOps: "label" };
    for (const key of /** @type {const} */ (["cardOps", "columnOps", "labelOps"])) {
      const v = req[key];
      if (v === undefined || v === null) continue;
      if (!Array.isArray(v)) errors.push(opError(kindOf[key], -1, "invalid_op", `${key} must be an array`));
      else lists[key] = v;
    }
    const total = lists.cardOps.length + lists.columnOps.length + lists.labelOps.length;
    if (total > LIMITS.opsPerRequest) {
      errors.push(opError("structure", -1, "limit",
        `A request may carry at most ${LIMITS.opsPerRequest} ops; this one has ${total}. Nothing was applied.`));
      return finishUnchanged(s, requestId, emptyResult(s.meta.revision, errors));
    }

    const senderId = cleanId(req.senderId);
    const by = cleanName(req.by, "Anonymous");
    const at = now();

    // Working copies. Cards are replaced, never mutated, so identity tells what changed.
    /** @type {BoardMeta} */
    const meta = structuredClone(s.meta);
    /** @type {Record<string, Label>} */
    let labels = structuredClone(s.labels);
    const cards = new Map(s.cards);
    /** @type {Set<string>} */
    const touched = new Set();
    /** @type {Set<string>} cards removed by a column delete (described by the column) */
    const cascaded = new Set();

    // Size budget, tracked across the ops of this request.
    const sizes = new Map(s.sizes);
    let boardBytes = s.boardBytes;
    /** @param {string} id @param {number} size */
    const setSize = (id, size) => { boardBytes += size - (sizes.get(id) ?? 0); sizes.set(id, size); };
    /** @param {string} id */
    const dropSize = (id) => { boardBytes -= sizes.get(id) ?? 0; sizes.delete(id); };
    /** True when writing `size` for card `id` stays within budget or does not grow the card. */
    const fitsBudget = (/** @type {string} */ id, /** @type {number} */ size) => {
      const old = sizes.get(id) ?? 0;
      return size <= old || boardBytes - old + size <= LIMITS.boardBytes;
    };
    const budgetMessage = `The board is full: cards may take at most ${LIMITS.boardBytes / MIB} MiB in total. Shorten or delete cards first.`;

    // Comments removed by this request (card deletes and column cascades).
    let commentDeletes = 0;
    /** Stored comment count of a card; 0 for cards that did not exist before this request. */
    const commentCount = (/** @type {string} */ id) => (s.cards.has(id) ? s.comments.get(id)?.count ?? 0 : 0);
    for (const op of lists.cardOps) {
      if (isObject(op) && op.op === "delete" && isId(op.cardId, "card") && s.cards.has(op.cardId)) {
        await commentStats(s, op.cardId);
      }
    }

    /**
     * Runs one op, turning any exception into an invalid_op error.
     * @param {string} kind @param {number} index @param {() => void} fn
     */
    const guard = (kind, index, fn) => {
      try { fn(); } catch (e) {
        errors.push(opError(kind, index, "invalid_op", "Invalid operation: " + cleanLine(/** @type {any} */ (e)?.message, 200)));
      }
    };

    // ---- 1. Labels (last-writer-wins) ----
    lists.labelOps.forEach((op, i) => guard("label", i, () => {
      if (!isObject(op)) return void errors.push(opError("label", i, "invalid_op", "Op must be an object"));
      if (!isId(op.labelId, "label")) return void errors.push(opError("label", i, "invalid_id", "labelId must look like l_1a2b3c4d"));
      const id = /** @type {string} */ (op.labelId);
      if (op.op === "upsert") {
        const patch = isObject(op.label) ? op.label : {};
        const existing = Object.hasOwn(labels, id) ? labels[id] : null;
        if (!existing && Object.keys(labels).length >= LIMITS.labels) {
          return void errors.push(opError("label", i, "limit", `A board may have at most ${LIMITS.labels} labels`));
        }
        const name = cleanLine(typeof patch.name === "string" ? patch.name : "", LIMITS.labelName);
        labels = { ...labels, [id]: {
          id,
          name: name || existing?.name || "Label",
          color: cleanColor(patch.color) ?? existing?.color ?? DEFAULT_LABEL_COLOR,
        } };
      } else if (op.op === "delete") {
        if (Object.hasOwn(labels, id)) {
          const next = { ...labels };
          delete next[id];
          labels = next;
        }
      } else {
        errors.push(opError("label", i, "invalid_op", 'Label op must be "upsert" or "delete"'));
      }
    }));

    // ---- Columns ----
    /** @param {unknown} v @param {number} max */
    const clampIndex = (v, max) =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.trunc(v))) : max;

    /**
     * Shared checks for column ops. Returns the column id, or null after recording an error.
     * @param {any} op @param {number} i
     */
    const columnIdOf = (op, i) => {
      if (!isObject(op)) { errors.push(opError("column", i, "invalid_op", "Op must be an object")); return null; }
      if (!["upsert", "move", "delete"].includes(op.op)) {
        errors.push(opError("column", i, "invalid_op", 'Column op must be "upsert", "move" or "delete"'));
        return null;
      }
      if (!isId(op.columnId, "column")) {
        errors.push(opError("column", i, "invalid_id", "columnId must look like k_1a2b3c4d"));
        return null;
      }
      return /** @type {string} */ (op.columnId);
    };

    /**
     * Version check for renames and deletes. Returns false after recording an error/conflict.
     * @param {any} op @param {number} i @param {string} id
     */
    const columnVersionOk = (op, i, id) => {
      if (force) return true;
      const base = parseBase(op.baseVersion);
      if (base === undefined || Number.isNaN(base)) {
        errors.push(opError("column", i, "invalid_op", "baseVersion (a non-negative integer) is required"));
        return false;
      }
      const current = Object.hasOwn(meta.columns, id) ? meta.columns[id] : null;
      const startVersion = Object.hasOwn(s.meta.columns, id) ? s.meta.columns[id].version : 0;
      if (!current || (current.version !== base && startVersion !== base)) {
        conflicts.push({ kind: "column", id, current: current ? structuredClone(current) : null });
        return false;
      }
      return true;
    };

    // ---- 2. Column upserts and moves ----
    lists.columnOps.forEach((op, i) => guard("column", i, () => {
      if (isObject(op) && op.op === "delete") return; // step 4
      const id = columnIdOf(op, i);
      if (!id) return;
      const exists = Object.hasOwn(meta.columns, id);
      if (op.op === "move") {
        if (!exists) return void errors.push(opError("column", i, "unknown_column", `No column ${id}`));
        if (typeof op.index !== "number" || !Number.isFinite(op.index)) {
          return void errors.push(opError("column", i, "invalid_op", "index must be a number"));
        }
        const order = meta.columnOrder.filter((c) => c !== id);
        order.splice(clampIndex(op.index, order.length), 0, id);
        meta.columnOrder = order;
        return;
      }
      // upsert
      const patch = isObject(op.column) ? op.column : {};
      if ("name" in patch && typeof patch.name !== "string") {
        return void errors.push(opError("column", i, "invalid_op", "column.name must be a string"));
      }
      if ("collapsed" in patch && typeof patch.collapsed !== "boolean") {
        return void errors.push(opError("column", i, "invalid_op", "column.collapsed must be a boolean"));
      }
      const base = parseBase(op.baseVersion);
      if (!exists) {
        if (!force && base !== 0 && base !== undefined) {
          if (Number.isNaN(base)) return void errors.push(opError("column", i, "invalid_op", "baseVersion must be a non-negative integer"));
          return void conflicts.push({ kind: "column", id, current: null });
        }
        if (meta.columnOrder.length >= LIMITS.columns) {
          return void errors.push(opError("column", i, "limit", `A board may have at most ${LIMITS.columns} columns`));
        }
        meta.columns[id] = {
          id, name: cleanLine(patch.name, LIMITS.columnName) || UNTITLED_COLUMN, version: 1,
          collapsed: patch.collapsed === true,
        };
        meta.columnOrder.splice(clampIndex(op.index, meta.columnOrder.length), 0, id);
        return;
      }
      if (!force && base === 0 && Object.hasOwn(s.meta.columns, id)) {
        return void errors.push(opError("column", i, "exists", `Column ${id} already exists`));
      }
      const column = { ...meta.columns[id] };
      if ("name" in patch) {
        if (!columnVersionOk(op, i, id)) return;
        const name = cleanLine(patch.name, LIMITS.columnName);
        if (name && name !== column.name) {
          // One version bump per request, however many renames it carries.
          const startVersion = Object.hasOwn(s.meta.columns, id) ? s.meta.columns[id].version : 0;
          if (column.version === startVersion) column.version += 1;
          column.name = name;
        }
      }
      if ("collapsed" in patch) column.collapsed = patch.collapsed;
      meta.columns[id] = column;
    }));

    // ---- 3. Cards ----
    /**
     * Key after the last card of `columnId`, ignoring `excludeId`.
     * @param {string} columnId @param {string} excludeId
     */
    const appendKey = (columnId, excludeId) => {
      let last = null;
      for (const c of cards.values()) {
        if (c.columnId !== columnId || c.id === excludeId) continue;
        if (last === null || c.order > last) last = c.order;
      }
      try {
        const key = keyBetween(last, null);
        if (isValidOrderKey(key)) return key;
      } catch { /* fall through */ }
      return keyBetween(null, null);
    };

    /** @param {Card} card True when no other card of its column sorts after it. */
    const isLastIn = (card) => {
      for (const c of cards.values()) {
        if (c.columnId === card.columnId && c.id !== card.id && compareCards(c, card) > 0) return false;
      }
      return true;
    };

    /** @param {string} id */
    const startVersion = (id) => s.cards.get(id)?.version ?? 0;

    /** @param {string} id @param {Card} current @param {number} base */
    const cardVersionOk = (id, current, base) =>
      base === current.version || (touched.has(id) && base === startVersion(id));

    /** @param {string} id @param {Card} current */
    const bumpedVersion = (id, current) =>
      touched.has(id) && current.version !== startVersion(id) ? current.version : current.version + 1;

    /** @param {Card} card */
    const stripLabels = (card) => cleanLabelIds(card.labels, labels);

    lists.cardOps.forEach((op, i) => guard("card", i, () => {
      if (!isObject(op)) return void errors.push(opError("card", i, "invalid_op", "Op must be an object"));
      if (!["upsert", "move", "delete"].includes(op.op)) {
        return void errors.push(opError("card", i, "invalid_op", 'Card op must be "upsert", "move" or "delete"'));
      }
      if (!isId(op.cardId, "card")) return void errors.push(opError("card", i, "invalid_id", "cardId must look like c_1a2b3c4d"));
      const id = /** @type {string} */ (op.cardId);
      const base = parseBase(op.baseVersion);
      if (!force && (base === undefined || Number.isNaN(base))) {
        return void errors.push(opError("card", i, "invalid_op", "baseVersion (a non-negative integer) is required"));
      }
      const current = cards.get(id) ?? null;

      if (!current) {
        const creating = op.op === "upsert" && (force ? typeof op.columnId === "string" : base === 0);
        if (!creating) {
          if (!force && /** @type {number} */ (base) > 0) return void conflicts.push({ kind: "card", id, current: null });
          return void errors.push(opError("card", i, "unknown_card", `No card ${id}`));
        }
        if (touched.has(id)) {
          return void errors.push(opError("card", i, "exists", `Card ${id} was deleted earlier in this request and cannot be recreated in it`));
        }
        if (!isId(op.columnId, "column") || !Object.hasOwn(meta.columns, op.columnId)) {
          return void errors.push(opError("card", i, "unknown_column", `No column ${String(op.columnId).slice(0, 40)}`));
        }
        if (cards.size >= LIMITS.cards) {
          return void errors.push(opError("card", i, "limit", `A board may have at most ${LIMITS.cards} cards`));
        }
        const columnId = /** @type {string} */ (op.columnId);
        const patch = cleanCardPatch(op.card, labels);
        const restore = force && isObject(op.restore) ? op.restore : {};
        const order = isObject(op.card) && isValidOrderKey(op.card.order) ? op.card.order : appendKey(columnId, id);
        /** @type {Card} */
        const card = {
          id, columnId, order,
          title: patch.title ?? "", description: patch.description ?? "", labels: patch.labels ?? [],
          assignee: patch.assignee ?? "", due: patch.due ?? null, checklist: patch.checklist ?? [],
          version: Number.isSafeInteger(restore.version) && restore.version > 0 ? restore.version + 1 : 1,
          createdAt: Number.isFinite(restore.createdAt) ? restore.createdAt : at,
          updatedAt: at,
          createdBy: typeof restore.createdBy === "string" ? cleanName(restore.createdBy, by) : by,
        };
        const size = storedBytes(card);
        if (!fitsBudget(id, size)) return void errors.push(opError("card", i, "limit", budgetMessage));
        cards.set(id, card);
        setSize(id, size);
        touched.add(id);
        return;
      }

      if (!force) {
        const b = /** @type {number} */ (base);
        if (op.op === "upsert" && b === 0 && !cardVersionOk(id, current, b)) {
          return void errors.push(opError("card", i, "exists", `Card ${id} already exists`));
        }
        if (!cardVersionOk(id, current, b)) return void conflicts.push({ kind: "card", id, current: structuredClone(current) });
      }

      if (op.op === "delete") {
        const n = commentCount(id);
        if (commentDeletes + n > LIMITS.columnDeleteComments) {
          return void errors.push(opError("card", i, "limit",
            `This request would delete more than ${LIMITS.columnDeleteComments} comments; delete fewer cards at once.`));
        }
        commentDeletes += n;
        cards.delete(id);
        dropSize(id);
        touched.add(id);
        return;
      }

      if (op.op === "move") {
        const to = op.toColumnId;
        if (to === undefined) return void errors.push(opError("card", i, "invalid_op", "toColumnId is required"));
        if (!isId(to, "column") || !Object.hasOwn(meta.columns, to)) {
          return void errors.push(opError("card", i, "unknown_column", `No column ${String(to).slice(0, 40)}`));
        }
        let order;
        if (isValidOrderKey(op.order)) order = op.order;
        else if (to === current.columnId && isLastIn(current)) order = current.order;
        else order = appendKey(to, id);
        const nextLabels = stripLabels(current);
        if (to === current.columnId && order === current.order && nextLabels.length === current.labels.length) return;
        /** @type {Card} */
        const relocated = {
          ...current, columnId: to, order, labels: nextLabels,
          version: bumpedVersion(id, current), updatedAt: at,
        };
        // Moves are never refused for size: they grow a card by at most an order key.
        cards.set(id, relocated);
        setSize(id, storedBytes(relocated));
        touched.add(id);
        return;
      }

      // upsert: patch the listed fields
      const patch = cleanCardPatch(op.card, labels);
      delete patch.order;
      const next = { ...current, ...patch };
      if (isObject(op.card) && isValidOrderKey(op.card.order)) next.order = op.card.order;
      next.labels = stripLabels(next);
      if (JSON.stringify(contentOf(next)) === JSON.stringify(contentOf(current)) && next.order === current.order) return;
      next.version = bumpedVersion(id, current);
      next.updatedAt = at;
      const size = storedBytes(next);
      if (!fitsBudget(id, size)) return void errors.push(opError("card", i, "limit", budgetMessage));
      cards.set(id, next);
      setSize(id, size);
      touched.add(id);
    }));

    // ---- 4. Column deletes (cascade to cards) ----
    // Load comment counts for the cards that deletes could cascade to (bounded by the card cap).
    for (const op of lists.columnOps) {
      if (!isObject(op) || op.op !== "delete" || !isId(op.columnId, "column")) continue;
      const inColumn = [...cards.values()].filter((c) => c.columnId === op.columnId);
      if (inColumn.length > LIMITS.columnDeleteCards) continue;
      for (const c of inColumn) if (s.cards.has(c.id)) await commentStats(s, c.id);
    }
    lists.columnOps.forEach((op, i) => {
      if (!isObject(op) || op.op !== "delete") return;
      guard("column", i, () => {
        const id = columnIdOf(op, i);
        if (!id) return;
        if (!Object.hasOwn(meta.columns, id)) {
          if (!force && parseBase(op.baseVersion) === undefined) {
            return void errors.push(opError("column", i, "invalid_op", "baseVersion (a non-negative integer) is required"));
          }
          if (!force && /** @type {number} */ (parseBase(op.baseVersion)) > 0) return void conflicts.push({ kind: "column", id, current: null });
          return void errors.push(opError("column", i, "unknown_column", `No column ${id}`));
        }
        if (!columnVersionOk(op, i, id)) return;
        const inColumn = [...cards.values()].filter((c) => c.columnId === id);
        const name = quote(meta.columns[id].name);
        if (inColumn.length > LIMITS.columnDeleteCards) {
          return void errors.push(opError("column", i, "limit",
            `Column ${name} has ${inColumn.length} cards; a column can only be deleted with at most ${LIMITS.columnDeleteCards} cards in it. Move or delete cards first.`));
        }
        const comments = inColumn.reduce((n, c) => n + commentCount(c.id), 0);
        if (commentDeletes + comments > LIMITS.columnDeleteComments) {
          return void errors.push(opError("column", i, "limit",
            `The cards in column ${name} have too many comments to delete at once (at most ${LIMITS.columnDeleteComments} per change). Move or delete cards first.`));
        }
        commentDeletes += comments;
        delete meta.columns[id];
        meta.columnOrder = meta.columnOrder.filter((c) => c !== id);
        for (const card of inColumn) {
          cards.delete(card.id);
          dropSize(card.id);
          touched.add(card.id);
          cascaded.add(card.id);
        }
      });
    });

    // ---- 5. Structure (last-writer-wins) ----
    if (req.structure !== undefined && req.structure !== null) {
      guard("structure", -1, () => {
        if (!isObject(req.structure)) return void errors.push(opError("structure", -1, "invalid_op", "structure must be an object"));
        if (!("title" in req.structure)) return;
        if (typeof req.structure.title !== "string") return void errors.push(opError("structure", -1, "invalid_op", "structure.title must be a string"));
        meta.title = cleanLine(req.structure.title, LIMITS.boardTitle) || DEFAULT_TITLE;
      });
    }

    // ---- Diff against the state before the request ----
    /** @type {Card[]} */
    const upserts = [];
    /** @type {{cardId: string, columnId: string}[]} */
    const deletes = [];
    /** @type {{cardId: string, fromColumnId: string, toColumnId: string}[]} */
    const moved = [];
    /** @type {string[]} */
    const descriptions = [];
    /** @type {any[]} */
    const inverseCardOps = [];
    let invertible = true;
    const columnName = (/** @type {string} */ id) =>
      (meta.columns[id] ?? s.meta.columns[id])?.name ?? "a deleted column";

    for (const id of touched) {
      const before = s.cards.get(id);
      const after = cards.get(id);
      if (before === after) continue;
      if (!before && after) {
        upserts.push(after);
        descriptions.push(`Created ${quote(after.title)}`);
        inverseCardOps.push({ op: "delete", cardId: id });
      } else if (before && !after) {
        deletes.push({ cardId: id, columnId: before.columnId });
        if (!cascaded.has(id)) descriptions.push(`Deleted ${quote(before.title)}`);
        inverseCardOps.push({
          op: "upsert", cardId: id, columnId: before.columnId,
          card: { ...contentOf(before), order: before.order },
          restore: { createdAt: before.createdAt, createdBy: before.createdBy, version: before.version },
        });
      } else if (before && after) {
        upserts.push(after);
        const edited = JSON.stringify(contentOf(before)) !== JSON.stringify(contentOf(after));
        const movedCard = before.columnId !== after.columnId || before.order !== after.order;
        if (movedCard) {
          moved.push({ cardId: id, fromColumnId: before.columnId, toColumnId: after.columnId });
          descriptions.push(before.columnId !== after.columnId
            ? `Moved ${quote(after.title)} to ${columnName(after.columnId)}`
            : `Reordered ${quote(after.title)} in ${columnName(after.columnId)}`);
        } else if (edited) {
          descriptions.push(`Edited ${quote(after.title)}`);
        }
        if (edited) {
          /** @type {Record<string, unknown>} */
          const card = {};
          const b = contentOf(before), a = contentOf(after);
          for (const f of CONTENT_FIELDS) if (JSON.stringify(b[f]) !== JSON.stringify(a[f])) card[f] = b[f];
          inverseCardOps.push({ op: "upsert", cardId: id, card });
        }
        if (movedCard) inverseCardOps.push({ op: "move", cardId: id, toColumnId: before.columnId, order: before.order });
      }
    }

    // Columns and structure.
    let structureChanged = meta.title !== s.meta.title;
    if (meta.title !== s.meta.title) {
      descriptions.push(`Renamed board to ${quote(meta.title)}`);
      invertible = false;
    }
    /** @type {any[]} */
    const inverseColumnOps = [];
    for (const id of s.meta.columnOrder) {
      const before = s.meta.columns[id];
      const after = meta.columns[id];
      if (!after) {
        structureChanged = true;
        invertible = false;
        descriptions.push(`Deleted column ${quote(before.name)}`);
        continue;
      }
      /** @type {Record<string, unknown>} */
      const column = {};
      if (after.name !== before.name) {
        descriptions.push(`Renamed column ${quote(before.name)} to ${quote(after.name)}`);
        column.name = before.name;
      }
      if (after.collapsed !== before.collapsed) {
        descriptions.push(`${after.collapsed ? "Collapsed" : "Expanded"} column ${quote(after.name)}`);
        column.collapsed = before.collapsed;
      }
      if (Object.keys(column).length) {
        structureChanged = true;
        inverseColumnOps.push({ op: "upsert", columnId: id, column });
      }
    }
    for (const id of meta.columnOrder) {
      if (s.meta.columns[id]) continue;
      structureChanged = true;
      invertible = false;
      descriptions.push(`Added column ${quote(meta.columns[id].name)}`);
    }
    const keptBefore = s.meta.columnOrder.filter((id) => meta.columns[id]);
    const keptAfter = meta.columnOrder.filter((id) => s.meta.columns[id]);
    if (keptBefore.some((id, i) => id !== keptAfter[i])) {
      structureChanged = true;
      descriptions.push("Reordered columns");
      const first = keptBefore.findIndex((id, i) => id !== keptAfter[i]);
      for (let i = first; i < keptBefore.length - 1; i++) inverseColumnOps.push({ op: "move", columnId: keptBefore[i], index: i });
    }
    const labelsChanged = JSON.stringify(labels) !== JSON.stringify(s.labels);
    if (labelsChanged) {
      descriptions.push("Updated labels");
      invertible = false;
    }

    const changed = upserts.length > 0 || deletes.length > 0 || structureChanged || labelsChanged;
    if (!changed) return finishUnchanged(s, requestId, structuredClone(emptyResult(s.meta.revision, errors, conflicts)));

    // ---- History entry ----
    let inverse = null;
    if (invertible && (inverseCardOps.length || inverseColumnOps.length)) {
      /** @type {Record<string, any[]>} */
      const inv = {};
      if (inverseCardOps.length) inv.cardOps = inverseCardOps;
      if (inverseColumnOps.length) inv.columnOps = inverseColumnOps;
      inverse = storedBytes(inv) <= LIMITS.inverseBytes ? structuredClone(inv) : null;
    }
    const summary = (summaryPrefix + (descriptions.length === 1 ? descriptions[0] : `${descriptions.length} changes`))
      .slice(0, LIMITS.summary);
    /** @type {HistoryEntry} */
    const entry = { id: newId("history"), at, by, summary, inverse: /** @type {any} */ (inverse) };
    const history = [...s.history, entry];
    while (history.length > LIMITS.historyEntries) history.shift();
    while (history.length > 1 && storedBytes(history) > LIMITS.historyBytes) history.shift();

    // ---- Commit ----
    meta.revision = s.meta.revision + 1;
    meta.lastModified = at;
    const deletedIds = deletes.map((d) => d.cardId);
    const structure = structureChanged
      ? { title: meta.title, columnOrder: meta.columnOrder, columns: meta.columns }
      : null;
    /** @type {OperationResult} */
    const result = structuredClone({
      status: conflicts.length ? "conflict" : "applied", revision: meta.revision, upserts, deletes,
      moved, structure, labels: labelsChanged ? labels : null, history: entry, conflicts, errors,
    });
    const requests = requestId ? withRecord(s, requestId, result) : s.requests;
    try {
      await repo.commit({
        meta,
        ...(labelsChanged ? { labels } : {}),
        putCards: upserts,
        deleteCards: deletedIds,
        deleteCommentsFor: deletedIds,
        history,
        ...(requestId ? { requests } : {}),
      });
    } catch (e) {
      state = null;
      throw e;
    }
    for (const id of deletedIds) s.comments.delete(id);
    state = { meta, labels, cards, history, requests, sizes, boardBytes, comments: s.comments };

    /** @type {BoardEvent} */
    const event = structuredClone({
      type: "operation", senderId, revision: meta.revision, upserts, deletes, moved, structure,
      labels: labelsChanged ? labels : null, history: entry, lastModified: meta.lastModified,
    });
    emit(event);
    return { result, event };
  }

  // --- Convenience resolution ----------------------------------------------------------------

  /** @param {State} s @param {unknown} ref @returns {string|null} */
  function resolveColumn(s, ref) {
    if (typeof ref !== "string") return null;
    if (Object.hasOwn(s.meta.columns, ref)) return ref;
    const name = ref.trim().toLowerCase();
    return s.meta.columnOrder.find((id) => s.meta.columns[id].name.toLowerCase() === name) ?? null;
  }

  /** @param {State} s @param {unknown} ref @returns {string|null} */
  function resolveLabel(s, ref) {
    if (typeof ref !== "string") return null;
    if (Object.hasOwn(s.labels, ref)) return ref;
    const name = ref.trim().toLowerCase();
    return Object.values(s.labels).find((l) => l.name.toLowerCase() === name)?.id ?? null;
  }

  /**
   * Turns friendly card fields (label names, checklist strings) into a card patch.
   * @param {State} s @param {any} fields
   */
  function friendlyPatch(s, fields) {
    /** @type {Record<string, unknown>} */
    const out = {};
    if (!isObject(fields)) return out;
    for (const f of ["title", "description", "assignee", "due"]) if (f in fields) out[f] = fields[f];
    if ("labels" in fields) {
      const list = Array.isArray(fields.labels) ? fields.labels : [fields.labels];
      out.labels = list.map((l) => resolveLabel(s, l)).filter(Boolean);
    }
    if ("checklist" in fields) {
      out.checklist = Array.isArray(fields.checklist)
        ? fields.checklist.map((/** @type {unknown} */ item) => typeof item === "string" ? { text: item, done: false } : item)
        : [];
    }
    return out;
  }

  /** @param {number} revision @param {string} code @param {string} message */
  const errorOnly = (revision, code, message) =>
    ({ result: emptyResult(revision, [opError("card", 0, code, message)]), event: null });

  // --- Public API ----------------------------------------------------------------------------

  return {
    /** @returns {Promise<BoardSnapshot>} */
    getBoard: () => enqueue(async () => snapshot(await load())),

    /** @returns {Promise<number>} */
    getRevision: () => enqueue(async () => (await load()).meta.revision),

    /** @param {any} req */
    applyOperation: (req) => enqueue(() => applyLocked(req)),

    /**
     * @param {any} args {senderId?, by?, historyId, requestId?}
     * @returns {Promise<{result: OperationResult, event: BoardEvent|null}>}
     */
    undo: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      const requestId = requestIdOf(a.requestId);
      const duplicate = duplicateOf(s, requestId);
      if (duplicate) return { result: duplicate, event: null };
      const entry = s.history.find((h) => h.id === a.historyId);
      if (!entry) return finishUnchanged(s, requestId, emptyResult(s.meta.revision, [opError("structure", -1, "invalid_op", "No such history entry")]));
      if (!entry.inverse) return finishUnchanged(s, requestId, emptyResult(s.meta.revision, [opError("structure", -1, "invalid_op", "That change cannot be undone")]));
      return applyLocked({ ...entry.inverse, senderId: a.senderId, by: a.by, requestId }, { force: true, summaryPrefix: "Undid: " });
    }),

    /**
     * @param {any} args {senderId?, cardId, author, text}
     * @returns {Promise<{comment: Comment, event: BoardEvent}>}
     */
    addComment: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      if (!isId(a.cardId, "card")) throw new Error("addComment: cardId must look like c_1a2b3c4d");
      if (!s.cards.has(a.cardId)) throw new Error(`addComment: no card ${a.cardId}`);
      const stats = await commentStats(s, a.cardId);
      if (stats.count >= LIMITS.commentsPerCard) {
        throw new Error(`addComment: card ${a.cardId} already has the maximum of ${LIMITS.commentsPerCard} comments`);
      }
      const text = cleanText(a.text, LIMITS.commentText);
      if (!text.trim()) throw new Error("addComment: text is empty");
      /** @type {Comment} */
      const comment = { id: newId("comment"), cardId: a.cardId, author: cleanName(a.author, "Anonymous"), text, at: now() };
      const size = storedBytes(comment);
      if (stats.bytes + size > LIMITS.commentBytesPerCard) {
        throw new Error(`addComment: card ${a.cardId} has reached the maximum comment size of ${LIMITS.commentBytesPerCard / 1024} KiB`);
      }
      try {
        await repo.commit({ putComments: [comment] });
      } catch (e) {
        state = null;
        throw e;
      }
      stats.count += 1;
      stats.bytes += size;
      /** @type {BoardEvent} */
      const event = { type: "comment", senderId: cleanId(a.senderId), comment: structuredClone(comment) };
      emit(event);
      return { comment, event };
    }),

    /** @param {unknown} cardId @returns {Promise<Comment[]>} */
    getComments: (cardId) => enqueue(async () => (isId(cardId, "card") ? repo.getComments(cardId) : [])),

    /** @param {unknown} [limit] @returns {Promise<HistoryEntry[]>} */
    getHistory: (limit = 50) => enqueue(async () => {
      const s = await load();
      const n = typeof limit === "number" && Number.isFinite(limit) ? Math.max(0, Math.min(LIMITS.historyEntries, Math.trunc(limit))) : 50;
      return n === 0 ? [] : structuredClone(s.history.slice(-n));
    }),

    // --- Convenience methods (README "Convenience methods") --------------------------------

    /**
     * @param {any} args {cards: [{column, title, description, labels, assignee, due, checklist}], by?}
     * @returns {Promise<{created: Card[], errors: OpError[], event: BoardEvent|null}>}
     */
    addCards: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      const input = Array.isArray(a.cards) ? a.cards : [];
      /** @type {OpError[]} */
      const errors = [];
      const cardOps = [];
      /** @type {number[]} */
      const indexOf = [];
      input.forEach((/** @type {any} */ item, i) => {
        if (!isObject(item)) return void errors.push(opError("card", i, "invalid_op", "Each card must be an object"));
        const columnId = resolveColumn(s, item.column ?? item.columnId);
        if (!columnId) return void errors.push(opError("card", i, "unknown_column", `No column ${String(item.column ?? item.columnId).slice(0, 80)}`));
        const cardId = isId(item.id, "card") && !s.cards.has(item.id) ? item.id : newId("card");
        cardOps.push({ op: "upsert", cardId, columnId, baseVersion: 0, card: friendlyPatch(s, item) });
        indexOf.push(i);
      });
      if (!Array.isArray(a.cards)) errors.push(opError("card", -1, "invalid_op", "cards must be an array"));
      if (!cardOps.length) return { created: [], errors, event: null };
      const { result, event } = await applyLocked({ cardOps, by: a.by, senderId: a.senderId });
      for (const e of result.errors) errors.push({ ...e, index: e.index >= 0 ? indexOf[e.index] : e.index });
      const ids = new Set(cardOps.map((o) => o.cardId));
      return { created: result.upserts.filter((c) => ids.has(c.id)), errors, event };
    }),

    /** @param {any} args {cardId, fields, by?} */
    updateCard: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      if (!isId(a.cardId, "card")) return errorOnly(s.meta.revision, "invalid_id", "cardId must look like c_1a2b3c4d");
      const card = s.cards.get(a.cardId);
      if (!card) return errorOnly(s.meta.revision, "unknown_card", `No card ${a.cardId}`);
      return applyLocked({
        cardOps: [{ op: "upsert", cardId: card.id, baseVersion: card.version, card: friendlyPatch(s, a.fields) }],
        by: a.by, senderId: a.senderId,
      });
    }),

    /** @param {any} args {cardId, toColumn, position?: "top"|"bottom"|number, by?} */
    moveCard: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      if (!isId(a.cardId, "card")) return errorOnly(s.meta.revision, "invalid_id", "cardId must look like c_1a2b3c4d");
      const card = s.cards.get(a.cardId);
      if (!card) return errorOnly(s.meta.revision, "unknown_card", `No card ${a.cardId}`);
      const toColumnId = a.toColumn === undefined ? card.columnId : resolveColumn(s, a.toColumn);
      if (!toColumnId) return errorOnly(s.meta.revision, "unknown_column", `No column ${String(a.toColumn).slice(0, 80)}`);
      const others = [...s.cards.values()]
        .filter((c) => c.columnId === toColumnId && c.id !== card.id).sort(compareCards);
      const pos = a.position ?? "bottom";
      let index;
      if (pos === "top") index = 0;
      else if (pos === "bottom") index = others.length;
      else if (typeof pos === "number" && Number.isFinite(pos)) index = Math.max(0, Math.min(others.length, Math.trunc(pos)));
      else return errorOnly(s.meta.revision, "invalid_op", 'position must be "top", "bottom" or a 0-based index');
      /** @type {string|undefined} */
      let order;
      if (index < others.length) {
        try {
          const key = keyBetween(others[index - 1]?.order ?? null, others[index].order);
          if (isValidOrderKey(key)) order = key;
        } catch { /* neighbours share a key: fall back to appending */ }
      }
      return applyLocked({
        cardOps: [{ op: "move", cardId: card.id, baseVersion: card.version, toColumnId, ...(order ? { order } : {}) }],
        by: a.by, senderId: a.senderId,
      });
    }),

    /** @param {any} args {cardId, by?} */
    deleteCard: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      if (!isId(a.cardId, "card")) return errorOnly(s.meta.revision, "invalid_id", "cardId must look like c_1a2b3c4d");
      const card = s.cards.get(a.cardId);
      if (!card) return errorOnly(s.meta.revision, "unknown_card", `No card ${a.cardId}`);
      return applyLocked({
        cardOps: [{ op: "delete", cardId: card.id, baseVersion: card.version }], by: a.by, senderId: a.senderId,
      });
    }),

    /**
     * @param {any} args {name, index?, by?}
     * @returns {Promise<{column: Column|null, errors: OpError[], event: BoardEvent|null}>}
     */
    addColumn: (args) => enqueue(async () => {
      const a = isObject(args) ? args : {};
      const columnId = newId("column");
      const { result, event } = await applyLocked({
        columnOps: [{ op: "upsert", columnId, baseVersion: 0, column: { name: typeof a.name === "string" ? a.name : "" }, index: a.index }],
        by: a.by, senderId: a.senderId,
      });
      return { column: result.structure?.columns[columnId] ?? null, errors: result.errors, event };
    }),

    /**
     * @param {any} [filter] {column?, label?, assignee?, text?}
     * @returns {Promise<Card[]>}
     */
    findCards: (filter) => enqueue(async () => {
      const s = await load();
      const f = isObject(filter) ? filter : {};
      const columnId = f.column === undefined ? undefined : resolveColumn(s, f.column);
      const labelId = f.label === undefined ? undefined : resolveLabel(s, f.label);
      if (columnId === null || labelId === null) return [];
      const assignee = typeof f.assignee === "string" ? f.assignee.trim().toLowerCase() : undefined;
      const text = typeof f.text === "string" ? f.text.trim().toLowerCase() : "";
      const rank = new Map(s.meta.columnOrder.map((id, i) => [id, i]));
      const found = [...s.cards.values()].filter((c) =>
        (columnId === undefined || c.columnId === columnId) &&
        (labelId === undefined || c.labels.includes(labelId)) &&
        (assignee === undefined || c.assignee.toLowerCase() === assignee) &&
        (!text || c.title.toLowerCase().includes(text) || c.description.toLowerCase().includes(text)));
      found.sort((x, y) => ((rank.get(x.columnId) ?? Infinity) - (rank.get(y.columnId) ?? Infinity)) || compareCards(x, y));
      return structuredClone(found);
    }),
  };
}
