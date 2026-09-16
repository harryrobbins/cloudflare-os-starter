// Real-core network harness for client sync tests: real stores (createStore) against the REAL
// board rules and hub (createBoard + Hub over an InMemoryRepository), wired the way
// src/server/index.js wires them. Every call and delivery is structuredClone'd and delayed by a
// random latency on per-client FIFO channels (results and events share the down channel, as they
// share one connection). `restart()` models a facet restart: a new board and hub over the same
// storage; calls in flight and events for the old instance are lost. Requires fake timers.
import { vi } from "vitest";
import { createBoard } from "../../src/core/board.js";
import { Hub } from "../../src/core/hub.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { createStore } from "../../src/client/sync/store.js";

export class RpcTarget {}

/** Small deterministic PRNG. @param {number} seed */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Net {
  /** @param {{rng?: () => number, minLat?: number, maxLat?: number, fifo?: boolean}} [options] */
  constructor({ rng = Math.random, minLat = 0, maxLat = 50, fifo = true } = {}) {
    this.rng = rng;
    this.minLat = minLat;
    this.maxLat = maxLat;
    this.fifo = fifo;
    this.repo = new InMemoryRepository();
    this.epoch = 0;
    /** @type {{name: string, method: string, args: any[]}[]} */
    this.calls = [];
    this.boot();
  }

  boot() {
    this.epoch++;
    const hub = new Hub();
    this.hub = hub;
    this.board = createBoard(this.repo, { onEvent: (e) => { hub.broadcast(e); } });
  }

  /** A facet restart: new board over the same storage, new hub, nothing disposed. */
  restart() { this.boot(); }

  lat() { return this.minLat + Math.floor(this.rng() * (this.maxLat - this.minLat + 1)); }

  /** Schedules fn on a channel; FIFO channels never reorder. */
  send(chan, fn) {
    const now = Date.now();
    let at = now + this.lat();
    if (this.fifo) { at = Math.max(at, chan.last); chan.last = at; }
    setTimeout(fn, at - now);
  }

  /** @param {string} name  label for recorded calls */
  connect(name) {
    const net = this;
    const up = { last: 0 };
    const down = { last: 0 };
    const rpc = (method, args, fn) => new Promise((resolve, reject) => {
      net.calls.push({ name, method, args: structuredClone(args) });
      const epoch = net.epoch;
      const a = structuredClone(args);
      net.send(up, () => {
        if (epoch !== net.epoch) return net.send(down, () => reject(new Error("connection lost")));
        Promise.resolve().then(() => fn(...a)).then(
          (r) => net.send(down, () => (epoch !== net.epoch ? reject(new Error("connection lost"))
            : resolve(r === undefined ? r : structuredClone(r)))),
          (e) => net.send(down, () => reject(e)),
        );
      });
    });
    return {
      getBoard: () => rpc("getBoard", [], () => net.board.getBoard()),
      getComments: (id) => rpc("getComments", [id], (x) => net.board.getComments(x)),
      getHistory: (l) => rpc("getHistory", [l], (x) => net.board.getHistory(x)),
      applyOperation: (req) => rpc("applyOperation", [req], async (r) => (await net.board.applyOperation(r)).result),
      undo: (req) => rpc("undo", [req], async (r) => (await net.board.undo(r)).result),
      addComment: (req) => rpc("addComment", [req], async (r) => (await net.board.addComment(r)).comment),
      subscribe: (callback, info) => {
        const epoch = net.epoch;
        // The stub the server keeps: deliveries go down the same FIFO channel as results.
        const stub = {
          operation: (ev) => { const c = structuredClone(ev); net.send(down, () => { if (epoch === net.epoch) callback.operation(c); }); },
          presence: (ev) => { const c = structuredClone(ev); net.send(down, () => { if (epoch === net.epoch) callback.presence(c); }); },
        };
        return rpc("subscribe", [info], async (i) => {
          const { session } = net.hub.add(stub, i);
          return { ...(await net.board.getBoard()), session };
        });
      },
      updatePresence: (p) => rpc("updatePresence", [p], async (x) => {
        const { known } = net.hub.updatePresence(x);
        return { known, revision: await net.board.getRevision() };
      }),
      leavePresence: (id, session) => rpc("leavePresence", [id, session], (x, s) => { net.hub.leave(x, s); }),
    };
  }

  /**
   * @param {string} name
   * @param {{clientId?: string}} [options]
   */
  async startStore(name, { clientId = "client-" + name } = {}) {
    const p = createStore({
      gadget: this.connect(name), RpcTarget,
      viewer: { clientId, name, color: "#123456" },
    });
    let done = false;
    p.then(() => { done = true; });
    for (let i = 0; i < 500 && !done; i++) await vi.advanceTimersByTimeAsync(10);
    return p;
  }
}
