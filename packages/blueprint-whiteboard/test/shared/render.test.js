import { describe, expect, it } from "vitest";
import { EXPORT_TEXT_BUDGET, boardToSvg, escapeXml, objectNode, serialize } from "../../src/shared/render.js";
import { normalizeNewObject } from "../../src/shared/protocol.js";

const oid = (n) => "o_" + n.toString(16).padStart(12, "0");
const make = (fields) => ({ ...normalizeNewObject(fields), z: fields.z ?? "a0", version: 1, createdAt: 0, updatedAt: 0, createdBy: "t" });
const CTRL = String.fromCharCode(1);

function board(list) {
  return {
    schemaVersion: 1, revision: 1, title: "Plan <Q4> & more", background: "dots", lastModified: 0,
    objects: Object.fromEntries(list.map((o) => [o.id, o])),
  };
}

describe("render", () => {
  const sticky = make({ id: oid(1), type: "sticky", x: 0, y: 0, text: 'Hello <b>"x"</b> & bye' + CTRL });
  const ellipse = make({ id: oid(2), type: "ellipse", x: 400, y: 0, rot: 30, text: "E" });
  const frame = make({ id: oid(3), type: "frame", x: -100, y: -100, w: 1000, h: 600, text: "Frame A" });
  const conn = make({ id: oid(4), type: "connector", from: oid(1), to: oid(2), text: "to", style: { arrowStart: "arrow" } });
  const pen = make({ id: oid(5), type: "pen", x: 0, y: 300, w: 100, h: 20, points: [0, 0, 0.5, 1, 1, 0] });
  const dangling = make({ id: oid(6), type: "connector", from: oid(1), to: oid(99) });

  it("escapes text and strips forbidden XML characters", () => {
    expect(escapeXml('<a href="x">&</a>' + CTRL)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  it("renders every object with data-id, rotation and arrowheads", () => {
    const svg = boardToSvg(board([sticky, ellipse, frame, conn, pen, dangling]));
    expect(svg.startsWith("<?xml")).toBe(true);
    for (const id of [oid(1), oid(2), oid(3), oid(4), oid(5)]) expect(svg).toContain(`data-id="${id}"`);
    expect(svg).not.toContain(`data-id="${oid(6)}"`);
    expect(svg).toContain("rotate(30 500 60)");
    expect(svg.match(/<polygon/g)).toHaveLength(2);
    expect(svg).toContain("<title>Plan &lt;Q4&gt; &amp; more</title>");
    expect(svg).not.toContain("<b>");
    expect(svg).not.toContain(CTRL);
    // Frames render first (below everything).
    expect(svg.indexOf(oid(3))).toBeLessThan(svg.indexOf(oid(1)));
  });

  it("exports one frame with its members and connectors between them", () => {
    const member = { ...sticky, frameId: oid(3) };
    const outside = make({ id: oid(7), type: "rect", x: 5000, y: 5000 });
    const svg = boardToSvg(board([member, ellipse, frame, conn, outside]), { frameId: oid(3) });
    expect(svg).toContain(oid(1));
    expect(svg).not.toContain(oid(7));
    expect(svg).not.toContain(oid(4)); // the ellipse is not a member, so its connector is left out
  });

  it("uses resolve for connector endpoints so ghosts can be followed", () => {
    const moved = { ...ellipse, x: 1000 };
    const node = objectNode(conn, (id) => (id === oid(2) ? moved : sticky));
    expect(serialize(node)).not.toBe(serialize(objectNode(conn, (id) => (id === oid(2) ? ellipse : sticky))));
    // Automatic sides: the (rotated) ellipse's left side, the shortest pair that crosses neither box.
    expect(serialize(node)).toContain("M200 100L1013.4 10");
    expect(objectNode(conn, () => undefined)).toBeNull();
  });

  it("lays out at most EXPORT_TEXT_BUDGET characters of text, cutting with an ellipsis", () => {
    const text = "word ".repeat(800); // 4000 chars
    const n = Math.ceil(EXPORT_TEXT_BUDGET / text.length) + 3;
    const list = Array.from({ length: n }, (_, i) => make({ id: oid(i + 1), type: "text", x: 0, y: i * 50, w: 100_000, h: 40, text, z: "a" + String(i % 10) }));
    list[Math.floor(EXPORT_TEXT_BUDGET / text.length)] = { ...list[Math.floor(EXPORT_TEXT_BUDGET / text.length)], text: "x".repeat(10) + text };
    const t = performance.now();
    const svg = boardToSvg(board(list));
    expect(performance.now() - t).toBeLessThan(1000);
    for (let i = 1; i <= n; i++) expect(svg).toContain(`data-id="${oid(i)}"`);
    expect((svg.match(/<text /g) ?? []).length).toBeLessThanOrEqual(Math.ceil(EXPORT_TEXT_BUDGET / text.length) + 1);
    expect(svg).toContain("…");
    // A small board is unaffected.
    expect(boardToSvg(board([sticky]))).not.toContain("…");
  });

  it("renders an empty board", () => {
    expect(boardToSvg(board([]))).toMatch(/<svg[^>]+viewBox=/);
  });
});
