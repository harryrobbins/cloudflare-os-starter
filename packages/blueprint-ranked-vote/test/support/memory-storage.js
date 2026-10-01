// The slice of Durable Object KV storage the Gadget uses (get, list, transaction with put/delete).
export class MemoryStorage {
  data = new Map();
  async get(keys) { return new Map(keys.filter((k) => this.data.has(k)).map((k) => [k, structuredClone(this.data.get(k))])); }
  async list({ prefix = "" } = {}) {
    return new Map([...this.data.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => [k, structuredClone(this.data.get(k))]));
  }
  async put(entries) { for (const [k, v] of Object.entries(entries)) this.data.set(k, structuredClone(v)); }
  async delete(keys) { for (const k of keys) this.data.delete(k); }
  async transaction(fn) { return fn(this); }
}
