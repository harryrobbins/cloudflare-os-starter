// @ts-check
// Obstacle-avoiding orthogonal routing for elbow connectors: an A* search over a sparse
// orthogonal visibility grid, in the spirit of Wybrow, Marriott and Stuckey, "Orthogonal
// connector routing" (GD 2009, the algorithm behind libavoid) and JointJS's "manhattan" router.
//
// Grid: the "interesting" x and y lines are the edges of the padded obstacles, the two route
// ports (the ends of the anchor stubs), the line halfway between the ports, lines `margin` beyond
// each port on both axes and a frame `margin` outside everything (so a route can leave a port the
// "wrong" way and come back, or go round the outside of all obstacles). Nodes are the
// crossings of those lines; an edge joins two neighbouring crossings on one line when the open
// segment between them does not pass through the interior of a padded obstacle (running along a
// padded edge is allowed). This grid is the Hanan grid of the obstacle corners and ports, which
// contains a shortest rectilinear path, and a minimum-bend one, between the ports when one exists.
// Blocked edges are found with two 2D difference arrays, O(grid + obstacles).
//
// Search: states are (node, heading), so a bend is counted exactly when the heading changes;
// reversing is never allowed. Cost = length + BEND_COST per bend, plus the bend at each port if
// the path leaves or arrives crosswise to the stub. The heuristic is the Manhattan distance plus
// BEND_COST times a lower bound on the bends still needed in free space (0, 1 or 2), which is
// admissible, so the first goal state popped is optimal; stale heap entries are skipped and states
// may be reopened when a cheaper path to them appears. Ties break on the smaller heuristic and then
// on insertion order, so the result is a pure function of the input (obstacles are sorted first).
//
// Budget: at most `maxExpanded` state expansions; beyond that (or when the ports are walled in)
// the caller falls back to the simple elbow. Counters (never content) are kept in ROUTE_STATS.

/** @typedef {{x: number, y: number}} Point */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */

/** Extra cost of one bend, in world units of length. */
export const BEND_COST = 40;
/** State expansions one search may make before it gives up (the caller falls back). */
export const MAX_EXPANDED = 3_000;

/** Algorithmic counters for tests and the benchmark (no ids, coordinates or content). */
export const ROUTE_STATS = {
  /** A* searches run. */ searches: 0,
  /** States expanded, over all searches. */ expanded: 0,
  /** Most states one search expanded. */ maxExpanded: 0,
  /** Searches that found no path or ran out of budget. */ failures: 0,
};

/** Resets ROUTE_STATS (tests and the benchmark). */
export function resetRouteStats() {
  ROUTE_STATS.searches = 0;
  ROUTE_STATS.expanded = 0;
  ROUTE_STATS.maxExpanded = 0;
  ROUTE_STATS.failures = 0;
}

// Headings: 0 right (+x), 1 down (+y), 2 left (-x), 3 up (-y).
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/** Heading index of a unit axis vector. @param {Point} v */
export function headingOf(v) {
  if (Math.abs(v.x) >= Math.abs(v.y)) return v.x >= 0 ? 0 : 2;
  return v.y >= 0 ? 1 : 3;
}

/**
 * Lower bound on the bends of a free-space orthogonal path that leaves (x, y) with heading `d`
 * and arrives at (gx, gy) with heading `e`. Exact for 0 and 1; "2" means "at least 2".
 * @param {number} x @param {number} y @param {number} d @param {number} gx @param {number} gy @param {number} e
 */
export function minBends(x, y, d, gx, gy, e) {
  const vx = gx - x, vy = gy - y;
  const EPS = 1e-9;
  const along = vx * DX[d] + vy * DY[d];
  const across = Math.abs(vx * DY[d] - vy * DX[d]);
  if (d === e && across <= EPS && along >= -EPS) return 0;
  if ((d & 1) !== (e & 1)) {
    // Perpendicular: one bend at the corner p + d*t = g - e*s needs t >= 0 and s >= 0.
    const onE = vx * DX[e] + vy * DY[e];
    if (along >= -EPS && onE >= -EPS) return 1;
  }
  return 2;
}

/**
 * Binary min-heap of (f, h, seq, state) ordered by f, then h, then seq (deterministic), in
 * parallel typed arrays that grow as needed (no allocation per operation).
 */
class Heap {
  constructor(capacity = 256) {
    this.n = 0;
    this.f = new Float64Array(capacity);
    this.h = new Float64Array(capacity);
    this.seq = new Int32Array(capacity);
    this.state = new Int32Array(capacity);
  }
  get size() { return this.n; }
  /** @param {number} i @param {number} j */
  less(i, j) {
    const fi = this.f[i], fj = this.f[j];
    if (fi !== fj) return fi < fj;
    const hi = this.h[i], hj = this.h[j];
    if (hi !== hj) return hi < hj;
    return this.seq[i] < this.seq[j];
  }
  /** @param {number} i @param {number} j */
  swap(i, j) {
    const { f, h, seq, state } = this;
    let t = f[i]; f[i] = f[j]; f[j] = t;
    t = h[i]; h[i] = h[j]; h[j] = t;
    let u = seq[i]; seq[i] = seq[j]; seq[j] = u;
    u = state[i]; state[i] = state[j]; state[j] = u;
  }
  grow() {
    const cap = this.f.length * 2;
    const f = new Float64Array(cap); f.set(this.f); this.f = f;
    const h = new Float64Array(cap); h.set(this.h); this.h = h;
    const seq = new Int32Array(cap); seq.set(this.seq); this.seq = seq;
    const state = new Int32Array(cap); state.set(this.state); this.state = state;
  }
  /** @param {number} f @param {number} h @param {number} seq @param {number} state */
  push(f, h, seq, state) {
    if (this.n === this.f.length) this.grow();
    let i = this.n++;
    this.f[i] = f; this.h[i] = h; this.seq[i] = seq; this.state[i] = state;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  /** Removes the top; read topF/topState first. */
  pop() {
    const last = --this.n;
    if (last > 0) this.swap(0, last);
    let i = 0;
    const n = this.n;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }
}

/** Sorted unique values. @param {number[]} values */
function uniqueSorted(values) {
  const s = values.toSorted((a, b) => a - b);
  /** @type {number[]} */
  const out = [];
  for (const v of s) if (!out.length || v - out[out.length - 1] > 1e-9) out.push(v);
  return out;
}

/** Index of `v` in sorted `arr` (exact match within 1e-9), or -1. @param {number[]} arr @param {number} v */
function indexOf(arr, v) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (Math.abs(arr[m] - v) <= 1e-9) return m;
    if (arr[m] < v) lo = m + 1; else hi = m - 1;
  }
  return -1;
}

/**
 * Whether an axis-aligned segment passes through the open interior of rect `r`.
 * @param {Point} a @param {Point} b @param {Rect} r
 */
export function segmentCrossesRect(a, b, r) {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  const E = 1e-9;
  if (x0 === x1) return x0 > r.x + E && x0 < r.x + r.w - E && Math.max(y0, r.y) < Math.min(y1, r.y + r.h) - E;
  if (y0 === y1) return y0 > r.y + E && y0 < r.y + r.h - E && Math.max(x0, r.x) < Math.min(x1, r.x + r.w) - E;
  // Not axis-aligned (callers only pass orthogonal routes); test the bounding box conservatively.
  return Math.max(x0, r.x) < Math.min(x1, r.x + r.w) && Math.max(y0, r.y) < Math.min(y1, r.y + r.h);
}

/** Whether p is strictly inside r. @param {Point} p @param {Rect} r */
export function strictlyInside(p, r) {
  return p.x > r.x + 1e-9 && p.x < r.x + r.w - 1e-9 && p.y > r.y + 1e-9 && p.y < r.y + r.h - 1e-9;
}

/**
 * The cheapest orthogonal path from `start` (leaving with heading `startDir`) to `end` (arriving
 * with heading `endDir`) around `obstacles` (already padded; the ports must not be strictly inside
 * any of them). Returns the corner points [start, ..., end] with collinear points removed, or null
 * when there is no path within the budget.
 * @param {Point} start @param {number} startDir heading 0..3
 * @param {Point} end @param {number} endDir heading 0..3 (the direction of travel INTO `end`)
 * @param {Rect[]} obstacles
 * @param {{bendCost?: number, maxExpanded?: number, margin?: number}} [opts]
 * @returns {{points: Point[], cost: number, bends: number, expanded: number}|null}
 */
export function orthogonalPath(start, startDir, end, endDir, obstacles, { bendCost = BEND_COST, maxExpanded = MAX_EXPANDED, margin = 16 } = {}) {
  ROUTE_STATS.searches++;
  const m = Math.max(1e-6, margin);
  const xsRaw = [start.x, end.x, (start.x + end.x) / 2, start.x - m, start.x + m, end.x - m, end.x + m];
  const ysRaw = [start.y, end.y, (start.y + end.y) / 2, start.y - m, start.y + m, end.y - m, end.y + m];
  for (const o of obstacles) { xsRaw.push(o.x, o.x + o.w); ysRaw.push(o.y, o.y + o.h); }
  xsRaw.push(Math.min(...xsRaw) - m, Math.max(...xsRaw) + m);
  ysRaw.push(Math.min(...ysRaw) - m, Math.max(...ysRaw) + m);
  const xs = uniqueSorted(xsRaw), ys = uniqueSorted(ysRaw);
  const nx = xs.length, ny = ys.length;
  // Blocked edges by 2D difference arrays over (edge index along the line, line index).
  // hBlock[i][j]: horizontal edge from (i, j) to (i+1, j); vBlock[i][j]: vertical edge (i, j)-(i, j+1).
  const hDiff = new Int32Array((nx + 1) * (ny + 1));
  const vDiff = new Int32Array((nx + 1) * (ny + 1));
  const at = (/** @type {number} */ i, /** @type {number} */ j) => i * (ny + 1) + j;
  for (const o of obstacles) {
    const i0 = indexOf(xs, o.x), i1 = indexOf(xs, o.x + o.w), j0 = indexOf(ys, o.y), j1 = indexOf(ys, o.y + o.h);
    if (i0 < 0 || i1 < 0 || j0 < 0 || j1 < 0 || i1 <= i0 || j1 <= j0) continue;
    // Horizontal edges i in [i0, i1), on lines j strictly inside (j0, j1).
    if (j1 - j0 >= 2) {
      hDiff[at(i0, j0 + 1)]++; hDiff[at(i1, j0 + 1)]--; hDiff[at(i0, j1)]--; hDiff[at(i1, j1)]++;
    }
    // Vertical edges j in [j0, j1), on lines i strictly inside (i0, i1).
    if (i1 - i0 >= 2) {
      vDiff[at(i0 + 1, j0)]++; vDiff[at(i1, j0)]--; vDiff[at(i0 + 1, j1)]--; vDiff[at(i1, j1)]++;
    }
  }
  const prefix = (/** @type {Int32Array} */ d) => {
    for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) {
      d[at(i, j)] += (i ? d[at(i - 1, j)] : 0) + (j ? d[at(i, j - 1)] : 0) - (i && j ? d[at(i - 1, j - 1)] : 0);
    }
  };
  prefix(hDiff);
  prefix(vDiff);
  /** Whether moving from node (i, j) in heading d is allowed. @param {number} i @param {number} j @param {number} d */
  const open = (i, j, d) => {
    if (d === 0) return i + 1 < nx && hDiff[at(i, j)] === 0;
    if (d === 2) return i > 0 && hDiff[at(i - 1, j)] === 0;
    if (d === 1) return j + 1 < ny && vDiff[at(i, j)] === 0;
    return j > 0 && vDiff[at(i, j - 1)] === 0;
  };

  const si = indexOf(xs, start.x), sj = indexOf(ys, start.y), gi = indexOf(xs, end.x), gj = indexOf(ys, end.y);
  const nodes = nx * ny;
  const g = new Float64Array(nodes * 4).fill(Infinity);
  const parent = new Int32Array(nodes * 4).fill(-1);
  const heap = new Heap();
  let seq = 0;
  const hOf = (/** @type {number} */ i, /** @type {number} */ j, /** @type {number} */ d) =>
    Math.abs(xs[i] - end.x) + Math.abs(ys[j] - end.y) + bendCost * minBends(xs[i], ys[j], d, end.x, end.y, endDir);
  const s0 = (si * ny + sj) * 4 + startDir;
  g[s0] = 0;
  heap.push(hOf(si, sj, startDir), hOf(si, sj, startDir), seq++, s0);
  let expanded = 0;
  let goalState = -1, goalCost = Infinity;
  while (heap.size) {
    const f = heap.f[0], state = heap.state[0];
    heap.pop();
    const node = state >> 2, d = state & 3;
    const i = Math.floor(node / ny), j = node % ny;
    const gs = g[state];
    // Stale entry: a cheaper path to this state was found after it was pushed.
    if (f > gs + hOf(i, j, d) + 1e-9) continue;
    if (i === gi && j === gj) {
      goalState = state;
      // Turning into the final heading at the port: one bend, or two for a U-turn (== hOf here).
      goalCost = gs + bendCost * minBends(end.x, end.y, d, end.x, end.y, endDir);
      break;
    }
    if (++expanded > maxExpanded) break;
    for (let nd = 0; nd < 4; nd++) {
      if (nd === ((d + 2) & 3)) continue; // no reversing
      if (!open(i, j, nd)) continue;
      const ni = i + DX[nd], nj = j + DY[nd];
      const len = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]);
      const cost = gs + len + (nd === d ? 0 : bendCost);
      const ns = (ni * ny + nj) * 4 + nd;
      if (cost < g[ns] - 1e-9) {
        g[ns] = cost;
        parent[ns] = state;
        const h = hOf(ni, nj, nd);
        heap.push(cost + h, h, seq++, ns);
      }
    }
  }
  ROUTE_STATS.expanded += expanded;
  if (expanded > ROUTE_STATS.maxExpanded) ROUTE_STATS.maxExpanded = expanded;
  if (goalState < 0) { ROUTE_STATS.failures++; return null; }
  /** @type {Point[]} */
  const rev = [];
  for (let s = goalState; s >= 0; s = parent[s]) {
    const node = s >> 2;
    rev.push({ x: xs[Math.floor(node / ny)], y: ys[node % ny] });
  }
  const pts = simplifyOrthogonal(rev.toReversed());
  let bends = 0;
  for (let k = 1; k + 1 < pts.length; k++) bends++;
  return { points: pts, cost: goalCost, bends, expanded };
}

/**
 * Removes repeated and collinear interior points of an orthogonal polyline.
 * @param {Point[]} pts
 * @returns {Point[]}
 */
export function simplifyOrthogonal(pts) {
  /** @type {Point[]} */
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) <= 0.01 && Math.abs(last.y - p.y) <= 0.01) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2], b = last;
      const collinear = (Math.abs(a.x - b.x) <= 0.01 && Math.abs(b.x - p.x) <= 0.01) ||
        (Math.abs(a.y - b.y) <= 0.01 && Math.abs(b.y - p.y) <= 0.01);
      // Collinear and not doubling back: drop the middle point.
      if (collinear && (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y) >= 0) { out[out.length - 1] = { x: p.x, y: p.y }; continue; }
    }
    out.push({ x: p.x, y: p.y });
  }
  return out;
}
