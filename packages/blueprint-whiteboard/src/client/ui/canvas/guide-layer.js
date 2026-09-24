// @ts-check
// Alignment guides and connector endpoint and route handles, drawn in the canvas's screen-space overlay.
// Guides come from ../../model/alignment.js (world coordinates); only the winning vertical and
// horizontal guide of a snap are ever drawn. Decorative: the overlay is aria-hidden and a snap is
// not announced (Align and Distribute are the accessible equivalents).

import { worldToScreen } from "./camera.js";
import { svgEl } from "./layers.js";

/** @typedef {import("../../model/alignment.js").Guide} Guide */
/** @typedef {{x: number, y: number, zoom: number}} Camera */

/** Screen pixels a guide extends past the objects it spans. */
const OVERHANG = 8;

/**
 * SVG lines (screen space) for `guides`.
 * @param {Guide[]} guides @param {Camera} cam
 * @returns {SVGElement[]}
 */
export function guideElements(guides, cam) {
  return guides.map((g) => {
    if (g.axis === "x") {
      const a = worldToScreen(cam, { x: g.x, y: g.y1 }), b = worldToScreen(cam, { x: g.x, y: g.y2 });
      return svgEl("line", { class: "wb-guide", x1: r1(a.x), y1: r1(a.y - OVERHANG), x2: r1(b.x), y2: r1(b.y + OVERHANG) });
    }
    const a = worldToScreen(cam, { x: g.x1, y: g.y }), b = worldToScreen(cam, { x: g.x2, y: g.y });
    return svgEl("line", { class: "wb-guide", x1: r1(a.x - OVERHANG), y1: r1(a.y), x2: r1(b.x + OVERHANG), y2: r1(b.y) });
  });
}

/**
 * Endpoint handles of a selected connector (screen positions from handles.endpointHandlePositions).
 * @param {Array<{name: string, x: number, y: number}>} handles
 * @returns {SVGElement[]}
 */
export function endpointHandleElements(handles) {
  return handles.map((hd) => svgEl("circle", { class: "wb-handle wb-endpoint-handle", "data-end": hd.name, cx: r1(hd.x), cy: r1(hd.y), r: 6 }));
}

/**
 * Route handles of a selected elbow or curved connector (route-edit.js), screen space: a small
 * rounded bar across each elbow segment (it moves across the segment) and a diamond for a curve.
 * The handle picked for keyboard editing is marked active.
 * @param {import("../../../shared/connectors.js").RouteHandle[]} handles @param {Camera} cam
 * @param {number} active  index of the keyboard-picked handle, or -1
 * @returns {SVGElement[]}
 */
export function routeHandleElements(handles, cam, active) {
  return handles.map((hd, i) => {
    const p = worldToScreen(cam, hd.point);
    const cls = "wb-handle wb-route-handle" + (i === active ? " wb-route-handle-active" : "");
    if (hd.kind === "curve") {
      return svgEl("rect", {
        class: cls, "data-route": String(i), "data-kind": "curve", x: r1(p.x - 5), y: r1(p.y - 5), width: 10, height: 10,
        transform: `rotate(45 ${r1(p.x)} ${r1(p.y)})`,
      });
    }
    const long = 14, short = 6;
    const w = hd.axis === "x" ? short : long, h = hd.axis === "x" ? long : short;
    return svgEl("rect", {
      class: cls, "data-route": String(i), "data-kind": "segment", "data-axis": hd.axis,
      x: r1(p.x - w / 2), y: r1(p.y - h / 2), width: w, height: h, rx: 3,
    });
  });
}

/** @param {number} v */
function r1(v) {
  return Math.round(v * 10) / 10;
}
