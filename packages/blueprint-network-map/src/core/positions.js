// @ts-check
// Element positions per layout. A layout key is "shared" (every view without its own layout) or a
// view id (a view with layout.own). Positions live apart from elements, so a move never bumps an
// element's version, and each position carries its own version `v` for layout-job fencing.
//
// Storage: each element hashes to one of BUCKETS buckets; a bucket's positions for one layout are
// stored under "p:<layout>:<n>" as columns {ids, x, y, pin, v}. A drag rewrites one bucket; a
// layout commit rewrites at most BUCKETS. At the element limit a bucket holds ~700 entries
// (~35 KB), well under the per-value cap; commits still check each bucket's bytes.

import { LIMITS, storedBytes } from "../shared/protocol.js";

export const BUCKETS = 16;

/** @param {string} id @returns {number} */
export function bucketOf(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % BUCKETS;
}

/**
 * @typedef {{x: number, y: number, pin: boolean, v: number}} Position
 */

export class PositionStore {
  constructor() {
    /** @type {Map<string, Map<string, Position>>} layout key -> element id -> position */
    this.layouts = new Map();
    /** @type {Map<string, number>} bucket key -> storedBytes of its last written value */
    this.bucketBytes = new Map();
    this.bytes = 0;
  }

  /** @param {Record<string, any>} stored bucket key -> bucket */
  static fromBuckets(stored) {
    const s = new PositionStore();
    for (const [key, bucket] of Object.entries(stored ?? {})) {
      const layout = key.slice(0, key.lastIndexOf(":"));
      if (!bucket || !Array.isArray(bucket.ids)) continue;
      let map = s.layouts.get(layout);
      if (!map) s.layouts.set(layout, (map = new Map()));
      for (let i = 0; i < bucket.ids.length; i++) {
        const x = bucket.x?.[i], y = bucket.y?.[i];
        if (typeof x !== "number" || typeof y !== "number") continue;
        map.set(bucket.ids[i], { x, y, pin: bucket.pin?.[i] === "1", v: Number(bucket.v?.[i]) || 1 });
      }
      const size = storedBytes(bucket);
      s.bucketBytes.set(key, size);
      s.bytes += size;
    }
    return s;
  }

  /** @param {string} layout @param {string} id @returns {Position|undefined} */
  get(layout, id) {
    return this.layouts.get(layout)?.get(id);
  }

  /** @param {string} layout @param {string} id @param {Position|null} pos */
  set(layout, id, pos) {
    let map = this.layouts.get(layout);
    if (!pos) {
      map?.delete(id);
      return;
    }
    if (!map) this.layouts.set(layout, (map = new Map()));
    map.set(id, pos);
  }

  /**
   * The stored value of one bucket, or null when empty.
   * @param {string} layout @param {number} n
   */
  bucketValue(layout, n) {
    const map = this.layouts.get(layout);
    if (!map) return null;
    /** @type {{ids: string[], x: number[], y: number[], pin: string, v: number[]}} */
    const b = { ids: [], x: [], y: [], pin: "", v: [] };
    for (const [id, p] of map) {
      if (bucketOf(id) !== n) continue;
      b.ids.push(id); b.x.push(p.x); b.y.push(p.y); b.pin += p.pin ? "1" : "0"; b.v.push(p.v);
    }
    return b.ids.length ? b : null;
  }

  /**
   * Values for the buckets touched by `changes` (layout key -> element ids), with the byte total
   * after writing them. Throws when a bucket exceeds LIMITS.valueBytes.
   * @param {Map<string, Set<string>>} changes
   * @returns {{buckets: Record<string, any|null>, bytes: number, sizes: Map<string, number>}}
   */
  bucketsFor(changes) {
    /** @type {Record<string, any|null>} */
    const buckets = {};
    const sizes = new Map();
    let bytes = this.bytes;
    for (const [layout, ids] of changes) {
      const touched = new Set([...ids].map(bucketOf));
      for (const n of touched) {
        const key = `${layout}:${n}`;
        const value = this.bucketValue(layout, n);
        const size = value ? storedBytes(value) : 0;
        if (size > LIMITS.valueBytes) throw new Error(`Position bucket ${key} would exceed ${LIMITS.valueBytes} bytes`);
        bytes += size - (this.bucketBytes.get(key) ?? 0);
        buckets[key] = value;
        sizes.set(key, size);
      }
    }
    return { buckets, bytes, sizes };
  }

  /** Records the sizes of buckets just written. @param {Map<string, number>} sizes */
  applySizes(sizes) {
    for (const [key, size] of sizes) {
      this.bytes += size - (this.bucketBytes.get(key) ?? 0);
      if (size) this.bucketBytes.set(key, size);
      else this.bucketBytes.delete(key);
    }
  }

  /** Every layout key that has positions. */
  keys() {
    return [...this.layouts.keys()];
  }

  /**
   * A layout's positions as columns (for snapshots). Copies, so later moves do not change it.
   * @param {string} layout
   */
  columns(layout) {
    const map = this.layouts.get(layout);
    /** @type {{layout: string, ids: string[], x: number[], y: number[], pin: string, v: number[]}} */
    const out = { layout, ids: [], x: [], y: [], pin: "", v: [] };
    if (!map) return out;
    for (const [id, p] of map) {
      out.ids.push(id); out.x.push(p.x); out.y.push(p.y); out.pin += p.pin ? "1" : "0"; out.v.push(p.v);
    }
    return out;
  }
}
