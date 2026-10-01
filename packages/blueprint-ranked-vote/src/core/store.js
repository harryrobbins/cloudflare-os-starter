// @ts-check
// Persistence and fan-out, shared by the Durable Object (src/server/index.js) and the harness.
//
// Storage keys: "meta", "ballots", "o:<optionId>" (one per option), "r:<n>" (one per count).
// A write persists exactly the keys the rules report as changed; a key whose value no longer
// exists in the state is deleted.
//
// Subscribers are RPC targets with update(view). Each gets the view for its own voter, so a
// ballot only ever travels to its owner. A delivery that rejects drops the subscriber and disposes
// its stub (the runtime never calls onRpcBroken).

import { Vote, VoteError, emptyState } from "./vote.js";

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
  const got = await repo.get(["meta", "ballots"]);
  if (got.has("meta")) state.meta = { ...state.meta, ...got.get("meta") };
  if (got.has("ballots")) state.ballots = got.get("ballots");
  const options = await repo.list("o:");
  for (const id of state.meta.order) {
    const o = options.get(`o:${id}`);
    if (o) state.options.set(id, o);
  }
  state.meta.order = state.meta.order.filter((id) => state.options.has(id));
  const results = await repo.list("r:");
  state.results = [...results.values()].toSorted((a, b) => a.n - b.n);
  return state;
}

/** @param {any} stub */
function dispose(stub) {
  try {
    const fn = stub?.[Symbol.dispose];
    if (typeof fn === "function") Promise.resolve(fn.call(stub)).catch(() => {});
  } catch { /* already gone */ }
}

export const MAX_SUBSCRIBERS = 200;

/**
 * The gadget's behaviour minus the platform: load once, run writes one at a time, persist, fan out.
 */
export class VoteService {
  /** @param {Repository} repo @param {{now?: () => number, random?: () => number}} [opts] */
  constructor(repo, opts = {}) {
    this.repo = repo;
    this.opts = opts;
    /** @type {Promise<Vote>|null} */
    this.loading = null;
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
    /** @type {Map<string, {stub: any, voterId: string}>} */
    this.subscribers = new Map();
  }

  vote() {
    this.loading ??= loadState(this.repo).then((s) => new Vote(s, this.opts));
    return this.loading;
  }

  /** @param {string} voterId */
  async view(voterId) { return (await this.vote()).viewFor(typeof voterId === "string" ? voterId : ""); }

  async markdown() { return (await this.vote()).summaryMarkdown(); }

  /** The vote's state and latest count in plain terms; never ballots. */
  async result() { return (await this.vote()).resultSummary(); }

  /**
   * Runs one rule method, persists what it changed, then pushes views. Writes are serialised so a
   * failed persist cannot interleave with the next write. Resolves {revision, ...} or {error}.
   * @param {string} method @param {any} args
   */
  write(method, args) {
    const run = async () => {
      const vote = await this.vote();
      const fn = /** @type {any} */ (vote)[method];
      if (typeof fn !== "function") throw new VoteError(`Unknown operation ${method}`);
      let result;
      try {
        result = fn.call(vote, args ?? {});
      } catch (e) {
        // Rules validate before they change anything, but a refusal still reloads from storage so
        // a half-applied change can never be served or persisted later.
        this.loading = null;
        throw e;
      }
      if (result.keys.length) {
        /** @type {Record<string, any>} */
        const puts = {};
        const deletes = [];
        const s = vote.s;
        for (const key of result.keys) {
          if (key === "meta") puts.meta = s.meta;
          else if (key === "ballots") puts.ballots = s.ballots;
          else if (key.startsWith("o:")) {
            const o = s.options.get(key.slice(2));
            if (o) puts[key] = o; else deletes.push(key);
          } else if (key.startsWith("r:")) {
            const r = s.results.find((x) => `r:${x.n}` === key);
            if (r) puts[key] = r; else deletes.push(key);
          }
        }
        try {
          await this.repo.write(puts, deletes);
        } catch (e) {
          this.loading = null;
          throw e;
        }
        this.broadcast(vote);
      }
      const { keys: _k, ...rest } = result;
      return rest;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    // A refusal is an answer, not a failure: it comes back as {error} so clients can tell it from
    // a broken connection.
    return p.catch((e) => {
      if (e instanceof VoteError) return { error: e.message };
      throw e;
    });
  }

  /** @param {Vote} vote */
  broadcast(vote) {
    for (const [clientId, sub] of this.subscribers) {
      Promise.resolve()
        .then(() => sub.stub.update(vote.viewFor(sub.voterId)))
        .catch(() => {
          if (this.subscribers.get(clientId) === sub) {
            this.subscribers.delete(clientId);
            dispose(sub.stub);
          }
        });
    }
  }

  /**
   * @param {any} stub already dup()ed by the caller
   * @param {{clientId: string, voterId: string}} client
   */
  async subscribe(stub, client) {
    const clientId = typeof client?.clientId === "string" ? client.clientId.slice(0, 64) : "";
    const voterId = typeof client?.voterId === "string" ? client.voterId.slice(0, 200) : "";
    if (!clientId) { dispose(stub); throw new VoteError("Missing clientId"); }
    const old = this.subscribers.get(clientId);
    if (old) { this.subscribers.delete(clientId); if (old.stub !== stub) dispose(old.stub); }
    if (this.subscribers.size >= MAX_SUBSCRIBERS) {
      const [oldestId, oldest] = this.subscribers.entries().next().value;
      this.subscribers.delete(oldestId);
      dispose(oldest.stub);
    }
    this.subscribers.set(clientId, { stub, voterId });
    return this.view(voterId);
  }

  /** @param {string} clientId */
  unsubscribe(clientId) {
    const sub = this.subscribers.get(clientId);
    if (sub) { this.subscribers.delete(clientId); dispose(sub.stub); }
  }

  /** Heartbeat: the view, and whether this client is still subscribed (false after a restart). @param {string} clientId @param {string} voterId */
  async ping(clientId, voterId) {
    return { subscribed: this.subscribers.has(clientId), view: await this.view(voterId) };
  }
}
