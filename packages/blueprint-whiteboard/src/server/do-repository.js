// @ts-check
// Repository over Durable Object storage (ctx.storage). Layout, as documented in README.md:
//
//   "meta"        BoardMeta
//   "obj:<id>"    WhiteboardObject, one key per object
//   "history"     HistoryEntry[]
//   "requests"    RequestRecord[] (recent requestIds, newest last)
//
// commit() runs inside storage.transaction(), so a multi-key write lands entirely or not at all.
// The whiteboard bounds what one commit may touch (LIMITS.commitObjects object keys), and keys
// are written and deleted in batches of 128 (the per-call key limit).

/** @typedef {import("../core/repository.js").Commit} Commit */
/** @typedef {import("../shared/protocol.js").WhiteboardObject} WhiteboardObject */

/** storage.put/delete accept at most this many keys per call. */
const BATCH = 128;

export const OBJECT_PREFIX = "obj:";

/** @param {string} id */
export const objectKey = (id) => OBJECT_PREFIX + id;

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

/** @typedef {import("../core/repository.js").Repository} Repository */

/** @implements {Repository} */
export class DoStorageRepository {
  /** @param {any} storage DurableObjectStorage */
  constructor(storage) {
    this.storage = storage;
  }

  async getMeta() {
    return (await this.storage.get("meta")) ?? null;
  }

  async getObjects() {
    /** @type {Map<string, WhiteboardObject>} */
    const entries = await this.storage.list({ prefix: OBJECT_PREFIX });
    /** @type {Record<string, WhiteboardObject>} */
    const objects = {};
    for (const [key, obj] of entries) {
      const id = key.slice(OBJECT_PREFIX.length);
      if (obj && typeof obj === "object" && obj.id === id) objects[id] = obj;
    }
    return objects;
  }

  async getHistory() {
    return (await this.storage.get("history")) ?? [];
  }

  async getRequests() {
    return (await this.storage.get("requests")) ?? [];
  }

  /** @param {Commit} commit */
  async commit(commit) {
    await this.storage.transaction(async (/** @type {any} */ txn) => {
      /** @type {Record<string, unknown>} */
      const puts = {};
      if (commit.meta) puts.meta = commit.meta;
      if (commit.history) puts.history = commit.history;
      if (commit.requests) puts.requests = commit.requests;
      for (const obj of commit.putObjects ?? []) puts[objectKey(obj.id)] = obj;
      const deletes = (commit.deleteObjects ?? []).map(objectKey).filter((k) => !Object.hasOwn(puts, k));
      for (const batch of chunks(deletes)) await txn.delete(batch);
      for (const batch of chunks(Object.entries(puts))) await txn.put(Object.fromEntries(batch));
    });
  }
}
