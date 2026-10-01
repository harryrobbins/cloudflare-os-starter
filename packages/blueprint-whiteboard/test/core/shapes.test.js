import { describe, expect, it } from "vitest";
import { apply, create, oid, setup, updateOp } from "./helpers.js";

describe("shapes and connector markers through the board", () => {
  it("addObjects takes shape names as types or fields, and rejects unknown shapes", async () => {
    const { board } = setup();
    const { created, errors } = await board.addObjects({
      by: "Assistant",
      objects: [
        { type: "diamond", x: 0, y: 0, text: "OK?" },
        { type: "rect", shape: "cylinder", x: 300, y: 0, dash: "dashed" },
        { type: "rect", shape: "blob" },
        { type: "ellipse", dash: "dotted" },
      ],
    });
    expect(created.map((o) => [o.type, o.style.shape, o.style.dash])).toEqual([
      ["rect", "diamond", "solid"], ["rect", "cylinder", "dashed"], ["ellipse", undefined, "dotted"],
    ]);
    expect(errors.map((e) => [e.index, e.code])).toEqual([[2, "invalid_op"]]);
    expect(errors[0].message).toMatch(/Unknown shape blob/);
  });

  it("updateObjects changes a shape by name; undo puts it back", async () => {
    const { board } = setup();
    const { id } = await create(board, { type: "rect" });
    const r = await board.updateObjects({ by: "Ann", updates: [{ id, fields: { shape: "hexagon" } }] });
    expect(r.result.upserts[0].style.shape).toBe("hexagon");
    await board.undo({ by: "Ann" });
    expect((await board.getBoard()).objects[id].style.shape).toBe("rect");
  });

  it("undo restores the fallback on an object stored before the key existed", async () => {
    const first = setup();
    const { id, obj } = await create(first.board, { type: "rect" });
    // An older rectangle: no shape or dash in its style. A new board instance loads it as stored.
    const { shape, dash, ...older } = obj.style;
    first.repo.objects.set(id, { ...obj, style: older });
    const { createWhiteboard } = await import("../../src/core/whiteboard.js");
    let t = 1_800_000_000_000;
    const board = createWhiteboard(first.repo, { now: () => (t += 1000) });
    const r = await apply(board, { by: "Ann", objectOps: [updateOp(id, obj.version, { style: { shape: "star", dash: "dashed" } })] });
    expect(r.upserts[0].style).toMatchObject({ shape: "star", dash: "dashed" });
    await board.undo({ by: "Ann" });
    const back = (await board.getBoard()).objects[id].style;
    expect(back.shape).toBe("rect");
    expect(back.dash).toBe("solid");
  });

  it("connectObjects takes end markers and a line pattern", async () => {
    const { board } = setup();
    const a = await create(board, { type: "rect" });
    const b = await create(board, { type: "rect", x: 400 });
    const r = await board.connect({ from: a.id, to: b.id, startMarker: "bar", endMarker: "crow", dash: "dashed" });
    expect(r.connector.style).toMatchObject({ arrowStart: "bar", arrowEnd: "crow", dash: "dashed" });
    const plain = await board.connect({ from: a.id, to: b.id, arrow: "both", endMarker: "bogus" });
    expect(plain.connector.style).toMatchObject({ arrowStart: "arrow", arrowEnd: "arrow", dash: "solid" });
  });

  it("a connector and a new shape created in one request undo together", async () => {
    const { board } = setup();
    const { id: from } = await create(board, { type: "rect", style: { shape: "diamond" } });
    const to = oid();
    const r = await apply(board, {
      by: "Ann", objectOps: [
        { op: "create", object: { id: to, type: "rect", x: 400, y: 0, style: { shape: "diamond" } } },
        { op: "create", object: { id: oid(), type: "connector", from, to } },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.upserts).toHaveLength(2);
    await board.undo({ by: "Ann" });
    expect(Object.keys((await board.getBoard()).objects)).toEqual([from]);
  });
});
