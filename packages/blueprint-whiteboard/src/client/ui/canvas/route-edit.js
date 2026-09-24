// @ts-check
// Editing a connector's route (src/shared/connectors.js): the route handles of a selected elbow or
// curved connector, the pointer gesture that drags one, the same edit from the keyboard, and
// pinning a side when a connector end is dropped near it.
//
//   Elbow   one handle per segment. Dragging moves the segment perpendicular to itself (Miro,
//           draw.io and Figma style); a segment through a port gains a jog next to its stub. The
//           segment snaps to other objects' edges and centres, to the ports' lines and to the
//           segments on the same axis (a straight-through alignment, which removes bends), unless
//           Alt is held. The edit pins both sides, since the stored offsets assume them.
//   Curved  one handle where the curve passes halfway (t = 0.5). Dragging it bends the curve
//           through the pointer; dropping it back on the default curve's midpoint clears the edit.
//
// While dragging, the new route is drawn locally (a route override on the connector) and sent as
// a presence transform on the connector, so collaborators see a ghost; release commits ONE update
// (one undo step). Escape or a lost pointer restores the committed route.

import { anchor } from "../../../shared/geometry.js";
import {
  routeHandles, moveElbowSegment, curveFromHandle, curveCubic, elbowPorts, segmentChain, axisNormal,
  hasRouteEdits,
} from "../../../shared/connectors.js";
import { cubicPoint } from "../../../shared/bezier.js";
import { snapMove } from "../../model/alignment.js";
import { worldToScreen } from "./camera.js";
import { connectorRouteOf, round2 } from "./model.js";
import { beyondThreshold } from "./gestures.js";

/** @typedef {import("../../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../../../shared/protocol.js").ObjectPatch} ObjectPatch */
/** @typedef {import("../../../shared/connectors.js").Route} Route */
/** @typedef {import("../../../shared/connectors.js").RouteHandle} RouteHandle */
/** @typedef {import("./gestures.js").GestureContext} GestureContext */
/** @typedef {import("./gestures.js").PointerSample} PointerSample */
/** @typedef {import("./gestures.js").Gesture} Gesture */
/** @typedef {import("../../model/alignment.js").Guide} Guide */
/** @typedef {{x: number, y: number, zoom: number}} Camera */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */

/**
 * The route fields an edit in progress overrides.
 * @typedef {{segments?: number[], curve?: [number, number]|null, fromSide?: string, toSide?: string, routing?: string}} RouteEditFields
 */

/** Screen pixels a route segment must be long to get a handle. */
export const ROUTE_HANDLE_MIN_PX = 28;
/** Screen radius of a route handle's hit area (mouse); touch uses TOUCH_RADIUS (a 44 px target). */
export const ROUTE_HANDLE_RADIUS = 9;
export const ROUTE_HANDLE_TOUCH_RADIUS = 22;
/** Screen pixels within which a dropped connector end pins the side it is near. */
export const SIDE_PIN_PX = 16;
export const SIDE_PIN_TOUCH_PX = 24;

/**
 * Whether a connector has route handles (elbow or curved).
 * @param {WhiteboardObject|undefined|null} o
 */
export function hasRouteHandles(o) {
  return !!o && o.type === "connector" && (o.routing === "elbow" || o.routing === "curved");
}

/**
 * The route handles of a connector in world coordinates, with segments too short on screen left out.
 * @param {WhiteboardObject} conn @param {(id: string) => WhiteboardObject|undefined} resolve
 * @param {import("../../../shared/connectors.js").RouteEnv|undefined} env @param {number} zoom
 * @returns {{route: Route, handles: RouteHandle[]}|null}
 */
export function connectorHandles(conn, resolve, env, zoom) {
  if (!hasRouteHandles(conn)) return null;
  const route = connectorRouteOf(conn, resolve, env);
  if (!route) return null;
  return { route, handles: routeHandles(route, ROUTE_HANDLE_MIN_PX / Math.max(1e-6, zoom)) };
}

/**
 * The route handle nearest to screen point `s` within `radius`, or null.
 * @param {RouteHandle[]} handles @param {Camera} cam @param {{x: number, y: number}} s @param {number} radius
 * @returns {number|null} index into `handles`
 */
export function routeHandleAt(handles, cam, s, radius) {
  let best = null, bestD = Infinity;
  handles.forEach((hd, i) => {
    const p = worldToScreen(cam, hd.point);
    const d = Math.hypot(p.x - s.x, p.y - s.y);
    if (d <= radius && d < bestD) { best = i; bestD = d; }
  });
  return best;
}

/**
 * Hit radius of route handles for a pointer type.
 * @param {string} pointerType
 */
export function routeHandleRadius(pointerType) {
  return pointerType === "touch" ? ROUTE_HANDLE_TOUCH_RADIUS : ROUTE_HANDLE_RADIUS;
}

/**
 * The side of `o` whose anchor (the middle of the side) is within `radius` world units of `p`,
 * or null (the side then stays automatic).
 * @param {{x: number, y: number, w: number, h: number, rot?: number}} o @param {{x: number, y: number}} p @param {number} radius
 * @returns {"top"|"right"|"bottom"|"left"|null}
 */
export function sideNear(o, p, radius) {
  let best = null, bestD = Infinity;
  for (const side of /** @type {const} */ (["top", "right", "bottom", "left"])) {
    const a = anchor(o, side).point;
    const d = Math.hypot(a.x - p.x, a.y - p.y);
    if (d <= radius && d < bestD) { best = side; bestD = d; }
  }
  return best;
}

/**
 * The route edit for moving handle `hd` of `route` to world point `p` (segments move along their
 * axis only), before snapping. Returns the fields to override, or null when nothing can change.
 * @param {WhiteboardObject} conn @param {WhiteboardObject} from @param {WhiteboardObject} to
 * @param {Route} route @param {RouteHandle} hd @param {{x: number, y: number}} p
 * @returns {RouteEditFields|null}
 */
export function editForHandle(conn, from, to, route, hd, p) {
  if (hd.kind === "curve" && route.cubic) {
    const a = anchor(from, route.fromSide), b = anchor(to, route.toSide);
    // Back on the default curve's midpoint (within half a unit): no edit.
    const plain = cubicPoint(curveCubic(a, b, null), 0.5);
    if (Math.hypot(plain.x - p.x, plain.y - p.y) < 0.5) return { curve: null };
    const uv = curveFromHandle(route.cubic[0], route.cubic[3], p);
    return uv ? { curve: uv } : null;
  }
  if (hd.kind !== "segment") return null;
  const pos = round2(hd.axis === "x" ? p.x : p.y);
  const segs = moveElbowSegment(from, to, route, hd.index, pos);
  if (!segs) return null;
  return { segments: segs, fromSide: route.fromSide, toSide: route.toSide };
}

/**
 * Lines a dragged elbow segment snaps to besides other objects: the ports' lines on its axis and
 * the positions of the other segments on the same axis (straight-through alignments).
 * @param {WhiteboardObject} from @param {WhiteboardObject} to @param {Route} route @param {RouteHandle} hd
 * @returns {number[]}
 */
export function straightThroughLines(from, to, route, hd) {
  const { p1, p2 } = elbowPorts(anchor(from, route.fromSide), anchor(to, route.toSide));
  const lines = hd.axis === "x" ? [p1.x, p2.x] : [p1.y, p2.y];
  const na = axisNormal({ x: route.points[1].x - route.points[0].x, y: route.points[1].y - route.points[0].y });
  const chain = segmentChain(route.points, na);
  chain.forEach((s, i) => {
    if (i !== hd.index && (s.axis === "h") === (hd.axis === "y")) lines.push(s.pos);
  });
  return lines;
}

/**
 * The patch that commits an edit (the fields that differ from the connector), or null.
 * @param {WhiteboardObject} conn @param {RouteEditFields} edit
 * @returns {ObjectPatch|null}
 */
export function routePatch(conn, edit) {
  /** @type {Record<string, any>} */
  const patch = {};
  const same = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (edit.segments && !same(edit.segments.length ? edit.segments : null, conn.segments?.length ? conn.segments : null)) patch.segments = edit.segments;
  if ("curve" in edit && !same(edit.curve, conn.curve)) patch.curve = edit.curve ?? null;
  if (edit.fromSide && edit.fromSide !== conn.fromSide) patch.fromSide = edit.fromSide;
  if (edit.toSide && edit.toSide !== conn.toSide) patch.toSide = edit.toSide;
  if (edit.routing && edit.routing !== conn.routing) patch.routing = edit.routing;
  return Object.keys(patch).length ? /** @type {ObjectPatch} */ (patch) : null;
}

/**
 * The patch for "Reset route": no edits and automatic sides. Null when there is nothing to reset.
 * @param {WhiteboardObject} conn
 * @returns {ObjectPatch|null}
 */
export function resetRoutePatch(conn) {
  if (conn.type !== "connector") return null;
  /** @type {Record<string, any>} */
  const patch = {};
  if (conn.segments?.length) patch.segments = [];
  if (conn.curve) patch.curve = null;
  if (conn.fromSide && conn.fromSide !== "auto") patch.fromSide = "auto";
  if (conn.toSide && conn.toSide !== "auto") patch.toSide = "auto";
  return Object.keys(patch).length ? /** @type {ObjectPatch} */ (patch) : null;
}

/**
 * Whether "Reset route" would change a connector.
 * @param {WhiteboardObject} conn
 */
export function canResetRoute(conn) {
  return conn.type === "connector" && (hasRouteEdits(conn) || !!conn.segments?.length || !!conn.curve ||
    (!!conn.fromSide && conn.fromSide !== "auto") || (!!conn.toSide && conn.toSide !== "auto"));
}

/**
 * A presence transform for a connector route edit in progress.
 * @param {string} id @param {RouteEditFields} edit
 */
export function routeTransform(id, edit) {
  /** @type {Record<string, any>} */
  const t = { id, x: 0, y: 0, w: 1, h: 1, rot: 0 };
  if (edit.segments) t.segments = edit.segments;
  if ("curve" in edit) t.curve = edit.curve ?? null;
  if (edit.fromSide) t.fromSide = edit.fromSide;
  if (edit.toSide) t.toSide = edit.toSide;
  if (edit.routing) t.routing = edit.routing;
  return /** @type {import("../../../shared/protocol.js").PresenceTransform} */ (t);
}

/**
 * Words for an announcement of a handle (for screen readers).
 * @param {RouteHandle} hd @param {number} i @param {number} n
 */
export function describeHandle(hd, i, n) {
  if (hd.kind === "curve") return `Curve handle at ${Math.round(hd.point.x)}, ${Math.round(hd.point.y)}`;
  const which = hd.axis === "x" ? "Vertical" : "Horizontal";
  return `${which} segment ${i + 1} of ${n} at ${hd.axis === "x" ? "x" : "y"} ${Math.round(hd.pos)}${hd.anchored ? ", next to an end" : ""}`;
}

/**
 * Drag one route handle of connector `connId`.
 * @param {GestureContext & {routeOverrides: Map<string, RouteEditFields>}} ctx
 * @param {PointerSample} p @param {string} connId @param {number} handleIndex
 * @returns {Gesture}
 */
export function routeHandleGesture(ctx, p, connId, handleIndex) {
  let started = false;
  let last = p;
  /** @type {RouteEditFields|null} */
  let edit = null;
  /** @type {Rect[]|null} */
  let targets = null;
  const start = (() => {
    const conn = ctx.objects()[connId];
    const from = conn?.from ? ctx.resolve(conn.from) : undefined;
    const to = conn?.to ? ctx.resolve(conn.to) : undefined;
    if (!conn || !from || !to) return null;
    const h = connectorHandles(conn, ctx.resolve, ctx.routeEnv, ctx.camera().zoom);
    const hd = h?.handles[handleIndex];
    return h && hd ? { conn, from, to, route: h.route, hd } : null;
  })();

  function restore() {
    ctx.setOverlay({ guides: [] });
    ctx.routeOverrides.delete(connId);
    ctx.layer.rerender([connId], ctx.objects(), ctx.resolve);
    ctx.schedule("selection");
  }

  /** @param {PointerSample} q @returns {{edit: RouteEditFields|null, guides: Guide[]}} */
  function compute(q) {
    if (!start) return { edit: null, guides: [] };
    const { conn, from, to, route, hd } = start;
    let pt = { x: q.x, y: q.y };
    /** @type {Guide[]} */
    let guides = [];
    const opts = q.alt ? null : ctx.snapOptions?.() ?? null;
    if (opts && hd.kind === "segment") {
      targets ??= ctx.snapTargets?.(new Set([connId])) ?? [];
      const extra = straightThroughLines(from, to, route, hd);
      const seg = segmentExtent(route, hd);
      const lineRects = extra.map((v) => (hd.axis === "x" ? { x: v, y: seg.y, w: 0, h: seg.h } : { x: seg.x, y: v, w: seg.w, h: 0 }));
      const box = hd.axis === "x" ? { x: pt.x, y: seg.y, w: 0, h: seg.h } : { x: seg.x, y: pt.y, w: seg.w, h: 0 };
      const s = snapMove(box, [...lineRects, ...targets], opts);
      if (hd.axis === "x") { pt = { x: pt.x + s.dx, y: pt.y }; guides = s.guides.filter((g) => g.axis === "x"); }
      else { pt = { x: pt.x, y: pt.y + s.dy }; guides = s.guides.filter((g) => g.axis === "y"); }
    }
    return { edit: editForHandle(conn, from, to, route, hd, pt), guides };
  }

  return {
    kind: "dragging",
    move(q) {
      last = q;
      if (!started && !beyondThreshold(p, q)) return;
      started = true;
      ctx.schedule("gesture");
    },
    frame() {
      if (!started || !start) return;
      const r = compute(last);
      edit = r.edit;
      ctx.setOverlay({ guides: r.guides });
      if (edit) {
        ctx.routeOverrides.set(connId, edit);
        ctx.store.setPresence({ transforms: [routeTransform(connId, edit)] });
      }
      ctx.layer.rerender([connId], ctx.objects(), ctx.resolve);
      ctx.schedule("selection");
    },
    setAlt(alt) {
      if (!started || !!last.alt === alt) return;
      last = { ...last, alt };
      ctx.schedule("gesture");
    },
    up(q) {
      if (!started || !start) return;
      last = q;
      const r = compute(q);
      restore();
      const conn = ctx.objects()[connId];
      const patch = conn && r.edit ? routePatch(conn, r.edit) : null;
      if (patch) {
        ctx.store.updateObjects([{ id: connId, patch }]);
        ctx.announce?.(start.hd.kind === "curve" ? "Curve changed" : "Route changed");
      }
      ctx.store.setPresence({ transforms: [] });
      ctx.store.flushPresence();
    },
    cancel() {
      if (!started) return;
      restore();
      ctx.store.setPresence({ transforms: [] });
      ctx.store.flushPresence();
    },
  };
}

/**
 * World extent of the segment a handle belongs to (for guides), as a rect.
 * @param {Route} route @param {RouteHandle} hd
 * @returns {Rect}
 */
function segmentExtent(route, hd) {
  const na = axisNormal({ x: route.points[1].x - route.points[0].x, y: route.points[1].y - route.points[0].y });
  const s = segmentChain(route.points, na)[hd.index];
  if (!s) return { x: hd.point.x, y: hd.point.y, w: 0, h: 0 };
  const x = Math.min(s.a.x, s.b.x), y = Math.min(s.a.y, s.b.y);
  return { x, y, w: Math.abs(s.a.x - s.b.x), h: Math.abs(s.a.y - s.b.y) };
}

/**
 * The route edit for a keyboard move of handle `hd` by (dx, dy) world units (segments move along
 * their axis only; no snapping, so keyboard moves are exact).
 * @param {WhiteboardObject} conn @param {WhiteboardObject} from @param {WhiteboardObject} to
 * @param {Route} route @param {RouteHandle} hd @param {number} dx @param {number} dy
 * @returns {RouteEditFields|null}
 */
export function keyboardEdit(conn, from, to, route, hd, dx, dy) {
  if (hd.kind === "segment") {
    const d = hd.axis === "x" ? dx : dy;
    if (!d) return null;
    return editForHandle(conn, from, to, route, hd, { x: hd.point.x + (hd.axis === "x" ? d : 0), y: hd.point.y + (hd.axis === "y" ? d : 0) });
  }
  if (!dx && !dy) return null;
  return editForHandle(conn, from, to, route, hd, { x: hd.point.x + dx, y: hd.point.y + dy });
}
