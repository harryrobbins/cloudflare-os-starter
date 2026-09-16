// @ts-check
// Collaborators' ephemeral state, drawn in a separate overlay <svg> that never touches committed
// objects: cursors with name labels (constant screen size, eased toward the latest position),
// translucent ghosts of objects being dragged, resized or rotated (with attached connectors
// following the ghosts), selection outlines in the peer's colour, strokes being drawn and an
// "is editing" badge. Rendering is driven by the canvas's animation-frame loop.

import { objectNode } from "../../../shared/render.js";
import { corners, strokePathD, textWidth, rotatedBounds } from "../../../shared/geometry.js";
import { ROTATABLE } from "../../../shared/protocol.js";
import { buildNode, svgEl } from "./layers.js";
import { cameraTransform, worldToScreen } from "./camera.js";
import { connectorPoints } from "./model.js";

/** @typedef {import("../../store-contract.js").Store} Store */
/** @typedef {import("../../store-contract.js").Peer} Peer */
/** @typedef {import("../../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {{x: number, y: number, zoom: number}} Camera */

const LABEL_FONT = 12;
/** Cursor easing time constant, ms: about two presence intervals. */
const EASE_MS = 50;

/**
 * @typedef {object} PeerView
 * @property {SVGGElement} world    ghosts, outlines, strokes (camera space)
 * @property {SVGGElement} cursor   screen space
 * @property {SVGGElement} badge    screen space
 * @property {string} labelKey
 * @property {{x: number, y: number}|null} shown  eased cursor position, world
 */

export class PresenceLayer {
  /**
   * @param {SVGSVGElement} svg  the overlay
   * @param {{getState: Store["getState"], connectorsOf: (ids: Iterable<string>) => Set<string>}} deps
   */
  constructor(svg, deps) {
    this.svg = svg;
    this.deps = deps;
    this.worldGroup = /** @type {SVGGElement} */ (svgEl("g", { class: "wb-presence-world" }));
    this.screenGroup = /** @type {SVGGElement} */ (svgEl("g", { class: "wb-presence-screen" }));
    svg.append(this.worldGroup, this.screenGroup);
    /** @type {Map<string, PeerView>} */
    this.views = new Map();
    /** @type {Set<string>} */
    this.dirty = new Set();
    this.allDirty = true;
    this.lastTime = 0;
  }

  /** @param {Iterable<string>|null} peers  null: every peer */
  invalidate(peers) {
    if (!peers) { this.allDirty = true; return; }
    for (const id of peers) this.dirty.add(id);
  }

  /**
   * Peers whose drawing depends on any of `ids` (ghosts, selections, editing badges).
   * @param {Iterable<string>} ids
   */
  invalidateObjects(ids) {
    const set = new Set(ids);
    for (const peer of this.deps.getState().peers.values()) {
      if (peer.transforms.some((t) => set.has(t.id)) || peer.selection.some((id) => set.has(id)) ||
          (peer.editingId && set.has(peer.editingId))) this.dirty.add(peer.clientId);
    }
  }

  /**
   * @param {Camera} cam @param {number} now
   * @returns {boolean} true while cursors are still easing (call again next frame)
   */
  render(cam, now) {
    const state = this.deps.getState();
    const dt = this.lastTime ? Math.min(200, now - this.lastTime) : 1000;
    this.lastTime = now;
    this.worldGroup.setAttribute("transform", cameraTransform(cam));
    for (const [id, view] of this.views) {
      if (!state.peers.has(id)) {
        view.world.remove(); view.cursor.remove(); view.badge.remove();
        this.views.delete(id);
      }
    }
    let animating = false;
    const objects = state.board.objects;
    for (const peer of state.peers.values()) {
      let view = this.views.get(peer.clientId);
      const fresh = !view;
      if (!view) {
        view = {
          world: /** @type {SVGGElement} */ (svgEl("g", { class: "wb-peer" })),
          cursor: /** @type {SVGGElement} */ (svgEl("g", { class: "wb-cursor", "data-client": peer.clientId })),
          badge: /** @type {SVGGElement} */ (svgEl("g", { class: "wb-badge" })),
          labelKey: "", shown: null,
        };
        this.worldGroup.appendChild(view.world);
        this.screenGroup.append(view.cursor, view.badge);
        this.views.set(peer.clientId, view);
      }
      if (fresh || this.allDirty || this.dirty.has(peer.clientId)) this.renderWorld(view, peer, objects);
      animating = this.renderCursor(view, peer, cam, dt) || animating;
      this.renderBadge(view, peer, objects, cam);
    }
    this.dirty.clear();
    this.allDirty = false;
    if (!animating) this.lastTime = 0;
    return animating;
  }

  /**
   * @param {PeerView} view @param {Peer} peer @param {Record<string, WhiteboardObject>} objects
   */
  renderWorld(view, peer, objects) {
    /** @type {Map<string, import("../../../shared/protocol.js").PresenceTransform>} */
    const tmap = new Map();
    for (const t of peer.transforms) tmap.set(t.id, t);
    /** @param {string} id @returns {WhiteboardObject|undefined} */
    const resolve = (id) => {
      const o = Object.hasOwn(objects, id) ? objects[id] : undefined;
      const t = tmap.get(id);
      if (!o || !t) return o;
      const rotates = /** @type {readonly string[]} */ (ROTATABLE).includes(o.type);
      return { ...o, x: t.x, y: t.y, w: t.w, h: t.h, rot: rotates ? t.rot : 0 };
    };
    /** @type {SVGElement[]} */
    const children = [];
    if (tmap.size) {
      const ghosts = /** @type {SVGGElement} */ (svgEl("g", { class: "wb-ghost" }));
      const ghostIds = [...tmap.keys()].filter((id) => Object.hasOwn(objects, id));
      for (const id of this.deps.connectorsOf(ghostIds)) {
        const c = objects[id];
        const node = c && objectNode(c, resolve);
        if (node) ghosts.appendChild(buildNode(node));
      }
      for (const id of ghostIds) {
        const g = resolve(id);
        const node = g && objectNode(g, resolve);
        if (node) ghosts.appendChild(buildNode(node));
      }
      children.push(ghosts);
    }
    for (const id of peer.selection) {
      const o = resolve(id);
      if (!o) continue;
      if (o.type === "connector") {
        const pts = connectorPoints(o, resolve);
        if (pts) children.push(svgEl("polyline", {
          class: "wb-peer-outline", points: pts.map((p) => `${r2(p.x)},${r2(p.y)}`).join(" "), stroke: peer.color,
        }));
      } else {
        children.push(svgEl("polygon", {
          class: "wb-peer-outline", points: corners(o).map((p) => `${r2(p.x)},${r2(p.y)}`).join(" "), stroke: peer.color,
        }));
      }
    }
    if (peer.stroke && peer.stroke.points.length >= 2) {
      children.push(svgEl("path", {
        class: "wb-peer-stroke", d: strokePathD(peer.stroke.points), stroke: peer.stroke.color,
        "stroke-width": peer.stroke.width,
      }));
    }
    view.world.replaceChildren(...children);
  }

  /**
   * @param {PeerView} view @param {Peer} peer @param {Camera} cam @param {number} dt
   * @returns {boolean} still easing
   */
  renderCursor(view, peer, cam, dt) {
    const name = peer.name || "Guest";
    const key = `${name}|${peer.color}`;
    if (view.labelKey !== key) {
      view.labelKey = key;
      const w = textWidth(name, LABEL_FONT) + 12;
      const text = svgEl("text", { x: 6, y: 13, "font-size": LABEL_FONT, fill: readableOn(peer.color) });
      text.textContent = name;
      const label = svgEl("g", { transform: "translate(10 18)" });
      label.append(svgEl("rect", { width: Math.ceil(w), height: 18, rx: 4, fill: peer.color }), text);
      view.cursor.replaceChildren(
        svgEl("path", { d: "M0 0L0 17L4.8 12.6L8 19.5L10.8 18.3L7.7 11.6L14 11.6Z", fill: peer.color, stroke: "#ffffff", "stroke-width": 1.2 }),
        label,
      );
    }
    const target = peer.cursor;
    if (!target) {
      view.shown = null;
      view.cursor.setAttribute("visibility", "hidden");
      return false;
    }
    let shown = view.shown;
    if (!shown) shown = { x: target.x, y: target.y };
    else {
      const k = 1 - Math.exp(-dt / EASE_MS);
      shown = { x: shown.x + (target.x - shown.x) * k, y: shown.y + (target.y - shown.y) * k };
    }
    const s = worldToScreen(cam, shown);
    const ts = worldToScreen(cam, target);
    const done = Math.hypot(ts.x - s.x, ts.y - s.y) < 0.5;
    view.shown = done ? { x: target.x, y: target.y } : shown;
    const p = done ? ts : s;
    view.cursor.removeAttribute("visibility");
    view.cursor.setAttribute("transform", `translate(${r2(p.x)} ${r2(p.y)})`);
    return !done;
  }

  /**
   * @param {PeerView} view @param {Peer} peer @param {Record<string, WhiteboardObject>} objects @param {Camera} cam
   */
  renderBadge(view, peer, objects, cam) {
    const o = peer.editingId && Object.hasOwn(objects, peer.editingId) ? objects[peer.editingId] : null;
    if (!o || o.type === "connector") {
      if (view.badge.firstChild) view.badge.replaceChildren();
      return;
    }
    const b = rotatedBounds(o);
    const p = worldToScreen(cam, { x: b.x, y: b.y });
    const label = `${peer.name || "Guest"} is editing`;
    if (view.badge.dataset.key !== label + peer.color) {
      view.badge.dataset.key = label + peer.color;
      const w = textWidth(label, 11) + 10;
      const text = svgEl("text", { x: 5, y: 12, "font-size": 11, fill: readableOn(peer.color) });
      text.textContent = label;
      view.badge.replaceChildren(svgEl("rect", { width: Math.ceil(w), height: 16, rx: 3, fill: peer.color }), text);
    }
    const y = o.type === "frame" ? p.y - (o.style.fontSize * 1.25 + 4) * cam.zoom - 18 : p.y - 18;
    view.badge.setAttribute("transform", `translate(${r2(p.x)} ${r2(y)})`);
  }

  destroy() {
    this.worldGroup.remove();
    this.screenGroup.remove();
    this.views.clear();
  }
}

/** @param {number} v */
function r2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * Dark or light text for a background colour.
 * @param {string} hex
 */
export function readableOn(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return "#ffffff";
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.2 ? "#111827" : "#ffffff";
}
