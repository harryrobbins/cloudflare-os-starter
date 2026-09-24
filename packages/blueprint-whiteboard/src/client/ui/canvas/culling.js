// @ts-check
// Viewport culling: which committed objects the canvas keeps as SVG. Pure (no DOM), driven by the
// canvas controller on camera changes, store changes and pin changes (selection, hover, editing,
// gestures, remote transforms). The client model is never culled: only the DOM is.
//
// The rendered set is
//   V  objects whose indexed effective bounds meet the "covered" rect: the viewport grown by
//      OVERSCAN of its size on every side
//   P  pins: selected, hovered and text-edited objects, objects in the local gesture, and objects
//      a collaborator is transforming (their presence ghosts)
//   C  connectors attached to anything in V or P (a connector whose endpoint is visible)
//   E  both endpoints of every connector in V, P or C (needed to draw it)
// so it is bounded by |V| + |P| + |C| + 2|C|, and independent of how many objects are off screen.
// Connectors whose route is visible are already in V (the index holds route bounds).
//
// No edge flashing: the covered rect is only recomputed when the viewport leaves it (or zooming
// in leaves it more than MAX_COVER_RATIO times too big), and the canvas does that in the same
// animation frame that applies the new camera, before the browser paints. Overscan only reduces
// how often the DOM changes while panning.
//
// Boards with fewer than MIN_OBJECTS indexed objects are rendered in full: the DOM is already small
// and every object stays addressable by selector.

/** @typedef {{x: number, y: number, w: number, h: number}} Rect */
/** @typedef {import("../../../shared/protocol.js").WhiteboardObject} WhiteboardObject */

/** Overscan on each side, as a fraction of the viewport's width and height. */
export const OVERSCAN = 0.5;
/** Culling starts at this many indexed objects. */
export const MIN_OBJECTS = 300;
/** Zooming in recomputes once the covered rect is this many times the area it would now be. */
export const MAX_COVER_RATIO = 9;

/**
 * The index surface culling reads: rect queries plus the endpoint -> connectors map the spatial
 * index keeps for every connector (rendered or not).
 * @typedef {object} CullIndex
 * @property {(rect: Rect) => string[]} query
 * @property {number} size
 * @property {Map<string, Set<string>>} dependents
 */

/**
 * Connectors attached to any of `ids`, from the spatial index (covers connectors that are not
 * rendered, unlike the object layer's own map).
 * @param {{dependents: Map<string, Set<string>>}} index @param {Iterable<string>} ids
 * @returns {Set<string>}
 */
export function connectorsOf(index, ids) {
  /** @type {Set<string>} */
  const out = new Set();
  for (const id of ids) for (const c of index.dependents.get(id) ?? []) out.add(c);
  return out;
}

/**
 * `rect` grown by `fraction` of its size on every side.
 * @param {Rect} rect @param {number} fraction @returns {Rect}
 */
export function expandRect(rect, fraction) {
  const dx = rect.w * fraction, dy = rect.h * fraction;
  return { x: rect.x - dx, y: rect.y - dy, w: rect.w + 2 * dx, h: rect.h + 2 * dy };
}

/** @param {Rect} outer @param {Rect} inner */
function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

export class Culler {
  /**
   * @param {{overscan?: number, minObjects?: number, enabled?: boolean}} [opts]
   *   enabled: false renders everything (export mode)
   */
  constructor({ overscan = OVERSCAN, minObjects = MIN_OBJECTS, enabled = true } = {}) {
    this.overscan = overscan;
    this.minObjects = minObjects;
    this.enabled = enabled;
    /** The world rect the current plan covers; null: nothing planned yet. @type {Rect|null} */
    this.covered = null;
    /** The last plan rendered everything (culling off or a small board): camera moves never re-plan. */
    this.full = false;
    /** Algorithmic counters (never content). */
    this.stats = { plans: 0, visible: 0, pinned: 0, closure: 0, wanted: 0 };
  }

  /**
   * Whether the camera moved far enough that the plan must be recomputed.
   * @param {Rect|null} viewport  world viewport, null while the canvas has no size
   */
  stale(viewport) {
    if (this.full) return false;
    if (!this.covered) return true;
    if (!viewport) return false;
    if (!contains(this.covered, viewport)) return true;
    const ideal = expandRect(viewport, this.overscan);
    return this.covered.w * this.covered.h > MAX_COVER_RATIO * ideal.w * ideal.h;
  }

  /** Forget the covered rect, so the next plan recomputes it from the viewport. */
  reset() {
    this.covered = null;
  }

  /**
   * The ids to render, or null for "every object" (culling off or the board is small).
   * `viewport` null (no size yet) renders only the pins, so an unmeasured canvas never builds the
   * whole board; the canvas plans again as soon as it has a size.
   * @param {object} args
   * @param {CullIndex} args.index
   * @param {Record<string, WhiteboardObject>} args.objects
   * @param {Rect|null} args.viewport
   * @param {Iterable<string>} args.pins
   * @returns {Set<string>|null}
   */
  plan({ index, objects, viewport, pins }) {
    if (!this.enabled || index.size < this.minObjects) {
      this.covered = null;
      this.full = true;
      return null;
    }
    this.full = false;
    this.stats.plans++;
    if (viewport && (!this.covered || this.stale(viewport))) this.covered = expandRect(viewport, this.overscan);
    /** @type {Set<string>} */
    const wanted = new Set(this.covered && viewport ? index.query(this.covered) : []);
    this.stats.visible = wanted.size;
    const has = (/** @type {string} */ id) => typeof id === "string" && Object.hasOwn(objects, id);
    let pinned = 0;
    for (const id of pins) if (has(id) && !wanted.has(id)) { wanted.add(id); pinned++; }
    this.stats.pinned = pinned;
    const before = wanted.size;
    // C: connectors of visible or pinned objects.
    /** @type {string[]} */
    const connectors = [];
    for (const id of wanted) {
      if (objects[id]?.type === "connector") connectors.push(id);
      else for (const c of index.dependents.get(id) ?? []) if (has(c)) connectors.push(c);
    }
    // E: their endpoints.
    for (const c of connectors) {
      wanted.add(c);
      const o = objects[c];
      if (o.from && has(o.from)) wanted.add(o.from);
      if (o.to && has(o.to)) wanted.add(o.to);
    }
    this.stats.closure = wanted.size - before;
    this.stats.wanted = wanted.size;
    return wanted;
  }
}
