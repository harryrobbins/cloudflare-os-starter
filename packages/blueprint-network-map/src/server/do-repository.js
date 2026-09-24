// @ts-check
// Repository over Durable Object storage (ctx.storage). Key layout: src/core/repository.js.
// commit() runs inside storage.transaction(), so a multi-key write lands entirely or not at all.
// Keys are written and deleted in batches of 128 (the per-call key limit).

import { commitToWrites } from "../core/repository.js";

const BATCH = 128;

/** @template T @param {T[]} items @returns {T[][]} */
function chunks(items) {
  const out = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
}

/** @implements {import("../core/repository.js").Repository} */
export class DoStorageRepository {
  /** @param {any} storage DurableObjectStorage */
  constructor(storage) {
    this.storage = storage;
    /** Known keys per prefix family, for deleting chunked values without listing. */
    /** @type {Set<string>|null} */
    this.chunkKeys = null;
  }

  async getMeta() {
    return (await this.storage.get("meta")) ?? null;
  }

  async getObjects() {
    /** @type {Map<string, any>} */
    const entries = await this.storage.list({ prefix: "o:" });
    const out = [];
    for (const [key, obj] of entries) if (obj && typeof obj === "object" && obj.id === key.slice(2)) out.push(obj);
    return out;
  }

  async getBuckets() {
    /** @type {Map<string, any>} */
    const entries = await this.storage.list({ prefix: "p:" });
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, value] of entries) out[key.slice(2)] = value;
    return out;
  }

  async getHistory() {
    return (await this.storage.get("history")) ?? [];
  }

  async getRequests() {
    return (await this.storage.get("requests")) ?? [];
  }

  /** @param {string} hid @param {number} n */
  async getInverse(hid, n) {
    const keys = Array.from({ length: n }, (_, i) => `inv:${hid}:${i}`);
    const out = [];
    for (const batch of chunks(keys)) {
      /** @type {Map<string, any>} */
      const got = await this.storage.get(batch);
      for (const k of batch) out.push(got.get(k) ?? []);
    }
    return out;
  }

  async getChangesets() {
    /** @type {Map<string, any>} */
    const entries = await this.storage.list({ prefix: "cs:" });
    return [...entries.values()];
  }

  /** @param {string} id @param {number} n */
  async getChangesetChunk(id, n) {
    return (await this.storage.get(`ci:${id}:${n}`)) ?? null;
  }

  /** @returns {Promise<Set<string>>} */
  async #chunkKeys() {
    if (!this.chunkKeys) {
      const [inv, ci] = await Promise.all([this.storage.list({ prefix: "inv:" }), this.storage.list({ prefix: "ci:" })]);
      this.chunkKeys = new Set([...inv.keys(), ...ci.keys()]);
    }
    return this.chunkKeys;
  }

  /** @param {import("../core/repository.js").Commit} commit */
  async commit(commit) {
    const known = await this.#chunkKeys();
    const { puts, deletes } = commitToWrites(commit, (prefix) => [...known].filter((k) => k.startsWith(prefix)));
    await this.storage.transaction(async (/** @type {any} */ txn) => {
      for (const batch of chunks(deletes)) await txn.delete(batch);
      for (const batch of chunks(Object.entries(puts))) await txn.put(Object.fromEntries(batch));
    });
    for (const k of deletes) known.delete(k);
    for (const k of Object.keys(puts)) if (k.startsWith("inv:") || k.startsWith("ci:")) known.add(k);
  }
}
