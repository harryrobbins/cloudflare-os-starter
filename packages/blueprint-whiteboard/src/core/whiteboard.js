// @ts-check
// Whiteboard rules: validation, references, caps, per-object versions, stacking, history,
// inverses and undo, plus the convenience methods agents call from chat. Storage-agnostic:
// everything goes through a Repository (src/core/repository.js), so the same rules run in the
// Durable Object, in memory for tests, and in the browser harness.
//
// Every public method is serialised through one promise queue, so each call observes and commits
// one authoritative state in strict order. A throwing call rejects its own promise only.
//
// One request: objectOps in array order (each op sees the ones before it), then structure. Valid
// ops commit even when others fail; the whole request is written with ONE repo.commit and bumps
// the revision once. An object's version is bumped once per request that changes it, and an op
// may name either the version from before the request or the one current within it.
//
// Indexes kept in the cached state and copied per request (never an O(n) scan per op):
//   sizes/bytes  storedBytes per object and their sum (LIMITS.boardBytes)
//   frames       number of frames (LIMITS.frames)
//   members      frameId -> objects naming it (raw, so an undone frame delete regains its count)
//   adj          object id -> connectors attached to it (copy-on-write per request)
//   top          highest valid z per stacking group ("frame" | "other"), an upper bound
//
// Idempotency: a request carrying a valid requestId is recorded ("requests", bounded) in the same
// commit as its changes, or in a records-only commit when nothing changed. A replay of a recorded
// requestId returns the recorded outcome with duplicate: true and applies nothing.

import {
  BACKGROUNDS, COLORS, DEFAULT_TITLE, LIMITS as DEFAULT_LIMITS, SCHEMA_VERSION, TYPE_DEFAULTS,
  cleanColor, cleanCoord, cleanLine, cleanName, cleanNumber, cleanObjectPatch, cleanSize, compareObjects,
  isId, isObject, isObjectType, isRequestId, newId as protocolNewId, normalizeNewObject,
  storedBytes,
} from "../shared/protocol.js";
import { isValidOrderKey, keyBetween } from "../shared/order.js";
import { boardToSvg } from "../shared/render.js";
import { boardBounds, rectsIntersect, objectBounds, rotatedBounds, unionRects } from "../shared/geometry.js";

/** @typedef {import("../shared/protocol.js").BoardMeta} BoardMeta */
/** @typedef {import("../shared/protocol.js").BoardSnapshot} BoardSnapshot */
/** @typedef {import("../shared/protocol.js").BoardEvent} BoardEvent */
/** @typedef {import("../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../shared/protocol.js").HistoryEntry} HistoryEntry */
/** @typedef {import("../shared/protocol.js").OperationResult} OperationResult */
/** @typedef {import("../shared/protocol.js").OpError} OpError */
/** @typedef {import("../shared/protocol.js").Conflict} Conflict */
/** @typedef {import("../shared/protocol.js").RequestRecord} RequestRecord */
/** @typedef {import("./repository.js").Repository} Repository */

export const ANONYMOUS = "Anonymous";
/** A single request record is shrunk (errors, then conflicts halved) to fit in this many bytes. */
const RECORD_MAX_BYTES = 16 * 1024;
const MIB = 1024 * 1024;
/** Fields compared to decide whether an update changed an object (and inverted by undo). */
const FIELDS = /** @type {const} */ (["x", "y", "w", "h", "rot", "z", "frameId", "text", "style", "points", "from", "to", "fromSide", "toSide", "routing"]);
/** An update touching only these is a move: never refused for size, summarised as "Moved". */
const MOVE_FIELDS = new Set(["x", "y", "frameId"]);
/** Fields the convenience methods pass through from caller input. */
const FRIENDLY_FIELDS = ["id", "type", ...FIELDS];
const NOUNS = /** @type {Record<string, string>} */ ({
  sticky: "sticky note", rect: "rectangle", ellipse: "ellipse", text: "text label", frame: "frame",
  pen: "pen stroke", connector: "connector",
});
const FILL_TYPES = new Set(["sticky", "rect", "ellipse", "text", "frame"]);
/** Default placement spacing for the convenience methods. */
const PLACE_GAP = 40;
const RIGHT_OF_CONTENT = 200;
const FRAME_PADDING = 60;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** @param {string} type */
const withArticle = (type) => {
  const noun = NOUNS[type] ?? "object";
  return (/^[aeiou]/.test(noun) ? "an " : "a ") + noun;
};

/** @param {number} index @param {OpError["code"]} code @param {string} message @returns {OpError} */
const opError = (index, code, message) => ({ index, code, message });

/**
 * baseVersion: undefined when absent, NaN when present but not a non-negative safe integer.
 * @param {unknown} v
 */
function parseBase(v) {
  if (v === undefined) return undefined;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : NaN;
}

/** @param {number} revision @param {OpError[]} [errors] @param {Conflict[]} [conflicts] @returns {OperationResult} */
function emptyResult(revision, errors = [], conflicts = []) {
  return {
    status: conflicts.length ? "conflict" : "unchanged", revision, upserts: [], deletes: [],
    structure: null, history: null, conflicts, errors,
  };
}

/**
 * @param {string} field @param {any} a @param {any} b
 */
function fieldEqual(field, a, b) {
  const x = a[field], y = b[field];
  if (x === y) return true;
  if (field === "style" && isObject(x) && isObject(y)) {
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    for (const k of keys) if (x[k] !== y[k]) return false;
    return true;
  }
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => v === y[i]);
  return false;
}

/** @param {WhiteboardObject} o */
const groupOf = (o) => (o.type === "frame" ? "frame" : "other");

/** @param {string} s */
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Upgrades stored meta to SCHEMA_VERSION and repairs its shape. Returns the same object when
 * nothing needed changing.
 * @param {any} meta
 * @returns {BoardMeta}
 */
export function migrate(meta) {
  const m = isObject(meta) ? meta : {};
  const fixed = {
    schemaVersion: SCHEMA_VERSION,
    revision: Number.isSafeInteger(m.revision) && m.revision >= 0 ? m.revision : 0,
    title: typeof m.title === "string" && m.title ? m.title : DEFAULT_TITLE,
    background: BACKGROUNDS.includes(m.background) ? m.background : "dots",
    lastModified: typeof m.lastModified === "number" && Number.isFinite(m.lastModified) ? m.lastModified : 0,
  };
  const same = m === meta && Object.keys(m).length === 5 &&
    Object.entries(fixed).every(([k, v]) => m[k] === v);
  return same ? meta : /** @type {BoardMeta} */ (fixed);
}

// ---------------------------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} Index
 * @property {Map<string, WhiteboardObject>} objects
 * @property {Map<string, number>} sizes
 * @property {number} bytes
 * @property {number} frames
 * @property {Map<string, number>} members
 * @property {Map<string, Set<string>>} adj
 * @property {Set<string>} adjCopied   sets in adj that belong to this copy (safe to mutate)
 * @property {{frame: string|null, other: string|null}} top
 */

/** @param {Index} w @param {string|undefined} target @param {string} connectorId @param {boolean} add */
function edge(w, target, connectorId, add) {
  if (!target) return;
  let set = w.adj.get(target);
  if (!set || !w.adjCopied.has(target)) {
    set = new Set(set ?? []);
    w.adj.set(target, set);
    w.adjCopied.add(target);
  }
  if (add) set.add(connectorId);
  else set.delete(connectorId);
  if (!set.size) w.adj.delete(target);
}

/** @param {Index} w @param {WhiteboardObject} o @param {number} size */
function indexAdd(w, o, size) {
  w.objects.set(o.id, o);
  w.sizes.set(o.id, size);
  w.bytes += size;
  if (o.type === "frame") w.frames++;
  if (o.frameId) w.members.set(o.frameId, (w.members.get(o.frameId) ?? 0) + 1);
  if (o.type === "connector") {
    edge(w, o.from, o.id, true);
    edge(w, o.to, o.id, true);
  }
  if (isValidOrderKey(o.z)) {
    const g = groupOf(o);
    const top = w.top[g];
    if (top === null || o.z > top) w.top[g] = o.z;
  }
}

/** @param {Index} w @param {WhiteboardObject} o */
function indexRemove(w, o) {
  w.objects.delete(o.id);
  w.bytes -= w.sizes.get(o.id) ?? 0;
  w.sizes.delete(o.id);
  if (o.type === "frame") w.frames--;
  if (o.frameId) {
    const n = (w.members.get(o.frameId) ?? 1) - 1;
    if (n > 0) w.members.set(o.frameId, n);
    else w.members.delete(o.frameId);
  }
  if (o.type === "connector") {
    edge(w, o.from, o.id, false);
    edge(w, o.to, o.id, false);
  }
}

/** @param {Record<string, WhiteboardObject>} objects @returns {Index} */
function buildIndex(objects) {
  /** @type {Index} */
  const w = {
    objects: new Map(), sizes: new Map(), bytes: 0, frames: 0, members: new Map(), adj: new Map(),
    adjCopied: new Set(), top: { frame: null, other: null },
  };
  for (const o of Object.values(objects ?? {})) {
    if (isObject(o) && typeof o.id === "string") indexAdd(w, o, storedBytes(o));
  }
  return w;
}

/** @param {Index} s @returns {Index} a working copy that can be mutated without touching `s` */
function copyIndex(s) {
  return {
    objects: new Map(s.objects), sizes: new Map(s.sizes), bytes: s.bytes, frames: s.frames,
    members: new Map(s.members), adj: new Map(s.adj), adjCopied: new Set(), top: { ...s.top },
  };
}

/**
 * An order key above every key of the group.
 * @param {Index} w @param {"frame"|"other"} g
 */
function zAbove(w, g) {
  const top = w.top[g];
  try {
    const key = keyBetween(top, null);
    if (isValidOrderKey(key)) return key;
  } catch { /* fall through */ }
  return top ? top + "V" : "a0";
}

// ---------------------------------------------------------------------------------------------
// createWhiteboard
// ---------------------------------------------------------------------------------------------

/**
 * @param {Repository} repo
 * @param {{now?: () => number, newId?: typeof protocolNewId,
 *   onEvent?: (event: BoardEvent) => void, limits?: Partial<typeof DEFAULT_LIMITS>}} [options]
 *   onEvent is called inside the queue right after each successful commit, so events are emitted
 *   in revision order. It must not block; errors it throws are swallowed. `limits` overrides
 *   LIMITS (tests only).
 */
export function createWhiteboard(repo, { now = Date.now, newId = protocolNewId, onEvent, limits } = {}) {
  const L = limits ? { ...DEFAULT_LIMITS, ...limits } : DEFAULT_LIMITS;

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
  /**
   * @typedef {Index & {meta: BoardMeta, history: HistoryEntry[], requests: RequestRecord[]}} State
   */
  /** @type {State|null} */
  let state = null;

  /** @returns {Promise<State>} */
  async function load() {
    if (state) return state;
    const stored = await repo.getMeta();
    if (!stored) {
      /** @type {BoardMeta} */
      const meta = {
        schemaVersion: SCHEMA_VERSION, revision: 0, title: DEFAULT_TITLE, background: "dots", lastModified: now(),
      };
      await repo.commit({ meta, history: [] });
      state = { ...buildIndex({}), meta, history: [], requests: [] };
      return state;
    }
    const meta = migrate(stored);
    if (meta !== stored) await repo.commit({ meta });
    const [objects, history, requests] = await Promise.all([repo.getObjects(), repo.getHistory(), repo.getRequests()]);
    state = {
      ...buildIndex(objects), meta,
      history: Array.isArray(history) ? history : [],
      requests: Array.isArray(requests) ? requests : [],
    };
    return state;
  }

  /** @param {State} s @returns {BoardSnapshot} */
  function snapshot(s) {
    return structuredClone({
      schemaVersion: s.meta.schemaVersion, revision: s.meta.revision, title: s.meta.title,
      background: s.meta.background, objects: Object.fromEntries(s.objects), lastModified: s.meta.lastModified,
    });
  }

  // --- Request records (idempotency) ---------------------------------------------------------

  /**
   * @param {State} s @param {string} requestId @param {OperationResult} result
   * @returns {RequestRecord[]}
   */
  function withRecord(s, requestId, result) {
    /** @type {RequestRecord} */
    const record = structuredClone({
      requestId, revision: result.revision, status: result.status,
      conflicts: result.conflicts.map((c) => c.id), errors: result.errors,
    });
    while (storedBytes(record) > RECORD_MAX_BYTES && record.errors.length > 1) {
      record.errors = record.errors.slice(0, Math.ceil(record.errors.length / 2));
    }
    while (storedBytes(record) > RECORD_MAX_BYTES && record.conflicts.length > 1) {
      record.conflicts = record.conflicts.slice(0, Math.ceil(record.conflicts.length / 2));
    }
    const requests = [...s.requests.filter((r) => r.requestId !== requestId), record];
    while (requests.length > L.requestRecords) requests.shift();
    while (requests.length > 1 && storedBytes(requests) > L.requestRecordBytes) requests.shift();
    return requests;
  }

  /**
   * @param {State} s @param {string|null} requestId
   * @returns {OperationResult|null}
   */
  function duplicateOf(s, requestId) {
    if (!requestId) return null;
    const record = s.requests.find((r) => r.requestId === requestId);
    if (!record) return null;
    return structuredClone({
      status: record.status, revision: s.meta.revision, upserts: [], deletes: [], structure: null, history: null,
      conflicts: (Array.isArray(record.conflicts) ? record.conflicts : []).map((id) => ({ id, current: s.objects.get(id) ?? null })),
      errors: Array.isArray(record.errors) ? record.errors : [], duplicate: true,
    });
  }

  /**
   * Records a request that changed nothing (records-only commit, no revision bump).
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

  // --- Applying a request --------------------------------------------------------------------

  /**
   * @param {any} rawReq
   * @param {{force?: boolean, summary?: string}} [mode]
   *   force: undo mode. No version checks; a create may carry `restore: {createdAt, createdBy,
   *   version}`; a frameId naming a missing frame is cleared instead of refused; update/delete of
   *   a missing object is skipped with an error. Never reachable from the public applyOperation.
   *   summary: replaces the generated history summary.
   * @returns {Promise<{result: OperationResult, event: BoardEvent|null}>}
   */
  async function applyLocked(rawReq, { force = false, summary: summaryOverride } = {}) {
    const s = await load();
    const req = isObject(rawReq) ? rawReq : {};
    const requestId = isRequestId(req.requestId) ? req.requestId : null;
    const duplicate = duplicateOf(s, requestId);
    if (duplicate) return { result: duplicate, event: null };
    /** @type {OpError[]} */
    const errors = [];
    /** @type {Conflict[]} */
    const conflicts = [];

    /** @type {any[]} */
    let ops = [];
    if (req.objectOps !== undefined && req.objectOps !== null) {
      if (!Array.isArray(req.objectOps)) errors.push(opError(-1, "invalid_op", "objectOps must be an array"));
      else ops = req.objectOps;
    }
    if (ops.length > L.opsPerRequest) {
      errors.push(opError(-1, "limit",
        `A request may carry at most ${L.opsPerRequest} ops; this one has ${ops.length}. Nothing was applied.`));
      return finishUnchanged(s, requestId, emptyResult(s.meta.revision, errors));
    }

    const senderId = typeof req.senderId === "string" ? cleanLine(req.senderId, 64) : "";
    const by = cleanName(req.by, ANONYMOUS);
    const at = now();
    const w = copyIndex(s);
    /** @type {Set<string>} every id created, changed or deleted by this request */
    const touched = new Set();
    /** @type {Set<string>} connectors removed because an endpoint was deleted */
    const cascaded = new Set();

    /** @param {string} id */
    const startVersion = (id) => s.objects.get(id)?.version ?? 0;
    /** @param {string} id @param {WhiteboardObject} current @param {number} base */
    const versionOk = (id, current, base) => base === current.version || (touched.has(id) && base === startVersion(id));
    /** @param {string} id @param {WhiteboardObject} current */
    const bumpedVersion = (id, current) =>
      touched.has(id) && current.version !== startVersion(id) ? current.version : current.version + 1;
    /** @param {unknown} id */
    const isFrame = (id) => typeof id === "string" && w.objects.get(id)?.type === "frame";
    /** @param {number} extra ids not yet touched */
    const overCommit = (extra) => touched.size + extra > L.commitObjects;
    const commitMessage = `One change may touch at most ${L.commitObjects} objects, deleted connectors included. Split it up.`;
    const budgetMessage = `The whiteboard is full: objects may take at most ${L.boardBytes / MIB} MiB in total. Shorten or delete objects first.`;
    const objectMessage = `One object may take at most ${L.objectBytes / 1024} KiB. Shorten its text or simplify the stroke.`;

    /** @param {WhiteboardObject} o @param {number} size */
    const put = (o, size) => {
      const prev = w.objects.get(o.id);
      if (prev) indexRemove(w, prev);
      indexAdd(w, o, size);
      touched.add(o.id);
    };
    /** @param {WhiteboardObject} o */
    const remove = (o) => {
      indexRemove(w, o);
      touched.add(o.id);
    };

    /** @param {unknown} from @param {unknown} to @returns {string|null} what is wrong, or null */
    const connectorProblem = (from, to) => {
      if (!isId(from) || !isId(to)) return "A connector needs from and to object ids";
      if (from === to) return "A connector cannot connect an object to itself";
      for (const [end, id] of /** @type {const} */ ([["from", from], ["to", to]])) {
        const o = w.objects.get(id);
        if (!o) return `Connector ${end}: no object ${id}`;
        if (o.type === "connector") return `Connector ${end}: ${id} is a connector, which cannot be connected`;
      }
      return null;
    };

    /**
     * Shared checks for update and delete. Returns the current object, or null after recording an
     * error or conflict.
     * @param {any} op @param {number} i
     */
    const lookup = (op, i) => {
      if (!isId(op.id)) { errors.push(opError(i, "invalid_id", "id must look like o_1a2b3c4d5e6f")); return null; }
      const id = /** @type {string} */ (op.id);
      const base = parseBase(op.baseVersion);
      if (!force && (base === undefined || Number.isNaN(base))) {
        errors.push(opError(i, "invalid_op", "baseVersion (a non-negative integer) is required"));
        return null;
      }
      const current = w.objects.get(id);
      if (!current) {
        if (!force && /** @type {number} */ (base) > 0) conflicts.push({ id, current: null });
        else errors.push(opError(i, "unknown_object", `No object ${id}`));
        return null;
      }
      if (!force && !versionOk(id, current, /** @type {number} */ (base))) {
        conflicts.push({ id, current: structuredClone(current) });
        return null;
      }
      return current;
    };

    /** @param {any} op @param {number} i */
    const create = (op, i) => {
      const raw = op.object;
      if (!isObject(raw)) return void errors.push(opError(i, "invalid_op", "create needs an object"));
      if (!isId(raw.id)) return void errors.push(opError(i, "invalid_id", "object.id must look like o_1a2b3c4d5e6f"));
      if (!isObjectType(raw.type)) {
        return void errors.push(opError(i, "invalid_op", "object.type must be sticky, rect, ellipse, text, frame, pen or connector"));
      }
      const id = /** @type {string} */ (raw.id);
      if (w.objects.has(id)) return void errors.push(opError(i, "exists", `Object ${id} already exists`));
      if (touched.has(id)) {
        return void errors.push(opError(i, "exists", `Object ${id} was deleted earlier in this request and cannot be recreated in it`));
      }
      const obj = /** @type {any} */ (normalizeNewObject(raw));
      if (!obj) return void errors.push(opError(i, "invalid_op", "Invalid object"));
      if (!isValidOrderKey(obj.z)) obj.z = "";
      if (obj.frameId !== null && !isFrame(obj.frameId)) {
        if (!force) return void errors.push(opError(i, "invalid_ref", `frameId ${obj.frameId} does not name a frame`));
        obj.frameId = null;
      }
      if (obj.type === "pen" && !(Array.isArray(obj.points) && obj.points.length >= 4)) {
        return void errors.push(opError(i, "invalid_op", "A pen stroke needs points: at least 2 points, each coordinate a number"));
      }
      if (obj.type === "connector") {
        const problem = connectorProblem(obj.from, obj.to);
        if (problem) return void errors.push(opError(i, "invalid_ref", problem));
      }
      if (w.objects.size >= L.objects) {
        return void errors.push(opError(i, "limit", `A whiteboard may have at most ${L.objects} objects`));
      }
      if (obj.type === "frame" && w.frames >= L.frames) {
        return void errors.push(opError(i, "limit", `A whiteboard may have at most ${L.frames} frames`));
      }
      if (obj.frameId && (w.members.get(obj.frameId) ?? 0) >= L.objectsPerFrame) {
        return void errors.push(opError(i, "limit", `A frame may hold at most ${L.objectsPerFrame} objects; add a new frame`));
      }
      if (overCommit(1)) return void errors.push(opError(i, "limit", commitMessage));
      if (!obj.z) obj.z = zAbove(w, groupOf(obj));
      const restore = force && isObject(op.restore) ? op.restore : {};
      obj.version = Number.isSafeInteger(restore.version) && restore.version > 0 ? restore.version + 1 : 1;
      obj.createdAt = typeof restore.createdAt === "number" && Number.isFinite(restore.createdAt) ? restore.createdAt : at;
      obj.updatedAt = at;
      obj.createdBy = typeof restore.createdBy === "string" ? cleanName(restore.createdBy, by) : by;
      const size = storedBytes(obj);
      if (size > L.objectBytes) return void errors.push(opError(i, "limit", objectMessage));
      if (w.bytes + size > L.boardBytes) return void errors.push(opError(i, "limit", budgetMessage));
      put(obj, size);
    };

    /** @param {any} op @param {number} i */
    const update = (op, i) => {
      const current = lookup(op, i);
      if (!current) return;
      const id = current.id;
      /** @type {Record<string, any>} */
      const patch = cleanObjectPatch(op.patch, current.type);
      if ("z" in patch && !isValidOrderKey(patch.z)) delete patch.z;
      const keys = Object.keys(patch);
      if (!keys.length) return;
      /** @type {any} */
      const next = { ...current, ...patch };
      if (patch.style) next.style = { ...current.style, ...patch.style };
      if (patch.frameId && !isFrame(patch.frameId)) {
        if (!force) return void errors.push(opError(i, "invalid_ref", `frameId ${patch.frameId} does not name a frame`));
        next.frameId = null;
      }
      if (next.frameId && !isFrame(next.frameId)) next.frameId = null;
      if (current.type === "connector" && ("from" in patch || "to" in patch)) {
        const problem = connectorProblem(next.from, next.to);
        if (problem) return void errors.push(opError(i, "invalid_ref", problem));
      }
      if (FIELDS.every((f) => fieldEqual(f, current, next))) return;
      if (next.frameId && next.frameId !== current.frameId && (w.members.get(next.frameId) ?? 0) >= L.objectsPerFrame) {
        return void errors.push(opError(i, "limit", `A frame may hold at most ${L.objectsPerFrame} objects; add a new frame`));
      }
      if (!touched.has(id) && overCommit(1)) return void errors.push(opError(i, "limit", commitMessage));
      next.version = bumpedVersion(id, current);
      next.updatedAt = at;
      const size = storedBytes(next);
      const old = w.sizes.get(id) ?? 0;
      const move = keys.every((k) => MOVE_FIELDS.has(k));
      if (!move && size > old) {
        if (size > L.objectBytes) return void errors.push(opError(i, "limit", objectMessage));
        if (w.bytes - old + size > L.boardBytes) return void errors.push(opError(i, "limit", budgetMessage));
      }
      put(next, size);
    };

    /** @param {any} op @param {number} i */
    const del = (op, i) => {
      const current = lookup(op, i);
      if (!current) return;
      const attached = current.type === "connector" ? [] : [...(w.adj.get(current.id) ?? [])];
      const extra = (touched.has(current.id) ? 0 : 1) + attached.filter((c) => !touched.has(c)).length;
      if (overCommit(extra)) return void errors.push(opError(i, "limit", commitMessage));
      for (const c of attached) {
        const conn = w.objects.get(c);
        if (!conn) continue;
        remove(conn);
        cascaded.add(c);
      }
      remove(current);
    };

    ops.forEach((op, i) => {
      try {
        if (!isObject(op)) return void errors.push(opError(i, "invalid_op", "Op must be an object"));
        if (op.op === "create") create(op, i);
        else if (op.op === "update") update(op, i);
        else if (op.op === "delete") del(op, i);
        else errors.push(opError(i, "invalid_op", 'op must be "create", "update" or "delete"'));
      } catch (e) {
        errors.push(opError(i, "invalid_op", "Invalid operation: " + cleanLine(/** @type {any} */ (e)?.message, 200)));
      }
    });

    // ---- Structure (last-writer-wins) ----
    let title = s.meta.title;
    let background = s.meta.background;
    if (req.structure !== undefined && req.structure !== null) {
      const st = req.structure;
      if (!isObject(st)) errors.push(opError(-1, "invalid_op", "structure must be an object"));
      else {
        if ("title" in st) {
          if (typeof st.title === "string") title = cleanLine(st.title, L.boardTitle) || DEFAULT_TITLE;
          else errors.push(opError(-1, "invalid_op", "structure.title must be a string"));
        }
        if ("background" in st) {
          if (BACKGROUNDS.includes(st.background)) background = st.background;
          else errors.push(opError(-1, "invalid_op", `structure.background must be ${BACKGROUNDS.join(", ")}`));
        }
      }
    }

    // ---- Diff against the state before the request ----
    /** @type {WhiteboardObject[]} */
    const upserts = [];
    /** @type {string[]} */
    const deletes = [];
    /** @type {WhiteboardObject[]} */
    const created = [];
    /** @type {[WhiteboardObject, WhiteboardObject][]} */
    const updated = [];
    /** @type {WhiteboardObject[]} */
    const deleted = [];
    /** @type {WhiteboardObject[]} */
    const restores = [];
    /** @type {any[]} */
    const inverseUpdates = [];
    for (const id of touched) {
      const before = s.objects.get(id);
      const after = w.objects.get(id);
      if (before === after) continue;
      if (!before && after) {
        upserts.push(after);
        created.push(after);
      } else if (before && !after) {
        deletes.push(id);
        if (!cascaded.has(id)) deleted.push(before);
        restores.push(before);
      } else if (before && after) {
        upserts.push(after);
        updated.push([before, after]);
        /** @type {Record<string, unknown>} */
        const patch = {};
        for (const f of FIELDS) if (!fieldEqual(f, before, after)) patch[f] = /** @type {any} */ (before)[f];
        if (Object.keys(patch).length) inverseUpdates.push({ op: "update", id, patch });
      }
    }
    const titleChanged = title !== s.meta.title;
    const backgroundChanged = background !== s.meta.background;
    const changed = upserts.length > 0 || deletes.length > 0 || titleChanged || backgroundChanged;
    if (!changed) return finishUnchanged(s, requestId, structuredClone(emptyResult(s.meta.revision, errors, conflicts)));

    // ---- History entry ----
    /** @type {string[]} */
    const parts = [];
    if (created.length) parts.push(created.length === 1 ? `Added ${withArticle(created[0].type)}` : `Added ${created.length} objects`);
    if (updated.length) {
      const moved = updated.every(([b, a]) => FIELDS.every((f) => MOVE_FIELDS.has(f) || fieldEqual(f, b, a)));
      const verb = moved ? "Moved" : "Edited";
      parts.push(updated.length === 1 ? `${verb} ${withArticle(updated[0][1].type)}` : `${verb} ${updated.length} objects`);
    }
    if (deleted.length) parts.push(deleted.length === 1 ? `Deleted ${withArticle(deleted[0].type)}` : `Deleted ${deleted.length} objects`);
    if (titleChanged) parts.push("Renamed the whiteboard");
    if (backgroundChanged) parts.push("Changed the background");
    if (!parts.length) parts.push("Changed the whiteboard");
    const summary = (summaryOverride ?? parts[0] + parts.slice(1).map((p) => ", " + lowerFirst(p)).join("")).slice(0, L.summary);

    // Inverse: restores (frames, then other objects, then connectors so their endpoints exist),
    // then updates, then deletes of created objects (connectors first, so nothing cascades).
    const rank = (/** @type {WhiteboardObject} */ o) => (o.type === "frame" ? 0 : o.type === "connector" ? 2 : 1);
    const inverseOps = [
      ...restores.sort((a, b) => rank(a) - rank(b)).map((o) => {
        const { version, createdAt, updatedAt: _u, createdBy, ...object } = o;
        return { op: "create", object, restore: { createdAt, createdBy, version } };
      }),
      ...inverseUpdates,
      ...created.sort((a, b) => rank(b) - rank(a)).map((o) => ({ op: "delete", id: o.id })),
    ];
    let inverse = null;
    if (inverseOps.length) {
      const inv = { objectOps: inverseOps };
      inverse = storedBytes(inv) <= L.inverseBytes ? structuredClone(inv) : null;
    }
    /** @type {HistoryEntry} */
    const entry = { id: newId("history"), at, by, summary, inverse };
    const history = [...s.history, entry];
    while (history.length > L.historyEntries) history.shift();
    while (history.length > 1 && storedBytes(history) > L.historyBytes) history.shift();

    // ---- Commit ----
    /** @type {BoardMeta} */
    const meta = { ...s.meta, title, background, revision: s.meta.revision + 1, lastModified: at };
    const structure = titleChanged || backgroundChanged ? { title, background } : null;
    /** @type {OperationResult} */
    const result = structuredClone({
      status: conflicts.length ? "conflict" : "applied", revision: meta.revision, upserts, deletes,
      structure, history: entry, conflicts, errors,
    });
    const requests = requestId ? withRecord(s, requestId, result) : s.requests;
    try {
      await repo.commit({
        meta, putObjects: upserts, deleteObjects: deletes, history, ...(requestId ? { requests } : {}),
      });
    } catch (e) {
      state = null;
      throw e;
    }
    state = {
      objects: w.objects, sizes: w.sizes, bytes: w.bytes, frames: w.frames, members: w.members, adj: w.adj,
      adjCopied: new Set(), top: w.top, meta, history, requests,
    };

    /** @type {BoardEvent} */
    const event = structuredClone({
      type: "operation", senderId, revision: meta.revision, upserts, deletes, structure, history: entry,
      lastModified: meta.lastModified,
    });
    emit(event);
    return { result, event };
  }

  // --- Convenience helpers -------------------------------------------------------------------

  /** @param {State} s @param {unknown} ref @returns {string|null} a frame id */
  function resolveFrame(s, ref) {
    if (typeof ref !== "string") return null;
    if (s.objects.get(ref)?.type === "frame") return ref;
    const name = ref.trim().toLowerCase();
    if (!name) return null;
    const frames = [...s.objects.values()].filter((o) => o.type === "frame" && o.text.toLowerCase() === name);
    return frames.sort(compareObjects)[0]?.id ?? null;
  }

  /** @param {unknown} v @returns {string|null} */
  function resolveColor(v) {
    if (typeof v !== "string") return null;
    const key = v.trim().toLowerCase();
    if (Object.hasOwn(COLORS, key)) return /** @type {any} */ (COLORS)[key];
    return cleanColor(v.trim(), true);
  }

  /**
   * Turns friendly fields (color names, frame names) into raw object fields. Returns null after
   * recording an error, so the item is skipped.
   * @param {State} s @param {string} type @param {any} fields @param {number} index @param {OpError[]} errors
   * @returns {Record<string, any>|null}
   */
  function friendly(s, type, fields, index, errors) {
    /** @type {Record<string, any>} */
    const out = {};
    if (!isObject(fields)) return out;
    for (const k of FRIENDLY_FIELDS) if (Object.hasOwn(fields, k)) out[k] = fields[k];
    if (Object.hasOwn(fields, "color") && fields.color !== undefined) {
      const hex = resolveColor(fields.color);
      if (!hex) {
        errors.push(opError(index, "invalid_op", `Unknown colour ${String(fields.color).slice(0, 40)}; use ${Object.keys(COLORS).join(", ")} or "#rrggbb"`));
        return null;
      }
      out.style = { ...(isObject(fields.style) ? fields.style : {}), [FILL_TYPES.has(type) ? "fill" : "stroke"]: hex };
    }
    if (Object.hasOwn(fields, "frame") && fields.frame !== undefined) {
      if (fields.frame === null) out.frameId = null;
      else {
        const frameId = resolveFrame(s, fields.frame);
        if (!frameId) {
          errors.push(opError(index, "invalid_ref", `No frame ${String(fields.frame).slice(0, 80)}`));
          return null;
        }
        out.frameId = frameId;
      }
    }
    return out;
  }

  /** Top-left for new content: right of everything on the board, at its top; 0,0 when empty. @param {State} s */
  function besideContent(s) {
    const b = boardBounds(Object.fromEntries(s.objects));
    return b ? { x: b.x + b.w + RIGHT_OF_CONTENT, y: b.y } : { x: 0, y: 0 };
  }

  /** @param {unknown} at @returns {{x: number, y: number}|null} */
  function cleanAt(at) {
    if (!isObject(at)) return null;
    const x = cleanCoord(/** @type {any} */ (at).x), y = cleanCoord(/** @type {any} */ (at).y);
    return x === null || y === null ? null : { x, y };
  }

  /** @param {unknown} v @param {number} n */
  const columnsOf = (v, n) =>
    typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.min(Math.trunc(v), Math.max(1, n)) : Math.max(1, Math.ceil(Math.sqrt(n)));

  /** @param {unknown} v */
  const gapOf = (v) => cleanNumber(v, 0, 10_000) ?? PLACE_GAP;

  /** @param {unknown} ids @returns {string[]} */
  const idList = (ids) => [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === "string"))];

  /**
   * Runs `objectOps` through the normal apply path and re-bases op errors onto caller indexes.
   * @param {any} a caller args (by, senderId)
   * @param {any[]} objectOps @param {number[]} indexOf caller index per op
   * @param {OpError[]} preErrors
   */
  async function applyMapped(a, objectOps, indexOf, preErrors) {
    const s = await load();
    if (!objectOps.length) return { result: emptyResult(s.meta.revision, preErrors), event: null };
    const { result, event } = await applyLocked({ objectOps, by: a.by, senderId: a.senderId });
    const mapped = result.errors.map((e) => ({ ...e, index: e.index >= 0 ? indexOf[e.index] ?? e.index : e.index }));
    result.errors = [...preErrors, ...mapped].sort((x, y) => x.index - y.index);
    return { result, event };
  }

  /**
   * Update ops from `patches` ([id, patch]) against current versions.
   * @param {State} s @param {[string, number, Record<string, any>][]} patches  [id, callerIndex, patch]
   */
  function updateOps(s, patches) {
    const objectOps = [];
    const indexOf = [];
    for (const [id, index, patch] of patches) {
      const o = s.objects.get(id);
      if (!o) continue;
      objectOps.push({ op: "update", id, baseVersion: o.version, patch });
      indexOf.push(index);
    }
    return { objectOps, indexOf };
  }

  // --- Public API ----------------------------------------------------------------------------

  return {
    /** @returns {Promise<BoardSnapshot>} */
    getBoard: () => enqueue(async () => snapshot(await load())),

    /** @returns {Promise<number>} */
    getRevision: () => enqueue(async () => (await load()).meta.revision),

    /** Cached revision without queueing; null before the first load. @returns {number|null} */
    revisionNow: () => (state ? state.meta.revision : null),

    /** @param {any} req */
    applyOperation: (req) => enqueue(() => applyLocked(req)),

    /**
     * @param {any} args {senderId?, by?, historyId?, requestId?}
     * @returns {Promise<{result: OperationResult, event: BoardEvent|null}>}
     */
    undo: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      const requestId = isRequestId(a.requestId) ? a.requestId : null;
      const duplicate = duplicateOf(s, requestId);
      if (duplicate) return { result: duplicate, event: null };
      /** @type {HistoryEntry|undefined} */
      let entry;
      if (a.historyId !== undefined && a.historyId !== null) {
        entry = s.history.find((h) => h.id === a.historyId);
        if (!entry) return finishUnchanged(s, requestId, emptyResult(s.meta.revision, [opError(-1, "invalid_op", "No such history entry")]));
      } else {
        const by = cleanName(a.by, ANONYMOUS);
        entry = s.history.findLast((h) => h.inverse && h.by === by);
        if (!entry) return finishUnchanged(s, requestId, emptyResult(s.meta.revision, [opError(-1, "invalid_op", `Nothing to undo for ${by}`)]));
      }
      if (!entry.inverse) {
        return finishUnchanged(s, requestId, emptyResult(s.meta.revision, [opError(-1, "invalid_op", "That change cannot be undone")]));
      }
      return applyLocked(
        { ...entry.inverse, senderId: a.senderId, by: a.by, requestId },
        { force: true, summary: ("Undid: " + lowerFirst(entry.summary)) },
      );
    }),

    /** @param {unknown} [limit] @returns {Promise<HistoryEntry[]>} */
    getHistory: (limit = 50) => enqueue(async () => {
      const s = await load();
      const n = typeof limit === "number" && Number.isFinite(limit) ? Math.max(0, Math.min(L.historyEntries, Math.trunc(limit))) : 50;
      return n === 0 ? [] : structuredClone(s.history.slice(-n));
    }),

    /**
     * @param {unknown} frameRef id or name
     * @returns {Promise<{frame: WhiteboardObject, objects: WhiteboardObject[]}|null>}
     */
    getFrame: (frameRef) => enqueue(async () => {
      const s = await load();
      const id = resolveFrame(s, frameRef);
      if (!id) return null;
      const objects = [...s.objects.values()].filter((o) => o.frameId === id).sort(compareObjects);
      return structuredClone({ frame: /** @type {WhiteboardObject} */ (s.objects.get(id)), objects });
    }),

    /**
     * @param {any} [filter] {type?, text?, frame?, within?}
     * @returns {Promise<WhiteboardObject[]>} bottom to top
     */
    findObjects: (filter) => enqueue(async () => {
      const s = await load();
      const f = isObject(filter) ? filter : {};
      const types = f.type === undefined ? null : new Set(Array.isArray(f.type) ? f.type : [f.type]);
      const text = typeof f.text === "string" ? f.text.trim().toLowerCase() : "";
      const frameId = f.frame === undefined || f.frame === null ? undefined : resolveFrame(s, f.frame);
      if (frameId === null) return [];
      const w = isObject(f.within) ? f.within : null;
      const within = w && [w.x, w.y, w.w, w.h].every((v) => typeof v === "number" && Number.isFinite(v)) ? w : null;
      const all = within ? Object.fromEntries(s.objects) : {};
      const found = [...s.objects.values()].filter((o) => {
        if (types && !types.has(o.type)) return false;
        if (text && !o.text.toLowerCase().includes(text)) return false;
        // frameId names an existing frame, so a member's raw frameId is its effective one.
        if (frameId !== undefined && o.frameId !== frameId) return false;
        if (within) {
          const b = objectBounds(o, all);
          if (!b || !rectsIntersect(b, within)) return false;
        }
        return true;
      });
      return structuredClone(found.sort(compareObjects));
    }),

    /**
     * @param {any} args {objects: [{type, ...fields, color?, frame?}], by?, senderId?}
     * @returns {Promise<{created: WhiteboardObject[], errors: OpError[], event: BoardEvent|null}>}
     */
    addObjects: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      /** @type {OpError[]} */
      const errors = [];
      if (!Array.isArray(a.objects)) errors.push(opError(-1, "invalid_op", "objects must be an array"));
      const input = Array.isArray(a.objects) ? a.objects : [];
      /** @type {any[]} */
      const objectOps = [];
      /** @type {number[]} */
      const indexOf = [];
      input.forEach((/** @type {any} */ item, /** @type {number} */ i) => {
        if (!isObject(item)) return void errors.push(opError(i, "invalid_op", "Each object must be an object"));
        const object = friendly(s, item.type, item, i, errors);
        if (!object) return;
        if (object.id === undefined) object.id = newId("object");
        objectOps.push({ op: "create", object });
        indexOf.push(i);
      });
      const { result, event } = await applyMapped(a, objectOps, indexOf, errors);
      const ids = objectOps.map((o) => o.object.id);
      const byId = new Map(result.upserts.map((o) => [o.id, o]));
      return { created: ids.map((id) => byId.get(id)).filter((o) => o !== undefined), errors: result.errors, event };
    }),

    /**
     * @param {any} args {stickies: (string|{text, color?, w?, h?})[], frame?, at?, columns?, gap?, by?, senderId?}
     * @returns {Promise<{created: WhiteboardObject[], errors: OpError[], event: BoardEvent|null}>}
     */
    addStickies: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      /** @type {OpError[]} */
      const errors = [];
      if (!Array.isArray(a.stickies)) errors.push(opError(-1, "invalid_op", "stickies must be an array"));
      /** @type {string|null} */
      let frameId = null;
      if (a.frame !== undefined && a.frame !== null) {
        frameId = resolveFrame(s, a.frame);
        if (!frameId) {
          errors.push(opError(-1, "invalid_ref", `No frame ${String(a.frame).slice(0, 80)}`));
          return { created: [], errors, event: null };
        }
      }
      /** @type {{index: number, fields: Record<string, any>}[]} */
      const items = [];
      (Array.isArray(a.stickies) ? a.stickies : []).forEach((/** @type {any} */ item, /** @type {number} */ i) => {
        const raw = typeof item === "string" ? { text: item } : item;
        if (!isObject(raw)) return void errors.push(opError(i, "invalid_op", "Each sticky must be a string or an object"));
        const fields = friendly(s, "sticky", raw, i, errors);
        if (fields) items.push({ index: i, fields });
      });
      const d = TYPE_DEFAULTS.sticky;
      const n = items.length;
      const columns = columnsOf(a.columns, n);
      const gap = gapOf(a.gap);
      const cellW = Math.max(d.w, ...items.map((it) => cleanSize(it.fields.w) ?? d.w));
      const cellH = Math.max(d.h, ...items.map((it) => cleanSize(it.fields.h) ?? d.h));
      const frame = frameId ? s.objects.get(frameId) : undefined;
      const origin = cleanAt(a.at) ?? (frame ? { x: frame.x + PLACE_GAP, y: frame.y + PLACE_GAP } : besideContent(s));
      const objectOps = items.map((it, k) => ({
        op: "create",
        object: {
          ...it.fields, id: isId(it.fields.id) ? it.fields.id : newId("object"), type: "sticky",
          x: origin.x + (k % columns) * (cellW + gap), y: origin.y + Math.floor(k / columns) * (cellH + gap),
          ...(frameId ? { frameId } : {}),
        },
      }));
      const { result, event } = await applyMapped(a, objectOps, items.map((it) => it.index), errors);
      const byId = new Map(result.upserts.map((o) => [o.id, o]));
      return {
        created: objectOps.map((o) => byId.get(o.object.id)).filter((o) => o !== undefined),
        errors: result.errors, event,
      };
    }),

    /**
     * @param {any} args {updates: [{id, fields}], by?, senderId?}
     * @returns {Promise<{result: OperationResult, event: BoardEvent|null}>}
     */
    updateObjects: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      /** @type {OpError[]} */
      const errors = [];
      if (!Array.isArray(a.updates)) errors.push(opError(-1, "invalid_op", "updates must be an array"));
      /** @type {[string, number, Record<string, any>][]} */
      const patches = [];
      (Array.isArray(a.updates) ? a.updates : []).forEach((/** @type {any} */ u, /** @type {number} */ i) => {
        if (!isObject(u)) return void errors.push(opError(i, "invalid_op", "Each update must be {id, fields}"));
        const o = typeof u.id === "string" ? s.objects.get(u.id) : undefined;
        if (!o) return void errors.push(opError(i, "unknown_object", `No object ${String(u.id).slice(0, 40)}`));
        const patch = friendly(s, o.type, u.fields, i, errors);
        if (!patch) return;
        delete patch.id;
        delete patch.type;
        patches.push([o.id, i, patch]);
      });
      const { objectOps, indexOf } = updateOps(s, patches);
      return applyMapped(a, objectOps, indexOf, errors);
    }),

    /**
     * @param {any} args {ids, dx, dy, by?, senderId?}
     * @returns {Promise<{result: OperationResult, event: BoardEvent|null}>}
     */
    moveObjects: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      /** @type {OpError[]} */
      const errors = [];
      const dx = typeof a.dx === "number" && Number.isFinite(a.dx) ? a.dx : 0;
      const dy = typeof a.dy === "number" && Number.isFinite(a.dy) ? a.dy : 0;
      /** @type {[string, number, Record<string, any>][]} */
      const patches = [];
      idList(a.ids).forEach((id, i) => {
        const o = s.objects.get(id);
        if (!o) return void errors.push(opError(i, "unknown_object", `No object ${id.slice(0, 40)}`));
        if (o.type === "connector") return; // follows its endpoints
        patches.push([id, i, { x: o.x + dx, y: o.y + dy }]);
      });
      const { objectOps, indexOf } = updateOps(s, patches);
      return applyMapped(a, objectOps, indexOf, errors);
    }),

    /**
     * @param {any} args {ids, columns?, gap?, at?, by?, senderId?}
     * @returns {Promise<{result: OperationResult, event: BoardEvent|null}>}
     */
    arrangeGrid: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      /** @type {OpError[]} */
      const errors = [];
      /** @type {{o: WhiteboardObject, i: number}[]} */
      const items = [];
      idList(a.ids).forEach((id, i) => {
        const o = s.objects.get(id);
        if (!o) return void errors.push(opError(i, "unknown_object", `No object ${id.slice(0, 40)}`));
        if (o.type === "connector") return;
        items.push({ o, i });
      });
      if (!items.length) return applyMapped(a, [], [], errors);
      const columns = columnsOf(a.columns, items.length);
      const gap = gapOf(a.gap);
      const cellW = Math.max(...items.map((it) => it.o.w));
      const cellH = Math.max(...items.map((it) => it.o.h));
      const origin = cleanAt(a.at) ?? {
        x: Math.min(...items.map((it) => it.o.x)), y: Math.min(...items.map((it) => it.o.y)),
      };
      /** @type {[string, number, Record<string, any>][]} */
      const patches = items.map((it, k) => [it.o.id, it.i, {
        x: origin.x + (k % columns) * (cellW + gap), y: origin.y + Math.floor(k / columns) * (cellH + gap),
      }]);
      const { objectOps, indexOf } = updateOps(s, patches);
      return applyMapped(a, objectOps, indexOf, errors);
    }),

    /**
     * @param {any} args {ids, by?, senderId?}
     * @returns {Promise<{result: OperationResult, event: BoardEvent|null}>}
     */
    deleteObjects: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      /** @type {OpError[]} */
      const errors = [];
      /** @type {{o: WhiteboardObject, i: number}[]} */
      const items = [];
      idList(a.ids).forEach((id, i) => {
        const o = s.objects.get(id);
        if (!o) return void errors.push(opError(i, "unknown_object", `No object ${id.slice(0, 40)}`));
        items.push({ o, i });
      });
      // Connectors first, so a listed connector is not already gone through a cascade.
      items.sort((x, y) => Number(y.o.type === "connector") - Number(x.o.type === "connector"));
      const objectOps = items.map((it) => ({ op: "delete", id: it.o.id, baseVersion: it.o.version }));
      return applyMapped(a, objectOps, items.map((it) => it.i), errors);
    }),

    /**
     * @param {any} args {name, x?, y?, w?, h?, contains?, by?, senderId?}
     * @returns {Promise<{frame: WhiteboardObject|null, result: OperationResult, event: BoardEvent|null}>}
     */
    addFrame: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      /** @type {OpError[]} */
      const errors = [];
      const name = cleanLine(a.name, L.frameName) || TYPE_DEFAULTS.frame.text;
      /** @type {WhiteboardObject[]} */
      const members = [];
      idList(a.contains).forEach((id, i) => {
        const o = s.objects.get(id);
        if (!o) return void errors.push(opError(-1, "unknown_object", `contains[${i}]: no object ${id.slice(0, 40)}`));
        if (o.type === "frame" || o.type === "connector") {
          return void errors.push(opError(-1, "invalid_op", `contains[${i}]: a ${o.type} cannot belong to a frame`));
        }
        members.push(o);
      });
      const gx = cleanCoord(a.x), gy = cleanCoord(a.y), gw = cleanSize(a.w), gh = cleanSize(a.h);
      const d = TYPE_DEFAULTS.frame;
      let geometry;
      const bounds = unionRects(members.map((o) => rotatedBounds(o)));
      if (gx === null && gy === null && gw === null && gh === null && bounds) {
        const nameRoom = Math.ceil(d.style.fontSize * 1.25 + 4);
        geometry = {
          x: bounds.x - FRAME_PADDING, y: bounds.y - FRAME_PADDING - nameRoom,
          w: bounds.w + 2 * FRAME_PADDING, h: bounds.h + 2 * FRAME_PADDING + nameRoom,
        };
      } else {
        const place = gx === null || gy === null ? besideContent(s) : { x: 0, y: 0 };
        geometry = { x: gx ?? place.x, y: gy ?? place.y, w: gw ?? d.w, h: gh ?? d.h };
      }
      const frameId = newId("object");
      const objectOps = [
        { op: "create", object: { id: frameId, type: "frame", text: name, ...geometry } },
        ...members.map((o) => ({ op: "update", id: o.id, baseVersion: o.version, patch: { frameId } })),
      ];
      const { result, event } = await applyMapped(a, objectOps, objectOps.map(() => -1), errors);
      return { frame: result.upserts.find((o) => o.id === frameId) ?? null, result, event };
    }),

    /**
     * @param {any} args {from, to, label?, routing?, arrow?: "end"|"both"|"none", color?, by?, senderId?}
     * @returns {Promise<{connector: WhiteboardObject|null, errors: OpError[], event: BoardEvent|null}>}
     */
    connect: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      /** @type {OpError[]} */
      const errors = [];
      const arrow = a.arrow === "both" || a.arrow === "none" ? a.arrow : "end";
      const fields = friendly(s, "connector", { color: a.color }, 0, errors);
      if (!fields) return { connector: null, errors, event: null };
      const id = newId("object");
      const object = {
        id, type: "connector", from: a.from, to: a.to, text: typeof a.label === "string" ? a.label : "",
        routing: a.routing === "elbow" ? "elbow" : "straight",
        style: { ...(fields.style ?? {}), arrowStart: arrow === "both" ? "arrow" : "none", arrowEnd: arrow === "none" ? "none" : "arrow" },
      };
      const { result, event } = await applyMapped(a, [{ op: "create", object }], [0], errors);
      return { connector: result.upserts.find((o) => o.id === id) ?? null, errors: result.errors, event };
    }),

    /**
     * @param {any} [args] {frame?}
     * @returns {Promise<string>}
     */
    exportSvg: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      let frameId = null;
      if (a.frame !== undefined && a.frame !== null) {
        frameId = resolveFrame(s, a.frame);
        if (!frameId) throw new Error(`exportSvg: no frame ${String(a.frame).slice(0, 80)}`);
      }
      return boardToSvg(snapshot(s), { frameId });
    }),
  };
}
