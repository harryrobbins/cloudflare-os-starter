// @ts-check
// Cubic Bézier geometry for curved connectors, pure and deterministic (the server's SVG export and
// every browser compute the same numbers). Exact where exact answers are cheap:
//   bounds       from the roots of the derivative (a quadratic per axis), not the control hull
//   tangents     B'(t), with the degenerate cases (a control point on its end point) handled
//   arc length   Gauss–Legendre quadrature (8 nodes) on an adaptive subdivision of [t0, t1]
//   half length  the parameter at half the arc length, by safeguarded Newton iteration
//   distance     coarse sampling, then Newton refinement of (B(t) - p) · B'(t) = 0 per bracket
//   flattening   recursive de Casteljau subdivision until the control points are within a
//                tolerance of the chord (used for polyline consumers and outlines)

/** @typedef {{x: number, y: number}} Point */
/** A cubic as its four control points: start, first control, second control, end. @typedef {[Point, Point, Point, Point]} Cubic */

/** @param {Cubic} c @param {number} t @returns {Point} */
export function cubicPoint(c, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return { x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x, y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y };
}

/** First derivative B'(t). @param {Cubic} c @param {number} t @returns {Point} */
export function cubicDerivative(c, t) {
  const u = 1 - t;
  const a = 3 * u * u, b = 6 * u * t, d = 3 * t * t;
  return {
    x: a * (c[1].x - c[0].x) + b * (c[2].x - c[1].x) + d * (c[3].x - c[2].x),
    y: a * (c[1].y - c[0].y) + b * (c[2].y - c[1].y) + d * (c[3].y - c[2].y),
  };
}

/** Second derivative B''(t). @param {Cubic} c @param {number} t @returns {Point} */
export function cubicSecondDerivative(c, t) {
  const u = 1 - t;
  return {
    x: 6 * u * (c[2].x - 2 * c[1].x + c[0].x) + 6 * t * (c[3].x - 2 * c[2].x + c[1].x),
    y: 6 * u * (c[2].y - 2 * c[1].y + c[0].y) + 6 * t * (c[3].y - 2 * c[2].y + c[1].y),
  };
}

/**
 * Unit tangent direction at the start (pointing into the curve) or the end (pointing out of it).
 * When the adjacent control point coincides with the end point the next one is used, then the
 * chord; a curve collapsed to a point has direction (1, 0).
 * @param {Cubic} c @param {"start"|"end"} which
 * @returns {Point}
 */
export function cubicEndDirection(c, which) {
  const [p0, c1, c2, p3] = c;
  const tries = which === "start"
    ? [[p0, c1], [p0, c2], [p0, p3]]
    : [[c2, p3], [c1, p3], [p0, p3]];
  for (const [a, b] of tries) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-9) return { x: dx / d, y: dy / d };
  }
  return { x: 1, y: 0 };
}

/**
 * Real roots in (0, 1) of a t^2 + b t + c = 0 (a linear or constant equation when a ~ 0).
 * @param {number} a @param {number} b @param {number} c
 * @returns {number[]}
 */
function unitQuadraticRoots(a, b, c) {
  /** @type {number[]} */
  const out = [];
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return out;
  if (Math.abs(a) <= 1e-12 * scale) {
    if (Math.abs(b) > 1e-12 * scale) out.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      // Numerically stable form (no cancellation between -b and sqrt(disc)).
      const q = -0.5 * (b + Math.sign(b || 1) * Math.sqrt(disc));
      out.push(q / a);
      if (q !== 0) out.push(c / q);
    }
  }
  return out.filter((t) => t > 0 && t < 1);
}

/**
 * Exact axis-aligned bounds: the end points plus every interior extremum, where a component of
 * B'(t) (a quadratic in t) is zero.
 * @param {Cubic} c
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export function cubicBounds(c) {
  let minX = Math.min(c[0].x, c[3].x), maxX = Math.max(c[0].x, c[3].x);
  let minY = Math.min(c[0].y, c[3].y), maxY = Math.max(c[0].y, c[3].y);
  for (const axis of /** @type {const} */ (["x", "y"])) {
    const p0 = c[0][axis], p1 = c[1][axis], p2 = c[2][axis], p3 = c[3][axis];
    // B'(t)/3 = a t^2 + b t + c with:
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const k = p1 - p0;
    for (const t of unitQuadraticRoots(a, b, k)) {
      const v = cubicPoint(c, t)[axis];
      if (axis === "x") { if (v < minX) minX = v; if (v > maxX) maxX = v; }
      else { if (v < minY) minY = v; if (v > maxY) maxY = v; }
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// 8-point Gauss–Legendre nodes and weights on [-1, 1].
const GL_X = [-0.9602898564975363, -0.7966664774136267, -0.5255324099163290, -0.1834346424956498,
  0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363];
const GL_W = [0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.3626837833783620,
  0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];

/** @param {Cubic} c @param {number} a @param {number} b */
function glLength(c, a, b) {
  const half = (b - a) / 2, mid = (a + b) / 2;
  let s = 0;
  for (let i = 0; i < 8; i++) {
    const d = cubicDerivative(c, mid + half * GL_X[i]);
    s += GL_W[i] * Math.hypot(d.x, d.y);
  }
  return s * half;
}

/**
 * Arc length of the curve between parameters t0 and t1 (default the whole curve): 8-point
 * Gauss–Legendre on [t0, t1], bisected until the two halves agree with the whole to a relative
 * 1e-9 (at most 12 levels deep), so cusps and near-cusps are integrated accurately too.
 * @param {Cubic} c @param {number} [t0] @param {number} [t1]
 */
export function cubicLength(c, t0 = 0, t1 = 1) {
  /** @param {number} a @param {number} b @param {number} whole @param {number} depth @returns {number} */
  const rec = (a, b, whole, depth) => {
    const m = (a + b) / 2;
    const left = glLength(c, a, m), right = glLength(c, m, b);
    if (depth >= 12 || Math.abs(left + right - whole) <= 1e-9 * Math.max(1, Math.abs(whole))) return left + right;
    return rec(a, m, left, depth + 1) + rec(m, b, right, depth + 1);
  };
  if (t1 <= t0) return 0;
  return rec(t0, t1, glLength(c, t0, t1), 0);
}

/**
 * The parameter t at which the arc length from the start is `s` (clamped to the curve), by Newton
 * iteration on L(t) - s safeguarded with bisection.
 * @param {Cubic} c @param {number} s @param {number} [total]  cubicLength(c), when already known
 */
export function cubicParamAtLength(c, s, total = cubicLength(c)) {
  if (total <= 0 || s <= 0) return 0;
  if (s >= total) return 1;
  let lo = 0, hi = 1, t = s / total;
  for (let i = 0; i < 40; i++) {
    const f = cubicLength(c, 0, t) - s;
    if (Math.abs(f) <= 1e-7 * Math.max(1, total)) return t;
    if (f > 0) hi = t; else lo = t;
    const d = cubicDerivative(c, t);
    const speed = Math.hypot(d.x, d.y);
    let next = speed > 1e-12 ? t - f / speed : (lo + hi) / 2;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    t = next;
  }
  return t;
}

/** The point halfway along the curve by arc length. @param {Cubic} c @returns {Point} */
export function cubicMidpoint(c) {
  const total = cubicLength(c);
  return cubicPoint(c, cubicParamAtLength(c, total / 2, total));
}

/**
 * Splits at t (de Casteljau).
 * @param {Cubic} c @param {number} t
 * @returns {[Cubic, Cubic]}
 */
export function splitCubic(c, t) {
  const lerp = (/** @type {Point} */ a, /** @type {Point} */ b) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const ab = lerp(c[0], c[1]), bc = lerp(c[1], c[2]), cd = lerp(c[2], c[3]);
  const abc = lerp(ab, bc), bcd = lerp(bc, cd);
  const m = lerp(abc, bcd);
  return [[c[0], ab, abc, m], [m, bcd, cd, c[3]]];
}

/** Distance from p to segment ab. @param {Point} p @param {Point} a @param {Point} b */
function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * The curve as a polyline whose distance from the curve is at most `tolerance`: subdivide until
 * both control points lie within the tolerance of the chord (the curve lies in the control hull,
 * so that bounds the error). Returns [start, ..., end]; at most 2^maxDepth segments.
 * @param {Cubic} c @param {number} tolerance world units (> 0) @param {number} [maxDepth]
 * @returns {Point[]}
 */
export function flattenCubic(c, tolerance, maxDepth = 10) {
  const tol = Math.max(1e-6, tolerance);
  /** @type {Point[]} */
  const out = [{ x: c[0].x, y: c[0].y }];
  /** @param {Cubic} k @param {number} depth */
  const rec = (k, depth) => {
    const flat = Math.max(segmentDistance(k[1], k[0], k[3]), segmentDistance(k[2], k[0], k[3]));
    if (flat <= tol || depth >= maxDepth) {
      out.push({ x: k[3].x, y: k[3].y });
      return;
    }
    const [a, b] = splitCubic(k, 0.5);
    rec(a, depth + 1);
    rec(b, depth + 1);
  };
  rec(c, 0);
  return out;
}

/**
 * Closest point of the curve to p: 16 uniform samples pick the candidate brackets, then Newton
 * iteration on g(t) = (B(t) - p) · B'(t) refines each local minimum; the ends are candidates too.
 * @param {Point} p @param {Cubic} c
 * @returns {{distance: number, t: number, point: Point}}
 */
export function closestOnCubic(p, c) {
  const N = 16;
  /** @type {number[]} */
  const d2 = [];
  for (let i = 0; i <= N; i++) {
    const q = cubicPoint(c, i / N);
    d2.push((q.x - p.x) ** 2 + (q.y - p.y) ** 2);
  }
  let best = { distance: Math.sqrt(d2[0]), t: 0, point: cubicPoint(c, 0) };
  const consider = (/** @type {number} */ t) => {
    const q = cubicPoint(c, t);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best.distance) best = { distance: d, t, point: q };
  };
  consider(1);
  for (let i = 0; i <= N; i++) {
    const left = i > 0 ? d2[i - 1] : Infinity, right = i < N ? d2[i + 1] : Infinity;
    if (d2[i] > left || d2[i] > right) continue; // not a local minimum of the samples
    let t = i / N;
    const lo = Math.max(0, (i - 1) / N), hi = Math.min(1, (i + 1) / N);
    for (let k = 0; k < 12; k++) {
      const q = cubicPoint(c, t), d1 = cubicDerivative(c, t), dd = cubicSecondDerivative(c, t);
      const rx = q.x - p.x, ry = q.y - p.y;
      const g = rx * d1.x + ry * d1.y;
      const gp = d1.x * d1.x + d1.y * d1.y + rx * dd.x + ry * dd.y;
      if (!(gp > 1e-12)) break;
      const next = Math.min(hi, Math.max(lo, t - g / gp));
      if (Math.abs(next - t) < 1e-10) { t = next; break; }
      t = next;
    }
    consider(t);
  }
  return best;
}

/** SVG path data "M p0 C c1 c2 p3" with fmt-style numbers. @param {Cubic} c @param {(v: number) => string} f */
export function cubicPathD(c, f) {
  return `M${f(c[0].x)} ${f(c[0].y)}C${f(c[1].x)} ${f(c[1].y)} ${f(c[2].x)} ${f(c[2].y)} ${f(c[3].x)} ${f(c[3].y)}`;
}
