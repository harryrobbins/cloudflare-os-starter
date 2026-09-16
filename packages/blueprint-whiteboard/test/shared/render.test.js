import { describe, expect, it } from "vitest";
import { boardToSvg, escapeXml, objectNode, serialize } from "../../src/shared/render.js";
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
    expect(serialize(node)).toContain("M200 100L1070");
    expect(objectNode(conn, () => undefined)).toBeNull();
  });

  it("renders an empty board", () => {
    expect(boardToSvg(board([]))).toMatch(/<svg[^>]+viewBox=/);
  });
});
