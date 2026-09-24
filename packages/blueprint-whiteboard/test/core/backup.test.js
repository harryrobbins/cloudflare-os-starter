// exportData() / importData(): a backup round trip through the normal operation path, placement,
// batching above one request's worth of ops, the object cap, and structure.
import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/shared/protocol.js";
import { exportData, importData } from "../../src/core/backup.js";
import { create, setup } from "./helpers.js";

describe("exportData / importData", () => {
  it("round-trips a board into another one with new ids, remapped references and the importer's name", async () => {
    const { board } = setup();
    await board.applyOperation({ structure: { title: "Plan", background: "grid" } });
    const f = await create(board, { type: "frame", text: "F", x: 0, y: 0, w: 600, h: 600 });
    const a = await create(board, { text: "a", x: 20, y: 20, frameId: f.id });
    const b = await create(board, { text: "b", x: 300, y: 20, frameId: f.id });
    await board.connect({ from: a.id, to: b.id });
    const doc = await exportData(board);
    expect(doc.objects.map((o) => o.type)).toEqual(["frame", "sticky", "sticky", "connector"]);

    const other = setup();
    const r = await importData(other.board, { data: doc, by: "Importer", structure: true });
    expect(r).toMatchObject({ created: 4, skipped: 0, errors: [] });
    const snap = await other.board.getBoard();
    expect(snap).toMatchObject({ title: "Plan", background: "grid" });
    const objs = Object.values(snap.objects);
    expect(objs.every((o) => o.createdBy === "Importer")).toBe(true);
    expect(objs.map((o) => o.id).some((id) => [f.id, a.id, b.id].includes(id))).toBe(false);
    const frame = objs.find((o) => o.type === "frame");
    const stickies = objs.filter((o) => o.type === "sticky");
    expect(stickies.every((s) => s.frameId === frame.id)).toBe(true);
    const conn = objs.find((o) => o.type === "connector");
    expect(new Set([conn.from, conn.to])).toEqual(new Set(stickies.map((s) => s.id)));
    // An empty board keeps the backup's coordinates.
    expect(stickies.map((s) => s.x).sort((x, y) => x - y)).toEqual([20, 300]);
    // History records ordinary changes.
    expect((await other.board.getHistory()).length).toBe(2);
  });

  it("places beside existing content, or at `at`, and keeps structure unless asked", async () => {
    const { board } = setup();
    await create(board, { x: 0, y: 50, w: 100, h: 100 });
    const data = { version: 1, objects: [{ id: "s", type: "sticky", x: -500, y: -500 }] };
    const r = await importData(board, { data: JSON.stringify(data), structure: false });
    const placed = (await board.getBoard()).objects[r.ids[0]];
    expect([placed.x, placed.y]).toEqual([300, 50]);
    const r2 = await importData(board, { data, at: { x: 7, y: 9 } });
    const placed2 = (await board.getBoard()).objects[r2.ids[0]];
    expect([placed2.x, placed2.y]).toEqual([7, 9]);
    expect((await board.getBoard()).title).not.toBe("x");
  });

  it("imports more than one request's worth in several requests", async () => {
    const { board, events } = setup();
    const n = LIMITS.opsPerRequest + 5;
    const data = { version: 1, objects: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, type: "sticky", x: i, y: 0 })) };
    const r = await importData(board, { data });
    expect(r.created).toBe(n);
    expect(events.filter((e) => e.type === "operation")).toHaveLength(2);
    expect(Object.keys((await board.getBoard()).objects)).toHaveLength(n);
  });

  it("reports unreadable documents, validation problems and board errors", async () => {
    const { board } = setup();
    expect(await importData(board, { data: "{oops" })).toEqual({ error: expect.stringMatching(/JSON/) });
    expect(await importData(board, null)).toEqual({ error: expect.any(String) });
    const frames = Array.from({ length: LIMITS.frames + 2 }, (_, i) => ({ id: `f${i}`, type: "frame", x: i * 900 }));
    const r = await importData(board, { data: { version: 1, objects: [...frames, { id: "x", type: "nope" }] } });
    expect(r.created).toBe(LIMITS.frames);
    expect(r.skipped).toBe(1);
    expect(r.problems[0]).toMatch(/unknown type/);
    expect(r.errors.filter((e) => e.code === "limit").map((e) => e.index)).toEqual([LIMITS.frames, LIMITS.frames + 1]);
  });
});
