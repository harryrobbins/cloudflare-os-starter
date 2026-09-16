// @ts-check
// Subscriber registry and fan-out, transport-agnostic: the Durable Object uses it with RPC stubs
// and the browser harness with plain objects. A subscriber is anything with
// `operation(event)` and `presence(event)` methods that may return a promise.
//
// Dead subscribers are detected by a delivery rejecting (or throwing): the subscriber is removed
// and a presence "leave" is broadcast for it. `onRpcBroken` is also registered defensively, but
// local workerd does not implement it.
//
// Sessions: each entry holds a random session token that subscribe() hands only to its caller.
// Replacing a live entry, updating its presence or leaving needs that token, so knowing another
// user's clientId (it is broadcast) is not enough to hijack their subscription or presence.
//
// Backpressure: at most LIMITS.subscribers entries. A subscriber with more than MAX_INFLIGHT
// unsettled deliveries, or whose oldest unsettled delivery is older than INFLIGHT_TIMEOUT_MS, is
// dropped (and "leave" broadcast) when the next delivery to it would start. Identical presence
// updates less than PRESENCE_THROTTLE_MS apart are accepted but not fanned out.
//
// Stubs are never disposed here. A client may treat its callback's disposal as "reconnect", so
// disposing a replaced stub could start a resubscribe loop; dropped references are released by GC.

import { LIMITS, cleanColor, cleanLine, cleanName, isId, isSession, newSession } from "../shared/protocol.js";

/** @typedef {import("../shared/protocol.js").BoardEvent} BoardEvent */
/** @typedef {import("../shared/protocol.js").PresenceEvent} PresenceEvent */

/**
 * @typedef {object} PresenceInfo
 * @property {string} clientId
 * @property {string} name
 * @property {string} color
 * @property {string|null} openCardId
 * @property {string|null} dragCardId
 * @property {string|null} hoverColumnId
 */

/**
 * @typedef {object} Entry
 * @property {any} stub
 * @property {PresenceInfo} info
 * @property {string} session           never broadcast
 * @property {Set<{at: number}>} inflight unsettled deliveries, oldest first
 * @property {{at: number, json: string}|null} lastPresence  last update that was fanned out
 */

export const DEFAULT_PRESENCE_COLOR = "#e1632e";
// High enough that a script firing hundreds of writes within one round trip does not drop every
// live subscriber; the age check below is what catches a peer that has stopped reading.
export const MAX_INFLIGHT = 500;
export const INFLIGHT_TIMEOUT_MS = 30_000;
export const PRESENCE_THROTTLE_MS = 100;
const CLIENT_ID_MAX = 64;

/** @param {unknown} v */
function cleanClientId(v) {
  return typeof v === "string" || typeof v === "number" ? cleanLine(v, CLIENT_ID_MAX) : "";
}

export class Hub {
  /** @param {{now?: () => number, maxSubscribers?: number}} [options] */
  constructor({ now = Date.now, maxSubscribers = LIMITS.subscribers } = {}) {
    this.maxSubscribers = maxSubscribers;
    this.now = now;
    /** @type {Map<string, Entry>} insertion order = subscription order */
    this.entries = new Map();
    /** @type {Set<Promise<void>>} */
    this.pending = new Set();
  }

  get size() {
    return this.entries.size;
  }

  /** @param {unknown} clientId */
  has(clientId) {
    return this.entries.has(cleanClientId(clientId));
  }

  /** @returns {PresenceInfo[]} */
  list() {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }

  /**
   * Registers a subscriber. Replays a "join" for everyone already present to the newcomer, then
   * broadcasts the newcomer's "join" to all (the newcomer included).
   *
   * Re-adding a clientId replaces the old entry only when `session` matches it (the entry keeps
   * its session); otherwise throws Error("clientId in use"). A new entry takes `session` when it
   * is a well-formed token (so a client keeps its token across server restarts), else a fresh one.
   * Throws Error("board is full") when a new entry would exceed maxSubscribers.
   * @param {any} stub
   * @param {any} clientInfo {clientId, name, color, session?}
   * @returns {{clientId: string, session: string, delivered: Promise<void>}}
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
    this.entries.delete(clientId);
    const others = [...this.entries.values()];
    /** @type {Entry} */
    const entry = {
      stub, info: cleanInfo({ ...raw, clientId }, null), session, inflight: new Set(), lastPresence: null,
    };
    this.entries.set(clientId, entry);

    try {
      Promise.resolve(stub?.onRpcBroken?.(() => { this.#drop(entry); })).catch(() => {});
    } catch { /* not supported by this transport */ }

    const at = this.now();
    const tasks = others.map((o) => this.#deliver(entry, "presence", { type: "join", ...o.info, at }));
    tasks.push(this.presence({ type: "join", ...entry.info, at }));
    return { clientId, session, delivered: this.#track(Promise.all(tasks).then(() => {})) };
  }

  /**
   * Delivers `event` to every subscriber's `operation`. Calls are initiated synchronously in
   * subscription order, so per-subscriber order follows call order. Never rejects.
   * @param {BoardEvent} event
   * @returns {Promise<void>}
   */
  broadcast(event) {
    return this.#fanOut("operation", event);
  }

  /**
   * Delivers a presence event to every subscriber. Never rejects.
   * @param {PresenceEvent} event
   * @returns {Promise<void>}
   */
  presence(event) {
    return this.#fanOut("presence", event);
  }

  /**
   * Updates a subscriber's presence and broadcasts an "update". Unknown clients (for example
   * after a server restart) and a mismatched session are ignored with known: false; the caller
   * tells the client to resubscribe. An update identical to the last one fanned out less than
   * PRESENCE_THROTTLE_MS ago is accepted (known: true) but not fanned out.
   * @param {any} presence {clientId, session, name?, color?, openCardId?, dragCardId?, hoverColumnId?}
   * @returns {{known: boolean, delivered: Promise<void>}}
   */
  updatePresence(presence) {
    const raw = presence && typeof presence === "object" ? presence : {};
    const entry = this.entries.get(cleanClientId(raw.clientId));
    if (!entry || raw.session !== entry.session) return { known: false, delivered: Promise.resolve() };
    entry.info = cleanInfo({ ...raw, clientId: entry.info.clientId }, entry.info);
    const at = this.now();
    const json = JSON.stringify(entry.info);
    const last = entry.lastPresence;
    if (last && last.json === json && at - last.at < PRESENCE_THROTTLE_MS) {
      return { known: true, delivered: Promise.resolve() };
    }
    entry.lastPresence = { at, json };
    return { known: true, delivered: this.presence({ type: "update", ...entry.info, at }) };
  }

  /**
   * Removes a subscriber and broadcasts "leave" to the rest, only when `session` matches it.
   * @param {unknown} clientId
   * @param {unknown} session
   * @returns {Promise<void>}
   */
  leave(clientId, session) {
    const id = cleanClientId(clientId);
    const entry = id ? this.entries.get(id) : undefined;
    if (!entry || session !== entry.session) return Promise.resolve();
    this.entries.delete(id);
    return this.presence({ type: "leave", clientId: id, at: this.now() });
  }

  /** Resolves once every in-flight delivery (including cascading leaves) has settled. */
  async settled() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  // --- Internals -------------------------------------------------------------------------------

  /** @param {"operation"|"presence"} method @param {any} event */
  #fanOut(method, event) {
    const tasks = [...this.entries.values()].map((entry) => this.#deliver(entry, method, event));
    return this.#track(Promise.all(tasks).then(() => {}));
  }

  /** @param {Entry} entry @param {"operation"|"presence"} method @param {any} event */
  #deliver(entry, method, event) {
    if (this.entries.get(entry.info.clientId) !== entry) return Promise.resolve();
    const now = this.now();
    const oldest = entry.inflight.values().next().value;
    if (entry.inflight.size >= MAX_INFLIGHT || (oldest && now - oldest.at > INFLIGHT_TIMEOUT_MS)) {
      return this.#drop(entry);
    }
    const token = { at: now };
    entry.inflight.add(token);
    /** @type {Promise<unknown>} */
    let call;
    try {
      call = Promise.resolve(entry.stub[method](event));
    } catch (e) {
      call = Promise.reject(e);
    }
    return call.then(
      () => { entry.inflight.delete(token); },
      () => { entry.inflight.delete(token); return this.#drop(entry); },
    );
  }

  /** @param {Entry} entry */
  #drop(entry) {
    const { clientId } = entry.info;
    if (this.entries.get(clientId) !== entry) return Promise.resolve();
    this.entries.delete(clientId);
    return this.presence({ type: "leave", clientId, at: this.now() });
  }

  /** @param {Promise<void>} promise */
  #track(promise) {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }
}

/**
 * @param {any} raw
 * @param {PresenceInfo|null} previous
 * @returns {PresenceInfo}
 */
function cleanInfo(raw, previous) {
  /** @param {string} key @param {"card"|"column"} kind */
  const ref = (key, kind) => {
    if (!(key in raw)) return previous ? /** @type {any} */ (previous)[key] : null;
    return isId(raw[key], kind) ? raw[key] : null;
  };
  return {
    clientId: raw.clientId,
    name: cleanName(raw.name, previous?.name ?? "Guest"),
    color: cleanColor(raw.color) ?? previous?.color ?? DEFAULT_PRESENCE_COLOR,
    openCardId: ref("openCardId", "card"),
    dragCardId: ref("dragCardId", "card"),
    hoverColumnId: ref("hoverColumnId", "column"),
  };
}
