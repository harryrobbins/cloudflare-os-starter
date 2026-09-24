// Connection truth and recoverability (plan Phase 1): the store's status fields, the recovery
// data, and deterministic network cases for the replaceable target seam (replaceTarget) on the
// fake gadget.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeServer, settle, startStore } from "./helpers.js";
import { SLOW_SAVE_MS } from "../../src/client/sync/connection.js";
import { REQUEST_TIMEOUT_MS, UNRECOVERABLE_AFTER_MS } from "../../src/client/sync/store.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/**
 * A gadget stub for `server` whose behaviour a test switches:
 *   ok           pass through
 *   hang         every call stays pending forever (a dead stub)
 *   reject       every call rejects (the stale platform stub after a facet restart)
 *   loseReply    applyOperation reaches the server and commits, but its result never comes back
 *   loseRequest  applyOperation never reaches the server
 * `sent` records every applyOperation request as the client made it.
 * @param {FakeServer} server
 */
function stub(server) {
  const real = /** @type {Record<string, (...args: any[]) => Promise<any>>} */ (server.connect());
  const ctl = { mode: "ok", /** @type {any[]} */ sent: [] };
  /** @type {Record<string, any>} */
  const gadget = {};
  for (const [name, fn] of Object.entries(real)) {
    gadget[name] = (/** @type {any[]} */ ...args) => {
      if (name === "applyOperation") ctl.sent.push(structuredClone(args[0]));
      if (ctl.mode === "reject") return Promise.reject(new Error("stub broken"));
      if (ctl.mode === "hang") return new Promise(() => {});
      if (name === "applyOperation" && ctl.mode === "loseReply") {
        fn(...args).catch(() => {});
        return new Promise(() => {});
      }
      if (name === "applyOperation" && ctl.mode === "loseRequest") return new Promise(() => {});
      return fn(...args);
    };
  }
  return { gadget, ctl };
}

/** @param {{latency?: number, eventLatency?: number, onUnrecoverable?: () => void}} [o] */
async function setup({ latency = 5, eventLatency = undefined, onUnrecoverable = undefined } = {}) {
  const server = new FakeServer({ latency, eventLatency });
  const noteId = server.seed({ type: "sticky", x: 100, y: 100, text: "Seed" });
  const first = stub(server);
  const a = await startStore(server, "a", { gadget: first.gadget, onUnrecoverable });
  await settle(50);
  /** @type {{c: string, n: number, risk: boolean}[]} */
  const seen = [];
  a.store.subscribe((s) => seen.push({ c: s.connection, n: s.pendingCount, risk: s.riskOfLoss }));
  return { server, noteId, a, first, seen };
}

/** @param {any} store @param {FakeServer} server */
function expectSettled(store, server) {
  const s = store.getState();
  expect(s.connection).toBe("live");
  expect(s.pendingCount).toBe(0);
  expect(s.riskOfLoss).toBe(false);
  expect(s.lastError).toBeNull();
  expect(s.lastAcknowledgedRevision).toBe(server.revision);
  expect(s.board.objects).toEqual(server.objects);
}

describe("status fields", () => {
  it("goes live -> saving -> live around an edit, and never says live with work pending", async () => {
    const { server, noteId, a, seen } = await setup({ latency: 20 });
    expect(a.store.getState()).toMatchObject({ connection: "live", pendingCount: 0, oldestPendingAt: null, riskOfLoss: false });
    const t0 = Date.now();
    a.store.updateObjects([{ id: noteId, patch: { x: 150 } }]);
    expect(a.store.getState()).toMatchObject({ connection: "saving", pendingCount: 1, pending: 1, oldestPendingAt: t0 });
    await settle(30); // applied on the server, result still in transit
    expect(server.objects[noteId].x).toBe(150);
    expect(a.store.getState().connection).toBe("saving");
    await settle(100);
    expectSettled(a.store, server);
    expect(seen.map((x) => x.c)).toContain("saving");
    for (const x of seen) if (x.c === "live") expect(x.n).toBe(0);
  });

  it("flags riskOfLoss when a save takes SLOW_SAVE_MS, and when the link is down", async () => {
    const { server, noteId, a, first } = await setup();
    first.ctl.mode = "hang";
    a.store.updateObjects([{ id: noteId, patch: { text: "Slow" } }]);
    await settle(SLOW_SAVE_MS - 100);
    expect(a.store.getState()).toMatchObject({ connection: "saving", riskOfLoss: false });
    await settle(200);
    expect(a.store.getState()).toMatchObject({ connection: "saving", riskOfLoss: true, pendingCount: 1 });
    const fresh = stub(server);
    a.store.replaceTarget(fresh.gadget);
    expect(a.store.getState()).toMatchObject({ connection: "reconnecting", riskOfLoss: true });
    await settle(200);
    expectSettled(a.store, server);
    expect(server.objects[noteId].text).toBe("Slow");
  });

  it("becomes recovery-required when the budget is spent, keeps the queue, and recovers on a new target", async () => {
    const onUnrecoverable = vi.fn();
    const { server, noteId, a, first } = await setup({ onUnrecoverable });
    first.ctl.mode = "reject";
    a.store.updateObjects([{ id: noteId, patch: { text: "Kept" } }]);
    await settle(UNRECOVERABLE_AFTER_MS + 2000);
    expect(onUnrecoverable).toHaveBeenCalledTimes(1);
    expect(a.store.getState()).toMatchObject({ connection: "recovery-required", pendingCount: 1, riskOfLoss: true, lastError: null });
    expect(a.store.getState().board.objects[noteId].text).toBe("Kept"); // still shown optimistically
    const fresh = stub(server);
    a.store.replaceTarget(fresh.gadget);
    await settle(200);
    expectSettled(a.store, server);
    expect(server.objects[noteId].text).toBe("Kept");
    // A later outage gets its own budget and callback.
    fresh.ctl.mode = "reject";
    await settle(UNRECOVERABLE_AFTER_MS + 8000);
    expect(onUnrecoverable).toHaveBeenCalledTimes(2);
    expect(a.store.getState().connection).toBe("recovery-required");
  });

  it("counts a server undo as saving until its result arrives", async () => {
    const { server, noteId, a } = await setup({ latency: 20 });
    a.store.updateObjects([{ id: noteId, patch: { x: 300 } }]);
    await settle(200);
    const entry = server.history.at(-1);
    const p = a.store.undoHistory(entry.id);
    expect(a.store.getState().connection).toBe("saving");
    await settle(100);
    await p;
    expect(a.store.getState().connection).toBe("live");
    expect(server.objects[noteId].x).toBe(100);
  });

  it("stops counting an undo that never settles as saving after the request timeout", async () => {
    const { server, noteId, a, first } = await setup();
    a.store.updateObjects([{ id: noteId, patch: { x: 300 } }]);
    await settle(200);
    first.gadget.undo = () => new Promise(() => {}); // a dead stub: the call never settles
    void a.store.undoHistory(server.history.at(-1).id);
    await settle(10);
    expect(a.store.getState()).toMatchObject({ connection: "saving", busy: true });
    await settle(REQUEST_TIMEOUT_MS + 100);
    expect(a.store.getState()).toMatchObject({ connection: "live", busy: false });
  });
});

describe("recovery data", () => {
  it("holds the last acknowledged board and the pending changes, and no request ids or session", async () => {
    const { server, noteId, a, first } = await setup();
    a.store.updateObjects([{ id: noteId, patch: { x: 120 } }]);
    await settle(100);
    first.ctl.mode = "loseRequest";
    a.store.updateObjects([{ id: noteId, patch: { text: "Unsaved" } }]);
    const [created] = a.store.createObjects([{ type: "rect", x: 5, y: 5 }]);
    a.store.setStructure({ title: "Renamed" });
    await settle(50);
    const data = a.store.getRecoveryData();
    expect(data).toMatchObject({ format: "whiteboard-recovery", version: 1, lastAcknowledgedRevision: server.revision });
    expect(data.board.objects[noteId]).toMatchObject({ x: 120, text: "Seed" }); // acknowledged state only
    expect(data.board.objects[created]).toBeUndefined();
    expect(data.pending.map((p) => p.kind)).toEqual(["update", "create", "structure"]);
    expect(data.pending[0]).toMatchObject({ id: noteId, patch: { text: "Unsaved" }, baseVersion: server.objects[noteId].version, sent: true });
    expect(data.pending[1]).toMatchObject({ id: created, object: { type: "rect" }, sent: false });
    expect(data.pending[2]).toMatchObject({ structure: { title: "Renamed" } });
    const json = JSON.stringify(data);
    const secret = first.ctl.sent.at(-1).requestId.split(":")[0];
    expect(json).not.toContain(secret);
    expect(json).not.toContain(server.subscribers.get(a.clientId).session);
    // A copy: mutating it changes nothing in the store.
    data.board.objects[noteId].x = -1;
    expect(a.store.getRecoveryData().board.objects[noteId].x).toBe(120);
  });
});

describe("recovery network cases (replaceTarget on the fake gadget)", () => {
  it("commit succeeds and the reply is lost: the replay keeps its request id and applies once", async () => {
    const { server, noteId, a, first } = await setup();
    first.ctl.mode = "loseReply";
    a.store.updateObjects([{ id: noteId, patch: { x: 111 } }]);
    await settle(50);
    expect(server.objects[noteId].x).toBe(111);
    expect(a.store.getState().pendingCount).toBe(1);
    const second = stub(server);
    a.store.replaceTarget(second.gadget);
    await settle(200);
    expect(second.ctl.sent).toHaveLength(1);
    expect(second.ctl.sent[0]).toEqual(first.ctl.sent[0]);
    expect(server.history).toHaveLength(1);
    expectSettled(a.store, server);
  });

  it("the request never reaches the server: the replay applies it exactly once", async () => {
    const { server, noteId, a, first } = await setup();
    first.ctl.mode = "loseRequest";
    a.store.updateObjects([{ id: noteId, patch: { text: "Arrives late" } }]);
    await settle(50);
    expect(server.objects[noteId].text).toBe("Seed");
    const second = stub(server);
    a.store.replaceTarget(second.gadget);
    await settle(200);
    expect(second.ctl.sent[0].requestId).toBe(first.ctl.sent[0].requestId);
    expect(server.objects[noteId].text).toBe("Arrives late");
    expect(server.history).toHaveLength(1);
    expectSettled(a.store, server);
  });

  it("the operation broadcast arrives before the request result", async () => {
    const { server, noteId, a } = await setup({ latency: 30, eventLatency: 1 });
    const flashes = [];
    a.store.subscribe((_s, c) => { if (c.kind === "flash") flashes.push(c); });
    a.store.updateObjects([{ id: noteId, patch: { x: 222, text: "Echo first" } }]);
    await settle(40); // echo in, result not yet
    expect(a.store.getState()).toMatchObject({ connection: "saving", pendingCount: 1 });
    expect(a.store.getState().board.objects[noteId]).toMatchObject({ x: 222, text: "Echo first" });
    await settle(100);
    expectSettled(a.store, server);
    expect(server.history).toHaveLength(1);
    expect(flashes).toEqual([]);
  });

  it("a restart between subscribe registration and the snapshot response", async () => {
    const { server, noteId, a } = await setup({ latency: 30 });
    server.disposeSubscriber(a.clientId); // triggers a re-subscribe
    await settle(40); // the server has registered it; the snapshot reply is in transit
    expect(server.subscribers.has(a.clientId)).toBe(true);
    a.store.updateObjects([{ id: noteId, patch: { text: "Queued meanwhile" } }]);
    server.restart();
    expect(a.store.getState()).toMatchObject({ connection: "reconnecting", pendingCount: 1, riskOfLoss: true });
    await settle(3000);
    expect(server.subscribers.has(a.clientId)).toBe(true);
    expect(server.objects[noteId].text).toBe("Queued meanwhile");
    expect(server.history).toHaveLength(1);
    expectSettled(a.store, server);
  });

  it("three consecutive target replacements keep the queue and apply every change once", async () => {
    const onUnrecoverable = vi.fn();
    const { server, noteId, a, first } = await setup({ onUnrecoverable });
    first.ctl.mode = "loseReply";
    a.store.updateObjects([{ id: noteId, patch: { x: 140 } }]);
    await settle(30);
    const t2 = stub(server);
    t2.ctl.mode = "hang"; // the host hands over a stub that never answers
    a.store.replaceTarget(t2.gadget);
    await settle(30);
    const [made] = a.store.createObjects([{ type: "sticky", text: "While reconnecting" }]);
    const t3 = stub(server);
    t3.ctl.mode = "reject"; // ... then one that fails outright
    a.store.replaceTarget(t3.gadget);
    await settle(30);
    const t4 = stub(server);
    a.store.replaceTarget(t4.gadget);
    await settle(500);
    const ids = [first, t2, t3, t4].flatMap((t) => t.ctl.sent).filter((r) => r.objectOps?.[0]?.id === noteId).map((r) => r.requestId);
    expect(new Set(ids).size).toBe(1);
    expect(server.history).toHaveLength(2);
    expect(server.objects[noteId].x).toBe(140);
    expect(server.objects[made].text).toBe("While reconnecting");
    expect(onUnrecoverable).not.toHaveBeenCalled();
    expectSettled(a.store, server);
  });

  it("an edited or deleted object conflicts while the client is reconnecting", async () => {
    const { server, noteId, a, first } = await setup();
    const moved = server.seed({ type: "rect", x: 100, y: 100 });
    const doomed = server.seed({ type: "rect", x: 500, y: 0 });
    // Load the new objects before the connection dies.
    server.disposeSubscriber(a.clientId);
    await settle(100);
    const flashes = new Set();
    a.store.subscribe((_s, c) => { if (c.kind === "flash") for (const id of c.objects) flashes.add(id); });
    first.ctl.mode = "hang";
    a.store.updateObjects([{ id: noteId, patch: { text: "Mine" } }]); // goes out on the dead stub
    a.store.updateObjects([{ id: moved, patch: { x: 110 } }]); // +10, queued
    a.store.updateObjects([{ id: doomed, patch: { text: "Too late" } }]);
    await settle(20);
    // Meanwhile others change the same objects.
    const v = (id) => server.objects[id].version;
    server.doApply({ senderId: "agent", objectOps: [
      { op: "update", id: noteId, baseVersion: v(noteId), patch: { text: "Theirs" } },
      { op: "update", id: moved, baseVersion: v(moved), patch: { x: 120 } }, // +20
      { op: "delete", id: doomed, baseVersion: v(doomed) },
    ] });
    a.store.replaceTarget(stub(server).gadget);
    await settle(1000);
    expect(server.objects[noteId].text).toBe("Theirs"); // text clash: theirs kept
    expect(server.objects[moved].x).toBe(130); // both nudges kept
    expect(server.objects[doomed]).toBeUndefined();
    expect([...flashes].sort()).toEqual([noteId, doomed].sort());
    expectSettled(a.store, server);
  });

  it("a facet restart during a queued edit reconnects in place and applies the edit at most once", async () => {
    const { server, noteId, a } = await setup({ latency: 30 });
    a.store.updateObjects([{ id: noteId, patch: { x: 333 } }]);
    await settle(45); // committed, result in flight
    server.restart();
    a.store.replaceTarget(server.connect()); // the host hands over a fresh stub
    await settle(300);
    expect(server.history).toHaveLength(1);
    expectSettled(a.store, server);
  });
});
