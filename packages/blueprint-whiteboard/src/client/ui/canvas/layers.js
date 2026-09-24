// @ts-check
// Committed objects as SVG DOM. Every object is rendered through shared/render.js objectNode (the
// same virtual nodes the server serialises for the SVG export) into its own wrapper <g>, kept in a
// Map by id so a change patches only that object (plus connectors attached to it). The wrapper's
// transform is free for in-progress moves, so dragging never re-renders the dragged objects.
//
// Culling (./culling.js): `wanted` limits which objects have an element at all (null: every object).
// Objects outside it keep no DOM; sync() adds and removes elements when the wanted set changes.

import { objectNode, SVG_NS } from "../../../shared/render.js";
import { sortedObjects } from "../../../shared/protocol.js";

/** @typedef {import("../../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("../../../shared/render.js").VNode} VNode */
/** @typedef {(id: string) => WhiteboardObject|undefined} Resolve */

/**
 * @param {string} tag @param {Record<string, string|number>} [attrs]
 * @returns {SVGElement}
 */
export function svgEl(tag, attrs) {
  const el = /** @type {SVGElement} */ (document.createElementNS(SVG_NS, tag));
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * Virtual node to SVG DOM.
 * @param {VNode} node
 * @returns {SVGElement}
 */
export function buildNode(node) {
  const el = svgEl(node.tag, node.attrs);
  if (node.text !== undefined) el.textContent = node.text;
  if (node.children) for (const child of node.children) el.appendChild(buildNode(child));
  return el;
}

/** @typedef {{objectRenders: number, fullRenders: number, rendered?: number}} RenderStats */

export class ObjectLayer {
  /**
   * @param {SVGGElement} framesGroup  frames render below everything
   * @param {SVGGElement} othersGroup
   * @param {RenderStats} stats
   * @param {(id: string) => WhiteboardObject|undefined} [drawOverride]  geometry to draw instead of
   *   the committed object (an in-progress resize or rotate); connectors always use `resolve`
   * @param {(ids: Iterable<string>) => Set<string>} [allConnectorsOf]  connectors attached to ids,
   *   rendered or not (the spatial index's map); defaults to the rendered ones only
   */
  constructor(framesGroup, othersGroup, stats, drawOverride = () => undefined, allConnectorsOf) {
    this.drawOverride = drawOverride;
    this.allConnectorsOf = allConnectorsOf;
    this.framesGroup = framesGroup;
    this.othersGroup = othersGroup;
    this.stats = stats;
    /** @type {Map<string, SVGGElement>} */
    this.elements = new Map();
    /** Stacking key last rendered per id, to notice z changes. @type {Map<string, string>} */
    this.orderKeys = new Map();
    /** connector id -> [from, to] as last rendered. @type {Map<string, [string, string]>} */
    this.ends = new Map();
    /** object id -> connectors attached to it. @type {Map<string, Set<string>>} */
    this.attached = new Map();
    /** Ids whose text is hidden because the inline editor covers it. @type {string|null} */
    this.editingId = null;
    /** Ids allowed an element (viewport culling); null: every object. @type {Set<string>|null} */
    this.wanted = null;
  }

  /** @param {string} id */
  isWanted(id) {
    return !this.wanted || this.wanted.has(id);
  }

  /**
   * Applies a new wanted set (null: every object): removes elements no longer wanted, renders the
   * newly wanted ones and restores stacking order when anything was added.
   * @param {Set<string>|null} wanted @param {Record<string, WhiteboardObject>} objects @param {Resolve} resolve
   * @param {WhiteboardObject[]} [sorted]  objects in stacking order, when the caller has it cached
   * @returns {{added: Set<string>, removed: number}}
   */
  sync(wanted, objects, resolve, sorted) {
    this.wanted = wanted;
    /** @type {Set<string>} */
    const added = new Set();
    let removed = 0;
    for (const id of [...this.elements.keys()]) {
      if (!Object.hasOwn(objects, id) || !this.isWanted(id)) { this.remove(id); removed++; }
    }
    const candidates = wanted ?? Object.keys(objects);
    for (const id of candidates) {
      if (this.elements.has(id) || !Object.hasOwn(objects, id)) continue;
      const o = objects[id];
      const el = this.render(o, resolve);
      (o.type === "frame" ? this.framesGroup : this.othersGroup).appendChild(el);
      added.add(id);
    }
    if (added.size) this.reorder(objects, sorted);
    this.stats.rendered = this.elements.size;
    return { added, removed };
  }

  /**
   * Rebuilds every element.
   * @param {Record<string, WhiteboardObject>} objects @param {Resolve} resolve
   */
  rebuild(objects, resolve) {
    this.stats.fullRenders++;
    this.framesGroup.replaceChildren();
    this.othersGroup.replaceChildren();
    this.elements.clear();
    this.orderKeys.clear();
    this.ends.clear();
    this.attached.clear();
    for (const o of sortedObjects(objects)) {
      if (!this.isWanted(o.id)) continue;
      const el = this.render(o, resolve);
      (o.type === "frame" ? this.framesGroup : this.othersGroup).appendChild(el);
    }
    this.stats.rendered = this.elements.size;
  }

  /**
   * Patches changed ids (created, updated or deleted) and the connectors attached to them. Ids
   * that are not wanted lose their element; `skip` names ids already rendered fresh (by sync).
   * @param {Iterable<string>} ids @param {Record<string, WhiteboardObject>} objects @param {Resolve} resolve
   * @param {Set<string>} [skip]
   * @returns {Set<string>} ids rendered or removed
   */
  patch(ids, objects, resolve, skip) {
    /** @type {Set<string>} */
    const touched = new Set();
    let reorder = false;
    for (const id of ids) {
      touched.add(id);
      for (const c of this.attached.get(id) ?? []) touched.add(c);
    }
    for (const id of touched) {
      const o = Object.hasOwn(objects, id) ? objects[id] : undefined;
      if (!o || !this.isWanted(id)) {
        this.remove(id);
        continue;
      }
      if (skip?.has(id)) continue;
      const existed = this.elements.has(id);
      if (!existed || this.orderKeys.get(id) !== orderKey(o)) reorder = true;
      const el = this.render(o, resolve);
      if (!existed) (o.type === "frame" ? this.framesGroup : this.othersGroup).appendChild(el);
    }
    // A connector added now may attach to objects patched earlier in this loop; nothing to do.
    if (reorder) this.reorder(objects);
    this.stats.rendered = this.elements.size;
    return touched;
  }

  /**
   * Re-renders `ids` with `resolve` (e.g. during a resize) without touching order.
   * @param {Iterable<string>} ids @param {Record<string, WhiteboardObject>} objects @param {Resolve} resolve
   */
  rerender(ids, objects, resolve) {
    for (const id of ids) {
      const o = objects[id];
      if (o && this.elements.has(id)) this.render(o, resolve);
    }
  }

  /**
   * Renders one object into its wrapper (created when missing), returns the wrapper.
   * @param {WhiteboardObject} o @param {Resolve} resolve
   */
  render(o, resolve) {
    let el = this.elements.get(o.id);
    if (!el) {
      el = /** @type {SVGGElement} */ (svgEl("g", { class: "wb-obj", "data-oid": o.id }));
      this.elements.set(o.id, el);
      if (this.editingId === o.id) el.classList.add("wb-editing");
    }
    this.stats.objectRenders++;
    const drawn = o.type === "connector" ? o : this.drawOverride(o.id) ?? o;
    const node = objectNode(drawn, resolve);
    if (node) el.replaceChildren(buildNode(node));
    else el.replaceChildren();
    this.orderKeys.set(o.id, orderKey(o));
    if (o.type === "connector") this.trackConnector(o);
    return el;
  }

  /** @param {WhiteboardObject} c */
  trackConnector(c) {
    const prev = this.ends.get(c.id);
    const next = /** @type {[string, string]} */ ([c.from ?? "", c.to ?? ""]);
    if (prev && prev[0] === next[0] && prev[1] === next[1]) return;
    if (prev) for (const end of prev) this.attached.get(end)?.delete(c.id);
    this.ends.set(c.id, next);
    for (const end of next) {
      if (!end) continue;
      let set = this.attached.get(end);
      if (!set) this.attached.set(end, set = new Set());
      set.add(c.id);
    }
  }

  /** @param {string} id */
  remove(id) {
    this.elements.get(id)?.remove();
    this.elements.delete(id);
    this.orderKeys.delete(id);
    const ends = this.ends.get(id);
    if (ends) for (const end of ends) this.attached.get(end)?.delete(id);
    this.ends.delete(id);
    // Connectors still attached to a removed object stay tracked; they are removed by their own change.
  }

  /**
   * Connectors attached to any of `ids` (with culling, including connectors without an element).
   * @param {Iterable<string>} ids
   * @returns {Set<string>}
   */
  connectorsOf(ids) {
    if (this.allConnectorsOf) return this.allConnectorsOf(ids);
    /** @type {Set<string>} */
    const out = new Set();
    for (const id of ids) for (const c of this.attached.get(id) ?? []) out.add(c);
    return out;
  }

  /**
   * Brings DOM order in line with stacking order, moving only misplaced nodes.
   * @param {Record<string, WhiteboardObject>} objects
   * @param {WhiteboardObject[]} [sorted]  `objects` in stacking order, when the caller has it cached
   */
  reorder(objects, sorted = sortedObjects(objects)) {
    for (const [group, list] of /** @type {const} */ ([
      [this.framesGroup, sorted.filter((o) => o.type === "frame")],
      [this.othersGroup, sorted.filter((o) => o.type !== "frame")],
    ])) {
      let cursor = group.firstChild;
      for (const o of list) {
        const el = this.elements.get(o.id);
        if (!el) continue;
        if (el === cursor) { cursor = cursor.nextSibling; continue; }
        group.insertBefore(el, cursor);
      }
    }
  }

  /**
   * Offsets an element visually (in-progress move); (0, 0) clears.
   * @param {string} id @param {number} dx @param {number} dy
   */
  translate(id, dx, dy) {
    const el = this.elements.get(id);
    if (!el) return;
    if (!dx && !dy) el.removeAttribute("transform");
    else el.setAttribute("transform", `translate(${Math.round(dx * 100) / 100} ${Math.round(dy * 100) / 100})`);
  }

  /** @param {string|null} id */
  setEditing(id) {
    if (this.editingId) this.elements.get(this.editingId)?.classList.remove("wb-editing");
    this.editingId = id;
    if (id) this.elements.get(id)?.classList.add("wb-editing");
  }

  /** @param {Iterable<string>} ids */
  flash(ids) {
    for (const id of ids) {
      const el = this.elements.get(id);
      if (!el) continue;
      el.classList.remove("wb-flash");
      // Restart the animation.
      void el.getBoundingClientRect();
      el.classList.add("wb-flash");
      setTimeout(() => el.classList.remove("wb-flash"), 1200);
    }
  }
}

/** @param {WhiteboardObject} o */
function orderKey(o) {
  return `${o.type === "frame" ? 0 : 1}|${o.z}`;
}
