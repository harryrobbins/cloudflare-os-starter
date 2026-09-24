import { describe, expect, it } from "vitest";
import {
  cubicPoint, cubicDerivative, cubicBounds, cubicLength, cubicParamAtLength, cubicMidpoint, closestOnCubic,
  flattenCubic, cubicEndDirection, splitCubic, cubicPathD,
} from "../../src/shared/bezier.js";
import { distanceToPolyline, fmt } from "../../src/shared/geometry.js";

/** Seeded PRNG (mulberry32). */
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

function randomCubic(rng, span = 1000) {
  const p = () => ({ x: (rng() - 0.5) * span, y: (rng() - 0.5) * span });
  return [p(), p(), p(), p()];
}

function sampled(c, n) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push(cubicPoint(c, i / n));
  return out;
}

describe("cubic Bézier geometry", () => {
  it("bounds come from derivative roots: tight against dense sampling, never the control hull", () => {
    const rng = prng(7);
    for (let k = 0; k < 200; k++) {
      const c = randomCubic(rng);
      const b = cubicBounds(c);
      const pts = sampled(c, 4000);
      const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
      // Contains every sample, and is no looser than sampling resolution allows.
      expect(b.x).toBeLessThanOrEqual(minX + 1e-9);
      expect(b.y).toBeLessThanOrEqual(minY + 1e-9);
      expect(b.x + b.w).toBeGreaterThanOrEqual(maxX - 1e-9);
      expect(b.y + b.h).toBeGreaterThanOrEqual(maxY - 1e-9);
      expect(minX - b.x).toBeLessThan(0.05);
      expect(b.x + b.w - maxX).toBeLessThan(0.05);
      expect(minY - b.y).toBeLessThan(0.05);
      expect(b.y + b.h - maxY).toBeLessThan(0.05);
    }
  });

  it("bounds of a curve whose controls overshoot are smaller than the control hull", () => {
    const c = [{ x: 0, y: 0 }, { x: 0, y: -300 }, { x: 100, y: -300 }, { x: 100, y: 0 }];
    const b = cubicBounds(c);
    expect(b.y).toBeCloseTo(-225, 9); // 3/4 of the control height, exactly
    expect(b.h).toBeCloseTo(225, 9);
  });

  it("arc length matches a fine polyline, also near cusps", () => {
    const rng = prng(11);
    const cases = [randomCubic(rng), randomCubic(rng), randomCubic(rng),
      // A cusp: controls crossed.
      [{ x: 0, y: 0 }, { x: 300, y: 200 }, { x: -200, y: 200 }, { x: 100, y: 0 }]];
    for (const c of cases) {
      const pts = sampled(c, 200_000);
      let poly = 0;
      for (let i = 1; i < pts.length; i++) poly += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      expect(Math.abs(cubicLength(c) - poly) / poly).toBeLessThan(1e-6);
    }
  });

  it("the arc-length midpoint splits the curve into halves of equal length", () => {
    const rng = prng(3);
    for (let k = 0; k < 40; k++) {
      const c = randomCubic(rng);
      const total = cubicLength(c);
      const t = cubicParamAtLength(c, total / 2, total);
      expect(Math.abs(cubicLength(c, 0, t) - cubicLength(c, t, 1))).toBeLessThan(1e-5 * Math.max(1, total));
      const m = cubicMidpoint(c);
      const p = cubicPoint(c, t);
      expect(m.x).toBeCloseTo(p.x, 9);
      expect(m.y).toBeCloseTo(p.y, 9);
    }
  });

  it("closest point: never farther than brute-force sampling, and at most a hair nearer", () => {
    const rng = prng(19);
    for (let k = 0; k < 150; k++) {
      const c = randomCubic(rng);
      const p = { x: (rng() - 0.5) * 1400, y: (rng() - 0.5) * 1400 };
      const got = closestOnCubic(p, c);
      let brute = Infinity;
      for (const q of sampled(c, 20_000)) brute = Math.min(brute, Math.hypot(q.x - p.x, q.y - p.y));
      expect(got.distance).toBeLessThanOrEqual(brute + 1e-9);
      expect(brute - got.distance).toBeLessThan(0.1);
      const q = cubicPoint(c, got.t);
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeCloseTo(got.distance, 9);
    }
  });

  it("flattening stays within its tolerance of the curve", () => {
    const rng = prng(23);
    for (const tol of [0.25, 1, 4]) {
      for (let k = 0; k < 30; k++) {
        const c = randomCubic(rng);
        const poly = flattenCubic(c, tol, 16);
        expect(poly[0]).toEqual(c[0]);
        expect(poly[poly.length - 1]).toEqual(c[3]);
        const flat = poly.flatMap((p) => [p.x, p.y]);
        for (const q of sampled(c, 2000)) expect(distanceToPolyline(q, flat)).toBeLessThanOrEqual(tol + 1e-9);
      }
    }
  });

  it("end directions follow the tangents, and survive a control point on its end point", () => {
    const c = [{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 0 }];
    expect(cubicEndDirection(c, "start")).toEqual({ x: 0, y: 1 });
    expect(cubicEndDirection(c, "end")).toEqual({ x: 0, y: -1 });
    const d = cubicDerivative(c, 1);
    expect(Math.atan2(d.y, d.x)).toBeCloseTo(-Math.PI / 2, 9);
    const degenerate = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }];
    expect(cubicEndDirection(degenerate, "start")).toEqual({ x: 1, y: 0 });
    expect(cubicEndDirection(degenerate, "end")).toEqual({ x: 1, y: 0 });
    const point = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 5 }];
    expect(cubicEndDirection(point, "end")).toEqual({ x: 1, y: 0 });
  });

  it("splitting reproduces the curve", () => {
    const c = randomCubic(prng(5));
    const [a, b] = splitCubic(c, 0.3);
    for (const t of [0, 0.25, 0.5, 1]) {
      const p = cubicPoint(a, t), q = cubicPoint(c, 0.3 * t);
      expect(p.x).toBeCloseTo(q.x, 9);
      const r = cubicPoint(b, t), s = cubicPoint(c, 0.3 + 0.7 * t);
      expect(r.y).toBeCloseTo(s.y, 9);
    }
    expect(cubicPathD(c, fmt)).toMatch(/^M-?[\d.]+ -?[\d.]+C/);
  });
});
