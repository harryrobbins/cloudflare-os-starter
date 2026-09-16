// @ts-check
// Camera math. Pure: no DOM. The camera maps world to screen as screen = (world - {x, y}) * zoom,
// with screen coordinates in CSS pixels relative to the canvas element's top-left corner.

import { ZOOM_MIN, ZOOM_MAX } from "../../../shared/protocol.js";
import { fitCamera, center } from "../../../shared/geometry.js";

/** @typedef {{x: number, y: number, zoom: number}} Camera */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */

/** @param {number} zoom */
export function clampZoom(zoom) {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/** @param {Camera} cam @returns {Camera} a finite camera with a clamped zoom */
export function cleanCamera(cam) {
  return {
    x: Number.isFinite(cam?.x) ? cam.x : 0,
    y: Number.isFinite(cam?.y) ? cam.y : 0,
    zoom: clampZoom(cam?.zoom),
  };
}

/** @param {Camera} cam @param {Point} s @returns {Point} */
export function screenToWorld(cam, s) {
  return { x: s.x / cam.zoom + cam.x, y: s.y / cam.zoom + cam.y };
}

/** @param {Camera} cam @param {Point} w @returns {Point} */
export function worldToScreen(cam, w) {
  return { x: (w.x - cam.x) * cam.zoom, y: (w.y - cam.y) * cam.zoom };
}

/**
 * Zooms to `zoom` (clamped) keeping the world point under screen point `s` fixed.
 * @param {Camera} cam @param {Point} s @param {number} zoom
 * @returns {Camera}
 */
export function zoomAt(cam, s, zoom) {
  const z = clampZoom(zoom);
  const w = screenToWorld(cam, s);
  return { x: w.x - s.x / z, y: w.y - s.y / z, zoom: z };
}

/**
 * Pans by a screen-pixel delta (content follows the pointer).
 * @param {Camera} cam @param {number} dx @param {number} dy
 * @returns {Camera}
 */
export function panBy(cam, dx, dy) {
  return { x: cam.x - dx / cam.zoom, y: cam.y - dy / cam.zoom, zoom: cam.zoom };
}

/**
 * The world rect visible in a view of `w` x `h` pixels.
 * @param {Camera} cam @param {number} w @param {number} h
 * @returns {Rect}
 */
export function viewportOf(cam, w, h) {
  return { x: cam.x, y: cam.y, w: Math.max(1, w) / cam.zoom, h: Math.max(1, h) / cam.zoom };
}

/** SVG transform attribute for the camera group. @param {Camera} cam */
export function cameraTransform(cam) {
  const r = (/** @type {number} */ v) => Math.round(v * 1000) / 1000;
  return `matrix(${r(cam.zoom)} 0 0 ${r(cam.zoom)} ${r(-cam.x * cam.zoom)} ${r(-cam.y * cam.zoom)})`;
}

/**
 * Camera that fits `rect` into the view, zoom clamped (and at most `maxZoom`).
 * @param {Rect} rect @param {number} viewW @param {number} viewH
 * @param {{padding?: number, maxZoom?: number}} [opts]
 * @returns {Camera}
 */
export function fitRect(rect, viewW, viewH, { padding = 40, maxZoom = ZOOM_MAX } = {}) {
  const pad = Math.min(padding, Math.max(0, Math.min(viewW, viewH) / 4));
  return fitCamera(rect, Math.max(1, viewW), Math.max(1, viewH), { padding: pad, minZoom: ZOOM_MIN, maxZoom: Math.min(ZOOM_MAX, maxZoom) });
}

/**
 * Camera centred on world point `c` at `zoom`.
 * @param {Point} c @param {number} zoom @param {number} viewW @param {number} viewH
 * @returns {Camera}
 */
export function centerOn(c, zoom, viewW, viewH) {
  const z = clampZoom(zoom);
  return { x: c.x - viewW / 2 / z, y: c.y - viewH / 2 / z, zoom: z };
}

/**
 * Pans (and zooms out only when needed) so `rect` is visible with `margin` pixels to spare.
 * @param {Camera} cam @param {Rect} rect @param {number} viewW @param {number} viewH @param {number} [margin]
 * @returns {Camera}
 */
export function revealRect(cam, rect, viewW, viewH, margin = 40) {
  const view = viewportOf(cam, viewW, viewH);
  const m = margin / cam.zoom;
  const inside = rect.x >= view.x + m && rect.y >= view.y + m &&
    rect.x + rect.w <= view.x + view.w - m && rect.y + rect.h <= view.y + view.h - m;
  if (inside) return cam;
  const fit = fitRect(rect, viewW, viewH, { padding: margin });
  const zoom = Math.min(cam.zoom, fit.zoom);
  return centerOn(center(rect), zoom, viewW, viewH);
}

/**
 * Interpolates between cameras; zoom geometrically so the motion looks even.
 * @param {Camera} a @param {Camera} b @param {number} t  0..1
 * @param {number} viewW @param {number} viewH
 * @returns {Camera}
 */
export function lerpCamera(a, b, t, viewW, viewH) {
  if (t >= 1) return b;
  const zoom = a.zoom * Math.pow(b.zoom / a.zoom, t);
  // Interpolate the view centres, not the top-left corners, so zooming does not swing sideways.
  const ca = { x: a.x + viewW / 2 / a.zoom, y: a.y + viewH / 2 / a.zoom };
  const cb = { x: b.x + viewW / 2 / b.zoom, y: b.y + viewH / 2 / b.zoom };
  return centerOn({ x: ca.x + (cb.x - ca.x) * t, y: ca.y + (cb.y - ca.y) * t }, zoom, viewW, viewH);
}

/** @param {number} t */
export function easeOutCubic(t) {
  return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
}

/**
 * Background pattern spacing in screen pixels for a base spacing in world units: multiplied by 5
 * until it is at least `minPx`, so dots never get denser than that on screen.
 * @param {number} zoom @param {number} [base] @param {number} [minPx]
 */
export function gridSpacing(zoom, base = 24, minPx = 12) {
  let s = base * zoom;
  for (let i = 0; i < 12 && s < minPx; i++) s *= 5;
  return s;
}

/**
 * Wheel delta in pixels (deltaMode 1 = lines, 2 = pages).
 * @param {{deltaX: number, deltaY: number, deltaMode: number}} e @param {number} pageH
 */
export function wheelPixels(e, pageH = 800) {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageH : 1;
  return { dx: e.deltaX * k, dy: e.deltaY * k };
}

/**
 * Zoom factor for a wheel event: pinch gestures (ctrlKey) are fine-grained, mouse wheels coarse.
 * @param {number} dy pixels @param {boolean} pinch
 */
export function wheelZoomFactor(dy, pinch) {
  const k = pinch ? 0.01 : 0.0015;
  return Math.exp(-Math.max(-300, Math.min(300, dy)) * k);
}
