import { describe, expect, it } from "vitest";
import { DEFAULT_PRESENCE_COLOR, Hub, INFLIGHT_TIMEOUT_MS, MAX_INFLIGHT, PRESENCE_THROTTLE_MS } from "../../src/core/hub.js";
import { LIMITS } from "../../src/shared/protocol.js";

class Sub {
  constructor(name, { failOperation = false, failPresence = false, delay = 0 } = {}) {
    Object.assign(this, { name, failOperation, failPresence, delay, ops: [], presences: [] });
  }
  async operation(event) {
    if (this.failOperation) throw new Error("gone");
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay * Math.random()));
    this.ops.push(event);
  }
  presence(event) {
    if (this.failPresence) throw new Error("gone"); // synchronous throw
    this.presences.push(event);
  }
}

const hub = () => new Hub({ now: () => 123 });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Hub", () => {
  it("replays joins to a newcomer and broadcasts its join to everyone", async () => {
    const h = hub();
    const a = new Sub("a"), b = new Sub("b"), c = new Sub("c");
    await h.add(a, { clientId: "A", name: "Ann", color: "#FF0000" }).delivered;
    await h.add(b, { clientId: "B", name: "Bob" }).delivered;
    await h.add(c, { clientId: "C", name: "Cat", color: "nope" }).delivered;
    expect(h.size).toBe(3);
    expect(c.presences.map((p) => [p.type, p.clientId])).toEqual([["join", "A"], ["join", "B"], ["join", "C"]]);
    expect(a.presences.map((p) => p.clientId)).toEqual(["A", "B", "C"]);
    expect(c.presences[0]).toEqual({ type: "join", clientId: "A", name: "Ann", color: "#ff0000", openCardId: null, dragCardId: null, hoverColumnId: null, at: 123 });
    expect(c.presences[2].color).toBe(DEFAULT_PRESENCE_COLOR);
    expect(b.presences.at(-1).name).toBe("Cat");
  });

  it("re-adding a clientId with its session replaces the old entry and keeps the session", async () => {
    const h = hub();
    const old = new Sub("old"), fresh = new Sub("fresh");
    const { session } = h.add(old, { clientId: "A" });
    expect(session).toMatch(/^[0-9a-f]{32}$/);
    const again = h.add(fresh, { clientId: "A", session });
    expect(again.session).toBe(session);
    await again.delivered;
    expect(h.size).toBe(1);
    await h.broadcast({ type: "operation", revision: 1 });
    expect(fresh.ops).toHaveLength(1);
    expect(old.ops).toHaveLength(0);
  });

  it("broadcast keeps revision order per subscriber despite slow deliveries", async () => {
    const h = hub();
    const subs = [new Sub("a", { delay: 5 }), new Sub("b", { delay: 5 })];
    subs.forEach((s, i) => h.add(s, { clientId: "c" + i }));
    // Deliveries are initiated synchronously and in order; each Sub awaits a random delay, so
    // arrival order only holds if calls were made in order. Model a transport that queues calls.
    const ordered = subs.map((s) => {
      let chain = Promise.resolve();
      const inner = s.operation.bind(s);
      s.operation = (e) => (chain = chain.then(() => inner(e)));
      return s;
    });
    const all = [];
    for (let r = 1; r <= 20; r++) all.push(h.broadcast({ type: "operation", revision: r }));
    await Promise.all(all);
    for (const s of ordered) expect(s.ops.map((e) => e.revision)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("initiates calls synchronously in insertion order", () => {
    const h = hub();
    const calls = [];
    for (const id of ["x", "y", "z"]) h.add({ operation: (e) => calls.push([id, e.revision]), presence() {} }, { clientId: id });
    h.broadcast({ revision: 1 });
    h.broadcast({ revision: 2 });
    expect(calls).toEqual([["x", 1], ["y", 1], ["z", 1], ["x", 2], ["y", 2], ["z", 2]]);
  });

  it("removes a subscriber whose delivery rejects and broadcasts its leave", async () => {
    const h = hub();
    const good = new Sub("good"), bad = new Sub("bad", { failOperation: true });
    await h.add(good, { clientId: "G" }).delivered;
    await h.add(bad, { clientId: "B" }).delivered;
    await h.broadcast({ type: "operation", revision: 1 });
    await h.settled();
    expect(h.has("B")).toBe(false);
    expect(h.size).toBe(1);
    expect(good.ops).toHaveLength(1);
    expect(good.presences.at(-1)).toEqual({ type: "leave", clientId: "B", at: 123 });
  });

  it("removes a subscriber whose presence throws synchronously", async () => {
    const h = hub();
    const good = new Sub("good");
    await h.add(good, { clientId: "G" }).delivered;
    h.add(new Sub("bad", { failPresence: true }), { clientId: "B" });
    await h.settled();
    expect(h.list().map((p) => p.clientId)).toEqual(["G"]);
    expect(good.presences.map((p) => [p.type, p.clientId])).toEqual([["join", "G"], ["join", "B"], ["leave", "B"]]);
  });

  it("updatePresence reports known, cleans fields and keeps previous values", async () => {
    let t = 0;
    const h = new Hub({ now: () => (t += 1000) });
    const a = new Sub("a"), b = new Sub("b");
    const { session } = h.add(a, { clientId: "A", name: "Ann", color: "#123456" });
    h.add(b, { clientId: "B", name: "Bob" });
    let r = h.updatePresence({ clientId: "A", session, openCardId: "c_0000abcd", dragCardId: "c_bad", hoverColumnId: "k_0000abcd", name: "" });
    expect(r.known).toBe(true);
    await r.delivered;
    expect(b.presences.at(-1)).toEqual({ type: "update", clientId: "A", name: "Ann", color: "#123456", openCardId: "c_0000abcd", dragCardId: null, hoverColumnId: "k_0000abcd", at: expect.any(Number) });
    r = h.updatePresence({ clientId: "A", session, dragCardId: "c_00000001" });
    await r.delivered;
    expect(b.presences.at(-1)).toMatchObject({ openCardId: "c_0000abcd", dragCardId: "c_00000001" });
    const count = b.presences.length;
    expect(h.updatePresence({ clientId: "ghost" }).known).toBe(false);
    expect(h.updatePresence(null).known).toBe(false);
    await h.settled();
    expect(b.presences).toHaveLength(count);
  });

  it("leave removes and broadcasts", async () => {
    const h = hub();
    const a = new Sub("a"), b = new Sub("b");
    const { session } = h.add(a, { clientId: "A" });
    h.add(b, { clientId: "B" });
    await h.leave("A", session);
    expect(h.has("A")).toBe(false);
    expect(b.presences.at(-1)).toEqual({ type: "leave", clientId: "A", at: 123 });
    await h.leave("");
    expect(h.size).toBe(1);
  });

  it("registers onRpcBroken defensively", async () => {
    const h = hub();
    let broken;
    const stub = { operation() {}, presence() {}, onRpcBroken: (fn) => { broken = fn; } };
    const other = new Sub("o");
    h.add(other, { clientId: "O" });
    h.add(stub, { clientId: "S" });
    h.add({ operation() {}, presence() {}, onRpcBroken: () => Promise.reject(new Error("unsupported")) }, { clientId: "R" });
    h.add({ operation() {}, presence() {}, onRpcBroken: () => { throw new Error("unsupported"); } }, { clientId: "T" });
    broken();
    await h.settled();
    expect(h.has("S")).toBe(false);
    expect(h.has("R") && h.has("T")).toBe(true);
    expect(other.presences.some((p) => p.type === "leave" && p.clientId === "S")).toBe(true);
  });

  it("assigns an id to clients without one", () => {
    const h = hub();
    const { clientId } = h.add(new Sub("x"), {});
    expect(clientId).toMatch(/^anon_/);
    expect(h.has(clientId)).toBe(true);
  });
});

describe("Hub sessions", () => {
  it("rejects a re-subscribe for a live clientId without its session", () => {
    const h = hub();
    const { session } = h.add(new Sub("a"), { clientId: "A" });
    expect(() => h.add(new Sub("x"), { clientId: "A" })).toThrow("clientId in use");
    expect(() => h.add(new Sub("x"), { clientId: "A", session: "f".repeat(32) })).toThrow("clientId in use");
    expect(h.add(new Sub("a2"), { clientId: "A", session }).session).toBe(session);
  });

  it("keeps a well-formed client session for an unknown clientId, else mints one", () => {
    const h = hub();
    const token = "0a".repeat(16);
    expect(h.add(new Sub("a"), { clientId: "A", session: token }).session).toBe(token);
    for (const bad of ["ABCDEF0123456789ABCDEF0123456789", "123", 42, null, "g".repeat(32)]) {
      const { session } = h.add(new Sub("b"), { clientId: "B" + String(bad), session: bad });
      expect(session).toMatch(/^[0-9a-f]{32}$/);
      expect(session).not.toBe(bad);
    }
    const s1 = h.add(new Sub("c"), { clientId: "C1" }).session;
    const s2 = h.add(new Sub("d"), { clientId: "C2" }).session;
    expect(s1).not.toBe(s2);
  });

  it("ignores presence updates and leaves with the wrong session, and never broadcasts it", async () => {
    const h = hub();
    const a = new Sub("a"), b = new Sub("b");
    const { session } = h.add(a, { clientId: "A", name: "Ann" });
    h.add(b, { clientId: "B" });
    await h.settled();
    const count = b.presences.length;
    expect(h.updatePresence({ clientId: "A", name: "Mallory" }).known).toBe(false);
    expect(h.updatePresence({ clientId: "A", session: "0".repeat(32), name: "Mallory" }).known).toBe(false);
    await h.leave("A");
    await h.leave("A", "0".repeat(32));
    await h.settled();
    expect(h.has("A")).toBe(true);
    expect(b.presences).toHaveLength(count);
    expect(h.list().find((p) => p.clientId === "A").name).toBe("Ann");
    expect(h.updatePresence({ clientId: "A", session, name: "Ann 2" }).known).toBe(true);
    await h.settled();
    for (const sub of [a, b]) {
      for (const p of sub.presences) expect(JSON.stringify(p)).not.toContain(session);
    }
    expect(JSON.stringify(h.list())).not.toContain(session);
  });
});

describe("Hub backpressure", () => {
  it("refuses subscribers beyond the cap, but still allows replacing one", () => {
    const h = new Hub({ now: () => 1, maxSubscribers: 3 });
    const sessions = [0, 1, 2].map((i) => h.add(new Sub("s"), { clientId: "c" + i }).session);
    expect(() => h.add(new Sub("x"), { clientId: "c3" })).toThrow("board is full");
    expect(h.add(new Sub("y"), { clientId: "c0", session: sessions[0] }).session).toBe(sessions[0]);
    expect(h.size).toBe(3);
    expect(new Hub().maxSubscribers).toBe(LIMITS.subscribers);
  });

  it("drops a subscriber with too many unsettled deliveries and broadcasts leave", async () => {
    const h = hub();
    const good = new Sub("good");
    const stuck = { operation: () => new Promise(() => {}), presence() {} };
    h.add(good, { clientId: "G" });
    h.add(stuck, { clientId: "S" });
    await h.settled(); // join deliveries settle first
    for (let r = 1; r <= MAX_INFLIGHT; r++) h.broadcast({ type: "operation", revision: r });
    await tick(); // the good subscriber's deliveries settle; the stuck one's never do
    expect(h.has("S")).toBe(true);
    h.broadcast({ type: "operation", revision: MAX_INFLIGHT + 1 });
    expect(h.has("S")).toBe(false);
    await h.broadcast({ type: "operation", revision: MAX_INFLIGHT + 2 });
    expect(good.ops).toHaveLength(MAX_INFLIGHT + 2);
    expect(good.presences.at(-1)).toEqual({ type: "leave", clientId: "S", at: 123 });
  });

  it("drops a subscriber whose oldest unsettled delivery is too old", async () => {
    let t = 0;
    const h = new Hub({ now: () => t });
    const good = new Sub("good");
    let calls = 0;
    const slow = { operation: () => { calls++; return new Promise(() => {}); }, presence() {} };
    h.add(good, { clientId: "G" });
    h.add(slow, { clientId: "S" });
    await h.settled();
    h.broadcast({ type: "operation", revision: 1 });
    await tick();
    t = INFLIGHT_TIMEOUT_MS;
    h.broadcast({ type: "operation", revision: 2 });
    await tick();
    expect(h.has("S")).toBe(true);
    t = INFLIGHT_TIMEOUT_MS + 1;
    h.broadcast({ type: "operation", revision: 3 });
    expect(h.has("S")).toBe(false);
    expect(calls).toBe(2);
    await tick();
    expect(h.has("G")).toBe(true);
    expect(good.presences.at(-1)).toMatchObject({ type: "leave", clientId: "S" });
  });

  it("settled deliveries do not count towards the in-flight cap", async () => {
    const h = hub();
    const a = new Sub("a");
    h.add(a, { clientId: "A" });
    for (let r = 1; r <= MAX_INFLIGHT * 3; r++) await h.broadcast({ type: "operation", revision: r });
    expect(h.has("A")).toBe(true);
    expect(a.ops).toHaveLength(MAX_INFLIGHT * 3);
  });

  it("throttles identical presence updates within the window", async () => {
    let t = 1000;
    const h = new Hub({ now: () => t });
    const a = new Sub("a"), b = new Sub("b");
    const { session } = h.add(a, { clientId: "A" });
    h.add(b, { clientId: "B" });
    await h.settled();
    const updates = () => b.presences.filter((p) => p.type === "update").length;
    const p = { clientId: "A", session, openCardId: "c_0000abcd" };
    expect(h.updatePresence(p).known).toBe(true);
    t += PRESENCE_THROTTLE_MS - 1;
    expect(h.updatePresence(p).known).toBe(true);                        // identical, too soon
    await h.settled();
    expect(updates()).toBe(1);
    expect(h.updatePresence({ ...p, openCardId: null }).known).toBe(true); // changed: fans out
    await h.settled();
    expect(updates()).toBe(2);
    t += PRESENCE_THROTTLE_MS;
    h.updatePresence({ ...p, openCardId: null });                         // identical but old enough
    await h.settled();
    expect(updates()).toBe(3);
  });
});
