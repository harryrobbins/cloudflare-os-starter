import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COALESCE_MS, Hub, INFLIGHT_TIMEOUT_MS, MAX_INFLIGHT, PRESENCE_BURST, PRESENCE_FLUSH_BYTES, PRESENCE_MAX_INFLIGHT,
  PRESENCE_RATE, SUBSCRIBER_IDLE_MS, presenceBytes,
} from "../../src/core/hub.js";
import { LIMITS, PRESENCE_HEARTBEAT_MS } from "../../src/shared/protocol.js";

class Sub {
  constructor(name, { failOperation = false, failPresence = false } = {}) {
    Object.assign(this, { name, failOperation, failPresence, ops: [], calls: [], disposed: 0, rpcBroken: 0 });
  }
  operation(event) {
    if (this.failOperation) return Promise.reject(new Error("gone"));
    this.ops.push(event);
  }
  presence(events) {
    if (this.failPresence) throw new Error("gone"); // synchronous throw
    this.calls.push(events);
  }
  onRpcBroken() { this.rpcBroken++; }
  [Symbol.dispose]() { this.disposed++; }
  /** Flattened presence events. */
  get presences() { return this.calls.flat(); }
}

const token = "0a".repeat(16);
let t;
const hub = (options = {}) => new Hub({ now: () => t, ...options });
const flush = async () => { await vi.advanceTimersByTimeAsync(DEFAULT_COALESCE_MS); };

beforeEach(() => { vi.useFakeTimers(); t = 1000; });
afterEach(() => { vi.useRealTimers(); });

describe("Hub presence", () => {
  it("replays joins to a newcomer, sends the newcomer's join to others, never echoes own presence", async () => {
    const h = hub();
    const a = new Sub("a"), b = new Sub("b"), c = new Sub("c");
    h.add(a, { clientId: "A", name: "Ann", color: "#FF0000" });
    await flush();
    h.add(b, { clientId: "B", name: "Bob" });
    await flush();
    h.add(c, { clientId: "C", name: "Cat", color: "nope", cursor: { x: 1, y: 2 } });
    expect(c.calls).toEqual([]); // coalesced: nothing before the flush
    await flush();
    expect(h.size).toBe(3);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].map((p) => [p.type, p.clientId])).toEqual([["join", "A"], ["join", "B"]]);
    expect(c.calls[0][0]).toEqual({
      type: "join", clientId: "A", name: "Ann", color: "#ff0000", cursor: null, viewport: null, selection: [],
      transforms: [], stroke: null, editingId: null, at: expect.any(Number),
    });
    expect(a.presences.map((p) => p.clientId)).toEqual(["B", "C"]);
    expect(b.presences.at(-1)).toMatchObject({ type: "join", name: "Cat", color: "#e1632e", cursor: { x: 1, y: 2 } });
    for (const s of [a, b, c]) {
      expect(s.presences.some((p) => p.clientId === s.name.toUpperCase())).toBe(false);
      for (const call of s.calls) expect(Array.isArray(call)).toBe(true);
    }
  });

  it("coalesces: latest full state wins, a pending join stays a join, leave overrides", async () => {
    const h = hub();
    const w = new Sub("w");
    h.add(w, { clientId: "W" });
    await flush();
    const x = h.add(new Sub("x"), { clientId: "X", name: "Xa" });
    h.updatePresence({ clientId: "X", session: x.session, cursor: { x: 1, y: 1 } });
    h.updatePresence({ clientId: "X", session: x.session, cursor: { x: 2, y: 2 }, selection: ["o_000000000001", "bad"] });
    const y = h.add(new Sub("y"), { clientId: "Y" });
    await flush();
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toEqual([
      expect.objectContaining({ type: "join", clientId: "X", name: "Xa", cursor: { x: 2, y: 2 }, selection: ["o_000000000001"] }),
      expect.objectContaining({ type: "join", clientId: "Y" }),
    ]);
    for (let i = 0; i < 5; i++) h.updatePresence({ clientId: "X", session: x.session, cursor: { x: i, y: 0 } });
    h.updatePresence({ clientId: "Y", session: y.session, name: "Yu" });
    h.leave("Y", y.session);
    await flush();
    expect(w.calls[1]).toEqual([
      expect.objectContaining({ type: "update", clientId: "X", cursor: { x: 4, y: 0 }, name: "Xa" }),
      { type: "leave", clientId: "Y", at: expect.any(Number) },
    ]);
    // Fields left out keep their values; null clears.
    h.updatePresence({ clientId: "X", session: x.session, cursor: null });
    await flush();
    expect(w.calls[2][0]).toMatchObject({ cursor: null, selection: ["o_000000000001"] });
  });

  it("coalesceMs 0 delivers immediately as one-element arrays", async () => {
    const h = hub({ coalesceMs: 0 });
    const a = new Sub("a"), b = new Sub("b");
    const { session } = h.add(a, { clientId: "A" });
    h.add(b, { clientId: "B" });
    expect(a.calls).toEqual([[expect.objectContaining({ type: "join", clientId: "B" })]]);
    await vi.advanceTimersByTimeAsync(0);
    h.updatePresence({ clientId: "A", session, cursor: { x: 5, y: 5 } });
    await vi.advanceTimersByTimeAsync(0);
    h.updatePresence({ clientId: "A", session, cursor: { x: 6, y: 5 } });
    expect(b.calls.at(-2)).toEqual([expect.objectContaining({ type: "update", cursor: { x: 5, y: 5 } })]);
    expect(b.calls.at(-1)).toEqual([expect.objectContaining({ type: "update", cursor: { x: 6, y: 5 } })]);
  });

  it("skips a subscriber with 4 presence deliveries in flight, then catches up with the latest", async () => {
    const h = hub();
    const resolvers = [];
    const slow = { calls: [], presence(events) { this.calls.push(events); return new Promise((r) => resolvers.push(r)); }, operation() {} };
    const fast = new Sub("fast");
    h.add(slow, { clientId: "S" });
    h.add(fast, { clientId: "F" });
    const { session } = h.add(new Sub("m"), { clientId: "M" });
    for (let i = 0; i < PRESENCE_MAX_INFLIGHT + 3; i++) {
      h.updatePresence({ clientId: "M", session, cursor: { x: i, y: 0 } });
      await flush();
    }
    expect(slow.calls).toHaveLength(PRESENCE_MAX_INFLIGHT);
    expect(fast.calls.length).toBeGreaterThan(PRESENCE_MAX_INFLIGHT);
    expect(h.has("S")).toBe(true);
    resolvers.shift()();
    await flush();
    expect(slow.calls).toHaveLength(PRESENCE_MAX_INFLIGHT + 1);
    expect(slow.calls.at(-1)).toEqual([expect.objectContaining({ clientId: "M", cursor: { x: PRESENCE_MAX_INFLIGHT + 2, y: 0 } })]);
  });

  it("presence deliveries do not count toward operation backpressure", async () => {
    const h = hub();
    const stuck = { presence: () => new Promise(() => {}), operation() {} };
    h.add(stuck, { clientId: "S" });
    const { session } = h.add(new Sub("m"), { clientId: "M" });
    for (let i = 0; i < 20; i++) { h.updatePresence({ clientId: "M", session, cursor: { x: i, y: 0 } }); await flush(); }
    for (let r = 0; r < 10; r++) await h.broadcast({ type: "operation", revision: r });
    expect(h.has("S")).toBe(true);
  });

  it("drops a subscriber whose presence delivery rejects or throws, and tells the others", async () => {
    const h = hub();
    const good = new Sub("good");
    h.add(good, { clientId: "G" });
    await flush();
    const bad = new Sub("bad", { failPresence: true });
    h.add(bad, { clientId: "B" });
    await flush(); // bad's first flush (join for G) throws
    await flush(); // the leave reaches G
    expect(h.has("B")).toBe(false);
    expect(bad.disposed).toBe(1);
    expect(good.presences.map((p) => [p.type, p.clientId])).toEqual([["join", "B"], ["leave", "B"]]);
  });

  it("drops a subscriber whose presence delivery stays unsettled past the timeout", async () => {
    const h = hub();
    const stuck = { presence: () => new Promise(() => {}), operation() {}, [Symbol.dispose]: vi.fn() };
    const watcher = new Sub("w");
    h.add(stuck, { clientId: "S" });
    const { session } = h.add(watcher, { clientId: "W" });
    await flush();
    t += INFLIGHT_TIMEOUT_MS + 1;
    h.updatePresence({ clientId: "W", session, cursor: { x: 1, y: 1 } });
    await flush();
    expect(h.has("S")).toBe(false);
    expect(stuck[Symbol.dispose]).toHaveBeenCalledOnce();
    await flush();
    expect(watcher.presences.at(-1)).toMatchObject({ type: "leave", clientId: "S" });
  });

  it("updatePresence reports known and ignores unknown clients and wrong sessions", async () => {
    const h = hub();
    const a = new Sub("a"), b = new Sub("b");
    const { session } = h.add(a, { clientId: "A", name: "Ann" });
    h.add(b, { clientId: "B" });
    await flush();
    const count = b.presences.length;
    expect(h.updatePresence({ clientId: "ghost", session })).toEqual({ known: false });
    expect(h.updatePresence(null)).toEqual({ known: false });
    expect(h.updatePresence({ clientId: "A", name: "Mallory" })).toEqual({ known: false });
    expect(h.updatePresence({ clientId: "A", session: "0".repeat(32), name: "Mallory" })).toEqual({ known: false });
    h.leave("A");
    h.leave("A", token);
    await flush();
    expect(h.has("A")).toBe(true);
    expect(b.presences).toHaveLength(count);
    expect(h.updatePresence({ clientId: "A", session, name: "Ann 2" })).toEqual({ known: true });
    await flush();
    expect(b.presences.at(-1)).toMatchObject({ type: "update", name: "Ann 2" });
    for (const s of [a, b]) expect(JSON.stringify(s.calls)).not.toContain(session);
    expect(JSON.stringify(h.list())).not.toContain(session);
    expect(h.list().map((p) => p.name)).toEqual(["Ann 2", "Guest"]);
  });

  it("settled() flushes pending presence without waiting for the timer", async () => {
    vi.useRealTimers();
    const h = new Hub({ coalesceMs: 60_000 });
    const a = new Sub("a");
    h.add(a, { clientId: "A" });
    h.add(new Sub("b"), { clientId: "B" });
    await h.settled();
    expect(a.presences.map((p) => p.clientId)).toEqual(["B"]);
    expect(h.timer).toBeNull();
  });
});

describe("Hub sessions and stubs", () => {
  it("rejects a re-subscribe for a live clientId without its session; replacing disposes the old stub", async () => {
    const h = hub();
    const old = new Sub("old");
    const watcher = new Sub("w");
    h.add(watcher, { clientId: "W" });
    const { session } = h.add(old, { clientId: "A" });
    expect(session).toMatch(/^[0-9a-f]{32}$/);
    expect(() => h.add(new Sub("x"), { clientId: "A" })).toThrow("clientId in use");
    expect(() => h.add(new Sub("x"), { clientId: "A", session: "f".repeat(32) })).toThrow("clientId in use");
    const fresh = new Sub("fresh");
    expect(h.add(fresh, { clientId: "A", session }).session).toBe(session);
    expect(old.disposed).toBe(1);
    expect(h.size).toBe(2);
    await h.broadcast({ type: "operation", revision: 1 });
    expect(fresh.ops).toHaveLength(1);
    expect(old.ops).toHaveLength(0);
    await flush();
    expect(watcher.presences.map((p) => [p.type, p.clientId])).toEqual([["join", "A"]]);
  });

  it("keeps a well-formed client session for an unknown clientId, else mints one", () => {
    const h = hub();
    expect(h.add(new Sub("a"), { clientId: "A", session: token }).session).toBe(token);
    for (const bad of [token.toUpperCase(), "123", 42, null, "g".repeat(32)]) {
      const { session } = h.add(new Sub("b"), { clientId: "B" + String(bad), session: bad });
      expect(session).toMatch(/^[0-9a-f]{32}$/);
      expect(session).not.toBe(bad);
    }
    expect(h.add(new Sub("x"), {}).clientId).toMatch(/^anon_/);
  });

  it("leave disposes the stub and tells the others; onRpcBroken is never called", async () => {
    const h = hub();
    const a = new Sub("a"), b = new Sub("b");
    const { session } = h.add(a, { clientId: "A" });
    h.add(b, { clientId: "B" });
    h.leave("A", session);
    expect(h.has("A")).toBe(false);
    expect(a.disposed).toBe(1);
    await flush();
    expect(b.presences.map((p) => [p.type, p.clientId])).toEqual([["leave", "A"]]); // join then leave coalesced
    h.leave("A", session);
    expect(a.disposed).toBe(1);
    expect(a.rpcBroken + b.rpcBroken).toBe(0);
  });

  it("a throwing or missing dispose is ignored", async () => {
    const h = hub();
    const { session } = h.add({ operation() {}, presence() {}, [Symbol.dispose]() { throw new Error("x"); } }, { clientId: "A" });
    expect(() => h.leave("A", session)).not.toThrow();
    const s2 = h.add({ operation() {}, presence() {} }, { clientId: "B" }).session;
    expect(() => h.leave("B", s2)).not.toThrow();
  });
});

describe("Hub operations and backpressure", () => {
  it("initiates operation calls synchronously in insertion order", () => {
    const h = hub();
    const calls = [];
    for (const id of ["x", "y", "z"]) h.add({ operation: (e) => calls.push([id, e.revision]), presence() {} }, { clientId: id });
    h.broadcast({ revision: 1 });
    h.broadcast({ revision: 2 });
    expect(calls).toEqual([["x", 1], ["y", 1], ["z", 1], ["x", 2], ["y", 2], ["z", 2]]);
  });

  it("removes a subscriber whose operation delivery rejects, disposes it, broadcasts leave", async () => {
    const h = hub();
    const good = new Sub("good"), bad = new Sub("bad", { failOperation: true });
    h.add(good, { clientId: "G" });
    h.add(bad, { clientId: "B" });
    await flush();
    await h.broadcast({ type: "operation", revision: 1 });
    expect(h.has("B")).toBe(false);
    expect(bad.disposed).toBe(1);
    await flush();
    expect(good.ops).toHaveLength(1);
    expect(good.presences.at(-1)).toEqual({ type: "leave", clientId: "B", at: expect.any(Number) });
  });

  it("refuses subscribers beyond the cap, but still allows replacing one", () => {
    const h = hub({ maxSubscribers: 3 });
    const sessions = [0, 1, 2].map((i) => h.add(new Sub("s"), { clientId: "c" + i }).session);
    expect(() => h.add(new Sub("x"), { clientId: "c3" })).toThrow("board is full");
    expect(h.add(new Sub("y"), { clientId: "c0", session: sessions[0] }).session).toBe(sessions[0]);
    expect(h.size).toBe(3);
    expect(new Hub().maxSubscribers).toBe(LIMITS.subscribers);
  });

  it("drops a subscriber with too many unsettled operation deliveries", async () => {
    const h = hub();
    const good = new Sub("good");
    const stuck = { operation: () => new Promise(() => {}), presence() {}, [Symbol.dispose]: vi.fn() };
    h.add(good, { clientId: "G" });
    h.add(stuck, { clientId: "S" });
    for (let r = 1; r <= MAX_INFLIGHT; r++) h.broadcast({ type: "operation", revision: r });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.has("S")).toBe(true);
    h.broadcast({ type: "operation", revision: MAX_INFLIGHT + 1 });
    expect(h.has("S")).toBe(false);
    expect(stuck[Symbol.dispose]).toHaveBeenCalledOnce();
    await h.broadcast({ type: "operation", revision: MAX_INFLIGHT + 2 });
    await flush();
    expect(good.ops).toHaveLength(MAX_INFLIGHT + 2);
    expect(good.presences.at(-1)).toMatchObject({ type: "leave", clientId: "S" });
  });

  it("drops a subscriber whose oldest unsettled operation is too old", async () => {
    const h = hub();
    let calls = 0;
    const slow = { operation: () => { calls++; return new Promise(() => {}); }, presence() {} };
    h.add(new Sub("good"), { clientId: "G" });
    h.add(slow, { clientId: "S" });
    h.broadcast({ type: "operation", revision: 1 });
    t += INFLIGHT_TIMEOUT_MS;
    h.broadcast({ type: "operation", revision: 2 });
    expect(h.has("S")).toBe(true);
    t += 1;
    h.broadcast({ type: "operation", revision: 3 });
    expect(h.has("S")).toBe(false);
    expect(calls).toBe(2);
  });

  it("settled deliveries do not count towards the in-flight cap", async () => {
    const h = hub();
    const a = new Sub("a");
    h.add(a, { clientId: "A" });
    for (let r = 1; r <= MAX_INFLIGHT * 3; r++) await h.broadcast({ type: "operation", revision: r });
    expect(h.has("A")).toBe(true);
    expect(a.ops).toHaveLength(MAX_INFLIGHT * 3);
  });
});

describe("Hub limits on a single caller", () => {
  it("when full, removes subscribers idle for SUBSCRIBER_IDLE_MS (disposed, leave broadcast) before refusing", async () => {
    const h = hub({ maxSubscribers: 3 });
    const live = new Sub("live");
    const squatters = [new Sub("s0"), new Sub("s1")];
    const { session } = h.add(live, { clientId: "L" });
    squatters.forEach((s, i) => h.add(s, { clientId: "S" + i }));
    await flush();
    // Nobody is idle yet: full.
    t += SUBSCRIBER_IDLE_MS;
    expect(() => h.add(new Sub("x"), { clientId: "X" })).toThrow("board is full");
    // L heartbeats (as clients do every PRESENCE_HEARTBEAT_MS); the squatters never do.
    h.updatePresence({ clientId: "L", session, cursor: { x: 1, y: 1 } });
    t += 1;
    const newcomer = new Sub("new");
    expect(h.add(newcomer, { clientId: "N" }).session).toMatch(/^[0-9a-f]{32}$/);
    expect([h.has("L"), h.has("S0"), h.has("S1"), h.has("N")]).toEqual([true, false, false, true]);
    expect(squatters.map((s) => s.disposed)).toEqual([1, 1]);
    await flush();
    expect(live.presences.filter((p) => p.type === "leave").map((p) => p.clientId)).toEqual(["S0", "S1"]);
    expect(newcomer.presences.map((p) => [p.type, p.clientId])).toEqual([["join", "L"]]);
    // A subscriber that keeps heartbeating is never evicted.
    for (let i = 0; i < 3; i++) {
      t += PRESENCE_HEARTBEAT_MS;
      h.updatePresence({ clientId: "L", session, cursor: { x: i, y: 1 } });
    }
    h.add(new Sub("y"), { clientId: "Y" });
    t += SUBSCRIBER_IDLE_MS + 1 - 3 * PRESENCE_HEARTBEAT_MS;
    h.updatePresence({ clientId: "L", session });
    expect(() => h.add(new Sub("z"), { clientId: "Z" })).not.toThrow(); // N idle: evicted
    expect([h.has("L"), h.has("N"), h.has("Y"), h.has("Z")]).toEqual([true, false, true, true]);
  });

  it("caps the presence bytes of one delivery and sends the rest, latest-wins, next flush", async () => {
    const h = hub();
    const watcher = new Sub("w");
    h.add(watcher, { clientId: "W" });
    await flush();
    const stroke = { points: Array.from({ length: 2 * LIMITS.presenceStrokePoints }, (_, i) => -999999.99 + i), color: "#123456", width: 3 };
    const sessions = [];
    for (let i = 0; i < 80; i++) sessions.push(h.add(new Sub("b" + i), { clientId: "B" + i }).session);
    await flush();
    watcher.calls.length = 0;
    for (let i = 0; i < 80; i++) h.updatePresence({ clientId: "B" + i, session: sessions[i], stroke, cursor: { x: i, y: 0 } });
    await flush();
    expect(watcher.calls).toHaveLength(1);
    const bytes = (events) => events.reduce((n, e) => n + presenceBytes(e), 0);
    expect(bytes(watcher.calls[0])).toBeLessThanOrEqual(PRESENCE_FLUSH_BYTES);
    expect(JSON.stringify(watcher.calls[0]).length).toBeLessThanOrEqual(PRESENCE_FLUSH_BYTES);
    const first = watcher.calls[0].length;
    expect(first).toBeLessThan(80);
    // A deferred client moves again before the next flush: only its latest state goes out.
    h.updatePresence({ clientId: "B79", session: sessions[79], cursor: { x: 1234, y: 0 } });
    for (let k = 0; k < 5 && watcher.presences.length < 80; k++) await flush();
    const got = watcher.presences;
    expect(got).toHaveLength(80);
    expect(new Set(got.map((e) => e.clientId)).size).toBe(80);
    expect(got.find((e) => e.clientId === "B79").cursor).toEqual({ x: 1234, y: 0 });
    for (const call of watcher.calls) expect(bytes(call)).toBeLessThanOrEqual(PRESENCE_FLUSH_BYTES);
  });

  it("an estimate never below the JSON size of a presence event", () => {
    const full = {
      type: "update", clientId: "c".repeat(64), name: "名".repeat(40), color: "#123456", at: 1_700_000_000_000,
      cursor: { x: -999999.99, y: -999999.99 }, viewport: { x: -999999.99, y: -999999.99, w: 1999999.99, h: 1999999.99 },
      selection: Array.from({ length: LIMITS.presenceSelection }, () => "o_0123456789ab"),
      transforms: Array.from({ length: LIMITS.presenceTransforms }, () => ({ id: "o_0123456789ab", x: -999999.99, y: -999999.99, w: 99999.99, h: 99999.99, rot: 359.9 })),
      stroke: { points: Array.from({ length: 2 * LIMITS.presenceStrokePoints }, () => -999999.99), color: "#123456", width: 63.5 },
      editingId: "o_0123456789ab",
    };
    expect(presenceBytes(full)).toBeGreaterThanOrEqual(new TextEncoder().encode(JSON.stringify(full)).length);
    const empty = { ...full, selection: [], transforms: [], stroke: null };
    expect(presenceBytes(empty)).toBeGreaterThanOrEqual(new TextEncoder().encode(JSON.stringify(empty)).length);
  });

  it("rate-limits fan-out per client: bursts beyond PRESENCE_BURST merge into one later update", async () => {
    const h = hub({ coalesceMs: 0 });
    const watcher = new Sub("w");
    h.add(watcher, { clientId: "W" });
    const { session } = h.add(new Sub("m"), { clientId: "M" });
    watcher.calls.length = 0;
    // (Awaiting lets each delivery settle, so the in-flight cap is not what limits them.)
    for (let i = 0; i < 500; i++) {
      expect(h.updatePresence({ clientId: "M", session, cursor: { x: i, y: 0 } })).toEqual({ known: true });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(watcher.calls).toHaveLength(PRESENCE_BURST);
    await vi.advanceTimersByTimeAsync(1000 / PRESENCE_RATE);
    expect(watcher.calls).toHaveLength(PRESENCE_BURST + 1);
    expect(watcher.calls.at(-1)).toEqual([expect.objectContaining({ type: "update", clientId: "M", cursor: { x: 499, y: 0 } })]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(watcher.calls).toHaveLength(PRESENCE_BURST + 1);
    // Tokens refill with time.
    t += 1000;
    for (let i = 0; i < 10; i++) {
      h.updatePresence({ clientId: "M", session, cursor: { x: i, y: 1 } });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(watcher.calls).toHaveLength(PRESENCE_BURST + 11);
    // The merged state is what list() and newcomers see at once.
    for (let i = 0; i < 100; i++) h.updatePresence({ clientId: "M", session, name: "Name " + i });
    expect(h.list().find((p) => p.clientId === "M").name).toBe("Name 99");
    await h.settled();
    expect(watcher.presences.at(-1)).toMatchObject({ clientId: "M", name: "Name 99" });
  });
});
