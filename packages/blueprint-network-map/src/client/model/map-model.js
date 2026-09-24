// @ts-check
// From store state and the current view to render records: decorations (src/shared/rules.js),
// visibility, positions of the view's layout, and deterministic spots for unplaced elements.
// Pure apart from reading the store's maps; recomputed per animation frame when objects change
// (positions alone update the renderer directly).

import { buildGraphIndex, decorate, layoutKeyOf } from "../../shared/rules.js";
import { placeNew } from "../layout/index.js";

/**
 * @typedef {object} MapModel
 * @property {import("../../shared/rules.js").GraphIndex} index
 * @property {any} view
 * @property {string} layout
 * @property {ReturnType<typeof decorate>} decor
 * @property {Map<string, import("../render/sigma-renderer.js").NodeRecord>} nodes
 * @property {Map<string, import("../render/sigma-renderer.js").EdgeRecord>} edges
 * @property {Map<string, {x: number, y: number}>} placed  positions computed for unplaced elements
 * @property {Map<string, any>} loops
 * @property {Map<string, any>} views
 */

/**
 * @param {{objects: Map<string, any>, positions: Map<string, Map<string, any>>, meta: any}} store
 * @param {string|null} viewId
 * @param {{labelMode?: "auto"|"all"|"none"}} [options]
 * @returns {MapModel}
 */
export function computeModel(store, viewId, options = {}) {
  const index = buildGraphIndex(store.objects.values());
  /** @type {Map<string, any>} */
  const views = new Map();
  /** @type {Map<string, any>} */
  const loops = new Map();
  for (const o of store.objects.values()) {
    if (o.id[0] === "v") views.set(o.id, o);
    else if (o.id[0] === "l") loops.set(o.id, o);
  }
  const view = (viewId && views.get(viewId)) || views.get(store.meta?.defaultViewId) || views.values().next().value || null;
  const layout = layoutKeyOf(view);
  const decor = decorate(index, view);
  const pos = store.positions.get(layout) ?? new Map();

  // Unplaced elements get deterministic spots near their neighbours.
  const missing = [];
  for (const id of index.elements.keys()) if (!pos.has(id)) missing.push(id);
  const neighbours = (/** @type {string} */ id) => (index.adjacency.get(id) ?? []).map((cid) => {
    const c = index.connections.get(cid);
    return c.from === id ? c.to : c.from;
  });
  const placed = placeNew(missing, (id) => pos.get(id), neighbours);

  const labelMode = options.labelMode ?? "auto";
  /** @type {Map<string, any>} */
  const nodes = new Map();
  for (const [id, e] of index.elements) {
    const d = /** @type {any} */ (decor.elements.get(id));
    if (d.hidden) continue;
    const p = pos.get(id) ?? placed.get(id) ?? { x: 0, y: 0 };
    nodes.set(id, {
      label: d.label ?? e.label, x: p.x, y: p.y, color: d.color, size: d.size, shape: d.shape, opacity: d.opacity,
      border: d.border, labelShown: labelMode === "all" || (labelMode === "auto" && d.label !== null),
    });
  }
  /** @type {Map<string, any>} */
  const edges = new Map();
  for (const [id, c] of index.connections) {
    const d = /** @type {any} */ (decor.connections.get(id));
    if (d.hidden || !nodes.has(c.from) || !nodes.has(c.to)) continue;
    edges.set(id, {
      from: c.from, to: c.to, color: d.color, width: d.width,
      arrow: !d.arrow ? "none" : c.direction === "mutual" ? "both" : c.direction === "directed" ? "forward" : "none",
      curved: d.curved, opacity: d.opacity, label: d.label,
    });
  }
  return { index, view, layout, decor, nodes, edges, placed, loops, views };
}

/**
 * Views in display order.
 * @param {Map<string, any>} views
 */
export function orderedViews(views) {
  return [...views.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}
