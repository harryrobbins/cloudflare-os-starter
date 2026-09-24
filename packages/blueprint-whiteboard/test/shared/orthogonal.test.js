import { describe, expect, it } from "vitest";
import { orthogonalPath, minBends, simplifyOrthogonal, segmentCrossesRect, BEND_COST, ROUTE_STATS, resetRouteStats } from "../../src/shared/orthogonal.js";

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

const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

/**
 * Exhaustive reference: Dijkstra over (lattice point, heading) on the integer lattice of the box
 * [lo, hi]^2, with the same cost (length + BEND_COST per bend, no reversing, crossing an obstacle's
 * open interior forbidden). Obstacles and ports are on even coordinates, so the router's midlines
 * are lattice lines too.
 */
function latticeCost(start, sd, end, ed, obstacles, lo, hi) {
  const n = hi - lo + 1;
  const idx = (x, y, d) => (((x - lo) * n + (y - lo)) << 2) | d;
  const dist = new Float64Array(n * n * 4).fill(Infinity);
  const inside = (x, y) => obstacles.some((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h);
  const edgeBlocked = (x, y, nx, ny) => {
    const mx = (x + nx) / 2, my = (y + ny) / 2;
    return obstacles.some((r) => mx > r.x && mx < r.x + r.w && my > r.y && my < r.y + r.h);
  };
  // Simple O(V^2)-ish Dijkstra with a sorted frontier (small lattices only).
  const frontier = [[0, start.x, start.y, sd]];
  dist[idx(start.x, start.y, sd)] = 0;
  let best = Infinity;
  while (frontier.length) {
    let m = 0;
    for (let i = 1; i < frontier.length; i++) if (frontier[i][0] < frontier[m][0]) m = i;
    const [c, x, y, d] = frontier.splice(m, 1)[0];
    if (c > dist[idx(x, y, d)]) continue;
    if (c >= best) break;
    if (x === end.x && y === end.y) {
      best = Math.min(best, c + BEND_COST * (d === ed ? 0 : ((d + 2) & 3) === ed ? 2 : 1));
      continue;
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === ((d + 2) & 3)) continue;
      const nx = x + DX[nd], ny = y + DY[nd];
      if (nx < lo || nx > hi || ny < lo || ny > hi || inside(nx, ny) || edgeBlocked(x, y, nx, ny)) continue;
      const nc = c + 1 + (nd === d ? 0 : BEND_COST);
      if (nc < dist[idx(nx, ny, nd)]) { dist[idx(nx, ny, nd)] = nc; frontier.push([nc, nx, ny, nd]); }
    }
  }
  return best;
}

function pathCost(points, sd, ed) {
  let len = 0, bends = 0;
  let heading = sd;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x, dy = points[i].y - points[i - 1].y;
    len += Math.abs(dx) + Math.abs(dy);
    const h = dx > 0 ? 0 : dx < 0 ? 2 : dy > 0 ? 1 : 3;
    if (h !== heading) bends += ((h + 2) & 3) === heading ? 2 : 1;
    heading = h;
  }
  if (heading !== ed) bends += ((heading + 2) & 3) === ed ? 2 : 1;
  return len + BEND_COST * bends;
}

describe("orthogonal A* router", () => {
  it("is optimal (length + bends) against an exhaustive lattice search on small random grids", () => {
    const rng = prng(42);
    let compared = 0;
    for (let k = 0; k < 150; k++) {
      const even = (max) => 2 * Math.floor(rng() * (max / 2));
      const obstacles = [];
      for (let i = 0; i < 1 + Math.floor(rng() * 4); i++) {
        const x = 2 + even(22), y = 2 + even(22);
        obstacles.push({ x, y, w: 2 + even(8), h: 2 + even(8) });
      }
      const pick = () => ({ x: even(34), y: even(34) });
      const start = pick(), end = pick();
      if (obstacles.some((r) => start.x > r.x && start.x < r.x + r.w && start.y > r.y && start.y < r.y + r.h)) continue;
      if (obstacles.some((r) => end.x > r.x && end.x < r.x + r.w && end.y > r.y && end.y < r.y + r.h)) continue;
      const sd = Math.floor(rng() * 4), ed = Math.floor(rng() * 4);
      const got = orthogonalPath(start, sd, end, ed, obstacles, { margin: 1 });
      // The router's grid spans the obstacles and ports; the reference lattice the same box.
      const xs = [start.x, end.x, ...obstacles.flatMap((r) => [r.x, r.x + r.w])];
      const ys = [start.y, end.y, ...obstacles.flatMap((r) => [r.y, r.y + r.h])];
      const lo = Math.min(...xs, ...ys) - 1, hi = Math.max(...xs, ...ys) + 1;
      const ref = latticeCost(start, sd, end, ed, obstacles, lo, hi);
      if (!Number.isFinite(ref)) { expect(got).toBeNull(); continue; }
      expect(got).not.toBeNull();
      expect(got.cost).toBeCloseTo(ref, 9);
      expect(pathCost(got.points, sd, ed)).toBeCloseTo(ref, 9);
      for (let i = 1; i < got.points.length; i++) {
        const a = got.points[i - 1], b = got.points[i];
        expect(a.x === b.x || a.y === b.y).toBe(true);
        for (const r of obstacles) expect(segmentCrossesRect(a, b, r)).toBe(false);
      }
      compared++;
    }
    expect(compared).toBeGreaterThan(80);
  });

  it("is deterministic: obstacle order does not change the path", () => {
    const obstacles = [{ x: 100, y: -50, w: 60, h: 200 }, { x: 250, y: 20, w: 40, h: 40 }, { x: 180, y: -200, w: 30, h: 120 }];
    const a = orthogonalPath({ x: 0, y: 50 }, 0, { x: 400, y: 50 }, 0, obstacles);
    const b = orthogonalPath({ x: 0, y: 50 }, 0, { x: 400, y: 50 }, 0, [...obstacles].reverse());
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
  });

  it("goes around a wall and gives up within its budget", () => {
    resetRouteStats();
    const wall = [{ x: 100, y: -500, w: 20, h: 1000 }];
    const r = orthogonalPath({ x: 0, y: 0 }, 0, { x: 300, y: 0 }, 0, wall);
    expect(r?.points.length).toBeGreaterThan(2);
    expect(ROUTE_STATS.searches).toBe(1);
    expect(orthogonalPath({ x: 0, y: 0 }, 0, { x: 300, y: 0 }, 0, wall, { maxExpanded: 2 })).toBeNull();
    expect(ROUTE_STATS.failures).toBe(1);
  });

  it("bend lower bound is exact for 0 and 1 bends", () => {
    expect(minBends(0, 0, 0, 10, 0, 0)).toBe(0);
    expect(minBends(0, 0, 0, -10, 0, 0)).toBe(2);
    expect(minBends(0, 0, 0, 10, 10, 1)).toBe(1);
    expect(minBends(0, 0, 0, 10, -10, 1)).toBe(2); // must go down but the goal is above
    expect(minBends(0, 0, 0, 10, 10, 0)).toBe(2);
  });

  it("simplifies collinear points but keeps a doubling back", () => {
    expect(simplifyOrthogonal([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }])).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]);
    expect(simplifyOrthogonal([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }])).toHaveLength(3);
  });
});
