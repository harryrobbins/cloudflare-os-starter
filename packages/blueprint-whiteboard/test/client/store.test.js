// Store tests against a scripted fake gadget (test/client/fake-gadget.js).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, PRESENCE_HEARTBEAT_MS, PRESENCE_SEND_MS, PRESENCE_STALE_MS } from "../../src/shared/protocol.js";
import { FakeServer, fakeId, settle, startStore } from "./helpers.js";

// Captured before fake timers replace the clocks.
const realHrtime = process.hrtime.bigint.bind(process.hrtime);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A board with one sticky (and optionally more objects), and `n` stores. */
async function setup({ n = 2, latency = 5, eventLatency = undefined, sticky = {}, seed = undefined } = {}) {
  const server = new FakeServer({ latency, eventLatency });
  const noteId = server.seed({ type: "sticky", x: 100, y: 100, text: "Seed", ...sticky });
  const extra = seed ? seed(server, noteId) : {};
  const clients = [];
  for (let i = 0; i < n; i++) clients.push(await startStore(server, "user" + i));
  await settle();
  return { server, noteId, clients, ...extra };
}

function opsFrom(server, clientId) {
  return server.callsOf("applyOperation").filter((c) => c.args[0].senderId === clientId);
}

const kinds = (client, kind) => client.changes.filter((c) => c.change.kind === kind);

describe("optimistic apply and acknowledgement", () => {
  it("creates optimistically, fills id, z and createdBy, and converges after the ack", async () => {
    const { server, noteId, clients: [a, b] } = await setup({ latency: 20 });
    const [id] = a.store.createObjects([{ type: "rect", x: 10, y: 20, text: "Box" }]);
    const local = a.store.getState().board.objects[id];
    expect(local).toMatchObject({ id, type: "rect", x: 10, y: 20, text: "Box", createdBy: "user0", version: 0 });
    expect(local.z > server.objects[noteId].z).toBe(true);
    expect(a.store.getState().pending).toBe(1);
    expect(kinds(a, "objects").at(-1).change).toEqual({ kind: "objects", objects: [id] });
    expect(a.changes.at(-1).change).toEqual({ kind: "undo" });
    await settle(200);
    expect(server.objects[id]).toMatchObject({ type: "rect", text: "Box", version: 1, z: local.z });
    for (const c of [a, b]) {
      expect(c.store.getState().board.objects).toEqual(server.board().objects);
      expect(c.store.getState().pending).toBe(0);
    }
  });

  it("updates optimistically; the echo and the ack are applied once, in either order", async () => {
    for (const eventLatency of [1, 80]) {
      const { server, noteId, clients: [a] } = await setup({ n: 1, latency: 20, eventLatency });
      const seen = [];
      a.store.subscribe((state) => seen.push(state.board.objects[noteId].x));
      a.store.updateObjects([{ id: noteId, patch: { x: 150 } }]);
      await settle(5);
      a.store.updateObjects([{ id: noteId, patch: { x: 180 } }]);
      await settle(500);
      const first180 = seen.indexOf(180);
      expect(seen.slice(0, first180).every((x) => x === 150)).toBe(true);
      expect(seen.slice(first180).every((x) => x === 180)).toBe(true);
      expect(a.store.getState().board.objects[noteId]).toEqual(server.objects[noteId]);
      const ids = a.store.getState().history.map((h) => h.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(2);
    }
  });

  it("keeps object identity for untouched objects and for no-op echoes", async () => {
    const { server, noteId, clients: [a, b] } = await setup({ latency: 10, eventLatency: 40 });
    const other = server.seed({ type: "rect" });
    await b.store; // no-op
    a.store.updateObjects([{ id: noteId, patch: { text: "x" } }]);
    await settle(1);
    const before = a.store.getState().board.objects;
    await settle(25); // ack arrived
    const afterAck = a.store.getState().board.objects[noteId];
    const count = kinds(a, "objects").length;
    await settle(100); // echo arrived
    expect(kinds(a, "objects").length).toBe(count);
    expect(a.store.getState().board.objects[noteId]).toBe(afterAck);
    expect(a.store.getState().board.objects).toBe(before);
    expect(other).toBeTruthy();
  });

  it("ignores updates of unknown ids and patches that change nothing", async () => {
    const { server, noteId, clients: [a] } = await setup({ n: 1 });
    a.store.updateObjects([{ id: fakeId(), patch: { x: 1 } }, { id: noteId, patch: { x: 100, text: "Seed" } }]);
    await settle(100);
    expect(opsFrom(server, a.clientId)).toHaveLength(0);
    expect(a.store.getState().canUndo).toBe(false);
  });

  it("cleans patches with the protocol sanitisers so rounding never differs from the server", async () => {
    const { server, noteId, clients: [a] } = await setup({ n: 1 });
    a.store.updateObjects([{ id: noteId, patch: { x: 10.123456, style: { fill: "#ABCDEF", bogus: 1 } } }]);
    expect(a.store.getState().board.objects[noteId]).toMatchObject({ x: 10.12, style: { fill: "#abcdef" } });
    await settle(100);
    expect(a.store.getState().board.objects[noteId]).toEqual(server.objects[noteId]);
  });

  it("sets and syncs title and background (last writer wins)", async () => {
    const { server, clients: [a, b] } = await setup();
    a.store.setStructure({ title: "  Plan  ", background: "grid" });
    expect(a.store.getState().board).toMatchObject({ title: "Plan", background: "grid" });
    expect(kinds(a, "structure")).toHaveLength(1);
    b.store.setStructure({ background: "plain" });
    await settle(200);
    expect(server).toMatchObject({ title: "Plan", background: "plain" });
    for (const c of [a, b]) expect(c.store.getState().board).toMatchObject({ title: "Plan", background: "plain" });
  });
});

describe("queue", () => {
  it("sends one request at a time and coalesces unsent updates of the same object", async () => {
    const { server, noteId, clients: [a] } = await setup({ n: 1, latency: 20 });
    a.store.updateObjects([{ id: noteId, patch: { x: 1 } }]); // sent at once
    a.store.updateObjects([{ id: noteId, patch: { x: 2 } }]);
    a.store.updateObjects([{ id: noteId, patch: { y: 3 } }]);
    a.store.updateObjects([{ id: noteId, patch: { style: { fill: "#ff0000" } } }]);
    a.store.updateObjects([{ id: noteId, patch: { style: { stroke: "#00ff00" } } }]);
    expect(a.store.getState().pending).toBe(2);
    await settle(300);
    const sends = opsFrom(server, a.clientId).map((c) => c.args[0].objectOps);
    expect(sends).toHaveLength(2);
    expect(sends[1][0].patch).toEqual({ x: 2, y: 3, style: { fill: "#ff0000", stroke: "#00ff00" } });
    expect(server.objects[noteId]).toMatchObject({ x: 2, y: 3, style: { fill: "#ff0000", stroke: "#00ff00" } });
  });

  it("merges an update into an unsent create, and cancels create + delete", async () => {
    const { server, noteId, clients: [a] } = await setup({ n: 1, latency: 20 });
    a.store.updateObjects([{ id: noteId, patch: { x: 1 } }]); // in flight
    const [x] = a.store.createObjects([{ type: "sticky", text: "one" }]);
    a.store.updateObjects([{ id: x, patch: { text: "two" } }]);
    const [y] = a.store.createObjects([{ type: "sticky" }]);
    a.store.deleteObjects([y]);
    expect(a.store.getState().pending).toBe(2);
    expect(a.store.getState().board.objects[y]).toBeUndefined();
    await settle(300);
    const sends = opsFrom(server, a.clientId).map((c) => c.args[0].objectOps);
    expect(sends).toHaveLength(2);
    expect(sends[1]).toHaveLength(1);
    expect(sends[1][0]).toMatchObject({ op: "create", object: { id: x, text: "two" } });
    expect(server.objects[y]).toBeUndefined();
  });

  it("batches ops on distinct objects up to LIMITS.opsPerRequest and keeps creates before references", async () => {
    const { server, noteId, clients: [a] } = await setup({ n: 1, latency: 20 });
    a.store.updateObjects([{ id: noteId, patch: { x: 1 } }]); // in flight
    const n = LIMITS.opsPerRequest + 5;
    const ids = a.store.createObjects(Array.from({ length: n }, (_, i) => ({ type: "sticky", x: i })));
    const [frame] = a.store.createObjects([{ type: "frame" }]);
    const [member] = a.store.createObjects([{ type: "sticky", frameId: frame }]);
    const [conn] = a.store.createObjects([{ type: "connector", from: frame, to: member }]);
    expect(ids).toHaveLength(n);
    await settle(500);
    const sends = opsFrom(server, a.clientId).map((c) => c.args[0].objectOps);
    expect(sends.map((s) => s.length)).toEqual([1, LIMITS.opsPerRequest, 8]);
    const last = sends[2].map((o) => o.object.id);
    expect(last.indexOf(frame)).toBeLessThan(last.indexOf(member));
    expect(last.indexOf(member)).toBeLessThan(last.indexOf(conn));
    expect(server.objects[member].frameId).toBe(frame);
    expect(server.objects[conn]).toMatchObject({ from: frame, to: member });
    expect(Object.keys(server.objects)).toHaveLength(n + 4);
    expect(a.store.getState().board.objects).toEqual(server.board().objects);
  });

  it("never merges an update across a later create it refers to", async () => {
    const { server, noteId, clients: [a] } = await setup({ n: 1, latency: 20 });
    const [other] = a.store.createObjects([{ type: "rect" }]); // in flight
    a.store.updateObjects([{ id: noteId, patch: { x: 5 } }]);
    const [frame] = a.store.createObjects([{ type: "frame" }]);
    a.store.updateObjects([{ id: noteId, patch: { frameId: frame } }]);
    await settle(400);
    expect(server.objects[noteId]).toMatchObject({ x: 5, frameId: frame });
    expect(a.store.getState().lastError).toBeNull();
    expect(other).toBeTruthy();
  });
});

describe("replays", () => {
  it("replays a request whose result was lost verbatim, with the same requestId and base versions", async () => {
    const { server, noteId, clients: [a, b] } = await setup({ latency: 30 });
    a.store.updateObjects([{ id: noteId, patch: { x: 111 } }]);
    await settle(45); // applied on the server, result in transit
    expect(server.objects[noteId].x).toBe(111);
    server.restart();
    await settle(1000);
    expect(a.store.getState().connection).toBe("live");
    const sends = opsFrom(server, a.clientId);
    expect(sends).toHaveLength(2);
    expect(sends[1].args[0]).toEqual(sends[0].args[0]);
    expect(sends[0].args[0].objectOps[0].baseVersion).toBe(1);
    expect(server.history).toHaveLength(1);
    expect(a.store.getState().lastError).toBeNull();
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().board.objects[noteId]).toEqual(server.objects[noteId]);
    expect(b).toBeTruthy();
  });

  it("a replayed update conflicts with a concurrent edit instead of overwriting it", async () => {
    const { server, noteId, clients: [a] } = await setup({ latency: 30 });
    a.store.updateObjects([{ id: noteId, patch: { text: "From A" } }]);
    await settle(10);
    server.restart(); // A's request never arrives
    // Meanwhile someone else edits the same field against the same base.
    const direct = server.doApply({ senderId: "agent", objectOps: [{ op: "update", id: noteId, baseVersion: 1, patch: { text: "From B" } }] });
    expect(direct.status).toBe("applied");
    await settle(5000);
    const sends = opsFrom(server, a.clientId).map((c) => c.args[0]);
    expect(sends[1]).toEqual(sends[0]);
    expect(server.objects[noteId].text).toBe("From B");
    expect(a.store.getState().board.objects[noteId].text).toBe("From B");
    expect(kinds(a, "flash").flatMap((c) => c.change.objects)).toContain(noteId);
    expect(a.store.getState().pending).toBe(0);
  });

  it("handles a duplicate result for a request it had already sent (no double apply, no false error)", async () => {
    const { server, noteId, clients: [a] } = await setup({ n: 1, latency: 30 });
    a.store.deleteObjects([noteId]);
    await settle(45);
    server.restart();
    await settle(2000);
    expect(server.objects[noteId]).toBeUndefined();
    expect(a.store.getState().board.objects[noteId]).toBeUndefined();
    expect(a.store.getState().lastError).toBeNull();
    expect(a.store.getState().pending).toBe(0);
  });

  it("does not resurrect a created object deleted while its result was lost", async () => {
    const { server, clients: [a] } = await setup({ n: 1, latency: 30 });
    const [x] = a.store.createObjects([{ type: "sticky" }]);
    await settle(45);
    server.doApply({ senderId: "agent", objectOps: [{ op: "delete", id: x, baseVersion: 1 }] });
    server.restart();
    await settle(3000);
    expect(server.objects[x]).toBeUndefined();
    expect(a.store.getState().board.objects[x]).toBeUndefined();
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().lastError).toBeNull();
  });

  it("drops a change whose request keeps failing, rolls back and reports it", async () => {
    const { server, noteId, clients: [a] } = await setup({ n: 1 });
    for (let i = 0; i < 10; i++) server.failNext("applyOperation");
    a.store.updateObjects([{ id: noteId, patch: { text: "Doomed" } }]);
    await settle(10000);
    expect(opsFrom(server, a.clientId)).toHaveLength(4);
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().board.objects[noteId].text).toBe("Seed");
    expect(a.store.getState().lastError).toMatch(/could not be saved/);
    expect(a.store.getState().connection).toBe("live");
  });

  it("rolls back a change the server rejects with an error", async () => {
    const { server, noteId, clients: [a] } = await setup({ n: 1 });
    const [pen] = a.store.createObjects([{ type: "pen" }]); // no points: invalid_op
    expect(a.store.getState().board.objects[pen]).toBeDefined();
    await settle(200);
    expect(a.store.getState().board.objects[pen]).toBeUndefined();
    expect(a.store.getState().lastError).toMatch(/invalid_op/);
    expect(server.objects[noteId]).toBeDefined();
  });

  it("gives every request a requestId the server accepts, whatever the clientId", async () => {
    const server = new FakeServer({ latency: 5 });
    const note = server.seed({ type: "sticky" });
    const a = await startStore(server, "a", { clientId: "weird id/with spaces " + "x".repeat(80) });
    a.store.updateObjects([{ id: note, patch: { x: 1 } }]);
    await settle(100);
    a.store.updateObjects([{ id: note, patch: { x: 2 } }]);
    await settle(100);
    const ids = opsFrom(server, a.store.getState().viewer.clientId).map((c) => c.args[0].requestId);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9:_-]{1,64}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("conflicts", () => {
  /**
   * B's change lands first while A's events are held, then A sends a change against the old
   * version. Returns once A's conflict has been handled and retried.
   */
  async function clash(bPatch, aPatch, { sticky = {} } = {}) {
    const ctx = await setup({ sticky });
    const { server, noteId, clients: [a, b] } = ctx;
    server.holdEvents(a.clientId);
    b.store.updateObjects([{ id: noteId, patch: bPatch }]);
    await settle(100);
    a.store.updateObjects([{ id: noteId, patch: aPatch }]);
    await settle(300);
    server.releaseEvents(a.clientId);
    await settle(100);
    return ctx;
  }

  it("both nudge the same note: my delta is re-applied on top of theirs", async () => {
    const { server, noteId, clients: [a, b] } = await clash({ x: 120 }, { x: 110 });
    expect(server.objects[noteId].x).toBe(130);
    for (const c of [a, b]) expect(c.store.getState().board.objects[noteId]).toEqual(server.objects[noteId]);
    expect(opsFrom(server, a.clientId)).toHaveLength(2);
    expect(kinds(a, "flash")).toHaveLength(0);
    expect(a.store.getState().pending).toBe(0);
  });

  it("rebases size and rotation deltas, clamping sizes and wrapping rotation", async () => {
    const { server, noteId } = await clash({ w: 150, rot: 350 }, { w: 40, rot: 20 }, { sticky: { w: 200, h: 200 } });
    expect(server.objects[noteId].w).toBe(1); // 150 + (40 - 200), clamped to LIMITS.sizeMin
    expect(server.objects[noteId].rot).toBe(10); // 350 + 20 mod 360
  });

  it("keeps theirs for text and style keys they changed, flashes, and keeps my other fields", async () => {
    const { server, noteId, clients: [a, b] } = await clash(
      { text: "Theirs", style: { fill: "#ff0000" } },
      { text: "Mine", x: 500, style: { fill: "#00ff00", textColor: "#123456" } },
    );
    expect(server.objects[noteId]).toMatchObject({
      text: "Theirs", x: 500, style: { fill: "#ff0000", textColor: "#123456" },
    });
    expect(kinds(a, "flash").map((c) => c.change.objects)).toEqual([[noteId]]);
    expect(kinds(b, "flash")).toHaveLength(0);
    for (const c of [a, b]) expect(c.store.getState().board.objects[noteId]).toEqual(server.objects[noteId]);
  });

  it("keeps mine for z and frameId even when they changed them", async () => {
    const { server, noteId } = await clash({ z: "a5" }, { z: "a3" });
    expect(server.objects[noteId].z).toBe("a3");
  });

  it("drops an update that equals theirs without a retry or flash", async () => {
    const { server, noteId, clients: [a] } = await clash({ text: "Same" }, { text: "Same" });
    expect(opsFrom(server, a.clientId)).toHaveLength(1);
    expect(kinds(a, "flash")).toHaveLength(0);
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().lastError).toBeNull();
    expect(server.objects[noteId].text).toBe("Same");
  });

  it("drops an update of an object someone deleted and flashes it", async () => {
    const { server, noteId, clients: [a, b] } = await setup();
    server.holdEvents(a.clientId);
    b.store.deleteObjects([noteId]);
    await settle(100);
    a.store.updateObjects([{ id: noteId, patch: { text: "Mine" } }]);
    await settle(300);
    expect(kinds(a, "flash").flatMap((c) => c.change.objects)).toEqual([noteId]);
    expect(a.store.getState().board.objects[noteId]).toBeUndefined();
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().lastError).toBeNull();
  });

  it("retries a delete that conflicts (delete wins)", async () => {
    const { server, noteId, clients: [a, b] } = await setup();
    server.holdEvents(a.clientId);
    b.store.updateObjects([{ id: noteId, patch: { text: "edit" } }]);
    await settle(100);
    a.store.deleteObjects([noteId]);
    await settle(300);
    expect(server.objects[noteId]).toBeUndefined();
    expect(opsFrom(server, a.clientId)).toHaveLength(2);
    server.releaseEvents(a.clientId);
    await settle(100);
    expect(a.store.getState().board.objects[noteId]).toBeUndefined();
    expect(b.store.getState().board.objects[noteId]).toBeUndefined();
  });

  it("gives up after MAX_CONFLICT_RETRIES with a rollback and an error", async () => {
    const { server, noteId, clients: [a] } = await setup({ n: 1 });
    let n = 0;
    server.beforeApply = (req) => {
      if (req.senderId !== a.clientId) return;
      const o = server.objects[noteId];
      server.objects[noteId] = { ...o, x: o.x + 1, version: o.version + 1 };
      n++;
    };
    a.store.updateObjects([{ id: noteId, patch: { x: 1000 } }]);
    await settle(1000);
    expect(n).toBe(6);
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().lastError).toMatch(/kept changing/);
    server.beforeApply = null;
  });

  it("a second unsent drag of the same object follows the rebase", async () => {
    const { server, noteId, clients: [a, b] } = await setup({ latency: 20 });
    server.holdEvents(a.clientId);
    b.store.updateObjects([{ id: noteId, patch: { x: 120 } }]); // +20, lands first
    await settle(200);
    a.store.updateObjects([{ id: noteId, patch: { x: 110 } }]); // +10, sent against version 1
    a.store.updateObjects([{ id: noteId, patch: { x: 115 } }]); // queued behind it: +15 in total
    await settle(500);
    server.releaseEvents(a.clientId);
    await settle(200);
    expect(server.objects[noteId].x).toBe(135);
    expect(a.store.getState().board.objects[noteId]).toEqual(server.objects[noteId]);
  });
});

describe("connectors", () => {
  it("hides attached connectors optimistically when an endpoint is deleted, and the server agrees", async () => {
    const { server, noteId, other, conn, clients: [a, b] } = await setup({
      latency: 20,
      seed: (srv, note) => {
        const o = srv.seed({ type: "rect", x: 400 });
        return { other: o, conn: srv.seed({ type: "connector", from: note, to: o }) };
      },
    });
    const c = await startStore(server, "c");
    c.store.deleteObjects([noteId]);
    expect(c.store.getState().board.objects[conn]).toBeUndefined();
    const change = kinds(c, "objects").at(-1).change;
    expect(change.objects.sort()).toEqual([noteId, conn].sort());
    await settle(300);
    expect(server.objects[conn]).toBeUndefined();
    for (const s of [a, b, c]) {
      expect(s.store.getState().board.objects[conn]).toBeUndefined();
      expect(s.store.getState().board.objects[other]).toBeDefined();
    }
  });

  it("hides a pending connector whose endpoint someone else deleted", async () => {
    const { server, noteId, other, clients: [a, b] } = await setup({
      latency: 20, seed: (srv) => ({ other: srv.seed({ type: "rect" }) }),
    });
    // A's events are late, so A creates a connector to an object B has already deleted.
    server.holdEvents(a.clientId);
    b.store.deleteObjects([other]);
    await settle(100);
    expect(server.objects[other]).toBeUndefined();
    a.store.createObjects([{ type: "connector", from: noteId, to: other }]);
    await settle(200);
    server.releaseEvents(a.clientId);
    await settle(200);
    expect(Object.values(a.store.getState().board.objects).filter((o) => o.type === "connector")).toHaveLength(0);
    expect(a.store.getState().pending).toBe(0);
  });
});

describe("undo and redo", () => {
  it("undoes and redoes a create, an update and a reorder", async () => {
    const { server, noteId, clients: [a] } = await setup({ n: 1 });
    const [x] = a.store.createObjects([{ type: "rect", text: "r" }]);
    expect(a.store.getState()).toMatchObject({ canUndo: true, canRedo: false });
    a.store.updateObjects([{ id: x, patch: { x: 50, style: { fill: "#ff0000" } } }]);
    a.store.reorder([noteId], "front");
    await settle(200);
    expect(server.objects[noteId].z > server.objects[x].z).toBe(true);
    a.store.undo(); // reorder
    await settle(200);
    expect(server.objects[noteId].z < server.objects[x].z).toBe(true);
    a.store.undo(); // update
    await settle(200);
    expect(server.objects[x]).toMatchObject({ x: 0, style: { fill: "#ffffff" } });
    a.store.undo(); // create
    await settle(200);
    expect(server.objects[x]).toBeUndefined();
    expect(a.store.getState()).toMatchObject({ canUndo: false, canRedo: true });
    a.store.redo();
    a.store.redo();
    await settle(300);
    expect(server.objects[x]).toMatchObject({ x: 50, style: { fill: "#ff0000" } });
    expect(a.store.getState().board.objects).toEqual(server.board().objects);
    // A new change clears redo.
    a.store.updateObjects([{ id: x, patch: { text: "new" } }]);
    expect(a.store.getState().canRedo).toBe(false);
    expect(kinds(a, "undo").length).toBeGreaterThan(0);
  });

  it("undo of a delete restores the object and its connectors with the same ids", async () => {
    const { server, noteId, other, frame, conn, clients: [a, b] } = await setup({
      seed: (srv, note) => {
        const o = srv.seed({ type: "rect", x: 400 });
        const f = srv.seed({ type: "frame", x: -100, y: -100 });
        srv.objects[note] = { ...srv.objects[note], frameId: f };
        return { other: o, frame: f, conn: srv.seed({ type: "connector", from: note, to: o, text: "label" }) };
      },
    });
    const c = await startStore(server, "c");
    expect(other).toBeTruthy();
    const before = structuredClone(server.objects);
    c.store.deleteObjects([noteId]);
    await settle(200);
    expect(server.objects[conn]).toBeUndefined();
    c.store.undo();
    expect(c.store.getState().board.objects[conn]).toBeDefined();
    await settle(300);
    for (const id of [noteId, conn]) {
      const { version, createdAt, updatedAt, createdBy, ...rest } = server.objects[id];
      const { version: _v, createdAt: _c, updatedAt: _u, createdBy: _b, ...old } = before[id];
      expect(rest).toEqual(old);
    }
    expect(server.objects[noteId].frameId).toBe(frame);
    c.store.redo();
    await settle(300);
    expect(server.objects[noteId]).toBeUndefined();
    expect(server.objects[conn]).toBeUndefined();
    for (const s of [a, b, c]) expect(s.store.getState().board.objects).toEqual(server.board().objects);
  });

  it("skips parts that no longer apply", async () => {
    const { server, noteId, clients: [a, b] } = await setup();
    a.store.updateObjects([{ id: noteId, patch: { text: "A" } }]);
    await settle(100);
    b.store.deleteObjects([noteId]);
    await settle(100);
    a.store.undo();
    await settle(100);
    expect(server.objects[noteId]).toBeUndefined();
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().canRedo).toBe(false);
  });

  it("caps the undo stack at 100 steps", async () => {
    const { noteId, clients: [a] } = await setup({ n: 1 });
    for (let i = 0; i < 120; i++) a.store.updateObjects([{ id: noteId, patch: { x: i + 1 } }]);
    let n = 0;
    while (a.store.getState().canUndo) { a.store.undo(); n++; }
    expect(n).toBe(100);
    expect(a.store.getState().board.objects[noteId].x).toBe(20);
  });
});

describe("reorder", () => {
  it("moves a group above or below its stacking group, keeping relative order; frames separately", async () => {
    const server = new FakeServer({ latency: 5 });
    const ids = ["a0", "a1", "a2", "a3"].map((z) => server.seed({ type: "sticky", z }));
    const frames = ["a0", "a5"].map((z) => server.seed({ type: "frame", z }));
    const a = await startStore(server, "a");
    a.store.reorder([ids[2], ids[0], frames[0]], "front");
    const objs = a.store.getState().board.objects;
    const zs = (list) => list.map((id) => objs[id].z);
    expect(zs([ids[0]])[0] > objs[ids[3]].z).toBe(true);
    expect(objs[ids[2]].z > objs[ids[0]].z).toBe(true);
    expect(objs[frames[0]].z > objs[frames[1]].z).toBe(true);
    a.store.reorder([ids[3], ids[1]], "back");
    const o2 = a.store.getState().board.objects;
    expect(o2[ids[1]].z < o2[ids[3]].z).toBe(true);
    expect(o2[ids[3]].z < o2[ids[0]].z).toBe(true);
    await settle(200);
    expect(a.store.getState().board.objects).toEqual(server.board().objects);
  });
});

describe("history", () => {
  it("loads history, appends live entries once, and undoes an entry on the server", async () => {
    const { server, noteId, clients: [a, b] } = await setup();
    a.store.updateObjects([{ id: noteId, patch: { x: 999 } }]);
    await settle(100);
    const history = await Promise.all([b.store.loadHistory(10), settle(100)]).then(([h]) => h);
    expect(history).toHaveLength(1);
    await Promise.all([b.store.undoHistory(history[0].id), settle(100)]);
    await settle(100);
    expect(server.objects[noteId].x).toBe(100);
    for (const c of [a, b]) {
      expect(c.store.getState().board.objects[noteId]).toEqual(server.objects[noteId]);
      expect(c.store.getState().history).toHaveLength(2);
    }
  });
});

describe("presence", () => {
  it("throttles sends to one per PRESENCE_SEND_MS and always sends the latest value", async () => {
    const { server, clients: [a, b] } = await setup();
    await settle(100);
    const sends = () => server.callsOf("updatePresence").filter((c) => c.args[0].clientId === b.clientId);
    const before = sends().length;
    b.store.setPresence({ cursor: { x: 1, y: 1 } }); // leading edge
    b.store.setPresence({ cursor: { x: 2, y: 2 } });
    b.store.setPresence({ cursor: { x: 3, y: 3 }, selection: [fakeId()] });
    await settle(0);
    expect(sends().length - before).toBe(1);
    await settle(PRESENCE_SEND_MS);
    expect(sends().length - before).toBe(2); // trailing edge
    expect(sends().at(-1).args[0]).toMatchObject({ cursor: { x: 3, y: 3 }, session: expect.any(String) });
    await settle(100);
    const peer = a.store.getState().peers.get(b.clientId);
    expect(peer).toMatchObject({ name: "user1", cursor: { x: 3, y: 3 }, transforms: [], stroke: null });
    expect(kinds(a, "presence").at(-1).change).toEqual({ kind: "presence", peers: [b.clientId] });
    // flushPresence sends at once, even inside the throttle window.
    b.store.setPresence({ cursor: { x: 4, y: 4 } }); // leading edge
    await settle(15); // settled (5 ms each way)
    b.store.setPresence({ cursor: { x: 5, y: 5 } }); // would be trailing
    const mid = sends().length;
    b.store.flushPresence();
    await settle(0);
    expect(sends().length).toBe(mid + 1);
    expect(sends().at(-1).args[0].cursor).toEqual({ x: 5, y: 5 });
    await settle(100);
    expect(sends().length).toBe(mid + 1); // the flush replaced the trailing send
  });

  it("accepts arrays and single events, ignores its own id, handles leave", async () => {
    const { server, clients: [a, b] } = await setup();
    const cb = server.subscribers.get(a.clientId).callback;
    cb.presence([
      { type: "join", clientId: "p1", name: "P1", color: "#111111", cursor: null, viewport: null, selection: [], transforms: [], stroke: null, editingId: null, at: 0 },
      { type: "update", clientId: a.clientId, name: "me", color: "#000000", at: 0 },
      { type: "join", clientId: "p2", name: "P2", color: "#222222", at: 0 },
    ]);
    expect(kinds(a, "presence").at(-1).change.peers).toEqual(["p1", "p2"]);
    expect(a.store.getState().peers.has(a.clientId)).toBe(false);
    cb.presence({ type: "leave", clientId: "p1", at: 0 });
    expect(a.store.getState().peers.has("p1")).toBe(false);
    expect(a.store.getState().peers.get("p2")).toMatchObject({ selection: [], transforms: [] });
    b.store.dispose();
    await settle(100);
    expect(a.store.getState().peers.has(b.clientId)).toBe(false);
  });

  it("expires peers unseen for PRESENCE_STALE_MS", async () => {
    const { server, clients: [a, b] } = await setup();
    const c = await startStore(server, "c");
    await settle();
    expect(a.store.getState().peers.size).toBe(2);
    c.store.dispose();
    server.silentDrop(c.clientId);
    await settle(PRESENCE_STALE_MS + 1100);
    expect([...a.store.getState().peers.keys()]).toEqual([b.clientId]);
  });
});

describe("presence gating", () => {
  /** A store whose updatePresence calls are held until released. */
  async function slowPresence() {
    const server = new FakeServer({ latency: 5 });
    server.seed({ type: "sticky" });
    const real = server.connect();
    const held = [];
    let hold = false;
    const gadget = {
      ...real,
      updatePresence: (p) => {
        if (!hold) return real.updatePresence(p);
        return new Promise((resolve, reject) => held.push({ p: structuredClone(p), resolve, reject }));
      },
    };
    const a = await startStore(server, "a", { gadget });
    await settle(100);
    return { server, a, held, real, setHold: (v) => { hold = v; } };
  }

  it("keeps at most one updatePresence in flight and sends the latest state once it settles", async () => {
    const { a, held, real, setHold } = await slowPresence();
    setHold(true);
    a.store.setPresence({ cursor: { x: 1, y: 1 } });
    await settle(0);
    expect(held).toHaveLength(1);
    for (let i = 2; i <= 20; i++) {
      a.store.setPresence({ cursor: { x: i, y: i } });
      await settle(20);
    }
    a.store.flushPresence();
    await settle(PRESENCE_HEARTBEAT_MS + 100); // heartbeats skip while one is in flight
    expect(held).toHaveLength(1);
    expect(a.store.getState().connection).toBe("live");
    const first = held.shift();
    first.resolve(await Promise.all([real.updatePresence(first.p), settle(20)]).then(([r]) => r));
    await settle(PRESENCE_SEND_MS + 5);
    expect(held).toHaveLength(1);
    expect(held[0].p.cursor).toEqual({ x: 20, y: 20 });
    // Nothing further is dirty: settling it sends nothing more until presence changes.
    held.shift().resolve({ known: true, revision: 0 });
    await settle(200);
    expect(held).toHaveLength(0);
  });

  it("treats an updatePresence unsettled for PRESENCE_TIMEOUT_MS as failed and re-subscribes", async () => {
    const { server, a, held, setHold } = await slowPresence();
    const subscribes = () => server.callsOf("subscribe").length;
    const before = subscribes();
    setHold(true);
    a.store.setPresence({ cursor: { x: 1, y: 1 } });
    await settle(9900);
    expect(subscribes()).toBe(before);
    setHold(false);
    await settle(300);
    expect(subscribes()).toBe(before + 1);
    expect(a.store.getState().connection).toBe("live");
    // Sends resume once the stuck call is abandoned; its late result is ignored.
    a.store.setPresence({ cursor: { x: 2, y: 2 } });
    await settle(100);
    const sent = server.callsOf("updatePresence").at(-1).args[0];
    expect(sent.cursor).toEqual({ x: 2, y: 2 });
    held[0].resolve({ known: false, revision: 0 });
    await settle(100);
    expect(subscribes()).toBe(before + 1);
    a.store.dispose();
    await settle(100);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("restart recovery", () => {
  it("re-subscribes when the heartbeat reports known:false and catches up", async () => {
    const { server, noteId, clients: [a, b] } = await setup();
    server.restart();
    server.doApply({ senderId: "agent", objectOps: [{ op: "update", id: noteId, baseVersion: 1, patch: { x: 7 } }] });
    a.store.updateObjects([{ id: noteId, patch: { text: "queued" } }]);
    await settle(100);
    expect(b.store.getState().board.objects[noteId].x).toBe(100);
    await settle(PRESENCE_HEARTBEAT_MS + 1000);
    for (const s of [a.store, b.store]) {
      expect(s.getState().connection).toBe("live");
      expect(s.getState().board.objects[noteId]).toEqual(server.objects[noteId]);
    }
    expect(server.objects[noteId]).toMatchObject({ x: 7, text: "queued" });
    expect(server.subscribers.size).toBe(2);
  });

  it("resyncs when the heartbeat shows a revision gap", async () => {
    const { server, noteId, clients: [a, b] } = await setup();
    server.dropping.add(a.clientId);
    b.store.updateObjects([{ id: noteId, patch: { text: "Missed" } }]);
    await settle(100);
    expect(a.store.getState().board.objects[noteId].text).toBe("Seed");
    server.dropping.delete(a.clientId);
    await settle(PRESENCE_HEARTBEAT_MS + 1500);
    expect(a.store.getState().board.objects[noteId].text).toBe("Missed");
    expect(server.callsOf("subscribe").filter((c) => c.args[1]?.clientId === a.clientId || c.args[0]?.clientId === a.clientId)).toHaveLength(2);
  });

  it("re-subscribes when the current callback is disposed, backing off on failure", async () => {
    const { server, noteId, clients: [a, b] } = await setup();
    const subscribes = () => server.callsOf("subscribe").filter((c) => c.args[0].clientId === a.clientId).length;
    server.failNext("subscribe");
    server.disposeSubscriber(a.clientId);
    expect(a.store.getState().connection).toBe("reconnecting");
    await settle(100);
    expect(subscribes()).toBe(2);
    b.store.updateObjects([{ id: noteId, patch: { text: "While away" } }]);
    await settle(600);
    expect(subscribes()).toBe(3);
    expect(a.store.getState().connection).toBe("live");
    expect(a.store.getState().board.objects[noteId].text).toBe("While away");
  });

  it("ignores events and dispose from a superseded subscription (generation guard)", async () => {
    const { server, clients: [a] } = await setup({ n: 1 });
    const old = server.subscribers.get(a.clientId).callback;
    server.disposeSubscriber(a.clientId);
    await settle(100);
    expect(a.store.getState().connection).toBe("live");
    const subscribes = server.callsOf("subscribe").length;
    old[Symbol.dispose](); // the server disposing the replaced stub
    old.operation({ type: "snapshot", board: { ...server.board(), title: "bogus", objects: {} } });
    old.presence([{ type: "join", clientId: "ghost", name: "g", color: "#000000", at: 0 }]);
    await settle(100);
    expect(server.callsOf("subscribe").length).toBe(subscribes);
    expect(a.store.getState().board.title).toBe("Board");
    expect(a.store.getState().peers.has("ghost")).toBe(false);
  });

  it("keeps its session across re-subscribes and takes a new clientId when its id is taken", async () => {
    const { server, clients: [a] } = await setup({ n: 1 });
    const session = server.subscribers.get(a.clientId).session;
    server.restart();
    await settle(PRESENCE_HEARTBEAT_MS + 1000);
    const subs = server.callsOf("subscribe").filter((c) => c.args[0].clientId === a.clientId);
    expect(subs.at(-1).args[0].session).toBe(session);
    const c = await startStore(server, "c", { clientId: a.clientId });
    const cId = c.store.getState().viewer.clientId;
    expect(cId).not.toBe(a.clientId);
    expect(c.changes.length + 1).toBeGreaterThan(0);
    expect(server.subscribers.has(cId)).toBe(true);
  });
});

describe("unrecoverable connection", () => {
  it("calls onUnrecoverable once after 3 failed subscribes in a row, and keeps retrying", async () => {
    const server = new FakeServer({ latency: 5 });
    const onUnrecoverable = vi.fn();
    const a = await startStore(server, "a", { onUnrecoverable });
    for (let i = 0; i < 4; i++) server.failNext("subscribe");
    server.disposeSubscriber(a.clientId);
    await settle(100);
    expect(onUnrecoverable).not.toHaveBeenCalled();
    await settle(1500);
    expect(onUnrecoverable).toHaveBeenCalledTimes(1);
    await settle(10000);
    expect(onUnrecoverable).toHaveBeenCalledTimes(1);
    expect(a.store.getState().connection).toBe("live");
  });

  it("calls it when the connection stays non-live for 8 s with calls hanging", async () => {
    const server = new FakeServer({ latency: 5 });
    const real = server.connect();
    let hang = false;
    const gadget = { ...real, subscribe: (...args) => (hang ? new Promise(() => {}) : real.subscribe(...args)) };
    const onUnrecoverable = vi.fn();
    const a = await startStore(server, "a", { gadget, onUnrecoverable });
    hang = true;
    server.disposeSubscriber(a.clientId);
    await settle(7900);
    expect(onUnrecoverable).not.toHaveBeenCalled();
    await settle(200);
    expect(onUnrecoverable).toHaveBeenCalledTimes(1);
  });
});

describe("dispose", () => {
  it("stops every timer and leaves presence", async () => {
    const { server, clients: [a] } = await setup({ n: 1 });
    a.store.setPresence({ cursor: { x: 1, y: 2 } });
    a.store.setPresence({ cursor: null });
    a.store.dispose();
    await settle(100);
    expect(server.callsOf("leavePresence")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    const presence = server.callsOf("updatePresence").length;
    await settle(PRESENCE_HEARTBEAT_MS * 3);
    expect(server.callsOf("updatePresence").length).toBe(presence);
  });
});

describe("performance", () => {
  it("applies 1,000 remote single-object updates on a 5,000-object board in well under a second", async () => {
    const server = new FakeServer({ latency: 0 });
    const ids = [];
    for (let i = 0; i < 4000; i++) ids.push(server.seed({ type: "sticky", x: i, z: "a" + (i % 10) }));
    for (let i = 0; i < 1000; i++) server.seed({ type: "connector", from: ids[i], to: ids[i + 1], z: "aZ" });
    const a = await startStore(server, "a");
    // Some local pending state to overlay.
    a.store.updateObjects(ids.slice(0, 50).map((id) => ({ id, patch: { y: 5 } })));
    const cb = server.subscribers.get(a.clientId).callback;
    const events = [];
    for (let i = 0; i < 1000; i++) {
      const id = ids[(i * 7) % 4000];
      const o = server.objects[id];
      events.push({
        type: "operation", senderId: "other", revision: server.revision + 1 + i,
        upserts: [{ ...o, x: o.x + 1, version: o.version + 1 + i }], deletes: [], structure: null, history: null, lastModified: i,
      });
    }
    let changes = 0;
    a.store.subscribe(() => { changes++; });
    const start = realHrtime();
    for (const e of events) cb.operation(e);
    const ms = Number(realHrtime() - start) / 1e6;
    expect(changes).toBe(1000);
    if (process.env.PERF_DEBUG) process.stderr.write(`1000 remote updates on 5000 objects: ${ms.toFixed(1)} ms\n`);
    expect(ms).toBeLessThan(250);
    expect(Object.keys(a.store.getState().board.objects)).toHaveLength(5000);
  });
});
