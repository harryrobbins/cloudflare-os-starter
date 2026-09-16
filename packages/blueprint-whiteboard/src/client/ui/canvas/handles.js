// @ts-check
// Selection handles: where they are, which one a pointer is over, and the geometry a resize or
// rotate produces. Pure. Handles live in the object's rotated frame; resizing keeps the handle
// opposite the dragged one fixed in world space, whatever the rotation.

import { center, rotatePoint } from "../../../shared/geometry.js";
import { ROTATABLE, LIMITS } from "../../../shared/protocol.js";
import { worldToScreen } from "./camera.js";

/** @typedef {import("../../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{x: number, y: number, w: number, h: number, rot: number}} Box */
/** @typedef {"nw"|"n"|"ne"|"e"|"se"|"s"|"sw"|"w"} ResizeHandle */
/** @typedef {ResizeHandle|"rotate"} Handle */

export const RESIZE_HANDLES = /** @type {const} */ (["nw", "n", "ne", "e", "se", "s", "sw", "w"]);
/** Screen pixels between the top edge and the rotate handle. */
export const ROTATE_OFFSET_PX = 28;
/** Rotation snap step with Shift, degrees. */
export const ROTATE_SNAP = 15;
/** Smallest size a resize produces, world units. */
export const MIN_RESIZE = 8;

/** @param {string} type */
export const isRotatable = (type) => /** @type {readonly string[]} */ (ROTATABLE).includes(type);
/** @param {string} type */
export const isResizable = (type) => type !== "connector";

/**
 * The unrotated local position of a resize handle.
 * @param {{x: number, y: number, w: number, h: number}} o @param {ResizeHandle} name
 * @returns {Point}
 */
export function handleLocal(o, name) {
  const x = name.includes("w") ? o.x : name.includes("e") ? o.x + o.w : o.x + o.w / 2;
  const y = name.startsWith("n") ? o.y : name.startsWith("s") ? o.y + o.h : o.y + o.h / 2;
  return { x, y };
}

/**
 * Screen positions of the handles of a single selected object.
 * @param {WhiteboardObject|Box & {type: string}} o
 * @param {{x: number, y: number, zoom: number}} cam
 * @returns {Array<{name: Handle, x: number, y: number}>}
 */
export function handlePositions(o, cam) {
  if (!isResizable(o.type)) return [];
  const c = center(o);
  const rot = o.rot ?? 0;
  /** @type {Array<{name: Handle, x: number, y: number}>} */
  const out = RESIZE_HANDLES.map((name) => ({ name, ...worldToScreen(cam, rotatePoint(handleLocal(o, name), c, rot)) }));
  if (isRotatable(o.type)) {
    const top = { x: c.x, y: o.y - ROTATE_OFFSET_PX / cam.zoom };
    out.push({ name: "rotate", ...worldToScreen(cam, rotatePoint(top, c, rot)) });
  }
  return out;
}

/**
 * The handle within `radius` screen pixels of `s` (nearest wins; rotate loses ties).
 * @param {Array<{name: Handle, x: number, y: number}>} handles @param {Point} s @param {number} radius
 * @returns {Handle|null}
 */
export function handleAt(handles, s, radius) {
  let best = null, bestD = Infinity;
  for (const hnd of handles) {
    const d = Math.hypot(hnd.x - s.x, hnd.y - s.y);
    if (d <= radius && d < bestD) { best = hnd.name; bestD = d; }
  }
  return best;
}

/**
 * The box after dragging `handle` of box `o` to world point `p`.
 * @param {Box} o @param {ResizeHandle} handle @param {Point} p
 * @param {boolean} [keepAspect] @param {number} [minSize]
 * @returns {Box}
 */
export function resizeBox(o, handle, p, keepAspect = false, minSize = MIN_RESIZE) {
  const rot = o.rot ?? 0;
  const c0 = center(o);
  const lp = rotatePoint(p, c0, -rot);
  const min = Math.min(minSize, o.w, o.h, minSize);
  let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
  const hasE = handle.includes("e"), hasW = handle.includes("w");
  const hasN = handle.startsWith("n"), hasS = handle.startsWith("s");
  if (hasE) x1 = Math.max(lp.x, x0 + min);
  if (hasW) x0 = Math.min(lp.x, x1 - min);
  if (hasS) y1 = Math.max(lp.y, y0 + min);
  if (hasN) y0 = Math.min(lp.y, y1 - min);
  if (keepAspect && o.w > 0 && o.h > 0) {
    const ratio = o.w / o.h;
    if ((hasE || hasW) && (hasN || hasS)) {
      const s = Math.max((x1 - x0) / o.w, (y1 - y0) / o.h);
      const nw = o.w * s, nh = o.h * s;
      if (hasE) x1 = x0 + nw; else x0 = x1 - nw;
      if (hasS) y1 = y0 + nh; else y0 = y1 - nh;
    } else if (hasE || hasW) {
      const nh = (x1 - x0) / ratio, cy = o.y + o.h / 2;
      y0 = cy - nh / 2; y1 = cy + nh / 2;
    } else {
      const nw = (y1 - y0) * ratio, cx = o.x + o.w / 2;
      x0 = cx - nw / 2; x1 = cx + nw / 2;
    }
  }
  const w = Math.min(LIMITS.sizeMax, Math.max(LIMITS.sizeMin, x1 - x0));
  const h = Math.min(LIMITS.sizeMax, Math.max(LIMITS.sizeMin, y1 - y0));
  const wc = rotatePoint({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, c0, rot);
  return { x: round2(wc.x - w / 2), y: round2(wc.y - h / 2), w: round2(w), h: round2(h), rot };
}

/**
 * Rotation (degrees clockwise, [0, 360)) that points the rotate handle at `p`.
 * @param {{x: number, y: number, w: number, h: number}} o @param {Point} p @param {boolean} [snap]
 */
export function rotationToward(o, p, snap = false) {
  const c = center(o);
  let deg = Math.atan2(p.y - c.y, p.x - c.x) * 180 / Math.PI + 90;
  if (snap) deg = Math.round(deg / ROTATE_SNAP) * ROTATE_SNAP;
  deg = ((deg % 360) + 360) % 360;
  const r = Math.round(deg * 10) / 10;
  return r >= 360 ? 0 : r;
}

/**
 * CSS cursor for a handle on an object rotated by `rot`.
 * @param {Handle} handle @param {number} rot
 */
export function cursorForHandle(handle, rot) {
  if (handle === "rotate") return "grab";
  const base = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }[handle];
  const a = (((base + rot) % 180) + 180) % 180;
  const i = Math.round(a / 45) % 4;
  return ["ns-resize", "nesw-resize", "ew-resize", "nwse-resize"][i];
}

/** @param {number} v */
function round2(v) {
  return Math.round(v * 100) / 100 + 0;
}
