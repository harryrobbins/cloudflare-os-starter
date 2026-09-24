// @ts-check
// Connector routes: the one seam every consumer uses (the client renderer and the server's SVG
// export through render.js, the spatial index, hit testing, handles, labels, presence ghosts).
// Pure and deterministic, so a board and its export draw the same lines.
//
// Routing styles (`routing`):
//   straight  one segment between the two anchors.
//   curved    a cubic Bézier. Each end leaves its anchor along the side's outward normal; the
//             control arms are 45% of the anchor distance, clamped to [CURVE_ARM_MIN, CURVE_ARM_MAX],
//             so same-side and overlapping pairs bulge outwards instead of collapsing. `curve`
//             (optional, [u, v]) is the user's curve handle: the point the curve passes through at
//             t = 0.5, stored relative to the anchors (u along the chord from start to end, v along
//             the chord turned 90° clockwise, both as fractions of the chord), so it follows moves
//             and scales with the connector. Both control points shift by 4/3 of the offset
//             between that handle and the default curve's midpoint, which puts B(0.5) exactly on it.
//   elbow     orthogonal. The first and last STUB units leave each anchor along its side (normals
//             of rotated objects snap to the nearest axis). With no `segments`, the route is the
//             simple elbow (at most two bends between the stubs, the middle segment centred), or,
//             when that crosses an obstacle and a RouteEnv is given, the cheapest route around the
//             obstacles (./orthogonal.js). `segments` (the user's edits) fixes the route instead:
//             see "Elbow segments" below.
//
// Automatic sides ("auto", the default): the side pair with the lowest cost wins, where the cost
// is the length of the automatic (obstacle-free) route of that style plus BEND_COST per bend, plus
// a large penalty for each place the route passes through either end's box. The pair the old
// rule picked (each side facing the other object's centre) is tried first, so it wins ties.
//
// Obstacles (elbow only, without `segments`): sticky notes, shapes, text and icons (OBSTACLE_TYPES)
// whose rotated bounds meet the region between the two ends (both boxes' union grown by
// REGION_MARGIN), except the two endpoints and anything overlapping either endpoint's box (labels
// and shapes stacked on an end). Frames are containers, never obstacles: a connector routes freely
// across frame borders and inside the frame it belongs to. Pens and connectors are not obstacles
// either. Each obstacle is padded by OBSTACLE_PAD; one that swallows a port (the end of a stub) is
// dropped. At most MAX_OBSTACLES are used, the nearest to the line between the ports. The two end
// boxes are obstacles too, so a route never cuts back through its own ends.
//
// Elbow segments: an orthogonal route is a chain of alternating horizontal and vertical segments.
// The first runs through the start port along the start side's axis and the last through the end
// port, so they are fixed by the anchors; `segments` lists the positions of the ones in between,
// in order from the start, each as an offset from the midpoint of the two ports on the segment's
// axis (an x offset for a vertical segment, a y offset for a horizontal one). Offsets rather than
// absolute positions: moving both ends together moves the whole route, and moving one end moves
// each middle segment by half as much, so edits survive moves without breaking orthogonality.
// When the chain ends on the wrong axis for the end port, one automatic segment is added halfway,
// so any list is valid. At most MAX_SEGMENTS; an edit pins both sides (the route's shape depends on
// them) and "Reset route" clears the edits and the pins.

import { center, anchor, facingSide, rotatedBounds, pointsBounds, polylineMidpoint, distanceToPolyline, rectsIntersect, rotatePoint, fmt } from "./geometry.js";
import { cubicPoint, cubicBounds, cubicEndDirection, cubicMidpoint, closestOnCubic, flattenCubic, cubicPathD } from "./bezier.js";
import { LIMITS } from "./protocol.js";
import { orthogonalPath, headingOf, segmentCrossesRect, strictlyInside, simplifyOrthogonal, BEND_COST } from "./orthogonal.js";

/** @typedef {import("./protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */
/** @typedef {{x: number, y: number, w: number, h: number, rot?: number, id?: string, type?: string}} Box */
/** @typedef {"top"|"right"|"bottom"|"left"} Side4 */
/** @typedef {import("./bezier.js").Cubic} Cubic */

/** Length of the straight stub that leaves each anchor of an elbow route. */
export const STUB = 24;
/** Clearance kept around obstacles (less than STUB, so a port is outside its own end's padding). */
export const OBSTACLE_PAD = 16;
/** How far beyond the two ends' boxes obstacles are considered. */
export const REGION_MARGIN = 160;
/** Most obstacles one route considers. */
export const MAX_OBSTACLES = 32;
/** Most stored elbow segments. */
export const MAX_SEGMENTS = LIMITS.routeSegments;
/** Largest |u| and |v| of a stored curve handle. */
export const CURVE_LIMIT = LIMITS.curveHandle;
/** Curve control arm limits (world units). */
export const CURVE_ARM_MIN = 40;
export const CURVE_ARM_MAX = 480;
/** Tolerance of the polyline stored in a curved route's `points`. */
export const CURVE_FLATTEN_TOL = 0.5;
/** Object types that elbow routes avoid. */
export const OBSTACLE_TYPES = Object.freeze(new Set(["sticky", "rect", "ellipse", "text", "icon"]));
/** Cost added per place an automatic route passes through one of its own end boxes. */
const CROSS_PENALTY = 1e6;
const SIDES4 = /** @type {const} */ (["right", "bottom", "left", "top"]);

/**
 * @typedef {object} Route
 * @property {"polyline"|"cubic"} kind
 * @property {Point[]} points     polyline vertices; a curve's flattening (within CURVE_FLATTEN_TOL)
 * @property {Cubic|null} cubic   the curve, for curved routes
 * @property {Side4} fromSide
 * @property {Side4} toSide
 * @property {"straight"|"elbow"|"curved"} routing
 * @property {boolean} avoided    an elbow routed around obstacles
 */

/**
 * Where obstacles come from, and an optional memo of automatic elbow routes (by connector id,
 * checked against a signature of everything the route depends on, so sharing it is safe).
 * @typedef {object} RouteEnv
 * @property {(region: Rect) => Iterable<Box|undefined>} candidates  objects that may meet `region`
 *   (a superset is fine; exact tests happen here), with their current geometry
 * @property {Map<string, {sig: string, route: Route}>} [memo]
 */

/** Counters for tests and the benchmark (never content). */
export const CONNECTOR_STATS = { routes: 0, obstacleRoutes: 0, memoHits: 0, fastPaths: 0, searches: 0, fallbacks: 0 };

/** Resets CONNECTOR_STATS. */
export function resetConnectorStats() {
  for (const k of /** @type {(keyof typeof CONNECTOR_STATS)[]} */ (Object.keys(CONNECTOR_STATS))) CONNECTOR_STATS[k] = 0;
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** @param {Point} n @returns {Point} unit axis vector nearest to n */
export function axisNormal(n) {
  return Math.abs(n.x) >= Math.abs(n.y) ? { x: Math.sign(n.x) || 1, y: 0 } : { x: 0, y: Math.sign(n.y) || 1 };
}

/** @param {unknown} s @returns {Side4|null} */
function pinnedSide(s) {
  return s === "top" || s === "right" || s === "bottom" || s === "left" ? s : null;
}

/** @param {Rect} r @param {number} d @returns {Rect} */
function grow(r, d) {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

/** @param {number} v */
const r2 = (v) => Math.round(v * 100) / 100 + 0;

/** Valid stored elbow segments (finite numbers, at most MAX_SEGMENTS), else []. @param {unknown} v @returns {number[]} */
export function segmentsOf(v) {
  if (!Array.isArray(v) || !v.length) return [];
  const out = [];
  for (const x of v.slice(0, MAX_SEGMENTS)) {
    if (typeof x !== "number" || !Number.isFinite(x)) return [];
    out.push(x);
  }
  return out;
}

/** A valid stored curve handle, else null. @param {unknown} v @returns {[number, number]|null} */
export function curveOf(v) {
  return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x))
    ? /** @type {[number, number]} */ ([v[0], v[1]]) : null;
}

/** Whether a connector's route has user edits (segments or a curve handle) for its routing. @param {Partial<WhiteboardObject>} conn */
export function hasRouteEdits(conn) {
  if (conn.routing === "elbow") return segmentsOf(conn.segments).length > 0;
  if (conn.routing === "curved") return curveOf(conn.curve) !== null;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------------------------------

/**
 * Whether segment ab passes through the interior of box `o` (rotation included), shrunk by 0.5.
 * Liang–Barsky clipping in the box's own frame.
 * @param {Point} a @param {Point} b @param {Box} o
 */
function segmentThroughBox(a, b, o) {
  const c = center(o);
  const p = rotatePoint(a, c, -(o.rot ?? 0)), q = rotatePoint(b, c, -(o.rot ?? 0));
  const x0 = o.x + 0.5, x1 = o.x + o.w - 0.5, y0 = o.y + 0.5, y1 = o.y + o.h - 0.5;
  if (x1 <= x0 || y1 <= y0) return false;
  let t0 = 0, t1 = 1;
  const dx = q.x - p.x, dy = q.y - p.y;
  for (const [pp, qq] of [[-dx, p.x - x0], [dx, x1 - p.x], [-dy, p.y - y0], [dy, y1 - p.y]]) {
    if (pp === 0) { if (qq < 0) return false; continue; }
    const r = qq / pp;
    if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t1 - t0 > 1e-9;
}

/**
 * Cost of a side pair for automatic side choice (see the top of this file).
 * @param {"straight"|"elbow"|"curved"} routing @param {Box} from @param {Box} to @param {Side4} fs @param {Side4} ts
 */
function sidePairCost(routing, from, to, fs, ts) {
  const a = anchor(from, fs), b = anchor(to, ts);
  if (routing === "straight") {
    let cost = Math.hypot(b.point.x - a.point.x, b.point.y - a.point.y);
    if (segmentThroughBox(a.point, b.point, from)) cost += CROSS_PENALTY;
    if (segmentThroughBox(a.point, b.point, to)) cost += CROSS_PENALTY;
    return cost;
  }
  const pts = elbowFromSegments(a, b, []);
  let cost = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    cost += Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
    // Segments other than the two stubs must stay out of both boxes.
    if (i > 1 && i < pts.length - 1) {
      if (segmentThroughBox(p, q, from)) cost += CROSS_PENALTY;
      if (segmentThroughBox(p, q, to)) cost += CROSS_PENALTY;
    }
  }
  return cost + BEND_COST * Math.max(0, pts.length - 2);
}

/**
 * The sides a connector uses: pinned sides as given, "auto" ones by the lowest-cost pair.
 * @param {{fromSide?: string, toSide?: string, routing?: string}} conn @param {Box} from @param {Box} to
 * @returns {{fromSide: Side4, toSide: Side4}}
 */
export function chooseSides(conn, from, to) {
  const pf = pinnedSide(conn.fromSide), pt = pinnedSide(conn.toSide);
  if (pf && pt) return { fromSide: pf, toSide: pt };
  const routing = conn.routing === "elbow" || conn.routing === "curved" ? conn.routing : "straight";
  const lf = pf ?? facingSide(from, center(to)), lt = pt ?? facingSide(to, center(from));
  let best = { fromSide: lf, toSide: lt }, bestCost = sidePairCost(routing, from, to, lf, lt);
  for (const fs of pf ? [pf] : SIDES4) {
    for (const ts of pt ? [pt] : SIDES4) {
      if (fs === lf && ts === lt) continue;
      const cost = sidePairCost(routing, from, to, fs, ts);
      if (cost < bestCost - 1e-9) { best = { fromSide: fs, toSide: ts }; bestCost = cost; }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Elbows
// ---------------------------------------------------------------------------------------------

/**
 * The two ports (stub ends) of an elbow between anchors a and b, with snapped normals.
 * @param {{point: Point, normal: Point}} a @param {{point: Point, normal: Point}} b
 */
export function elbowPorts(a, b) {
  const na = axisNormal(a.normal), nb = axisNormal(b.normal);
  const p0 = a.point, p3 = b.point;
  const p1 = { x: p0.x + na.x * STUB, y: p0.y + na.y * STUB };
  const p2 = { x: p3.x + nb.x * STUB, y: p3.y + nb.y * STUB };
  return { p0, p1, p2, p3, na, nb, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } };
}

/**
 * The elbow route through stored segment offsets (see "Elbow segments" at the top). With no
 * segments this is the simple elbow: at most two bends between the stubs.
 * @param {{point: Point, normal: Point}} a @param {{point: Point, normal: Point}} b @param {number[]} segs
 * @returns {Point[]}
 */
export function elbowFromSegments(a, b, segs) {
  const { p0, p1, p2, p3, na, nb, mid } = elbowPorts(a, b);
  /** @type {Point[]} */
  const pts = [p0, p1];
  let horizontal = na.x !== 0;
  let cur = p1;
  for (const s of segs) {
    cur = horizontal ? { x: mid.x + s, y: cur.y } : { x: cur.x, y: mid.y + s };
    pts.push(cur);
    horizontal = !horizontal;
  }
  const arriveH = nb.x !== 0;
  if (horizontal === arriveH) {
    const aligned = horizontal ? Math.abs(cur.y - p2.y) <= 1e-9 : Math.abs(cur.x - p2.x) <= 1e-9;
    if (!aligned) {
      // One automatic segment halfway, perpendicular to the arrival axis.
      if (horizontal) pts.push({ x: mid.x, y: cur.y }, { x: mid.x, y: p2.y });
      else pts.push({ x: cur.x, y: mid.y }, { x: p2.x, y: mid.y });
    }
  } else {
    pts.push(horizontal ? { x: p2.x, y: cur.y } : { x: cur.x, y: p2.y });
  }
  pts.push(p2, p3);
  /** @type {Point[]} */
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > 0.01 || Math.abs(last.y - p.y) > 0.01) out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * The chain of alternating segments of an orthogonal route from anchor a to anchor b: for each,
 * its axis ("h": horizontal, at y = pos; "v": vertical, at x = pos) and its end points. The first
 * starts at the start anchor, the last ends at the end anchor; a doubling back is split by a
 * zero-length segment so axes always alternate.
 * @param {Point[]} points  an orthogonal polyline from anchor to anchor
 * @param {Point} na  snapped start normal
 * @returns {Array<{axis: "h"|"v", pos: number, a: Point, b: Point}>}
 */
export function segmentChain(points, na) {
  /** @type {Array<{axis: "h"|"v", pos: number, a: Point, b: Point}>} */
  const chain = [];
  const pts = simplifyOrthogonal(points);
  let axis = /** @type {"h"|"v"} */ (na.x !== 0 ? "h" : "v");
  let start = pts[0];
  let prev = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const q = pts[i];
    const moveAxis = Math.abs(q.y - prev.y) <= 0.01 ? "h" : "v";
    if (moveAxis !== axis) {
      chain.push({ axis, pos: axis === "h" ? start.y : start.x, a: start, b: prev });
      axis = moveAxis;
      start = prev;
    } else if (i > 1) {
      // Same axis but reversing direction: close the segment and add a zero-length turn.
      const back = (prev.x - start.x) * (q.x - prev.x) + (prev.y - start.y) * (q.y - prev.y) < 0;
      if (back) {
        chain.push({ axis, pos: axis === "h" ? start.y : start.x, a: start, b: prev });
        const other = axis === "h" ? "v" : "h";
        chain.push({ axis: other, pos: other === "h" ? prev.y : prev.x, a: prev, b: prev });
        start = prev;
      }
    }
    prev = q;
  }
  chain.push({ axis, pos: axis === "h" ? start.y : start.x, a: start, b: prev });
  return chain;
}

/**
 * Stored segment offsets that reproduce an orthogonal route between anchors a and b.
 * @param {{point: Point, normal: Point}} a @param {{point: Point, normal: Point}} b @param {Point[]} points
 * @returns {number[]|null} null when the route needs more than MAX_SEGMENTS
 */
export function segmentsFromPoints(a, b, points) {
  const { na, mid } = elbowPorts(a, b);
  const chain = segmentChain(points, na);
  const middle = chain.slice(1, -1);
  if (middle.length > MAX_SEGMENTS) return null;
  return middle.map((s) => r2(s.pos - (s.axis === "h" ? mid.y : mid.x)));
}

/**
 * The simple elbow between two anchors (compatibility name).
 * @param {{point: Point, normal: Point}} a @param {{point: Point, normal: Point}} b
 */
export function elbowPoints(a, b) {
  return elbowFromSegments(a, b, []);
}

// ---------------------------------------------------------------------------------------------
// Obstacles
// ---------------------------------------------------------------------------------------------

/**
 * The region whose objects an automatic elbow between `from` and `to` considers.
 * @param {Box} from @param {Box} to @returns {Rect}
 */
export function routeRegion(from, to) {
  const a = rotatedBounds(from), b = rotatedBounds(to);
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return grow({ x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }, REGION_MARGIN);
}

/** Distance from rect r to segment pq (0 when they meet). @param {Rect} r @param {Point} p @param {Point} q */
function rectSegmentDistance(r, p, q) {
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  const d = distanceToPolyline(c, [p.x, p.y, q.x, q.y]);
  return Math.max(0, d - Math.hypot(r.w, r.h) / 2);
}

/**
 * The padded obstacle rects an automatic elbow avoids (see the top of this file), sorted.
 * @param {Box} from @param {Box} to @param {Iterable<Box|undefined>} candidates
 * @param {Point} p1 @param {Point} p2  the ports
 * @returns {Rect[]}
 */
export function selectObstacles(from, to, candidates, p1, p2) {
  const region = routeRegion(from, to);
  const fb = rotatedBounds(from), tb = rotatedBounds(to);
  /** @type {Rect[]} */
  let list = [];
  const seen = new Set();
  for (const c of candidates) {
    if (!c || !c.type || !OBSTACLE_TYPES.has(c.type)) continue;
    if (c.id !== undefined && (c.id === from.id || c.id === to.id)) continue;
    const r = rotatedBounds(c);
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) continue;
    if (!rectsIntersect(r, region) || rectsIntersect(r, fb) || rectsIntersect(r, tb)) continue;
    const padded = grow(r, OBSTACLE_PAD);
    if (strictlyInside(p1, padded) || strictlyInside(p2, padded)) continue;
    const key = `${padded.x},${padded.y},${padded.w},${padded.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(padded);
  }
  if (list.length > MAX_OBSTACLES) {
    list = list
      .map((r) => ({ r, d: rectSegmentDistance(r, p1, p2) }))
      .toSorted((m, n) => m.d - n.d || m.r.x - n.r.x || m.r.y - n.r.y || m.r.w - n.r.w || m.r.h - n.r.h)
      .slice(0, MAX_OBSTACLES)
      .map((m) => m.r);
  }
  return list.toSorted((m, n) => m.x - n.x || m.y - n.y || m.w - n.w || m.h - n.h);
}

/**
 * The automatic elbow, around obstacles when an env is given (see the top of this file).
 * @param {Partial<WhiteboardObject>} conn @param {Box} from @param {Box} to
 * @param {{point: Point, normal: Point}} a @param {{point: Point, normal: Point}} b
 * @param {RouteEnv|undefined} env @param {Side4} fromSide @param {Side4} toSide
 * @returns {{points: Point[], avoided: boolean}}
 */
function autoElbow(conn, from, to, a, b, env, fromSide, toSide) {
  const base = elbowFromSegments(a, b, []);
  if (!env) return { points: base, avoided: false };
  const { p0, p1, p2, p3, na, nb } = elbowPorts(a, b);
  const obstacles = selectObstacles(from, to, env.candidates(routeRegion(from, to)), p1, p2);
  for (const own of [grow(rotatedBounds(from), OBSTACLE_PAD), grow(rotatedBounds(to), OBSTACLE_PAD)]) {
    if (!strictlyInside(p1, own) && !strictlyInside(p2, own)) obstacles.push(own);
  }
  const id = typeof conn.id === "string" ? conn.id : null;
  const sig = id && env.memo ? [
    fromSide, toSide, a.point.x, a.point.y, a.normal.x, a.normal.y, b.point.x, b.point.y, b.normal.x, b.normal.y,
    ...obstacles.flatMap((r) => [r.x, r.y, r.w, r.h]),
  ].join(",") : "";
  if (id && env.memo) {
    const hit = env.memo.get(id);
    if (hit && hit.sig === sig) {
      CONNECTOR_STATS.memoHits++;
      return { points: hit.route.points, avoided: hit.route.avoided };
    }
  }
  CONNECTOR_STATS.obstacleRoutes++;
  /** @type {{points: Point[], avoided: boolean}} */
  let result;
  let clear = true;
  for (let i = 1; i + 2 < base.length && clear; i++) {
    for (const r of obstacles) if (segmentCrossesRect(base[i], base[i + 1], r)) { clear = false; break; }
  }
  if (clear) {
    CONNECTOR_STATS.fastPaths++;
    result = { points: base, avoided: false };
  } else {
    CONNECTOR_STATS.searches++;
    const found = orthogonalPath(p1, headingOf(na), p2, headingOf({ x: -nb.x, y: -nb.y }), obstacles);
    if (found) result = { points: simplifyOrthogonal([p0, ...found.points, p3]), avoided: true };
    else { CONNECTOR_STATS.fallbacks++; result = { points: base, avoided: false }; }
  }
  if (id && env.memo) {
    env.memo.set(id, { sig, route: { kind: "polyline", points: result.points, cubic: null, fromSide, toSide, routing: "elbow", avoided: result.avoided } });
  }
  return result;
}

/**
 * An obstacle source over a plain object record (the server's export, the core and tests): a
 * bucket grid of the obstacle-type objects, built once.
 * @param {Record<string, WhiteboardObject>|Map<string, WhiteboardObject>} objects
 * @param {{memo?: boolean}} [opts]
 * @returns {RouteEnv}
 */
export function createRouteEnv(objects, { memo = false } = {}) {
  const CELL = 512;
  /** @type {Map<string, Box[]>} */
  const cells = new Map();
  /** @type {Box[]} */
  const all = [];
  const values = objects instanceof Map ? objects.values() : Object.values(objects);
  for (const o of values) {
    if (!o || !OBSTACLE_TYPES.has(o.type)) continue;
    const r = rotatedBounds(o);
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) continue;
    all.push(o);
    const x0 = Math.floor(r.x / CELL), x1 = Math.floor((r.x + r.w) / CELL);
    const y0 = Math.floor(r.y / CELL), y1 = Math.floor((r.y + r.h) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) { (cells.get("big") ?? cells.set("big", []).get("big"))?.push(o); continue; }
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const key = cx + ":" + cy;
      (cells.get(key) ?? cells.set(key, []).get(key))?.push(o);
    }
  }
  return {
    memo: memo ? new Map() : undefined,
    candidates(region) {
      const x0 = Math.floor(region.x / CELL), x1 = Math.floor((region.x + region.w) / CELL);
      const y0 = Math.floor(region.y / CELL), y1 = Math.floor((region.y + region.h) / CELL);
      if (!(Number.isFinite(x0) && Number.isFinite(x1) && Number.isFinite(y0) && Number.isFinite(y1)) ||
          (x1 - x0 + 1) * (y1 - y0 + 1) > cells.size) return all;
      /** @type {Set<Box>} */
      const out = new Set(cells.get("big") ?? []);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (const o of cells.get(cx + ":" + cy) ?? []) out.add(o);
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------------------------

/**
 * The curve's point for a stored handle [u, v] (see the top of this file).
 * @param {Point} p0 @param {Point} p3 @param {[number, number]} uv
 */
export function curveHandlePoint(p0, p3, uv) {
  const cx = p3.x - p0.x, cy = p3.y - p0.y;
  return { x: p0.x + uv[0] * cx - uv[1] * cy, y: p0.y + uv[0] * cy + uv[1] * cx };
}

/**
 * The stored handle [u, v] for a curve through `h`, or null when the anchors coincide.
 * @param {Point} p0 @param {Point} p3 @param {Point} h
 * @returns {[number, number]|null}
 */
export function curveFromHandle(p0, p3, h) {
  const cx = p3.x - p0.x, cy = p3.y - p0.y;
  const len2 = cx * cx + cy * cy;
  if (len2 < 1) return null;
  const dx = h.x - p0.x, dy = h.y - p0.y;
  const clamp = (/** @type {number} */ v) => Math.round(Math.max(-CURVE_LIMIT, Math.min(CURVE_LIMIT, v)) * 10000) / 10000 + 0;
  return [clamp((dx * cx + dy * cy) / len2), clamp((dy * cx - dx * cy) / len2)];
}

/**
 * The cubic of a curved connector between anchors a and b.
 * @param {{point: Point, normal: Point}} a @param {{point: Point, normal: Point}} b @param {[number, number]|null} uv
 * @returns {Cubic}
 */
export function curveCubic(a, b, uv) {
  const p0 = a.point, p3 = b.point;
  const d = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  const arm = Math.min(CURVE_ARM_MAX, Math.max(CURVE_ARM_MIN, d * 0.45));
  let c1 = { x: p0.x + a.normal.x * arm, y: p0.y + a.normal.y * arm };
  let c2 = { x: p3.x + b.normal.x * arm, y: p3.y + b.normal.y * arm };
  if (uv && d >= 1) {
    const h = curveHandlePoint(p0, p3, uv);
    const m = cubicPoint([p0, c1, c2, p3], 0.5);
    const dx = (h.x - m.x) * 4 / 3, dy = (h.y - m.y) * 4 / 3;
    c1 = { x: c1.x + dx, y: c1.y + dy };
    c2 = { x: c2.x + dx, y: c2.y + dy };
  }
  return [{ x: p0.x, y: p0.y }, c1, c2, { x: p3.x, y: p3.y }];
}

// ---------------------------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------------------------

/**
 * The route of a connector between two object boxes (use ghost geometry while dragging).
 * @param {Partial<WhiteboardObject>} conn  routing, sides, segments and curve are read; an empty
 *   object is a default straight connector with automatic sides
 * @param {Box} from @param {Box} to
 * @param {RouteEnv} [env]  obstacles for automatic elbows (without it: the simple elbow)
 * @returns {Route}
 */
export function connectorRoute(conn, from, to, env) {
  CONNECTOR_STATS.routes++;
  const routing = conn.routing === "elbow" || conn.routing === "curved" ? conn.routing : "straight";
  const segs = routing === "elbow" ? segmentsOf(conn.segments) : [];
  const auto = routing === "elbow" && !segs.length;
  // Memo of everything that depends only on the connector and its two ends (see RouteEnv): the
  // whole route, or for automatic elbows the side choice (their obstacles are checked below).
  const id = env?.memo && typeof conn.id === "string" ? conn.id : null;
  const key = id ? id + GEOMETRY_KEY : "";
  const sig = id ? [
    routing, conn.fromSide, conn.toSide, segs.join(":"), routing === "curved" ? curveOf(conn.curve)?.join(":") : "",
    from.x, from.y, from.w, from.h, from.rot || 0, to.x, to.y, to.w, to.h, to.rot || 0,
  ].join(",") : "";
  const hit = id ? env?.memo?.get(key) : undefined;
  if (hit && hit.sig === sig && !auto) { CONNECTOR_STATS.memoHits++; return hit.route; }
  const { fromSide, toSide } = hit && hit.sig === sig ? hit.route : chooseSides({ ...conn, routing }, from, to);
  const a = anchor(from, fromSide), b = anchor(to, toSide);
  /** @type {Route} */
  let route;
  if (routing === "curved") {
    const cubic = curveCubic(a, b, curveOf(conn.curve));
    route = { kind: "cubic", points: flattenCubic(cubic, CURVE_FLATTEN_TOL, 8), cubic, fromSide, toSide, routing, avoided: false };
  } else if (routing === "elbow" && segs.length) {
    route = { kind: "polyline", points: elbowFromSegments(a, b, segs), cubic: null, fromSide, toSide, routing, avoided: false };
  } else if (routing === "elbow") {
    const { points, avoided } = autoElbow(conn, from, to, a, b, env, fromSide, toSide);
    route = { kind: "polyline", points, cubic: null, fromSide, toSide, routing, avoided };
  } else {
    route = { kind: "polyline", points: [a.point, b.point], cubic: null, fromSide, toSide, routing, avoided: false };
  }
  if (id && !(hit && hit.sig === sig)) env?.memo?.set(key, { sig, route });
  return route;
}

/** Suffix of the memo key holding a connector's end-geometry memo (see connectorRoute). */
const GEOMETRY_KEY = "#g";

/**
 * Drops a connector's entries from a route memo (it was deleted).
 * @param {Map<string, unknown>} memo @param {string} id
 */
export function forgetRoute(memo, id) {
  memo.delete(id);
  memo.delete(id + GEOMETRY_KEY);
}

/** Exact axis-aligned bounds of a route. @param {Route} route @returns {Rect} */
export function routeBounds(route) {
  return route.cubic ? cubicBounds(route.cubic) : pointsBounds(route.points);
}

/** The point halfway along a route by length (label position). @param {Route} route @returns {Point} */
export function routeMidpoint(route) {
  return route.cubic ? cubicMidpoint(route.cubic) : polylineMidpoint(route.points);
}

/** Distance from p to a route. @param {Point} p @param {Route} route */
export function routeDistance(p, route) {
  if (route.cubic) return closestOnCubic(p, route.cubic).distance;
  return distanceToPolyline(p, route.points.flatMap((q) => [q.x, q.y]));
}

/** SVG path data of a route. @param {Route} route */
export function routePathD(route) {
  if (route.cubic) return cubicPathD(route.cubic, fmt);
  return route.points.map((p, i) => `${i ? "L" : "M"}${fmt(p.x)} ${fmt(p.y)}`).join("");
}

/**
 * Unit directions at the ends: `start` points from the start anchor into the line, `end` along
 * the line into the end anchor (the arrowhead directions are -start and end).
 * @param {Route} route @returns {{start: Point, end: Point}}
 */
export function routeEndDirections(route) {
  if (route.cubic) return { start: cubicEndDirection(route.cubic, "start"), end: cubicEndDirection(route.cubic, "end") };
  const pts = route.points;
  const dir = (/** @type {Point} */ p, /** @type {Point} */ q) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    return d > 1e-9 ? { x: (q.x - p.x) / d, y: (q.y - p.y) / d } : { x: 1, y: 0 };
  };
  if (pts.length < 2) return { start: { x: 1, y: 0 }, end: { x: 1, y: 0 } };
  return { start: dir(pts[0], pts[1]), end: dir(pts[pts.length - 2], pts[pts.length - 1]) };
}

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

/**
 * A draggable route handle: an elbow segment (moves along `axis`, perpendicular to itself) or the
 * curve handle (moves freely).
 * @typedef {object} RouteHandle
 * @property {"segment"|"curve"} kind
 * @property {number} index      segment index in the chain (0: through the start port); 0 for a curve
 * @property {"x"|"y"|"xy"} axis the coordinate a drag changes ("x": a vertical segment)
 * @property {Point} point       where the handle is drawn (world)
 * @property {boolean} anchored  an elbow segment through a port: dragging it adds a bend
 * @property {number} pos        the segment's current position on `axis` (segments)
 */

/**
 * The route handles of a connector (world positions). Elbows get one per segment of the chain
 * except those shorter than `minLength` world units; the segments through the ports only when
 * they reach beyond their stub. Curves get one at the curve's midpoint (t = 0.5). Straight lines
 * have none.
 * @param {Route} route @param {number} [minLength]
 * @returns {RouteHandle[]}
 */
export function routeHandles(route, minLength = 0) {
  if (route.cubic) return [{ kind: "curve", index: 0, axis: "xy", point: cubicPoint(route.cubic, 0.5), anchored: false, pos: 0 }];
  if (route.routing !== "elbow") return [];
  const pts = route.points;
  const na = axisNormal({ x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y });
  const chain = segmentChain(pts, na);
  /** @type {RouteHandle[]} */
  const out = [];
  chain.forEach((s, i) => {
    const first = i === 0, last = i === chain.length - 1;
    const anchored = first || last;
    let a = s.a, b = s.b;
    // Only the part beyond the stubs can move.
    const full = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    const trim = (first ? STUB : 0) + (last ? STUB : 0);
    if (anchored && full <= trim + minLength) return;
    if (first) a = { x: a.x + (b.x - a.x) * (STUB / full), y: a.y + (b.y - a.y) * (STUB / full) };
    if (last) b = { x: s.b.x + (s.a.x - s.b.x) * (STUB / full), y: s.b.y + (s.a.y - s.b.y) * (STUB / full) };
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    if (len < minLength) return;
    out.push({
      kind: "segment", index: i, axis: s.axis === "h" ? "y" : "x", anchored, pos: s.pos,
      point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    });
  });
  return out;
}

/**
 * New stored segments after moving chain segment `index` of an elbow route to position `pos` on
 * its axis. A middle segment just moves; a segment through a port gains a jog (two bends) next to
 * its stub. The result is canonical: bends that became straight are dropped.
 * @param {Box} from @param {Box} to @param {Route} route @param {number} index @param {number} pos
 * @returns {number[]|null} null when the result would need more than MAX_SEGMENTS
 */
export function moveElbowSegment(from, to, route, index, pos) {
  const a = anchor(from, route.fromSide), b = anchor(to, route.toSide);
  const { p1, p2, na, mid } = elbowPorts(a, b);
  const chain = segmentChain(route.points, na);
  const k = Math.max(0, Math.min(chain.length - 1, index));
  // Absolute positions of the free segments (chain[1..n-2]).
  let free = chain.slice(1, -1).map((s) => s.pos);
  if (chain.length === 1) {
    // One straight line through both ports: jog it near the start.
    free = chain[0].axis === "h" ? [p1.x, pos] : [p1.y, pos];
  } else if (k === 0) {
    free = [chain[0].axis === "h" ? p1.x : p1.y, pos, ...free];
  } else if (k === chain.length - 1) {
    free = [...free, pos, chain[k].axis === "h" ? p2.x : p2.y];
  } else {
    free[k - 1] = pos;
  }
  // Absolute to offsets, rebuild, and re-extract the canonical list.
  let axisH = na.x !== 0; // axis of chain[0]; free[0] is perpendicular to it
  const rel = free.map((v) => {
    axisH = !axisH;
    return axisH ? v - mid.y : v - mid.x;
  });
  const pts = elbowFromSegments(a, b, rel);
  return segmentsFromPoints(a, b, pts);
}

/**
 * The stored segments that reproduce `route` exactly (for starting an edit from an automatic
 * route), or null when that needs more than MAX_SEGMENTS.
 * @param {Box} from @param {Box} to @param {Route} route
 */
export function materializeSegments(from, to, route) {
  return segmentsFromPoints(anchor(from, route.fromSide), anchor(to, route.toSide), route.points);
}
