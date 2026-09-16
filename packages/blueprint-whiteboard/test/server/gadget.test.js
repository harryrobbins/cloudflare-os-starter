// Server tests in workerd: the Gadget Durable Object over real DO storage, RPC callbacks,
// presence and the ExportHandler. Storage persists between tests, so each test uses its own DO.
import { env, exports, RpcTarget } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { DoStorageRepository } from "../../src/server/do-repository.js";
import { ExportHandler } from "../../src/server/index.js";

class Callbacks extends RpcTarget {
  ops = [];
  /** @type {any[][]} one entry per presence() call */
  calls = [];
  disposed = false;
  operation(event) {
    this.ops.push(event);
  }
  presence(events) {
    this.calls.push(events);
  }
  get presences() {
    return this.calls.flat();
  }
  [Symbol.dispose]() {
    this.disposed = true;
  }
}

// A subscriber whose deliveries reject. (Exceptions thrown inside an RPC method are reported by
// the pool as unhandled errors, so the rejection comes from calling a method it lacks instead.)
class Dead extends RpcTarget {
  presence() {}
}

const idFor = (name) => env.GADGET.idFromName(name);
const fresh = () => {
  const name = crypto.randomUUID();
  return { name, stub: env.GADGET.get(idFor(name)), again: () => env.GADGET.get(idFor(name)) };
};
const objectId = () => "o_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);

async function withSticky(stub, object = { text: "Hello" }) {
  const id = objectId();
  const result = await stub.applyOperation({
    senderId: "setup", by: "Tester", objectOps: [{ op: "create", object: { id, type: "sticky", ...object } }],
  });
  return { id, result };
}

describe("storage", () => {
  it("uses exactly the README key layout", async () => {
    const { stub } = fresh();
    const { id } = await withSticky(stub);
    await stub.applyOperation({ requestId: "r:1", structure: { title: "T" } });
    const keys = await runInDurableObject(stub, async (_instance, state) => [...(await state.storage.list()).keys()]);
    expect(keys.sort()).toEqual([`obj:${id}`, "history", "meta", "requests"].sort());
    const raw = await runInDurableObject(stub, async (_i, state) => ({
      meta: await state.storage.get("meta"),
      obj: await state.storage.get(`obj:${id}`),
      history: await state.storage.get("history"),
    }));
    expect(Object.keys(raw.meta).sort()).toEqual(["background", "lastModified", "revision", "schemaVersion", "title"]);
    expect(raw.meta).toMatchObject({ revision: 2, title: "T", background: "dots" });
    expect(raw.obj).toMatchObject({ id, type: "sticky", text: "Hello", version: 1 });
    expect(raw.history).toHaveLength(2);
  });

  it("a multi-op request commits atomically in one revision", async () => {
    const { stub } = fresh();
    const a = objectId(), b = objectId(), c = objectId();
    const r = await stub.applyOperation({ objectOps: [
      { op: "create", object: { id: a, type: "sticky" } },
      { op: "create", object: { id: b, type: "rect" } },
      { op: "create", object: { id: c, type: "connector", from: a, to: b } },
    ] });
    expect(r).toMatchObject({ status: "applied", revision: 1 });
    const d = await stub.applyOperation({ objectOps: [{ op: "delete", id: a, baseVersion: 1 }] });
    expect(d.deletes.sort()).toEqual([a, c].sort());
    const keys = await runInDurableObject(stub, async (_i, state) => [...(await state.storage.list({ prefix: "obj:" })).keys()]);
    expect(keys).toEqual([`obj:${b}`]);
  });

  it("commit is atomic: a failing write rolls back earlier writes in the same commit", async () => {
    const { stub } = fresh();
    await runInDurableObject(stub, async (_instance, state) => {
      const repo = new DoStorageRepository(state.storage);
      const keep = { id: "o_000000000001", text: "keep" };
      await repo.commit({ putObjects: [keep], meta: { revision: 1 } });
      await expect(repo.commit({
        deleteObjects: ["o_000000000001"],                       // runs first
        meta: { revision: 2 },
        putObjects: [{ id: "o_000000000002", notCloneable: () => 1 }], // then the put throws
      })).rejects.toThrow();
      expect(await state.storage.get("obj:o_000000000001")).toEqual(keep);
      expect(await state.storage.get("meta")).toEqual({ revision: 1 });
      expect(await state.storage.get("obj:o_000000000002")).toBeUndefined();
    });
  });

  it("writes and deletes more than one 128-key batch in one commit", async () => {
    const { stub } = fresh();
    await runInDurableObject(stub, async (_instance, state) => {
      const repo = new DoStorageRepository(state.storage);
      const objects = Array.from({ length: 300 }, (_, i) => ({ id: "o_" + i.toString(16).padStart(12, "0") }));
      await repo.commit({ putObjects: objects });
      expect(Object.keys(await repo.getObjects())).toHaveLength(300);
      await repo.commit({ deleteObjects: objects.slice(0, 290).map((o) => o.id), putObjects: [objects[0]] });
      expect(Object.keys(await repo.getObjects()).sort()).toEqual([objects[0], ...objects.slice(290)].map((o) => o.id).sort());
    });
  });

  it("request records survive a restart", async () => {
    const { stub, again } = fresh();
    const id = objectId();
    const req = { requestId: "client:1", objectOps: [{ op: "create", object: { id, type: "sticky", text: "Once" } }] };
    expect((await stub.applyOperation(req)).status).toBe("applied");
    const stored = await runInDurableObject(stub, async (_i, state) => state.storage.get("requests"));
    expect(stored).toEqual([{ requestId: "client:1", senderId: "", revision: 1, status: "applied", conflicts: [], errors: [] }]);
    await stub.deleteObjects({ ids: [id] });
    await abortAllDurableObjects();
    const replay = await again().applyOperation(req);
    expect(replay).toMatchObject({ status: "applied", revision: 2, duplicate: true, upserts: [] });
    expect((await again().getBoard()).objects[id]).toBeUndefined();
  });

  it("board, history and indexes survive a restart", async () => {
    const { stub, again } = fresh();
    const { id } = await withSticky(stub, { text: "Durable" });
    const other = await withSticky(stub);
    await stub.connectObjects({ from: id, to: other.id });
    await abortAllDurableObjects();
    const board = await again().getBoard();
    expect(board.revision).toBe(3);
    expect(board.objects[id].text).toBe("Durable");
    expect(await again().getHistory()).toHaveLength(3);
    // The connector index is rebuilt at load: deleting an endpoint still cascades.
    const d = await again().deleteObjects({ ids: [id] });
    expect(d.deletes).toHaveLength(2);
  });
});

describe("RPC surface", () => {
  it("applyOperation, undo and history return plain results", async () => {
    const { stub } = fresh();
    const { id, result } = await withSticky(stub);
    expect(result).toMatchObject({ status: "applied", revision: 1, conflicts: [], errors: [] });
    expect(result).not.toHaveProperty("event");
    const conflict = await stub.applyOperation({ objectOps: [{ op: "update", id, baseVersion: 7, patch: { text: "x" } }] });
    expect(conflict.conflicts[0].current.text).toBe("Hello");
    const moved = await stub.applyOperation({ by: "U", objectOps: [{ op: "update", id, baseVersion: 1, patch: { x: 500 } }] });
    const undone = await stub.undo({ by: "U" });
    expect(undone.upserts[0].x).toBe(0);
    expect((await stub.getHistory(2)).map((h) => [h.by, h.summary])).toEqual([["U", moved.history.summary], ["U", "Undid: moved a sticky note"]]);
  });

  it("convenience methods round trip", async () => {
    const { stub } = fresh();
    const added = await stub.addStickies({ by: "Assistant", stickies: ["Hire", { text: "Ship", color: "green" }] });
    expect(Object.keys(added).sort()).toEqual(["created", "errors"]);
    expect(added.created.map((o) => o.text)).toEqual(["Hire", "Ship"]);
    const ids = added.created.map((o) => o.id);
    const frame = await stub.addFrame({ name: "Planning", contains: ids, by: "Assistant" });
    expect(Object.keys(frame).sort()).toEqual(["frame", "result"]);
    expect(frame.frame.text).toBe("Planning");
    expect((await stub.getFrame("planning")).objects.map((o) => o.id).sort()).toEqual([...ids].sort());
    const objs = await stub.addObjects({ objects: [{ type: "rect", text: "Decision", color: "blue", x: 0, y: 600 }] });
    const conn = await stub.connectObjects({ from: ids[0], to: objs.created[0].id, label: "leads to" });
    expect(Object.keys(conn).sort()).toEqual(["connector", "errors"]);
    expect(conn.connector.text).toBe("leads to");
    expect((await stub.findObjects({ type: "sticky", frame: "Planning", text: "ship" })).map((o) => o.id)).toEqual([ids[1]]);
    expect((await stub.moveObjects({ ids, dx: 10, dy: 0 })).status).toBe("applied");
    expect((await stub.arrangeGrid({ ids, columns: 1, at: { x: 0, y: 0 } })).upserts.map((o) => o.y)).toEqual([0, 240]);
    expect((await stub.updateObjects({ updates: [{ id: ids[0], fields: { text: "Hire two" } }] })).upserts[0].text).toBe("Hire two");
    expect((await stub.deleteObjects({ ids: [ids[0]] })).deletes).toContain(conn.connector.id);
  });
});

describe("live updates", () => {
  it("two subscribers receive operation events carrying senderId, in revision order", async () => {
    const { stub, again } = fresh();
    const a = new Callbacks();
    const b = new Callbacks();
    const snapA = await stub.subscribe(a, { clientId: "A", name: "Ann", color: "#112233" });
    await again().subscribe(b, { clientId: "B", name: "Bob", color: "#445566" });
    expect(snapA).toMatchObject({ revision: 0, objects: {}, session: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const { id } = await withSticky(again());
    await Promise.all(Array.from({ length: 10 }, () => withSticky(stub)));
    await vi.waitFor(() => {
      expect(a.ops).toHaveLength(11);
      expect(b.ops).toHaveLength(11);
    });
    for (const cb of [a, b]) {
      expect(cb.ops[0]).toMatchObject({ type: "operation", senderId: "setup", revision: 1, deletes: [], structure: null });
      expect(cb.ops[0].upserts[0].id).toBe(id);
      expect(cb.ops.map((e) => e.revision)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    }
  });

  it("presence is delivered as arrays: join replay, update, leave; leave disposes the callback", async () => {
    const { stub } = fresh();
    const a = new Callbacks();
    const b = new Callbacks();
    const { session } = await stub.subscribe(a, { clientId: "A", name: "Ann", color: "#112233" });
    await stub.subscribe(b, { clientId: "B", name: "Bob", color: "not a colour" });
    await vi.waitFor(() => expect(b.presences).toHaveLength(1));
    expect(b.calls.every(Array.isArray)).toBe(true);
    expect(b.presences[0]).toMatchObject({ type: "join", clientId: "A", name: "Ann", color: "#112233", cursor: null, at: expect.any(Number) });
    await vi.waitFor(() => expect(a.presences.map((p) => p.clientId)).toEqual(["B"]));

    const { id } = await withSticky(stub);
    const r = await stub.updatePresence({ clientId: "A", session, cursor: { x: 5, y: 6 }, selection: [id, "<script>"], editingId: "nope" });
    expect(r).toEqual({ known: true, revision: 1 });
    await vi.waitFor(() => expect(b.presences.at(-1)).toMatchObject({ type: "update", clientId: "A", cursor: { x: 5, y: 6 }, selection: [id], editingId: null }));
    expect(a.presences.some((p) => p.clientId === "A")).toBe(false);

    expect(a.disposed).toBe(false);
    await stub.leavePresence("A", session);
    await vi.waitFor(() => expect(b.presences.at(-1)).toMatchObject({ type: "leave", clientId: "A" }));
    await vi.waitFor(() => expect(a.disposed).toBe(true));
    expect(await stub.updatePresence({ clientId: "A", session })).toEqual({ known: false, revision: 1 });
    expect(await stub.updatePresence({ clientId: "nobody" })).toEqual({ known: false, revision: 1 });
  });

  it("a failing subscriber is removed and others see it leave", async () => {
    const { stub } = fresh();
    const good = new Callbacks();
    const { session } = await stub.subscribe(good, { clientId: "G", name: "Good" });
    const dead = await stub.subscribe(new Dead(), { clientId: "T", name: "Bad" });
    await withSticky(stub);
    await vi.waitFor(() => expect(good.presences.some((p) => p.type === "leave" && p.clientId === "T")).toBe(true));
    expect(good.ops).toHaveLength(1);
    expect(await stub.updatePresence({ clientId: "T", session: dead.session })).toMatchObject({ known: false });
    expect(await stub.updatePresence({ clientId: "G", session })).toMatchObject({ known: true });
  });

  it("heartbeat reports known: false after a restart; re-subscribing keeps the token", async () => {
    const { stub, again } = fresh();
    const { session } = await stub.subscribe(new Callbacks(), { clientId: "A" });
    expect(await stub.updatePresence({ clientId: "A", session })).toEqual({ known: true, revision: 0 });
    await withSticky(stub);
    await abortAllDurableObjects();
    // A new instance has not loaded the board yet: revision still comes back correct.
    expect(await again().updatePresence({ clientId: "A", session })).toEqual({ known: false, revision: 1 });
    const resub = await again().subscribe(new Callbacks(), { clientId: "A", session });
    expect(resub.session).toBe(session);
    expect((await again().updatePresence({ clientId: "A", session })).known).toBe(true);
  });

  it("sessions guard replace, presence and leave; a refused subscribe disposes its duplicate", async () => {
    const { stub } = fresh();
    const a = new Callbacks();
    const watcher = new Callbacks();
    const snap = await stub.subscribe(a, { clientId: "A", name: "Ann" });
    await stub.subscribe(watcher, { clientId: "W" });
    const hijacker = new Callbacks();
    await expect(runInDurableObject(stub, (instance) => instance.subscribe(hijacker, { clientId: "A", name: "Mallory" }))).rejects.toThrow("clientId in use");
    expect(await stub.updatePresence({ clientId: "A", name: "Mallory" })).toMatchObject({ known: false });
    await stub.leavePresence("A");
    await stub.leavePresence("A", "0".repeat(32));
    expect(await stub.updatePresence({ clientId: "A", session: snap.session, name: "Ann" })).toMatchObject({ known: true });
    expect(await stub.updatePresence({ clientId: "A", session: snap.session, cursor: { x: 9, y: 9 } })).toMatchObject({ known: true });
    // Coalesced: the update may arrive folded into A's pending join.
    await vi.waitFor(() => expect(watcher.presences.some((p) => p.clientId === "A" && p.cursor?.x === 9)).toBe(true));
    expect(watcher.presences.some((p) => p.name === "Mallory" || p.type === "leave")).toBe(false);
    for (const p of [...a.presences, ...watcher.presences]) expect(JSON.stringify(p)).not.toContain(snap.session);
    // The owner can replace its own subscription, keeping the session; the old callback is released.
    const replacement = new Callbacks();
    const again = await stub.subscribe(replacement, { clientId: "A", session: snap.session });
    expect(again.session).toBe(snap.session);
    await vi.waitFor(() => expect(a.disposed).toBe(true));
    expect(replacement.disposed).toBe(false);
  });
});

describe("ExportHandler", () => {
  it("lists SVG (server) and HTML/PDF (browser) formats", async () => {
    const { stub } = fresh();
    expect(await exports.ExportHandler.getExportFormats(stub)).toEqual([
      { id: "svg", label: "SVG image", mode: "server", contentType: "image/svg+xml", fileExtension: ".svg" },
      { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
      { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
    ]);
  });

  it("exports the board as SVG with escaped text", async () => {
    const { stub } = fresh();
    await stub.applyOperation({ structure: { title: "Q4 <plan>" } });
    await stub.addStickies({ stickies: ["a & b", "<script>alert(1)</script>"] });
    const text = await new Response(await exports.ExportHandler.export(stub, "svg")).text();
    expect(text.startsWith("<?xml")).toBe(true);
    expect(text).toContain("<svg xmlns=\"http://www.w3.org/2000/svg\"");
    expect(text).toContain("<title>Q4 &lt;plan&gt;</title>");
    expect(text).toContain("a &amp; b");
    expect(text).not.toContain("<script>");
    expect(text).toBe(await stub.exportSvg({}));
    // Called directly: an exception thrown across RPC is reported by the pool as unhandled.
    await expect(ExportHandler.prototype.export.call(null, stub, "csv")).rejects.toThrow(/Unknown/);
  });
});
