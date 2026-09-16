// @ts-check
// Subscriber registry and fan-out, transport-agnostic: the Durable Object uses it with RPC stubs
// and the browser harness with plain objects. A subscriber is anything with `operation(event)`
// and `presence(events)` (an ARRAY of PresenceEvent) methods that may return a promise.
//
// Sessions: each entry holds a random session token that add() hands only to its caller.
// Replacing a live entry, updating its presence or leaving needs that token, so knowing another
// user's clientId (it is broadcast) is not enough to hijack their subscription or presence.
//
// Operations: delivered immediately, in call order. A subscriber with MAX_INFLIGHT unsettled
// operation deliveries, or whose oldest unsettled one is older than INFLIGHT_TIMEOUT_MS, is
// dropped (and "leave" broadcast) when the next delivery to it would start.
//
// Presence is coalesced. Each subscriber has a pending map clientId -> latest event: a newer
// join/update replaces an older one (staying "join" while a join is pending), "leave" replaces
// anything. A flush timer (coalesceMs) delivers one presence([...]) call per subscriber with
// pending events; coalesceMs 0 flushes on every change. A subscriber with PRESENCE_MAX_INFLIGHT
// unsettled presence deliveries is skipped (its pending map keeps only the latest states, sent
// once a delivery settles). Presence deliveries do not count towards the operation limit, but a
// rejected one, or one unsettled for INFLIGHT_TIMEOUT_MS, drops the subscriber. A client's own
// presence is never delivered back to it.
//
// Stubs: onRpcBroken is never called (the runtime does not implement it, and passing a function
// over RPC creates a stub nobody disposes). Whenever an entry is removed (leave, drop, or replaced
// by a re-subscribe) its stub is disposed with [Symbol.dispose], errors ignored.

import { LIMITS, cleanLine, cleanPresence, isSession, newSession } from "../shared/protocol.js";

/** @typedef {import("../shared/protocol.js").BoardEvent} BoardEvent */
/** @typedef {import("../shared/protocol.js").PresenceEvent} PresenceEvent */
/** @typedef {import("../shared/protocol.js").PresenceState} PresenceState */

/**
 * @typedef {object} Entry
 * @property {any} stub
 * @property {PresenceState} state
 * @property {string} session                  never broadcast
 * @property {Set<{at: number}>} inflight      unsettled operation deliveries, oldest first
 * @property {Set<{at: number}>} presenceInflight  unsettled presence deliveries, oldest first
 * @property {Map<string, PresenceEvent>} pending  presence waiting for the next flush
 */

// High enough that a script firing hundreds of writes within one round trip does not drop every
// live subscriber; the age check is what catches a peer that has stopped reading.
export const MAX_INFLIGHT = 500;
export const INFLIGHT_TIMEOUT_MS = 30_000;
export const PRESENCE_MAX_INFLIGHT = 4;
// Measured on the local platform (spike, 3 clients): coalescing at 50 ms added ~40 ms p50 over direct
// fan-out; 33 ms keeps cursors near 30 Hz while capping outbound calls per subscriber.
export const DEFAULT_COALESCE_MS = 33;
const CLIENT_ID_MAX = 64;

/** @param {unknown} v */
function cleanClientId(v) {
  return typeof v === "string" || typeof v === "number" ? cleanLine(v, CLIENT_ID_MAX) : "";
}

/** @param {any} stub */
function dispose(stub) {
  try {
    const fn = stub?.[Symbol.dispose];
    if (typeof fn === "function") Promise.resolve(fn.call(stub)).catch(() => {});
  } catch { /* already disposed or not disposable */ }
}

export class Hub {
  /**
   * @param {{now?: () => number, timers?: {setTimeout: Function, clearTimeout: Function},
   *   maxSubscribers?: number, coalesceMs?: number}} [options]
   */
  constructor({ now = Date.now, timers, maxSubscribers = LIMITS.subscribers, coalesceMs = DEFAULT_COALESCE_MS } = {}) {
    this.now = now;
    this.timers = timers ?? {
      setTimeout: (/** @type {any} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms),
      clearTimeout: (/** @type {any} */ t) => clearTimeout(t),
    };
    this.maxSubscribers = maxSubscribers;
    this.coalesceMs = coalesceMs;
    /** @type {Map<string, Entry>} insertion order = subscription order */
    this.entries = new Map();
    /** @type {Set<Promise<void>>} */
    this.pending = new Set();
    /** @type {any} */
    this.timer = null;
  }

  get size() {
    return this.entries.size;
  }

  /** @param {unknown} clientId */
  has(clientId) {
    return this.entries.has(cleanClientId(clientId));
  }

  /** @returns {PresenceState[]} */
  list() {
    return [...this.entries.values()].map((e) => structuredClone(e.state));
  }

  /**
   * Registers a subscriber. The newcomer's first flush carries a "join" for everyone already
   * present; everyone else gets the newcomer's "join".
   *
   * Re-adding a clientId replaces (and disposes) the old entry only when `session` matches it (the
   * entry keeps its session); otherwise throws Error("clientId in use"). A new entry takes
   * `session` when it is a well-formed token (so a client keeps its token across server restarts),
   * else a fresh one. Throws Error("board is full") when a new entry would exceed maxSubscribers.
   * @param {any} stub
   * @param {any} clientInfo {clientId, name, color, session?}
   * @returns {{clientId: string, session: string}}
   */
  add(stub, clientInfo) {
    const raw = clientInfo && typeof clientInfo === "object" ? clientInfo : {};
    const clientId = cleanClientId(raw.clientId) || "anon_" + newSession().slice(0, 16);
    const existing = this.entries.get(clientId);
    let session;
    if (existing) {
      if (raw.session !== existing.session) throw new Error("clientId in use");
      session = existing.session;
    } else {
      if (this.entries.size >= this.maxSubscribers) throw new Error("board is full");
      session = isSession(raw.session) ? raw.session : newSession();
    }
    if (existing) {
      this.entries.delete(clientId);
      if (existing.stub !== stub) dispose(existing.stub);
    }
    const { session: _s, clientId: _c, ...fields } = raw;
    /** @type {Entry} */
    const entry = {
      stub, state: cleanPresence(fields, clientId, null), session,
      inflight: new Set(), presenceInflight: new Set(), pending: new Map(),
    };
    const at = this.now();
    for (const other of this.entries.values()) entry.pending.set(other.state.clientId, { type: "join", ...structuredClone(other.state), at });
    this.entries.set(clientId, entry);
    this.#enqueuePresence({ type: "join", ...structuredClone(entry.state), at });
    return { clientId, session };
  }

  /**
   * Delivers `event` to every subscriber's `operation`. Calls are initiated synchronously in
   * subscription order, so per-subscriber order follows call order. Never rejects.
   * @param {BoardEvent} event
   * @returns {Promise<void>}
   */
  broadcast(event) {
    const tasks = [...this.entries.values()].map((entry) => this.#deliverOperation(entry, event));
    return this.#track(Promise.all(tasks).then(() => {}));
  }

  /**
   * Updates a subscriber's presence (fields left out keep their value) and queues an "update" for
   * everyone else. Unknown clients (for example after a server restart) and a mismatched session
   * are ignored with known: false; the caller tells the client to re-subscribe.
   * @param {any} update PresenceUpdate
   * @returns {{known: boolean}}
   */
  updatePresence(update) {
    const raw = update && typeof update === "object" ? update : {};
    const entry = this.entries.get(cleanClientId(raw.clientId));
    if (!entry || typeof raw.session !== "string" || raw.session !== entry.session) return { known: false };
    const { session: _s, clientId: _c, ...fields } = raw;
    entry.state = cleanPresence(fields, entry.state.clientId, entry.state);
    this.#enqueuePresence({ type: "update", ...structuredClone(entry.state), at: this.now() });
    return { known: true };
  }

  /**
   * Removes (and disposes) a subscriber and queues "leave" for the rest, only when `session`
   * matches it.
   * @param {unknown} clientId
   * @param {unknown} session
   */
  leave(clientId, session) {
    const id = cleanClientId(clientId);
    const entry = id ? this.entries.get(id) : undefined;
    if (!entry || typeof session !== "string" || session !== entry.session) return;
    this.#remove(entry);
  }

  /**
   * Resolves once every in-flight delivery has settled and no presence is pending. Pending
   * presence is flushed immediately rather than waiting for the timer.
   */
  async settled() {
    for (let guard = 0; guard < 10_000; guard++) {
      if (this.pending.size) {
        await Promise.all([...this.pending]);
        continue;
      }
      const waiting = [...this.entries.values()].some((e) => e.pending.size);
      if (!waiting) {
        if (this.timer !== null) { this.timers.clearTimeout(this.timer); this.timer = null; }
        return;
      }
      if (this.timer !== null) { this.timers.clearTimeout(this.timer); this.timer = null; }
      this.#flush();
    }
  }

  // --- Internals -------------------------------------------------------------------------------

  /**
   * Queues a presence event for every subscriber except the client it is about.
   * @param {PresenceEvent} event
   */
  #enqueuePresence(event) {
    for (const entry of this.entries.values()) {
      if (entry.state.clientId === event.clientId) continue;
      const previous = entry.pending.get(event.clientId);
      entry.pending.set(event.clientId, event.type !== "leave" && previous?.type === "join"
        ? { ...event, type: "join" }
        : event);
    }
    this.#schedule();
  }

  #schedule() {
    if (this.coalesceMs <= 0) {
      this.#flush();
      return;
    }
    if (this.timer !== null) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.#flush();
    }, this.coalesceMs);
  }

  #flush() {
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if (!entry.pending.size || this.entries.get(entry.state.clientId) !== entry) continue;
      const oldest = entry.presenceInflight.values().next().value;
      if (oldest && now - oldest.at > INFLIGHT_TIMEOUT_MS) {
        this.#remove(entry);
        continue;
      }
      if (entry.presenceInflight.size >= PRESENCE_MAX_INFLIGHT) continue;
      const events = [...entry.pending.values()];
      entry.pending.clear();
      this.#track(this.#deliverPresence(entry, events, now));
    }
  }

  /** @param {Entry} entry @param {PresenceEvent[]} events @param {number} now */
  #deliverPresence(entry, events, now) {
    const token = { at: now };
    entry.presenceInflight.add(token);
    /** @type {Promise<unknown>} */
    let call;
    try {
      call = Promise.resolve(entry.stub.presence(events));
    } catch (e) {
      call = Promise.reject(e);
    }
    return call.then(
      () => {
        entry.presenceInflight.delete(token);
        // Catch up a subscriber that was skipped while its deliveries were in flight.
        if (entry.pending.size && this.entries.get(entry.state.clientId) === entry) this.#schedule();
      },
      () => {
        entry.presenceInflight.delete(token);
        this.#remove(entry);
      },
    );
  }

  /** @param {Entry} entry @param {BoardEvent} event */
  #deliverOperation(entry, event) {
    if (this.entries.get(entry.state.clientId) !== entry) return Promise.resolve();
    const now = this.now();
    const oldest = entry.inflight.values().next().value;
    if (entry.inflight.size >= MAX_INFLIGHT || (oldest && now - oldest.at > INFLIGHT_TIMEOUT_MS)) {
      this.#remove(entry);
      return Promise.resolve();
    }
    const token = { at: now };
    entry.inflight.add(token);
    /** @type {Promise<unknown>} */
    let call;
    try {
      call = Promise.resolve(entry.stub.operation(event));
    } catch (e) {
      call = Promise.reject(e);
    }
    return call.then(
      () => { entry.inflight.delete(token); },
      () => { entry.inflight.delete(token); this.#remove(entry); },
    );
  }

  /**
   * Removes an entry if it is still current, disposes its stub and queues its "leave".
   * @param {Entry} entry
   */
  #remove(entry) {
    const { clientId } = entry.state;
    if (this.entries.get(clientId) !== entry) return;
    this.entries.delete(clientId);
    entry.pending.clear();
    dispose(entry.stub);
    this.#enqueuePresence({ type: "leave", clientId, at: this.now() });
  }

  /** @param {Promise<void>} promise */
  #track(promise) {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }
}
