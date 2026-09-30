// The subset of Durable Object storage the Docs server and the whiteboard repository use, in
// memory. Values are structured-cloned in and out, as real storage does.
export class MemoryStorage {
  constructor() {
    /** @type {Map<string, unknown>} */
    this.map = new Map();
  }

  async get(key) {
    if (Array.isArray(key)) {
      const out = new Map();
      for (const k of key) if (this.map.has(k)) out.set(k, structuredClone(this.map.get(k)));
      return out;
    }
    return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined;
  }

  async put(key, value) {
    if (typeof key === "object" && key !== null) {
      for (const [k, v] of Object.entries(key)) this.map.set(k, structuredClone(v));
    } else {
      this.map.set(key, structuredClone(value));
    }
  }

  async delete(key) {
    if (Array.isArray(key)) {
      let n = 0;
      for (const k of key) if (this.map.delete(k)) n++;
      return n;
    }
    return this.map.delete(key);
  }

  async list({ prefix = "" } = {}) {
    const out = new Map();
    for (const k of [...this.map.keys()].sort()) {
      if (k.startsWith(prefix)) out.set(k, structuredClone(this.map.get(k)));
    }
    return out;
  }

  async transaction(fn) {
    return fn(this);
  }
}
