// @ts-check
// A scripted, in-memory stand-in for the whiteboard Gadget RPC surface, for client sync tests. It
// is NOT the real core (test/client/net.js runs the real one): it implements just enough of the
// protocol (per-object versions with "before this request" base matching, conflicts carrying the
// authoritative object, connector cascade, last-writer-wins structure, requestId idempotency,
// subscription sessions, presence arrays) to exercise the store. All delays use setTimeout so tests
// drive it with fake timers.

import {
  cleanObjectPatch, cleanPresence, isId, normalizeNewObject,
} from "../../src/shared/protocol.js";
import { keyBetween } from "../../src/shared/order.js";

/** @typedef {import("../../src/shared/protocol.js").WhiteboardObject} WhiteboardObject */

export class FakeRpcTarget {}

let idCounter = 0;
/** A valid object id ("o_" + 12 hex), unique per test process. */
export function fakeId() {
  return "o_" + (0x100000000000 + ++idCounter).toString(16).slice(-12);
}
function historyId() {
  return "h_" + (0x100000000000 + ++idCounter).toString(16).slice(-12);
}

/**
 * @typedef {object} Subscriber
 * @property {any} callback
 * @property {any} state       presence state
 * @property {string} session
 */

export class FakeServer {
  /** @param {{latency?: number, eventLatency?: number}} [opts] */
  constructor(opts = {}) {
    this.latency = opts.latency ?? 0;
    this.eventLatency = opts.eventLatency ?? this.latency;
    this.revision = 0;
    this.title = "Board";
    /** @type {"dots"|"grid"|"plain"} */
    this.background = "dots";
    /** @type {Record<string, WhiteboardObject>} */
    this.objects = {};
    this.lastModified = 0;
    /** @type {any[]} */
    this.history = [];
    /** @type {Map<string, Subscriber>} */
    this.subscribers = new Map();
    /** @type {Map<string, number>} */
    this.failures = new Map();
    this.epoch = 0;
    /** @type {{method: string, args: any[]}[]} */
    this.calls = [];
    /** @type {Set<string>} clients whose events are silently discarded */
    this.dropping = new Set();
    /** @type {Map<string, {kind: string, event: any}[]>} clients whose events are held */
    this.held = new Map();
    /** @type {Map<string, any>} requestId -> recorded outcome; survives restarts (it is stored) */
    this.requests = new Map();
    this.sessionCounter = 0;
    /** @type {((req: any) => void)|null} called just before each request is applied */
    this.beforeApply = null;
  }

  // ---------------------------------------------------------------------------------------
  // Test controls
  // ---------------------------------------------------------------------------------------

  /** @param {any} fields  at least {type}; id optional */
  seed(fields) {
    const id = fields.id ?? fakeId();
    const norm = /** @type {any} */ (normalizeNewObject({ ...fields, id }));
    if (!norm.z) norm.z = this.topZ();
    this.objects[id] = { ...norm, version: 1, createdAt: 0, updatedAt: 0, createdBy: "seed" };
    return id;
  }

  topZ() {
    let max = null;
    for (const o of Object.values(this.objects)) if (max === null || o.z > max) max = o.z;
    return keyBetween(max, null);
  }

  /** Drops every subscription without calling dispose (a facet restart). */
  restart() {
    this.epoch++;
    this.subscribers.clear();
    this.held.clear();
  }

  /** @param {string} method */
  failNext(method) {
    this.failures.set(method, (this.failures.get(method) ?? 0) + 1);
  }

  /** @param {string} clientId  removes a subscriber and calls its callback's dispose */
  disposeSubscriber(clientId) {
    const sub = this.subscribers.get(clientId);
    this.subscribers.delete(clientId);
    sub?.callback[Symbol.dispose]?.();
  }

  /** @param {string} clientId  removes a subscriber with no leave and no dispose */
  silentDrop(clientId) {
    this.subscribers.delete(clientId);
  }

  /** @param {string} clientId */
  holdEvents(clientId) {
    if (!this.held.has(clientId)) this.held.set(clientId, []);
  }

  /** @param {string} clientId */
  releaseEvents(clientId) {
    const queued = this.held.get(clientId) ?? [];
    this.held.delete(clientId);
    const sub = this.subscribers.get(clientId);
    for (const { kind, event } of queued) if (sub) this.deliver(sub, kind, event);
  }

  /** @param {string} method */
  callsOf(method) {
    return this.calls.filter((c) => c.method === method);
  }

  board() {
    return structuredClone({
      schemaVersion: 1, revision: this.revision, title: this.title, background: this.background,
      objects: this.objects, lastModified: this.lastModified,
    });
  }

  // ---------------------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------------------

  /** @param {number} ms */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * @param {string} method
   * @param {any[]} args
   * @param {() => any} fn
   */
  async call(method, args, fn) {
    this.calls.push({ method, args: structuredClone(args.filter((a) => !(a instanceof FakeRpcTarget))) });
    const epoch = this.epoch;
    await this.delay(this.latency);
    const failing = this.failures.get(method) ?? 0;
    if (failing > 0) {
      this.failures.set(method, failing - 1);
      throw new Error("injected failure: " + method);
    }
    if (epoch !== this.epoch) throw new Error("connection lost");
    const result = fn();
    await this.delay(this.latency);
    if (epoch !== this.epoch) throw new Error("connection lost");
    return result === undefined ? undefined : structuredClone(result);
  }

  /**
   * @param {Subscriber} sub
   * @param {"operation"|"presence"} kind
   * @param {any} event
   */
  deliver(sub, kind, event) {
    const copy = structuredClone(kind === "presence" ? [event] : event);
    const epoch = this.epoch;
    setTimeout(() => {
      if (epoch !== this.epoch || this.subscribers.get(sub.state.clientId) !== sub) return;
      sub.callback[kind](copy);
    }, this.eventLatency);
  }

  /**
   * @param {"operation"|"presence"} kind
   * @param {any} event
   * @param {string|null} [except]
   */
  broadcast(kind, event, except = null) {
    for (const [clientId, sub] of this.subscribers) {
      if (clientId === except || this.dropping.has(clientId)) continue;
      const held = this.held.get(clientId);
      if (held) held.push({ kind, event });
      else this.deliver(sub, kind, event);
    }
  }

  /** A gadget stub for one client. */
  connect() {
    const server = this;
    return {
      getBoard: () => server.call("getBoard", [], () => server.board()),
      /** @param {any} callback @param {any} info */
      subscribe: (callback, info) => server.call("subscribe", [callback, info], () => server.doSubscribe(callback, info)),
      /** @param {any} req */
      applyOperation: (req) => server.call("applyOperation", [req], () => server.doApply(req)),
      /** @param {number} [limit] */
      getHistory: (limit = 50) => server.call("getHistory", [limit], () => server.history.slice(-limit)),
      /** @param {any} req */
      undo: (req) => server.call("undo", [req], () => server.doUndo(req)),
      /** @param {any} p */
      updatePresence: (p) => server.call("updatePresence", [p], () => server.doPresence(p)),
      /** @param {string} clientId @param {string} [session] */
      leavePresence: (clientId, session) => server.call("leavePresence", [clientId, session], () => server.doLeave(clientId, session)),
    };
  }

  // ---------------------------------------------------------------------------------------
  // RPC implementations
  // ---------------------------------------------------------------------------------------

  /** @param {any} callback @param {any} info */
  doSubscribe(callback, info) {
    const existing = this.subscribers.get(info.clientId);
    if (existing && existing.session !== info.session) throw new Error("clientId in use");
    const session = existing?.session ??
      (/^[0-9a-f]{32}$/.test(info.session ?? "") ? info.session : (++this.sessionCounter).toString(16).padStart(32, "0"));
    /** @type {Subscriber} */
    const sub = { callback, state: cleanPresence(info, info.clientId, null), session };
    // Like the hub, the newcomer's first presence delivery carries a join for everyone present.
    const joins = [...this.subscribers].filter(([id]) => id !== info.clientId)
      .map(([, other]) => ({ type: "join", ...other.state, at: Date.now() }));
    if (joins.length) this.deliver(sub, "presence", joins);
    this.subscribers.set(info.clientId, sub);
    this.broadcast("presence", { type: "join", ...sub.state, at: Date.now() });
    return { ...this.board(), session };
  }

  /** @param {any} p */
  doPresence(p) {
    const sub = this.subscribers.get(p.clientId);
    if (!sub || sub.session !== p.session) return { known: false, revision: this.revision };
    sub.state = cleanPresence(p, p.clientId, sub.state);
    this.broadcast("presence", { type: "update", ...sub.state, at: Date.now() }, p.clientId);
    return { known: true, revision: this.revision };
  }

  /** @param {string} clientId @param {string} [session] */
  doLeave(clientId, session) {
    const sub = this.subscribers.get(clientId);
    if (!sub || sub.session !== session) return;
    this.subscribers.delete(clientId);
    this.broadcast("presence", { type: "leave", clientId, at: Date.now() });
  }

  /**
   * Runs a request once per requestId; a replay gets the recorded outcome with duplicate: true.
   * @param {any} req
   * @param {() => any} fn
   */
  once(req, fn) {
    const id = req.requestId;
    const recorded = typeof id === "string" ? this.requests.get(id) : undefined;
    if (recorded) {
      return structuredClone({
        status: recorded.status, errors: recorded.errors, revision: this.revision, upserts: [], deletes: [],
        structure: null, history: null, duplicate: true,
        conflicts: recorded.conflicts.map((/** @type {string} */ cid) => ({ id: cid, current: this.objects[cid] ?? null })),
      });
    }
    const result = fn();
    if (typeof id === "string") {
      this.requests.set(id, {
        status: result.status, errors: result.errors, conflicts: result.conflicts.map((/** @type {any} */ c) => c.id),
      });
    }
    return result;
  }

  /** @param {any} req */
  doUndo(req) {
    return this.once(req, () => {
      const entry = this.history.find((h) => h.id === req.historyId);
      if (!entry?.inverse) return this.applyOnce({ senderId: req.senderId, by: req.by }, false);
      return this.applyOnce({ senderId: req.senderId, by: req.by, objectOps: entry.inverse.objectOps }, true);
    });
  }

  /** @param {any} req */
  doApply(req) {
    return this.once(req, () => {
      this.beforeApply?.(req);
      return this.applyOnce(req, false);
    });
  }

  /**
   * @param {any} req
   * @param {boolean} force  ignore base versions (server undo)
   */
  applyOnce(req, force) {
    const now = Date.now();
    /** @type {any} */
    const result = {
      status: "unchanged", revision: this.revision, upserts: [], deletes: [], structure: null,
      history: null, conflicts: [], errors: [],
    };
    if ((req.objectOps?.length ?? 0) > 1000) {
      result.errors.push({ index: -1, code: "limit", message: "too many ops" });
      return structuredClone(result);
    }
    /** @type {Map<string, number|null>} version each touched object had before this request */
    const before = new Map();
    /** @type {Set<string>} */
    const changedIds = new Set();
    /** @type {Set<string>} */
    const deleted = new Set();
    /** @type {any[]} */
    const inverse = [];
    /** @param {string} id */
    const remember = (id) => { if (!before.has(id)) before.set(id, this.objects[id]?.version ?? null); };
    /** @param {string} id @param {number} base */
    const baseOk = (id, base) => force || base === this.objects[id]?.version || base === before.get(id);
    /** @param {number} index @param {string} code */
    const error = (index, code) => result.errors.push({ index, code, message: `op ${index}: ${code}` });
    /** @param {string} id */
    const conflict = (id) => result.conflicts.push({ id, current: structuredClone(this.objects[id] ?? null) });
    /** @type {Set<string>} objects whose version this request already bumped (or created) */
    const bumped = new Set();
    /** @param {WhiteboardObject} o */
    const bump = (o) => {
      if (bumped.has(o.id)) return o;
      bumped.add(o.id);
      return { ...o, version: o.version + 1 };
    };
    /** @param {string|undefined} id */
    const endpoint = (id) => Boolean(id && this.objects[id] && this.objects[id].type !== "connector");

    (req.objectOps ?? []).forEach((/** @type {any} */ op, /** @type {number} */ i) => {
      if (op?.op === "create") {
        const norm = /** @type {any} */ (normalizeNewObject(op.object));
        if (!norm) return error(i, "invalid_id");
        if (this.objects[norm.id]) return error(i, "exists");
        if (norm.type === "connector" && (!endpoint(norm.from) || !endpoint(norm.to) || norm.from === norm.to)) {
          return error(i, "invalid_ref");
        }
        if (norm.type === "pen" && norm.points.length < 4) return error(i, "invalid_op");
        // Like the core: a frameId naming no object is cleared (the frame was deleted meanwhile);
        // one naming an object that is not a frame is refused.
        if (norm.frameId && this.objects[norm.frameId] && this.objects[norm.frameId].type !== "frame") return error(i, "invalid_ref");
        if (norm.frameId && !this.objects[norm.frameId]) norm.frameId = null;
        if (!norm.z) norm.z = this.topZ();
        remember(norm.id);
        const obj = { ...norm, version: 1, createdAt: now, updatedAt: now, createdBy: req.by ?? "" };
        this.objects[norm.id] = obj;
        changedIds.add(norm.id);
        bumped.add(norm.id);
        deleted.delete(norm.id);
        inverse.push({ op: "delete", id: norm.id, baseVersion: 1 });
      } else if (op?.op === "update") {
        const obj = this.objects[op.id];
        if (!obj) {
          if (before.has(op.id) || deleted.has(op.id) || isId(op.id)) return conflict(op.id);
          return error(i, "unknown_object");
        }
        remember(op.id);
        if (!baseOk(op.id, op.baseVersion)) return conflict(op.id);
        const patch = /** @type {any} */ (cleanObjectPatch(op.patch, obj.type));
        if ((patch.from && !endpoint(patch.from)) || (patch.to && !endpoint(patch.to))) return error(i, "invalid_ref");
        if (patch.frameId && this.objects[patch.frameId] && this.objects[patch.frameId].type !== "frame") return error(i, "invalid_ref");
        if (patch.frameId && !this.objects[patch.frameId]) patch.frameId = null;
        const next = { ...obj, ...patch, style: patch.style ? { ...obj.style, ...patch.style } : obj.style };
        if (JSON.stringify(next) === JSON.stringify(obj)) return;
        /** @type {any} */
        const prev = {};
        for (const k of Object.keys(patch)) prev[k] = k === "style" ? Object.fromEntries(Object.keys(patch.style).map((s) => [s, /** @type {any} */ (obj.style)[s]])) : /** @type {any} */ (obj)[k];
        inverse.push({ op: "update", id: op.id, baseVersion: 0, patch: prev });
        this.objects[op.id] = bump({ ...next, updatedAt: now });
        changedIds.add(op.id);
      } else if (op?.op === "delete") {
        const obj = this.objects[op.id];
        if (!obj) return conflict(op.id);
        remember(op.id);
        if (!baseOk(op.id, op.baseVersion)) return conflict(op.id);
        const victims = [obj, ...Object.values(this.objects).filter((o) => o.type === "connector" && (o.from === op.id || o.to === op.id))];
        for (const v of victims) {
          inverse.push({ op: "create", object: structuredClone(v) });
          delete this.objects[v.id];
          changedIds.delete(v.id);
          deleted.add(v.id);
        }
      } else {
        error(i, "invalid_op");
      }
    });

    let structure = false;
    if (req.structure && typeof req.structure === "object") {
      if (typeof req.structure.title === "string") { this.title = req.structure.title.trim(); structure = true; }
      if (["dots", "grid", "plain"].includes(req.structure.background)) { this.background = req.structure.background; structure = true; }
    }

    const upserts = [...changedIds].filter((id) => this.objects[id]).map((id) => this.objects[id]);
    const deletes = [...deleted].filter((id) => !this.objects[id] && before.get(id) !== null);
    const changed = upserts.length > 0 || deletes.length > 0 || structure;
    if (changed) {
      this.revision++;
      this.lastModified = now;
      result.revision = this.revision;
      result.upserts = upserts;
      result.deletes = deletes;
      if (structure) result.structure = { title: this.title, background: this.background };
      // Inverse ops reverse in reverse order; creates of endpoints come before their connectors.
      const inv = inverse.reverse();
      result.history = { id: historyId(), at: now, by: req.by ?? "", summary: "change", inverse: inv.length ? { objectOps: inv } : null };
      this.history.push(result.history);
      this.broadcast("operation", {
        type: "operation", senderId: req.senderId ?? "", revision: this.revision, upserts, deletes,
        structure: result.structure, history: result.history, lastModified: now,
      });
    }
    result.status = result.conflicts.length ? "conflict" : changed ? "applied" : "unchanged";
    return structuredClone(result);
  }
}
