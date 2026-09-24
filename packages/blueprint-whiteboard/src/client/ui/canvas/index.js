// @ts-check
// The whiteboard canvas: createCanvas(store, options) -> CanvasController (see ../ui-contract.js).
//
// DOM, bottom to top, inside one focusable container (.wb-canvas):
//   <svg class="wb-svg">       background pattern (screen space), camera <g> holding frames, other
//                              objects, own selection outlines and local previews, then a
//                              screen-space overlay with handles, group box and marquee
//   <svg class="wb-presence-svg">  collaborators' ghosts, outlines, strokes, cursors, badges
//   <textarea class="wb-editor">   while editing text
//
// Rendering is incremental: objects patch per id on store changes, pan and zoom only change the
// camera transform, and all per-frame work (camera, gestures, overlay, presence) is batched into
// one requestAnimationFrame. window.__wbRenderStats counts object renders and full rebuilds, and
// `rendered`, the object elements currently in the DOM.
//
// Viewport culling (./culling.js): on boards of culling.MIN_OBJECTS or more, only objects near the
// viewport, pinned objects (selection, hover, text editing, the local gesture, collaborators'
// transforms) and the connectors and endpoints they need have elements. The plan is refreshed in
// the animation frame that applies a camera change (before paint, so nothing flashes at the
// edges), on store changes, and when a pin changes. The store's model is never culled.
//
// "wb-contextmenu" detail (see ../ui-contract.js) also carries `pointerType` ("mouse", "pen",
// "touch" or "keyboard") and, for the keyboard, `rect`: the selection's client rect to anchor the
// menu beside rather than on top of.

import { TYPE_DEFAULTS, sortedObjects, newId } from "../../../shared/protocol.js";
import { center, corners, boardBounds, unionRects, textWidth, textObjectHeight } from "../../../shared/geometry.js";
import {
  cleanCamera, screenToWorld, worldToScreen, zoomAt, panBy, viewportOf, cameraTransform,
  fitRect, centerOn, revealRect, lerpCamera, easeOutCubic, gridSpacing, wheelPixels, wheelZoomFactor,
} from "./camera.js";
import {
  topObjectAt, boundsOf, connectorPoints, validIds, expandMoveIds, moveUpdates, buildDuplicates,
  frameAtPoint, canEditText, EDIT_ON_CREATE, round2, resizeUpdates, rotateUpdates,
  HIT_TOLERANCE_PX, stackOrder, snapTargets, alignUpdates, distributeUpdates, reconnectUpdate,
} from "./model.js";
import { handleForPress, visibleHandles, cursorForHandle, endpointForPress, endpointHandlePositions, endpointRadius } from "./handles.js";
import { SpatialIndex, applyStoreChange } from "../../model/spatial-index.js";
import { SNAP_PX } from "../../model/alignment.js";
import { guideElements, endpointHandleElements } from "./guide-layer.js";
import { resolveIcon, iconDefaults, getIcon } from "../../../shared/icons/registry.js";
import { keyAction, panStep, directionWord, SHORTCUTS_HINT } from "./keymap.js";
import { ObjectLayer, svgEl } from "./layers.js";
import { Culler, connectorsOf } from "./culling.js";
import { PresenceLayer } from "./presence-layer.js";
import { TextEditor, textPatch } from "./text-editor.js";
import {
  panGesture, pinchGesture, objectPressGesture, handleGesture, marqueeGesture, createGesture,
  penGesture, connectGesture, endpointGesture,
} from "./gestures.js";

export { CANVAS_CSS } from "./canvas.css.js";
export { SHORTCUTS_HINT } from "./keymap.js";
export { expandMoveIds, moveUpdates, resizeUpdates, rotateUpdates, arrangeUnits } from "./model.js";

/** @typedef {import("../ui-contract.js").CanvasController} CanvasController */
/** @typedef {import("../ui-contract.js").CanvasOptions} CanvasOptions */
/** @typedef {import("../ui-contract.js").CanvasEvents} CanvasEvents */
/** @typedef {import("../ui-contract.js").Tool} Tool */
/** @typedef {import("../ui-contract.js").Camera} Camera */
/** @typedef {import("../../store-contract.js").Store} Store */
/** @typedef {import("../../store-contract.js").Change} Change */
/** @typedef {import("../../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../../../shared/protocol.js").ObjectType} ObjectType */
/** @typedef {import("../../../shared/protocol.js").Style} Style */
/** @typedef {import("./gestures.js").Gesture} Gesture */
/** @typedef {import("./gestures.js").PointerSample} PointerSample */
/** @typedef {import("./gestures.js").Override} Override */
/** @typedef {import("./gestures.js").GestureContext} GestureContext */

const TOOLS = /** @type {const} */ (["select", "hand", "sticky", "rect", "ellipse", "text", "frame", "connector", "pen"]);
const CREATE_TOOLS = /** @type {readonly string[]} */ (["sticky", "rect", "ellipse", "text", "frame"]);
const HANDLE_RADIUS = { mouse: 8, pen: 10, touch: 18 };
const DOUBLE_CLICK_MS = 450;
const CAMERA_ANIM_MS = 260;
const FOLLOW_ANIM_MS = 180;
const ZOOM_STEP = 1.25;
/** Keyboard moves, resizes and rotations are announced once the keys pause for this long. */
const ANNOUNCE_DEBOUNCE_MS = 350;
/** A contextmenu event this soon after the context menu key was handled is its echo. */
const KEY_MENU_ECHO_MS = 1000;

let instances = 0;

/**
 * @param {Store} store
 * @param {CanvasOptions & {toolStyle?: (type: ObjectType) => Partial<Style>}} [options]
 *   toolStyle (optional extension): style for objects the tools create, e.g. the shell's current
 *   pen colour. Defaults to the type defaults.
 * @returns {CanvasController}
 */
export function createCanvas(store, options = {}) {
  const exportMode = !!options.exportMode;
  const uid = ++instances;
  /** @type {{objectRenders: number, fullRenders: number}} */
  const stats = (() => {
    const w = /** @type {any} */ (typeof window !== "undefined" ? window : {});
    if (!w.__wbRenderStats) w.__wbRenderStats = { objectRenders: 0, fullRenders: 0 };
    return w.__wbRenderStats;
  })();

  // ------------------------------------------------------------------------------------------
  // DOM
  // ------------------------------------------------------------------------------------------
  const element = document.createElement("div");
  element.className = "wb-canvas" + (exportMode ? " wb-export" : "");
  const hintId = `wb-canvas-hint-${uid}`;
  if (!exportMode) {
    element.tabIndex = 0;
    element.setAttribute("role", "application");
    element.setAttribute("aria-label", "Whiteboard canvas");
    element.setAttribute("aria-describedby", hintId);
    element.dataset.tool = "select";
  }
  const svg = /** @type {SVGSVGElement} */ (svgEl("svg", { class: "wb-svg" }));
  const defs = svgEl("defs");
  const patternId = `wb-bg-${uid}`;
  const pattern = svgEl("pattern", { id: patternId, patternUnits: "userSpaceOnUse", width: 24, height: 24 });
  defs.appendChild(pattern);
  const bgRect = svgEl("rect", { x: 0, y: 0, width: "100%", height: "100%", fill: "none" });
  const cameraGroup = /** @type {SVGGElement} */ (svgEl("g", { class: "wb-camera" }));
  const framesGroup = /** @type {SVGGElement} */ (svgEl("g", { class: "wb-frames" }));
  const othersGroup = /** @type {SVGGElement} */ (svgEl("g", { class: "wb-objects" }));
  const outlineGroup = /** @type {SVGGElement} */ (svgEl("g", { class: "wb-selection" }));
  const previewGroup = /** @type {SVGGElement} */ (svgEl("g", { class: "wb-preview" }));
  const overlayGroup = /** @type {SVGGElement} */ (svgEl("g", { class: "wb-overlay" }));
  cameraGroup.append(framesGroup, othersGroup, outlineGroup, previewGroup);
  svg.append(defs, bgRect, cameraGroup, overlayGroup);
  element.appendChild(svg);
  /** @type {SVGSVGElement|null} */
  let presenceSvg = null;
  if (!exportMode) {
    presenceSvg = /** @type {SVGSVGElement} */ (svgEl("svg", { class: "wb-presence-svg", "aria-hidden": "true" }));
    element.appendChild(presenceSvg);
    const hint = document.createElement("div");
    hint.id = hintId;
    hint.className = "wb-sr-only";
    hint.textContent = SHORTCUTS_HINT;
    element.appendChild(hint);
  }

  // ------------------------------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------------------------------
  /** @type {Camera} */
  let camera = { x: 0, y: 0, zoom: 1 };
  let size = { w: 0, h: 0 };
  let cameraReady = false;     // placed once the element has a size
  let userMovedCamera = false; // a later snapshot with content does not re-fit after this
  /** @type {{from: Camera, to: Camera, start: number, duration: number}|null} */
  let cameraAnim = null;
  /** @type {Tool} */
  let tool = "select";
  let toolLocked = false;
  /** @type {string[]} */
  let selection = [];
  /** @type {string|null} */
  let following = null;
  /** @type {Gesture|null} */
  let gesture = null;
  /** @type {ReturnType<typeof pinchGesture>|null} */
  let pinch = null;
  /** @type {Map<number, {x: number, y: number}>} */
  const touches = new Map();
  /** Pointers to ignore until released (e.g. the finger left after a pinch). @type {Set<number>} */
  const ignoredPointers = new Set();
  let spaceDown = false;
  let canvasActive = false;
  /** @type {Map<string, Override>} */
  const overrides = new Map();
  /** @type {WhiteboardObject[]|null} */
  let sortedCache = null;
  /** @type {{marquee: {x: number, y: number, w: number, h: number}|null, hoverId: string|null, guides: import("../../model/alignment.js").Guide[]}} */
  const overlay = { marquee: null, hoverId: null, guides: [] };
  /** @type {{id: string, time: number, sx: number, sy: number}|null} */
  let lastClick = null;
  /** @type {{sx: number, sy: number, pointerType: string}|null} */
  let hoverPoint = null;
  /** World position of the pointer while it is over the canvas (paste goes there). @type {{x: number, y: number}|null} */
  let pointerWorld = null;
  /** The last pointer type pressed on the canvas: sizes handle hit areas. */
  let lastPointerType = "mouse";
  let lastPointerDownAt = -Infinity;
  let keyMenuAt = -Infinity;
  /** @type {ReturnType<typeof setTimeout>|0} */
  let announceTimer = 0;
  let background = "dots";
  let destroyed = false;
  /** @type {Set<(event: CanvasEvents) => void>} */
  const listeners = new Set();

  const objects = () => store.getState().board.objects;
  /** @param {string} id @returns {WhiteboardObject|undefined} */
  const resolve = (id) => {
    const all = objects();
    const o = Object.hasOwn(all, id) ? all[id] : undefined;
    if (!o) return undefined;
    const ov = overrides.get(id);
    return ov ? { ...o, ...ov.geom } : o;
  };
  const sorted = () => sortedCache ??= sortedObjects(objects());

  // Spatial index of effective bounds (../../model/spatial-index.js), updated from store changes
  // before anything else reads it. Hit tests and marquees ask it for candidates instead of scanning
  // the board; objects with an in-progress override (a drag) are always candidates too.
  const spatial = new SpatialIndex({
    debug: !!(/** @type {any} */ (options).debugSpatialIndex || /** @type {any} */ (globalThis).__wbSpatialDebug === true),
  });
  /** @param {string[]} ids */
  function withOverridden(ids) {
    if (!overrides.size) return ids;
    const keys = [...overrides.keys()];
    return [...ids, ...keys, ...layer.connectorsOf(keys)];
  }
  /**
   * Topmost object at world point `p` (index-backed topObjectAt).
   * @param {{x: number, y: number}} p @param {(o: WhiteboardObject) => boolean} [accept]
   */
  function hitAt(p, accept) {
    const near = withOverridden(spatial.queryPoint(p, HIT_TOLERANCE_PX / camera.zoom));
    return topObjectAt(stackOrder(objects(), near), p, camera.zoom, resolve, accept);
  }
  /** Objects whose bounds may meet `rect`, in stacking order. @param {{x: number, y: number, w: number, h: number}} rect */
  function objectsNear(rect) {
    return stackOrder(objects(), withOverridden(spatial.query(rect)));
  }

  const layer = new ObjectLayer(framesGroup, othersGroup, stats, (id) => {
    const ov = overrides.get(id);
    return ov && ov.mode === "replace" ? resolve(id) : undefined;
  }, (ids) => connectorsOf(spatial, ids));

  // Viewport culling. options.cull (test/benchmark extension): Culler options, e.g. {minObjects: 0}.
  const cullOptions = /** @type {any} */ (options).cull ?? {};
  const culler = new Culler({ ...cullOptions, enabled: !exportMode && cullOptions.enabled !== false });
  /** Ids a collaborator is transforming, as last pinned. */
  let remotePinKey = "";
  function remoteTransformIds() {
    /** @type {string[]} */
    const ids = [];
    for (const peer of store.getState().peers.values()) for (const t of peer.transforms ?? []) ids.push(t.id);
    return ids;
  }
  /** Objects that keep an element wherever they are. */
  function* pins() {
    yield* selection;
    if (overlay.hoverId) yield overlay.hoverId;
    if (editor?.id) yield editor.id;
    yield* overrides.keys();
    yield* remoteTransformIds();
  }
  function cullViewport() {
    return size.w && size.h && cameraReady ? viewportOf(camera, size.w, size.h) : null;
  }
  function planCulling() {
    return culler.plan({ index: spatial, objects: objects(), viewport: cullViewport(), pins: pins() });
  }
  /** Re-plans culling and adds/removes elements to match. @returns {Set<string>} ids just added */
  function updateCulling() {
    dirty.cull = false;
    const all = objects();
    const { added } = layer.sync(planCulling(), all, resolve, sorted());
    for (const id of added) {
      const ov = overrides.get(id);
      if (ov?.mode === "translate") layer.translate(id, ov.geom.x - all[id].x, ov.geom.y - all[id].y);
    }
    return added;
  }

  /** @param {CanvasEvents & Record<string, any>} event */
  function emit(event) {
    for (const listener of [...listeners]) {
      try { listener(event); } catch (err) { console.error(err); }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Frame scheduling
  // ------------------------------------------------------------------------------------------
  const dirty = { camera: false, gesture: false, selection: false, overlay: false, presence: false, hover: false, cull: false };
  let presenceAnimating = false;
  let rafId = 0;

  /** @param {keyof typeof dirty} kind */
  function schedule(kind) {
    dirty[kind] = true;
    if (exportMode || destroyed) return;
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  /** @param {number} now */
  function frame(now) {
    rafId = 0;
    if (destroyed) return;
    if (cameraAnim) {
      const t = easeOutCubic((now - cameraAnim.start) / cameraAnim.duration);
      camera = cleanCamera(lerpCamera(cameraAnim.from, cameraAnim.to, t, size.w, size.h));
      if (t >= 1) cameraAnim = null;
      dirty.camera = true;
    }
    // Culling before anything draws: the camera this frame applies, and pins that just changed.
    if (dirty.cull || (dirty.camera && culler.stale(cullViewport()))) updateCulling();
    if (dirty.gesture) {
      dirty.gesture = false;
      gesture?.frame();
      // Objects the gesture moves (e.g. a frame's children) keep an element while it runs.
      if (overrides.size) for (const id of overrides.keys()) if (!layer.elements.has(id)) { updateCulling(); break; }
    }
    if (dirty.camera) {
      dirty.camera = false;
      applyCamera();
      editor?.position();
      dirty.overlay = true;
      dirty.presence = true;
      emit({ kind: "camera" });
      if (size.w && size.h) store.setPresence({ viewport: roundRect(viewportOf(camera, size.w, size.h)) });
    }
    if (dirty.selection) {
      dirty.selection = false;
      renderOutlines();
      dirty.overlay = true;
    }
    if (dirty.overlay) {
      dirty.overlay = false;
      renderOverlay();
    }
    if (dirty.hover) {
      dirty.hover = false;
      updateHoverCursor();
    }
    if ((dirty.presence || presenceAnimating) && presence) {
      dirty.presence = false;
      presenceAnimating = presence.render(camera, now);
    }
    if (cameraAnim || presenceAnimating) rafId = requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------------------------------
  // Camera and background
  // ------------------------------------------------------------------------------------------
  function applyCamera() {
    cameraGroup.setAttribute("transform", cameraTransform(camera));
    updateBackground();
  }

  function updateBackground() {
    if (exportMode || background === "plain") {
      bgRect.setAttribute("fill", "none");
      return;
    }
    const spacing = gridSpacing(camera.zoom);
    const ox = -camera.x * camera.zoom, oy = -camera.y * camera.zoom;
    const r3 = (/** @type {number} */ v) => String(Math.round(v * 1000) / 1000);
    if (pattern.dataset.kind !== background || pattern.dataset.spacing !== r3(spacing)) {
      pattern.dataset.kind = background;
      pattern.dataset.spacing = r3(spacing);
      if (background === "grid") {
        pattern.replaceChildren(svgEl("path", { class: "wb-bg-line", d: `M${r3(spacing)} 0H0V${r3(spacing)}` }));
      } else {
        const radius = Math.min(1.6, Math.max(0.8, spacing / 18));
        pattern.replaceChildren(svgEl("circle", { class: "wb-bg-dot", cx: r3(spacing / 2), cy: r3(spacing / 2), r: r3(radius) }));
      }
    }
    pattern.setAttribute("width", r3(spacing));
    pattern.setAttribute("height", r3(spacing));
    const shift = background === "grid" ? 0 : spacing / 2;
    pattern.setAttribute("x", r3(mod(ox - shift, spacing)));
    pattern.setAttribute("y", r3(mod(oy - shift, spacing)));
    bgRect.setAttribute("fill", `url(#${patternId})`);
  }

  /**
   * @param {Camera} next @param {{animate?: boolean, user?: boolean, duration?: number}} [opts]
   */
  function moveCamera(next, { animate = false, user = true, duration = CAMERA_ANIM_MS } = {}) {
    if (user) {
      userMovedCamera = true;
      stopFollowing();
    }
    const target = cleanCamera(next);
    if (animate && size.w && size.h && !exportMode && !reducedMotion()) {
      cameraAnim = { from: camera, to: target, start: performance.now(), duration };
    } else {
      cameraAnim = null;
      camera = target;
    }
    schedule("camera");
  }

  function contentBounds() {
    const all = objects();
    const b = boardBounds(all);
    if (!b) return null;
    // Leave room for frame names above frames.
    let top = b.y;
    for (const o of Object.values(all)) if (o.type === "frame") top = Math.min(top, o.y - o.style.fontSize * 1.25 - 4);
    return { x: b.x, y: top, w: b.w, h: b.y + b.h - top };
  }

  function initialCamera() {
    const b = contentBounds();
    return b ? fitRect(b, size.w, size.h, { padding: 60, maxZoom: 1 }) : centerOn({ x: 0, y: 0 }, 1, size.w, size.h);
  }

  function measure() {
    const w = element.clientWidth, h = element.clientHeight;
    if (w === size.w && h === size.h) return;
    const first = !cameraReady && w > 0 && h > 0;
    // Keep the view centre fixed when the element resizes.
    if (cameraReady && size.w && size.h && w && h) {
      const c = screenToWorld(camera, { x: size.w / 2, y: size.h / 2 });
      camera = centerOn(c, camera.zoom, w, h);
    }
    size = { w, h };
    if (first) {
      cameraReady = true;
      camera = initialCamera();
    }
    if (exportMode) updateExportViewBox();
    schedule("camera");
  }

  // ------------------------------------------------------------------------------------------
  // Selection outlines (camera space) and overlay (screen space)
  // ------------------------------------------------------------------------------------------
  function renderOutlines() {
    /** @type {SVGElement[]} */
    const children = [];
    for (const id of selection) {
      const o = resolve(id);
      if (!o) continue;
      children.push(outlineFor(o, "wb-sel-outline"));
    }
    if (overlay.hoverId) {
      const o = resolve(overlay.hoverId);
      if (o) children.push(outlineFor(o, "wb-hover-outline"));
    }
    outlineGroup.replaceChildren(...children);
  }

  /** @param {WhiteboardObject} o @param {string} cls */
  function outlineFor(o, cls) {
    if (o.type === "connector") {
      const pts = connectorPoints(o, resolve) ?? [];
      return svgEl("polyline", { class: cls, points: pts.map((p) => `${round2(p.x)},${round2(p.y)}`).join(" ") });
    }
    return svgEl("polygon", { class: cls, points: corners(o).map((p) => `${round2(p.x)},${round2(p.y)}`).join(" ") });
  }

  function renderOverlay() {
    /** @type {SVGElement[]} */
    const children = [];
    const editing = !!editor?.isOpen;
    const busy = gesture && (gesture.kind === "dragging" || gesture.kind === "marquee" || gesture.kind === "connecting");
    const single = selection.length === 1 ? resolve(selection[0]) : undefined;
    if (single?.type === "connector") {
      if (!editing && !busy) children.push(...endpointHandleElements(endpointHandlePositions(connectorPoints(single, resolve), camera)));
    } else if (selection.length === 1 && !editing && !busy) {
      const o = resolve(selection[0]);
      if (o) {
        const handles = visibleHandles(o, camera, handleRadius(lastPointerType));
        const rot = o.rot || 0;
        const rotateHandle = handles.find((hd) => hd.name === "rotate");
        if (rotateHandle) {
          const top = handles.find((hd) => hd.name === "n");
          if (top) children.push(svgEl("line", { class: "wb-rotate-stem", x1: r1(top.x), y1: r1(top.y), x2: r1(rotateHandle.x), y2: r1(rotateHandle.y) }));
        }
        for (const hd of handles) {
          if (hd.name === "rotate") {
            children.push(svgEl("circle", { class: "wb-handle", cx: r1(hd.x), cy: r1(hd.y), r: 5 }));
          } else {
            children.push(svgEl("rect", {
              class: "wb-handle", x: r1(hd.x - 4.5), y: r1(hd.y - 4.5), width: 9, height: 9, rx: 1.5,
              transform: rot ? `rotate(${rot} ${r1(hd.x)} ${r1(hd.y)})` : "",
            }));
          }
        }
      }
    } else if (selection.length > 1) {
      const rects = [];
      for (const id of selection) {
        const o = resolve(id);
        const b = o && boundsOf(o, resolve);
        if (b) rects.push(b);
      }
      const u = unionRects(rects);
      if (u) {
        const a = worldToScreen(camera, u), b = worldToScreen(camera, { x: u.x + u.w, y: u.y + u.h });
        children.push(svgEl("rect", { class: "wb-group-box", x: r1(a.x - 4), y: r1(a.y - 4), width: r1(b.x - a.x + 8), height: r1(b.y - a.y + 8) }));
      }
    }
    if (overlay.marquee) {
      const m = overlay.marquee;
      const a = worldToScreen(camera, m), b = worldToScreen(camera, { x: m.x + m.w, y: m.y + m.h });
      children.push(svgEl("rect", { class: "wb-marquee", x: r1(a.x), y: r1(a.y), width: r1(b.x - a.x), height: r1(b.y - a.y) }));
    }
    if (overlay.guides.length) children.push(...guideElements(overlay.guides, camera));
    overlayGroup.replaceChildren(...children);
  }

  /** @param {PointerSample|{sx: number, sy: number, pointerType: string}} s */
  function handleUnder(s) {
    if (selection.length !== 1 || editor?.isOpen) return null;
    const o = resolve(selection[0]);
    if (!o) return null;
    if (o.type === "connector") {
      const radius = endpointRadius(handleRadius(s.pointerType), s.pointerType);
      const end = endpointForPress(connectorPoints(o, resolve), camera, { x: s.sx, y: s.sy }, radius);
      return end ? { id: o.id, name: end, rot: 0, endpoint: /** @type {const} */ (true) } : null;
    }
    const name = handleForPress(o, camera, { x: s.sx, y: s.sy }, handleRadius(s.pointerType));
    return name ? { id: o.id, name, rot: o.rot || 0, endpoint: /** @type {const} */ (false) } : null;
  }

  function updateHoverCursor() {
    if (!hoverPoint || gesture || tool !== "select" || spaceDown) {
      if (element.style.cursor) element.style.cursor = "";
      return;
    }
    const hd = handleUnder(hoverPoint);
    let cursor = "";
    if (hd) cursor = hd.endpoint ? "crosshair" : cursorForHandle(/** @type {any} */ (hd.name), hd.rot);
    else {
      const w = screenToWorld(camera, { x: hoverPoint.sx, y: hoverPoint.sy });
      if (hitAt(w)) cursor = "move";
    }
    if (element.style.cursor !== cursor) element.style.cursor = cursor;
  }

  // ------------------------------------------------------------------------------------------
  // Selection
  // ------------------------------------------------------------------------------------------
  /**
   * @param {string[]} ids @param {{announce?: boolean}} [opts]
   */
  function setSelectionInternal(ids, { announce = false } = {}) {
    const next = validIds(objects(), ids);
    if (next.length === selection.length && next.every((id, i) => id === selection[i])) return;
    selection = next;
    schedule("selection");
    schedule("cull");
    if (!exportMode) store.setPresence({ selection: [...selection] });
    emit({ kind: "selection" });
    if (announce) announceSelection();
  }

  function announceSelection() {
    if (!options.announce) return;
    if (selection.length === 0) options.announce("Selection cleared");
    else if (selection.length === 1) {
      const o = objects()[selection[0]];
      options.announce(o ? `Selected ${describe(o)}` : "Selected 1 object");
    } else options.announce(`Selected ${selection.length} objects`);
  }

  // ------------------------------------------------------------------------------------------
  // Text editing
  // ------------------------------------------------------------------------------------------
  /** @type {TextEditor|null} */
  const editor = exportMode ? null : new TextEditor({
    host: element,
    getObject: (id) => objects()[id],
    resolve,
    getCamera: () => camera,
    onCommit(id, value) {
      const o = objects()[id];
      if (!o) return;
      const patch = textPatch(o, value);
      if (o.type === "text" && !(patch?.text ?? o.text).trim()) {
        store.deleteObjects([id]);
        return;
      }
      if (patch) store.updateObjects([{ id, patch }]);
    },
    // The icon picker's panel may take focus without ending the edit, to insert at the caret.
    keepOpen: (t) => t instanceof Element && !!t.closest("[data-wb-keeps-editor]"),
    onCommand: (command) => emit({ kind: "command", command: /** @type {any} */ (command) }),
    onClose() {
      layer.setEditing(null);
      schedule("cull");
      store.setPresence({ editingId: null });
      schedule("overlay");
      emit({ kind: "editing" });
      if (!destroyed && document.activeElement !== element && (!document.activeElement || document.activeElement === document.body || element.contains(document.activeElement))) {
        element.focus({ preventScroll: true });
      }
    },
  });

  /** @param {string} id */
  function editText(id) {
    if (!editor) return;
    const o = objects()[id];
    if (!o || !canEditText(o)) return;
    cancelGesture();
    if (editor.isOpen && editor.id === id) return;
    if (selection.length !== 1 || selection[0] !== id) setSelectionInternal([id]);
    if (!cameraReady) measure();
    layer.setEditing(id);
    if (!layer.elements.has(id)) updateCulling();
    if (!editor.open(id)) {
      layer.setEditing(null);
      return;
    }
    store.setPresence({ editingId: id });
    schedule("overlay");
    emit({ kind: "editing" });
  }

  // ------------------------------------------------------------------------------------------
  // Presence and follow
  // ------------------------------------------------------------------------------------------
  const presence = presenceSvg ? new PresenceLayer(presenceSvg, {
    getState: () => store.getState(),
    connectorsOf: (ids) => layer.connectorsOf(ids),
  }) : null;

  function stopFollowing() {
    if (following === null) return;
    following = null;
    emit({ kind: "follow" });
  }

  function followStep() {
    if (!following) return;
    const peer = store.getState().peers.get(following);
    if (!peer) { stopFollowing(); return; }
    if (!peer.viewport || !size.w || !size.h) return;
    const target = fitRect(peer.viewport, size.w, size.h, { padding: 0 });
    moveCamera(target, { animate: true, user: false, duration: FOLLOW_ANIM_MS });
  }

  // ------------------------------------------------------------------------------------------
  // Tools and creation
  // ------------------------------------------------------------------------------------------
  /** @param {ObjectType} type */
  function toolStyle(type) {
    try {
      const s = options.toolStyle?.(type);
      return s && typeof s === "object" ? s : {};
    } catch {
      return {};
    }
  }

  /** @param {string|undefined} id @param {ObjectType} type */
  function finishCreate(id, type) {
    if (!id) return;
    if (type !== "pen") setSelectionInternal([id], { announce: true });
    if (!toolLocked && type !== "pen") setToolInternal("select", false);
    if (EDIT_ON_CREATE.includes(type)) editText(id);
  }

  /** @param {Tool} next @param {boolean} locked */
  function setToolInternal(next, locked) {
    if (!TOOLS.includes(/** @type {any} */ (next))) return;
    const changed = next !== tool || locked !== toolLocked;
    if (gesture) cancelGesture();
    tool = next;
    toolLocked = !!locked;
    element.dataset.tool = tool;
    if (changed) emit({ kind: "tool", tool, locked: toolLocked });
  }

  // ------------------------------------------------------------------------------------------
  // Gestures
  // ------------------------------------------------------------------------------------------
  /** @type {GestureContext} */
  const ctx = {
    store, element, objects, resolve, sorted, camera: () => camera, layer, overrides, preview: previewGroup,
    getSelection: () => [...selection],
    setSelection: setSelectionInternal,
    schedule: (kind) => schedule(kind),
    setCameraByUser: (cam) => moveCamera(cam),
    setOverlay(patch) {
      if ("marquee" in patch) { overlay.marquee = patch.marquee ?? null; schedule("overlay"); }
      if ("guides" in patch && (patch.guides?.length || overlay.guides.length)) { overlay.guides = patch.guides ?? []; schedule("overlay"); }
      if ("hoverId" in patch && patch.hoverId !== overlay.hoverId) { overlay.hoverId = patch.hoverId ?? null; schedule("selection"); schedule("cull"); }
    },
    toolStyle, finishCreate, editText,
    contextMenu: dispatchContextMenu,
    registerClick(id, p) {
      const prev = lastClick;
      const now = p.time;
      if (prev && prev.id === id && now - prev.time < DOUBLE_CLICK_MS && Math.hypot(prev.sx - p.sx, prev.sy - p.sy) < 12) {
        lastClick = null;
        return true;
      }
      lastClick = { id, time: now, sx: p.sx, sy: p.sy };
      return false;
    },
    announceSelection,
    // Snapping: SNAP_PX screen pixels at any zoom; the grid too when the board shows one.
    snapOptions: () => ({
      threshold: SNAP_PX / camera.zoom,
      grid: background === "grid" ? gridSpacing(camera.zoom) / camera.zoom : 0,
    }),
    snapTargets(moving) {
      const v = viewportOf(camera, size.w || 1, size.h || 1);
      const around = { x: v.x - v.w / 2, y: v.y - v.h / 2, w: v.w * 2, h: v.h * 2 };
      return snapTargets(objects(), spatial.query(around), moving);
    },
    objectAt: hitAt,
    objectsNear,
    announce: (message) => options.announce?.(message),
  };

  function cancelGesture() {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    g.cancel();
    element.classList.remove("wb-grabbing");
    schedule("overlay");
  }

  /** @param {PointerEvent|MouseEvent} e @returns {PointerSample} */
  function sample(e) {
    const rect = element.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const w = screenToWorld(camera, { x: sx, y: sy });
    return {
      sx, sy, x: w.x, y: w.y, shift: e.shiftKey, alt: e.altKey, clientX: e.clientX, clientY: e.clientY,
      pointerType: "pointerType" in e ? e.pointerType || "mouse" : "mouse", time: performance.now(),
    };
  }

  /**
   * @param {number} clientX @param {number} clientY @param {string[]} ids
   * @param {string} [pointerType] @param {{left: number, top: number, right: number, bottom: number}} [rect]
   */
  function dispatchContextMenu(clientX, clientY, ids, pointerType = "mouse", rect) {
    element.dispatchEvent(new CustomEvent("wb-contextmenu", {
      bubbles: true, detail: { clientX, clientY, ids: [...ids], pointerType, rect: rect ?? null },
    }));
  }

  /**
   * The keyboard path of the context menu: the current selection's actions (never a hit test),
   * anchored beside the selection's on-screen bounds, or the view centre with nothing selected.
   */
  function openKeyboardMenu() {
    keyMenuAt = performance.now();
    if (!cameraReady) measure();
    const box = element.getBoundingClientRect();
    const rects = [];
    for (const id of selection) {
      const o = resolve(id);
      const b = o && boundsOf(o, resolve);
      if (b) rects.push(b);
    }
    const u = unionRects(rects);
    if (!u) {
      const cx = box.left + size.w / 2, cy = box.top + size.h / 2;
      dispatchContextMenu(cx, cy, [], "keyboard", { left: cx, top: cy, right: cx, bottom: cy });
      return;
    }
    const a = worldToScreen(camera, u), b = worldToScreen(camera, { x: u.x + u.w, y: u.y + u.h });
    const clampX = (/** @type {number} */ v) => Math.min(box.right, Math.max(box.left, v));
    const clampY = (/** @type {number} */ v) => Math.min(box.bottom, Math.max(box.top, v));
    const rect = { left: clampX(box.left + a.x), top: clampY(box.top + a.y), right: clampX(box.left + b.x), bottom: clampY(box.top + b.y) };
    dispatchContextMenu(rect.left, rect.bottom, selection, "keyboard", rect);
  }

  /** Polite announcement of the latest keyboard change, once the keys pause. @param {string} message */
  function announceLater(message) {
    if (!options.announce) return;
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { announceTimer = 0; if (!destroyed) options.announce?.(message); }, ANNOUNCE_DEBOUNCE_MS);
  }

  /** @param {PointerEvent} e */
  function onPointerDown(e) {
    if (destroyed || e.target instanceof HTMLTextAreaElement) return;
    if (editor?.isOpen) editor.commit();
    canvasActive = true;
    lastPointerType = e.pointerType || "mouse";
    lastPointerDownAt = performance.now();
    if (document.activeElement !== element) element.focus({ preventScroll: true });
    if (!cameraReady) measure();
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        cancelGesture();
        const [a, b] = [...touches.values()];
        pinch = pinchGesture(ctx, toLocal(a), toLocal(b));
        for (const id of touches.keys()) ignoredPointers.add(id);
        capture(e);
        e.preventDefault();
        return;
      }
      if (touches.size > 2 || pinch) return;
    }
    if (gesture) return;
    if (e.pointerType === "mouse" && e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    const p = sample(e);
    capture(e);

    if (e.button === 1 || spaceDown || tool === "hand") {
      gesture = panGesture(ctx, p);
      return;
    }
    switch (tool) {
      case "select": {
        const hd = handleUnder(p);
        if (hd?.endpoint) { gesture = endpointGesture(ctx, p, hd.id, /** @type {"from"|"to"} */ (hd.name)); break; }
        if (hd) { gesture = handleGesture(ctx, p, hd.id, /** @type {any} */ (hd.name)); break; }
        const hit = hitAt(p);
        if (hit) { gesture = objectPressGesture(ctx, p, hit); break; }
        gesture = p.pointerType === "touch" ? panGesture(ctx, p, { tapClearsSelection: true }) : marqueeGesture(ctx, p);
        break;
      }
      case "pen":
        gesture = penGesture(ctx, p);
        break;
      case "connector": {
        const hit = hitAt(p, (o) => o.type !== "connector");
        gesture = hit ? connectGesture(ctx, p, hit) : p.pointerType === "touch" ? panGesture(ctx, p) : null;
        break;
      }
      default:
        if (CREATE_TOOLS.includes(tool)) gesture = createGesture(ctx, p, /** @type {ObjectType} */ (tool));
    }
    schedule("overlay");
  }

  /** @param {PointerEvent} e */
  function onPointerMove(e) {
    if (destroyed) return;
    if (e.pointerType === "touch" && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && touches.size >= 2) {
        const [a, b] = [...touches.values()];
        pinch.update(toLocal(a), toLocal(b));
        return;
      }
    }
    const p = sample(e);
    if (!exportMode && p.sx >= 0 && p.sy >= 0 && p.sx <= size.w && p.sy <= size.h) {
      pointerWorld = { x: p.x, y: p.y };
      store.setPresence({ cursor: { x: round2(p.x), y: round2(p.y) } });
    }
    if (ignoredPointers.has(e.pointerId)) return;
    if (gesture) {
      gesture.move(p);
      return;
    }
    if (e.pointerType === "mouse") {
      hoverPoint = { sx: p.sx, sy: p.sy, pointerType: "mouse" };
      schedule("hover");
    }
  }

  /** @param {PointerEvent} e */
  function onPointerUp(e) {
    if (destroyed) return;
    touches.delete(e.pointerId);
    if (pinch && touches.size < 2) pinch = null;
    if (ignoredPointers.delete(e.pointerId)) return;
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    // Run any pending frame work of the gesture first so its final state is consistent.
    g.up(sample(e));
    element.classList.remove("wb-grabbing");
    schedule("overlay");
  }

  /** @param {PointerEvent} e */
  function onPointerCancel(e) {
    touches.delete(e.pointerId);
    if (pinch && touches.size < 2) pinch = null;
    if (ignoredPointers.delete(e.pointerId)) return;
    cancelGesture();
  }

  function onPointerLeave() {
    hoverPoint = null;
    pointerWorld = null;
    if (!gesture && !exportMode) store.setPresence({ cursor: null });
  }

  /** @param {PointerEvent} e */
  function capture(e) {
    try { element.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  }

  /** @param {{x: number, y: number}} client */
  function toLocal(client) {
    const rect = element.getBoundingClientRect();
    return { x: client.x - rect.left, y: client.y - rect.top };
  }

  /** @param {WheelEvent} e */
  function onWheel(e) {
    if (destroyed || e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    if (!cameraReady) measure();
    const { dx, dy } = wheelPixels(e, size.h || 800);
    const rect = element.getBoundingClientRect();
    const s = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (e.shiftKey && !e.ctrlKey) {
      moveCamera(panBy(camera, -(dx || dy), 0));
    } else if (!e.ctrlKey && Math.abs(dx) > Math.abs(dy)) {
      moveCamera(panBy(camera, -dx, 0));
    } else {
      moveCamera(zoomAt(camera, s, camera.zoom * wheelZoomFactor(dy, e.ctrlKey)));
    }
  }

  /** @param {MouseEvent} e */
  function onContextMenu(e) {
    if (e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    if (gesture) return;
    const now = performance.now();
    // The context menu key and Shift+F10 were handled on keydown; this is their echo.
    if (now - keyMenuAt < KEY_MENU_ECHO_MS) { keyMenuAt = -Infinity; return; }
    // Only a pointer-originated right-click picks what is under the pointer. A keyboard-generated
    // event (no right button, no recent press) opens the menu for the current selection.
    if (e.button !== 2 && !e.ctrlKey && now - lastPointerDownAt > KEY_MENU_ECHO_MS) {
      openKeyboardMenu();
      keyMenuAt = -Infinity;
      return;
    }
    const p = sample(e);
    const hit = hitAt(p);
    if (hit && !selection.includes(hit.id)) setSelectionInternal([hit.id], { announce: true });
    dispatchContextMenu(e.clientX, e.clientY, hit ? selection : [], /** @type {any} */ (e).pointerType || "mouse");
  }

  // ------------------------------------------------------------------------------------------
  // Keyboard
  // ------------------------------------------------------------------------------------------
  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    if (destroyed) return;
    const target = /** @type {HTMLElement} */ (e.target);
    if (target !== element && target.closest?.("input, textarea, select, [contenteditable]")) return;
    // Alt held during a drag or resize bypasses snapping; pressing it alone does nothing else.
    if (e.key === "Alt") {
      if (gesture?.setAlt) { e.preventDefault(); gesture.setAlt(true); }
      return;
    }
    if (e.key === " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      if (!spaceDown) {
        spaceDown = true;
        element.classList.add("wb-space");
        schedule("hover");
      }
      return;
    }
    const action = keyAction(e);
    if (!action) return;
    e.preventDefault();
    const all = objects();
    switch (action.type) {
      case "delete":
        if (gesture || !selection.length) return;
        store.deleteObjects([...selection]);
        options.announce?.(`Deleted ${selection.length === 1 ? "1 object" : `${selection.length} objects`}`);
        setSelectionInternal([]);
        break;
      case "nudge": {
        if (gesture) return;
        if (!selection.length) {
          if (!cameraReady) measure();
          const step = panStep(action);
          moveCamera(panBy(camera, step.x, step.y));
          break;
        }
        const ids = expandMoveIds(all, selection);
        if (!ids.length) break;
        store.updateObjects(moveUpdates(all, ids, action.dx, action.dy));
        announceLater(`Moved ${directionWord(action.dx, action.dy)}`);
        break;
      }
      case "resize": {
        if (gesture || !selection.length) return;
        const updates = resizeUpdates(all, selection, (o) => ({ w: o.w + action.dw, h: o.h + action.dh }));
        if (!updates.length) break;
        store.updateObjects(updates);
        if (updates.length === 1) {
          const o = objects()[updates[0].id];
          if (o) announceLater(action.dw ? `Width ${o.w}` : `Height ${o.h}`);
        } else announceLater(`Resized ${updates.length} objects`);
        break;
      }
      case "rotate": {
        if (gesture || !selection.length) return;
        const updates = rotateUpdates(all, selection, action.deg);
        if (!updates.length) break;
        store.updateObjects(updates);
        announceLater(updates.length === 1 ? `Rotation ${updates[0].patch.rot} degrees` : `Rotated ${updates.length} objects`);
        break;
      }
      case "contextMenu":
        if (gesture) return;
        openKeyboardMenu();
        break;
      case "undo": cancelGesture(); store.undo(); break;
      case "redo": cancelGesture(); store.redo(); break;
      case "duplicate": if (!gesture) api.duplicate(selection); break;
      case "selectAll": setSelectionInternal(sorted().map((o) => o.id), { announce: true }); break;
      case "escape":
        if (gesture) cancelGesture();
        else if (selection.length) setSelectionInternal([], { announce: true });
        else if (tool !== "select") setToolInternal("select", false);
        break;
      case "edit":
        if (selection.length === 1) editText(selection[0]);
        break;
      case "front": case "back":
        if (selection.length && !gesture) store.reorder([...selection], action.type);
        break;
      case "tool": setToolInternal(action.tool, false); break;
      case "zoomIn": api.zoomBy(ZOOM_STEP); break;
      case "zoomOut": api.zoomBy(1 / ZOOM_STEP); break;
      case "fit": api.zoomToFit(); break;
      case "zoomReset": api.zoomBy(1 / camera.zoom); break;
      case "command": emit({ kind: "command", command: action.command }); break;
    }
  }

  /** @param {KeyboardEvent} e */
  function onKeyUp(e) {
    if (e.key === " ") releaseSpace();
    if (e.key === "Alt" && gesture?.setAlt) { e.preventDefault(); gesture.setAlt(false); }
  }

  function releaseSpace() {
    if (!spaceDown) return;
    spaceDown = false;
    element.classList.remove("wb-space");
    schedule("hover");
  }

  // ------------------------------------------------------------------------------------------
  // Store changes
  // ------------------------------------------------------------------------------------------
  function rebuildAll() {
    sortedCache = null;
    culler.reset();
    layer.wanted = planCulling();
    layer.rebuild(objects(), resolve);
    const kept = validIds(objects(), selection);
    if (kept.length !== selection.length) setSelectionInternal(kept);
    editor?.sync();
    presence?.invalidate(null);
    schedule("selection");
    schedule("presence");
  }

  /**
   * @param {import("../../store-contract.js").ClientState} state @param {Change} change
   */
  function onStoreChange(state, change) {
    if (destroyed) return;
    applyStoreChange(spatial, state, change);
    switch (change.kind) {
      case "snapshot": {
        setBackground(state.board.background);
        rebuildAll();
        if (exportMode) updateExportViewBox();
        else if (cameraReady && !userMovedCamera && Object.keys(state.board.objects).length) {
          camera = initialCamera();
          userMovedCamera = true;
          schedule("camera");
        }
        break;
      }
      case "objects": {
        const ids = change.objects;
        if (!ids) { rebuildAll(); break; }
        sortedCache = null;
        const added = updateCulling();
        const touched = layer.patch(ids, state.board.objects, resolve, added);
        for (const id of added) touched.add(id);
        // Re-apply in-progress move offsets to elements that were just re-rendered.
        for (const id of touched) {
          const ov = overrides.get(id);
          const o = state.board.objects[id];
          if (ov?.mode === "translate" && o) layer.translate(id, ov.geom.x - o.x, ov.geom.y - o.y);
        }
        if (gesture) schedule("gesture");
        const kept = validIds(state.board.objects, selection);
        if (kept.length !== selection.length) setSelectionInternal(kept);
        else if (ids.some((id) => selection.includes(id)) || selection.some((id) => layer.connectorsOf([id]).size)) schedule("selection");
        if (editor?.isOpen) editor.sync();
        presence?.invalidateObjects(touched);
        schedule("presence");
        if (exportMode) updateExportViewBox();
        break;
      }
      case "structure":
        setBackground(state.board.background);
        break;
      case "presence": {
        const key = remoteTransformIds().join(",");
        if (key !== remotePinKey) { remotePinKey = key; schedule("cull"); }
        presence?.invalidate(change.peers ?? null);
        schedule("presence");
        if (following && (!change.peers || change.peers.includes(following))) followStep();
        break;
      }
      case "flash":
        layer.flash(change.objects ?? []);
        break;
    }
  }

  /** @param {string} bg */
  function setBackground(bg) {
    const next = bg === "grid" || bg === "plain" ? bg : "dots";
    if (next === background && pattern.dataset.kind) return;
    background = next;
    delete pattern.dataset.kind;
    if (exportMode) return;
    schedule("camera");
  }

  function updateExportViewBox() {
    const b = contentBounds() ?? { x: 0, y: 0, w: 800, h: 600 };
    const pad = 40;
    svg.setAttribute("viewBox", `${round2(b.x - pad)} ${round2(b.y - pad)} ${round2(b.w + 2 * pad)} ${round2(b.h + 2 * pad)}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    cameraGroup.removeAttribute("transform");
    camera = size.w && size.h ? fitRect(b, size.w, size.h, { padding: pad }) : camera;
  }

  // ------------------------------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------------------------------
  const unsubscribe = store.subscribe(onStoreChange);
  /** @type {ResizeObserver|null} */
  let resizeObserver = null;
  /** @type {Array<[EventTarget, string, EventListener, AddEventListenerOptions|undefined]>} */
  const bound = [];
  /** @param {EventTarget} target @param {string} type @param {(e: any) => void} fn @param {AddEventListenerOptions} [opts] */
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    bound.push([target, type, fn, opts]);
  };

  {
    const state = store.getState();
    background = state.board.background === "grid" || state.board.background === "plain" ? state.board.background : "dots";
    spatial.reset(state.board.objects);
    // Unmeasured: only pins get elements; the first camera frame plans the viewport.
    layer.wanted = planCulling();
    layer.rebuild(state.board.objects, resolve);
  }

  if (exportMode) {
    updateExportViewBox();
  } else {
    on(element, "pointerdown", onPointerDown);
    on(element, "pointermove", onPointerMove);
    on(element, "pointerup", onPointerUp);
    on(element, "pointercancel", onPointerCancel);
    on(element, "pointerleave", onPointerLeave);
    on(element, "wheel", onWheel, { passive: false });
    on(element, "contextmenu", onContextMenu);
    // The echo of a context menu key handled on keydown lands wherever focus went (the menu, or
    // <body> when the key arrived there): no native menu on top of ours.
    on(window, "contextmenu", (e) => {
      if (element.contains(/** @type {Node} */ (e.target))) return;
      if (performance.now() - keyMenuAt < KEY_MENU_ECHO_MS) { e.preventDefault(); keyMenuAt = -Infinity; }
    });
    on(element, "keydown", onKeyDown);
    on(element, "keyup", onKeyUp);
    on(element, "blur", releaseSpace);
    on(window, "blur", () => { releaseSpace(); cancelGesture(); });
    // Canvas "activity": set by a press on the canvas, cleared by a press anywhere else. On the
    // platform a click can leave focus on <body>; keys arriving there still drive the canvas.
    on(window, "pointerdown", (e) => { canvasActive = element.contains(/** @type {Node} */ (e.target)); }, { capture: true });
    // Undo/redo outside text fields: never let the browser's native undo run (it refocuses the last
    // edited textarea). Keys inside the canvas are handled by onKeyDown; elsewhere route them here.
    on(window, "keydown", (e) => {
      if (destroyed || isTextField(e.target)) return;
      const action = undoAction(e);
      if (!action) return;
      e.preventDefault();
      if (element.contains(/** @type {Node} */ (e.target))) return;
      cancelGesture();
      if (action === "undo") store.undo(); else store.redo();
    }, { capture: true });
    on(window, "keydown", (e) => {
      if (e.defaultPrevented || !canvasActive || !isBodyTarget(e.target)) return;
      onKeyDown(e);
    });
    on(window, "keyup", (e) => {
      if (canvasActive && isBodyTarget(e.target)) onKeyUp(e);
    });
    // Safari's non-standard gesture events would otherwise zoom the whole page.
    on(element, "gesturestart", (e) => e.preventDefault());
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => measure());
      resizeObserver.observe(element);
    } else {
      on(window, "resize", measure);
    }
    schedule("camera");
  }

  // ------------------------------------------------------------------------------------------
  // Controller
  // ------------------------------------------------------------------------------------------
  /** @type {CanvasController} */
  const api = {
    element,
    getTool: () => tool,
    setTool: (next, locked = false) => setToolInternal(next, locked),
    getCamera: () => ({ ...camera }),
    setCamera(cam, animate = false) {
      if (!cameraReady) measure();
      moveCamera(cam, { animate });
    },
    zoomBy(factor) {
      if (!cameraReady) measure();
      const target = cameraAnim ? cameraAnim.to : camera;
      const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
      moveCamera(zoomAt(target, { x: size.w / 2, y: size.h / 2 }, target.zoom * f), { animate: true });
    },
    zoomToFit() {
      if (!cameraReady) measure();
      const b = contentBounds();
      const next = b ? fitRect(b, size.w, size.h, { padding: 60 }) : centerOn({ x: 0, y: 0 }, 1, size.w, size.h);
      moveCamera(next, { animate: true });
    },
    getViewport: () => viewportOf(camera, size.w || 1, size.h || 1),
    getSelection: () => [...selection],
    setSelection: (ids) => setSelectionInternal(Array.isArray(ids) ? ids : []),
    addAtCenter(type) {
      if (!Object.hasOwn(TYPE_DEFAULTS, type) || type === "pen" || type === "connector") return null;
      if (!cameraReady) measure();
      const c = screenToWorld(camera, { x: size.w / 2, y: size.h / 2 });
      const d = TYPE_DEFAULTS[type];
      // Nudge down-right while the spot is taken, so repeated adds do not stack exactly.
      let x = round2(c.x - d.w / 2), y = round2(c.y - d.h / 2);
      const taken = (/** @type {number} */ px, /** @type {number} */ py) =>
        Object.values(objects()).some((o) => o.type === type && Math.abs(o.x - px) < 1 && Math.abs(o.y - py) < 1);
      for (let i = 0; i < 20 && taken(x, y); i++) { x += 20; y += 20; }
      /** @type {Partial<WhiteboardObject> & {type: ObjectType}} */
      const obj = { type, x, y, w: d.w, h: d.h };
      const style = toolStyle(type);
      if (Object.keys(style).length) obj.style = /** @type {Style} */ (style);
      if (type !== "frame") obj.frameId = frameAtPoint(objects(), center({ x, y, w: d.w, h: d.h }));
      const [id] = store.createObjects([obj]);
      if (!id) return null;
      setSelectionInternal([id], { announce: true });
      if (EDIT_ON_CREATE.includes(type)) editText(id);
      return id;
    },
    addIcon(ref, at) {
      const icon = resolveIcon(ref);
      if (!icon || exportMode) return null;
      if (!cameraReady) measure();
      const d = iconDefaults(icon);
      let c = screenToWorld(camera, { x: size.w / 2, y: size.h / 2 });
      if (at && Number.isFinite(at.clientX) && Number.isFinite(at.clientY)) {
        c = screenToWorld(camera, toLocal({ x: at.clientX, y: at.clientY }));
      }
      let x = round2(c.x - d.w / 2), y = round2(c.y - d.h / 2);
      if (!at) {
        // Nudge down-right while the spot is taken, like addAtCenter.
        const taken = (/** @type {number} */ px, /** @type {number} */ py) =>
          Object.values(objects()).some((o) => o.type === "icon" && Math.abs(o.x - px) < 1 && Math.abs(o.y - py) < 1);
        for (let i = 0; i < 20 && taken(x, y); i++) { x += 20; y += 20; }
      }
      // Remembered colours: the line colour for every icon, fill and text colour only for shapes.
      const remembered = toolStyle("icon");
      /** @type {Record<string, any>} */
      const style = { ...d.style };
      if (remembered.stroke && remembered.stroke !== "none") style.stroke = remembered.stroke;
      if (icon.kind === "stencil") {
        if (remembered.fill) style.fill = remembered.fill;
        if (remembered.textColor) style.textColor = remembered.textColor;
      }
      /** @type {any} */
      const obj = {
        type: "icon", packId: icon.packId, iconId: icon.id, x, y, w: d.w, h: d.h, style,
        frameId: frameAtPoint(objects(), center({ x, y, w: d.w, h: d.h })),
      };
      const [id] = store.createObjects([obj]);
      if (!id) return null;
      setSelectionInternal([id], { announce: true });
      return id;
    },
    editText,
    getTextEdit() {
      if (!editor?.isOpen || !editor.id) return null;
      const o = objects()[editor.id];
      return o ? { id: o.id, type: o.type } : null;
    },
    finishTextEdit() {
      if (editor?.isOpen) editor.commit();
    },
    focusTextEdit() {
      if (!editor?.isOpen) return false;
      editor.focus();
      return true;
    },
    insertText(text, opts = {}) {
      if (exportMode || typeof text !== "string" || !text) return null;
      const at = opts.at && Number.isFinite(opts.at.clientX) && Number.isFinite(opts.at.clientY) ? opts.at : null;
      // Into the text being edited, at its caret (a drop always makes a new object).
      if (editor?.isOpen && editor.id && !at) {
        const id = editor.id;
        return editor.insert(text) ? { mode: "caret", id } : null;
      }
      if (editor?.isOpen) editor.commit();
      if (!cameraReady) measure();
      const fontSize = Math.max(8, Math.min(200, Math.round(opts.fontSize ?? INSERTED_TEXT_FONT_SIZE)));
      // A box fitted to the glyph (emoji are about 1em wide, drawn a little wider by some fonts).
      const w = Math.ceil(Math.max(fontSize, textWidth(text, fontSize)) * 1.25);
      const hgt = textObjectHeight(text, w, fontSize);
      let c = screenToWorld(camera, { x: size.w / 2, y: size.h / 2 });
      if (at) c = screenToWorld(camera, toLocal({ x: at.clientX, y: at.clientY }));
      let x = round2(c.x - w / 2), y = round2(c.y - hgt / 2);
      if (!at) {
        const taken = (/** @type {number} */ px, /** @type {number} */ py) =>
          Object.values(objects()).some((o) => o.type === "text" && Math.abs(o.x - px) < 1 && Math.abs(o.y - py) < 1);
        for (let i = 0; i < 20 && taken(x, y); i++) { x += 20; y += 20; }
      }
      const remembered = toolStyle("text");
      /** @type {any} */
      const obj = {
        type: "text", x, y, w, h: hgt, text,
        style: { ...(remembered.textColor ? { textColor: remembered.textColor } : {}), fontSize, align: "center" },
        frameId: frameAtPoint(objects(), center({ x, y, w, h: hgt })),
      };
      const [id] = store.createObjects([obj]);
      if (!id) return null;
      setSelectionInternal([id], { announce: true });
      return { mode: "object", id };
    },
    follow(clientId) {
      if (clientId === following) return;
      if (!clientId) { stopFollowing(); return; }
      following = clientId;
      emit({ kind: "follow" });
      followStep();
    },
    getFollowing: () => following,
    duplicate(ids) {
      const all = objects();
      const { creates, ids: newIds } = buildDuplicates(all, validIds(all, ids), () => newId("object"));
      if (!creates.length) return;
      store.createObjects(creates);
      setSelectionInternal(newIds, { announce: true });
    },
    getPointer: () => (pointerWorld ? { ...pointerWorld } : null),
    fitObjects(ids, { padding = 40, animate = true } = {}) {
      if (!cameraReady) measure();
      const rects = [];
      for (const id of ids) {
        const o = resolve(id);
        const b = o && boundsOf(o, resolve);
        if (b) rects.push(b);
      }
      const u = unionRects(rects);
      if (!u) return false;
      moveCamera(fitRect(u, size.w, size.h, { padding }), { animate });
      return true;
    },
    focusObjects(ids, opts) {
      if (!cameraReady) measure();
      const rects = [];
      for (const id of ids) {
        const o = resolve(id);
        const b = o && boundsOf(o, resolve);
        if (b) rects.push(b);
      }
      const u = unionRects(rects);
      if (!u) return;
      moveCamera(revealRect(camera, u, size.w, size.h, 60), { animate: opts?.animate !== false });
    },
    align(mode) {
      const updates = alignUpdates(objects(), selection, mode);
      if (updates.length) store.updateObjects(updates);
      return updates.length;
    },
    distribute(axis) {
      const updates = distributeUpdates(objects(), selection, axis);
      if (updates.length) store.updateObjects(updates);
      return updates.length;
    },
    reconnect(connectorId, end, targetId) {
      const all = objects();
      const conn = Object.hasOwn(all, connectorId) ? all[connectorId] : undefined;
      const target = Object.hasOwn(all, targetId) ? all[targetId] : undefined;
      const update = conn && (end === "from" || end === "to") ? reconnectUpdate(conn, end, target) : null;
      if (!update) return false;
      store.updateObjects([update]);
      return true;
    },
    getSpatialIndex: () => spatial,
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      cancelGesture();
      if (editor?.isOpen) editor.commit();
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      clearTimeout(announceTimer);
      unsubscribe();
      resizeObserver?.disconnect();
      for (const [target, type, fn, opts] of bound) target.removeEventListener(type, fn, opts);
      presence?.destroy();
      listeners.clear();
      if (!exportMode) {
        store.setPresence({ cursor: null, selection: [], transforms: [], stroke: null, editingId: null });
      }
      element.remove();
    },
  };

  return api;
}

/** Font size of a text object made by inserting an emoji or symbol from the picker. */
export const INSERTED_TEXT_FONT_SIZE = 64;

/** @param {string} pointerType */
function handleRadius(pointerType) {
  return HANDLE_RADIUS[/** @type {keyof typeof HANDLE_RADIUS} */ (pointerType)] ?? HANDLE_RADIUS.mouse;
}

function reducedMotion() {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** @param {WhiteboardObject} o */
function describe(o) {
  const names = { sticky: "sticky note", rect: "rectangle", ellipse: "ellipse", text: "text", frame: "frame", pen: "drawing", connector: "connector" };
  const label = o.text ? `: ${o.text.slice(0, 40)}` : "";
  if (o.type === "icon") {
    const icon = getIcon(o.packId, o.iconId);
    return `${icon ? icon.label.toLowerCase() + (icon.kind === "stencil" ? " shape" : " icon") : "icon"}${label}`;
  }
  return `${names[o.type] ?? o.type}${label}`;
}

/** @param {EventTarget|null} t */
function isTextField(t) {
  const el = /** @type {HTMLElement|null} */ (t instanceof Element ? t : null);
  return !!el?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])");
}

/** @param {EventTarget|null} t */
function isBodyTarget(t) {
  return t === document.body || t === document.documentElement || t === document || t === window;
}

/**
 * "undo" for Ctrl/Cmd+Z, "redo" for Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y, else null.
 * @param {KeyboardEvent} e
 */
function undoAction(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === "z") return e.shiftKey ? "redo" : "undo";
  if (key === "y") return "redo";
  return null;
}

/** @param {number} a @param {number} n */
function mod(a, n) {
  return ((a % n) + n) % n;
}

/** @param {number} v */
function r1(v) {
  return Math.round(v * 10) / 10;
}

/** @param {{x: number, y: number, w: number, h: number}} r */
function roundRect(r) {
  return { x: round2(r.x), y: round2(r.y), w: round2(r.w), h: round2(r.h) };
}
