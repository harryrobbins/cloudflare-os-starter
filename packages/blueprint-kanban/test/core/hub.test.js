import { describe, expect, it } from "vitest";
import { DEFAULT_PRESENCE_COLOR, Hub } from "../../src/core/hub.js";

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

  it("re-adding a clientId replaces the old entry", async () => {
    const h = hub();
    const old = new Sub("old"), fresh = new Sub("fresh");
    h.add(old, { clientId: "A" });
    await h.add(fresh, { clientId: "A" }).delivered;
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
    const h = hub();
    const a = new Sub("a"), b = new Sub("b");
    h.add(a, { clientId: "A", name: "Ann", color: "#123456" });
    h.add(b, { clientId: "B", name: "Bob" });
    let r = h.updatePresence({ clientId: "A", openCardId: "c_0000abcd", dragCardId: "c_bad", hoverColumnId: "k_0000abcd", name: "" });
    expect(r.known).toBe(true);
    await r.delivered;
    expect(b.presences.at(-1)).toEqual({ type: "update", clientId: "A", name: "Ann", color: "#123456", openCardId: "c_0000abcd", dragCardId: null, hoverColumnId: "k_0000abcd", at: 123 });
    r = h.updatePresence({ clientId: "A", dragCardId: "c_00000001" });
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
    h.add(a, { clientId: "A" });
    h.add(b, { clientId: "B" });
    await h.leave("A");
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
