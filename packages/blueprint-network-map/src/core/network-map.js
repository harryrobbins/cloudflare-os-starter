// @ts-check
// Network map rules: validation, references and cascades, caps (counts and bytes), per-object
// versions, positions per layout, history with chunked inverses and conflict-aware undo,
// idempotent requests, and revision-consistent snapshot pages. Storage-agnostic: everything goes
// through a Repository (src/core/repository.js).
//
// Every public method runs through one promise queue, so each call observes and commits one
// authoritative state in strict order. State is mutated in place while a request is validated and
// applied; stored objects are never mutated, only replaced, so a snapshot that holds references
// stays consistent. If the commit fails the cached state is dropped and reloaded from storage.
//
// One request: ops in array order (each sees the ones before it), then structure. Valid ops commit
// even when others fail; the request is written with ONE repo.commit and bumps the revision once.
// An object's version is bumped once per request that changes it; an op may name the version from
// before the request or the one current within it.
//
// Idempotency: a request with a requestId is recorded with its sender and a digest of its payload.
// A replay with the same digest returns the recorded outcome (duplicate: true) and applies
// nothing; the same (senderId, requestId) with a different digest is refused (request_reused).
// Records are kept for the last LIMITS.requestRecords requests within LIMITS.requestRecordBytes:
// a client retrying after that window must reconcile against a snapshot, not replay blindly.
//
// Undo: each change records its inverse (full prior objects and positions), chunked apart from
// the history list, within LIMITS.inverseEntryBytes per entry and LIMITS.inverseBytes in total
// (the oldest inverses are evicted first). Undo is conflict-aware: it restores only what is still
// at the version the change wrote, keeps later edits, and never deletes an element that gained a
// connection since, or a connection a loop now uses. What it skips is returned as conflicts.

import {
  DEFAULT_TITLE, DEFAULT_VIEW_NAME, EDITABLE, KINDS, LIMITS as DEFAULT_LIMITS, SCHEMA_VERSION,
  cleanCoord, cleanLine, cleanName, cleanText, digestOf, isId, isObject, isRequestId, kindOf,
  loopProblem, newId as protocolNewId, normalizeConnection, normalizeElement, normalizeField,
  normalizeLabel, normalizeLoop, normalizeType, storedBytes,
} from "../shared/protocol.js";
import { SHARED_LAYOUT, layoutKeyOf, normalizeView } from "../shared/rules.js";
import { PositionStore } from "./positions.js";
import { demoMap } from "../shared/demo.js";

export const ANONYMOUS = "Anonymous";
const RECORD_MAX_BYTES = 8 * 1024;
/** Position items per inverse move op (~100 bytes each), so a chunk stays well under valueBytes. */
const INVERSE_MOVE_ITEMS = 400;
const KIND_LIMIT = /** @type {Record<string, keyof typeof DEFAULT_LIMITS>} */ ({
  e: "elements", c: "connections", l: "loops", v: "views", t: "types", f: "fields",
});
const NOUN = /** @type {Record<string, [string, string]>} */ ({
  e: ["element", "elements"], c: ["connection", "connections"], l: ["loop", "loops"], v: ["view", "views"],
  t: ["type", "types"], f: ["field", "fields"],
});
/** Restore order for undo: what others reference comes first. */
const CREATE_ORDER = "tfvecl";
const DELETE_ORDER = "lcevft";

/** @param {number} index @param {string} code @param {string} message */
const opError = (index, code, message) => ({ index, code, message });

/** @param {unknown} v baseVersion: undefined when absent, NaN when malformed */
function parseBase(v) {
  if (v === undefined) return undefined;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : NaN;
}

/** @param {unknown} v */
const senderOf = (v) => (typeof v === "string" ? cleanLine(v, 64) : "");

/** Stored content of an object (everything except system fields), for change detection. */
function contentOf(/** @type {any} */ o) {
  const { id: _i, version: _v, createdAt: _ca, createdBy: _cb, updatedAt: _ua, updatedBy: _ub, ...rest } = o;
  return rest;
}

/**
 * Upgrades stored meta to SCHEMA_VERSION and repairs its shape. Refuses a newer schema.
 * @param {any} meta
 */
export function migrate(meta) {
  const m = isObject(meta) ? meta : {};
  if (typeof m.schemaVersion === "number" && m.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`This map was saved by a newer version (schema ${m.schemaVersion}); this code understands schema ${SCHEMA_VERSION}.`);
  }
  const fixed = {
    schemaVersion: SCHEMA_VERSION,
    revision: Number.isSafeInteger(m.revision) && m.revision >= 0 ? m.revision : 0,
    graphRevision: Number.isSafeInteger(m.graphRevision) && m.graphRevision >= 0 ? m.graphRevision : 0,
    title: typeof m.title === "string" && m.title ? m.title : DEFAULT_TITLE,
    description: typeof m.description === "string" ? m.description : "",
    defaultViewId: isId(m.defaultViewId, "view") ? m.defaultViewId : null,
    lastModified: typeof m.lastModified === "number" && Number.isFinite(m.lastModified) ? m.lastModified : 0,
    demo: m.demo === true,
  };
  const same = m === meta && Object.keys(m).length === Object.keys(fixed).length &&
    Object.entries(fixed).every(([k, v]) => m[k] === v);
  return same ? meta : fixed;
}

/**
 * Splits a list into chunks whose storedBytes stay under `max`.
 * @param {any[]} items @param {number} max
 */
export function chunkByBytes(items, max) {
  const chunks = [];
  let cur = [], bytes = 12;
  for (const item of items) {
    const n = storedBytes(item) + 4;
    if (cur.length && bytes + n > max) { chunks.push(cur); cur = []; bytes = 12; }
    cur.push(item);
    bytes += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Drops the oldest items (keeping at least one) until storedBytes(list) fits `max`.
 * @template T @param {T[]} list @param {number} max @returns {T[]}
 */
function trimToBytes(list, max) {
  let total = storedBytes(list);
  let drop = 0;
  while (list.length - drop > 1 && total > max) total -= storedBytes(list[drop++]) + 4;
  return drop ? list.slice(drop) : list;
}

/**
 * @param {import("./repository.js").Repository} repo
 * @param {{now?: () => number, newId?: typeof protocolNewId, onEvent?: (event: any) => void,
 *   limits?: Partial<typeof DEFAULT_LIMITS>, seedDemo?: boolean}} [options]
 *   seedDemo: a never-initialised map starts with the demo content (default true).
 */
export function createNetworkMap(repo, { now = Date.now, newId = protocolNewId, onEvent, limits, seedDemo = true } = {}) {
  const L = limits ? { ...DEFAULT_LIMITS, ...limits } : DEFAULT_LIMITS;

  // --- Mutation queue ------------------------------------------------------------------------
  let queue = /** @type {Promise<unknown>} */ (Promise.resolve());
  /** @template T @param {() => Promise<T>|T} fn @returns {Promise<T>} */
  function enqueue(fn) {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }
  /** @param {any} event */
  function emit(event) {
    if (!event || !onEvent) return;
    try { onEvent(event); } catch { /* a broken listener must not fail a committed write */ }
  }

  // --- Cached state --------------------------------------------------------------------------
  /**
   * @typedef {object} State
   * @property {any} meta
   * @property {Map<string, any>} objects
   * @property {Map<string, number>} sizes
   * @property {number} bytes
   * @property {Record<string, number>} counts   by id prefix
   * @property {Map<string, Set<string>>} adj     element -> incident connections
   * @property {Map<string, Set<string>>} loopsOf connection -> loops using it
   * @property {Map<string, number>} typeUse
   * @property {Map<string, number>} fieldUse
   * @property {Map<string, Set<string>>} byLabel normalised label -> element ids
   * @property {Map<string, string>} byRef       "sourceId\0key" -> element id
   * @property {PositionStore} positions
   * @property {any[]} history
   * @property {any[]} requests
   * @property {number} inverseBytes
   * @property {Map<string, any>} changesets
   */
  /** @type {State|null} */
  let state = null;
  /** @type {Map<string, any>} snapshot token -> frozen snapshot */
  const snapshots = new Map();

  /** @param {State} s @param {any} o */
  function indexAdd(s, o) {
    const size = storedBytes(o);
    s.objects.set(o.id, o);
    s.sizes.set(o.id, size);
    s.bytes += size;
    s.counts[o.id[0]] = (s.counts[o.id[0]] ?? 0) + 1;
    if (o.typeId) s.typeUse.set(o.typeId, (s.typeUse.get(o.typeId) ?? 0) + 1);
    for (const f of Object.keys(o.fields ?? {})) s.fieldUse.set(f, (s.fieldUse.get(f) ?? 0) + 1);
    if (o.id[0] === "e") {
      if (!s.adj.has(o.id)) s.adj.set(o.id, new Set());
      const key = normalizeLabel(o.label);
      let set = s.byLabel.get(key);
      if (!set) s.byLabel.set(key, (set = new Set()));
      set.add(o.id);
      for (const r of o.externalRefs ?? []) s.byRef.set(r.sourceId + "\0" + r.key, o.id);
    } else if (o.id[0] === "c") {
      for (const end of [o.from, o.to]) {
        let set = s.adj.get(end);
        if (!set) s.adj.set(end, (set = new Set()));
        set.add(o.id);
      }
    } else if (o.id[0] === "l") {
      for (const step of o.steps) {
        let set = s.loopsOf.get(step.c);
        if (!set) s.loopsOf.set(step.c, (set = new Set()));
        set.add(o.id);
      }
    }
  }

  /** @param {State} s @param {any} o */
  function indexRemove(s, o) {
    s.objects.delete(o.id);
    s.bytes -= s.sizes.get(o.id) ?? 0;
    s.sizes.delete(o.id);
    s.counts[o.id[0]] = (s.counts[o.id[0]] ?? 1) - 1;
    const dec = (/** @type {Map<string, number>} */ m, /** @type {string} */ k) => {
      const n = (m.get(k) ?? 1) - 1;
      if (n > 0) m.set(k, n); else m.delete(k);
    };
    if (o.typeId) dec(s.typeUse, o.typeId);
    for (const f of Object.keys(o.fields ?? {})) dec(s.fieldUse, f);
    if (o.id[0] === "e") {
      const key = normalizeLabel(o.label);
      const set = s.byLabel.get(key);
      set?.delete(o.id);
      if (set && !set.size) s.byLabel.delete(key);
      for (const r of o.externalRefs ?? []) if (s.byRef.get(r.sourceId + "\0" + r.key) === o.id) s.byRef.delete(r.sourceId + "\0" + r.key);
      if (!s.adj.get(o.id)?.size) s.adj.delete(o.id);
    } else if (o.id[0] === "c") {
      for (const end of [o.from, o.to]) s.adj.get(end)?.delete(o.id);
    } else if (o.id[0] === "l") {
      for (const step of o.steps) {
        const set = s.loopsOf.get(step.c);
        set?.delete(o.id);
        if (set && !set.size) s.loopsOf.delete(step.c);
      }
    }
  }

  /** @returns {Promise<State>} */
  async function load() {
    if (state) return state;
    const stored = await repo.getMeta();
    /** @type {State} */
    const s = {
      meta: null, objects: new Map(), sizes: new Map(), bytes: 0, counts: {}, adj: new Map(), loopsOf: new Map(),
      typeUse: new Map(), fieldUse: new Map(), byLabel: new Map(), byRef: new Map(), positions: new PositionStore(),
      history: [], requests: [], inverseBytes: 0, changesets: new Map(),
    };
    if (!stored) {
      const meta = migrate({ revision: 0, lastModified: now() });
      const seed = seedDemo ? demoMap() : { objects: [], positions: [], title: DEFAULT_TITLE };
      const at = now();
      const objects = seed.objects.map((o) => ({ ...o, version: 1, createdAt: at, createdBy: "Network Map", updatedAt: at }));
      let view = objects.find((o) => o.id[0] === "v");
      if (!view) {
        view = { id: newId("view"), name: DEFAULT_VIEW_NAME, rules: [], layout: { kind: "force", own: false }, version: 1, createdAt: at, createdBy: "Network Map", updatedAt: at };
        objects.push(view);
      }
      meta.title = seed.title;
      meta.defaultViewId = view.id;
      meta.demo = seedDemo;
      for (const o of objects) indexAdd(s, o);
      for (const p of seed.positions) s.positions.set(SHARED_LAYOUT, p.id, { x: p.x, y: p.y, pin: false, v: 1 });
      const touched = new Map([[SHARED_LAYOUT, new Set(seed.positions.map((p) => p.id))]]);
      const { buckets, sizes } = s.positions.bucketsFor(touched);
      await repo.commit({ meta, putObjects: objects, buckets, history: [], requests: [] });
      s.positions.applySizes(sizes);
      s.meta = meta;
      state = s;
      return s;
    }
    const meta = migrate(stored);
    const [objects, buckets, history, requests, changesets] = await Promise.all([
      repo.getObjects(), repo.getBuckets(), repo.getHistory(), repo.getRequests(), repo.getChangesets(),
    ]);
    // Elements first, so connections and loops find their references in the indexes.
    const ordered = [...objects].filter((o) => isObject(o) && kindOf(o.id)).sort((a, b) => CREATE_ORDER.indexOf(a.id[0]) - CREATE_ORDER.indexOf(b.id[0]));
    for (const o of ordered) indexAdd(s, o);
    s.positions = PositionStore.fromBuckets(buckets);
    s.history = Array.isArray(history) ? history : [];
    s.requests = Array.isArray(requests) ? requests : [];
    s.inverseBytes = s.history.reduce((n, h) => n + (h.undoable ? h.inverseBytes ?? 0 : 0), 0);
    for (const cs of changesets) if (isObject(cs) && typeof cs.id === "string") s.changesets.set(cs.id, cs);
    // A default view must exist.
    if (!meta.defaultViewId || !s.objects.has(meta.defaultViewId)) {
      const view = [...s.objects.values()].find((o) => o.id[0] === "v");
      if (view) meta.defaultViewId = view.id;
      else {
        const at = now();
        const v = { id: newId("view"), name: DEFAULT_VIEW_NAME, rules: [], layout: { kind: "force", own: false }, version: 1, createdAt: at, createdBy: "Network Map", updatedAt: at };
        indexAdd(s, v);
        meta.defaultViewId = v.id;
        await repo.commit({ meta, putObjects: [v] });
      }
    }
    if (meta !== stored) await repo.commit({ meta });
    s.meta = meta;
    state = s;
    return s;
  }

  // --- Request records ------------------------------------------------------------------------

  /** @param {any} r @param {string} requestId @param {string} senderId */
  const recordMatches = (r, requestId, senderId) => r.requestId === requestId && r.senderId === senderId;

  /**
   * @param {State} s @param {string} requestId @param {string} senderId @param {string} digest @param {any} result
   */
  function withRecord(s, requestId, senderId, digest, result) {
    const record = {
      requestId, senderId, digest, revision: result.revision, status: result.status,
      conflicts: result.conflicts.map((/** @type {any} */ c) => c.id ?? c.layout ?? null).slice(0, 50),
      errors: result.errors.slice(0, 20),
      historyId: result.history?.id ?? null,
    };
    while (storedBytes(record) > RECORD_MAX_BYTES && record.errors.length > 1) record.errors = record.errors.slice(0, Math.ceil(record.errors.length / 2));
    const requests = [...s.requests.filter((r) => !recordMatches(r, requestId, senderId)), record];
    return trimToBytes(requests.slice(Math.max(0, requests.length - L.requestRecords)), L.requestRecordBytes);
  }

  /**
   * @param {State} s @param {string|null} requestId @param {string} senderId @param {string} digest
   * @returns {any|null}
   */
  function duplicateOf(s, requestId, senderId, digest) {
    if (!requestId) return null;
    const record = s.requests.find((r) => recordMatches(r, requestId, senderId));
    if (!record) return null;
    if (record.digest !== digest) {
      return {
        status: "unchanged", revision: s.meta.revision, upserts: [], deletes: [], moves: [], structure: null, history: null, conflicts: [],
        errors: [opError(-1, "request_reused", "This requestId was already used for a different change. Use a new requestId.")],
        duplicate: true,
      };
    }
    return {
      status: record.status, revision: record.revision ?? s.meta.revision, upserts: [], deletes: [], moves: [], structure: null,
      history: record.historyId ? s.history.find((h) => h.id === record.historyId) ?? null : null,
      conflicts: (record.conflicts ?? []).filter(Boolean).map((/** @type {string} */ id) => ({ id, current: s.objects.get(id) ?? null })),
      errors: record.errors ?? [], duplicate: true,
    };
  }

  /** @param {number} revision @param {any[]} [errors] */
  function emptyResult(revision, errors = []) {
    return { status: "unchanged", revision, upserts: [], deletes: [], moves: [], structure: null, history: null, conflicts: [], errors };
  }

  /**
   * Records a request that changed nothing (no revision bump).
   * @param {State} s @param {string|null} requestId @param {string} senderId @param {string} digest @param {any} result
   */
  async function finishUnchanged(s, requestId, senderId, digest, result) {
    if (requestId) {
      const requests = withRecord(s, requestId, senderId, digest, result);
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

  // --- Applying a request ---------------------------------------------------------------------

  /**
   * @param {any} rawReq {senderId, by, requestId, ops, structure}
   * @param {{force?: boolean, summary?: string, undoOf?: string, groupId?: string, extraCommit?: any,
   *   afterCommit?: () => void}} [mode]
   *   force: undo mode (restore/expect ops, no baseVersion). Never reachable from applyOperation.
   *   extraCommit: more writes for the same commit (changeset checkpoints).
   * @returns {Promise<{result: any, event: any}>}
   */
  async function applyLocked(rawReq, { force = false, summary: summaryOverride, undoOf, groupId, extraCommit, afterCommit, digest: digestOverride } = {}) {
    const s = await load();
    const req = isObject(rawReq) ? rawReq : {};
    const requestId = isRequestId(req.requestId) ? req.requestId : null;
    const senderId = senderOf(req.senderId);
    // An undo records the digest of what was asked (undo X), not of the inverse it computed, so a
    // retried undo replays its outcome.
    const digest = requestId ? digestOverride ?? digestOf({ ops: req.ops ?? null, structure: req.structure ?? null }) : "";
    const duplicate = duplicateOf(s, requestId, senderId, digest);
    if (duplicate) return { result: duplicate, event: null };
    /** @type {any[]} */
    const errors = [];
    /** @type {any[]} */
    const conflicts = [];
    /** @type {any[]} */
    let ops = [];
    if (req.ops !== undefined && req.ops !== null) {
      if (!Array.isArray(req.ops)) errors.push(opError(-1, "invalid_op", "ops must be an array"));
      else ops = req.ops;
    }
    if (ops.length > L.opsPerRequest) {
      errors.push(opError(-1, "limit", `A request may carry at most ${L.opsPerRequest} ops; this one has ${ops.length}. Nothing was applied.`));
      return finishUnchanged(s, requestId, senderId, digest, emptyResult(s.meta.revision, errors));
    }
    const by = cleanName(req.by, ANONYMOUS);
    const at = now();

    /** @type {Map<string, any|null>} id -> object before this request (null: did not exist) */
    const before = new Map();
    /** @type {Map<string, Map<string, any|null>>} layout -> id -> position before */
    const posBefore = new Map();
    /** @type {Map<string, Set<string>>} layout -> ids whose positions changed */
    const posTouched = new Map();
    let moveCount = 0;
    /** @type {Map<string, Set<string>>} layout -> ids moved by move ops (not by deletes) */
    const moved = new Map();
    let graphChanged = false;
    const startVersion = (/** @type {string} */ id) => (before.has(id) ? before.get(id)?.version ?? 0 : s.objects.get(id)?.version ?? 0);
    const touched = (/** @type {string} */ id) => before.has(id);

    /** @param {any} o */
    const put = (o) => {
      if (!before.has(o.id)) before.set(o.id, s.objects.get(o.id) ?? null);
      const prev = s.objects.get(o.id);
      if (prev) indexRemove(s, prev);
      indexAdd(s, o);
      if ("ecltf".includes(o.id[0])) graphChanged = true;
    };
    /** @param {any} o */
    const remove = (o) => {
      if (!before.has(o.id)) before.set(o.id, o);
      indexRemove(s, o);
      if ("ecltf".includes(o.id[0])) graphChanged = true;
    };
    /** @param {string} layout @param {string} id @param {any|null} pos */
    const setPos = (layout, id, pos) => {
      let b = posBefore.get(layout);
      if (!b) posBefore.set(layout, (b = new Map()));
      if (!b.has(id)) b.set(id, s.positions.get(layout, id) ?? null);
      let t = posTouched.get(layout);
      if (!t) posTouched.set(layout, (t = new Set()));
      t.add(id);
      s.positions.set(layout, id, pos);
    };
    /** @param {string} id the element's positions go, in every layout */
    const dropPositions = (id) => {
      for (const layout of s.positions.keys()) if (s.positions.get(layout, id)) setPos(layout, id, null);
    };

    /** @type {Map<string, number>} loop id -> index of the op that may have broken it */
    const loopChecks = new Map();
    const overCommit = (/** @type {number} */ extra) => before.size + extra > L.commitObjects;
    const commitMessage = `One change may touch at most ${L.commitObjects} objects, cascades included. Split it up.`;
    const budgetMessage = `The map is full: objects may take at most ${L.objectsBytes / 1024 / 1024} MiB in total.`;
    const objectMessage = `One object may take at most ${L.objectBytes / 1024} KiB. Shorten its text.`;
    /** @type {import("../shared/protocol.js").NormalizeContext} */
    const ctx = {
      get: (id) => s.objects.get(id),
      field: (id) => { const f = s.objects.get(id); return f && f.id[0] === "f" ? f : null; },
    };

    /** @param {string} kind @param {Record<string, any>} raw */
    const normalize = (kind, raw) => {
      switch (kind) {
        case "element": return normalizeElement(raw, ctx);
        case "connection": return normalizeConnection(raw, ctx);
        case "loop": return normalizeLoop(raw, ctx);
        case "view": return normalizeView(raw);
        case "type": return normalizeType(raw);
        case "field": return normalizeField(raw);
        default: return { error: "Unknown kind" };
      }
    };

    /**
     * Size and budget checks, then stores the object.
     * @param {any} next @param {number} i @param {boolean} grows
     */
    const store = (next, i, grows) => {
      const size = storedBytes(next);
      const old = s.sizes.get(next.id) ?? 0;
      if (grows && size > old) {
        if (size > L.objectBytes) return void errors.push(opError(i, "limit", objectMessage));
        if (s.bytes - old + size > L.objectsBytes) return void errors.push(opError(i, "limit", budgetMessage));
      }
      put(next);
    };

    /**
     * Deletes an object with its cascades. Returns false (with an error recorded) when refused.
     * @param {any} current @param {number} i
     */
    const deleteWithCascade = (current, i) => {
      const kind = current.id[0];
      if (kind === "t" && (s.typeUse.get(current.id) ?? 0) > 0) {
        errors.push(opError(i, "in_use", `Type "${current.name}" is used by ${s.typeUse.get(current.id)} items; change their type first`));
        return false;
      }
      if (kind === "v") {
        if (current.id === s.meta.defaultViewId) { errors.push(opError(i, "in_use", "The default view cannot be deleted; make another view the default first")); return false; }
      }
      if (kind === "f" && (s.fieldUse.get(current.id) ?? 0) > 0) {
        // A field's values go with it (undo brings both back). One scan; deletes are rare.
        const holders = [...s.objects.values()].filter((o) => o.fields && Object.hasOwn(o.fields, current.id));
        if (overCommit(holders.filter((o) => !touched(o.id)).length + (touched(current.id) ? 0 : 1))) {
          errors.push(opError(i, "limit", `Field "${current.name}" has ${holders.length} values; clear some first (${commitMessage})`));
          return false;
        }
        for (const o of holders) {
          const fields = { ...o.fields };
          delete fields[current.id];
          const next = { ...o, fields, version: bumped(o), updatedAt: at, updatedBy: by };
          if (!Object.keys(fields).length) delete next.fields;
          put(next);
        }
      }
      /** @type {any[]} */
      const connections = kind === "e" ? [...(s.adj.get(current.id) ?? [])].map((id) => s.objects.get(id)).filter(Boolean) : kind === "c" ? [current] : [];
      const loops = new Map();
      for (const c of connections) for (const l of s.loopsOf.get(c.id) ?? []) loops.set(l, s.objects.get(l));
      /** @type {any[]} */
      const views = [];
      if (kind === "e") {
        for (const o of s.objects.values()) if (o.id[0] === "v" && o.focus?.roots?.includes(current.id)) views.push(o);
      }
      const extra = [current, ...connections, ...loops.values(), ...views].filter((o) => o && !touched(o.id) && o !== current).length + (touched(current.id) ? 0 : 1);
      if (overCommit(extra)) { errors.push(opError(i, "limit", commitMessage)); return false; }
      for (const l of loops.values()) if (l && s.objects.has(l.id)) remove(l);
      for (const c of connections) if (c.id !== current.id && s.objects.has(c.id)) remove(c);
      for (const v of views) {
        const roots = v.focus.roots.filter((/** @type {string} */ r) => r !== current.id);
        const next = { ...v, focus: roots.length ? { ...v.focus, roots } : undefined, version: bumped(v), updatedAt: at, updatedBy: by };
        if (!roots.length) delete next.focus;
        put(next);
      }
      remove(current);
      if (kind === "e") dropPositions(current.id);
      if (kind === "v" && current.layout?.own) for (const id of [...(s.positions.layouts.get(current.id)?.keys() ?? [])]) setPos(current.id, id, null);
      return true;
    };
    /** @param {any} current */
    const bumped = (current) => (touched(current.id) && current.version !== startVersion(current.id) ? current.version : current.version + 1);

    /** @param {any} op @param {number} i */
    const lookup = (op, i) => {
      if (!isId(op.id)) { errors.push(opError(i, "invalid_id", "id must look like e_1a2b3c4d5e6f")); return null; }
      const base = parseBase(op.baseVersion);
      if (base === undefined || Number.isNaN(base)) { errors.push(opError(i, "invalid_op", "baseVersion (a non-negative integer) is required")); return null; }
      const current = s.objects.get(op.id);
      if (!current) {
        if (/** @type {number} */ (base) > 0) conflicts.push({ id: op.id, current: null });
        else errors.push(opError(i, "unknown_object", `No object ${op.id}`));
        return null;
      }
      if (base !== current.version && !(touched(op.id) && base === startVersion(op.id))) {
        conflicts.push({ id: op.id, current });
        return null;
      }
      return current;
    };

    /** @param {any} op @param {number} i */
    const create = (op, i) => {
      const raw = op.object;
      if (!isObject(raw)) return void errors.push(opError(i, "invalid_op", "create needs an object"));
      const kind = kindOf(raw.id);
      if (!kind) return void errors.push(opError(i, "invalid_id", "object.id must be an id like e_1a2b3c4d5e6f (e element, c connection, l loop, v view, t type, f field)"));
      if (s.objects.has(raw.id)) return void errors.push(opError(i, "exists", `Object ${raw.id} already exists`));
      if (touched(raw.id)) return void errors.push(opError(i, "exists", `Object ${raw.id} was deleted earlier in this request and cannot be recreated in it`));
      const limitKey = KIND_LIMIT[raw.id[0]];
      if ((s.counts[raw.id[0]] ?? 0) >= /** @type {number} */ (L[limitKey])) return void errors.push(opError(i, "limit", `A map may have at most ${L[limitKey]} ${NOUN[raw.id[0]][1]}`));
      if (overCommit(1)) return void errors.push(opError(i, "limit", commitMessage));
      const n = normalize(kind, raw);
      if ("error" in n) return void errors.push(opError(i, "invalid_op", n.error));
      const obj = { id: raw.id, ...n.value, version: 1, createdAt: at, createdBy: by, updatedAt: at };
      store(obj, i, true);
    };

    /** @param {any} op @param {number} i */
    const update = (op, i) => {
      const current = lookup(op, i);
      if (!current) return;
      const kind = /** @type {string} */ (kindOf(current.id));
      if (!isObject(op.patch)) return void errors.push(opError(i, "invalid_op", "update needs a patch object"));
      const allowed = /** @type {Record<string, readonly string[]>} */ (EDITABLE)[kind];
      /** @type {Record<string, any>} */
      const merged = { ...contentOf(current) };
      // Values of a field that no longer exists (older data) are dropped rather than blocking edits.
      if (merged.fields) merged.fields = Object.fromEntries(Object.entries(merged.fields).filter(([fid]) => ctx.field(fid)));
      for (const [k, v] of Object.entries(op.patch)) {
        if (!allowed.includes(k)) return void errors.push(opError(i, "invalid_op", `${k} cannot be changed on a ${kind}`));
        if (k === "fields" && isObject(v)) {
          const fields = { ...(merged.fields ?? {}) };
          for (const [fid, fv] of Object.entries(v)) {
            if (fv === null || fv === undefined || fv === "") delete fields[fid];
            else fields[fid] = fv;
          }
          merged.fields = fields;
        } else merged[k] = v;
      }
      const n = normalize(kind, merged);
      if ("error" in n) return void errors.push(opError(i, "invalid_op", n.error));
      const next = { id: current.id, ...n.value, version: 0, createdAt: current.createdAt, createdBy: current.createdBy, updatedAt: at, updatedBy: by };
      if (digestOf(contentOf(next)) === digestOf(contentOf(current))) return;
      // Reference rules that depend on usage.
      if (kind === "type" && next.appliesTo !== current.appliesTo && (s.typeUse.get(current.id) ?? 0) > 0) {
        return void errors.push(opError(i, "in_use", `Type "${current.name}" is in use; its appliesTo cannot change`));
      }
      if (kind === "field" && (s.fieldUse.get(current.id) ?? 0) > 0) {
        if (next.kind !== current.kind) return void errors.push(opError(i, "in_use", `Field "${current.name}" has values; its kind cannot change`));
        if (next.appliesTo !== current.appliesTo && next.appliesTo !== "both") return void errors.push(opError(i, "in_use", `Field "${current.name}" has values; it can only widen to both`));
        const removed = (current.choices ?? []).filter((/** @type {string} */ c) => !(next.choices ?? []).includes(c));
        if (removed.length) {
          const used = [...s.objects.values()].some((o) => {
            const v = o.fields?.[current.id];
            return v !== undefined && (Array.isArray(v) ? v.some((x) => removed.includes(x)) : removed.includes(v));
          });
          if (used) return void errors.push(opError(i, "in_use", `Choices still in use cannot be removed from "${current.name}"`));
        }
      }
      // Loops are checked once the whole request has applied (below), so a request may re-point
      // every connection of a loop one op at a time, as a merge does.
      if (kind === "connection" && (next.from !== current.from || next.to !== current.to || next.direction !== current.direction)) {
        for (const lid of s.loopsOf.get(current.id) ?? []) loopChecks.set(lid, i);
      }
      if (!touched(current.id) && overCommit(1)) return void errors.push(opError(i, "limit", commitMessage));
      next.version = bumped(current);
      store(next, i, true);
    };

    /** @param {any} op @param {number} i */
    const del = (op, i) => {
      const current = lookup(op, i);
      if (current) deleteWithCascade(current, i);
    };

    /** @param {any} op @param {number} i */
    const move = (op, i) => {
      const layout = op.layout === SHARED_LAYOUT ? SHARED_LAYOUT : isId(op.layout, "view") ? op.layout : null;
      if (!layout) return void errors.push(opError(i, "invalid_op", 'layout must be "shared" or a view id'));
      if (layout !== SHARED_LAYOUT) {
        const view = s.objects.get(layout);
        if (!view || view.id[0] !== "v") return void errors.push(opError(i, "invalid_ref", `No view ${layout}`));
        if (!view.layout?.own) return void errors.push(opError(i, "invalid_op", `View "${view.name}" uses the shared layout; move in layout "shared"`));
      }
      if (!Array.isArray(op.items)) return void errors.push(opError(i, "invalid_op", "move needs items: [{id, x, y, pin?, base?}]"));
      if (moveCount + op.items.length > L.movesPerRequest) return void errors.push(opError(i, "limit", `A request may move at most ${L.movesPerRequest} elements`));
      for (const item of op.items) {
        if (!isObject(item) || !isId(item.id, "element") || !s.objects.has(item.id)) continue;
        const x = cleanCoord(item.x), y = cleanCoord(item.y);
        if (x === null || y === null) continue;
        const cur = s.positions.get(layout, item.id);
        const base = item.base;
        if (base !== undefined && (cur?.v ?? 0) !== base) {
          conflicts.push({ layout, id: item.id, current: cur ?? null });
          continue;
        }
        const pin = typeof item.pin === "boolean" ? item.pin : cur?.pin ?? false;
        if (cur && cur.x === x && cur.y === y && cur.pin === pin) continue;
        const prevV = posTouched.get(layout)?.has(item.id) ? (posBefore.get(layout)?.get(item.id)?.v ?? 0) : (cur?.v ?? 0);
        setPos(layout, item.id, { x, y, pin, v: prevV + 1 });
        let m = moved.get(layout);
        if (!m) moved.set(layout, (m = new Set()));
        m.add(item.id);
        moveCount++;
      }
    };

    // --- Force (undo) ops ---
    /** @param {any} op @param {number} i */
    const forceOp = (op, i) => {
      if (op.op === "create") {
        const o = op.restore;
        if (!isObject(o) || !kindOf(o.id)) return;
        if (s.objects.has(o.id)) return void conflicts.push({ id: o.id, current: s.objects.get(o.id), reason: "exists" });
        if (o.id[0] === "c" && (!s.objects.has(o.from) || !s.objects.has(o.to))) return void conflicts.push({ id: o.id, current: null, reason: "endpoint missing" });
        if (o.id[0] === "l" && loopProblem(o.steps, (id) => s.objects.get(id))) return void conflicts.push({ id: o.id, current: null, reason: "loop broken" });
        if (o.typeId && !s.objects.has(o.typeId)) return void conflicts.push({ id: o.id, current: null, reason: "type missing" });
        if ((s.counts[o.id[0]] ?? 0) >= /** @type {number} */ (L[KIND_LIMIT[o.id[0]]])) return void errors.push(opError(i, "limit", "limit reached"));
        put({ ...o, version: o.version + 1, updatedAt: at, updatedBy: by });
        if (o.id[0] === "l") loopChecks.set(o.id, i);
      } else if (op.op === "update") {
        const cur = s.objects.get(op.id);
        if (!cur || cur.version !== op.expect) return void conflicts.push({ id: op.id, current: cur ?? null, reason: "changed since" });
        const o = op.restore;
        if (o.id[0] === "c" && (!s.objects.has(o.from) || !s.objects.has(o.to))) return void conflicts.push({ id: op.id, current: cur, reason: "endpoint missing" });
        if (o.typeId && !s.objects.has(o.typeId)) return void conflicts.push({ id: op.id, current: cur, reason: "type missing" });
        put({ ...o, version: cur.version + 1, updatedAt: at, updatedBy: by });
        if (o.id[0] === "l") loopChecks.set(o.id, i);
        if (o.id[0] === "c") for (const lid of s.loopsOf.get(o.id) ?? []) loopChecks.set(lid, i);
      } else if (op.op === "delete") {
        const cur = s.objects.get(op.id);
        if (!cur) return;
        if (cur.version !== op.expect) return void conflicts.push({ id: op.id, current: cur, reason: "changed since" });
        if (cur.id[0] === "e" && [...(s.adj.get(cur.id) ?? [])].length) return void conflicts.push({ id: op.id, current: cur, reason: "has connections added later" });
        if (cur.id[0] === "c" && (s.loopsOf.get(cur.id)?.size ?? 0) > 0) return void conflicts.push({ id: op.id, current: cur, reason: "used by a loop" });
        if (cur.id[0] === "t" && (s.typeUse.get(cur.id) ?? 0) > 0) return void conflicts.push({ id: op.id, current: cur, reason: "type in use" });
        if (cur.id[0] === "f" && (s.fieldUse.get(cur.id) ?? 0) > 0) return void conflicts.push({ id: op.id, current: cur, reason: "field has values added later" });
        if (cur.id[0] === "v" && cur.id === s.meta.defaultViewId) return void conflicts.push({ id: op.id, current: cur, reason: "default view" });
        remove(cur);
        if (cur.id[0] === "e") dropPositions(cur.id);
      } else if (op.op === "move") {
        for (const item of op.items ?? []) {
          const cur = s.positions.get(op.layout, item.id);
          if ((cur?.v ?? 0) !== item.expectV) { conflicts.push({ layout: op.layout, id: item.id, current: cur ?? null, reason: "moved since" }); continue; }
          if (item.unset) {
            if (item.withElement && s.objects.has(item.id)) continue;
            if (cur) setPos(op.layout, item.id, null);
            continue;
          }
          if (!s.objects.has(item.id)) continue;
          setPos(op.layout, item.id, { x: item.x, y: item.y, pin: item.pin, v: (cur?.v ?? 0) + 1 });
        }
      }
    };

    ops.forEach((op, i) => {
      try {
        if (!isObject(op)) return void errors.push(opError(i, "invalid_op", "Op must be an object"));
        if (force) return forceOp(op, i);
        if (op.op === "create") create(op, i);
        else if (op.op === "update") update(op, i);
        else if (op.op === "delete") del(op, i);
        else if (op.op === "move") move(op, i);
        else errors.push(opError(i, "invalid_op", 'op must be "create", "update", "delete" or "move"'));
      } catch (e) {
        errors.push(opError(i, "invalid_op", "Invalid operation: " + cleanLine(/** @type {any} */ (e)?.message, 200)));
      }
    });

    // A request that leaves a loop broken is refused as a whole: every change it made is put back.
    for (const [lid, i] of loopChecks) {
      const loop = s.objects.get(lid);
      if (!loop) continue;
      const problem = loopProblem(loop.steps, (id) => s.objects.get(id));
      if (!problem) continue;
      for (const [id, prev] of before) {
        const cur = s.objects.get(id);
        if (cur) indexRemove(s, cur);
        if (prev) indexAdd(s, prev);
      }
      for (const [layout, ids] of posBefore) for (const [id, p] of ids) s.positions.set(layout, id, p);
      const refused = [...errors, opError(i, "in_use", force
        ? `Undoing this now would break loop "${loop.label}" (${problem}), which changed since. Nothing was undone.`
        : `This change would break loop "${loop.label}": ${problem}. Nothing in this request was applied.`)];
      return finishUnchanged(s, requestId, senderId, digest, emptyResult(s.meta.revision, refused));
    }

    // ---- Structure (last-writer-wins) ----
    const meta0 = s.meta;
    let { title, description, defaultViewId } = meta0;
    if (req.structure !== undefined && req.structure !== null) {
      const st = req.structure;
      if (!isObject(st)) errors.push(opError(-1, "invalid_op", "structure must be an object"));
      else {
        if ("title" in st) title = cleanLine(st.title, L.title) || DEFAULT_TITLE;
        if ("description" in st) description = cleanText(st.description, 4000);
        if ("defaultViewId" in st) {
          if (isId(st.defaultViewId, "view") && s.objects.has(st.defaultViewId)) defaultViewId = st.defaultViewId;
          else errors.push(opError(-1, "invalid_ref", "defaultViewId must name a view"));
        }
      }
    }
    const structureChanged = title !== meta0.title || description !== meta0.description || defaultViewId !== meta0.defaultViewId;

    // Position byte budget (checked once, for all touched buckets).
    /** @type {{buckets: Record<string, any>, bytes: number, sizes: Map<string, number>}|null} */
    let posWrite = null;
    if (posTouched.size) {
      try {
        posWrite = s.positions.bucketsFor(posTouched);
        if (posWrite.bytes > L.positionsBytes && posWrite.bytes > s.positions.bytes) {
          // Refuse only the moves; objects (and positions dropped with deleted elements) stay.
          for (const [layout, ids] of moved) {
            for (const id of ids) {
              s.positions.set(layout, id, posBefore.get(layout)?.get(id) ?? null);
              posBefore.get(layout)?.delete(id);
              posTouched.get(layout)?.delete(id);
            }
          }
          for (const [layout, ids] of posTouched) if (!ids.size) posTouched.delete(layout);
          moveCount = 0;
          posWrite = posTouched.size ? s.positions.bucketsFor(posTouched) : null;
          errors.push(opError(-1, "limit", `Stored positions may take at most ${L.positionsBytes / 1024 / 1024} MiB; use the shared layout for more views`));
        }
      } catch (e) {
        state = null;
        throw e;
      }
    }

    if (!before.size && !posTouched.size && !structureChanged) {
      const status = conflicts.length ? "conflict" : "unchanged";
      return finishUnchanged(s, requestId, senderId, digest, { ...emptyResult(s.meta.revision, errors), status, conflicts });
    }

    // ---- Commit ----
    const revision = meta0.revision + 1;
    const meta = { ...meta0, revision, graphRevision: meta0.graphRevision + (graphChanged ? 1 : 0), title, description, defaultViewId, lastModified: at, demo: meta0.demo && !graphChanged };
    const upserts = [];
    const deletes = [];
    for (const [id] of before) {
      const cur = s.objects.get(id);
      if (cur) upserts.push(cur);
      else deletes.push(id);
    }
    const moves = [];
    for (const [layout, ids] of posTouched) {
      const m = { layout, ids: /** @type {string[]} */ ([]), x: /** @type {number[]} */ ([]), y: /** @type {number[]} */ ([]), pin: "", v: /** @type {number[]} */ ([]), unset: /** @type {string[]} */ ([]) };
      for (const id of ids) {
        const p = s.positions.get(layout, id);
        if (!p) { m.unset.push(id); continue; }
        m.ids.push(id); m.x.push(p.x); m.y.push(p.y); m.pin += p.pin ? "1" : "0"; m.v.push(p.v);
      }
      moves.push(m);
    }

    // Inverse.
    /** @type {any[]} */
    const inverse = [];
    const restoreCreates = [], restoreUpdates = [], restoreDeletes = [];
    for (const [id, prev] of before) {
      const cur = s.objects.get(id);
      if (!prev && cur) restoreDeletes.push({ op: "delete", id, expect: cur.version });
      else if (prev && !cur) restoreCreates.push({ op: "create", restore: prev });
      else if (prev && cur) restoreUpdates.push({ op: "update", id, expect: cur.version, restore: prev });
    }
    restoreCreates.sort((a, b) => CREATE_ORDER.indexOf(a.restore.id[0]) - CREATE_ORDER.indexOf(b.restore.id[0]));
    restoreDeletes.sort((a, b) => DELETE_ORDER.indexOf(a.id[0]) - DELETE_ORDER.indexOf(b.id[0]));
    // Recreate what was deleted and is referenced (types, fields, views, elements) first, then put
    // updated objects back (their references now exist), then recreate connections and loops,
    // then delete what the change created (nothing points at it any more), then positions.
    const early = restoreCreates.filter((op) => "tfve".includes(op.restore.id[0]));
    const late = restoreCreates.filter((op) => "cl".includes(op.restore.id[0]));
    restoreUpdates.sort((a, b) => CREATE_ORDER.indexOf(a.id[0]) - CREATE_ORDER.indexOf(b.id[0]));
    inverse.push(...early, ...restoreUpdates, ...late, ...restoreDeletes);
    for (const [layout, ids] of posBefore) {
      const items = [];
      for (const [id, prev] of ids) {
        const cur = s.positions.get(layout, id);
        // An unset for an element this request created goes only with the element: undo skips it
        // while the element survives (its deletion was refused).
        const created = before.has(id) && before.get(id) === null;
        items.push(prev ? { id, x: prev.x, y: prev.y, pin: prev.pin, expectV: cur?.v ?? 0 } : { id, unset: true, expectV: cur?.v ?? 0, ...(created ? { withElement: true } : {}) });
      }
      // Small ops, so every inverse chunk stays within LIMITS.valueBytes.
      for (let k = 0; k < items.length; k += INVERSE_MOVE_ITEMS) inverse.push({ op: "move", layout, items: items.slice(k, k + INVERSE_MOVE_ITEMS) });
    }
    const inverseStructure = structureChanged ? { title: meta0.title, description: meta0.description, defaultViewId: meta0.defaultViewId } : null;
    const inverseChunks = chunkByBytes([...inverse, ...(inverseStructure ? [{ op: "structure", structure: inverseStructure }] : [])], L.valueBytes);
    const inverseBytes = inverseChunks.reduce((n, c) => n + storedBytes(c), 0);
    const undoable = inverseBytes <= L.inverseEntryBytes;

    const counts = { created: restoreDeletes.length, updated: restoreUpdates.length, deleted: restoreCreates.length, moved: moveCount };
    const summary = summaryOverride ?? summarize(before, s, moveCount, structureChanged);
    const entry = {
      id: newId("history"), at, by, senderId, summary: cleanLine(summary, L.summary), revision, counts,
      undoable, inverseChunks: undoable ? inverseChunks.length : 0, inverseBytes: undoable ? inverseBytes : 0,
      ...(groupId ? { groupId } : {}), ...(undoOf ? { undoOf } : {}),
    };
    let history = [...s.history];
    if (undoOf) history = history.map((h) => (h.id === undoOf ? { ...h, undoneBy: entry.id } : h));
    history.push(entry);
    // Keep undo data within its quota: evict the oldest inverses first.
    let totalInverse = s.inverseBytes + entry.inverseBytes;
    /** @type {string[]} */
    const deleteInverse = [];
    for (let k = 0; k < history.length - 1 && totalInverse > L.inverseBytes; k++) {
      const h = history[k];
      if (!h.undoable) continue;
      totalInverse -= h.inverseBytes ?? 0;
      deleteInverse.push(h.id);
      history[k] = { ...h, undoable: false, inverseChunks: 0, inverseBytes: 0, evicted: true };
    }
    const kept = trimToBytes(history.slice(Math.max(0, history.length - L.historyEntries)), L.historyBytes);
    const keptIds = new Set(kept.map((h) => h.id));
    for (const h of history) if (!keptIds.has(h.id) && h.undoable) { deleteInverse.push(h.id); totalInverse -= h.inverseBytes ?? 0; }
    history = kept;

    const result = {
      status: "applied", revision, upserts, deletes, moves, structure: structureChanged ? { title, description, defaultViewId } : null,
      history: entry, conflicts, errors,
    };
    const requests = requestId ? withRecord(s, requestId, senderId, digest, result) : undefined;
    try {
      await repo.commit({
        meta, putObjects: upserts, deleteObjects: deletes, buckets: posWrite?.buckets, history, requests,
        putInverse: undoable ? { [entry.id]: inverseChunks } : undefined, deleteInverse,
        ...((typeof extraCommit === "function" ? extraCommit(result) : extraCommit) ?? {}),
      });
    } catch (e) {
      state = null;
      throw e;
    }
    if (posWrite) s.positions.applySizes(posWrite.sizes);
    s.meta = meta;
    s.history = history;
    s.inverseBytes = totalInverse;
    if (requests) s.requests = requests;
    afterCommit?.();
    const event = {
      type: "operation", revision, graphRevision: meta.graphRevision, senderId, requestId,
      upserts, deletes, moves, structure: result.structure, history: entry,
    };
    emit(event);
    return { result, event };
  }

  /**
   * @param {Map<string, any|null>} before @param {State} s @param {number} moved @param {boolean} structure
   */
  function summarize(before, s, moved, structure) {
    /** @type {Record<string, {created: number, updated: number, deleted: number, label?: string}>} */
    const by = {};
    for (const [id, prev] of before) {
      const cur = s.objects.get(id);
      const k = id[0];
      const b = (by[k] ??= { created: 0, updated: 0, deleted: 0 });
      if (!prev) b.created++;
      else if (!cur) b.deleted++;
      else b.updated++;
      b.label = (cur ?? prev)?.label ?? (cur ?? prev)?.name;
    }
    const parts = [];
    for (const k of "ecltfv") {
      const b = by[k];
      if (!b) continue;
      for (const [verb, n] of /** @type {const} */ ([["Added", b.created], ["Edited", b.updated], ["Deleted", b.deleted]])) {
        if (!n) continue;
        parts.push(n === 1 && b.label ? `${verb} ${NOUN[k][0]} “${cleanLine(b.label, 60)}”` : `${verb} ${n} ${NOUN[k][n === 1 ? 0 : 1]}`);
      }
    }
    if (moved) parts.push(`Moved ${moved} element${moved === 1 ? "" : "s"}`);
    if (structure) parts.push("Changed map settings");
    const text = parts.slice(0, 3).join("; ");
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Change";
  }

  // --- Undo -----------------------------------------------------------------------------------

  /**
   * @param {any} args {senderId, by, requestId, historyId?}
   */
  async function undoLocked(args) {
    const s = await load();
    const a = isObject(args) ? args : {};
    const by = cleanName(a.by, ANONYMOUS);
    const senderId = senderOf(a.senderId);
    const requestId = isRequestId(a.requestId) ? a.requestId : null;
    const digest = requestId ? digestOf({ undo: a.historyId ?? null, by }) : "";
    const dup = duplicateOf(s, requestId, senderId, digest);
    if (dup) return { result: dup, event: null };
    let entry;
    if (a.historyId !== undefined) {
      entry = s.history.find((h) => h.id === a.historyId);
      if (!entry) return { result: emptyResult(s.meta.revision, [opError(-1, "unknown_history", "No such change in the history")]), event: null };
    } else {
      entry = [...s.history].reverse().find((h) => h.by === by && h.undoable && !h.undoneBy);
      if (!entry) return { result: emptyResult(s.meta.revision, [opError(-1, "nothing_to_undo", "Nothing of yours to undo")]), event: null };
    }
    if (!entry.undoable) return { result: emptyResult(s.meta.revision, [opError(-1, "not_undoable", entry.evicted ? "This change is too old to undo: its undo data was evicted" : "This change was too large to record for undo")]), event: null };
    if (entry.undoneBy) return { result: emptyResult(s.meta.revision, [opError(-1, "already_undone", "This change was already undone")]), event: null };
    const chunks = await repo.getInverse(entry.id, entry.inverseChunks);
    const all = chunks.flat();
    const structure = all.find((o) => o.op === "structure")?.structure ?? null;
    const ops = all.filter((o) => o.op !== "structure");
    return applyLocked({ senderId, by, requestId, ops, structure }, { force: true, summary: `Undid: ${entry.summary}`, undoOf: entry.id, digest });
  }

  // --- Snapshots ------------------------------------------------------------------------------

  /** @param {State} s */
  function openSnapshotLocked(s) {
    const t = now();
    for (const [k, v] of snapshots) if (v.expires < t) snapshots.delete(k);
    while (snapshots.size >= L.snapshotTokens) snapshots.delete(/** @type {string} */ (snapshots.keys().next().value));
    const objects = [...s.objects.values()].sort((a, b) => CREATE_ORDER.indexOf(a.id[0]) - CREATE_ORDER.indexOf(b.id[0]));
    const positions = s.positions.keys().map((k) => s.positions.columns(k));
    const token = protocolNewId("group").slice(2) + protocolNewId("group").slice(2);
    const snap = {
      token, revision: s.meta.revision, graphRevision: s.meta.graphRevision, meta: structuredClone(s.meta),
      objects, positions, sizes: new Map(s.sizes), expires: t + L.snapshotTokenMs,
    };
    snapshots.set(token, snap);
    return snap;
  }

  /**
   * One page of a snapshot: objects from `cursor`, then position columns, by bytes.
   * @param {any} snap @param {number} cursor
   */
  function pageOf(snap, cursor) {
    const out = [];
    const positions = [];
    let bytes = 0;
    let i = cursor;
    const total = snap.objects.length + snap.positions.length;
    while (i < total) {
      const item = i < snap.objects.length ? snap.objects[i] : snap.positions[i - snap.objects.length];
      const n = i < snap.objects.length ? snap.sizes.get(item.id) ?? storedBytes(item) : storedBytes(item);
      if ((out.length || positions.length) && bytes + n > L.snapshotPageBytes) break;
      if (i < snap.objects.length) out.push(item);
      else positions.push(item);
      bytes += n;
      i++;
    }
    return { objects: structuredClone(out), positions: structuredClone(positions), next: i < total ? i : null, total };
  }

  // --- Public API -----------------------------------------------------------------------------

  /** @param {State} s */
  const counts = (s) => ({
    elements: s.counts.e ?? 0, connections: s.counts.c ?? 0, loops: s.counts.l ?? 0,
    views: s.counts.v ?? 0, types: s.counts.t ?? 0, fields: s.counts.f ?? 0,
  });

  const api = {
    LIMITS: L,

    /** Revision now, if loaded. */
    revisionNow: () => state?.meta.revision ?? null,
    getRevision: () => enqueue(async () => (await load()).meta.revision),

    /**
     * Opens a revision-consistent snapshot: returns the meta, counts and the first page. Pages
     * after the first come from snapshotPage(token, next).
     */
    openSnapshot: () => enqueue(async () => {
      const s = await load();
      const snap = openSnapshotLocked(s);
      const first = pageOf(snap, 0);
      return {
        token: snap.token, revision: snap.revision, graphRevision: snap.graphRevision, meta: snap.meta,
        counts: counts(s), limits: publicLimits(L), ...first,
      };
    }),

    /** @param {string} token @param {number} cursor */
    snapshotPage: (token, cursor) => enqueue(async () => {
      const snap = snapshots.get(String(token));
      if (!snap || snap.expires < now()) return { expired: true };
      snap.expires = now() + L.snapshotTokenMs;
      const c = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
      return { revision: snap.revision, ...pageOf(snap, c) };
    }),

    /** Everything at once, for small maps, exports and tests. */
    getMap: () => enqueue(async () => {
      const s = await load();
      return structuredClone({
        meta: s.meta, objects: [...s.objects.values()],
        positions: s.positions.keys().map((k) => s.positions.columns(k)),
      });
    }),

    /** @param {number} [limit] */
    getHistory: (limit = 50) => enqueue(async () => {
      const s = await load();
      const n = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, L.historyEntries) : 50;
      return structuredClone(s.history.slice(-n).reverse());
    }),

    /** @param {any} request {senderId, by, requestId, ops, structure} */
    applyOperation: (request) => enqueue(() => applyLocked(request)),

    /** @param {any} args {senderId, by, requestId, historyId?} */
    undo: (args) => enqueue(() => undoLocked(args)),

    /**
     * Undoes every change of a group (an import's chunks), newest first. Each is its own commit;
     * the result lists every part's outcome.
     * @param {any} args {groupId, senderId, by}
     */
    undoGroup: async (args) => {
      const a = isObject(args) ? args : {};
      const entries = await enqueue(async () => (await load()).history.filter((h) => h.groupId === a.groupId && h.undoable && !h.undoneBy).reverse());
      const results = [];
      for (const h of entries) results.push((await enqueue(() => undoLocked({ senderId: a.senderId, by: a.by, historyId: h.id }))).result);
      return { parts: results.length, conflicts: results.flatMap((r) => r.conflicts), errors: results.flatMap((r) => r.errors) };
    },

    /** Summary for agents: counts, types, fields, views and limits. */
    describeMap: () => enqueue(async () => {
      const s = await load();
      const list = (/** @type {string} */ k) => [...s.objects.values()].filter((o) => o.id[0] === k);
      return structuredClone({
        title: s.meta.title, description: s.meta.description, revision: s.meta.revision, counts: counts(s),
        types: list("t").map((t) => ({ id: t.id, name: t.name, appliesTo: t.appliesTo, color: t.color, used: s.typeUse.get(t.id) ?? 0 })),
        fields: list("f").map((f) => ({ id: f.id, name: f.name, kind: f.kind, appliesTo: f.appliesTo, choices: f.choices })),
        views: list("v").map((v) => ({ id: v.id, name: v.name, rules: v.rules.length, default: v.id === s.meta.defaultViewId })),
        limits: publicLimits(L),
      });
    }),

    /**
     * @param {any} [filter] {text?, type? (id or name), tag?, limit?}
     */
    findElements: (filter) => enqueue(async () => {
      const s = await load();
      const f = isObject(filter) ? filter : {};
      const text = normalizeLabel(f.text ?? "");
      const typeId = typeIdFor(s, f.type, "element");
      const tag = cleanLine(f.tag, 60).toLowerCase();
      const limit = Number.isSafeInteger(f.limit) && f.limit > 0 ? Math.min(f.limit, 500) : 50;
      const out = [];
      for (const o of s.objects.values()) {
        if (o.id[0] !== "e") continue;
        if (typeId !== undefined && o.typeId !== typeId) continue;
        if (tag && !(o.tags ?? []).some((/** @type {string} */ t) => t.toLowerCase() === tag)) continue;
        if (text && !normalizeLabel(o.label).includes(text) && !(o.aliases ?? []).some((/** @type {string} */ a) => normalizeLabel(a).includes(text))) continue;
        out.push({ ...o, degree: s.adj.get(o.id)?.size ?? 0 });
        if (out.length >= limit) break;
      }
      return structuredClone(out);
    }),

    /**
     * @param {any} args {id? | label?, depth?, limit?}
     */
    getNeighbourhood: (args) => enqueue(async () => {
      const s = await load();
      const a = isObject(args) ? args : {};
      const root = isId(a.id, "element") ? s.objects.get(a.id) : [...(s.byLabel.get(normalizeLabel(a.label)) ?? [])].map((id) => s.objects.get(id))[0];
      if (!root) return { root: null, elements: [], connections: [] };
      const depth = Number.isSafeInteger(a.depth) ? Math.min(Math.max(a.depth, 1), 3) : 1;
      const limit = Number.isSafeInteger(a.limit) ? Math.min(Math.max(a.limit, 1), 1000) : 200;
      const seen = new Set([root.id]);
      const conns = new Set();
      let frontier = [root.id];
      for (let d = 0; d < depth && frontier.length && seen.size < limit; d++) {
        const next = [];
        for (const id of frontier) {
          for (const cid of s.adj.get(id) ?? []) {
            const c = s.objects.get(cid);
            conns.add(cid);
            for (const other of [c.from, c.to]) {
              if (!seen.has(other) && seen.size < limit) { seen.add(other); next.push(other); }
            }
          }
        }
        frontier = next;
      }
      return structuredClone({
        root,
        elements: [...seen].map((id) => s.objects.get(id)),
        connections: [...conns].map((id) => s.objects.get(id)).filter((c) => seen.has(c.from) && seen.has(c.to)),
      });
    }),

    /** Markdown outline of the map for agents: types, then each element with its connections. */
    getMapMarkdown: (/** @type {any} */ args) => enqueue(async () => {
      const s = await load();
      const limit = isObject(args) && Number.isSafeInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 2000) : 300;
      const name = (/** @type {string} */ id) => s.objects.get(id)?.label ?? s.objects.get(id)?.name ?? id;
      const lines = [`# ${s.meta.title}`, "", s.meta.description || "", "", `${s.counts.e ?? 0} elements, ${s.counts.c ?? 0} connections, ${s.counts.l ?? 0} loops.`, ""];
      let n = 0;
      for (const o of s.objects.values()) {
        if (o.id[0] !== "e") continue;
        if (n++ >= limit) { lines.push(`… ${(s.counts.e ?? 0) - limit} more elements`); break; }
        lines.push(`- **${o.label}** (${o.typeId ? name(o.typeId) : "untyped"}, ${o.id})${o.description ? ": " + cleanLine(o.description, 200) : ""}`);
        for (const cid of s.adj.get(o.id) ?? []) {
          const c = s.objects.get(cid);
          if (c.from !== o.id) continue;
          const arrow = c.direction === "directed" ? "→" : c.direction === "mutual" ? "↔" : "—";
          lines.push(`  - ${arrow} ${name(c.to)}${c.typeId ? ` [${name(c.typeId)}]` : ""}${c.label ? ` “${c.label}”` : ""}${c.polarity ? ` (${c.polarity})` : ""}`);
        }
      }
      return lines.join("\n");
    }),

    // Internal hooks for the changeset workflow (src/core/changesets.js) and the server.
    _internal: {
      enqueue, load, applyLocked, emit, repo,
      /** @returns {State|null} */
      state: () => state,
      now,
      newId,
    },
  };
  return api;
}

/**
 * @param {any} s @param {unknown} type an id or a name @param {"element"|"connection"} appliesTo
 * @returns {string|null|undefined} undefined when no filter, null for "untyped"
 */
function typeIdFor(s, type, appliesTo) {
  if (type === undefined || type === null || type === "") return undefined;
  if (isId(type, "type")) return type;
  const n = normalizeLabel(type);
  if (n === "untyped") return null;
  for (const o of s.objects.values()) if (o.id[0] === "t" && o.appliesTo === appliesTo && normalizeLabel(o.name) === n) return o.id;
  return "t_000000000000";
}

/** @param {typeof DEFAULT_LIMITS} L */
function publicLimits(L) {
  return {
    elements: L.elements, connections: L.connections, loops: L.loops, views: L.views, types: L.types, fields: L.fields,
    objectBytes: L.objectBytes, objectsBytes: L.objectsBytes, opsPerRequest: L.opsPerRequest, commitObjects: L.commitObjects,
    movesPerRequest: L.movesPerRequest,
  };
}

export { KINDS };
