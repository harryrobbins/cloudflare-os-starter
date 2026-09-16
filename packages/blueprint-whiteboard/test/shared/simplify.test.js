import { describe, expect, it } from "vitest";
import { radialFilter, rdp, simplifyStroke } from "../../src/shared/simplify.js";
import { distanceToPolyline } from "../../src/shared/geometry.js";

function wave(n, noise = 0) {
  const out = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
  for (let i = 0; i < n; i++) out.push(i * 2, Math.sin(i / 25) * 60 + rnd() * noise);
  return out;
}

describe("stroke simplification", () => {
  it("keeps endpoints and short strokes", () => {
    expect(rdp([0, 0, 5, 5], 1)).toEqual([0, 0, 5, 5]);
    expect(radialFilter([0, 0], 1)).toEqual([0, 0]);
    const out = simplifyStroke(wave(300), 1);
    expect(out.slice(0, 2)).toEqual([0, 0]);
    expect(out.slice(-2)).toEqual(wave(300).slice(-2));
  });
  it("drops collinear points", () => {
    const line = [];
    for (let i = 0; i <= 100; i++) line.push(i, i * 2);
    expect(simplifyStroke(line, 0.5)).toEqual([0, 0, 100, 200]);
  });
  it("stays within epsilon of the original", () => {
    const src = wave(600, 0.3);
    const eps = 1.5;
    const out = simplifyStroke(src, eps);
    expect(out.length).toBeLessThan(src.length / 5);
    for (let i = 0; i < src.length; i += 2) {
      expect(distanceToPolyline({ x: src[i], y: src[i + 1] }, out)).toBeLessThanOrEqual(eps * 2 + 1e-9);
    }
  });
  it("honours maxPoints even for pathological input", () => {
    const zigzag = [];
    for (let i = 0; i < 5000; i++) zigzag.push(i * 10, i % 2 ? 1000 : -1000);
    const out = simplifyStroke(zigzag, 0, 200);
    expect(out.length / 2).toBeLessThanOrEqual(200);
    expect(out.slice(0, 2)).toEqual([0, -1000]);
  });
  it("handles 10,000 points quickly", () => {
    const src = wave(10000, 1);
    const t = performance.now();
    simplifyStroke(src, 1, 2000);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
