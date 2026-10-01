// Runs a gadget's real server code in Node: server.js (and the modules it imports, such as
// server.lib.js) from a set of gadget files, with `cloudflare:workers` shimmed and the Durable
// Object's storage kept in memory. Supports the KV storage API only (get/put/delete/list/
// transaction/deleteAll); a gadget that uses `ctx.storage.sql` fails loudly.

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The root has no esbuild of its own; every blueprint package does.
export const requireFromBlueprints = createRequire(new URL("../../packages/blueprint-whiteboard/package.json", import.meta.url));

const WORKERS_SHIM = `
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class RpcTarget {}
export class RpcStub {}
export const restore = Symbol.for("gadget.restore");
`;

/** In-memory Durable Object KV storage with the semantics gadgets rely on. */
export class MemoryStorage {
  /** @type {Map<string, unknown>} */
  #data = new Map();

  // Synchronous KV API used by newer gadget facets, backed by the same data as async storage.
  get kv() {
    return {
      get: (key) => this.#data.has(key) ? structuredClone(this.#data.get(key)) : undefined,
      put: (key, value) => { this.#data.set(key, structuredClone(value)); },
      delete: (key) => this.#data.delete(key),
      list: (options = {}) => {
        const entries = [...this.#data].filter(([key]) => !options.prefix || key.startsWith(options.prefix)).toSorted(([a], [b]) => a.localeCompare(b));
        return new Map(entries.map(([key, value]) => [key, structuredClone(value)]));
      },
    };
  }

  /** @param {string | string[]} key */
  async get(key) {
    if (Array.isArray(key)) {
      const out = new Map();
      for (const k of key) if (this.#data.has(k)) out.set(k, structuredClone(this.#data.get(k)));
      return out;
    }
    return this.#data.has(key) ? structuredClone(this.#data.get(key)) : undefined;
  }

  /** @param {string | Record<string, unknown>} key @param {unknown} [value] */
  async put(key, value) {
    if (typeof key === "object") for (const [k, v] of Object.entries(key)) this.#data.set(k, structuredClone(v));
    else this.#data.set(key, structuredClone(value));
  }

  /** @param {string | string[]} key */
  async delete(key) {
    if (Array.isArray(key)) { let n = 0; for (const k of key) if (this.#data.delete(k)) n++; return n; }
    return this.#data.delete(key);
  }

  async deleteAll() { this.#data.clear(); }

  /** @param {{prefix?: string, start?: string, startAfter?: string, end?: string, limit?: number, reverse?: boolean}} [o] */
  async list(o = {}) {
    let keys = [...this.#data.keys()].toSorted();
    if (o.prefix !== undefined) keys = keys.filter((k) => k.startsWith(/** @type {string} */ (o.prefix)));
    if (o.start !== undefined) keys = keys.filter((k) => k >= /** @type {string} */ (o.start));
    if (o.startAfter !== undefined) keys = keys.filter((k) => k > /** @type {string} */ (o.startAfter));
    if (o.end !== undefined) keys = keys.filter((k) => k < /** @type {string} */ (o.end));
    if (o.reverse) keys.reverse();
    if (o.limit !== undefined) keys = keys.slice(0, o.limit);
    return new Map(keys.map((k) => [k, structuredClone(this.#data.get(k))]));
  }

  /** Runs fn against this storage; a throw rolls every write back. @param {(txn: MemoryStorage) => unknown} fn */
  async transaction(fn) {
    const before = new Map([...this.#data].map(([k, v]) => [k, structuredClone(v)]));
    try {
      return await fn(this);
    } catch (e) {
      this.#data = before;
      throw e;
    }
  }

  /** @param {() => unknown} fn */
  transactionSync(fn) {
    const before = structuredClone(this.#data);
    try { return fn(); } catch (error) { this.#data = before; throw error; }
  }
  async getAlarm() { return null; }
  async setAlarm() {}
  async deleteAlarm() {}
  get sql() { throw new Error("MemoryStorage: ctx.storage.sql is not supported by the eval runner"); }
}

/**
 * Bundles server.js from `files` and constructs its `Gadget` class.
 * @param {Record<string, string>} files  gadget files by name
 * @param {{env?: Record<string, unknown>, storage?: MemoryStorage}} [o]  pass `storage` to keep
 *   state across a rebuild after code edits
 * @returns {Promise<{gadget: any, module: any, storage: MemoryStorage, dispose: () => Promise<void>}>}
 */
export async function loadGadget(files, { env = {}, storage = new MemoryStorage() } = {}) {
  if (!files["server.js"]) throw new Error("gadget has no server.js");
  const esbuild = requireFromBlueprints("esbuild");
  const dir = await mkdtemp(join(tmpdir(), "gadget-eval-"));
  for (const [name, text] of Object.entries(files)) {
    if (!name.endsWith(".js") || name === "client.lib.js") continue; // server modules only (gadget-files.ts)
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  const out = join(dir, "__bundle.mjs");
  await esbuild.build({
    entryPoints: [join(dir, "server.js")], outfile: out, bundle: true, format: "esm", platform: "neutral",
    target: "es2022", logLevel: "silent",
    plugins: [{
      name: "cloudflare-workers-shim",
      setup(b) {
        b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cloudflare:workers", namespace: "shim" }));
        b.onLoad({ filter: /.*/, namespace: "shim" }, () => ({ contents: WORKERS_SHIM, loader: "js" }));
      },
    }],
  });
  const module = await import(pathToFileURL(out).href);
  if (typeof module.Gadget !== "function") throw new Error("server.js does not export a Gadget class");
  const ctx = {
    storage,
    id: { toString: () => "eval-gadget", name: "eval-gadget" },
    waitUntil(promise) { Promise.resolve(promise).catch(() => {}); },
    restore: async (params) => gadget[Symbol.for("gadget.restore")](params),
    blockConcurrencyWhile: (/** @type {() => unknown} */ fn) => fn(),
  };
  const gadget = new module.Gadget(ctx, env);
  return { gadget, module, storage, dispose: () => rm(dir, { recursive: true, force: true }) };
}
