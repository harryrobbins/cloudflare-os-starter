// @ts-check
// The pointer gestures of the canvas state machine: panning, marquee, dragging, resizing,
// rotating, drawing, connecting and creating (editingText lives in text-editor.js). Each gesture
// is an object with move/up/cancel and a frame() the canvas calls once per animation frame while
// the gesture is dirty. In-progress state goes to presence (transforms, stroke); completion is ONE
// store call followed by clearing that presence and flushing it. cancel() restores everything.

import {
  center, strokePathD, normalizeStroke, connectorRoute, anchor, facingSide, rotatedBounds, unionRects,
} from "../../../shared/geometry.js";
import { simplifyStroke } from "../../../shared/simplify.js";
import { LIMITS, TYPE_DEFAULTS } from "../../../shared/protocol.js";
import { panBy, clampZoom, screenToWorld } from "./camera.js";
import {
  expandMoveIds, moveUpdates, objectsInRect, rectFromPoints, frameAtPoint, withFrameMembership,
  creationBox, topObjectAt, TEXT_EDITABLE, round2, validEndpoint, reconnectUpdate,
} from "./model.js";
import { resizeBox, rotationToward, MIN_RESIZE } from "./handles.js";
import { snapMove, snapResize } from "../../model/alignment.js";
import { svgEl } from "./layers.js";

/** @typedef {import("../../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../../../shared/protocol.js").ObjectType} ObjectType */
/** @typedef {import("../../../shared/protocol.js").Style} Style */
/** @typedef {import("../../store-contract.js").Store} Store */
/** @typedef {import("./handles.js").Handle} Handle */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */
/** @typedef {{x: number, y: number, zoom: number}} Camera */

/**
 * A pointer sample: screen (sx, sy) relative to the canvas, world (x, y), modifiers.
 * @typedef {object} PointerSample
 * @property {number} sx @property {number} sy @property {number} x @property {number} y
 * @property {boolean} shift
 * @property {boolean} [alt]  held: no snapping (the documented bypass modifier)
 * @property {number} clientX @property {number} clientY
 * @property {string} pointerType
 * @property {number} time
 */

/**
 * @typedef {object} Override
 * @property {"translate"|"replace"} mode  translate: wrapper transform only; replace: re-rendered
 * @property {{x: number, y: number, w: number, h: number, rot: number}} geom
 */

/**
 * What gestures need from the canvas.
 * @typedef {object} GestureContext
 * @property {Store} store
 * @property {HTMLElement} element
 * @property {() => Record<string, WhiteboardObject>} objects
 * @property {(id: string) => WhiteboardObject|undefined} resolve  committed objects with overrides applied
 * @property {() => WhiteboardObject[]} sorted
 * @property {() => Camera} camera
 * @property {import("./layers.js").ObjectLayer} layer
 * @property {Map<string, Override>} overrides
 * @property {SVGGElement} preview  camera-space group for local previews
 * @property {() => string[]} getSelection
 * @property {(ids: string[], opts?: {announce?: boolean}) => void} setSelection
 * @property {(kind: "gesture"|"selection") => void} schedule
 * @property {(cam: Camera) => void} setCameraByUser
 * @property {(patch: {marquee?: Rect|null, hoverId?: string|null, guides?: Guide[]}) => void} setOverlay
 * @property {(type: ObjectType) => Partial<Style>} toolStyle
 * @property {(id: string|undefined, type: ObjectType) => void} finishCreate
 * @property {(id: string) => void} editText
 * @property {(clientX: number, clientY: number, ids: string[], pointerType?: string) => void} contextMenu
 * @property {(id: string, p: PointerSample) => boolean} registerClick  true on a double click
 * @property {() => void} announceSelection
 * @property {() => SnapOptions|null} [snapOptions]  snapping settings now (null: snapping off)
 * @property {(moving: Set<string>) => Rect[]} [snapTargets]  rects a moving set may snap to
 * @property {(p: {x: number, y: number}, accept?: (o: WhiteboardObject) => boolean) => WhiteboardObject|null} [objectAt]
 *   topmost object at a world point (index-backed); defaults to a scan of sorted()
 * @property {(rect: Rect) => WhiteboardObject[]} [objectsNear]  marquee candidates in stacking order
 *   (index-backed); defaults to sorted()
 * @property {(message: string) => void} [announce]
 */
/** @typedef {import("../../model/alignment.js").Guide} Guide */
/** @typedef {import("../../model/alignment.js").SnapOptions} SnapOptions */

/**
 * @typedef {object} Gesture
 * @property {"panning"|"marquee"|"dragging"|"resizing"|"rotating"|"drawing"|"connecting"|"creating"} kind
 * @property {(p: PointerSample) => void} move
 * @property {(p: PointerSample) => void} up
 * @property {() => void} cancel
 * @property {() => void} frame
 * @property {(alt: boolean) => void} [setAlt]  the snap-bypass modifier changed without a pointer move
 */

/** Movement (screen px) before a press becomes a drag. */
export const DRAG_THRESHOLD = /** @type {Record<string, number>} */ ({ mouse: 3, pen: 4, touch: 8 });
export const LONG_PRESS_MS = 500;

/** @param {PointerSample} a @param {PointerSample} b */
export function beyondThreshold(a, b) {
  return Math.hypot(a.sx - b.sx, a.sy - b.sy) >= (DRAG_THRESHOLD[a.pointerType] ?? 4);
}

/** @param {GestureContext} ctx @param {PointerSample} q */
function snapping(ctx, q) {
  return q.alt ? null : ctx.snapOptions?.() ?? null;
}

/** @param {GestureContext} ctx @param {{x: number, y: number}} p @param {(o: WhiteboardObject) => boolean} [accept] */
function objectAt(ctx, p, accept) {
  return ctx.objectAt ? ctx.objectAt(p, accept) : topObjectAt(ctx.sorted(), p, ctx.camera().zoom, ctx.resolve, accept);
}

/**
 * @param {GestureContext} ctx @param {PointerSample} p
 * @param {{tapClearsSelection?: boolean}} [opts]
 * @returns {Gesture}
 */
export function panGesture(ctx, p, { tapClearsSelection = false } = {}) {
  const cam0 = ctx.camera();
  let moved = false;
  ctx.element.classList.add("wb-grabbing");
  const end = () => ctx.element.classList.remove("wb-grabbing");
  return {
    kind: "panning",
    move(q) {
      if (!moved && !beyondThreshold(p, q)) return;
      moved = true;
      ctx.setCameraByUser(panBy(cam0, q.sx - p.sx, q.sy - p.sy));
    },
    up(q) {
      end();
      if (!moved && tapClearsSelection && !q.shift) ctx.setSelection([], { announce: true });
    },
    cancel: end,
    frame() {},
  };
}

/**
 * Two-finger pan and pinch zoom.
 * @param {GestureContext} ctx @param {{x: number, y: number}} a @param {{x: number, y: number}} b  screen points
 */
export function pinchGesture(ctx, a, b) {
  const cam0 = ctx.camera();
  const mid0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const dist0 = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
  const anchorWorld = screenToWorld(cam0, mid0);
  return {
    kind: /** @type {const} */ ("panning"),
    /** @param {{x: number, y: number}} a2 @param {{x: number, y: number}} b2 */
    update(a2, b2) {
      const mid = { x: (a2.x + b2.x) / 2, y: (a2.y + b2.y) / 2 };
      const dist = Math.max(10, Math.hypot(a2.x - b2.x, a2.y - b2.y));
      const zoom = clampZoom(cam0.zoom * dist / dist0);
      ctx.setCameraByUser({ x: anchorWorld.x - mid.x / zoom, y: anchorWorld.y - mid.y / zoom, zoom });
    },
  };
}

/**
 * Press on an object with the select tool: selection on press, drag after the threshold, click
 * handling (shift toggles, double click edits) on release, long press on touch opens the menu.
 * @param {GestureContext} ctx @param {PointerSample} p @param {WhiteboardObject} hit
 * @returns {Gesture}
 */
export function objectPressGesture(ctx, p, hit) {
  const before = ctx.getSelection();
  const wasSelected = before.includes(hit.id);
  if (p.shift) {
    if (!wasSelected) ctx.setSelection([...before, hit.id], { announce: true });
  } else if (!wasSelected) {
    ctx.setSelection([hit.id], { announce: true });
  }
  /** @type {{ids: string[], connectors: Set<string>, box: Rect|null, targets: Rect[]|null}|null} */
  let drag = null;
  let dead = false;
  let last = p;
  let timer = /** @type {ReturnType<typeof setTimeout>|0} */ (0);
  if (p.pointerType === "touch") {
    timer = setTimeout(() => {
      if (drag || dead) return;
      dead = true;
      if (!ctx.getSelection().includes(hit.id)) ctx.setSelection([hit.id], { announce: true });
      ctx.contextMenu(p.clientX, p.clientY, ctx.getSelection(), p.pointerType);
    }, LONG_PRESS_MS);
  }

  function clearOverrides() {
    if (!drag) return;
    ctx.setOverlay({ guides: [] });
    for (const id of drag.ids) {
      ctx.overrides.delete(id);
      ctx.layer.translate(id, 0, 0);
    }
    ctx.layer.rerender(drag.connectors, ctx.objects(), ctx.resolve);
    ctx.schedule("selection");
  }

  /**
   * The move so far, snapped to other objects' edges and centres (or the grid) unless Alt is held.
   * @param {PointerSample} q
   */
  function delta(q) {
    let dx = q.x - p.x, dy = q.y - p.y;
    /** @type {Guide[]} */
    let guides = [];
    const opts = drag?.box ? snapping(ctx, q) : null;
    if (opts && drag?.box) {
      drag.targets ??= ctx.snapTargets?.(new Set(drag.ids)) ?? [];
      const b = drag.box;
      const s = snapMove({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, drag.targets, opts);
      dx += s.dx; dy += s.dy;
      guides = s.guides;
    }
    return { dx: round2(dx), dy: round2(dy), guides };
  }

  return {
    kind: "dragging",
    move(q) {
      if (dead) return;
      last = q;
      if (!drag) {
        if (!beyondThreshold(p, q)) return;
        clearTimeout(timer);
        const ids = expandMoveIds(ctx.objects(), ctx.getSelection());
        if (!ids.length) { dead = true; return; }
        const objects = ctx.objects();
        const box = unionRects(ids.map((i) => objects[i]).filter(Boolean).map((o) => rotatedBounds(o)));
        drag = { ids, connectors: ctx.layer.connectorsOf(ids), box, targets: null };
      }
      ctx.schedule("gesture");
    },
    frame() {
      if (!drag || dead) return;
      const objects = ctx.objects();
      const { dx, dy, guides } = delta(last);
      ctx.setOverlay({ guides });
      const transforms = [];
      for (const id of drag.ids) {
        const o = objects[id];
        if (!o) continue;
        const geom = { x: round2(o.x + dx), y: round2(o.y + dy), w: o.w, h: o.h, rot: o.rot };
        ctx.overrides.set(id, { mode: "translate", geom });
        ctx.layer.translate(id, dx, dy);
        if (transforms.length < LIMITS.presenceTransforms) transforms.push({ id, ...geom });
      }
      ctx.layer.rerender(drag.connectors, objects, ctx.resolve);
      ctx.store.setPresence({ transforms });
      ctx.schedule("selection");
    },
    setAlt(alt) {
      if (!drag || dead || !!last.alt === alt) return;
      last = { ...last, alt };
      ctx.schedule("gesture");
    },
    up(q) {
      clearTimeout(timer);
      if (dead) return;
      if (!drag) {
        if (q.shift && wasSelected) ctx.setSelection(before.filter((id) => id !== hit.id), { announce: true });
        else if (!q.shift && wasSelected && before.length > 1) ctx.setSelection([hit.id], { announce: true });
        if (!q.shift && ctx.registerClick(hit.id, q) && TEXT_EDITABLE.includes(hit.type)) ctx.editText(hit.id);
        return;
      }
      const { dx, dy } = delta(q);
      const ids = drag.ids;
      clearOverrides();
      drag = null;
      if (dx || dy) {
        const updates = moveUpdates(ctx.objects(), ids, dx, dy);
        if (updates.length) ctx.store.updateObjects(updates);
      }
      ctx.store.setPresence({ transforms: [] });
      ctx.store.flushPresence();
    },
    cancel() {
      clearTimeout(timer);
      if (drag) {
        clearOverrides();
        drag = null;
        ctx.store.setPresence({ transforms: [] });
        ctx.store.flushPresence();
      }
      dead = true;
    },
  };
}

/**
 * Resize or rotate a single object by one of its handles.
 * @param {GestureContext} ctx @param {PointerSample} p @param {string} id @param {Handle} handle
 * @returns {Gesture}
 */
export function handleGesture(ctx, p, id, handle) {
  let started = false;
  let last = p;
  /** @type {Rect[]|null} */
  let targets = null;
  /** @type {Guide[]} */
  let guides = [];
  /** @returns {{x: number, y: number, w: number, h: number, rot: number}|null} */
  function box() {
    const o = ctx.objects()[id];
    guides = [];
    if (!o) return null;
    if (handle === "rotate") return { x: o.x, y: o.y, w: o.w, h: o.h, rot: rotationToward(o, last, last.shift) };
    const b = resizeBox({ x: o.x, y: o.y, w: o.w, h: o.h, rot: o.rot || 0 }, handle, last, last.shift);
    // Edge snapping for unrotated boxes without Shift (aspect lock); Alt bypasses it.
    const opts = !b.rot && !last.shift ? snapping(ctx, last) : null;
    if (!opts) return b;
    targets ??= ctx.snapTargets?.(new Set([id])) ?? [];
    const s = snapResize(b, handle, targets, { ...opts, minSize: Math.min(MIN_RESIZE, o.w, o.h) });
    guides = s.guides;
    return { x: round2(s.box.x), y: round2(s.box.y), w: round2(s.box.w), h: round2(s.box.h), rot: 0 };
  }
  function restore() {
    ctx.setOverlay({ guides: [] });
    ctx.overrides.delete(id);
    ctx.layer.rerender([id, ...ctx.layer.connectorsOf([id])], ctx.objects(), ctx.resolve);
    ctx.schedule("selection");
  }
  return {
    kind: handle === "rotate" ? "rotating" : "resizing",
    move(q) {
      last = q;
      if (!started && !beyondThreshold(p, q)) return;
      started = true;
      ctx.schedule("gesture");
    },
    frame() {
      if (!started) return;
      const b = box();
      if (!b) return;
      ctx.setOverlay({ guides });
      ctx.overrides.set(id, { mode: "replace", geom: b });
      ctx.layer.rerender([id, ...ctx.layer.connectorsOf([id])], ctx.objects(), ctx.resolve);
      ctx.store.setPresence({ transforms: [{ id, ...b }] });
      ctx.schedule("selection");
    },
    setAlt(alt) {
      if (!started || !!last.alt === alt) return;
      last = { ...last, alt };
      ctx.schedule("gesture");
    },
    up(q) {
      if (!started) return;
      last = q;
      const b = box();
      restore();
      const o = ctx.objects()[id];
      if (b && o) {
        /** @type {import("../../../shared/protocol.js").ObjectPatch} */
        const patch = {};
        if (handle === "rotate") {
          if (b.rot !== o.rot) patch.rot = b.rot;
        } else {
          for (const k of /** @type {const} */ (["x", "y", "w", "h"])) if (b[k] !== o[k]) patch[k] = b[k];
          if (Object.keys(patch).length) withFrameMembership(ctx.objects(), o, b, patch);
        }
        if (Object.keys(patch).length) ctx.store.updateObjects([{ id, patch }]);
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
 * @param {GestureContext} ctx @param {PointerSample} p
 * @returns {Gesture}
 */
export function marqueeGesture(ctx, p) {
  const original = ctx.getSelection();
  const base = p.shift ? original : [];
  let started = false;
  let last = p;
  return {
    kind: "marquee",
    move(q) {
      last = q;
      if (!started) {
        if (!beyondThreshold(p, q)) return;
        started = true;
      }
      ctx.schedule("gesture");
    },
    frame() {
      if (!started) return;
      const rect = rectFromPoints(p, last);
      const ids = objectsInRect(ctx.objectsNear ? ctx.objectsNear(rect) : ctx.sorted(), rect, ctx.resolve);
      ctx.setSelection([...new Set([...base, ...ids])]);
      ctx.setOverlay({ marquee: rect });
    },
    up(q) {
      if (!started) {
        if (!q.shift) ctx.setSelection([], { announce: true });
        return;
      }
      last = q;
      this.frame();
      ctx.setOverlay({ marquee: null });
      ctx.announceSelection();
    },
    cancel() {
      if (!started) return;
      ctx.setOverlay({ marquee: null });
      ctx.setSelection(original);
    },
  };
}

/**
 * Sticky, rect, ellipse, text or frame: click for the default size, drag for a box.
 * @param {GestureContext} ctx @param {PointerSample} p @param {ObjectType} type
 * @returns {Gesture}
 */
export function createGesture(ctx, p, type) {
  let started = false;
  let last = p;
  /** @type {SVGElement|null} */
  let shape = null;
  const clear = () => { shape?.remove(); shape = null; };
  return {
    kind: "creating",
    move(q) {
      last = q;
      if (!started && !beyondThreshold(p, q)) return;
      started = true;
      ctx.schedule("gesture");
    },
    frame() {
      if (!started) return;
      const b = creationBox(type, p, last, 0, last.shift);
      if (!shape) {
        shape = svgEl(type === "ellipse" ? "ellipse" : "rect", { class: "wb-preview-shape" });
        ctx.preview.appendChild(shape);
      }
      if (type === "ellipse") {
        shape.setAttribute("cx", String(b.x + b.w / 2)); shape.setAttribute("cy", String(b.y + b.h / 2));
        shape.setAttribute("rx", String(b.w / 2)); shape.setAttribute("ry", String(b.h / 2));
      } else {
        shape.setAttribute("x", String(b.x)); shape.setAttribute("y", String(b.y));
        shape.setAttribute("width", String(b.w)); shape.setAttribute("height", String(b.h));
      }
    },
    up(q) {
      clear();
      const zoom = ctx.camera().zoom;
      const b = started ? creationBox(type, p, q, 4 / zoom, q.shift) : creationBox(type, p, p, Infinity);
      /** @type {Partial<WhiteboardObject> & {type: ObjectType}} */
      const obj = { type, x: b.x, y: b.y, w: b.w, h: b.h };
      const style = ctx.toolStyle(type);
      if (Object.keys(style).length) obj.style = /** @type {Style} */ (style);
      if (type !== "frame") obj.frameId = frameAtPoint(ctx.objects(), center(b));
      const [id] = ctx.store.createObjects([obj]);
      ctx.finishCreate(id, type);
    },
    cancel: clear,
  };
}

/**
 * Free-hand pen stroke.
 * @param {GestureContext} ctx @param {PointerSample} p
 * @returns {Gesture}
 */
export function penGesture(ctx, p) {
  const custom = ctx.toolStyle("pen");
  const style = { ...TYPE_DEFAULTS.pen.style, ...custom };
  const color = style.stroke === "none" ? "#1f2937" : style.stroke;
  const width = Math.max(0.5, style.strokeWidth);
  /** @type {number[]} */
  let points = [p.x, p.y];
  const path = svgEl("path", { class: "wb-preview-stroke", stroke: color, "stroke-width": width, d: strokePathD(points) });
  ctx.preview.appendChild(path);
  let lx = p.x, ly = p.y;
  const clearPresence = () => {
    ctx.store.setPresence({ stroke: null });
    ctx.store.flushPresence();
  };
  return {
    kind: "drawing",
    move(q) {
      const zoom = ctx.camera().zoom;
      if (Math.hypot(q.x - lx, q.y - ly) < 0.5 / zoom) return;
      points.push(q.x, q.y);
      lx = q.x; ly = q.y;
      if (points.length > 40000) points = simplifyStroke(points, 0.5 / zoom);
      ctx.schedule("gesture");
    },
    frame() {
      const zoom = ctx.camera().zoom;
      path.setAttribute("d", strokePathD(points));
      const sent = simplifyStroke(points, 1 / zoom, LIMITS.presenceStrokePoints).map(round2);
      ctx.store.setPresence({ stroke: { points: sent, color, width } });
    },
    up(q) {
      path.remove();
      const zoom = ctx.camera().zoom;
      if (Math.hypot(q.x - lx, q.y - ly) >= 0.5 / zoom) points.push(q.x, q.y);
      let pts = simplifyStroke(points, 0.75 / zoom, LIMITS.penPoints);
      if (pts.length < 4) pts = [pts[0], pts[1], pts[0], pts[1]];
      const norm = normalizeStroke(pts, width / 2);
      /** @type {Partial<WhiteboardObject> & {type: ObjectType}} */
      const obj = { type: "pen", ...norm, frameId: frameAtPoint(ctx.objects(), center(norm)) };
      if (Object.keys(custom).length) obj.style = /** @type {Style} */ (custom);
      const [id] = ctx.store.createObjects([obj]);
      clearPresence();
      ctx.finishCreate(id, "pen");
    },
    cancel() {
      path.remove();
      clearPresence();
    },
  };
}

/**
 * Drag from one object to another to connect them.
 * @param {GestureContext} ctx @param {PointerSample} p @param {WhiteboardObject} from
 * @returns {Gesture}
 */
export function connectGesture(ctx, p, from) {
  const line = svgEl("path", { class: "wb-preview-line" });
  ctx.preview.appendChild(line);
  let last = p;
  /** @param {PointerSample} q */
  const targetAt = (q) => objectAt(ctx, q, (o) => o.type !== "connector" && o.id !== from.id);
  const clear = () => { line.remove(); ctx.setOverlay({ hoverId: null }); };
  return {
    kind: "connecting",
    move(q) { last = q; ctx.schedule("gesture"); },
    frame() {
      const f = ctx.resolve(from.id);
      if (!f) return;
      const target = targetAt(last);
      ctx.setOverlay({ hoverId: target?.id ?? null });
      const pts = target
        ? connectorRoute({}, f, target).points
        : [anchor(f, facingSide(f, last)).point, { x: last.x, y: last.y }];
      line.setAttribute("d", pts.map((pt, i) => `${i ? "L" : "M"}${round2(pt.x)} ${round2(pt.y)}`).join(""));
    },
    up(q) {
      const target = targetAt(q);
      clear();
      if (!target || !ctx.objects()[from.id]) return;
      /** @type {Partial<WhiteboardObject> & {type: ObjectType}} */
      const obj = { type: "connector", from: from.id, to: target.id };
      const style = ctx.toolStyle("connector");
      if (Object.keys(style).length) obj.style = /** @type {Style} */ (style);
      const [id] = ctx.store.createObjects([obj]);
      ctx.finishCreate(id, "connector");
    },
    cancel: clear,
  };
}

/**
 * Drag one endpoint handle of a selected connector onto another object to reconnect that end.
 * While dragging, a preview line runs from the fixed end to the pointer (or to the target) and the
 * valid target under the pointer is highlighted. Dropping on empty space, on the connector's other
 * endpoint (a self-link) or on another connector cancels. Only that endpoint changes.
 * @param {GestureContext} ctx @param {PointerSample} p @param {string} connId @param {"from"|"to"} end
 * @returns {Gesture}
 */
export function endpointGesture(ctx, p, connId, end) {
  const line = svgEl("path", { class: "wb-preview-line" });
  ctx.preview.appendChild(line);
  let started = false;
  let last = p;
  /** @param {PointerSample} q */
  const targetAt = (q) => {
    const conn = ctx.objects()[connId];
    if (!conn) return null;
    const t = objectAt(ctx, q, (o) => o.type !== "connector");
    return t && validEndpoint(conn, end, t) ? t : null;
  };
  const clear = () => { line.remove(); ctx.setOverlay({ hoverId: null }); };
  return {
    kind: "connecting",
    move(q) {
      last = q;
      if (!started && !beyondThreshold(p, q)) return;
      started = true;
      ctx.schedule("gesture");
    },
    frame() {
      if (!started) return;
      const conn = ctx.objects()[connId];
      const otherId = conn ? (end === "from" ? conn.to : conn.from) : undefined;
      const other = otherId ? ctx.resolve(otherId) : undefined;
      if (!conn || !other) { line.setAttribute("d", ""); return; }
      const target = targetAt(last);
      ctx.setOverlay({ hoverId: target?.id ?? null });
      let pts;
      if (target) {
        const route = end === "from" ? connectorRoute(conn, target, other) : connectorRoute(conn, other, target);
        pts = route.points;
      } else {
        const fixed = anchor(other, facingSide(other, last)).point;
        pts = end === "from" ? [{ x: last.x, y: last.y }, fixed] : [fixed, { x: last.x, y: last.y }];
      }
      line.setAttribute("d", pts.map((pt, i) => `${i ? "L" : "M"}${round2(pt.x)} ${round2(pt.y)}`).join(""));
    },
    up(q) {
      clear();
      if (!started) return;
      const conn = ctx.objects()[connId];
      if (!conn) return;
      const update = reconnectUpdate(conn, end, targetAt(q));
      if (!update) {
        ctx.announce?.("Connector not changed");
        return;
      }
      ctx.store.updateObjects([update]);
      ctx.announce?.(end === "from" ? "Connector start moved" : "Connector end moved");
    },
    cancel: clear,
  };
}
