// @ts-check
// The storage seam. Wave rules (src/core/wave.js, src/core/runs.js) talk only to a Repository, so
// the same rules run over Durable Object storage (src/server/do-repository.js), in memory for
// tests and the harness, and later over another backend.
//
// Layout (one storage key per record; the DO repository builds the keys, see do-repository.js):
//   meta                 WaveMeta
//   blip:<id>            Blip
//   text:<id>            TextRecord     compacted Y.Text state (Uint8Array) as of textSeq
//   base:<id>            BaseRecord     the earliest state playback can start from
//   upd:<id>:<seq>       UpdateRecord   one Yjs V2 update; seq zero-padded (seqKey) so a prefix
//                                       listing is in sequence order
//   event:<seq>          WaveEvent      zero-padded likewise
//   run:<id>             Run
//   req:<senderId>       RequestRecord[]  newest last
//
// Binary values (state, update) are Uint8Array in storage and in memory; structuredClone keeps
// the type, so the in-memory repository hands out copies with the same shape the DO returns.
// Sizes are bounded by the core with storedBytes; every write goes through commit(), which
// applies all of its fields in ONE transaction, or none of them.

/** @typedef {import("../shared/protocol.js").WaveMeta} WaveMeta */
/** @typedef {import("../shared/protocol.js").Blip} Blip */
/** @typedef {import("../shared/protocol.js").WaveEvent} WaveEvent */
/** @typedef {import("../shared/protocol.js").Run} Run */
/** @typedef {import("../shared/protocol.js").RequestRecord} RequestRecord */

/**
 * "text:<id>": the compacted state of a blip's Y.Text as of `textSeq` (a V2 update encoding the
 * whole doc). Hydration applies it, then every "upd:" record with seq > textSeq.
 * @typedef {object} TextRecord
 * @property {string} id
 * @property {number} textSeq
 * @property {Uint8Array} state
 */

/**
 * "base:<id>": the state playback starts from. `seq` is the sequence of the last update folded
 * into it (0 with an empty state when nothing was ever trimmed: playback then starts from an
 * empty doc). Retention trimming folds the oldest "upd:" records into it and deletes them.
 * @typedef {object} BaseRecord
 * @property {string} id
 * @property {number} seq
 * @property {Uint8Array} state
 */

/**
 * "upd:<id>:<seq>": one committed text update.
 * @typedef {object} UpdateRecord
 * @property {string} blipId
 * @property {number} seq      the global event sequence this push took
 * @property {string} by
 * @property {number} at
 * @property {Uint8Array} update
 */

/**
 * One atomic write. Every present field is applied together or not at all. Deletes are applied
 * before puts, so a key both deleted and put ends up put.
 * @typedef {object} Commit
 * @property {WaveMeta} [meta]
 * @property {Blip[]} [putBlips]
 * @property {TextRecord[]} [putText]
 * @property {BaseRecord[]} [putBase]
 * @property {UpdateRecord[]} [putUpdates]
 * @property {{blipId: string, seq: number}[]} [deleteUpdates]
 * @property {WaveEvent[]} [putEvents]
 * @property {number[]} [deleteEvents]   sequences
 * @property {Run[]} [putRuns]
 * @property {string[]} [deleteRuns]     run ids
 * @property {{senderId: string, records: RequestRecord[]}[]} [putRequests]  replaces the sender's list
 * @property {string[]} [deleteRequests]  sender ids
 */

/**
 * @typedef {object} Repository
 * @property {() => Promise<WaveMeta|null>} getMeta          null for a wave never initialised
 * @property {() => Promise<Record<string, Blip>>} getBlips  every "blip:" record keyed by id
 * @property {(id: string) => Promise<TextRecord|null>} getText
 * @property {(id: string) => Promise<BaseRecord|null>} getBase
 * @property {(id: string, range?: {fromSeq?: number, toSeq?: number, limit?: number}) => Promise<UpdateRecord[]>} listUpdates
 *   a blip's retained updates with fromSeq <= seq <= toSeq (inclusive, defaults: all), ascending,
 *   at most `limit` (default: all)
 * @property {(range?: {afterSeq?: number, limit?: number}) => Promise<WaveEvent[]>} listEvents
 *   events with seq > afterSeq (default 0), ascending, at most `limit` (default: all)
 * @property {() => Promise<Run[]>} getRuns                  every "run:" record, by id order
 * @property {(senderId: string) => Promise<RequestRecord[]>} getRequests  oldest first; [] when none
 * @property {() => Promise<string[]>} listRequestSenders    sender ids with a "req:" record
 * @property {(commit: Commit) => Promise<void>} commit
 */

/**
 * Repository over plain maps. Values are deep-copied on the way in and out so callers cannot
 * alias stored state, matching Durable Object storage's structured-clone semantics (a Uint8Array
 * survives structuredClone as a Uint8Array).
 * @implements {Repository}
 */
export class InMemoryRepository {
  constructor() {
    /** @type {WaveMeta|null} */
    this.meta = null;
    /** @type {Map<string, Blip>} */
    this.blips = new Map();
    /** @type {Map<string, TextRecord>} */
    this.texts = new Map();
    /** @type {Map<string, BaseRecord>} */
    this.bases = new Map();
    /** @type {Map<string, Map<number, UpdateRecord>>} blipId -> seq -> record */
    this.updates = new Map();
    /** @type {Map<number, WaveEvent>} */
    this.events = new Map();
    /** @type {Map<string, Run>} */
    this.runs = new Map();
    /** @type {Map<string, RequestRecord[]>} */
    this.requests = new Map();
    /** Number of commits, for tests. */
    this.commits = 0;
  }

  async getMeta() { return clone(this.meta); }

  async getBlips() { return clone(Object.fromEntries(this.blips)); }

  /** @param {string} id */
  async getText(id) { return clone(this.texts.get(id) ?? null); }

  /** @param {string} id */
  async getBase(id) { return clone(this.bases.get(id) ?? null); }

  /** @param {string} id @param {{fromSeq?: number, toSeq?: number, limit?: number}} [range] */
  async listUpdates(id, { fromSeq = 0, toSeq = Infinity, limit = Infinity } = {}) {
    const byBlip = this.updates.get(id);
    if (!byBlip) return [];
    const seqs = [...byBlip.keys()].filter((s) => s >= fromSeq && s <= toSeq).sort((a, b) => a - b);
    return clone(seqs.slice(0, limit).map((s) => /** @type {UpdateRecord} */ (byBlip.get(s))));
  }

  /** @param {{afterSeq?: number, limit?: number}} [range] */
  async listEvents({ afterSeq = 0, limit = Infinity } = {}) {
    const seqs = [...this.events.keys()].filter((s) => s > afterSeq).sort((a, b) => a - b);
    return clone(seqs.slice(0, limit).map((s) => /** @type {WaveEvent} */ (this.events.get(s))));
  }

  async getRuns() {
    return clone([...this.runs.keys()].sort().map((id) => /** @type {Run} */ (this.runs.get(id))));
  }

  /** @param {string} senderId */
  async getRequests(senderId) { return clone(this.requests.get(senderId) ?? []); }

  async listRequestSenders() { return [...this.requests.keys()].sort(); }

  /** @param {Commit} commit */
  async commit(commit) {
    const c = clone(commit);
    for (const { blipId, seq } of c.deleteUpdates ?? []) this.updates.get(blipId)?.delete(seq);
    for (const seq of c.deleteEvents ?? []) this.events.delete(seq);
    for (const id of c.deleteRuns ?? []) this.runs.delete(id);
    for (const senderId of c.deleteRequests ?? []) this.requests.delete(senderId);
    if (c.meta) this.meta = c.meta;
    for (const blip of c.putBlips ?? []) this.blips.set(blip.id, blip);
    for (const text of c.putText ?? []) this.texts.set(text.id, text);
    for (const base of c.putBase ?? []) this.bases.set(base.id, base);
    for (const rec of c.putUpdates ?? []) {
      let byBlip = this.updates.get(rec.blipId);
      if (!byBlip) this.updates.set(rec.blipId, byBlip = new Map());
      byBlip.set(rec.seq, rec);
    }
    for (const ev of c.putEvents ?? []) this.events.set(ev.seq, ev);
    for (const run of c.putRuns ?? []) this.runs.set(run.id, run);
    for (const { senderId, records } of c.putRequests ?? []) this.requests.set(senderId, records);
    this.commits++;
  }
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return value == null ? value : structuredClone(value);
}
