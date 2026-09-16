// Convenience methods for agents: placement, colours and frames by name, grids, connectors, export.
import { describe, expect, it } from "vitest";
import { COLORS, LIMITS } from "../../src/shared/protocol.js";
import { apply, create, oid, pen, setup, updateOp } from "./helpers.js";

describe("addStickies", () => {
  it("places a grid at 0,0 on an empty board, ceil(sqrt(n)) columns, gap 40, colours by name", async () => {
    const { board, events } = setup();
    const { created, errors, event } = await board.addStickies({
      by: "Assistant", senderId: "agent",
      stickies: ["one", "two", { text: "three", color: "Green" }, { text: "four", color: "#AABBCC" }, "five"],
    });
    expect(errors).toEqual([]);
    expect(created.map((o) => [o.text, o.x, o.y])).toEqual([
      ["one", 0, 0], ["two", 240, 0], ["three", 480, 0], ["four", 0, 240], ["five", 240, 240],
    ]);
    expect(created[2].style.fill).toBe(COLORS.green);
    expect(created[3].style.fill).toBe("#aabbcc");
    expect(created.every((o) => o.createdBy === "Assistant" && o.type === "sticky")).toBe(true);
    expect(event).toBe(events.at(-1));
    expect(event.senderId).toBe("agent");
    expect(event.history.summary).toBe("Added 5 objects");
  });

  it("places right of existing content at its top, or at `at`, with columns and gap", async () => {
    const { board } = setup();
    await create(board, { x: -100, y: 50, w: 300, h: 100 });
    await create(board, { type: "rect", x: 500, y: -20, w: 100, h: 100 });
    let { created } = await board.addStickies({ stickies: ["a", "b"] });
    expect(created.map((o) => [o.x, o.y])).toEqual([[800, -20], [1040, -20]]);
    ({ created } = await board.addStickies({ stickies: ["a", "b", "c"], at: { x: 10, y: 20 }, columns: 1, gap: 0 }));
    expect(created.map((o) => [o.x, o.y])).toEqual([[10, 20], [10, 220], [10, 420]]);
  });

  it("inside a frame by name: top-left + 40 and members", async () => {
    const { board } = setup();
    const frame = await create(board, { type: "frame", text: "Planning", x: 1000, y: 2000 });
    const { created } = await board.addStickies({ stickies: ["x"], frame: "  planning " });
    expect(created[0]).toMatchObject({ x: 1040, y: 2040, frameId: frame.id });
    const byId = await board.addStickies({ stickies: ["y"], frame: frame.id, at: { x: 5, y: 5 } });
    expect(byId.created[0]).toMatchObject({ x: 5, y: 5, frameId: frame.id });
    const missing = await board.addStickies({ stickies: ["z"], frame: "Nope" });
    expect(missing).toMatchObject({ created: [], event: null });
    expect(missing.errors[0]).toMatchObject({ index: -1, code: "invalid_ref" });
  });

  it("reports bad items by their index and still adds the rest", async () => {
    const { board } = setup();
    const { created, errors } = await board.addStickies({ stickies: ["ok", 5, { text: "bad", color: "chartreuse" }, "ok2"] });
    expect(created.map((o) => o.text)).toEqual(["ok", "ok2"]);
    expect(errors.map((e) => [e.index, e.code])).toEqual([[1, "invalid_op"], [2, "invalid_op"]]);
    expect((await board.addStickies({})).errors[0].code).toBe("invalid_op");
    expect((await board.addStickies(null)).created).toEqual([]);
  });
});

describe("addObjects", () => {
  it("creates mixed objects, colour by type, errors by index; connectors may use ids from the batch", async () => {
    const { board } = setup();
    const a = oid();
    const { created, errors } = await board.addObjects({
      by: "Assistant",
      objects: [
        { id: a, type: "rect", x: 0, y: 400, w: 300, h: 120, text: "Decision", color: "blue" },
        { type: "text", x: 0, y: -80, text: "Q4 priorities", style: { fontSize: 48 } },
        { type: "star" },
        { ...pen(), color: "red" },
        "nope",
        { type: "connector", from: a, to: "o_ffffffffffff" },
      ],
    });
    expect(created.map((o) => o.type)).toEqual(["rect", "text", "pen"]);
    expect(created[0]).toMatchObject({ id: a, style: { fill: COLORS.blue } });
    expect(created[1].style.fontSize).toBe(48);
    expect(created[2].style.stroke).toBe(COLORS.red);
    expect(errors.map((e) => [e.index, e.code])).toEqual([[2, "invalid_op"], [4, "invalid_op"], [5, "invalid_ref"]]);
    const dup = await board.addObjects({ objects: [{ id: a, type: "sticky" }] });
    expect(dup.errors[0]).toMatchObject({ index: 0, code: "exists" });
  });
});

describe("updateObjects, moveObjects, deleteObjects", () => {
  it("updateObjects reads versions itself, maps color and frame names", async () => {
    const { board } = setup();
    const frame = await create(board, { type: "frame", text: "Themes" });
    const s = await create(board);
    await apply(board, { objectOps: [updateOp(s.id, 1, { x: 1 })] }); // version 2 now
    const conn = await create(board, { type: "connector", from: frame.id, to: s.id });
    const { result } = await board.updateObjects({
      by: "Assistant",
      updates: [
        { id: s.id, fields: { text: "Renamed", color: "pink", frame: "themes", type: "rect", id: "o_000000000000" } },
        { id: conn.id, fields: { color: "red", label: "ignored", text: "label" } },
        { id: "o_ffffffffffff", fields: { text: "x" } },
        { id: s.id, fields: { frame: "Nope" } },
      ],
    });
    expect(result.status).toBe("applied");
    expect(result.upserts.find((o) => o.id === s.id)).toMatchObject({ type: "sticky", text: "Renamed", frameId: frame.id, style: { fill: COLORS.pink }, version: 3 });
    expect(result.upserts.find((o) => o.id === conn.id)).toMatchObject({ text: "label", style: { stroke: COLORS.red } });
    expect(result.errors.map((e) => [e.index, e.code])).toEqual([[2, "unknown_object"], [3, "invalid_ref"]]);
    const cleared = await board.updateObjects({ updates: [{ id: s.id, fields: { frame: null } }] });
    expect(cleared.result.upserts[0].frameId).toBeNull();
  });

  it("moveObjects moves by a delta, skips connectors, reports unknown ids", async () => {
    const { board } = setup();
    const a = await create(board, { x: 10, y: 10 }), b = await create(board, { x: -5, y: 0 });
    const conn = await create(board, { type: "connector", from: a.id, to: b.id });
    const { result } = await board.moveObjects({ ids: [a.id, b.id, conn.id, "o_ffffffffffff", a.id], dx: 100, dy: -10, by: "Bot" });
    expect(result.upserts.map((o) => [o.id, o.x, o.y])).toEqual([[a.id, 110, 0], [b.id, 95, -10]]);
    expect(result.errors.map((e) => e.code)).toEqual(["unknown_object"]);
    expect(result.history.summary).toBe("Moved 2 objects");
    const none = await board.moveObjects({ ids: "x" });
    expect(none.result.status).toBe("unchanged");
  });

  it("deleteObjects deletes listed connectors and cascades the rest, without conflicts", async () => {
    const { board } = setup();
    const a = await create(board), b = await create(board), c = await create(board);
    const ab = await create(board, { type: "connector", from: a.id, to: b.id });
    const bc = await create(board, { type: "connector", from: b.id, to: c.id });
    const { result } = await board.deleteObjects({ ids: [a.id, ab.id, b.id] });
    expect(result).toMatchObject({ status: "applied", conflicts: [], errors: [] });
    expect(result.deletes.sort()).toEqual([a.id, b.id, ab.id, bc.id].sort());
    expect(result.history.summary).toBe("Deleted 3 objects");
  });
});

describe("arrangeGrid", () => {
  it("keeps the given order, row-major, cell = max w/h of the set, origin = top-left of the set", async () => {
    const { board } = setup();
    const a = await create(board, { x: 500, y: 500, w: 100, h: 50 });
    const b = await create(board, { x: 300, y: 900, w: 200, h: 80 });
    const c = await create(board, { x: 700, y: 400 });
    const { result } = await board.arrangeGrid({ ids: [c.id, a.id, b.id], columns: 2, gap: 10 });
    const pos = Object.fromEntries(result.upserts.map((o) => [o.id, [o.x, o.y]]));
    // cell 200 x 200 (c is a 200x200 sticky), origin (300, 400)
    expect(pos[c.id]).toEqual([300, 400]);
    expect(pos[a.id]).toEqual([510, 400]);
    expect(pos[b.id]).toEqual([300, 610]);
    const at = await board.arrangeGrid({ ids: [a.id, b.id], at: { x: 0, y: 0 } });
    expect(at.result.upserts.map((o) => [o.x, o.y])).toEqual([[0, 0], [240, 0]]);
  });
});

describe("addFrame", () => {
  it("sizes the frame around `contains` with padding and room for the name, and makes them members", async () => {
    const { board } = setup();
    const a = await create(board, { x: 0, y: 0 }), b = await create(board, { x: 400, y: 300 });
    const { frame, result, event } = await board.addFrame({ name: "Themes", contains: [a.id, b.id, "o_ffffffffffff"], by: "Bot" });
    expect(frame).toMatchObject({ type: "frame", text: "Themes", x: -60, w: 720, frameId: null });
    expect(frame.y).toBeLessThan(-60);
    expect(frame.y + frame.h).toBe(560);
    expect(result.upserts.filter((o) => o.type === "sticky").every((o) => o.frameId === frame.id)).toBe(true);
    expect(result.errors).toEqual([expect.objectContaining({ code: "unknown_object" })]);
    expect(event.upserts).toHaveLength(3);
    expect((await board.getFrame("THEMES")).objects.map((o) => o.id).sort()).toEqual([a.id, b.id].sort());
    expect(await board.getFrame("nope")).toBeNull();
  });

  it("with geometry, or placed right of content with the default size", async () => {
    const { board } = setup();
    let { frame } = await board.addFrame({ name: "A", x: 1, y: 2, w: 3, h: 4 });
    expect(frame).toMatchObject({ x: 1, y: 2, w: 3, h: 4 });
    ({ frame } = await board.addFrame({ name: "" }));
    expect(frame).toMatchObject({ text: "Frame", x: 204, y: 2, w: 800, h: 600 });
  });

  it("reports the frame cap", async () => {
    const { board } = setup({ limits: { frames: 1 } });
    await board.addFrame({ name: "one" });
    const r = await board.addFrame({ name: "two" });
    expect(r.frame).toBeNull();
    expect(r.result.errors[0].code).toBe("limit");
    expect(LIMITS.frames).toBe(50);
  });
});

describe("connect", () => {
  it("creates a connector with label, routing and arrows", async () => {
    const { board } = setup();
    const a = await create(board), b = await create(board);
    let r = await board.connect({ from: a.id, to: b.id, label: "blocks", routing: "elbow", by: "Bot" });
    expect(r.errors).toEqual([]);
    expect(r.connector).toMatchObject({ from: a.id, to: b.id, text: "blocks", routing: "elbow", style: { arrowStart: "none", arrowEnd: "arrow" } });
    r = await board.connect({ from: a.id, to: b.id, arrow: "both", color: "purple" });
    expect(r.connector.style).toMatchObject({ arrowStart: "arrow", arrowEnd: "arrow", stroke: COLORS.purple });
    r = await board.connect({ from: a.id, to: b.id, arrow: "none" });
    expect(r.connector.style).toMatchObject({ arrowStart: "none", arrowEnd: "none" });
    r = await board.connect({ from: a.id, to: a.id });
    expect(r).toMatchObject({ connector: null, errors: [expect.objectContaining({ code: "invalid_ref" })] });
  });
});

describe("findObjects", () => {
  it("filters by type, text, frame and within; bottom to top", async () => {
    const { board } = setup();
    const frame = await create(board, { type: "frame", text: "Planning", x: 0, y: 0 });
    const q4 = await create(board, { text: "Q4 hiring", frameId: frame.id, x: 10, y: 10 });
    const other = await create(board, { type: "rect", text: "q4 budget", x: 5000, y: 5000 });
    await create(board, { text: "unrelated", x: 20, y: 20 });
    expect((await board.findObjects({ text: "Q4" })).map((o) => o.id)).toEqual([q4.id, other.id]);
    expect((await board.findObjects({ type: "sticky", text: "q4", frame: "planning" })).map((o) => o.id)).toEqual([q4.id]);
    expect((await board.findObjects({ type: ["rect", "frame"] })).map((o) => o.id)).toEqual([frame.id, other.id]);
    expect((await board.findObjects({ within: { x: 4900, y: 4900, w: 200, h: 200 } })).map((o) => o.id)).toEqual([other.id]);
    expect(await board.findObjects({ frame: "missing" })).toEqual([]);
    expect(await board.findObjects()).toHaveLength(4);
  });
});

describe("exportSvg", () => {
  it("renders a well-formed SVG with escaped text, for the board or one frame", async () => {
    const { board } = setup();
    await apply(board, { structure: { title: "<Board> & \"co\"" } });
    const frame = await create(board, { type: "frame", text: "F & <f>", x: 0, y: 0 });
    const inFrame = await create(board, { text: "a < b & \"c\"", frameId: frame.id, x: 20, y: 40 });
    const outside = await create(board, { text: "outside</text><script>", x: 3000, y: 0 });
    await create(board, { type: "connector", from: inFrame.id, to: outside.id, text: "<edge>" });
    const svg = await board.exportSvg({});
    expect(svg.startsWith("<?xml")).toBe(true);
    expect(svg).toContain("<title>&lt;Board&gt; &amp; &quot;co&quot;</title>");
    expect(svg).toContain("a &lt; b &amp; &quot;c&quot;");
    expect(svg).toContain("&lt;edge&gt;");
    expect(svg).not.toContain("<script>");
    expect(wellFormed(svg)).toBe(true);
    const only = await board.exportSvg({ frame: "f & <F>" });
    expect(only).toContain(`data-id="${inFrame.id}"`);
    expect(only).not.toContain(outside.id);
    expect(wellFormed(only)).toBe(true);
    await expect(board.exportSvg({ frame: "nope" })).rejects.toThrow(/no frame/);
    expect(wellFormed(await setup().board.exportSvg())).toBe(true);
  });
});

/** Minimal XML well-formedness: balanced tags, no raw `<` or `&` in text or attributes. */
function wellFormed(xml) {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const stack = [];
  const re = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  let m, consumed = 0;
  while ((m = re.exec(body))) {
    if (m.index !== consumed) return false;
    consumed = re.lastIndex;
    if (m[5] !== undefined) {
      if (/&(?!(amp|lt|gt|quot|apos);)/.test(m[5])) return false;
      continue;
    }
    if (/&(?!(amp|lt|gt|quot|apos);)/.test(m[3])) return false;
    if (m[1]) { if (stack.pop() !== m[2]) return false; }
    else if (!m[4]) stack.push(m[2]);
  }
  return consumed === body.length && stack.length === 0;
}
