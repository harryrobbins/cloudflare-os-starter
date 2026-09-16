// @ts-check
// Subscriber registry and fan-out, transport-agnostic: the Durable Object uses it with RPC stubs
// and the browser harness with plain objects. A subscriber is anything with
// `operation(event)` and `presence(event)` methods that may return a promise.
//
// Dead subscribers are detected by a delivery rejecting (or throwing): the subscriber is removed
// and a presence "leave" is broadcast for it. `onRpcBroken` is also registered defensively, but
// local workerd does not implement it.
//
// Stubs are never disposed here. A client may treat its callback's disposal as "reconnect", so
// disposing a replaced stub could start a resubscribe loop; dropped references are released by GC.

import { cleanColor, cleanLine, cleanName, isId } from "../shared/protocol.js";

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

/** @typedef {{stub: any, info: PresenceInfo}} Entry */

export const DEFAULT_PRESENCE_COLOR = "#e1632e";
const CLIENT_ID_MAX = 64;

/** @param {unknown} v */
function cleanClientId(v) {
  return typeof v === "string" || typeof v === "number" ? cleanLine(v, CLIENT_ID_MAX) : "";
}

export class Hub {
  /** @param {{now?: () => number}} [options] */
  constructor({ now = Date.now } = {}) {
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
   * broadcasts the newcomer's "join" to all (the newcomer included). Re-adding a clientId
   * replaces the old entry. Returns the resolved clientId and a promise for the deliveries.
   * @param {any} stub
   * @param {any} clientInfo {clientId, name, color}
   * @returns {{clientId: string, delivered: Promise<void>}}
   */
  add(stub, clientInfo) {
    const raw = clientInfo && typeof clientInfo === "object" ? clientInfo : {};
    const clientId = cleanClientId(raw.clientId) || "anon_" + Math.random().toString(16).slice(2, 10);
    this.entries.delete(clientId);
    const others = [...this.entries.values()];
    /** @type {Entry} */
    const entry = { stub, info: cleanInfo({ ...raw, clientId }, null) };
    this.entries.set(clientId, entry);

    try {
      Promise.resolve(stub?.onRpcBroken?.(() => { this.#drop(entry); })).catch(() => {});
    } catch { /* not supported by this transport */ }

    const at = this.now();
    const tasks = others.map((o) => this.#deliver(entry, "presence", { type: "join", ...o.info, at }));
    tasks.push(this.presence({ type: "join", ...entry.info, at }));
    return { clientId, delivered: this.#track(Promise.all(tasks).then(() => {})) };
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
   * after a server restart) are not broadcast; the caller tells them to resubscribe.
   * @param {any} presence {clientId, name?, color?, openCardId?, dragCardId?, hoverColumnId?}
   * @returns {{known: boolean, delivered: Promise<void>}}
   */
  updatePresence(presence) {
    const raw = presence && typeof presence === "object" ? presence : {};
    const entry = this.entries.get(cleanClientId(raw.clientId));
    if (!entry) return { known: false, delivered: Promise.resolve() };
    entry.info = cleanInfo({ ...raw, clientId: entry.info.clientId }, entry.info);
    return { known: true, delivered: this.presence({ type: "update", ...entry.info, at: this.now() }) };
  }

  /**
   * Removes a subscriber (if present) and broadcasts "leave" to the rest.
   * @param {unknown} clientId
   * @returns {Promise<void>}
   */
  leave(clientId) {
    const id = cleanClientId(clientId);
    if (!id) return Promise.resolve();
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
    /** @type {Promise<unknown>} */
    let call;
    try {
      call = Promise.resolve(entry.stub[method](event));
    } catch (e) {
      call = Promise.reject(e);
    }
    return call.then(() => {}, () => this.#drop(entry));
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
