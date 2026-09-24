// @ts-check
// Alignment geometry, pure: snapping a moving or resizing box to other objects' edges and centres
// (and optionally to the grid), the guides to draw for the winning snap, and the Align / Distribute
// commands. Everything works on axis-aligned world rects; a rotated object takes part through its
// rotated bounds.
//
// Snapping rules:
//   - the moving box's left/centre/right snap to any candidate's left/centre/right (and the same
//     for top/middle/bottom); the nearest line within the threshold wins, per axis;
//   - the threshold is SNAP_PX screen pixels, so callers pass SNAP_PX / zoom world units and the
//     feel is the same at every zoom;
//   - candidates never include the moving set (the caller filters them);
//   - with a grid, an axis with no object snap snaps its nearest edge to a grid line;
//   - only the winning vertical and horizontal guides are returned (grid snaps draw none).

/** @typedef {{x: number, y: number, w: number, h: number}} Rect */
/** A vertical guide (axis "x", at world x, from y1 to y2) or a horizontal one (axis "y").
 * @typedef {{axis: "x", x: number, y1: number, y2: number} | {axis: "y", y: number, x1: number, x2: number}} Guide */
/** @typedef {{threshold: number, grid?: number}} SnapOptions */
/** @typedef {"left"|"center"|"right"|"top"|"middle"|"bottom"} AlignMode */

/** Snap distance in screen pixels (divide by zoom for world units). */
export const SNAP_PX = 6;
/** Two lines closer than this (world units) count as the same line when drawing a guide. */
const SAME_LINE = 0.01;

/** @param {Rect} r @returns {[number, number, number]} */
const xLines = (r) => [r.x, r.x + r.w / 2, r.x + r.w];
/** @param {Rect} r @returns {[number, number, number]} */
const yLines = (r) => [r.y, r.y + r.h / 2, r.y + r.h];

/**
 * The nearest (moving line, target line) pair on one axis within `threshold`, or null.
 * Ties go to the earlier moving line and then the earlier target, so results are stable.
 * @param {number[]} moving @param {Rect[]} targets @param {(r: Rect) => number[]} linesOf @param {number} threshold
 * @returns {{delta: number, line: number}|null}
 */
function nearest(moving, targets, linesOf, threshold) {
  let best = null, bestD = Infinity;
  for (const t of targets) {
    for (const line of linesOf(t)) {
      for (const m of moving) {
        const d = Math.abs(line - m);
        if (d <= threshold && d < bestD) { bestD = d; best = { delta: line - m, line }; }
      }
    }
  }
  return best;
}

/**
 * Grid snap of the nearest of `moving` to a multiple of `grid`, or null.
 * @param {number[]} moving @param {number} grid @param {number} threshold
 */
function nearestGrid(moving, grid, threshold) {
  if (!(grid > 0)) return null;
  let best = null, bestD = Infinity;
  for (const m of moving) {
    const line = Math.round(m / grid) * grid;
    const d = Math.abs(line - m);
    if (d <= threshold && d < bestD) { bestD = d; best = { delta: line - m, line }; }
  }
  return best;
}

/**
 * The guide along x = `line`, spanning the snapped box and every target touching that line.
 * @param {number} line @param {Rect} box @param {Rect[]} targets
 * @returns {Guide}
 */
function vGuide(line, box, targets) {
  let y1 = box.y, y2 = box.y + box.h;
  for (const t of targets) {
    if (!xLines(t).some((v) => Math.abs(v - line) <= SAME_LINE)) continue;
    y1 = Math.min(y1, t.y); y2 = Math.max(y2, t.y + t.h);
  }
  return { axis: "x", x: line, y1, y2 };
}

/** @param {number} line @param {Rect} box @param {Rect[]} targets @returns {Guide} */
function hGuide(line, box, targets) {
  let x1 = box.x, x2 = box.x + box.w;
  for (const t of targets) {
    if (!yLines(t).some((v) => Math.abs(v - line) <= SAME_LINE)) continue;
    x1 = Math.min(x1, t.x); x2 = Math.max(x2, t.x + t.w);
  }
  return { axis: "y", y: line, x1, x2 };
}

/**
 * Snaps a moving box (the union of the moving set's bounds at the unsnapped position).
 * @param {Rect} box @param {Rect[]} targets  candidates, never the moving set
 * @param {SnapOptions} opts
 * @returns {{dx: number, dy: number, guides: Guide[]}}  add (dx, dy) to the move
 */
export function snapMove(box, targets, { threshold, grid = 0 }) {
  const sx = nearest(xLines(box), targets, xLines, threshold);
  const sy = nearest(yLines(box), targets, yLines, threshold);
  const gx = sx ? null : nearestGrid(xLines(box), grid, threshold);
  const gy = sy ? null : nearestGrid(yLines(box), grid, threshold);
  const dx = sx?.delta ?? gx?.delta ?? 0, dy = sy?.delta ?? gy?.delta ?? 0;
  const snapped = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
  /** @type {Guide[]} */
  const guides = [];
  if (sx) guides.push(vGuide(sx.line, snapped, targets));
  if (sy) guides.push(hGuide(sy.line, snapped, targets));
  return { dx, dy, guides };
}

/**
 * Snaps the edges a resize handle moves, for an unrotated box. `handle` is a compass name
 * ("e", "nw", ...). Edges that would cross the opposite edge (below `minSize`) do not snap.
 * @param {Rect} box  the box after the unsnapped resize
 * @param {string} handle @param {Rect[]} targets @param {SnapOptions & {minSize?: number}} opts
 * @returns {{box: Rect, guides: Guide[]}}
 */
export function snapResize(box, handle, targets, { threshold, grid = 0, minSize = 1 }) {
  let x0 = box.x, y0 = box.y, x1 = box.x + box.w, y1 = box.y + box.h;
  /** @type {Guide[]} */
  const guides = [];
  const hasE = handle.includes("e"), hasW = handle.includes("w");
  const hasN = handle.startsWith("n"), hasS = handle.startsWith("s");
  /** @param {number} edge @param {(r: Rect) => number[]} linesOf */
  const snapEdge = (edge, linesOf) => nearest([edge], targets, linesOf, threshold) ?? nearestGrid([edge], grid, threshold);
  let vx = null, hy = null;
  if (hasE || hasW) {
    const edge = hasE ? x1 : x0;
    const s = snapEdge(edge, xLines);
    const next = s ? edge + s.delta : edge;
    if (s && (hasE ? next - x0 >= minSize : x1 - next >= minSize)) {
      if (hasE) x1 = next; else x0 = next;
      if (nearest([edge], targets, xLines, threshold)) vx = next;
    }
  }
  if (hasN || hasS) {
    const edge = hasS ? y1 : y0;
    const s = snapEdge(edge, yLines);
    const next = s ? edge + s.delta : edge;
    if (s && (hasS ? next - y0 >= minSize : y1 - next >= minSize)) {
      if (hasS) y1 = next; else y0 = next;
      if (nearest([edge], targets, yLines, threshold)) hy = next;
    }
  }
  const out = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (vx !== null) guides.push(vGuide(vx, out, targets));
  if (hy !== null) guides.push(hGuide(hy, out, targets));
  return { box: out, guides };
}

/**
 * Per-unit offsets that align `units` (each an id and its bounds) to the selection's left edge,
 * horizontal centre, right edge, top edge, vertical middle or bottom edge. Fewer than two units:
 * no offsets.
 * @param {Array<{id: string, rect: Rect}>} units @param {AlignMode} mode
 * @returns {Map<string, {dx: number, dy: number}>}
 */
export function alignDeltas(units, mode) {
  /** @type {Map<string, {dx: number, dy: number}>} */
  const out = new Map();
  if (units.length < 2) return out;
  const minX = Math.min(...units.map((u) => u.rect.x)), maxX = Math.max(...units.map((u) => u.rect.x + u.rect.w));
  const minY = Math.min(...units.map((u) => u.rect.y)), maxY = Math.max(...units.map((u) => u.rect.y + u.rect.h));
  for (const { id, rect: r } of units) {
    let dx = 0, dy = 0;
    switch (mode) {
      case "left": dx = minX - r.x; break;
      case "center": dx = (minX + maxX) / 2 - (r.x + r.w / 2); break;
      case "right": dx = maxX - (r.x + r.w); break;
      case "top": dy = minY - r.y; break;
      case "middle": dy = (minY + maxY) / 2 - (r.y + r.h / 2); break;
      case "bottom": dy = maxY - (r.y + r.h); break;
    }
    out.set(id, { dx, dy });
  }
  return out;
}

/**
 * Per-unit offsets that space `units` evenly along an axis: sorted by centre (ties by id), the
 * first and last stay put and the gaps between neighbours become equal. Fewer than three units:
 * no offsets.
 * @param {Array<{id: string, rect: Rect}>} units @param {"horizontal"|"vertical"} axis
 * @returns {Map<string, {dx: number, dy: number}>}
 */
export function distributeDeltas(units, axis) {
  /** @type {Map<string, {dx: number, dy: number}>} */
  const out = new Map();
  if (units.length < 3) return out;
  const h = axis === "horizontal";
  const pos = (/** @type {Rect} */ r) => (h ? r.x : r.y);
  const len = (/** @type {Rect} */ r) => (h ? r.w : r.h);
  const sorted = [...units].sort((a, b) =>
    (pos(a.rect) + len(a.rect) / 2) - (pos(b.rect) + len(b.rect) / 2) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const first = sorted[0].rect, last = sorted[sorted.length - 1].rect;
  const span = pos(last) + len(last) - pos(first);
  const total = sorted.reduce((s, u) => s + len(u.rect), 0);
  const gap = (span - total) / (sorted.length - 1);
  let at = pos(first);
  for (const u of sorted) {
    let d = at - pos(u.rect);
    if (Math.abs(d) < 1e-9) d = 0;
    out.set(u.id, h ? { dx: d, dy: 0 } : { dx: 0, dy: d });
    at += len(u.rect) + gap;
  }
  return out;
}

/** Labels of the Align and Distribute commands (buttons, menu items, announcements). */
export const ALIGN_LABELS = Object.freeze({
  left: "Align left edges", center: "Align horizontal centres", right: "Align right edges",
  top: "Align top edges", middle: "Align vertical middles", bottom: "Align bottom edges",
});
export const DISTRIBUTE_LABELS = Object.freeze({
  horizontal: "Distribute horizontally", vertical: "Distribute vertically",
});
