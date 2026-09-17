// @ts-check
// A scripted, in-memory stand-in for the Wave Gadget RPC surface, for client sync tests. It is
// NOT the real core (test/client/net.js runs the real one): it implements just enough of the
// protocol to exercise the store and the text channel: blip versions with "before this request"
// base matching, conflicts carrying the authoritative blip, last-writer-wins title, a template
// applied only once, requestId idempotency per sender, subscription sessions, presence arrays, a
// real Y.Doc per blip behind pushText / openBlip (returning {seq, textSeq} and diffs against a
// state vector), text events carrying prevTextSeq, and held or dropped deliveries to simulate gaps
// and restarts. All delays use setTimeout so tests drive it with fake timers.

import * as Y from "yjs";
import {
  DEFAULT_TITLE, LIMITS, cleanBlipOp, cleanLine, cleanParticipantOp, cleanPresence, cleanText,
  compareBlips, decodeBytes, encodeBytes, isRequestId, isTemplateId, previewOf,
} from "../../src/shared/protocol.js";
import { keyBetween } from "../../src/shared/order.js";

/** @typedef {import("../../src/shared/protocol.js").Blip} Blip */
/** @typedef {import("../../src/shared/protocol.js").Run} Run */
/** @typedef {import("../../src/shared/protocol.js").WaveEvent} WaveEvent */

export class FakeRpcTarget {}

let idCounter = 0;
/** A valid blip id ("b_" + 12 hex), unique per test process. */
export function fakeId() {
  return "b_" + (0x100000000000 + ++idCounter).toString(16).slice(-12);
}
function runId() {
  return "r_" + (0x100000000000 + ++idCounter).toString(16).slice(-12);
}

/**
 * @typedef {object} Subscriber
 * @property {any} callback
 * @property {any} state       presence state
 * @property {string} session
 */

export class FakeServer {
  /** @param {{latency?: number, eventLatency?: number, model?: boolean}} [opts] */
  constructor(opts = {}) {
    this.latency = opts.latency ?? 0;
    this.eventLatency = opts.eventLatency ?? this.latency;
    this.hasModel = opts.model ?? false;
    this.seq = 0;
    this.title = DEFAULT_TITLE;
    /** @type {string|null} */
    this.template = null;
    /** @type {Record<string, Blip>} */
    this.blips = {};
    /** @type {import("../../src/shared/protocol.js").Participant[]} */
    this.participants = [];
    /** @type {Map<string, Y.Doc>} */
    this.docs = new Map();
    /** @type {Map<string, {seq: number, at: number, by: string, update: Uint8Array}[]>} */
    this.updates = new Map();
    /** @type {WaveEvent[]} */
    this.events = [];
    /** @type {Run[]} */
    this.runs = [];
    this.lastModified = 0;
    /** @type {Map<string, Subscriber>} */
    this.subscribers = new Map();
    /** @type {Map<string, number>} */
    this.failures = new Map();
    /** @type {Map<string, any>} method -> error result returned instead of applying (once) */
    this.errorNext = new Map();
    this.epoch = 0;
    /** @type {{method: string, args: any[]}[]} */
    this.calls = [];
    /** @type {Set<string>} clients whose deliveries are silently discarded */
    this.dropping = new Set();
    /** @type {Map<string, {kind: string, event: any}[]>} clients whose deliveries are held */
    this.held = new Map();
    /** @type {Map<string, any>} `${senderId}\n${requestId}` -> recorded outcome; survives restarts */
    this.requests = new Map();
    this.sessionCounter = 0;
    /** @type {((req: any) => void)|null} called just before each write is applied */
    this.beforeApply = null;
  }

  // ---------------------------------------------------------------------------------------
  // Test controls
  // ---------------------------------------------------------------------------------------

  /**
   * Seeds a blip (and its text) without events.
   * @param {Partial<Blip> & {text?: string}} [fields]
   */
  seed(fields = {}) {
    const id = fields.id ?? fakeId();
    const parentId = fields.parentId ?? null;
    const { text, ...rest } = fields;
    /** @type {Blip} */
    const blip = {
      id, parentId, anchor: parentId === null ? null : { type: "end" }, kind: "note",
      order: this.lastOrder(parentId), by: "seed", createdAt: 0, updatedAt: 0, version: 1, seq: 0,
      textSeq: 0, textChars: 0, log: { count: 0, bytes: 0, sinceCompaction: 0, sinceCompactionBytes: 0 },
      deleted: false, locked: false, preview: "", ...rest,
    };
    this.blips[id] = blip;
    const doc = this.doc(id);
    if (text) doc.getText("t").insert(0, text);
    blip.textChars = doc.getText("t").length;
    blip.preview = previewOf(doc.getText("t").toString());
    return id;
  }

  /** @param {string|null} parentId */
  lastOrder(parentId) {
    let max = null;
    for (const b of Object.values(this.blips)) if (b.parentId === parentId && (max === null || b.order > max)) max = b.order;
    return keyBetween(max, null);
  }

  /** @param {string} id */
  doc(id) {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = new Y.Doc();
      this.docs.set(id, doc);
    }
    return doc;
  }

  /** @param {string} id */
  textOf(id) {
    return this.doc(id).getText("t").toString();
  }

  /** Drops every subscription without calling dispose (a facet restart). Docs survive (storage). */
  restart() {
    this.epoch++;
    this.subscribers.clear();
    this.held.clear();
  }

  /** @param {string} method */
  failNext(method) {
    this.failures.set(method, (this.failures.get(method) ?? 0) + 1);
  }

  /**
   * The next call of `method` returns this error result instead of applying.
   * @param {string} method @param {string} code
   */
  errorNextCall(method, code) {
    this.errorNext.set(method, { error: code, message: "injected " + code });
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

  /** @param {string} clientId @param {{discard?: boolean}} [opts] */
  releaseEvents(clientId, { discard = false } = {}) {
    const queued = this.held.get(clientId) ?? [];
    this.held.delete(clientId);
    if (discard) return;
    const sub = this.subscribers.get(clientId);
    for (const { kind, event } of queued) if (sub) this.deliver(sub, kind, event);
  }

  /** @param {string} method */
  callsOf(method) {
    return this.calls.filter((c) => c.method === method);
  }

  meta() {
    return {
      schemaVersion: 1, seq: this.seq, title: this.title,
      rootOrder: Object.values(this.blips).filter((b) => b.parentId === null).sort(compareBlips).map((b) => b.id),
      participants: this.participants, earliestSeq: 1, retainedBytes: 0, lastModified: this.lastModified,
      template: this.template,
    };
  }

  wave() {
    return structuredClone({
      meta: this.meta(), blips: this.blips, runs: this.runs.slice(-LIMITS.runs.keep), seq: this.seq,
      capabilities: { model: this.hasModel },
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
    const injected = this.errorNext.get(method);
    if (injected) this.errorNext.delete(method);
    const result = injected ?? fn();
    await this.delay(this.latency);
    if (epoch !== this.epoch) throw new Error("connection lost");
    return result === undefined ? undefined : structuredClone(result);
  }

  /**
   * @param {Subscriber} sub
   * @param {"operation"|"presence"|"text"} kind
   * @param {any} event
   */
  deliver(sub, kind, event) {
    const copy = structuredClone(kind === "operation" ? event : [event]);
    const epoch = this.epoch;
    setTimeout(() => {
      if (epoch !== this.epoch || this.subscribers.get(sub.state.clientId) !== sub) return;
      sub.callback[kind](copy);
    }, this.eventLatency);
  }

  /**
   * @param {"operation"|"presence"|"text"} kind
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
    /** @param {string} m @param {(...a: any[]) => any} fn */
    const method = (m, fn) => (/** @type {any[]} */ ...args) => server.call(m, args, () => fn(...args));
    return {
      getWave: method("getWave", () => server.wave()),
      subscribe: method("subscribe", (callback, info) => server.doSubscribe(callback, info)),
      applyOperation: method("applyOperation", (req) => server.doApply(req)),
      pushText: method("pushText", (req) => server.doPushText(req)),
      openBlip: method("openBlip", (req) => server.doOpenBlip(req)),
      reply: method("reply", (req) => server.doReply(req)),
      propose: method("propose", () => ({ error: "invalid_argument", message: "not in the fake" })),
      reviewProposal: method("reviewProposal", (req) => server.doReview(req)),
      recordDecision: method("recordDecision", (req) => server.doDecision(req)),
      askAgent: method("askAgent", (req) => server.doAskAgent(req)),
      cancelRun: method("cancelRun", (req) => server.doCancelRun(req)),
      getChanges: method("getChanges", (req) => server.doGetChanges(req)),
      getPlayback: method("getPlayback", (req) => server.doGetPlayback(req)),
      getRun: method("getRun", (req) => ({ run: server.runs.find((r) => r.id === req.runId) ?? null, seq: server.seq })),
      exportMarkdown: method("exportMarkdown", () => "# " + server.title + "\n"),
      getWaveMarkdown: method("getWaveMarkdown", () => "# " + server.title + "\n"),
      updatePresence: method("updatePresence", (p) => server.doPresence(p)),
      leavePresence: method("leavePresence", (clientId, session) => server.doLeave(clientId, session)),
    };
  }

  // ---------------------------------------------------------------------------------------
  // Subscriptions and presence
  // ---------------------------------------------------------------------------------------

  /** @param {any} callback @param {any} info */
  doSubscribe(callback, info) {
    const existing = this.subscribers.get(info.clientId);
    if (existing && existing.session !== info.session) throw new Error("clientId in use");
    const session = existing?.session ??
      (/^[0-9a-f]{32}$/.test(info.session ?? "") ? info.session : (++this.sessionCounter).toString(16).padStart(32, "0"));
    /** @type {Subscriber} */
    const sub = { callback, state: cleanPresence(info, info.clientId, null), session };
    const joins = [...this.subscribers].filter(([id]) => id !== info.clientId)
      .map(([, other]) => ({ type: "join", ...other.state, at: Date.now() }));
    this.subscribers.set(info.clientId, sub);
    for (const join of joins) this.deliver(sub, "presence", join);
    this.broadcast("presence", { type: "join", ...sub.state, at: Date.now() });
    return { ...this.wave(), session };
  }

  /** @param {any} p */
  doPresence(p) {
    const sub = this.subscribers.get(p.clientId);
    if (!sub || sub.session !== p.session) return { known: false, seq: this.seq };
    sub.state = cleanPresence(p, p.clientId, sub.state);
    this.broadcast("presence", { type: "update", ...sub.state, at: Date.now() }, p.clientId);
    return { known: true, seq: this.seq };
  }

  /** @param {string} clientId @param {string} [session] */
  doLeave(clientId, session) {
    const sub = this.subscribers.get(clientId);
    if (!sub || sub.session !== session) return;
    this.subscribers.delete(clientId);
    this.broadcast("presence", { type: "leave", clientId, at: Date.now() });
  }

  // ---------------------------------------------------------------------------------------
  // Commits
  // ---------------------------------------------------------------------------------------

  /**
   * Runs a write once per (senderId, requestId); a replay gets the recorded outcome with
   * duplicate: true.
   * @param {any} req
   * @param {() => any} fn
   * @param {(recorded: any) => any} [replay]  builds the duplicate result from the record
   */
  once(req, fn, replay = (r) => ({ ...r, seq: this.seq, duplicate: true })) {
    const key = isRequestId(req?.requestId) ? `${req.senderId ?? ""}\n${req.requestId}` : null;
    const recorded = key ? this.requests.get(key) : undefined;
    if (recorded) return structuredClone(replay(recorded));
    const result = fn();
    if (key && !result?.error) this.requests.set(key, structuredClone(result));
    return result;
  }

  /**
   * One committed change: bumps seq, records events.
   * @param {Omit<WaveEvent, "seq"|"at">[]} events
   * @param {string} by
   */
  commit(events, by) {
    this.seq++;
    const at = Date.now();
    this.lastModified = at;
    /** @type {WaveEvent[]} */
    const out = events.map((e) => ({ seq: this.seq, at, by, ...e }));
    this.events.push(...out);
    return out;
  }

  /** @param {Blip} blip @param {Set<string>} bumped */
  bump(blip, bumped) {
    if (!bumped.has(blip.id)) {
      blip.version++;
      bumped.add(blip.id);
    }
    blip.seq = this.seq;
    blip.updatedAt = this.lastModified;
  }

  /** @param {any} req */
  doApply(req) {
    return this.once(req, () => {
      this.beforeApply?.(req);
      return this.applyOnce(req);
    }, (r) => ({
      status: r.status, seq: this.seq, upserts: [], deletes: [], meta: null, events: [], errors: r.errors,
      conflicts: r.conflicts.map((/** @type {any} */ c) => ({ blipId: c.blipId, current: this.blips[c.blipId] ?? null })),
      duplicate: true,
    }));
  }

  /** @param {any} req */
  applyOnce(req) {
    const by = cleanLine(req.by, LIMITS.displayName) || "Guest";
    /** @type {any} */
    const result = { status: "unchanged", seq: this.seq, upserts: [], deletes: [], meta: null, events: [], conflicts: [], errors: [] };
    /** @type {Map<string, number>} */
    const before = new Map();
    /** @type {Set<string>} */
    const bumped = new Set();
    /** @type {Set<string>} */
    const touched = new Set();
    /** @type {string[]} */
    const deletes = [];
    /** @type {Omit<WaveEvent, "seq"|"at">[]} */
    const events = [];
    /** @type {Partial<import("../../src/shared/protocol.js").WaveMeta>} */
    const meta = {};
    let metaChanged = false;
    const remember = (/** @type {string} */ id) => { if (!before.has(id)) before.set(id, this.blips[id]?.version ?? 0); };
    const baseOk = (/** @type {string} */ id, /** @type {number} */ base) => base === this.blips[id].version || base === before.get(id);

    // Provisional seq: commit() assigns the real one; creates need it now for blip.seq.
    const nextSeq = this.seq + 1;
    const now = Date.now();
    (req.blipOps ?? []).forEach((/** @type {any} */ raw, /** @type {number} */ i) => {
      const cleaned = cleanBlipOp(raw);
      if (!cleaned.ok) return result.errors.push({ index: i, code: cleaned.code, message: cleaned.message });
      const op = cleaned.op;
      const blip = this.blips[op.blipId];
      if (op.op === "create") {
        if (blip) return result.errors.push({ index: i, code: "exists", message: "exists" });
        if (Object.keys(this.blips).length >= LIMITS.blips) return result.errors.push({ index: i, code: "limit", message: "too many blips" });
        if (op.parentId !== null) {
          const parent = this.blips[op.parentId];
          if (!parent) return result.errors.push({ index: i, code: "unknown_blip", message: "no parent" });
          if (parent.deleted) return result.errors.push({ index: i, code: "invalid_ref", message: "parent deleted" });
        }
        const doc = this.doc(op.blipId);
        if (op.text) doc.getText("t").insert(0, op.text);
        const text = doc.getText("t").toString();
        /** @type {Blip} */
        const created = {
          id: op.blipId, parentId: op.parentId, anchor: op.parentId === null ? null : op.anchor ?? { type: "end" },
          kind: op.kind ?? "note", order: op.order ?? this.lastOrder(op.parentId), by, createdAt: now, updatedAt: now,
          version: 1, seq: nextSeq, textSeq: op.text ? nextSeq : 0, textChars: text.length,
          log: { count: 0, bytes: 0, sinceCompaction: 0, sinceCompactionBytes: 0 }, deleted: false, locked: false,
          preview: previewOf(text),
          ...(raw.extra ?? {}), // internal callers only (doDecision): fields committed with the create
        };
        this.blips[op.blipId] = created;
        remember(op.blipId);
        bumped.add(op.blipId);
        touched.add(op.blipId);
        events.push({ kind: "blip.create", by, blipId: op.blipId });
        if (op.parentId === null) metaChanged = true;
        return;
      }
      if (!blip) return result.errors.push({ index: i, code: "unknown_blip", message: "unknown blip" });
      if (blip.locked) return result.errors.push({ index: i, code: "locked", message: "locked" });
      remember(op.blipId);
      if (!baseOk(op.blipId, op.baseVersion)) return result.conflicts.push({ blipId: op.blipId, current: structuredClone(blip) });
      if (op.op === "delete") {
        if (blip.deleted) return;
        blip.deleted = true;
        deletes.push(blip.id);
        events.push({ kind: "blip.delete", by, blipId: blip.id });
      } else if (op.op === "restore") {
        if (!blip.deleted) return;
        blip.deleted = false;
        events.push({ kind: "blip.restore", by, blipId: blip.id });
      } else if (op.op === "move") {
        blip.parentId = op.parentId;
        blip.anchor = op.parentId === null ? null : op.anchor ?? { type: "end" };
        if (op.order) blip.order = op.order;
        events.push({ kind: "blip.move", by, blipId: blip.id });
        metaChanged = true;
      }
      touched.add(blip.id);
    });

    if (req.structure && typeof req.structure === "object") {
      if (typeof req.structure.title === "string") {
        const title = cleanLine(req.structure.title, LIMITS.title);
        if (title !== this.title) {
          this.title = title;
          meta.title = title;
          metaChanged = true;
          events.push({ kind: "structure", by, detail: title });
        }
      }
      if (isTemplateId(req.structure.template) && this.template === null) {
        this.template = req.structure.template;
        meta.template = this.template;
        metaChanged = true;
      }
    }
    for (const raw of req.participantOps ?? []) {
      const op = cleanParticipantOp(raw);
      if (!op) continue;
      if (op.op === "upsert") {
        const i = this.participants.findIndex((p) => p.id === op.participant.id);
        if (i >= 0) this.participants[i] = op.participant;
        else this.participants.push(op.participant);
      } else {
        this.participants = this.participants.filter((p) => p.id !== op.id);
      }
      meta.participants = this.participants;
      metaChanged = true;
    }

    const changed = touched.size > 0 || metaChanged;
    if (changed) {
      const committed = this.commit(events, by);
      for (const id of touched) this.bump(this.blips[id], bumped);
      result.seq = this.seq;
      result.upserts = [...touched].map((id) => structuredClone(this.blips[id]));
      result.deletes = deletes;
      result.events = committed;
      meta.seq = this.seq;
      meta.lastModified = this.lastModified;
      meta.rootOrder = this.meta().rootOrder;
      result.meta = structuredClone(meta);
      this.broadcast("operation", {
        type: "operation", senderId: req.senderId ?? "", seq: this.seq, upserts: result.upserts, deletes,
        meta: result.meta, events: committed,
      });
    }
    result.status = result.conflicts.length ? "conflict" : changed ? "applied" : "unchanged";
    return structuredClone(result);
  }

  /** @param {any} req */
  doPushText(req) {
    return this.once(req, () => {
      const blip = this.blips[req.blipId];
      if (!blip) return { error: "unknown_blip", message: "unknown blip" };
      if (blip.locked) return { error: "locked", message: "decisions cannot be edited" };
      const bytes = decodeBytes(req.update, LIMITS.pushBytes);
      if (!bytes) return { error: "invalid_update", message: "bad base64" };
      const doc = this.doc(req.blipId);
      // Scratch check first, as the core does.
      const scratch = new Y.Doc();
      try {
        Y.applyUpdateV2(scratch, Y.encodeStateAsUpdateV2(doc));
        Y.applyUpdateV2(scratch, bytes);
      } catch {
        return { error: "invalid_update", message: "not a Yjs update" };
      }
      const length = scratch.getText("t").length;
      if (length > LIMITS.textChars) return { error: "blip_full", message: `text exceeds ${LIMITS.textChars} characters` };
      scratch.destroy();
      Y.applyUpdateV2(doc, bytes, "push");
      const by = cleanLine(req.by, LIMITS.displayName) || "Guest";
      const prevTextSeq = blip.textSeq;
      const [event] = this.commit([{ kind: "text", by, blipId: blip.id, bytes: bytes.length }], by);
      blip.textSeq = this.seq;
      blip.seq = this.seq;
      blip.updatedAt = this.lastModified;
      blip.textChars = length;
      blip.preview = previewOf(doc.getText("t").toString());
      blip.log.count++;
      blip.log.bytes += bytes.length;
      const list = this.updates.get(blip.id) ?? [];
      list.push({ seq: this.seq, at: event.at, by, update: bytes });
      this.updates.set(blip.id, list);
      this.broadcast("text", {
        blipId: blip.id, senderId: req.senderId ?? "", seq: this.seq, prevTextSeq, textSeq: this.seq, update: req.update,
      });
      this.broadcast("operation", {
        type: "operation", senderId: req.senderId ?? "", seq: this.seq, upserts: [structuredClone(blip)], deletes: [],
        events: [event],
      });
      return { seq: this.seq, textSeq: this.seq };
    }, (r) => ({ seq: r.seq, textSeq: r.textSeq, duplicate: true }));
  }

  /** @param {any} req */
  doOpenBlip(req) {
    const blip = this.blips[req?.blipId];
    if (!blip) return { error: "unknown_blip", message: "unknown blip" };
    const doc = this.doc(blip.id);
    let update;
    if (req.stateVector !== undefined) {
      const sv = decodeBytes(req.stateVector, LIMITS.stateVectorBytes);
      if (!sv) return { error: "invalid_argument", message: "bad state vector" };
      try {
        update = Y.encodeStateAsUpdateV2(doc, sv);
      } catch {
        return { error: "invalid_argument", message: "bad state vector" };
      }
    } else {
      update = Y.encodeStateAsUpdateV2(doc);
    }
    return { update: encodeBytes(update), seq: this.seq, textSeq: blip.textSeq };
  }

  /** @param {any} req */
  doReply(req) {
    return this.once(req, () => {
      const parent = this.blips[req.parentId];
      if (!parent || parent.deleted) return { error: "unknown_blip", message: "unknown parent" };
      const id = fakeId();
      const res = this.applyOnce({
        senderId: req.senderId, by: req.by,
        blipOps: [{ op: "create", blipId: id, parentId: req.parentId, anchor: req.anchor, text: cleanText(req.text, LIMITS.textChars) }],
      });
      if (res.errors.length) return { error: "invalid_argument", message: res.errors[0].message };
      return { blip: structuredClone(this.blips[id]), seq: this.seq };
    });
  }

  /** @param {any} req */
  doReview(req) {
    return this.once(req, () => {
      const blip = this.blips[req.proposalId];
      if (!blip || blip.kind !== "proposal" || !blip.proposal) return { error: "unknown_blip", message: "no such proposal" };
      if (blip.version !== req.expectedVersion) return { status: "conflict", blip: structuredClone(blip), seq: this.seq };
      const events = this.commit([{ kind: req.decision === "accept" ? "proposal.accept" : "proposal.reject", by: req.by ?? "", blipId: blip.id }], req.by ?? "");
      blip.proposal = { ...blip.proposal, state: req.decision === "accept" ? "accepted" : "rejected", reviewedBy: req.by ?? "", reviewedAt: Date.now() };
      this.bump(blip, new Set());
      this.broadcast("operation", { type: "operation", senderId: req.senderId ?? "", seq: this.seq, upserts: [structuredClone(blip)], deletes: [], events });
      return { status: req.decision === "accept" ? "applied" : "rejected", blip: structuredClone(blip), seq: this.seq };
    });
  }

  /** @param {any} req */
  doDecision(req) {
    return this.once(req, () => {
      const thread = this.blips[req.threadId];
      if (!thread) return { error: "unknown_blip", message: "unknown thread" };
      const id = fakeId();
      const res = this.applyOnce({
        senderId: req.senderId, by: req.by,
        // One commit, as on the server: a result and its echo never differ at one seq and version.
        blipOps: [{
          op: "create", blipId: id, parentId: req.threadId, text: cleanText(req.text, LIMITS.textChars),
          extra: { kind: "decision", locked: true, decision: { recordedBy: req.by ?? "", recordedAt: Date.now(), rationale: req.rationale ?? "", dissent: req.dissent ?? "", nextSteps: req.nextSteps ?? "" } },
        }],
      });
      if (res.errors.length) return { error: "invalid_argument", message: res.errors[0].message };
      return { blip: structuredClone(this.blips[id]), seq: this.seq };
    });
  }

  /** @param {any} req */
  doAskAgent(req) {
    return this.once(req, () => {
      if (!this.hasModel) return { error: "no_model", message: "no Model binding" };
      /** @type {Run} */
      const run = {
        id: runId(), op: req.op, by: req.by ?? "", instructions: req.instructions ?? "",
        scope: { blipIds: req.blipIds ?? [], sinceSeq: req.sinceSeq ?? 0, snapshotSeq: this.seq, inputBytes: 0, omitted: [] },
        state: "queued", generation: 1, createdAt: Date.now(),
      };
      this.runs.push(run);
      const events = this.commit([{ kind: "run.queued", by: run.by, runId: run.id }], run.by);
      this.broadcast("operation", { type: "operation", senderId: req.senderId ?? "", seq: this.seq, upserts: [], deletes: [], events, runs: [structuredClone(run)] });
      return { run: structuredClone(run), seq: this.seq };
    });
  }

  /** @param {any} req */
  doCancelRun(req) {
    return this.once(req, () => {
      const run = this.runs.find((r) => r.id === req.runId);
      if (!run) return { error: "unknown_run", message: "unknown run" };
      if (run.state === "queued" || run.state === "running") {
        run.state = "cancelled";
        run.finishedAt = Date.now();
        const events = this.commit([{ kind: "run.cancelled", by: req.by ?? "", runId: run.id }], req.by ?? "");
        this.broadcast("operation", { type: "operation", senderId: req.senderId ?? "", seq: this.seq, upserts: [], deletes: [], events, runs: [structuredClone(run)] });
      }
      return { run: structuredClone(run), seq: this.seq };
    });
  }

  /** @param {any} req */
  doGetChanges(req) {
    const limit = Math.min(req.limit ?? 200, 1000);
    return { events: this.events.filter((e) => e.seq > (req.afterSeq ?? 0)).slice(0, limit), seq: this.seq, earliestSeq: 1 };
  }

  /** @param {any} req */
  doGetPlayback(req) {
    if (!this.blips[req?.blipId]) return { error: "unknown_blip", message: "unknown blip" };
    const updates = (this.updates.get(req.blipId) ?? [])
      .filter((u) => u.seq >= (req.fromSeq ?? 0) && u.seq <= (req.toSeq ?? Infinity))
      .map((u) => ({ seq: u.seq, at: u.at, by: u.by, update: encodeBytes(u.update) }));
    return { base: { seq: 0, state: "" }, updates, seq: this.seq };
  }
}
