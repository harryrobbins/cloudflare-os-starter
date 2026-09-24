// @ts-check
// Pure board logic used by the canvas: hit testing, marquee selection, frame membership, the
// updates a move produces, duplication and creation boxes. No DOM, so it is unit tested directly.
//
// Frame click rule: a frame is picked only by its title (the name above it) or its border
// (within a few screen pixels of the edge). Clicking a frame's empty interior acts like clicking
// empty canvas (starts a marquee, clears the selection), so objects inside a frame stay easy to
// pick and to marquee. A marquee selects a frame only when it encloses the whole frame; every
// other object is selected when its bounds intersect the marquee.

import {
  center, rotatedBounds, pointInObjectBox, distanceToPolyline, penWorldPoints, connectorRoute,
  pointsBounds, rectsIntersect, rectContains, rectContainsPoint, textLayout, textWidth, textObjectHeight,
} from "../../../shared/geometry.js";
import { effectiveFrameId, compareObjects, TYPE_DEFAULTS, LIMITS, ROTATABLE } from "../../../shared/protocol.js";
import { sizedBox, rotatedBy } from "./handles.js";
import { alignDeltas, distributeDeltas } from "../../model/alignment.js";
import { iconTextBox } from "../../../shared/icons/registry.js";

/** @typedef {import("../../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../../../shared/protocol.js").ObjectType} ObjectType */
/** @typedef {import("../../../shared/protocol.js").ObjectPatch} ObjectPatch */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */
/** @typedef {(id: string) => WhiteboardObject|undefined} Resolve */

/** Screen pixels within which a click still hits a thin line or a frame border. */
export const HIT_TOLERANCE_PX = 6;
/** Objects move by this much when duplicated. */
export const DUPLICATE_OFFSET = 20;
/** Types whose text can be edited inline (icons only when their icon has a text box; see canEditText). */
export const TEXT_EDITABLE = Object.freeze(["sticky", "rect", "ellipse", "text", "frame", "connector", "icon"]);
/** Types that open the editor right after being created. */
export const EDIT_ON_CREATE = Object.freeze(["sticky", "text"]);

/** @param {number} v */
export const round2 = (v) => Math.round(v * 100) / 100 + 0;

/**
 * Whether `o` holds editable text: its type does, and an icon's icon has a text box (stencils do,
 * glyphs do not).
 * @param {WhiteboardObject} o
 */
export function canEditText(o) {
  return TEXT_EDITABLE.includes(o.type) && (o.type !== "icon" || !!iconTextBox(o));
}

/**
 * Flat world points of a connector's route, or null when an endpoint is missing.
 * @param {WhiteboardObject} conn @param {Resolve} resolve
 */
export function connectorPoints(conn, resolve) {
  const from = conn.from ? resolve(conn.from) : undefined;
  const to = conn.to ? resolve(conn.to) : undefined;
  if (!from || !to) return null;
  return connectorRoute(conn, from, to).points;
}

/**
 * The title strip of a frame (world rect above the frame where its name is drawn).
 * @param {WhiteboardObject} f @param {number} zoom
 * @returns {Rect}
 */
export function frameTitleRect(f, zoom) {
  const layout = textLayout(f);
  const w = Math.min(f.w, Math.max(60 / zoom, textWidth(f.text || "", f.style.fontSize) + f.style.fontSize));
  return { x: f.x, y: layout.y, w, h: f.y - layout.y };
}

/**
 * True when world point `p` hits object `o` at `zoom`.
 * @param {WhiteboardObject} o @param {Point} p @param {number} zoom @param {Resolve} resolve
 */
export function hitObject(o, p, zoom, resolve) {
  const tol = HIT_TOLERANCE_PX / zoom;
  switch (o.type) {
    case "connector": {
      const pts = connectorPoints(o, resolve);
      if (!pts) return false;
      const flat = pts.flatMap((q) => [q.x, q.y]);
      return distanceToPolyline(p, flat) <= Math.max(tol, o.style.strokeWidth);
    }
    case "pen": {
      const bounds = { x: o.x - tol, y: o.y - tol, w: o.w + 2 * tol, h: o.h + 2 * tol };
      if (!rectContainsPoint(bounds, p)) return false;
      return distanceToPolyline(p, penWorldPoints(o)) <= Math.max(tol, o.style.strokeWidth);
    }
    case "frame": {
      if (rectContainsPoint(frameTitleRect(o, zoom), p)) return true;
      const outer = { x: o.x - tol, y: o.y - tol, w: o.w + 2 * tol, h: o.h + 2 * tol };
      const inner = { x: o.x + tol, y: o.y + tol, w: o.w - 2 * tol, h: o.h - 2 * tol };
      return rectContainsPoint(outer, p) && !(inner.w > 0 && inner.h > 0 && rectContainsPoint(inner, p));
    }
    default:
      return pointInObjectBox(o, p);
  }
}

/**
 * Topmost object at world point `p`.
 * @param {WhiteboardObject[]} sorted  stacking order, bottom first
 * @param {Point} p @param {number} zoom @param {Resolve} resolve
 * @param {(o: WhiteboardObject) => boolean} [accept]
 * @returns {WhiteboardObject|null}
 */
export function topObjectAt(sorted, p, zoom, resolve, accept) {
  for (let i = sorted.length - 1; i >= 0; i--) {
    const o = sorted[i];
    if (accept && !accept(o)) continue;
    if (hitObject(o, p, zoom, resolve)) return o;
  }
  return null;
}

/**
 * World bounds of an object using `resolve` for connector endpoints (null when unresolvable).
 * @param {WhiteboardObject} o @param {Resolve} resolve
 * @returns {Rect|null}
 */
export function boundsOf(o, resolve) {
  if (o.type === "connector") {
    const pts = connectorPoints(o, resolve);
    return pts ? pointsBounds(pts) : null;
  }
  return rotatedBounds(o);
}

/**
 * Ids selected by a marquee (see the rule at the top of this file).
 * @param {Iterable<WhiteboardObject>} objects @param {Rect} rect @param {Resolve} resolve
 * @returns {string[]}
 */
export function objectsInRect(objects, rect, resolve) {
  const out = [];
  for (const o of objects) {
    const b = boundsOf(o, resolve);
    if (!b) continue;
    if (o.type === "frame" ? rectContains(rect, b) : rectsIntersect(rect, b)) out.push(o.id);
  }
  return out;
}

/** @param {Point} a @param {Point} b @returns {Rect} */
export function rectFromPoints(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/**
 * The smallest frame whose box contains world point `p`, or null.
 * @param {Record<string, WhiteboardObject>} objects
 * @param {Point} p
 * @param {Resolve} [geom]  geometry lookup (e.g. frames being moved); defaults to `objects`
 * @returns {string|null}
 */
export function frameAtPoint(objects, p, geom) {
  let best = null, bestArea = Infinity;
  for (const f of Object.values(objects)) {
    if (f.type !== "frame") continue;
    const g = geom ? geom(f.id) ?? f : f;
    if (!rectContainsPoint(g, p)) continue;
    const area = g.w * g.h;
    if (area < bestArea || (area === bestArea && best !== null && f.id < best)) { best = f.id; bestArea = area; }
  }
  return best;
}

/**
 * Adds `frameId` to `patch` when the object's centre (at geometry `g`) lands in a different frame
 * than its current one. Frames and connectors never get a frameId.
 * @param {Record<string, WhiteboardObject>} objects @param {WhiteboardObject} o
 * @param {Rect} g @param {ObjectPatch} patch @param {Resolve} [geom]
 */
export function withFrameMembership(objects, o, g, patch, geom) {
  if (o.type === "frame" || o.type === "connector") return patch;
  const f = frameAtPoint(objects, center(g), geom);
  if (f !== (o.frameId ?? null)) patch.frameId = f;
  return patch;
}

/**
 * The ids a move of `ids` actually moves: connectors dropped (their geometry follows their
 * endpoints) and each frame's effective members added.
 * @param {Record<string, WhiteboardObject>} objects @param {Iterable<string>} ids
 * @returns {string[]}
 */
export function expandMoveIds(objects, ids) {
  /** @type {Set<string>} */
  const out = new Set();
  /** @type {Set<string>} */
  const frames = new Set();
  for (const id of ids) {
    const o = objects[id];
    if (!o || o.type === "connector") continue;
    out.add(id);
    if (o.type === "frame") frames.add(id);
  }
  if (frames.size) {
    for (const o of Object.values(objects)) {
      if (o.type === "frame" || o.type === "connector") continue;
      const f = effectiveFrameId(o, objects);
      if (f && frames.has(f)) out.add(o.id);
    }
  }
  return [...out];
}

/**
 * One updateObjects batch for moving `ids` (already expanded) by (dx, dy), with frame membership.
 * @param {Record<string, WhiteboardObject>} objects @param {string[]} ids @param {number} dx @param {number} dy
 * @returns {Array<{id: string, patch: ObjectPatch}>}
 */
export function moveUpdates(objects, ids, dx, dy) {
  const moved = new Set(ids);
  /** @type {Resolve} */
  const geom = (id) => {
    const o = objects[id];
    return o && moved.has(id) ? { ...o, x: o.x + dx, y: o.y + dy } : o;
  };
  const out = [];
  for (const id of ids) {
    const o = objects[id];
    if (!o || o.type === "connector") continue;
    const g = { x: round2(o.x + dx), y: round2(o.y + dy), w: o.w, h: o.h };
    /** @type {ObjectPatch} */
    const patch = { x: g.x, y: g.y };
    withFrameMembership(objects, o, g, patch, geom);
    out.push({ id, patch });
  }
  return out;
}

/**
 * One updateObjects batch resizing each resizable object of `ids` (connectors are skipped) to the
 * size `sizeOf` returns for it, keeping its top-left corner fixed, with frame membership. Frames
 * keep their members where they are, as with the resize handles.
 * @param {Record<string, WhiteboardObject>} objects @param {Iterable<string>} ids
 * @param {(o: WhiteboardObject) => {w: number, h: number}} sizeOf
 * @returns {Array<{id: string, patch: ObjectPatch}>}
 */
export function resizeUpdates(objects, ids, sizeOf) {
  const out = [];
  for (const id of ids) {
    const o = objects[id];
    if (!o || o.type === "connector") continue;
    const want = sizeOf(o);
    const b = sizedBox({ x: o.x, y: o.y, w: o.w, h: o.h, rot: o.rot || 0 }, want.w, want.h);
    /** @type {ObjectPatch} */
    const patch = {};
    for (const k of /** @type {const} */ (["x", "y", "w", "h"])) if (b[k] !== o[k]) patch[k] = b[k];
    if (!Object.keys(patch).length) continue;
    withFrameMembership(objects, o, b, patch);
    out.push({ id, patch });
  }
  return out;
}

/**
 * One updateObjects batch rotating each rotatable object of `ids` by `deg` degrees.
 * @param {Record<string, WhiteboardObject>} objects @param {Iterable<string>} ids @param {number} deg
 * @returns {Array<{id: string, patch: ObjectPatch}>}
 */
export function rotateUpdates(objects, ids, deg) {
  const out = [];
  for (const id of ids) {
    const o = objects[id];
    if (!o || !/** @type {readonly string[]} */ (ROTATABLE).includes(o.type)) continue;
    const rot = rotatedBy(o.rot || 0, deg);
    if (rot !== (o.rot || 0)) out.push({ id, patch: { rot } });
  }
  return out;
}

/**
 * Connectors attached to any of `ids`.
 * @param {Record<string, WhiteboardObject>} objects @param {Set<string>} ids
 * @returns {string[]}
 */
export function attachedConnectors(objects, ids) {
  const out = [];
  for (const o of Object.values(objects)) {
    if (o.type === "connector" && ((o.from && ids.has(o.from)) || (o.to && ids.has(o.to)))) out.push(o.id);
  }
  return out;
}

/**
 * Create payloads for duplicating `ids`: frames bring their members, connectors come along when
 * both ends are copied, copies are offset and keep their stacking order (the store stacks them
 * above everything in array order).
 * @param {Record<string, WhiteboardObject>} objects @param {string[]} ids
 * @param {() => string} newId @param {number} [offset]
 * @returns {{creates: Array<Partial<WhiteboardObject> & {type: ObjectType}>, ids: string[]}}
 */
export function buildDuplicates(objects, ids, newId, offset = DUPLICATE_OFFSET) {
  const chosen = new Set(ids.filter((id) => objects[id]));
  for (const id of expandMoveIds(objects, chosen)) chosen.add(id);
  const originals = [...chosen].map((id) => objects[id]).sort(compareObjects);
  /** @type {Map<string, string>} */
  const idMap = new Map();
  for (const o of originals) idMap.set(o.id, newId());
  // Connectors whose endpoints are both copied come along even if not selected.
  for (const o of Object.values(objects)) {
    if (o.type === "connector" && !idMap.has(o.id) && o.from && o.to && idMap.has(o.from) && idMap.has(o.to)) {
      idMap.set(o.id, newId());
      originals.push(o);
    }
  }
  /** @type {Array<Partial<WhiteboardObject> & {type: ObjectType}>} */
  const creates = [];
  /** @type {string[]} */
  const selected = [];
  /** @type {Record<string, WhiteboardObject>} */
  const copies = {};
  for (const o of originals) {
    if (o.type === "connector") {
      const from = o.from ? idMap.get(o.from) : undefined, to = o.to ? idMap.get(o.to) : undefined;
      if (!from || !to) continue;
      /** @type {any} */
      const c = {
        id: idMap.get(o.id), type: "connector", text: o.text, style: { ...o.style },
        from, to, fromSide: o.fromSide, toSide: o.toSide, routing: o.routing,
      };
      creates.push(c);
    } else {
      /** @type {any} */
      const c = {
        id: idMap.get(o.id), type: o.type, x: round2(o.x + offset), y: round2(o.y + offset), w: o.w, h: o.h,
        rot: o.rot, text: o.text, style: { ...o.style },
      };
      if (o.type === "pen") c.points = [...(o.points ?? [])];
      if (o.type === "icon") { c.packId = o.packId; c.iconId = o.iconId; }
      if (o.type !== "frame") c.frameId = null;
      creates.push(c);
      copies[c.id] = { ...o, ...c };
    }
    selected.push(/** @type {string} */ (idMap.get(o.id)));
  }
  // Membership: copies of members join the copied frame; others join whatever frame holds them.
  const world = { ...objects, ...copies };
  for (const c of creates) {
    if (c.type === "frame" || c.type === "connector") continue;
    const orig = originals.find((o) => idMap.get(o.id) === c.id);
    const origFrame = orig ? effectiveFrameId(orig, objects) : null;
    c.frameId = origFrame && idMap.has(origFrame)
      ? idMap.get(origFrame) ?? null
      : frameAtPoint(world, center(/** @type {Rect} */ (/** @type {unknown} */ (c))));
  }
  // Every copy is returned in `ids` (the canvas selects them all).
  return { creates, ids: selected };
}

/**
 * The box a creation gesture produces. A click (or a drag smaller than `minDrag` world units)
 * gives the type's default size centred on the start point.
 * @param {ObjectType} type @param {Point} start @param {Point} end @param {number} minDrag
 * @param {boolean} [square]  shift held: keep the default aspect ratio
 * @returns {Rect}
 */
export function creationBox(type, start, end, minDrag, square = false) {
  const d = TYPE_DEFAULTS[type];
  let r = rectFromPoints(start, end);
  if (r.w < minDrag && r.h < minDrag) {
    return { x: round2(start.x - d.w / 2), y: round2(start.y - d.h / 2), w: d.w, h: d.h };
  }
  if (square) {
    const ratio = d.w / d.h;
    const w = Math.max(r.w, r.h * ratio), h = w / ratio;
    r = { x: end.x < start.x ? start.x - w : start.x, y: end.y < start.y ? start.y - h : start.y, w, h };
  }
  const w = Math.max(type === "text" ? 20 : 8, r.w);
  const h = type === "text" ? Math.max(r.h, textObjectHeight("", w, d.style.fontSize)) : Math.max(8, r.h);
  return { x: round2(r.x), y: round2(r.y), w: round2(clampSize(w)), h: round2(clampSize(h)) };
}

/** @param {number} v */
function clampSize(v) {
  return Math.min(LIMITS.sizeMax, Math.max(LIMITS.sizeMin, v));
}

/**
 * Drops ids that are not on the board and duplicates, keeping order.
 * @param {Record<string, WhiteboardObject>} objects @param {Iterable<string>} ids
 */
export function validIds(objects, ids) {
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== "string" || seen.has(id) || !Object.hasOwn(objects, id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * The frame that should be selected when the only click target inside it is its empty interior:
 * none (see the rule at the top of this file). Exported for documentation and tests.
 * @param {WhiteboardObject} frame @param {Point} p @param {number} zoom
 */
export function frameInteriorClick(frame, p, zoom) {
  return rectContainsPoint(frame, p) && !hitObject(frame, p, zoom, () => undefined);
}

// ---------------------------------------------------------------------------------------------
// Align, distribute and snap candidates (geometry in ../../model/alignment.js)
// ---------------------------------------------------------------------------------------------

/**
 * The units Align and Distribute move: each selected non-connector object whose frame is not also
 * selected, with its rotated bounds. A selected frame is one unit and brings its members along,
 * exactly as a move does (see expandMoveIds).
 * @param {Record<string, WhiteboardObject>} objects @param {Iterable<string>} ids
 * @returns {Array<{id: string, rect: Rect}>}
 */
export function arrangeUnits(objects, ids) {
  const chosen = new Set();
  for (const id of ids) {
    const o = objects[id];
    if (o && o.type !== "connector") chosen.add(id);
  }
  const out = [];
  for (const id of chosen) {
    const o = objects[id];
    const f = o.type === "frame" ? null : effectiveFrameId(o, objects);
    if (f && chosen.has(f)) continue;
    out.push({ id, rect: rotatedBounds(o) });
  }
  return out;
}

/**
 * One updateObjects batch applying per-unit offsets (frames bring their members), with frame
 * membership recomputed for the new positions.
 * @param {Record<string, WhiteboardObject>} objects
 * @param {Map<string, {dx: number, dy: number}>} deltas  unit id -> offset
 * @returns {Array<{id: string, patch: ObjectPatch}>}
 */
export function offsetUpdates(objects, deltas) {
  /** @type {Map<string, {dx: number, dy: number}>} */
  const moves = new Map();
  for (const [id, d] of deltas) {
    const dx = round2(d.dx), dy = round2(d.dy);
    if (!dx && !dy) continue;
    for (const m of expandMoveIds(objects, [id])) if (!moves.has(m)) moves.set(m, { dx, dy });
  }
  /** @type {Resolve} */
  const geom = (id) => {
    const o = objects[id];
    const d = moves.get(id);
    return o && d ? { ...o, x: o.x + d.dx, y: o.y + d.dy } : o;
  };
  const out = [];
  for (const [id, { dx, dy }] of moves) {
    const o = objects[id];
    if (!o || o.type === "connector") continue;
    const g = { x: round2(o.x + dx), y: round2(o.y + dy), w: o.w, h: o.h };
    /** @type {ObjectPatch} */
    const patch = {};
    if (g.x !== o.x) patch.x = g.x;
    if (g.y !== o.y) patch.y = g.y;
    if (!Object.keys(patch).length) continue;
    withFrameMembership(objects, o, g, patch, geom);
    out.push({ id, patch });
  }
  return out;
}

/**
 * One updateObjects batch aligning the selection (see alignDeltas).
 * @param {Record<string, WhiteboardObject>} objects @param {Iterable<string>} ids
 * @param {import("../../model/alignment.js").AlignMode} mode
 */
export function alignUpdates(objects, ids, mode) {
  return offsetUpdates(objects, alignDeltas(arrangeUnits(objects, ids), mode));
}

/**
 * One updateObjects batch distributing the selection (see distributeDeltas).
 * @param {Record<string, WhiteboardObject>} objects @param {Iterable<string>} ids
 * @param {"horizontal"|"vertical"} axis
 */
export function distributeUpdates(objects, ids, axis) {
  return offsetUpdates(objects, distributeDeltas(arrangeUnits(objects, ids), axis));
}

/**
 * Rects of the objects a moving set can snap to: non-connector objects among `candidateIds`
 * (typically an index query around the view) that are not moving. Frames count by their box.
 * @param {Record<string, WhiteboardObject>} objects @param {Iterable<string>} candidateIds
 * @param {Set<string>} moving
 * @returns {Rect[]}
 */
export function snapTargets(objects, candidateIds, moving) {
  const out = [];
  for (const id of candidateIds) {
    if (moving.has(id)) continue;
    const o = objects[id];
    if (!o || o.type === "connector") continue;
    out.push(rotatedBounds(o));
  }
  return out;
}

/**
 * The index-backed replacement for a full scan: objects of `ids` in stacking order (bottom first).
 * @param {Record<string, WhiteboardObject>} objects @param {Iterable<string>} ids
 * @returns {WhiteboardObject[]}
 */
export function stackOrder(objects, ids) {
  const out = [];
  for (const id of new Set(ids)) {
    const o = Object.hasOwn(objects, id) ? objects[id] : undefined;
    if (o) out.push(o);
  }
  return out.sort(compareObjects);
}

/**
 * Whether `target` may become endpoint `end` of connector `conn`: an existing non-connector object
 * that is not the other endpoint (no self-links). The current endpoint itself is valid (a no-op).
 * @param {WhiteboardObject} conn @param {"from"|"to"} end @param {WhiteboardObject|undefined|null} target
 */
export function validEndpoint(conn, end, target) {
  if (!target || target.type === "connector" || target.id === conn.id) return false;
  const other = end === "from" ? conn.to : conn.from;
  return target.id !== other;
}

/**
 * The update that reconnects one end of a connector, or null when nothing changes or the target
 * is not valid. Only that endpoint changes: the other end, label, routing, sides, style and
 * stacking are kept. The server stays authoritative (invalid_ref if the target is gone).
 * @param {WhiteboardObject} conn @param {"from"|"to"} end @param {WhiteboardObject|undefined|null} target
 * @returns {{id: string, patch: ObjectPatch}|null}
 */
export function reconnectUpdate(conn, end, target) {
  if (!conn || conn.type !== "connector" || !validEndpoint(conn, end, target)) return null;
  const t = /** @type {WhiteboardObject} */ (target);
  if (conn[end] === t.id) return null;
  return { id: conn.id, patch: { [end]: t.id } };
}
