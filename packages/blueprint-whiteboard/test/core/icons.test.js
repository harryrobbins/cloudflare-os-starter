// Icons in the whiteboard rules: validation through the normal create/update path, defaults,
// undo, history summaries, the findIcons/addIcons convenience methods, and compatibility of
// boards stored before icons existed (no schemaVersion change).
import { describe, expect, it } from "vitest";
import { COLORS, LIMITS, SCHEMA_VERSION } from "../../src/shared/protocol.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { createWhiteboard, migrate } from "../../src/core/whiteboard.js";
import { apply, create, oid, setup, updateOp } from "./helpers.js";

const icon = (packId, iconId, extra = {}) => ({ type: "icon", packId, iconId, ...extra });

describe("icon objects", () => {
  it("creates icons with their pack's size and style; glyphs hold no text", async () => {
    const { board } = setup();
    const { obj: stencil } = await create(board, icon("core.1", "decision", { x: 10, y: 20, text: "Ship?" }));
    expect(stencil).toMatchObject({ type: "icon", packId: "core.1", iconId: "decision", w: 160, h: 100, text: "Ship?", style: { fill: "#ffffff" } });
    const { obj: glyph } = await create(board, icon("tabler.1", "user", { text: "dropped", w: 50, style: { stroke: "#dc2626" } }));
    expect(glyph).toMatchObject({ w: 50, h: 96, text: "", style: { fill: "none", stroke: "#dc2626", strokeWidth: 2 } });
  });

  it("rejects unknown or malformed icon references as invalid_ref, never storing them", async () => {
    const { board } = setup();
    const result = await apply(board, {
      objectOps: [
        { op: "create", object: { id: oid(), ...icon("tabler.1", "no-such-icon") } },
        { op: "create", object: { id: oid(), ...icon("tabler.9", "user") } },
        { op: "create", object: { id: oid(), ...icon("<svg onload=x>", "user") } },
        { op: "create", object: { id: oid(), type: "icon" } },
        { op: "create", object: { id: oid(), ...icon("tabler.1", "user"), markup: "<svg/>", d: "M0 0" } },
      ],
    });
    expect(result.errors.map((e) => [e.index, e.code])).toEqual([[0, "invalid_ref"], [1, "invalid_ref"], [2, "invalid_ref"], [3, "invalid_ref"]]);
    expect(result.upserts).toHaveLength(1);
    // Unknown fields (markup, path data) are never stored.
    expect(result.upserts[0]).not.toHaveProperty("markup");
    expect(result.upserts[0]).not.toHaveProperty("d");
  });

  it("swaps icons by update, keeps text only where the new icon holds it, and undoes the swap", async () => {
    const { board } = setup();
    const { obj } = await create(board, icon("core.1", "process", { text: "Step" }), { by: "Ann" });
    let r = await apply(board, { by: "Ann", objectOps: [updateOp(obj.id, 1, { iconId: "decision" })] });
    expect(r.upserts[0]).toMatchObject({ iconId: "decision", text: "Step" });
    expect(r.history.summary).toBe("Edited a decision shape");
    r = await apply(board, { by: "Ann", objectOps: [updateOp(obj.id, 2, { iconId: "nope" })] });
    expect(r.errors[0].code).toBe("invalid_ref");
    r = await apply(board, { by: "Ann", objectOps: [updateOp(obj.id, 2, { packId: "tabler.1", iconId: "server" })] });
    expect(r.upserts[0]).toMatchObject({ packId: "tabler.1", iconId: "server", text: "" });
    const undone = (await board.undo({ by: "Ann" })).result;
    expect(undone.upserts[0]).toMatchObject({ packId: "core.1", iconId: "decision", text: "Step" });
  });

  it("names icons in history summaries", async () => {
    const { board } = setup();
    const { result } = await create(board, icon("tabler.1", "user"));
    expect(result.history.summary).toBe("Added a user icon");
    const { obj, result: r2 } = await create(board, icon("core.1", "actor"));
    expect(r2.history.summary).toBe("Added a user (actor) shape");
    expect((await create(board, icon("tabler.1", "activity"))).result.history.summary).toBe("Added an activity icon");
    const del = await apply(board, { objectOps: [{ op: "delete", id: obj.id, baseVersion: 1 }] });
    expect(del.history.summary).toBe("Deleted a user (actor) shape");
  });

  it("applies the usual limits: text length, rotation, clamped geometry, the object cap", async () => {
    const { board } = setup({ limits: { objects: 2 } });
    const { obj } = await create(board, icon("core.1", "note", { text: "x".repeat(LIMITS.text + 50), rot: 725, x: 5e9 }));
    expect(obj.text).toHaveLength(LIMITS.text);
    expect(obj.rot).toBe(5);
    expect(obj.x).toBe(LIMITS.coord);
    await create(board, icon("tabler.1", "user"));
    const { result } = await create(board, icon("tabler.1", "user"));
    expect(result.errors[0].code).toBe("limit");
  });

  it("carries icons through duplicate-style creates and connectors", async () => {
    const { board } = setup();
    const { obj: a } = await create(board, icon("core.1", "database"));
    const { obj: b } = await create(board, icon("tabler.1", "server"));
    const { connector, errors } = await board.connect({ from: a.id, to: b.id });
    expect(errors).toEqual([]);
    expect(connector).toMatchObject({ from: a.id, to: b.id });
    expect(await board.findObjects({ type: "icon" })).toHaveLength(2);
    expect(await board.exportSvg()).toContain(`data-id="${a.id}"`);
  });
});

describe("findIcons", () => {
  it("returns summaries best first, with a clamped limit", () => {
    const { board } = setup();
    const found = board.findIcons({ query: "database", limit: 3 });
    expect(found.length).toBeLessThanOrEqual(3);
    expect(found[0]).toEqual(expect.objectContaining({ iconId: "database", label: "Database" }));
    expect(Object.keys(found[0]).sort()).toEqual(["aspect", "category", "categoryLabel", "iconId", "kind", "label", "packId", "tags", "text"]);
    expect(board.findIcons("cloud").length).toBeGreaterThan(1);
    expect(board.findIcons({ limit: 1e6 })).toHaveLength(100);
    expect(board.findIcons({ query: "user", packId: "core.1" }).every((i) => i.packId === "core.1")).toBe(true);
    expect(board.findIcons(null)).toHaveLength(20);
  });
});

describe("addIcons", () => {
  it("adds icons by reference in a centred grid right of existing content", async () => {
    const { board } = setup();
    await create(board, { x: 0, y: 0, w: 200, h: 200 });
    const { created, errors, event } = await board.addIcons({
      by: "Assistant", senderId: "agent", icons: ["core.1/decision", "user", { packId: "tabler.1", iconId: "cloud" }],
    });
    expect(errors).toEqual([]);
    expect(created.map((o) => `${o.packId}/${o.iconId}`)).toEqual(["core.1/decision", "tabler.1/user", "tabler.1/cloud"]);
    // Two columns of 160 x 100 cells (the decision), each icon centred in its cell.
    expect(created.map((o) => [o.x, o.y])).toEqual([[400, 0], [632, 2], [432, 142]]);
    expect(event.history.summary).toBe("Added 3 objects");
    expect(created.every((o) => o.createdBy === "Assistant")).toBe(true);
  });

  it("takes explicit geometry, size, colour, text and frames", async () => {
    const { board } = setup();
    const frame = (await create(board, { type: "frame", text: "Infra", x: 1000, y: 1000 })).obj;
    const { created, errors } = await board.addIcons({
      frame: "infra",
      icons: [
        { icon: "tabler.1/server", size: 48, color: "red" },
        { icon: "core.1/database", x: 5, y: 6, w: 100, h: 140, color: "blue", text: "Orders" },
        { iconId: "queue", frame: null, at: 1 },
      ],
    });
    expect(errors).toEqual([]);
    expect(created[0]).toMatchObject({ w: 48, h: 48, frameId: frame.id, style: { stroke: COLORS.red, fill: "none" } });
    expect(created[1]).toMatchObject({ x: 5, y: 6, w: 100, h: 140, text: "Orders", style: { fill: COLORS.blue } });
    expect(created[2]).toMatchObject({ iconId: "queue", frameId: null });
  });

  it("reports bad items by index and applies the rest", async () => {
    const { board } = setup();
    const { created, errors } = await board.addIcons({ icons: ["tabler.1/user", "no-such-icon", 42, { icon: "core.1/cloud", color: "sparkly" }] });
    expect(created).toHaveLength(1);
    expect(errors.map((e) => [e.index, e.code])).toEqual([[1, "invalid_ref"], [2, "invalid_op"], [3, "invalid_op"]]);
    expect(errors[0].message).toMatch(/findIcons/);
    const none = await board.addIcons({ icons: "user" });
    expect(none.errors[0].code).toBe("invalid_op");
    const many = await board.addIcons({ icons: Array(LIMITS.opsPerRequest + 1).fill("user") });
    expect(many).toMatchObject({ created: [], errors: [{ code: "limit" }] });
    const noFrame = await board.addIcons({ icons: ["user"], frame: "Nowhere" });
    expect(noFrame.errors[0].code).toBe("invalid_ref");
  });

  it("recolours icons through updateObjects: glyphs by line colour, stencils by fill", async () => {
    const { board } = setup();
    const { created } = await board.addIcons({ icons: ["tabler.1/user", "core.1/process"] });
    const r = (await board.updateObjects({ updates: created.map((o) => ({ id: o.id, fields: { color: "green" } })) })).result;
    expect(r.upserts.find((o) => o.iconId === "user").style.stroke).toBe(COLORS.green);
    expect(r.upserts.find((o) => o.iconId === "process").style.fill).toBe(COLORS.green);
  });
});

describe("stored data compatibility", () => {
  it("keeps schemaVersion 1: a board stored before icons existed loads unchanged", async () => {
    expect(SCHEMA_VERSION).toBe(1);
    const repo = new InMemoryRepository();
    const meta = { schemaVersion: 1, revision: 7, title: "Legacy", background: "grid", lastModified: 123 };
    const sticky = {
      id: "o_0000000000a1", type: "sticky", x: 0, y: 0, w: 200, h: 200, rot: 0, z: "a0", frameId: null, text: "old",
      style: { fill: "#fff3a0", stroke: "none", strokeWidth: 0, textColor: "#1f2937", fontSize: 20, align: "center", arrowStart: "none", arrowEnd: "none" },
      version: 3, createdAt: 1, updatedAt: 2, createdBy: "Ann",
    };
    await repo.commit({ meta, putObjects: [sticky], history: [] });
    expect(migrate(meta)).toBe(meta); // nothing to migrate
    const board = createWhiteboard(repo);
    const snap = await board.getBoard();
    expect(snap).toMatchObject({ schemaVersion: 1, revision: 7, title: "Legacy" });
    expect(snap.objects[sticky.id]).toEqual(sticky);
    // Adding an icon to it is an ordinary write.
    const { created } = await board.addIcons({ icons: ["user"] });
    expect(created).toHaveLength(1);
    expect((await repo.getMeta()).schemaVersion).toBe(1);
  });
});
