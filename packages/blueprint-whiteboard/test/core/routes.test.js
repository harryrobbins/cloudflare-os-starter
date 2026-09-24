// Connector route fields on the server: curved routing and route edits (`segments`, `curve`) are
// normalised like every other field, fit the per-object byte limit, undo correctly (also on
// connectors stored before the fields existed), survive backups and the clipboard format, are
// accepted by the convenience methods, and draw identically in the SVG export and the client.
import { describe, expect, it } from "vitest";
import {
  LIMITS, SCHEMA_VERSION, cleanObjectPatch, cleanSegments, cleanCurve, normalizeNewObject, storedBytes,
} from "../../src/shared/protocol.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { createWhiteboard, migrate } from "../../src/core/whiteboard.js";
import { exportData, importData } from "../../src/core/backup.js";
import { buildClipboard, parseBackup } from "../../src/shared/backup.js";
import { objectNode, serialize, boardToSvg } from "../../src/shared/render.js";
import { createRouteEnv, connectorRoute } from "../../src/shared/connectors.js";
import { apply, create, setup, updateOp } from "./helpers.js";

describe("protocol: route fields", () => {
  it("accepts curved routing and cleans segments and curve handles", () => {
    expect(cleanObjectPatch({ routing: "curved" }, "connector")).toEqual({ routing: "curved" });
    expect(cleanObjectPatch({ routing: "wiggly" }, "connector")).toEqual({});
    expect(cleanObjectPatch({ segments: [1.234, -5e9, 0] }, "connector")).toEqual({ segments: [1.23, -LIMITS.coord, 0] });
    expect(cleanObjectPatch({ segments: [1, Number.NaN] }, "connector")).toEqual({});
    expect(cleanObjectPatch({ segments: [1, "2"] }, "connector")).toEqual({});
    expect(cleanObjectPatch({ segments: new Array(LIMITS.routeSegments + 1).fill(1) }, "connector")).toEqual({});
    expect(cleanObjectPatch({ segments: null }, "connector")).toEqual({ segments: [] });
    expect(cleanObjectPatch({ curve: [0.123456, 99] }, "connector")).toEqual({ curve: [0.1235, LIMITS.curveHandle] });
    expect(cleanObjectPatch({ curve: null }, "connector")).toEqual({ curve: null });
    expect(cleanObjectPatch({ curve: [1] }, "connector")).toEqual({});
    expect(cleanObjectPatch({ curve: [1, Infinity] }, "connector")).toEqual({});
    // Only connectors take them.
    expect(cleanObjectPatch({ segments: [1], curve: [0, 0], routing: "curved" }, "rect")).toEqual({});
    expect(cleanSegments({ length: 1, 0: 1 })).toBeNull();
    expect(cleanCurve("0.5,0.5")).toBeUndefined();
  });

  it("stores route edits only when present, so older and newer connectors look alike", () => {
    const base = { id: "o_000000000001", type: "connector", from: "o_000000000002", to: "o_000000000003" };
    expect(normalizeNewObject(base)).not.toHaveProperty("segments");
    expect(normalizeNewObject(base)).not.toHaveProperty("curve");
    expect(normalizeNewObject({ ...base, segments: [], curve: null })).not.toHaveProperty("segments");
    expect(normalizeNewObject({ ...base, routing: "curved", segments: [4], curve: [0.5, 0.1] })).toMatchObject({ routing: "curved", segments: [4], curve: [0.5, 0.1] });
  });

  it("a connector with the most segments stays far inside the per-object byte limit", () => {
    const o = normalizeNewObject({
      id: "o_000000000001", type: "connector", from: "o_000000000002", to: "o_000000000003", text: "x".repeat(LIMITS.connectorLabel),
      routing: "elbow", segments: new Array(LIMITS.routeSegments).fill(-999999.99), curve: [-8, 8],
    });
    expect(storedBytes(o)).toBeLessThan(LIMITS.objectBytes / 32);
  });
});

describe("core: route fields", () => {
  it("creates curved connectors, stores edits, and one undo restores the previous route", async () => {
    const { board } = setup();
    const a = await create(board, { x: 0, y: 0 });
    const b = await create(board, { x: 600, y: 300 });
    const c = await create(board, { type: "connector", from: a.id, to: b.id, routing: "curved", curve: [0.5, -0.3] });
    expect(c.obj).toMatchObject({ routing: "curved", curve: [0.5, -0.3] });
    const e = await create(board, { type: "connector", from: a.id, to: b.id, routing: "elbow" });
    expect(e.obj).not.toHaveProperty("segments");
    const r = await apply(board, { by: "Ann", objectOps: [updateOp(e.id, 1, { segments: [40, -20, 10], fromSide: "right", toSide: "left" })] });
    expect(r.upserts[0]).toMatchObject({ segments: [40, -20, 10], fromSide: "right", toSide: "left", version: 2 });
    // Writing the same segments again is not a change.
    const same = await apply(board, { by: "Ann", objectOps: [updateOp(e.id, 2, { segments: [40, -20, 10] })] });
    expect(same.upserts).toEqual([]);
    const u = await board.undo({ by: "Ann" });
    const restored = u.result.upserts.find((o) => o.id === e.id);
    expect(restored.segments ?? []).toEqual([]);
    expect(restored).toMatchObject({ fromSide: "auto", toSide: "auto" });
  });

  it("connect() accepts curved routing and sides", async () => {
    const { board } = setup();
    const a = await create(board, { x: 0, y: 0 });
    const b = await create(board, { x: 600, y: 300 });
    const r = await board.connect({ from: a.id, to: b.id, routing: "curved", fromSide: "bottom", toSide: "nope" });
    expect(r.connector).toMatchObject({ routing: "curved", fromSide: "bottom", toSide: "auto" });
    const r2 = await board.connect({ from: a.id, to: b.id, routing: "bogus" });
    expect(r2.connector.routing).toBe("straight");
    // updateObjects passes route edits through the same checks.
    const u = await board.updateObjects({ updates: [{ id: r.connector.id, fields: { curve: [0.4, 0.2] } }] });
    expect(u.result.upserts[0].curve).toEqual([0.4, 0.2]);
  });

  it("findObjects({within}) uses the routed elbow's bounds", async () => {
    const { board } = setup();
    const a = await create(board, { x: 0, y: 0, w: 100, h: 100 });
    const b = await create(board, { x: 600, y: 0, w: 100, h: 100 });
    await create(board, { type: "rect", x: 250, y: -20, w: 100, h: 140 });
    const c = await create(board, { type: "connector", from: a.id, to: b.id, routing: "elbow", fromSide: "right", toSide: "left" });
    // The detour runs above or below the blocking rect, outside the ends' own rows.
    // Padded by 16, the rect's clearance lines are y = -36 and y = 136.
    const found = await board.findObjects({ type: "connector", within: { x: 280, y: -45, w: 40, h: 12 } });
    const below = await board.findObjects({ type: "connector", within: { x: 280, y: 130, w: 40, h: 12 } });
    expect([...found, ...below].map((o) => o.id)).toEqual([c.id]);
  });
});

describe("backups and the clipboard format", () => {
  it("round-trip route edits and curved routing", async () => {
    const { board } = setup();
    const a = await create(board, { x: 0, y: 0 });
    const b = await create(board, { x: 600, y: 300 });
    await create(board, { type: "connector", from: a.id, to: b.id, routing: "elbow", segments: [15, -30], fromSide: "right", toSide: "top" });
    await create(board, { type: "connector", from: b.id, to: a.id, routing: "curved", curve: [0.25, 0.5] });
    const doc = await exportData(board);
    const conns = doc.objects.filter((o) => o.type === "connector");
    expect(conns.map((o) => o.segments ?? null)).toEqual([[15, -30], null]);
    expect(conns.map((o) => o.curve ?? null)).toEqual([null, [0.25, 0.5]]);
    const other = setup();
    const r = await importData(other.board, { data: JSON.parse(JSON.stringify(doc)), by: "Importer" });
    expect(r.errors).toEqual([]);
    const snap = await other.board.getBoard();
    const imported = Object.values(snap.objects).filter((o) => o.type === "connector");
    expect(imported.map((o) => [o.routing, o.segments ?? null, o.curve ?? null, o.fromSide, o.toSide])).toEqual([
      ["elbow", [15, -30], null, "right", "top"],
      ["curved", null, [0.25, 0.5], "auto", "auto"],
    ]);
    // The data-only format the clipboard uses keeps them too.
    const all = (await board.getBoard()).objects;
    const parsed = parseBackup(buildClipboard(Object.values(all), all));
    expect(parsed.entries.filter((e) => e.object.type === "connector").map((e) => e.object.segments ?? e.object.curve)).toEqual([[15, -30], [0.25, 0.5]]);
  });
});

describe("export and client draw the same routes", () => {
  it("curved connectors draw as an SVG cubic; elbows route around obstacles in the export", async () => {
    const { board } = setup();
    const a = await create(board, { x: 0, y: 0, w: 100, h: 100 });
    const b = await create(board, { x: 600, y: 0, w: 100, h: 100 });
    await create(board, { type: "rect", x: 250, y: -20, w: 100, h: 140 });
    const curved = await create(board, { type: "connector", from: a.id, to: b.id, routing: "curved" });
    const elbow = await create(board, { type: "connector", from: a.id, to: b.id, routing: "elbow" });
    const snap = await board.getBoard();
    const svg = await board.exportSvg();
    const env = createRouteEnv(snap.objects);
    const resolve = (id) => snap.objects[id];
    for (const c of [curved, elbow]) expect(svg).toContain(serialize(objectNode(snap.objects[c.id], resolve, env)));
    expect(svg).toMatch(/d="M100 50C/);
    expect(connectorRoute(snap.objects[elbow.id], a.obj, b.obj, env).avoided).toBe(true);
    // The viewBox holds the detour.
    const vb = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(svg).slice(1).map(Number);
    const route = connectorRoute(snap.objects[elbow.id], a.obj, b.obj, env);
    for (const p of route.points) {
      expect(p.x).toBeGreaterThanOrEqual(vb[0]);
      expect(p.y).toBeGreaterThanOrEqual(vb[1]);
      expect(p.y).toBeLessThanOrEqual(vb[1] + vb[3]);
    }
    expect(boardToSvg(snap)).toBe(svg);
  });
});

describe("stored data compatibility", () => {
  it("keeps schemaVersion 1: connectors stored before route edits load, draw and undo unchanged", async () => {
    expect(SCHEMA_VERSION).toBe(1);
    const repo = new InMemoryRepository();
    const meta = { schemaVersion: 1, revision: 9, title: "Legacy", background: "dots", lastModified: 123 };
    const style = (s) => ({ fill: "#ffffff", stroke: "#1f2937", strokeWidth: 2, textColor: "#1f2937", fontSize: 18, align: "center", arrowStart: "none", arrowEnd: "none", ...s });
    const a = { id: "o_0000000000b1", type: "rect", x: 0, y: 0, w: 200, h: 120, rot: 0, z: "a0", frameId: null, text: "A", style: style({}), version: 1, createdAt: 1, updatedAt: 1, createdBy: "Ann" };
    const b = { ...a, id: "o_0000000000b2", x: 500, y: 300, z: "a1", text: "B" };
    // Revision 6 connectors: no segments, no curve.
    const elbow = {
      id: "o_0000000000b3", type: "connector", x: 0, y: 0, w: 1, h: 1, rot: 0, z: "a2", frameId: null, text: "",
      style: style({ fill: "none", fontSize: 14, arrowEnd: "arrow" }), from: a.id, to: b.id, fromSide: "auto", toSide: "auto",
      routing: "elbow", version: 2, createdAt: 1, updatedAt: 2, createdBy: "Ann",
    };
    const straight = { ...elbow, id: "o_0000000000b4", z: "a3", routing: "straight" };
    await repo.commit({ meta, putObjects: [a, b, elbow, straight], history: [] });
    expect(migrate(meta)).toBe(meta);
    const board = createWhiteboard(repo);
    const snap = await board.getBoard();
    expect(snap.objects[elbow.id]).toEqual(elbow);
    expect(snap.objects[straight.id]).toEqual(straight);
    const svg = await board.exportSvg();
    expect(svg).toContain(`data-id="${elbow.id}"`);
    // An edit, then undo: the connector reads as having no edits again.
    const r = await apply(board, { by: "Bob", objectOps: [updateOp(elbow.id, 2, { segments: [10], fromSide: "right", toSide: "left" })] });
    expect(r.upserts[0].segments).toEqual([10]);
    const u = await board.undo({ by: "Bob" });
    const back = u.result.upserts.find((o) => o.id === elbow.id);
    expect(back.segments).toEqual([]);
    expect(back).toMatchObject({ fromSide: "auto", toSide: "auto", routing: "elbow" });
    expect((await board.exportSvg())).toBe(svg);
    expect((await repo.getMeta()).schemaVersion).toBe(1);
  });
});
