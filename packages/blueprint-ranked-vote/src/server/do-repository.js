// @ts-check
// Durable Object storage behind the Repository seam of src/core/store.js; a write is one transaction.

const BATCH = 128;

export class DoRepository {
  /** @param {any} storage */
  constructor(storage) { this.storage = storage; }
  /** @param {string[]} keys */
  get(keys) { return this.storage.get(keys); }
  /** @param {string} prefix */
  list(prefix) { return this.storage.list({ prefix }); }
  /** @param {Record<string, any>} puts @param {string[]} deletes */
  async write(puts, deletes) {
    const entries = Object.entries(puts);
    await this.storage.transaction(async (/** @type {any} */ txn) => {
      for (let i = 0; i < deletes.length; i += BATCH) await txn.delete(deletes.slice(i, i + BATCH));
      for (let i = 0; i < entries.length; i += BATCH) await txn.put(Object.fromEntries(entries.slice(i, i + BATCH)));
    });
  }
}
