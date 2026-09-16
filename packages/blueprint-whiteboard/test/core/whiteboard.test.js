// Operations, versions, references, cascades, stacking, structure, history, undo and idempotency.
import { describe, expect, it } from "vitest";
import { DEFAULT_TITLE, SCHEMA_VERSION, TYPE_DEFAULTS, compareObjects, isId } from "../../src/shared/protocol.js";
import { isValidOrderKey } from "../../src/shared/order.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { createWhiteboard } from "../../src/core/whiteboard.js";
import { apply, create, createOp, deleteOp, oid, pen, setup, updateOp } from "./helpers.js";

describe("new board", () => {
  it("starts empty with default meta, and commits it once", async () => {
    const { board, repo } = setup();
    const snap = await board.getBoard();
    expect(snap).toEqual({
      schemaVersion: SCHEMA_VERSION, revision: 0, title: DEFAULT_TITLE, background: "dots", objects: {},
      lastModified: expect.any(Number),
    });
    expect(repo.commits).toBe(1);
    expect(board.revisionNow()).toBe(0);
    expect(await board.getRevision()).toBe(0);
    expect(createWhiteboard(new InMemoryRepository()).revisionNow()).toBeNull();
  });

  it("repairs malformed stored meta on load", async () => {
    const repo = new InMemoryRepository();
    repo.meta = { revision: "x", title: 5, background: "neon" };
    const snap = await createWhiteboard(repo).getBoard();
    expect(snap).toMatchObject({ schemaVersion: SCHEMA_VERSION, revision: 0, title: DEFAULT_TITLE, background: "dots" });
    expect(repo.meta.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe("create", () => {
  it("creates every type with defaults, version 1, timestamps and createdBy", async () => {
    const { board, events } = setup();
    const a = oid(), b = oid();
    const ops = [
      { op: "create", object: { id: a, type: "sticky", text: "hello" } },
      { op: "create", object: { id: b, type: "rect", x: 10, y: 20, style: { fill: "#ABCDEF", bogus: 1 } } },
      createOp({ type: "ellipse" }), createOp({ type: "text", text: "label", rot: 725 }),
      createOp({ type: "frame", text: "Frame one" }), createOp(pen()),
      createOp({ type: "connector", from: a, to: b, x: 99, frameId: null }),
    ];
    const r = await apply(board, { by: "Ann", senderId: "S", objectOps: ops });
    expect(r).toMatchObject({ status: "applied", revision: 1, errors: [], conflicts: [], deletes: [], structure: null });
    expect(r.upserts.map((o) => o.type)).toEqual(["sticky", "rect", "ellipse", "text", "frame", "pen", "connector"]);
    for (const o of r.upserts) {
      expect(o).toMatchObject({ version: 1, createdBy: "Ann", createdAt: o.updatedAt });
      expect(isValidOrderKey(o.z)).toBe(true);
    }
    const [sticky, rect, , text, frame, stroke, conn] = r.upserts;
    expect(sticky).toMatchObject({ w: 200, h: 200, text: "hello", frameId: null, style: TYPE_DEFAULTS.sticky.style });
    expect(rect.style.fill).toBe("#abcdef");
    expect(rect.style).not.toHaveProperty("bogus");
    expect(text.rot).toBe(5);
    expect(frame.frameId).toBeNull();
    expect(stroke.points).toEqual([0, 0, 1, 1]);
    expect(conn).toMatchObject({ x: 0, y: 0, w: 1, h: 1, from: a, to: b, fromSide: "auto", routing: "straight" });
    expect(r.history.summary).toBe("Added 7 objects");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "operation", senderId: "S", revision: 1, deletes: [], structure: null });
    expect(events[0].upserts).toHaveLength(7);
  });

  it("refuses an existing id, invalid ids and types, and ops that are not objects", async () => {
    const { board } = setup();
    const { id } = await create(board);
    const r = await apply(board, { objectOps: [
      createOp({ id }), createOp({ id: "c_123" }), createOp({ type: "star" }), { op: "create" },
      null, 42, [], { op: "upsert" },
    ] });
    expect(r.status).toBe("unchanged");
    expect(r.errors.map((e) => [e.index, e.code])).toEqual([
      [0, "exists"], [1, "invalid_id"], [2, "invalid_op"], [3, "invalid_op"], [4, "invalid_op"],
      [5, "invalid_op"], [6, "invalid_op"], [7, "invalid_op"],
    ]);
  });

  it("a request may not delete and then recreate an id", async () => {
    const { board } = setup();
    const { id } = await create(board);
    const r = await apply(board, { objectOps: [deleteOp(id, 1), createOp({ id })] });
    expect(r.deletes).toEqual([id]);
    expect(r.errors).toEqual([expect.objectContaining({ index: 1, code: "exists" })]);
  });

  it("pens need at least two valid points", async () => {
    const { board } = setup();
    const r = await apply(board, { objectOps: [
      createOp({ type: "pen" }), createOp(pen({ points: [0.5, 0.5] })), createOp(pen({ points: [0, "x", 1, 1] })),
      createOp(pen({ points: [0, 0, 2, -1, 0.123456, 0.5, 7] })),
    ] });
    expect(r.errors.map((e) => [e.index, e.code])).toEqual([[0, "invalid_op"], [1, "invalid_op"], [2, "invalid_op"]]);
    expect(r.upserts[0].points).toEqual([0, 0, 1, 0, 0.1235, 0.5]);
  });

  it("validates connector endpoints and frameIds when the op runs", async () => {
    const { board } = setup();
    const a = await create(board), b = await create(board);
    const frame = await create(board, { type: "frame" });
    const c = oid();
    const r = await apply(board, { objectOps: [
      createOp({ type: "connector", from: a.id, to: a.id }),
      createOp({ type: "connector", from: a.id, to: oid() }),
      createOp({ type: "connector", from: a.id }),
      { op: "create", object: { id: c, type: "connector", from: a.id, to: b.id } },
      createOp({ type: "connector", from: c, to: b.id }),
      createOp({ frameId: a.id }),
      createOp({ frameId: oid() }),
      createOp({ frameId: frame.id }),
      createOp({ type: "connector", from: frame.id, to: b.id }),
    ] });
    expect(r.errors.map((e) => [e.index, e.code])).toEqual([
      [0, "invalid_ref"], [1, "invalid_ref"], [2, "invalid_ref"], [4, "invalid_ref"], [5, "invalid_ref"],
    ]);
    expect(r.errors[4].message).toMatch(/not a frame/);
    // A frameId naming nothing (a frame deleted meanwhile) is cleared; the create still applies.
    expect(r.upserts.map((o) => [o.type, o.frameId])).toEqual([["connector", null], ["sticky", null], ["sticky", frame.id], ["connector", null]]);
  });

  it("an op sees objects created earlier in the same request", async () => {
    const { board } = setup();
    const f = oid(), a = oid(), b = oid();
    const r = await apply(board, { objectOps: [
      { op: "create", object: { id: f, type: "frame" } },
      { op: "create", object: { id: a, type: "sticky", frameId: f } },
      { op: "create", object: { id: b, type: "rect" } },
      { op: "create", object: { id: oid(), type: "connector", from: a, to: b } },
    ] });
    expect(r.errors).toEqual([]);
    expect(r.upserts).toHaveLength(4);
  });
});

describe("z order", () => {
  it("defaults above the highest z of the object's stacking group, across one request", async () => {
    const { board } = setup();
    const r = await apply(board, { objectOps: [
      createOp({}), createOp({ type: "frame" }), createOp({ z: "b00" }), createOp({}), createOp({ type: "frame" }),
      createOp({ z: "not valid!" }), createOp({ z: "a0" }),
    ] });
    const [s1, f1, s2, s3, f2, s4, s5] = r.upserts;
    expect(s1.z).toBe("a0");
    expect(f1.z).toBe("a0");
    expect(s2.z).toBe("b00");
    expect(s3.z > "b00").toBe(true);
    expect(f2.z > f1.z).toBe(true);
    expect(f2.z < s3.z).toBe(true); // frames have their own group
    expect(s4.z > s3.z).toBe(true); // invalid key replaced by a default
    expect(s5.z).toBe("a0");
    // A later request (and a reloaded board) keeps stacking on top.
    const next = await create(board);
    expect(next.obj.z > s4.z).toBe(true);
    expect(Object.values((await board.getBoard()).objects).sort(compareObjects)[0].type).toBe("frame");
  });

  it("recomputes the top of each group after a reload", async () => {
    const repo = new InMemoryRepository();
    const board = createWhiteboard(repo);
    const r = await apply(board, { objectOps: [createOp({ z: "b0V" }), createOp({ type: "frame", z: "a5" })] });
    expect(r.errors).toEqual([]);
    const again = createWhiteboard(repo);
    const s = await apply(again, { objectOps: [createOp({}), createOp({ type: "frame" })] });
    expect(s.upserts[0].z > "b0V").toBe(true);
    expect(s.upserts[1].z > "a5").toBe(true);
  });

  it("update may change z to a valid key; invalid keys are ignored", async () => {
    const { board } = setup();
    const { id } = await create(board);
    let r = await apply(board, { objectOps: [updateOp(id, 1, { z: "Zz" })] });
    expect(r.upserts[0].z).toBe("Zz");
    r = await apply(board, { objectOps: [updateOp(id, 2, { z: "b" })] });
    expect(r.status).toBe("unchanged");
  });
});

describe("update", () => {
  it("patches listed fields, merges style, bumps the version once per request", async () => {
    const { board } = setup();
    const { id, obj } = await create(board, { text: "a" });
    const r = await apply(board, { by: "Bob", objectOps: [
      updateOp(id, 1, { x: 5, text: "b", style: { fill: "#000000" }, type: "rect", version: 99, createdBy: "X" }),
      updateOp(id, 1, { y: 7 }),
      updateOp(id, 2, { w: 300 }),
    ] });
    expect(r.errors).toEqual([]);
    expect(r.upserts).toHaveLength(1);
    const o = r.upserts[0];
    expect(o).toMatchObject({ type: "sticky", x: 5, y: 7, w: 300, text: "b", version: 2, createdBy: "Tester" });
    expect(o.style).toEqual({ ...obj.style, fill: "#000000" });
    expect(o.updatedAt).toBeGreaterThan(obj.updatedAt);
    expect(r.history.summary).toBe("Edited a sticky note");
  });

  it("ignores fields the type does not allow, and an empty or no-op patch changes nothing", async () => {
    const { board } = setup();
    const { id } = await create(board, { type: "frame", x: 1 });
    for (const patch of [{}, { rot: 45, frameId: null, points: [0, 0, 1, 1] }, { x: 1 }, null, "x", [1]]) {
      const r = await apply(board, { objectOps: [updateOp(id, 1, patch)] });
      expect(r).toMatchObject({ status: "unchanged", errors: [], upserts: [] });
    }
    expect(await board.getRevision()).toBe(1);
  });

  it("conflicts on a stale version, reports missing objects", async () => {
    const { board } = setup();
    const { id } = await create(board);
    await apply(board, { objectOps: [updateOp(id, 1, { x: 1 })] });
    const gone = await create(board);
    await apply(board, { objectOps: [deleteOp(gone.id, 1)] });
    const r = await apply(board, { objectOps: [
      updateOp(id, 1, { x: 2 }),         // stale
      updateOp(gone.id, 1, { x: 2 }),    // deleted: conflict with current null
      updateOp(oid(), 0, { x: 2 }),      // never existed
      updateOp(id, undefined, { x: 2 }), // missing baseVersion
      updateOp(id, -1, { x: 2 }),
      updateOp(id, 1.5, { x: 2 }),
      updateOp("nope", 1, { x: 2 }),
      updateOp(id, 2, { y: 9 }),         // current: applies
    ] });
    expect(r.status).toBe("conflict");
    expect(r.conflicts).toEqual([
      { id, current: expect.objectContaining({ id, x: 1, version: 2 }) },
      { id: gone.id, current: null },
    ]);
    expect(r.errors.map((e) => [e.index, e.code])).toEqual([
      [2, "unknown_object"], [3, "invalid_op"], [4, "invalid_op"], [5, "invalid_op"], [6, "invalid_id"],
    ]);
    expect(r.upserts[0]).toMatchObject({ y: 9, version: 3 });
  });

  it("frameId must name a frame; a dangling frameId is cleared on the next write", async () => {
    const { board } = setup();
    const frame = await create(board, { type: "frame" });
    const other = await create(board);
    const { id } = await create(board, { frameId: frame.id });
    let r = await apply(board, { objectOps: [updateOp(id, 1, { frameId: other.id })] });
    expect(r.errors).toEqual([expect.objectContaining({ code: "invalid_ref" })]);
    r = await apply(board, { objectOps: [updateOp(id, 1, { frameId: null, x: 3 })] });
    expect(r.upserts[0]).toMatchObject({ frameId: null, x: 3 });
    r = await apply(board, { objectOps: [updateOp(id, 2, { frameId: frame.id })] });
    expect(r.upserts[0].frameId).toBe(frame.id);
    // A frameId naming nothing is cleared and the rest of the update applies.
    r = await apply(board, { objectOps: [updateOp(id, 3, { frameId: oid(), x: 7 })] });
    expect(r.errors).toEqual([]);
    expect(r.upserts[0]).toMatchObject({ frameId: null, x: 7, version: 4 });
    r = await apply(board, { objectOps: [updateOp(id, 4, { frameId: frame.id })] });
    expect(r.upserts[0]).toMatchObject({ frameId: frame.id, version: 5 });
    // Deleting the frame leaves the member dangling until its next write.
    await apply(board, { objectOps: [deleteOp(frame.id, 1)] });
    expect((await board.getBoard()).objects[id].frameId).toBe(frame.id);
    r = await apply(board, { objectOps: [updateOp(id, 5, { text: "moved" })] });
    expect(r.upserts[0]).toMatchObject({ frameId: null, text: "moved" });
  });

  it("a move or create into a frame deleted concurrently keeps everything but the frameId", async () => {
    const { board } = setup();
    const frame = await create(board, { type: "frame", x: 0, y: 0, w: 1000, h: 1000 });
    const x = await create(board, { x: 2000, y: 2000 });
    await apply(board, { by: "A", objectOps: [deleteOp(frame.id, 1)] });
    // B has not seen the delete: drags X into the frame and creates a sticky inside it.
    const created = createOp({ x: 100, y: 100, text: "important", frameId: frame.id });
    const r = await apply(board, { by: "B", objectOps: [updateOp(x.id, 1, { x: 100, y: 100, frameId: frame.id }), created] });
    expect(r).toMatchObject({ status: "applied", errors: [] });
    const snap = await board.getBoard();
    expect(snap.objects[x.id]).toMatchObject({ x: 100, y: 100, frameId: null });
    expect(snap.objects[created.object.id]).toMatchObject({ text: "important", frameId: null });
    // Deleted earlier in the same request counts as gone too.
    const f2 = await create(board, { type: "frame" });
    const r2 = await apply(board, { objectOps: [deleteOp(f2.id, 1), createOp({ frameId: f2.id })] });
    expect(r2.errors).toEqual([]);
    expect(r2.upserts[0].frameId).toBeNull();
  });

  it("connector endpoints can change but must stay valid", async () => {
    const { board } = setup();
    const a = await create(board), b = await create(board), c = await create(board);
    const conn = await create(board, { type: "connector", from: a.id, to: b.id });
    let r = await apply(board, { objectOps: [updateOp(conn.id, 1, { to: a.id })] });
    expect(r.errors[0].code).toBe("invalid_ref");
    r = await apply(board, { objectOps: [updateOp(conn.id, 1, { to: c.id, routing: "elbow", x: 500 })] });
    expect(r.upserts[0]).toMatchObject({ to: c.id, routing: "elbow", x: 0 });
    // The adjacency index follows: deleting b no longer cascades, deleting c does.
    r = await apply(board, { objectOps: [deleteOp(b.id, 1)] });
    expect(r.deletes).toEqual([b.id]);
    r = await apply(board, { objectOps: [deleteOp(c.id, 1)] });
    expect(r.deletes.sort()).toEqual([c.id, conn.id].sort());
  });
});

describe("delete", () => {
  it("deletes connectors attached to the object in the same op; later ops see them gone", async () => {
    const { board, events } = setup();
    const a = await create(board), b = await create(board), c = await create(board);
    const ab = await create(board, { type: "connector", from: a.id, to: b.id });
    const ca = await create(board, { type: "connector", from: c.id, to: a.id });
    const bc = await create(board, { type: "connector", from: b.id, to: c.id });
    const r = await apply(board, { objectOps: [
      deleteOp(a.id, 1),
      updateOp(ab.id, 1, { text: "late" }),
      createOp({ type: "connector", from: a.id, to: b.id }),
    ] });
    expect(r.deletes.sort()).toEqual([a.id, ab.id, ca.id].sort());
    expect(r.conflicts).toEqual([{ id: ab.id, current: null }]);
    expect(r.errors).toEqual([expect.objectContaining({ index: 2, code: "invalid_ref" })]);
    expect(r.history.summary).toBe("Deleted a sticky note");
    expect(events.at(-1).deletes.sort()).toEqual(r.deletes.sort());
    const snap = await board.getBoard();
    expect(Object.keys(snap.objects).sort()).toEqual([b.id, c.id, bc.id].sort());
  });

  it("conflict and missing rules", async () => {
    const { board } = setup();
    const { id } = await create(board);
    const r = await apply(board, { objectOps: [deleteOp(id, 3), deleteOp(oid(), 0), deleteOp(oid(), 2), deleteOp(id)] });
    expect(r.conflicts.map((c) => c.current?.id ?? null)).toEqual([id, null]);
    expect(r.errors.map((e) => [e.index, e.code])).toEqual([[1, "unknown_object"], [3, "invalid_op"]]);
  });

  it("may name the version from before the request after an update in it", async () => {
    const { board } = setup();
    const { id } = await create(board);
    const r = await apply(board, { objectOps: [updateOp(id, 1, { x: 9 }), deleteOp(id, 1)] });
    expect(r).toMatchObject({ status: "applied", deletes: [id], upserts: [] });
  });

  it("deleting a frame leaves members in place; undo restores it and they rejoin", async () => {
    const { board } = setup();
    const frame = await create(board, { type: "frame", text: "Plan" });
    const m = await create(board, { frameId: frame.id });
    const r = await apply(board, { by: "Ann", objectOps: [deleteOp(frame.id, 1)] });
    expect(r.deletes).toEqual([frame.id]);
    const u = await board.undo({ by: "Ann" });
    expect(u.result.upserts[0]).toMatchObject({ id: frame.id, text: "Plan" });
    const found = await board.getFrame("plan");
    expect(found.objects.map((o) => o.id)).toEqual([m.id]);
  });
});

describe("structure", () => {
  it("title and background are last-writer-wins, after objectOps, recorded but not undoable", async () => {
    const { board, events } = setup();
    let r = await apply(board, { by: "Ann", structure: { title: "  Q4\nplanning  ", background: "grid" } });
    expect(r).toMatchObject({ status: "applied", structure: { title: "Q4 planning", background: "grid" } });
    expect(r.history).toMatchObject({ summary: "Renamed the whiteboard, changed the background", inverse: null });
    expect(events.at(-1).structure).toEqual({ title: "Q4 planning", background: "grid" });
    r = await apply(board, { structure: { title: "" } });
    expect(r.structure.title).toBe(DEFAULT_TITLE);
    r = await apply(board, { structure: { title: 5, background: "neon" } });
    expect(r.errors.map((e) => [e.index, e.code])).toEqual([[-1, "invalid_op"], [-1, "invalid_op"]]);
    expect((await apply(board, { structure: "x" })).errors[0].code).toBe("invalid_op");
    expect((await apply(board, { structure: { background: "grid" } })).status).toBe("unchanged");
    const u = await board.undo({ by: "Ann" });
    expect(u.result.errors[0].message).toMatch(/Nothing to undo/);
    expect((await board.getBoard()).title).toBe(DEFAULT_TITLE);
  });
});

describe("history and undo", () => {
  it("summaries", async () => {
    const { board } = setup();
    const ops = Array.from({ length: 10 }, () => createOp({}));
    let r = await apply(board, { objectOps: ops });
    expect(r.history.summary).toBe("Added 10 objects");
    const ids = ops.map((o) => o.object.id);
    r = await apply(board, { objectOps: ids.slice(0, 3).map((id) => updateOp(id, 1, { x: 50 })) });
    expect(r.history.summary).toBe("Moved 3 objects");
    r = await apply(board, { objectOps: [updateOp(ids[4], 1, { x: 50, text: "t" })] });
    expect(r.history.summary).toBe("Edited a sticky note");
    r = await apply(board, { objectOps: [deleteOp(ids[5], 1), deleteOp(ids[6], 1)] });
    expect(r.history.summary).toBe("Deleted 2 objects");
    r = await apply(board, { objectOps: [createOp({ type: "ellipse" }), updateOp(ids[7], 1, { y: 1 })], structure: { title: "T" } });
    expect(r.history.summary).toBe("Added an ellipse, moved a sticky note, renamed the whiteboard");
    const history = await board.getHistory();
    expect(history).toHaveLength(5);
    expect(history[0]).toMatchObject({ id: expect.stringMatching(/^h_[0-9a-f]{12}$/), by: "Anonymous", at: expect.any(Number) });
    expect(await board.getHistory(2)).toEqual(history.slice(-2));
    expect(await board.getHistory(0)).toEqual([]);
    expect(await board.getHistory("x")).toEqual(history);
  });

  it("inverses: create -> delete, update -> previous values (whole style), delete -> full restore", async () => {
    const { board } = setup();
    const a = await create(board, { text: "a", style: { fill: "#111111" } });
    const b = await create(board);
    const conn = await create(board, { type: "connector", from: a.id, to: b.id });
    let r = await apply(board, { objectOps: [updateOp(a.id, 1, { x: 10, style: { textColor: "#222222" } })] });
    expect(r.history.inverse).toEqual({ objectOps: [{ op: "update", id: a.id, patch: { x: 0, style: a.obj.style } }] });
    r = await apply(board, { objectOps: [deleteOp(a.id, 2)] });
    const inv = r.history.inverse.objectOps;
    expect(inv.map((o) => [o.op, o.object.type])).toEqual([["create", "sticky"], ["create", "connector"]]);
    expect(inv[0].restore).toEqual({ createdAt: a.obj.createdAt, createdBy: "Tester", version: 2 });
    expect(inv[0].object).not.toHaveProperty("version");
    const created = await create(board);
    expect(created.result.history.inverse).toEqual({ objectOps: [{ op: "delete", id: created.id }] });
    void conn;
  });

  it("undo recreates deleted objects with their connectors, in force mode, then redo by undoing the undo", async () => {
    const { board, events } = setup();
    const a = await create(board, { text: "A" }, { by: "Ann" });
    const b = await create(board, {}, { by: "Ann" });
    const conn = await create(board, { type: "connector", from: a.id, to: b.id, text: "x" }, { by: "Ann" });
    const del = await apply(board, { by: "Ann", objectOps: [deleteOp(a.id, 1)] });
    expect(del.deletes).toHaveLength(2);
    const u = await board.undo({ by: "Ann", senderId: "S", historyId: del.history.id });
    expect(u.result).toMatchObject({ status: "applied", errors: [] });
    expect(u.result.history.summary).toBe("Undid: deleted a sticky note");
    expect(events.at(-1).senderId).toBe("S");
    const snap = await board.getBoard();
    expect(snap.objects[a.id]).toMatchObject({ text: "A", createdAt: a.obj.createdAt, createdBy: "Ann", version: 2, z: a.obj.z });
    expect(snap.objects[conn.id]).toMatchObject({ from: a.id, to: b.id, text: "x", version: 2 });
    // A client holding the pre-delete version conflicts rather than overwriting.
    expect((await apply(board, { objectOps: [updateOp(a.id, 1, { x: 1 })] })).status).toBe("conflict");
    // Undo of the undo (by its history id) deletes them again.
    const redo = await board.undo({ by: "Ann", historyId: u.result.history.id });
    expect(redo.result.deletes.sort()).toEqual([a.id, conn.id].sort());
  });

  it("undo skips ops on objects that no longer exist without failing the rest", async () => {
    const { board } = setup();
    const a = await create(board), b = await create(board);
    const moved = await apply(board, { by: "Ann", objectOps: [updateOp(a.id, 1, { x: 100 }), updateOp(b.id, 1, { x: 100 })] });
    await apply(board, { by: "Bob", objectOps: [deleteOp(a.id, 2)] });
    // Bob edits b in between: force mode ignores versions.
    await apply(board, { by: "Bob", objectOps: [updateOp(b.id, 2, { text: "bob" })] });
    const u = await board.undo({ historyId: moved.history.id, by: "Ann" });
    expect(u.result.status).toBe("applied");
    expect(u.result.errors).toEqual([expect.objectContaining({ index: 0, code: "unknown_object" })]);
    expect(u.result.upserts[0]).toMatchObject({ id: b.id, x: 0, text: "bob", version: 4 });
  });

  it("undo without historyId picks the latest undoable entry by `by` (cleaned)", async () => {
    const { board } = setup();
    const a = await create(board, {}, { by: "  Ann " });
    await create(board, {}, { by: "Bob" });
    await apply(board, { by: "Ann", structure: { title: "not undoable" } });
    const u = await board.undo({ by: "Ann\n" });
    expect(u.result.deletes).toEqual([a.id]);
    expect((await board.undo({ historyId: "h_000000000000" })).result.errors[0].message).toMatch(/No such/);
    const titled = (await board.getHistory()).find((h) => h.summary === "Renamed the whiteboard");
    expect((await board.undo({ historyId: titled.id })).result.errors[0].message).toMatch(/cannot be undone/);
  });

  it("recreate in force mode clears a frameId whose frame is gone", async () => {
    const { board } = setup();
    const frame = await create(board, { type: "frame" });
    const m = await create(board, { frameId: frame.id });
    const del = await apply(board, { objectOps: [deleteOp(m.id, 1)] });
    await apply(board, { objectOps: [deleteOp(frame.id, 1)] });
    const u = await board.undo({ historyId: del.history.id });
    expect(u.result.upserts[0]).toMatchObject({ id: m.id, frameId: null });
  });

  it("drops an inverse larger than inverseBytes", async () => {
    const { board } = setup({ limits: { inverseBytes: 300 } });
    const r = await apply(board, { objectOps: Array.from({ length: 10 }, () => createOp({})) });
    expect(r.history.inverse).toBeNull();
    const one = await create(board);
    expect(one.result.history.inverse).not.toBeNull();
  });

  it("history is bounded by entries and bytes", async () => {
    const { board } = setup({ limits: { historyEntries: 5, historyBytes: 1500 } });
    for (let i = 0; i < 12; i++) await create(board);
    const h = await board.getHistory(200);
    expect(h.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(h).length).toBeLessThanOrEqual(1500);
  });
});

describe("idempotent requests", () => {
  it("replays a recorded requestId without applying it again", async () => {
    const { board, events, repo } = setup();
    const op = createOp({});
    const first = await apply(board, { requestId: "c:1", objectOps: [op] });
    expect(first.status).toBe("applied");
    expect(repo.requests).toEqual([{ requestId: "c:1", senderId: "", revision: 1, status: "applied", conflicts: [], errors: [] }]);
    const commits = repo.commits;
    const again = await apply(board, { requestId: "c:1", objectOps: [op] });
    expect(again).toMatchObject({ status: "applied", revision: 1, duplicate: true, upserts: [], deletes: [], history: null });
    expect(repo.commits).toBe(commits);
    expect(events).toHaveLength(1);
  });

  it("records unchanged and conflicting outcomes, reading current objects on replay", async () => {
    const { board, repo } = setup();
    const { id } = await create(board);
    const req = { requestId: "c-2", objectOps: [updateOp(id, 7, { x: 1 }), deleteOp(oid(), 0)] };
    const first = await apply(board, req);
    expect(first.status).toBe("conflict");
    expect(repo.requests.at(-1)).toMatchObject({ requestId: "c-2", status: "conflict", conflicts: [id], errors: [expect.objectContaining({ code: "unknown_object" })] });
    await apply(board, { objectOps: [updateOp(id, 1, { x: 42 })] });
    const replay = await apply(board, req);
    expect(replay).toMatchObject({ duplicate: true, status: "conflict", revision: 2 });
    expect(replay.conflicts[0].current.x).toBe(42);
    // Undo shares the record list.
    const u1 = await board.undo({ requestId: "u-1", historyId: "h_000000000000" });
    const u2 = await board.undo({ requestId: "u-1", historyId: "h_000000000000" });
    expect(u1.result.duplicate).toBeUndefined();
    expect(u2.result.duplicate).toBe(true);
  });

  it("ignores malformed requestIds and bounds the record list", async () => {
    const { board, repo } = setup({ limits: { requestRecords: 3 } });
    await apply(board, { requestId: "bad id!", objectOps: [createOp({})] });
    expect(repo.requests).toEqual([]);
    for (let i = 0; i < 5; i++) await apply(board, { requestId: "r" + i });
    expect(repo.requests.map((r) => r.requestId)).toEqual(["r2", "r3", "r4"]);
  });
});

describe("ids", () => {
  it("uses the injected newId for history", async () => {
    let i = 0;
    const { board } = setup({ newId: (kind) => `${kind[0]}_${String(i++).padStart(12, "0")}` });
    const { result } = await create(board);
    expect(result.history.id).toBe("h_000000000000");
    expect(isId(result.history.id, "history")).toBe(true);
  });
});
