// @ts-check
// Persistence and fan-out, shared by the Durable Object (src/server/index.js), the harness and the
// tests. Writes run one at a time; each persists exactly the keys the rules report, and a key
// whose value has gone from the state is deleted. Subscribers are RPC targets with update(view);
// a delivery that rejects drops the subscriber and disposes its stub (the runtime never calls
// onRpcBroken).

import { Arcade, ArcadeError, emptyState } from "./arcade.js";

/**
 * @typedef {object} Repository
 * @property {(keys: string[]) => Promise<Map<string, any>>} get
 * @property {(prefix: string) => Promise<Map<string, any>>} list
 * @property {(puts: Record<string, any>, deletes: string[]) => Promise<void>} write
 */

export class InMemoryRepository {
  constructor() { /** @type {Map<string, any>} */ this.data = new Map(); }
  /** @param {string[]} keys */
  async get(keys) { return new Map(keys.filter((k) => this.data.has(k)).map((k) => [k, structuredClone(this.data.get(k))])); }
  /** @param {string} prefix */
  async list(prefix) { return new Map([...this.data].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); }
  /** @param {Record<string, any>} puts @param {string[]} deletes */
  async write(puts, deletes) {
    for (const k of deletes) this.data.delete(k);
    for (const [k, v] of Object.entries(puts)) this.data.set(k, structuredClone(v));
  }
}

/** @param {Repository} repo */
export async function loadState(repo) {
  const state = emptyState();
  const got = await repo.get(["meta"]);
  if (got.has("meta")) state.meta = { ...state.meta, ...got.get("meta") };
  for (const [k, v] of await repo.list("g:")) state.games.set(k.slice(2), v);
  for (const [k, v] of await repo.list("t:")) state.tunes.set(k.slice(2), v);
  for (const [k, v] of await repo.list("s:")) state.scores.set(k.slice(2), v);
  for (const [k, v] of await repo.list("p:")) state.prefs.set(k.slice(2), v);
  state.meta.gameOrder = state.meta.gameOrder.filter((id) => state.games.has(id));
  state.meta.tuneOrder = state.meta.tuneOrder.filter((id) => state.tunes.has(id));
  return state;
}

/** @param {ReturnType<typeof emptyState>} s @param {string} key */
function valueFor(s, key) {
  if (key === "meta") return s.meta;
  const id = key.slice(2);
  if (key.startsWith("g:")) return s.games.get(id);
  if (key.startsWith("t:")) return s.tunes.get(id);
  if (key.startsWith("s:")) return s.scores.get(id);
  if (key.startsWith("p:")) return s.prefs.get(id);
  return undefined;
}

/** @param {any} stub */
function dispose(stub) {
  try {
    const fn = stub?.[Symbol.dispose];
    if (typeof fn === "function") Promise.resolve(fn.call(stub)).catch(() => {});
  } catch { /* already gone */ }
}

export const MAX_SUBSCRIBERS = 200;

export class ArcadeService {
  /**
   * @param {Repository} repo
   * @param {{now?: () => number, random?: () => number, templates?: any[], starterTunes?: any[]}} [opts]
   */
  constructor(repo, opts = {}) {
    this.repo = repo;
    this.opts = opts;
    /** @type {Promise<Arcade>|null} */
    this.loading = null;
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
    /** @type {Map<string, {stub: any, viewerId: string}>} */
    this.subscribers = new Map();
  }

  /** Loads once; a brand-new arcade is stocked with the starter games and tunes and saved. */
  arcade() {
    this.loading ??= (async () => {
      const arcade = new Arcade(await loadState(this.repo), this.opts);
      const keys = arcade.seed();
      if (keys.length) await this.persist(arcade, keys);
      return arcade;
    })().catch((e) => { this.loading = null; throw e; });
    return this.loading;
  }

  /** @param {Arcade} arcade @param {string[]} keys */
  async persist(arcade, keys) {
    /** @type {Record<string, any>} */
    const puts = {};
    const deletes = [];
    for (const key of keys) {
      const v = valueFor(arcade.s, key);
      if (v === undefined) deletes.push(key); else puts[key] = v;
    }
    await this.repo.write(puts, deletes);
  }

  /** @param {string} viewerId */
  async view(viewerId) { return (await this.arcade()).viewFor(typeof viewerId === "string" ? viewerId : ""); }

  /** A read that may refuse (unknown id): resolves {error} like a write. @param {(a: Arcade) => any} fn */
  async read(fn) {
    try {
      return fn(await this.arcade());
    } catch (e) {
      if (e instanceof ArcadeError) return { error: e.message };
      throw e;
    }
  }

  /**
   * Runs one rule method, persists what it changed, then pushes views. Resolves {revision, ...}
   * or {error} when the rules refuse.
   * @param {string} method @param {any} args
   */
  write(method, args) {
    const run = async () => {
      const arcade = await this.arcade();
      const fn = /** @type {any} */ (arcade)[method];
      if (typeof fn !== "function") throw new ArcadeError(`Unknown operation ${method}`);
      let result;
      try {
        result = fn.call(arcade, args ?? {});
      } catch (e) {
        // Rules validate before changing anything, but reload anyway so a half-applied change is
        // never served or persisted later.
        this.loading = null;
        throw e;
      }
      if (result.keys.length) {
        try {
          await this.persist(arcade, result.keys);
        } catch (e) {
          this.loading = null;
          throw e;
        }
        this.broadcast(arcade);
      }
      const { keys: _k, ...rest } = result;
      return rest;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p.catch((e) => {
      if (e instanceof ArcadeError) return { error: e.message };
      throw e;
    });
  }

  /** @param {Arcade} arcade */
  broadcast(arcade) {
    for (const [clientId, sub] of this.subscribers) {
      Promise.resolve()
        .then(() => sub.stub.update(arcade.viewFor(sub.viewerId)))
        .catch(() => {
          if (this.subscribers.get(clientId) === sub) {
            this.subscribers.delete(clientId);
            dispose(sub.stub);
          }
        });
    }
  }

  /** @param {any} stub already dup()ed by the caller @param {{clientId: string, viewerId: string}} client */
  async subscribe(stub, client) {
    const clientId = typeof client?.clientId === "string" ? client.clientId.slice(0, 64) : "";
    const viewerId = typeof client?.viewerId === "string" ? client.viewerId.slice(0, 200) : "";
    if (!clientId) { dispose(stub); throw new ArcadeError("Missing clientId"); }
    const old = this.subscribers.get(clientId);
    if (old) { this.subscribers.delete(clientId); if (old.stub !== stub) dispose(old.stub); }
    if (this.subscribers.size >= MAX_SUBSCRIBERS) {
      const [oldestId, oldest] = this.subscribers.entries().next().value;
      this.subscribers.delete(oldestId);
      dispose(oldest.stub);
    }
    this.subscribers.set(clientId, { stub, viewerId });
    return this.view(viewerId);
  }

  /** @param {string} clientId */
  unsubscribe(clientId) {
    const sub = this.subscribers.get(clientId);
    if (sub) { this.subscribers.delete(clientId); dispose(sub.stub); }
  }

  /** Heartbeat: whether this client is still subscribed (false after a restart) and the revision. @param {string} clientId @param {string} viewerId */
  async ping(clientId, viewerId) {
    const view = await this.view(viewerId);
    return { subscribed: this.subscribers.has(clientId), revision: view.revision, view: this.subscribers.has(clientId) ? null : view };
  }
}
