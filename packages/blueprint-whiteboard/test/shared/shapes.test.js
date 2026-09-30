import { describe, expect, it } from "vitest";
import {
  SHAPES, SHAPE_IDS, shapeOutline, flattenCmds, insideShape, localOutlineAnchor, shapeOf, shapeSize, cmdsToPath,
} from "../../src/shared/shapes.js";
import { cleanStylePatch, normalizeNewObject, withStyleFallbacks, ARROWHEADS } from "../../src/shared/protocol.js";
import { pointInObjectBox, outlineAnchor, textLayout } from "../../src/shared/geometry.js";
import { connectorRoute } from "../../src/shared/connectors.js";
import { objectNode, serialize, arrowMarker } from "../../src/shared/render.js";

const oid = (n) => "o_" + n.toString(16).padStart(12, "0");
const make = (fields) => ({ ...normalizeNewObject(fields), z: fields.z ?? "a0", version: 1, createdAt: 0, updatedAt: 0, createdBy: "t" });
const shaped = (shape, extra = {}) => make({ id: oid(1), type: "rect", x: 0, y: 0, w: 200, h: 120, style: { shape }, ...extra });
const SIDES = ["top", "right", "bottom", "left"];

describe("shape outlines", () => {
  it("lists unique ids with rect first and labels for each", () => {
    expect(SHAPE_IDS[0]).toBe("rect");
    expect(new Set(SHAPE_IDS).size).toBe(SHAPE_IDS.length);
    for (const s of SHAPES) expect(s.label).toBeTruthy();
    expect(SHAPE_IDS).toEqual(expect.arrayContaining(["diamond", "triangle", "hexagon", "cylinder", "document", "cloud", "star"]));
  });

  for (const id of SHAPE_IDS) {
    it(`${id}: closed outline inside its box, text box inside too, centre inside, anchors on the outline`, () => {
      for (const [w, h] of [[200, 120], [80, 300], [shapeSize(id).w, shapeSize(id).h]]) {
        const g = shapeOutline(id, w, h);
        expect(g.cmds[0][0]).toBe("M");
        expect(g.cmds.at(-1)).toEqual(["Z"]);
        for (const p of flattenCmds(g.cmds)) {
          expect(p.x).toBeGreaterThanOrEqual(-0.01); expect(p.x).toBeLessThanOrEqual(w + 0.01);
          expect(p.y).toBeGreaterThanOrEqual(-0.01); expect(p.y).toBeLessThanOrEqual(h + 0.01);
        }
        const t = g.text;
        expect(t.x).toBeGreaterThanOrEqual(0); expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.x + t.w).toBeLessThanOrEqual(w + 0.01); expect(t.y + t.h).toBeLessThanOrEqual(h + 0.01);
        expect(insideShape(id, w, h, t.x + t.w / 2, t.y + t.h / 2)).toBe(true);
        for (const side of SIDES) {
          const a = localOutlineAnchor(id, w, h, side);
          expect(a).not.toBeNull();
          // On the axis through the centre, within the box.
          if (side === "left" || side === "right") expect(a.y).toBeCloseTo(h / 2);
          else expect(a.x).toBeCloseTo(w / 2);
          expect(a.x).toBeGreaterThanOrEqual(-0.01); expect(a.x).toBeLessThanOrEqual(w + 0.01);
        }
        expect(cmdsToPath(g.cmds, 10, 20)).not.toMatch(/NaN|Infinity/);
      }
    });
  }

  it("puts anchors where diagrams expect them", () => {
    expect(localOutlineAnchor("diamond", 200, 120, "left")).toEqual({ x: 0, y: 60 });
    expect(localOutlineAnchor("diamond", 200, 120, "top")).toEqual({ x: 100, y: 0 });
    const tl = localOutlineAnchor("triangle", 200, 120, "left");
    expect(tl.x).toBeCloseTo(50);
    expect(localOutlineAnchor("triangle", 200, 120, "top")).toEqual({ x: 100, y: 0 });
    expect(localOutlineAnchor("cylinder", 140, 160, "top").y).toBeCloseTo(0, 1);
  });

  it("hit tests by outline: a diamond's corners are outside", () => {
    expect(insideShape("diamond", 200, 120, 5, 5)).toBe(false);
    expect(insideShape("diamond", 200, 120, 100, 60)).toBe(true);
    const d = shaped("diamond");
    expect(pointInObjectBox(d, { x: 5, y: 5 })).toBe(false);
    expect(pointInObjectBox(d, { x: 100, y: 60 })).toBe(true);
    expect(pointInObjectBox(shaped("rect"), { x: 5, y: 5 })).toBe(true);
  });

  it("reads a missing or unknown shape as rect; other types have none", () => {
    expect(shapeOf({ type: "rect", style: {} })).toBe("rect");
    expect(shapeOf({ type: "rect", style: { shape: "blob" } })).toBe("rect");
    expect(shapeOf({ type: "ellipse", style: { shape: "diamond" } })).toBeNull();
  });

  it("lays text out in the shape's text box", () => {
    const plain = textLayout(shaped("rect", { text: "hello" }));
    const d = textLayout(shaped("diamond", { text: "hello" }));
    expect(d.w).toBeLessThan(plain.w);
    expect(d.x).toBeGreaterThan(plain.x);
  });

  it("rotates outline anchors with the object", () => {
    const o = shaped("triangle", { rot: 90 });
    const p = outlineAnchor(o, "top");
    // The apex (top) of a triangle turned 90° clockwise points right.
    expect(p.x).toBeCloseTo(160);
    expect(p.y).toBeCloseTo(60);
  });
});

describe("protocol: shape, dash and markers", () => {
  it("keeps shape for rectangles only, dash for lines and outlines, every marker for connectors", () => {
    expect(cleanStylePatch({ shape: "diamond" }, "rect")).toEqual({ shape: "diamond" });
    expect(cleanStylePatch({ shape: "blob" }, "rect")).toEqual({});
    expect(cleanStylePatch({ shape: "diamond" }, "ellipse")).toEqual({});
    expect(cleanStylePatch({ dash: "dotted" }, "connector")).toEqual({ dash: "dotted" });
    expect(cleanStylePatch({ dash: "dotted" }, "sticky")).toEqual({});
    expect(cleanStylePatch({ dash: "wavy" }, "rect")).toEqual({});
    for (const m of ARROWHEADS) expect(cleanStylePatch({ arrowEnd: m, arrowStart: m }, "connector")).toEqual({ arrowEnd: m, arrowStart: m });
    expect(cleanStylePatch({ arrowEnd: "crow" }, "rect")).toEqual({});
  });

  it("new objects carry the keys their type uses; fallbacks fill older ones", () => {
    expect(make({ id: oid(1), type: "rect" }).style).toMatchObject({ shape: "rect", dash: "solid" });
    expect(make({ id: oid(1), type: "sticky" }).style.shape).toBeUndefined();
    expect(make({ id: oid(1), type: "connector", from: oid(2), to: oid(3) }).style.dash).toBe("solid");
    expect(withStyleFallbacks("rect", { fill: "none" })).toEqual({ fill: "none", shape: "rect", dash: "solid" });
    expect(withStyleFallbacks("sticky", { fill: "none" })).toEqual({ fill: "none" });
    expect(withStyleFallbacks("rect", { shape: "star" }).shape).toBe("star");
  });
});

describe("render", () => {
  it("draws a plain rect exactly as before and a shape as a path with its detail", () => {
    expect(serialize(objectNode(shaped("rect"), () => undefined))).toContain('<rect x="0" y="0" width="200" height="120" rx="4"');
    const db = serialize(objectNode(shaped("cylinder"), () => undefined));
    expect(db.match(/<path /g)).toHaveLength(2);
    expect(serialize(objectNode(shaped("diamond"), () => undefined))).toContain('d="M100 0L200 60L100 120L0 60Z"');
  });

  it("dashes outlines and connectors", () => {
    expect(serialize(objectNode(shaped("hexagon", { style: { shape: "hexagon", dash: "dashed" } }), () => undefined))).toContain("stroke-dasharray");
    const a = shaped("rect", { id: oid(1) }), b = shaped("rect", { id: oid(2), x: 400 });
    const conn = make({ id: oid(3), type: "connector", from: oid(1), to: oid(2), style: { dash: "dotted" } });
    const svg = serialize(objectNode(conn, (id) => (id === oid(1) ? a : b)));
    expect(svg).toContain('stroke-dasharray="0 5"');
    expect(svg.match(/stroke-dasharray/g)).toHaveLength(1); // not on the hit path
  });

  it("draws every marker and cuts the line back under hollow ones", () => {
    for (const m of ARROWHEADS) {
      const r = arrowMarker(m, { x: 100, y: 0 }, { x: 1, y: 0 }, 2, "#000000");
      expect(r.nodes.length > 0).toBe(m !== "none");
      for (const n of r.nodes) expect(JSON.stringify(n)).not.toMatch(/NaN/);
    }
    const a = shaped("rect", { id: oid(1) }), b = shaped("rect", { id: oid(2), x: 400 });
    const resolve = (id) => (id === oid(1) ? a : b);
    const plain = serialize(objectNode(make({ id: oid(3), type: "connector", from: oid(1), to: oid(2) }), resolve));
    const hollow = serialize(objectNode(make({ id: oid(3), type: "connector", from: oid(1), to: oid(2), style: { arrowEnd: "triangle" } }), resolve));
    // The visible line (second path) ends before the tip at x = 400.
    const visible = (svg) => [...svg.matchAll(/<path d="([^"]+)"/g)][1][1];
    expect(visible(plain)).toBe("M200 60L400 60");
    expect(visible(hollow)).toMatch(/^M200 60L3[0-9.]+ 60$/);
    expect(hollow).toContain("<polygon");
  });
});

describe("connectors meet shaped outlines", () => {
  const diamond = shaped("diamond", { id: oid(1) });
  const box = make({ id: oid(2), type: "rect", x: 400, y: 0, w: 200, h: 120 });
  const triangle = shaped("triangle", { id: oid(3), x: 0, y: 300 });

  it("straight and curved lines start at the outline", () => {
    const s = connectorRoute({ fromSide: "right", toSide: "left" }, diamond, box);
    expect(s.points[0]).toEqual({ x: 200, y: 60 });
    const t = connectorRoute({ fromSide: "left", toSide: "left" }, triangle, box);
    expect(t.points[0].x).toBeCloseTo(50);
    const c = connectorRoute({ routing: "curved", fromSide: "left", toSide: "left" }, triangle, box);
    expect(c.cubic[0].x).toBeCloseTo(50);
  });

  it("elbows stay orthogonal with their ends on the outline", () => {
    for (const conn of [{ routing: "elbow" }, { routing: "elbow", fromSide: "left", toSide: "top" }, { routing: "elbow", segments: [40], fromSide: "bottom", toSide: "left" }]) {
      const r = connectorRoute(conn, triangle, diamond);
      for (let i = 1; i < r.points.length; i++) {
        const p = r.points[i - 1], q = r.points[i];
        expect(Math.abs(p.x - q.x) < 0.01 || Math.abs(p.y - q.y) < 0.01).toBe(true);
      }
    }
    const r = connectorRoute({ routing: "elbow", fromSide: "left", toSide: "left" }, triangle, diamond);
    expect(r.points[0].x).toBeCloseTo(50);
    expect(r.points.at(-1)).toEqual({ x: 0, y: 60 });
  });

  it("memoised routes notice a shape change", () => {
    const memo = new Map();
    const env = { candidates: () => [], memo };
    const conn = { id: oid(9), fromSide: "left", toSide: "left" };
    const r1 = connectorRoute(conn, triangle, box, env);
    const r2 = connectorRoute(conn, { ...triangle, style: { ...triangle.style, shape: "rect" } }, box, env);
    expect(r1.points[0].x).toBeCloseTo(50);
    expect(r2.points[0].x).toBe(0);
  });
});
