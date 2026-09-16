// @ts-check
// Bottom right: zoom controls (−, percentage = reset to 100%, +, fit) and a minimap showing object
// bounds, your viewport and collaborators' viewports in their colours. Clicking or dragging on the
// minimap moves the camera; arrow keys on it pan. Redraws are coalesced to one per animation
// frame and skipped while the page or the minimap is hidden.

import { objectBounds } from "../../shared/geometry.js";
import { h, icon } from "./dom.js";

/** @typedef {import("./app.js").App} App */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */

const MINIMAP_W = 200;
const MINIMAP_H = 140;

/** @param {App} app */
export function createMinimap(app) {
  const { store, canvas } = app;

  // ---- zoom controls
  const level = h("button", {
    type: "button", class: "btn small zoom-level", title: "Reset zoom to 100% (Shift+0)", "aria-label": "Zoom 100%",
    onclick: () => zoomTo(1),
  }, "100%");
  const zoom = h("div", { class: "wb-float wb-zoom", role: "group", "aria-label": "Zoom" },
    h("button", { type: "button", class: "btn icon-only zoom-out", title: "Zoom out (−)", "aria-label": "Zoom out", onclick: () => canvas.zoomBy(1 / 1.25) }, icon("minus", 18)),
    level,
    h("button", { type: "button", class: "btn icon-only zoom-in", title: "Zoom in (+)", "aria-label": "Zoom in", onclick: () => canvas.zoomBy(1.25) }, icon("plus", 18)),
    h("button", { type: "button", class: "btn icon-only zoom-fit", title: "Zoom to fit (Shift+1)", "aria-label": "Zoom to fit", onclick: () => canvas.zoomToFit() }, icon("fit", 18)),
  );

  /** @param {number} z */
  function zoomTo(z) {
    const vp = canvas.getViewport();
    const cx = vp.x + vp.w / 2, cy = vp.y + vp.h / 2;
    const cam = canvas.getCamera();
    const vw = vp.w * cam.zoom, vh = vp.h * cam.zoom;
    canvas.setCamera({ x: cx - vw / 2 / z, y: cy - vh / 2 / z, zoom: z }, true);
  }

  // ---- minimap
  const cnv = /** @type {HTMLCanvasElement} */ (h("canvas", { width: MINIMAP_W, height: MINIMAP_H, "aria-hidden": "true" }));
  const el = h("div", {
    class: "wb-float wb-minimap", tabindex: "0", role: "application",
    "aria-label": "Minimap. Click to move the view there; arrow keys pan.", title: "Minimap",
  }, cnv);

  /** World rect the minimap currently shows, and its scale, for pointer mapping. */
  let frame = { x: 0, y: 0, scale: 1 };
  let scheduled = false;
  /** @type {any} */
  let boardRef = null;
  let boundsDirty = true;
  /** @type {Rect[]} */
  let rects = [];
  /** @type {Rect|null} */
  let content = null;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; draw(); });
  }

  function computeBounds() {
    const board = store.getState().board;
    // The store may patch the board in place, so identity alone is not enough.
    if (board === boardRef && !boundsDirty) return;
    boardRef = board;
    boundsDirty = false;
    rects = [];
    content = null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of Object.values(board.objects)) {
      if (o.type === "connector") continue; // too thin to see at minimap scale
      const r = objectBounds(o, board.objects);
      if (!r) continue;
      rects.push(r);
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    if (rects.length) content = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function draw() {
    if (document.hidden || el.hidden || !el.isConnected || el.offsetParent === null) return;
    computeBounds();
    const state = store.getState();
    const vp = canvas.getViewport();
    let x0 = vp.x, y0 = vp.y, x1 = vp.x + vp.w, y1 = vp.y + vp.h;
    if (content) {
      x0 = Math.min(x0, content.x); y0 = Math.min(y0, content.y);
      x1 = Math.max(x1, content.x + content.w); y1 = Math.max(y1, content.y + content.h);
    }
    for (const p of state.peers.values()) {
      if (!p.viewport) continue;
      x0 = Math.min(x0, p.viewport.x); y0 = Math.min(y0, p.viewport.y);
      x1 = Math.max(x1, p.viewport.x + p.viewport.w); y1 = Math.max(y1, p.viewport.y + p.viewport.h);
    }
    const pad = 0.06;
    const ww = Math.max(1, x1 - x0), wh = Math.max(1, y1 - y0);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = el.clientWidth || MINIMAP_W, ch = el.clientHeight || MINIMAP_H;
    if (cnv.width !== Math.round(cw * dpr)) { cnv.width = Math.round(cw * dpr); cnv.height = Math.round(ch * dpr); }
    const scale = Math.min(cw * (1 - 2 * pad) / ww, ch * (1 - 2 * pad) / wh);
    const ox = (cw - ww * scale) / 2 - x0 * scale, oy = (ch - wh * scale) / 2 - y0 * scale;
    frame = { x: ox, y: oy, scale };
    const ctx = cnv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = "rgba(37, 99, 235, .08)";
    ctx.fillRect(ox + vp.x * scale, oy + vp.y * scale, vp.w * scale, vp.h * scale);
    ctx.fillStyle = "#c3c8d0";
    for (const r of rects) {
      ctx.fillRect(ox + r.x * scale, oy + r.y * scale, Math.max(1, r.w * scale), Math.max(1, r.h * scale));
    }
    ctx.lineWidth = 1.5;
    for (const p of state.peers.values()) {
      if (!p.viewport) continue;
      ctx.strokeStyle = p.color;
      ctx.strokeRect(ox + p.viewport.x * scale, oy + p.viewport.y * scale, p.viewport.w * scale, p.viewport.h * scale);
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#2563eb";
    ctx.strokeRect(ox + vp.x * scale, oy + vp.y * scale, vp.w * scale, vp.h * scale);
  }

  /** @param {PointerEvent} e */
  function centreAt(e) {
    const r = cnv.getBoundingClientRect();
    const wx = (e.clientX - r.left - frame.x) / frame.scale;
    const wy = (e.clientY - r.top - frame.y) / frame.scale;
    const cam = canvas.getCamera();
    const vp = canvas.getViewport();
    canvas.setCamera({ x: wx - vp.w / 2, y: wy - vp.h / 2, zoom: cam.zoom });
  }
  let dragging = false;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    el.setPointerCapture(e.pointerId);
    if (canvas.getFollowing()) canvas.follow(null);
    centreAt(e);
  });
  el.addEventListener("pointermove", (e) => { if (dragging) centreAt(e); });
  const end = () => { dragging = false; };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!step) return;
    e.preventDefault();
    const cam = canvas.getCamera();
    const vp = canvas.getViewport();
    if (canvas.getFollowing()) canvas.follow(null);
    canvas.setCamera({ x: cam.x + step[0] * vp.w * 0.2, y: cam.y + step[1] * vp.h * 0.2, zoom: cam.zoom });
  });

  function renderZoom() {
    const pct = Math.round(canvas.getCamera().zoom * 100) + "%";
    if (level.textContent !== pct) {
      level.textContent = pct;
      level.setAttribute("aria-label", `Zoom ${pct}. Reset to 100%`);
    }
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });

  return {
    zoom, el,
    /** Something the minimap shows changed. */
    invalidate: schedule,
    /** Objects changed: recompute their bounds on the next draw. */
    invalidateObjects: () => { boundsDirty = true; schedule(); },
    renderZoom,
  };
}
