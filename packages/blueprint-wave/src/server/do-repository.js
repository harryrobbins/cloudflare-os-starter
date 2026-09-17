// @ts-check
// Repository over Durable Object storage (ctx.storage). Layout, as documented in README.md and
// src/core/repository.js:
//
//   "meta"               WaveMeta
//   "blip:<id>"          Blip
//   "text:<id>"          TextRecord (state: Uint8Array)
//   "base:<id>"          BaseRecord (state: Uint8Array)
//   "upd:<id>:<seq>"     UpdateRecord (update: Uint8Array); seq zero-padded to 12 digits
//   "event:<seq>"        WaveEvent; zero-padded likewise
//   "run:<id>"           Run
//   "req:<senderId>"     RequestRecord[]
//
// commit() runs inside storage.transaction(), so a multi-key write lands entirely or not at all.
// Keys are written and deleted in batches of 128 (the per-call key limit). Listings use
// storage.list({prefix, start, end, limit}); the zero-padded sequences make lexical order equal
// numeric order.

import { SEQ_DIGITS, parseSeqKey, seqKey } from "../shared/protocol.js";

/** @typedef {import("../core/repository.js").Commit} Commit */
/** @typedef {import("../core/repository.js").Repository} Repository */
/** @typedef {import("../core/repository.js").UpdateRecord} UpdateRecord */
/** @typedef {import("../shared/protocol.js").Blip} Blip */
/** @typedef {import("../shared/protocol.js").WaveEvent} WaveEvent */
/** @typedef {import("../shared/protocol.js").Run} Run */

/** storage.put/delete accept at most this many keys per call. */
const BATCH = 128;

export const BLIP_PREFIX = "blip:";
export const TEXT_PREFIX = "text:";
export const BASE_PREFIX = "base:";
export const UPDATE_PREFIX = "upd:";
export const EVENT_PREFIX = "event:";
export const RUN_PREFIX = "run:";
export const REQUEST_PREFIX = "req:";

/** @param {string} id */
export const blipKey = (id) => BLIP_PREFIX + id;
/** @param {string} id */
export const textKey = (id) => TEXT_PREFIX + id;
/** @param {string} id */
export const baseKey = (id) => BASE_PREFIX + id;
/** @param {string} blipId */
export const updatePrefix = (blipId) => UPDATE_PREFIX + blipId + ":";
/** @param {string} blipId @param {number} seq */
export const updateKey = (blipId, seq) => updatePrefix(blipId) + seqKey(seq);
/** @param {number} seq */
export const eventKey = (seq) => EVENT_PREFIX + seqKey(seq);
/** @param {string} id */
export const runKey = (id) => RUN_PREFIX + id;
/** @param {string} senderId */
export const requestKey = (senderId) => REQUEST_PREFIX + senderId;

/** The key just past every key with a 12-digit sequence: "…:" + "9" * 12 sorts after any digits. */
const SEQ_MAX_KEY = "9".repeat(SEQ_DIGITS);

/**
 * @template T
 * @param {T[]} items
 * @returns {T[][]}
 */
function chunks(items) {
  const out = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
}

/** @implements {Repository} */
export class DoStorageRepository {
  /** @param {any} storage DurableObjectStorage */
  constructor(storage) {
    this.storage = storage;
  }

  async getMeta() {
    return (await this.storage.get("meta")) ?? null;
  }

  async getBlips() {
    /** @type {Map<string, Blip>} */
    const entries = await this.storage.list({ prefix: BLIP_PREFIX });
    /** @type {Record<string, Blip>} */
    const blips = {};
    for (const [key, blip] of entries) {
      const id = key.slice(BLIP_PREFIX.length);
      if (blip && typeof blip === "object" && blip.id === id) blips[id] = blip;
    }
    return blips;
  }

  /** @param {string} id */
  async getText(id) {
    return (await this.storage.get(textKey(id))) ?? null;
  }

  /** @param {string} id */
  async getBase(id) {
    return (await this.storage.get(baseKey(id))) ?? null;
  }

  /** @param {string} id @param {{fromSeq?: number, toSeq?: number, limit?: number}} [range] */
  async listUpdates(id, { fromSeq = 0, toSeq, limit } = {}) {
    const prefix = updatePrefix(id);
    /** @type {any} */
    const options = { prefix, start: prefix + seqKey(Math.max(0, fromSeq)) };
    // `end` is exclusive: one past toSeq.
    options.end = prefix + (toSeq === undefined || toSeq >= 10 ** SEQ_DIGITS - 1 ? SEQ_MAX_KEY : seqKey(toSeq + 1));
    if (limit !== undefined && Number.isFinite(limit)) options.limit = Math.max(0, Math.floor(limit));
    /** @type {Map<string, UpdateRecord>} */
    const entries = await this.storage.list(options);
    /** @type {UpdateRecord[]} */
    const out = [];
    for (const [key, rec] of entries) {
      const seq = parseSeqKey(key);
      if (seq !== null && rec && typeof rec === "object" && rec.seq === seq) out.push(rec);
    }
    return out;
  }

  /** @param {{afterSeq?: number, limit?: number}} [range] */
  async listEvents({ afterSeq = 0, limit } = {}) {
    /** @type {any} */
    const options = { prefix: EVENT_PREFIX, start: eventKey(Math.max(0, afterSeq) + 1) };
    if (limit !== undefined && Number.isFinite(limit)) options.limit = Math.max(0, Math.floor(limit));
    /** @type {Map<string, WaveEvent>} */
    const entries = await this.storage.list(options);
    /** @type {WaveEvent[]} */
    const out = [];
    for (const [key, ev] of entries) {
      const seq = parseSeqKey(key);
      if (seq !== null && ev && typeof ev === "object" && ev.seq === seq) out.push(ev);
    }
    return out;
  }

  async getRuns() {
    /** @type {Map<string, Run>} */
    const entries = await this.storage.list({ prefix: RUN_PREFIX });
    /** @type {Run[]} */
    const out = [];
    for (const [key, run] of entries) {
      if (run && typeof run === "object" && run.id === key.slice(RUN_PREFIX.length)) out.push(run);
    }
    return out;
  }

  /** @param {string} senderId */
  async getRequests(senderId) {
    return (await this.storage.get(requestKey(senderId))) ?? [];
  }

  async listRequestSenders() {
    /** @type {Map<string, unknown>} */
    const entries = await this.storage.list({ prefix: REQUEST_PREFIX });
    return [...entries.keys()].map((k) => k.slice(REQUEST_PREFIX.length));
  }

  /** @param {Commit} commit */
  async commit(commit) {
    await this.storage.transaction(async (/** @type {any} */ txn) => {
      /** @type {Record<string, unknown>} */
      const puts = {};
      if (commit.meta) puts.meta = commit.meta;
      for (const blip of commit.putBlips ?? []) puts[blipKey(blip.id)] = blip;
      for (const text of commit.putText ?? []) puts[textKey(text.id)] = text;
      for (const base of commit.putBase ?? []) puts[baseKey(base.id)] = base;
      for (const rec of commit.putUpdates ?? []) puts[updateKey(rec.blipId, rec.seq)] = rec;
      for (const ev of commit.putEvents ?? []) puts[eventKey(ev.seq)] = ev;
      for (const run of commit.putRuns ?? []) puts[runKey(run.id)] = run;
      for (const { senderId, records } of commit.putRequests ?? []) puts[requestKey(senderId)] = records;
      const deletes = [
        ...(commit.deleteUpdates ?? []).map(({ blipId, seq }) => updateKey(blipId, seq)),
        ...(commit.deleteEvents ?? []).map(eventKey),
        ...(commit.deleteRuns ?? []).map(runKey),
        ...(commit.deleteRequests ?? []).map(requestKey),
      ].filter((k) => !Object.hasOwn(puts, k));
      for (const batch of chunks(deletes)) await txn.delete(batch);
      for (const batch of chunks(Object.entries(puts))) await txn.put(Object.fromEntries(batch));
    });
  }
}
