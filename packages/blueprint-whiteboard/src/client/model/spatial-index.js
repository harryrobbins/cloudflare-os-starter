// @ts-check
// A client spatial index of every object's effective world bounds: a fixed grid of square cells,
// kept up to date incrementally from store changes. Used for hit testing, marquee candidates and
// alignment candidates, and exported for viewport render selection (culling) and the minimap.
//
// Effective bounds are a SUPERSET of everything that draws or hits for an object, so a query is a
// candidate filter; callers still run their exact test (hitObject, marquee rules) on the result:
//   sticky/rect/ellipse/text  rotated (axis-aligned) bounds
//   pen                       its box (normalised strokes already pad the box by half the width)
//   frame                     its box plus the name strip above it
//   connector                 its route's bounds (exact for curves), padded for the stroke and
//                             arrowheads, plus the label box; recomputed whenever either endpoint
//                             changes. A connector whose endpoint is missing has no bounds and is
//                             not indexed.
//
// Obstacle-aware elbow routes (src/shared/connectors.js): an automatic elbow connector's route also
// depends on the obstacles in its route region (the ends' boxes grown by REGION_MARGIN). The index
// keeps those regions in a second grid, so when an obstacle-type object is created, moved, resized
// or deleted, exactly the automatic elbows whose region meets its old or new bounds are re-routed
// and re-indexed (update() returns them, so the canvas re-renders them too). Routes are memoised
// per connector (`routeMemo`, shared with the canvas renderer) under a signature of everything
// they depend on, so the renderer reuses the route the index just computed.
//
// Objects spanning more than LARGE_CELLS cells are kept in a short "large" list that every query
// checks, so one huge frame never costs thousands of cell entries.
//
// Debug/test mode (`debug: true`, or `globalThis.__wbSpatialDebug = true` when the canvas creates
// its index) checks every query against a brute-force scan and counts mismatches in `stats`.
// Nothing about the board (ids, coordinates, text) is ever logged.

import {
  rotatedBounds, connectorRoute, textWidth, rectsIntersect, LINE_HEIGHT,
} from "../../shared/geometry.js";
import { routeBounds, routeMidpoint, routeRegion, forgetRoute, OBSTACLE_TYPES, segmentsOf } from "../../shared/connectors.js";

/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */
/** @typedef {{x: number, y: number}} Point */

/** World units per grid cell. A default sticky note (200) fits in one or four cells. */
export const CELL_SIZE = 256;
/** Objects covering more cells than this go to the "large" list instead. */
export const LARGE_CELLS = 64;

const OFFSET = 1 << 20;
const STRIDE = 1 << 21;

/**
 * Read-only query surface of the index (what the canvas controller exposes to the shell).
 * @typedef {object} SpatialQuery
 * @property {(rect: Rect) => string[]} query      ids whose effective bounds intersect `rect`
 * @property {(p: Point, pad?: number) => string[]} queryPoint  ids whose bounds are within `pad` of `p`
 * @property {(id: string) => Rect|null} bounds     indexed effective bounds of an object
 * @property {number} size                          indexed objects
 */

/** @typedef {import("../../shared/connectors.js").RouteEnv} RouteEnv */

/**
 * Whether a connector's route depends on obstacles (an automatic elbow).
 * @param {WhiteboardObject} o
 */
export function routesAroundObstacles(o) {
  return o.type === "connector" && o.routing === "elbow" && segmentsOf(o.segments).length === 0;
}

/**
 * Effective world bounds of `o` (see the top of this file), or null when it has none (a connector
 * with a missing endpoint). `resolve` looks up connector endpoints; `env` gives obstacles for
 * automatic elbow routes.
 * @param {WhiteboardObject} o
 * @param {(id: string) => WhiteboardObject|undefined} resolve
 * @param {RouteEnv} [env]
 * @returns {Rect|null}
 */
export function effectiveBounds(o, resolve, env) {
  if (o.type === "connector") {
    const from = o.from ? resolve(o.from) : undefined;
    const to = o.to ? resolve(o.to) : undefined;
    if (!from || !to) return null;
    const route = connectorRoute(o, from, to, env);
    const b = routeBounds(route);
    const width = Math.max(0.5, o.style?.strokeWidth || 2);
    const pad = Math.max(12, width + 10) / 2 + width * 3;
    let r = { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
    if (o.text) {
      const mid = routeMidpoint(route);
      const fontSize = o.style.fontSize;
      const lw = textWidth(o.text, fontSize) + fontSize, lh = fontSize * 1.5;
      r = union(r, { x: mid.x - lw / 2, y: mid.y - lh / 2, w: lw, h: lh });
    }
    return finite(r);
  }
  if (o.type === "frame") {
    const top = o.style.fontSize * LINE_HEIGHT + 4;
    return finite({ x: o.x, y: o.y - top, w: o.w, h: o.h + top });
  }
  return finite(rotatedBounds(o));
}

/** @param {Rect} a @param {Rect} b @returns {Rect} */
function union(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** @param {Rect} r @returns {Rect|null} */
function finite(r) {
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h) ? r : null;
}

export class SpatialIndex {
  /**
   * @param {{cellSize?: number, largeCells?: number, debug?: boolean}} [opts]
   */
  constructor({ cellSize = CELL_SIZE, largeCells = LARGE_CELLS, debug = false } = {}) {
    this.cellSize = cellSize;
    this.largeCells = largeCells;
    this.debug = debug;
    /** The record the index was last fed (the store mutates it in place). @type {Record<string, WhiteboardObject>} */
    this.objects = {};
    /** @type {Map<string, Rect>} */
    this.rects = new Map();
    /** cell key -> ids @type {Map<number, Set<string>>} */
    this.cells = new Map();
    /** id -> cell keys it is in (empty array: in the large list) @type {Map<string, number[]>} */
    this.cellsOf = new Map();
    /** @type {Set<string>} */
    this.large = new Set();
    /** endpoint id -> connectors naming it (indexed or not) @type {Map<string, Set<string>>} */
    this.dependents = new Map();
    /** connector id -> the endpoints registered for it @type {Map<string, string[]>} */
    this.endsOf = new Map();
    /** Automatic elbow connector id -> its route region, in a grid of their own. */
    this.regions = new RegionGrid(cellSize, largeCells);
    /** Ids indexed as obstacle types (their indexed rect is their rotated bounds). @type {Set<string>} */
    this.obstacleIds = new Set();
    /** Memoised automatic elbow routes (see connectors.js RouteEnv), shared with the renderer. */
    this.routeMemo = new Map();
    /** Algorithmic counters for benchmarks and tests (never content). `rerouted`: connectors
     * re-indexed because an obstacle in their route region changed. */
    this.stats = { queries: 0, scanned: 0, updates: 0, resets: 0, mismatches: 0, connectorIndexes: 0, rerouted: 0 };
    this.#env = { memo: this.routeMemo, candidates: (region) => this.#rawQuery(region).map(this.#resolve) };
  }

  get size() {
    return this.rects.size;
  }

  /** @param {string} id */
  #resolve = (id) => (Object.hasOwn(this.objects, id) ? this.objects[id] : undefined);

  /** Obstacles for the index's own routes: committed objects from the grid (set in the constructor). @type {RouteEnv} */
  #env = { candidates: () => [] };

  /**
   * Brute-force obstacles (bruteForce, verify): every object, with a memo of its own (safe: an
   * entry is only reused when every input of the route is the same). @type {RouteEnv}
   */
  #bruteEnv = { candidates: () => Object.values(this.objects), memo: new Map() };

  /**
   * A RouteEnv over the index for the renderer: candidates from the grid (plus `extra` ids, e.g.
   * objects being dragged), looked up with `resolve` (which may apply in-progress geometry), and
   * the shared route memo.
   * @param {(id: string) => WhiteboardObject|undefined} resolve
   * @param {() => Iterable<string>} [extra]
   * @returns {RouteEnv}
   */
  routeEnv(resolve, extra) {
    return {
      memo: this.routeMemo,
      candidates: (region) => {
        const ids = this.#rawQuery(region);
        if (extra) for (const id of extra()) ids.push(id);
        return ids.map(resolve);
      },
    };
  }

  /**
   * Rebuilds from scratch (initial load, snapshot replacement).
   * @param {Record<string, WhiteboardObject>} objects
   */
  reset(objects) {
    this.objects = objects;
    this.rects.clear();
    this.cells.clear();
    this.cellsOf.clear();
    this.large.clear();
    this.dependents.clear();
    this.endsOf.clear();
    this.regions.clear();
    this.obstacleIds.clear();
    this.routeMemo.clear();
    this.stats.resets++;
    // Endpoints first so connectors resolve regardless of key order.
    for (const id in objects) if (objects[id].type !== "connector") this.#index(id);
    for (const id in objects) if (objects[id].type === "connector") this.#index(id);
  }

  /**
   * Re-indexes `ids` (created, changed or deleted in `objects`) and every connector attached to
   * them. Returns the ids actually re-indexed.
   * @param {Iterable<string>} ids
   * @param {Record<string, WhiteboardObject>} [objects]
   * @returns {Set<string>}
   */
  update(ids, objects = this.objects) {
    this.objects = objects;
    this.stats.updates++;
    /** @type {Set<string>} */
    const done = new Set();
    /** @type {string[]} */
    const connectors = [];
    for (const id of ids) {
      if (done.has(id)) continue;
      done.add(id);
      const o = this.#resolve(id);
      if (o?.type === "connector" || this.endsOf.has(id)) { connectors.push(id); continue; }
      const before = this.obstacleIds.has(id) ? this.rects.get(id) : undefined;
      this.#index(id);
      const after = this.obstacleIds.has(id) ? this.rects.get(id) : undefined;
      for (const c of this.dependents.get(id) ?? []) if (!done.has(c)) { done.add(c); connectors.push(c); }
      // Automatic elbows whose route region meets the obstacle's old or new bounds.
      for (const r of [before, after]) {
        if (!r) continue;
        for (const c of this.regions.query(r)) {
          if (done.has(c)) continue;
          done.add(c);
          connectors.push(c);
          this.stats.rerouted++;
        }
      }
    }
    // Connectors after their endpoints, so their routes use the new geometry.
    for (const c of connectors) this.#index(c);
    return done;
  }

  /**
   * Ids whose effective bounds intersect `rect` (edges touching count), each once.
   * @param {Rect} rect
   * @returns {string[]}
   */
  query(rect) {
    this.stats.queries++;
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {string[]} */
    const out = [];
    const consider = (/** @type {string} */ id) => {
      if (seen.has(id)) return;
      seen.add(id);
      this.stats.scanned++;
      const r = this.rects.get(id);
      if (r && rectsIntersect(r, rect)) out.push(id);
    };
    for (const id of this.large) consider(id);
    const span = this.#span(rect);
    if (span) {
      const cells = (span.x1 - span.x0 + 1) * (span.y1 - span.y0 + 1);
      if (cells > this.cells.size) {
        // A query wider than the populated grid: walk the populated cells instead.
        for (const [key, set] of this.cells) {
          const cx = Math.floor(key / STRIDE) - OFFSET, cy = (key % STRIDE) - OFFSET;
          if (cx < span.x0 || cx > span.x1 || cy < span.y0 || cy > span.y1) continue;
          for (const id of set) consider(id);
        }
      } else {
        for (let cx = span.x0; cx <= span.x1; cx++) {
          for (let cy = span.y0; cy <= span.y1; cy++) {
            const set = this.cells.get(cellKey(cx, cy));
            if (set) for (const id of set) consider(id);
          }
        }
      }
    }
    if (this.debug) this.#check(rect, out);
    return out;
  }

  /**
   * Ids whose effective bounds come within `pad` of point `p`.
   * @param {Point} p @param {number} [pad]
   */
  queryPoint(p, pad = 0) {
    return this.query({ x: p.x - pad, y: p.y - pad, w: 2 * pad, h: 2 * pad });
  }

  /** @param {string} id @returns {Rect|null} */
  bounds(id) {
    return this.rects.get(id) ?? null;
  }

  /**
   * The brute-force answer to query(rect): recomputes every object's bounds from `objects`.
   * @param {Rect} rect
   * @returns {string[]}
   */
  bruteForce(rect) {
    const out = [];
    for (const id in this.objects) {
      const b = effectiveBounds(this.objects[id], this.#resolve, this.#bruteEnv);
      if (b && rectsIntersect(b, rect)) out.push(id);
    }
    return out;
  }

  /**
   * Full consistency check against the current objects: ids missing from the index, indexed ids
   * that should not be, and ids whose indexed bounds are stale. Empty lists mean consistent.
   * @returns {{missing: string[], extra: string[], stale: string[]}}
   */
  verify() {
    const missing = [], extra = [], stale = [];
    for (const id in this.objects) {
      const b = effectiveBounds(this.objects[id], this.#resolve, this.#bruteEnv);
      const r = this.rects.get(id);
      if (b && !r) missing.push(id);
      else if (!b && r) extra.push(id);
      else if (b && r && (b.x !== r.x || b.y !== r.y || b.w !== r.w || b.h !== r.h)) stale.push(id);
    }
    for (const id of this.rects.keys()) if (!Object.hasOwn(this.objects, id)) extra.push(id);
    return { missing, extra, stale };
  }

  /** @param {Rect} rect @param {string[]} got */
  #check(rect, got) {
    const want = this.bruteForce(rect);
    const a = new Set(got);
    if (want.length !== got.length || want.some((id) => !a.has(id))) {
      this.stats.mismatches++;
      console.warn("whiteboard: spatial index query differed from a brute-force scan");
    }
  }

  /** (Re)indexes one id from this.objects. @param {string} id */
  #index(id) {
    this.#remove(id);
    const o = this.#resolve(id);
    if (!o) return;
    if (o.type === "connector") {
      const ends = [o.from, o.to].filter((e) => typeof e === "string" && e);
      this.endsOf.set(id, /** @type {string[]} */ (ends));
      for (const e of /** @type {string[]} */ (ends)) {
        let set = this.dependents.get(e);
        if (!set) this.dependents.set(e, (set = new Set()));
        set.add(id);
      }
    }
    let b;
    if (o.type === "connector") {
      this.stats.connectorIndexes++;
      b = effectiveBounds(o, this.#resolve, this.#env);
      const from = o.from ? this.#resolve(o.from) : undefined, to = o.to ? this.#resolve(o.to) : undefined;
      if (from && to && routesAroundObstacles(o)) this.regions.set(id, routeRegion(from, to));
    } else {
      b = effectiveBounds(o, this.#resolve);
      if (OBSTACLE_TYPES.has(o.type)) this.obstacleIds.add(id);
    }
    if (!b) return;
    this.rects.set(id, b);
    const span = this.#span(b);
    if (!span || (span.x1 - span.x0 + 1) * (span.y1 - span.y0 + 1) > this.largeCells) {
      this.large.add(id);
      this.cellsOf.set(id, []);
      return;
    }
    /** @type {number[]} */
    const keys = [];
    for (let cx = span.x0; cx <= span.x1; cx++) {
      for (let cy = span.y0; cy <= span.y1; cy++) {
        const key = cellKey(cx, cy);
        let set = this.cells.get(key);
        if (!set) this.cells.set(key, (set = new Set()));
        set.add(id);
        keys.push(key);
      }
    }
    this.cellsOf.set(id, keys);
  }

  /** @param {string} id */
  #remove(id) {
    const keys = this.cellsOf.get(id);
    if (keys) {
      for (const key of keys) {
        const set = this.cells.get(key);
        if (!set) continue;
        set.delete(id);
        if (!set.size) this.cells.delete(key);
      }
      this.cellsOf.delete(id);
    }
    this.large.delete(id);
    this.rects.delete(id);
    this.obstacleIds.delete(id);
    this.regions.delete(id);
    if (!Object.hasOwn(this.objects, id)) forgetRoute(this.routeMemo, id);
    const ends = this.endsOf.get(id);
    if (ends) {
      for (const e of ends) {
        const set = this.dependents.get(e);
        if (!set) continue;
        set.delete(id);
        if (!set.size) this.dependents.delete(e);
      }
      this.endsOf.delete(id);
    }
  }

  /**
   * Ids whose indexed bounds meet `rect`, without counters or debug checks (route obstacles).
   * @param {Rect} rect
   * @returns {string[]}
   */
  #rawQuery(rect) {
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {string[]} */
    const out = [];
    const consider = (/** @type {string} */ id) => {
      if (seen.has(id)) return;
      seen.add(id);
      if (!this.obstacleIds.has(id)) return; // routes only care about obstacle types
      const r = this.rects.get(id);
      if (r && rectsIntersect(r, rect)) out.push(id);
    };
    for (const id of this.large) consider(id);
    const span = this.#span(rect);
    if (!span) return out;
    if ((span.x1 - span.x0 + 1) * (span.y1 - span.y0 + 1) > this.cells.size) {
      for (const [key, set] of this.cells) {
        const cx = Math.floor(key / STRIDE) - OFFSET, cy = (key % STRIDE) - OFFSET;
        if (cx < span.x0 || cx > span.x1 || cy < span.y0 || cy > span.y1) continue;
        for (const id of set) consider(id);
      }
    } else {
      for (let cx = span.x0; cx <= span.x1; cx++) {
        for (let cy = span.y0; cy <= span.y1; cy++) {
          const set = this.cells.get(cellKey(cx, cy));
          if (set) for (const id of set) consider(id);
        }
      }
    }
    return out;
  }

  /** Cell range covered by a rect, or null when it is outside the grid's range. @param {Rect} r */
  #span(r) {
    const s = this.cellSize;
    const x0 = Math.floor(r.x / s), y0 = Math.floor(r.y / s);
    const x1 = Math.floor((r.x + r.w) / s), y1 = Math.floor((r.y + r.h) / s);
    if (![x0, y0, x1, y1].every((v) => Number.isFinite(v) && Math.abs(v) < OFFSET)) return null;
    return { x0, y0, x1, y1 };
  }
}

/** @param {number} cx @param {number} cy */
function cellKey(cx, cy) {
  return (cx + OFFSET) * STRIDE + (cy + OFFSET);
}

/**
 * A plain grid of id -> rect (the automatic elbows' route regions), with rect queries.
 */
export class RegionGrid {
  /** @param {number} cellSize @param {number} largeCells */
  constructor(cellSize, largeCells) {
    this.cellSize = cellSize;
    this.largeCells = largeCells;
    /** @type {Map<string, Rect>} */
    this.rects = new Map();
    /** @type {Map<number, Set<string>>} */
    this.cells = new Map();
    /** @type {Map<string, number[]>} */
    this.keysOf = new Map();
    /** @type {Set<string>} */
    this.large = new Set();
  }

  get size() { return this.rects.size; }

  clear() {
    this.rects.clear(); this.cells.clear(); this.keysOf.clear(); this.large.clear();
  }

  /** @param {string} id @param {Rect} r */
  set(id, r) {
    this.delete(id);
    if (![r.x, r.y, r.w, r.h].every(Number.isFinite)) return;
    this.rects.set(id, r);
    const s = this.cellSize;
    const x0 = Math.floor(r.x / s), y0 = Math.floor(r.y / s), x1 = Math.floor((r.x + r.w) / s), y1 = Math.floor((r.y + r.h) / s);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.largeCells || Math.max(Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1)) >= OFFSET) {
      this.large.add(id);
      this.keysOf.set(id, []);
      return;
    }
    /** @type {number[]} */
    const keys = [];
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const key = cellKey(cx, cy);
      let set = this.cells.get(key);
      if (!set) this.cells.set(key, (set = new Set()));
      set.add(id);
      keys.push(key);
    }
    this.keysOf.set(id, keys);
  }

  /** @param {string} id */
  delete(id) {
    const keys = this.keysOf.get(id);
    if (!keys) return;
    for (const key of keys) {
      const set = this.cells.get(key);
      if (!set) continue;
      set.delete(id);
      if (!set.size) this.cells.delete(key);
    }
    this.keysOf.delete(id);
    this.large.delete(id);
    this.rects.delete(id);
  }

  /**
   * Ids whose rect meets `r`.
   * @param {Rect} r
   * @returns {string[]}
   */
  query(r) {
    /** @type {Set<string>} */
    const seen = new Set();
    const out = [];
    const consider = (/** @type {string} */ id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const rr = this.rects.get(id);
      if (rr && rectsIntersect(rr, r)) out.push(id);
    };
    for (const id of this.large) consider(id);
    const s = this.cellSize;
    const x0 = Math.floor(r.x / s), y0 = Math.floor(r.y / s), x1 = Math.floor((r.x + r.w) / s), y1 = Math.floor((r.y + r.h) / s);
    if (![x0, y0, x1, y1].every(Number.isFinite)) return out;
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size) {
      for (const set of this.cells.values()) for (const id of set) consider(id);
    } else {
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (const id of this.cells.get(cellKey(cx, cy)) ?? []) consider(id);
    }
    return out;
  }
}

/**
 * Keeps `index` in step with one store change (call it before anything reads the index):
 * snapshots rebuild, object changes re-index their ids (creates, updates, deletes, rebases,
 * rollbacks, undo and redo all arrive as "objects" changes).
 * @param {SpatialIndex} index
 * @param {{board: {objects: Record<string, WhiteboardObject>}}} state
 * @param {{kind: string, objects?: string[]}} change
 * @returns {Set<string>|null} the ids re-indexed by an incremental update (the changed ids, the
 *   connectors attached to them and automatic elbows re-routed around them); null otherwise
 */
export function applyStoreChange(index, state, change) {
  if (change.kind === "snapshot" || (change.kind === "objects" && !change.objects)) {
    index.reset(state.board.objects);
  } else if (change.kind === "objects" && change.objects) {
    return index.update(change.objects, state.board.objects);
  }
  return null;
}
