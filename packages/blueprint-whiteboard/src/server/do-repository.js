// @ts-check
// Repository over Durable Object storage (ctx.storage). Layout, as documented in README.md:
//
//   "meta"        BoardMeta
//   "obj:<id>"    WhiteboardObject, one key per object
//   "history"     HistoryEntry[]
//   "requests"    RequestRecord[] (recent requestIds, newest last)
//   "render:<id>"      a diagram's cached render: {hash, status, error?, w?, h?, chunks}
//   "render:<id>:<n>"  its SVG, in chunks of RENDER_CHUNK characters
//
// commit() runs inside storage.transaction(), so a multi-key write lands entirely or not at all.
// The whiteboard bounds what one commit may touch (LIMITS.commitObjects object keys), and keys
// are written and deleted in batches of 128 (the per-call key limit).

/** @typedef {import("../core/repository.js").Commit} Commit */
/** @typedef {import("../shared/protocol.js").WhiteboardObject} WhiteboardObject */

/** storage.put/delete accept at most this many keys per call. */
const BATCH = 128;
/** Characters per stored render chunk: at most 120 KB even as two-byte V8 strings. */
export const RENDER_CHUNK = 60_000;

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
  /**
   * @param {any} storage DurableObjectStorage
   * @param {{prefix?: string}} [options]
   */
  constructor(storage, { prefix = "" } = {}) {
    this.storage = storage;
    this.prefix = prefix;
  }

  async getMeta() {
    return (await this.storage.get(this.prefix + "meta")) ?? null;
  }

  async getObjects() {
    const objectPrefix = this.prefix + OBJECT_PREFIX;
    /** @type {Map<string, WhiteboardObject>} */
    const entries = await this.storage.list({ prefix: objectPrefix });
    /** @type {Record<string, WhiteboardObject>} */
    const objects = {};
    for (const [key, obj] of entries) {
      const id = key.slice(objectPrefix.length);
      if (obj && typeof obj === "object" && obj.id === id) objects[id] = obj;
    }
    return objects;
  }

  async getHistory() {
    return (await this.storage.get(this.prefix + "history")) ?? [];
  }

  async getRequests() {
    return (await this.storage.get(this.prefix + "requests")) ?? [];
  }

  /**
   * A diagram's cached render, or null.
   * @param {string} id @returns {Promise<import("../shared/diagram.js").DiagramRender|null>}
   */
  async getRender(id) {
    const key = this.prefix + "render:" + id;
    const head = await this.storage.get(key);
    if (!head || typeof head !== "object") return null;
    const { chunks: n = 0, ...rest } = head;
    if (!n) return rest;
    const keys = Array.from({ length: n }, (_, i) => `${key}:${i}`);
    /** @type {Map<string, string>} */
    const parts = await this.storage.get(keys);
    const svg = keys.map((k) => parts.get(k) ?? "").join("");
    return svg.length === head.length ? { ...rest, svg } : null;
  }

  /**
   * Stores (or with null, removes) a diagram's cached render.
   * @param {string} id @param {import("../shared/diagram.js").DiagramRender|null} render
   */
  async putRender(id, render) {
    const key = this.prefix + "render:" + id;
    const old = await this.storage.get(key);
    const oldKeys = Array.from({ length: old?.chunks ?? 0 }, (_, i) => `${key}:${i}`);
    if (!render) {
      await this.storage.transaction(async (/** @type {any} */ txn) => {
        for (const batch of chunks([key, ...oldKeys])) await txn.delete(batch);
      });
      return;
    }
    const { svg = "", ...rest } = render;
    /** @type {Record<string, unknown>} */
    const puts = {};
    const n = Math.ceil(svg.length / RENDER_CHUNK);
    for (let i = 0; i < n; i++) puts[`${key}:${i}`] = svg.slice(i * RENDER_CHUNK, (i + 1) * RENDER_CHUNK);
    puts[key] = { ...rest, chunks: n, length: svg.length };
    const stale = oldKeys.filter((k) => !Object.hasOwn(puts, k));
    // One transaction, so overlapping writes never leave chunks the head does not count.
    await this.storage.transaction(async (/** @type {any} */ txn) => {
      for (const batch of chunks(stale)) await txn.delete(batch);
      for (const batch of chunks(Object.entries(puts))) await txn.put(Object.fromEntries(batch));
    });
  }

  /** @param {Commit} commit */
  async commit(commit) {
    await this.storage.transaction(async (/** @type {any} */ txn) => {
      /** @type {Record<string, unknown>} */
      const puts = {};
      const p = this.prefix;
      if (commit.meta) puts[p + "meta"] = commit.meta;
      if (commit.history) puts[p + "history"] = commit.history;
      if (commit.requests) puts[p + "requests"] = commit.requests;
      for (const obj of commit.putObjects ?? []) puts[p + objectKey(obj.id)] = obj;
      const deletes = (commit.deleteObjects ?? []).map((id) => p + objectKey(id)).filter((k) => !Object.hasOwn(puts, k));
      for (const batch of chunks(deletes)) await txn.delete(batch);
      for (const batch of chunks(Object.entries(puts))) await txn.put(Object.fromEntries(batch));
    });
  }
}
