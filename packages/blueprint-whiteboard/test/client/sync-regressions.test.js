// Regression tests for sync-correctness review findings, against the REAL core and hub over the
// simulated network (test/client/net.js), plus the pure server model.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyUpdate, createServerModel } from "../../src/client/model/server-model.js";
import { createStore } from "../../src/client/sync/store.js";
import { Net, RpcTarget } from "./net.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const tick = (/** @type {number} */ ms) => vi.advanceTimersByTimeAsync(ms);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A net.js gadget with per-method hooks: `resultDelay[m]` holds the result that long before it
 * reaches the client, `callDelay[m]` holds the call before it is made, `hang[m]` never settles.
 * @param {any} inner
 */
function wrap(inner) {
  /** @type {{resultDelay: Record<string, number>, callDelay: Record<string, number>, hang: Record<string, boolean>, calls: string[]}} */
  const ctl = { resultDelay: {}, callDelay: {}, hang: {}, calls: [] };
  /** @type {any} */
  const g = {};
  for (const m of Object.keys(inner)) {
    g[m] = async (/** @type {any[]} */ ...args) => {
      ctl.calls.push(m);
      if (ctl.hang[m]) return new Promise(() => {});
      if (ctl.callDelay[m]) await sleep(ctl.callDelay[m]);
      const r = await inner[m](...args);
      if (ctl.resultDelay[m]) await sleep(ctl.resultDelay[m]);
      return r;
    };
  }
  return { g, ctl };
}

/**
 * @param {Net} net
 * @param {string} name
 * @param {object} [extra]  more createStore options
 */
async function start(net, name, extra = {}) {
  const { g, ctl } = wrap(net.connect(name));
  const p = createStore({ gadget: g, RpcTarget, viewer: { clientId: "client-" + name, name, color: "#123456" }, ...extra });
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 2000 && !done; i++) await tick(10);
  const store = await p;
  return { store, ctl, g };
}

describe("finding 1: a conflict result overtaken by a newer event", () => {
  it("rebases against the newer state, keeping every concurrent nudge", async () => {
    const net = new Net({ rng: () => 0, minLat: 0, maxLat: 0, fifo: false });
    const { store: a, ctl: actl } = await start(net, "a");
    const { store: b } = await start(net, "b");
    const { store: c } = await start(net, "c");
    const [id] = a.createObjects([{ type: "sticky", x: 0, y: 0 }]);
    await tick(200);
    actl.resultDelay.applyOperation = 200; // A's results are slow; events to A are not
    b.updateObjects([{ id, patch: { x: 20 } }]); // +20, reaches the server first
    a.updateObjects([{ id, patch: { x: 5 } }]); // +5 against the old version: conflict
    await tick(20);
    c.updateObjects([{ id, patch: { x: 100 } }]); // has seen B's: +80
    await tick(1000);
    actl.resultDelay.applyOperation = 0;
    await tick(2000);
    const server = await net.board.getBoard();
    expect(server.objects[id].x).toBe(105);
    for (const s of [a, b, c]) expect(s.getState().board.objects[id]).toEqual(server.objects[id]);
  });
});

describe("finding 2: a re-created id with a lower version", () => {
  const obj = (/** @type {number} */ version, /** @type {number} */ createdAt) =>
    ({ id: "o_000000000001", type: "sticky", x: 0, y: 0, version, createdAt });

  it("lands when the re-create's event arrives before the delete's", () => {
    const model = createServerModel(/** @type {any} */ ({ revision: 10, objects: { o_000000000001: obj(4, 100) } }));
    applyUpdate(model, /** @type {any} */ ({ upserts: [obj(1, 200)] }), 12);
    applyUpdate(model, { deletes: ["o_000000000001"] }, 11);
    expect(model.board.objects.o_000000000001).toEqual(obj(1, 200));
  });

  it("still refuses a lower version of the same incarnation", () => {
    const model = createServerModel(/** @type {any} */ ({ revision: 10, objects: {} }));
    applyUpdate(model, /** @type {any} */ ({ upserts: [obj(4, 100)] }), 12);
    expect(applyUpdate(model, /** @type {any} */ ({ upserts: [obj(3, 100)] }), 13).objects).toEqual([]);
    expect(model.board.objects.o_000000000001.version).toBe(4);
  });
});

describe("finding 3: a frame deleted concurrently", () => {
  async function setup() {
    const net = new Net({ rng: () => 0.5, minLat: 0, maxLat: 50 });
    const a = await start(net, "a");
    const b = await start(net, "b");
    await tick(200);
    return { net, a: a.store, b: b.store, bg: b.g };
  }

  it("a drag into it keeps its new position (only frameId is lost)", async () => {
    const { net, a, b } = await setup();
    const [frame] = a.createObjects([{ type: "frame", x: 0, y: 0, w: 1000, h: 1000, text: "F" }]);
    const [x] = a.createObjects([{ type: "sticky", x: 2000, y: 2000 }]);
    await tick(500);
    a.deleteObjects([frame]);
    b.updateObjects([{ id: x, patch: { x: 100, y: 100, frameId: frame } }]);
    await tick(2000);
    const server = await net.board.getBoard();
    expect(server.objects[x]).toMatchObject({ x: 100, frameId: null });
    expect(b.getState().board.objects[x]).toEqual(server.objects[x]);
  });

  it("a sticky created inside it is not lost", async () => {
    const { net, a, b } = await setup();
    const [frame] = a.createObjects([{ type: "frame", x: 0, y: 0, w: 1000, h: 1000, text: "F" }]);
    await tick(500);
    a.deleteObjects([frame]);
    const [s] = b.createObjects([{ type: "sticky", x: 100, y: 100, text: "important", frameId: frame }]);
    await tick(2000);
    const server = await net.board.getBoard();
    expect(server.objects[s]).toMatchObject({ text: "important", frameId: null });
    expect(b.getState().board.objects[s]).toEqual(server.objects[s]);
  });

  it("client fallback: invalid_ref for an op naming a frame is retried once without it", async () => {
    const { net, a, b, bg } = await setup();
    const [frame] = a.createObjects([{ type: "frame", x: 0, y: 0, w: 1000, h: 1000, text: "F" }]);
    const [x] = a.createObjects([{ type: "sticky", x: 2000, y: 2000 }]);
    await tick(500);
    // A server that still refuses a missing frame with invalid_ref.
    const apply = bg.applyOperation;
    /** @type {any[]} */
    const sent = [];
    bg.applyOperation = async (/** @type {any} */ req) => {
      sent.push(structuredClone(req));
      // Ops naming a frame are refused; the rest are applied, with error indexes mapped back.
      const ops = req.objectOps ?? [];
      /** @type {number[]} */
      const kept = [];
      /** @type {any[]} */
      const errors = [];
      ops.forEach((/** @type {any} */ op, /** @type {number} */ index) => {
        if (op.object?.frameId || op.patch?.frameId) errors.push({ index, code: "invalid_ref", message: "frame gone" });
        else kept.push(index);
      });
      if (!errors.length) return apply(req);
      const result = kept.length
        ? await apply({ ...req, objectOps: kept.map((i) => ops[i]) })
        : { status: "unchanged", revision: (await net.board.getBoard()).revision, upserts: [], deletes: [], structure: null, history: null, conflicts: [], errors: [] };
      return { ...result, errors: [...errors, ...result.errors.map((/** @type {any} */ e) => ({ ...e, index: kept[e.index] ?? e.index }))] };
    };
    b.updateObjects([{ id: x, patch: { x: 100, frameId: frame } }]);
    const [s] = b.createObjects([{ type: "sticky", x: 5, y: 5, frameId: frame }]);
    await tick(2000);
    const server = await net.board.getBoard();
    expect(server.objects[x]).toMatchObject({ x: 100, frameId: null });
    expect(server.objects[s]).toMatchObject({ frameId: null });
    expect(b.getState().pending).toBe(0);
    expect(b.getState().lastError).toBeNull();
    // Only one retry per op: an op refused again is dropped rather than looping.
    bg.applyOperation = async (/** @type {any} */ req) => {
      sent.push(structuredClone(req));
      const board = await net.board.getBoard();
      return { status: "unchanged", revision: board.revision, upserts: [], deletes: [], structure: null, history: null, conflicts: [],
        errors: (req.objectOps ?? []).map((/** @type {any} */ _op, /** @type {number} */ index) => ({ index, code: "invalid_ref", message: "not a frame" })) };
    };
    const before = sent.length;
    b.updateObjects([{ id: x, patch: { y: 7, frameId: frame } }]);
    await tick(2000);
    expect(sent.slice(before).map((r) => r.objectOps[0].patch.frameId)).toEqual([frame, null]);
    expect(b.getState().pending).toBe(0);
    expect(b.getState().board.objects[x]).toEqual(server.objects[x]); // rolled back
  });
});

describe("finding 4: local undo of a delete that cascaded to an unseen connector", () => {
  it("brings the connector back too", async () => {
    const net = new Net({ rng: () => 0.5, minLat: 0, maxLat: 50 });
    const { store: a } = await start(net, "a");
    const { store: b } = await start(net, "b");
    await tick(200);
    const [x, y] = a.createObjects([{ type: "sticky", x: 0, y: 0 }, { type: "sticky", x: 500, y: 0 }]);
    await tick(500);
    const [conn] = b.createObjects([{ type: "connector", from: x, to: y }]);
    a.deleteObjects([x]); // A has not seen B's connector yet
    await tick(2000);
    let server = await net.board.getBoard();
    expect(server.objects[conn]).toBeUndefined();
    a.undo();
    await tick(2000);
    server = await net.board.getBoard();
    expect(server.objects[x]).toBeDefined();
    expect(server.objects[conn]).toMatchObject({ from: x, to: y });
    for (const s of [a, b]) expect(s.getState().board.objects).toEqual(server.objects);
  });
});

describe("finding 5: a slow but alive server", () => {
  it("a first subscribe taking 9 s does not trigger onUnrecoverable", async () => {
    const net = new Net({ rng: () => 0, minLat: 0, maxLat: 0 });
    const { g, ctl } = wrap(net.connect("a"));
    ctl.resultDelay.subscribe = 9000;
    const onUnrecoverable = vi.fn();
    const p = createStore({ gadget: g, RpcTarget, viewer: { clientId: "client-a", name: "a", color: "#123456" }, onUnrecoverable });
    await tick(12000);
    await p;
    expect(onUnrecoverable).not.toHaveBeenCalled();
    expect(ctl.calls.filter((c) => c === "subscribe")).toHaveLength(1);
  });

  it("a live store whose calls take 9-11 s is not declared unrecoverable, and a pending change survives", async () => {
    const net = new Net({ rng: () => 0, minLat: 0, maxLat: 0 });
    const onUnrecoverable = vi.fn();
    const { store: a, ctl } = await start(net, "a", { onUnrecoverable });
    await tick(100);
    ctl.callDelay.updatePresence = 11000;
    ctl.callDelay.subscribe = 9000;
    ctl.callDelay.applyOperation = 9000;
    const [id] = a.createObjects([{ type: "sticky", text: "typed during the slow period" }]);
    await tick(40000);
    expect(onUnrecoverable).not.toHaveBeenCalled();
    expect(a.getState().connection).toBe("live");
    expect(a.getState().pending).toBe(0);
    expect((await net.board.getBoard()).objects[id]).toBeDefined();
    expect(ctl.calls.filter((c) => c === "subscribe")).toHaveLength(1);
  });
});

describe("finding 6: a peer that leaves while I re-subscribe", () => {
  for (const d of [0, 5]) {
    it(`does not linger until expiry (leave ${d} ms into the re-subscribe)`, async () => {
      const net = new Net({ rng: () => 0.5, minLat: 0, maxLat: 100, coalesceMs: 33 });
      const { store: a, g } = await start(net, "a");
      const { store: b } = await start(net, "b");
      const { store: c } = await start(net, "c");
      c.setPresence({ cursor: { x: 1, y: 1 }, transforms: [{ objId: "o_000000000001", x: 5, y: 5, w: 10, h: 10, rot: 0 }] });
      await tick(500);
      expect(a.getState().peers.has("client-c")).toBe(true);
      // The next heartbeat tells A it is unknown, so A re-subscribes.
      const up = g.updatePresence;
      g.updatePresence = async () => { g.updatePresence = up; await sleep(60); return { known: false, revision: 0 }; };
      a.flushPresence();
      await tick(d);
      c.dispose(); // C closes its tab while A's subscribe is travelling
      const t0 = Date.now();
      /** @type {number|null} */
      let goneAt = null;
      for (let i = 0; i < 150 && goneAt === null; i++) {
        await tick(100);
        if (!a.getState().peers.has("client-c")) goneAt = Date.now() - t0;
      }
      expect(goneAt).not.toBeNull();
      expect(goneAt).toBeLessThan(1000);
      expect(a.getState().peers.has("client-b")).toBe(true);
      expect(b.getState().peers.has("client-a")).toBe(true);
    });
  }

  it("a peer still present stays through a re-subscribe", async () => {
    const net = new Net({ rng: () => 0.5, minLat: 0, maxLat: 100, coalesceMs: 33 });
    const { store: a, g } = await start(net, "a");
    await start(net, "b");
    await tick(500);
    /** @type {string[][]} */
    const left = [];
    a.subscribe((s, change) => { if (change.kind === "presence") left.push((change.peers ?? []).filter((p) => !s.peers.has(p))); });
    const up = g.updatePresence;
    g.updatePresence = async () => { g.updatePresence = up; return { known: false, revision: 0 }; };
    a.flushPresence();
    await tick(5000);
    expect(a.getState().peers.has("client-b")).toBe(true);
    expect(left.flat()).toEqual([]);
  });
});
