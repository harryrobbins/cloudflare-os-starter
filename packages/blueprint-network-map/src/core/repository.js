// @ts-check
// The storage seam. The map's rules (src/core/network-map.js) talk only to a Repository, so the
// same rules run over Durable Object storage (src/server/do-repository.js), in memory for tests
// and the harness, and later over another backend (Phase 5: a datastore shard).
//
// Key layout (both implementations):
//   meta                 MapMeta
//   o:<id>               one stored object (element, connection, loop, view, type, field)
//   p:<layout>:<bucket>  a position bucket: {ids, x, y, pin, v} for the elements hashed to it
//   history              HistoryEntry[] (metadata only)
//   inv:<hid>:<n>        inverse chunks of a history entry
//   requests             RequestRecord[]
//   cs:<id>              changeset manifest
//   ci:<id>:<n>          changeset item chunk

/**
 * One atomic write. Every present field is applied together or not at all.
 * @typedef {object} Commit
 * @property {any} [meta]
 * @property {any[]} [putObjects]
 * @property {string[]} [deleteObjects]              object ids
 * @property {Record<string, any|null>} [buckets]    bucket key ("<layout>:<n>") -> value, null deletes
 * @property {any[]} [history]                       replaces the whole list
 * @property {any[]} [requests]                      replaces the whole list
 * @property {Record<string, any[]>} [putInverse]    history id -> chunks
 * @property {string[]} [deleteInverse]              history ids whose chunks go
 * @property {Record<string, any|null>} [changesets] changeset id -> manifest, null deletes it and its chunks
 * @property {Record<string, any[]|null>} [changesetChunks] "<id>:<n>" -> items, null deletes
 */

/**
 * @typedef {object} Repository
 * @property {() => Promise<any|null>} getMeta
 * @property {() => Promise<any[]>} getObjects
 * @property {() => Promise<Record<string, any>>} getBuckets       "<layout>:<n>" -> bucket
 * @property {() => Promise<any[]>} getHistory
 * @property {() => Promise<any[]>} getRequests
 * @property {(hid: string, chunks: number) => Promise<any[][]>} getInverse
 * @property {() => Promise<any[]>} getChangesets
 * @property {(id: string, n: number) => Promise<any[]|null>} getChangesetChunk
 * @property {(commit: Commit) => Promise<void>} commit
 */

/**
 * Repository over plain maps. Values are deep-copied on the way in and out, matching Durable
 * Object storage's structured-clone semantics.
 * @implements {Repository}
 */
export class InMemoryRepository {
  constructor() {
    /** @type {Map<string, any>} */
    this.kv = new Map();
    /** Number of commits, for tests. */
    this.commits = 0;
    /** When set, the next commit throws this (tests). */
    /** @type {Error|null} */
    this.failNext = null;
  }

  async getMeta() { return clone(this.kv.get("meta") ?? null); }

  async getObjects() {
    const out = [];
    for (const [k, v] of this.kv) if (k.startsWith("o:")) out.push(v);
    return clone(out);
  }

  async getBuckets() {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of this.kv) if (k.startsWith("p:")) out[k.slice(2)] = v;
    return clone(out);
  }

  async getHistory() { return clone(this.kv.get("history") ?? []); }
  async getRequests() { return clone(this.kv.get("requests") ?? []); }

  /** @param {string} hid @param {number} chunks */
  async getInverse(hid, chunks) {
    const out = [];
    for (let n = 0; n < chunks; n++) out.push(clone(this.kv.get(`inv:${hid}:${n}`) ?? []));
    return out;
  }

  async getChangesets() {
    const out = [];
    for (const [k, v] of this.kv) if (k.startsWith("cs:")) out.push(v);
    return clone(out);
  }

  /** @param {string} id @param {number} n */
  async getChangesetChunk(id, n) { return clone(this.kv.get(`ci:${id}:${n}`) ?? null); }

  /** @param {import("./repository.js").Commit} commit */
  async commit(commit) {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const puts = commitToWrites(clone(commit), (prefix) => [...this.kv.keys()].filter((k) => k.startsWith(prefix)));
    for (const k of puts.deletes) this.kv.delete(k);
    for (const [k, v] of Object.entries(puts.puts)) this.kv.set(k, v);
    this.commits++;
  }

  /** Total storedBytes-free size of all values as JSON, for tests and spikes. */
  jsonBytes() {
    let n = 0;
    for (const [k, v] of this.kv) n += k.length + JSON.stringify(v).length;
    return n;
  }
}

/**
 * Turns a Commit into key writes. `keysWithPrefix` lists existing keys (for deleting a
 * changeset's or inverse's chunks without knowing how many there are).
 * @param {import("./repository.js").Commit} commit
 * @param {(prefix: string) => string[]} keysWithPrefix
 * @returns {{puts: Record<string, any>, deletes: string[]}}
 */
export function commitToWrites(commit, keysWithPrefix) {
  /** @type {Record<string, any>} */
  const puts = {};
  /** @type {Set<string>} */
  const deletes = new Set();
  if (commit.meta) puts.meta = commit.meta;
  if (commit.history) puts.history = commit.history;
  if (commit.requests) puts.requests = commit.requests;
  for (const id of commit.deleteObjects ?? []) deletes.add("o:" + id);
  for (const o of commit.putObjects ?? []) { puts["o:" + o.id] = o; deletes.delete("o:" + o.id); }
  for (const [k, v] of Object.entries(commit.buckets ?? {})) {
    if (v === null) deletes.add("p:" + k);
    else puts["p:" + k] = v;
  }
  for (const hid of commit.deleteInverse ?? []) for (const k of keysWithPrefix(`inv:${hid}:`)) deletes.add(k);
  for (const [hid, chunks] of Object.entries(commit.putInverse ?? {})) {
    chunks.forEach((chunk, n) => { puts[`inv:${hid}:${n}`] = chunk; deletes.delete(`inv:${hid}:${n}`); });
  }
  for (const [id, manifest] of Object.entries(commit.changesets ?? {})) {
    if (manifest === null) {
      deletes.add("cs:" + id);
      for (const k of keysWithPrefix(`ci:${id}:`)) deletes.add(k);
    } else puts["cs:" + id] = manifest;
  }
  for (const [k, items] of Object.entries(commit.changesetChunks ?? {})) {
    if (items === null) deletes.add("ci:" + k);
    else { puts["ci:" + k] = items; deletes.delete("ci:" + k); }
  }
  return { puts, deletes: [...deletes].filter((k) => !Object.hasOwn(puts, k)) };
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  return value == null ? value : structuredClone(value);
}
