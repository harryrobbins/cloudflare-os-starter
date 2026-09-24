import { describe, expect, it } from "vitest";
import {
  connectorRoute, chooseSides, elbowFromSegments, segmentsFromPoints, moveElbowSegment, materializeSegments,
  routeBounds, routeMidpoint, routeDistance, routePathD, routeEndDirections, routeHandles, curveFromHandle,
  curveHandlePoint, createRouteEnv, selectObstacles, elbowPorts, routeRegion, OBSTACLE_PAD, STUB, MAX_SEGMENTS,
  CONNECTOR_STATS, resetConnectorStats, hasRouteEdits,
} from "../../src/shared/connectors.js";
import { anchor, pointsBounds } from "../../src/shared/geometry.js";
import { cubicPoint } from "../../src/shared/bezier.js";
import { segmentCrossesRect, simplifyOrthogonal } from "../../src/shared/orthogonal.js";

const box = (id, x, y, w = 100, h = 100, extra = {}) => ({ id, type: "rect", x, y, w, h, rot: 0, ...extra });

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function orthogonal(points) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (Math.abs(a.x - b.x) > 1e-6 && Math.abs(a.y - b.y) > 1e-6) return false;
  }
  return true;
}

function envOf(list, memo = false) {
  return createRouteEnv(Object.fromEntries(list.map((o) => [o.id, o])), { memo });
}

describe("automatic sides", () => {
  const a = box("o_000000000001", 0, 0), b = box("o_000000000002", 300, 0);

  it("keeps the facing pair for side-by-side objects in every style", () => {
    for (const routing of ["straight", "elbow", "curved"]) {
      expect(chooseSides({ routing }, a, b)).toEqual({ fromSide: "right", toSide: "left" });
      expect(chooseSides({ routing }, b, a)).toEqual({ fromSide: "left", toSide: "right" });
    }
    expect(connectorRoute({}, a, b).points).toEqual([{ x: 100, y: 50 }, { x: 300, y: 50 }]);
  });

  it("respects pinned sides and chooses only the free one", () => {
    expect(chooseSides({ fromSide: "top", toSide: "top" }, a, b)).toEqual({ fromSide: "top", toSide: "top" });
    expect(chooseSides({ fromSide: "bottom", routing: "elbow" }, a, box("o_000000000003", 300, 300)).fromSide).toBe("bottom");
  });

  it("overlapping boxes: the elbow never runs through either box", () => {
    const rng = prng(9);
    for (let k = 0; k < 100; k++) {
      const p = box("o_000000000001", 0, 0, 100 + rng() * 100, 60 + rng() * 100);
      const q = box("o_000000000002", (rng() - 0.5) * 150, (rng() - 0.5) * 150, 80 + rng() * 120, 60 + rng() * 120);
      const route = connectorRoute({ routing: "elbow" }, p, q);
      expect(orthogonal(route.points)).toBe(true);
      // Middle segments (not the stubs) cross the boxes no more often than the best side pair's.
      const inner = (r) => ({ x: r.x + 0.5, y: r.y + 0.5, w: r.w - 1, h: r.h - 1 });
      const crossings = (pts) => pts.slice(1, -2).reduce((n, pt, i) =>
        n + (segmentCrossesRect(pt, pts[i + 2], inner(p)) ? 1 : 0) + (segmentCrossesRect(pt, pts[i + 2], inner(q)) ? 1 : 0), 0);
      let best = Infinity;
      for (const fs of ["top", "right", "bottom", "left"]) for (const ts of ["top", "right", "bottom", "left"]) {
        best = Math.min(best, crossings(connectorRoute({ routing: "elbow", fromSide: fs, toSide: ts }, p, q).points));
      }
      expect(crossings(route.points)).toBe(best);
    }
  });

  it("a target above and to the right gets a shorter pair than facing centres would", () => {
    const q = box("o_000000000002", 400, -400);
    const s = chooseSides({ routing: "elbow" }, a, q);
    // One bend (perpendicular sides) beats the two-bend Z the facing rule gives.
    expect(["top", "right"]).toContain(s.fromSide);
    expect(["bottom", "left"]).toContain(s.toSide);
    expect(connectorRoute({ routing: "elbow" }, a, q).points.length).toBeLessThanOrEqual(5);
  });
});

describe("curved connectors", () => {
  const a = box("o_000000000001", 0, 0), b = box("o_000000000002", 400, 200);

  it("leave each anchor along the side normal and draw as one SVG cubic", () => {
    const r = connectorRoute({ routing: "curved" }, a, b);
    expect(r.kind).toBe("cubic");
    const [p0, c1, c2, p3] = r.cubic;
    const fa = anchor(a, r.fromSide), tb = anchor(b, r.toSide);
    expect(p0).toEqual(fa.point);
    expect(p3).toEqual(tb.point);
    // c1 - p0 is along the start normal, c2 - p3 along the end normal.
    expect((c1.x - p0.x) * fa.normal.y - (c1.y - p0.y) * fa.normal.x).toBeCloseTo(0, 9);
    expect((c1.x - p0.x) * fa.normal.x + (c1.y - p0.y) * fa.normal.y).toBeGreaterThan(0);
    expect((c2.x - p3.x) * tb.normal.x + (c2.y - p3.y) * tb.normal.y).toBeGreaterThan(0);
    expect(routePathD(r)).toMatch(/^M[\d.-]+ [\d.-]+C[\d.\s-]+$/);
    // Arrowheads follow the end tangents (into the end anchor).
    const d = routeEndDirections(r);
    expect(d.end.x * -tb.normal.x + d.end.y * -tb.normal.y).toBeCloseTo(1, 6);
    expect(d.start.x * fa.normal.x + d.start.y * fa.normal.y).toBeCloseTo(1, 6);
  });

  it("same-side pairs bulge outwards instead of collapsing", () => {
    const r = connectorRoute({ routing: "curved", fromSide: "top", toSide: "top" }, a, box("o_000000000002", 300, 0));
    const b = routeBounds(r);
    expect(b.y).toBeLessThan(-20);
    expect(b.y + b.h).toBeCloseTo(0, 6);
  });

  it("bounds, label midpoint and distance are exact, not from the control hull", () => {
    const r = connectorRoute({ routing: "curved", fromSide: "top", toSide: "top" }, a, box("o_000000000002", 300, 0));
    const pts = [];
    for (let i = 0; i <= 5000; i++) pts.push(cubicPoint(r.cubic, i / 5000));
    const s = pointsBounds(pts), b = routeBounds(r);
    expect(Math.abs(s.y - b.y)).toBeLessThan(0.01);
    expect(b.y).toBeGreaterThan(Math.min(...r.cubic.map((p) => p.y))); // tighter than the hull
    const mid = routeMidpoint(r);
    expect(mid.x).toBeCloseTo(200, 6); // symmetric curve: halfway by length is the apex
    expect(routeDistance(mid, r)).toBeCloseTo(0, 6);
    expect(routeDistance({ x: 200, y: b.y - 10 }, r)).toBeCloseTo(10, 3);
  });

  it("the curve handle is where the curve passes at t = 0.5, and follows moves and scaling", () => {
    const base = connectorRoute({ routing: "curved" }, a, b);
    const target = { x: 150, y: 250 };
    const uv = curveFromHandle(base.cubic[0], base.cubic[3], target);
    const edited = connectorRoute({ routing: "curved", curve: uv, fromSide: base.fromSide, toSide: base.toSide }, a, b);
    const m = cubicPoint(edited.cubic, 0.5);
    // uv is stored to 4 decimals of the chord (about 0.05 units here).
    expect(m.x).toBeCloseTo(target.x, 1);
    expect(m.y).toBeCloseTo(target.y, 1);
    expect(routeHandles(edited)[0].point.x).toBeCloseTo(target.x, 1);
    // Move both ends: the handle moves with them.
    const moved = connectorRoute({ routing: "curved", curve: uv, fromSide: base.fromSide, toSide: base.toSide },
      { ...a, x: a.x + 70, y: a.y - 30 }, { ...b, x: b.x + 70, y: b.y - 30 });
    const mm = cubicPoint(moved.cubic, 0.5);
    expect(mm.x).toBeCloseTo(target.x + 70, 1);
    expect(mm.y).toBeCloseTo(target.y - 30, 1);
    expect(curveHandlePoint(base.cubic[0], base.cubic[3], uv).x).toBeCloseTo(target.x, 1);
    expect(hasRouteEdits({ routing: "curved", curve: uv })).toBe(true);
    expect(hasRouteEdits({ routing: "curved", curve: null })).toBe(false);
  });
});

describe("editable elbows", () => {
  const a = box("o_000000000001", 0, 0), b = box("o_000000000002", 400, 200);
  const sides = { fromSide: "right", toSide: "left" };

  it("no segments reproduces the simple elbow; segments round-trip through the stored form", () => {
    const fa = anchor(a, "right"), tb = anchor(b, "left");
    expect(elbowFromSegments(fa, tb, [])).toEqual([
      { x: 100, y: 50 }, { x: 124, y: 50 }, { x: 250, y: 50 }, { x: 250, y: 250 }, { x: 376, y: 250 }, { x: 400, y: 250 },
    ]);
    const rng = prng(4);
    for (let k = 0; k < 200; k++) {
      const segs = Array.from({ length: Math.floor(rng() * 7) }, () => Math.round((rng() - 0.5) * 600));
      const pts = elbowFromSegments(fa, tb, segs);
      expect(orthogonal(pts)).toBe(true);
      const back = segmentsFromPoints(fa, tb, pts);
      expect(elbowFromSegments(fa, tb, back)).toEqual(elbowFromSegments(fa, tb, segmentsFromPoints(fa, tb, elbowFromSegments(fa, tb, back))));
      // Same drawing (collinear points aside).
      const d1 = routePathD({ kind: "polyline", points: pts, cubic: null });
      const simple = (p) => routePathD({ kind: "polyline", points: p, cubic: null });
      expect(simple(elbowFromSegments(fa, tb, back)).length).toBeLessThanOrEqual(d1.length);
    }
  });

  it("dragging the middle segment stores one offset; moving the ends keeps it orthogonal", () => {
    const route = connectorRoute({ routing: "elbow", ...sides }, a, b);
    const handles = routeHandles(route);
    const middle = handles.find((hd) => !hd.anchored);
    expect(middle).toMatchObject({ axis: "x", pos: 250 });
    const segs = moveElbowSegment(a, b, route, middle.index, 320);
    expect(segs).toEqual([70]);
    const edited = connectorRoute({ routing: "elbow", ...sides, segments: segs }, a, b);
    expect(edited.points.some((p) => p.x === 320)).toBe(true);
    // Both ends move together: the whole route translates.
    const shifted = connectorRoute({ routing: "elbow", ...sides, segments: segs }, { ...a, x: 50, y: 60 }, { ...b, x: 450, y: 260 });
    expect(shifted.points).toEqual(edited.points.map((p) => ({ x: p.x + 50, y: p.y + 60 })));
    // One end moves: still orthogonal, still leaving each anchor along its side, the segment half way.
    const rng = prng(12);
    for (let k = 0; k < 100; k++) {
      const moved = { ...b, x: b.x + (rng() - 0.5) * 900, y: b.y + (rng() - 0.5) * 900 };
      const r = connectorRoute({ routing: "elbow", ...sides, segments: segs }, a, moved);
      expect(orthogonal(r.points)).toBe(true);
      expect(r.points[0]).toEqual(anchor(a, "right").point);
      expect(r.points[r.points.length - 1]).toEqual(anchor(moved, "left").point);
      expect(r.points[1].x).toBeGreaterThan(r.points[0].x); // the start stub still leaves rightwards
    }
  });

  it("dragging a segment through a port adds a jog next to its stub", () => {
    const route = connectorRoute({ routing: "elbow", ...sides }, a, b);
    const first = routeHandles(route).find((hd) => hd.anchored && hd.index === 0);
    expect(first).toBeDefined();
    const segs = moveElbowSegment(a, b, route, 0, -40);
    const r = connectorRoute({ routing: "elbow", ...sides, segments: segs }, a, b);
    expect(orthogonal(r.points)).toBe(true);
    expect(r.points.slice(0, 3)).toEqual([{ x: 100, y: 50 }, { x: 124, y: 50 }, { x: 124, y: -40 }]);
    const last = routeHandles(route).find((hd) => hd.anchored && hd.index > 0);
    const segs2 = moveElbowSegment(a, b, route, last.index, 330);
    const r2 = connectorRoute({ routing: "elbow", ...sides, segments: segs2 }, a, b);
    expect(orthogonal(r2.points)).toBe(true);
    expect(r2.points.slice(-3)).toEqual([{ x: 376, y: 330 }, { x: 376, y: 250 }, { x: 400, y: 250 }]);
  });

  it("dragging into line with a neighbour straightens the route (bends dropped)", () => {
    const route = connectorRoute({ routing: "elbow", ...sides }, a, box("o_000000000002", 400, 0));
    expect(new Set(route.points.map((p) => p.y)).size).toBe(1); // aligned: one straight line
    const jog = moveElbowSegment(a, box("o_000000000002", 400, 0), route, 0, 120);
    expect(jog.length).toBeGreaterThan(0);
    const bent = connectorRoute({ routing: "elbow", ...sides, segments: jog }, a, box("o_000000000002", 400, 0));
    const h = routeHandles(bent).find((hd) => hd.axis === "y" && !hd.anchored);
    const straight = moveElbowSegment(a, box("o_000000000002", 400, 0), bent, h.index, 50);
    expect(simplifyOrthogonal(connectorRoute({ routing: "elbow", ...sides, segments: straight }, a, box("o_000000000002", 400, 0)).points)).toHaveLength(2);
    expect(straight).toEqual([]);
  });

  it("an automatic route materialises into segments that reproduce it exactly", () => {
    const wall = box("o_000000000009", 200, -300, 40, 700);
    const env = envOf([a, b, wall]);
    const auto = connectorRoute({ routing: "elbow", ...sides }, a, b, env);
    expect(auto.avoided).toBe(true);
    const segs = materializeSegments(a, b, auto);
    expect(segs.length).toBeLessThanOrEqual(MAX_SEGMENTS);
    const fixed = connectorRoute({ routing: "elbow", ...sides, segments: segs }, a, b, env);
    expect(simplifyOrthogonal(fixed.points)).toEqual(simplifyOrthogonal(auto.points));
  });
});

describe("obstacle-avoiding elbows", () => {
  const a = box("o_000000000001", 0, 0), b = box("o_000000000002", 600, 0);
  const between = box("o_000000000003", 250, -20, 100, 140);

  it("route around an object in the way, never through its padded box", () => {
    const env = envOf([a, b, between]);
    const r = connectorRoute({ routing: "elbow" }, a, b, env);
    expect(r.avoided).toBe(true);
    expect(orthogonal(r.points)).toBe(true);
    const padded = { x: 250 - OBSTACLE_PAD, y: -20 - OBSTACLE_PAD, w: 100 + 2 * OBSTACLE_PAD, h: 140 + 2 * OBSTACLE_PAD };
    for (let i = 1; i < r.points.length; i++) expect(segmentCrossesRect(r.points[i - 1], r.points[i], padded)).toBe(false);
    expect(r.points[0]).toEqual({ x: 100, y: 50 });
    expect(r.points[r.points.length - 1]).toEqual({ x: 600, y: 50 });
  });

  it("without obstacles in the way the route is the simple elbow, with or without an env", () => {
    const off = box("o_000000000003", 250, 400);
    expect(connectorRoute({ routing: "elbow" }, a, b, envOf([a, b, off])).points).toEqual(connectorRoute({ routing: "elbow" }, a, b).points);
  });

  it("ignores frames, pens, connectors, the endpoints and objects stacked on an endpoint", () => {
    const frame = { ...between, id: "o_000000000004", type: "frame" };
    const pen = { ...between, id: "o_000000000005", type: "pen" };
    const label = box("o_000000000006", 20, 20, 40, 20, { type: "text" });
    const { p1, p2 } = elbowPorts(anchor(a, "right"), anchor(b, "left"));
    expect(selectObstacles(a, b, [frame, pen, label, a, b], p1, p2)).toEqual([]);
    expect(connectorRoute({ routing: "elbow" }, a, b, envOf([a, b, frame, pen, label])).avoided).toBe(false);
  });

  it("is deterministic: candidate order and a superset of candidates do not matter", () => {
    const more = [between, box("o_000000000007", 380, -200, 60, 300), box("o_000000000008", 150, 90, 60, 60)];
    const r1 = connectorRoute({ routing: "elbow" }, a, b, { candidates: () => more });
    const r2 = connectorRoute({ routing: "elbow" }, a, b, { candidates: () => [...more].reverse().concat([box("o_00000000000a", 9000, 9000)]) });
    const r3 = connectorRoute({ routing: "elbow" }, a, b, envOf([a, b, ...more]));
    expect(r2.points).toEqual(r1.points);
    expect(r3.points).toEqual(r1.points);
  });

  it("memoises by connector id and recomputes only when an input changes", () => {
    const env = envOf([a, b, between], true);
    const conn = { id: "o_0000000000c1", routing: "elbow" };
    resetConnectorStats();
    const r1 = connectorRoute(conn, a, b, env);
    const r2 = connectorRoute(conn, a, b, env);
    expect(CONNECTOR_STATS.memoHits).toBe(1);
    expect(CONNECTOR_STATS.searches).toBe(1);
    expect(r2.points).toEqual(r1.points);
    connectorRoute(conn, { ...a, y: 5 }, b, env);
    expect(CONNECTOR_STATS.searches).toBe(2);
  });

  it("stays stable when an unrelated object far away moves", () => {
    const far = box("o_000000000009", 5000, 5000);
    const r1 = connectorRoute({ routing: "elbow" }, a, b, envOf([a, b, between, far]));
    const r2 = connectorRoute({ routing: "elbow" }, a, b, envOf([a, b, between, { ...far, x: 6000 }]));
    expect(r2.points).toEqual(r1.points);
    expect(routeRegion(a, b).x).toBeLessThan(0);
  });

  it("random scenes: routes are orthogonal, start and end at the anchors, and avoid obstacles", () => {
    const rng = prng(77);
    for (let k = 0; k < 80; k++) {
      const p = box("o_000000000001", 0, 0, 80 + rng() * 80, 60 + rng() * 80);
      const q = box("o_000000000002", 300 + rng() * 500, (rng() - 0.5) * 600, 80 + rng() * 80, 60 + rng() * 80);
      const obstacles = Array.from({ length: 1 + Math.floor(rng() * 6) }, (_, i) =>
        box("o_00000000010" + i, 120 + rng() * 600, (rng() - 0.5) * 700, 30 + rng() * 120, 30 + rng() * 120));
      const env = envOf([p, q, ...obstacles]);
      const r = connectorRoute({ routing: "elbow" }, p, q, env);
      expect(orthogonal(r.points)).toBe(true);
      expect(r.points[0]).toEqual(anchor(p, r.fromSide).point);
      expect(r.points[r.points.length - 1]).toEqual(anchor(q, r.toSide).point);
      if (!r.avoided) continue;
      const { p1, p2 } = elbowPorts(anchor(p, r.fromSide), anchor(q, r.toSide));
      const used = selectObstacles(p, q, [p, q, ...obstacles], p1, p2);
      for (let i = 1; i < r.points.length; i++) for (const o of used) expect(segmentCrossesRect(r.points[i - 1], r.points[i], o)).toBe(false);
    }
  });

  it("stub length and padding keep ports outside their own padded box", () => {
    expect(STUB).toBeGreaterThan(OBSTACLE_PAD);
  });
});
