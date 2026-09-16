// @ts-check
// The optimistic view of a board's objects, maintained incrementally.
//
// optimistic(id) = server(id) with the pending ops naming id applied in queue order, and a
// connector is hidden when either endpoint is absent from the optimistic view (the server deletes
// connectors with their endpoints, so this is the optimistic cascade).
//
// `objects` is one record, mutated in place. An entry is replaced only when its value changed
// (structurally), so the UI can rely on: `objects[id]` identity changes iff that object changed.
// Recomputing a set of ids costs O(ids + connectors attached to them + pending ops naming them),
// never O(board).

import { deepEqual } from "./equal.js";
import { applyOpToObject } from "./ops.js";

/** @typedef {import("../../shared/protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("./ops.js").PendingOp} PendingOp */

export class OptimisticView {
  constructor() {
    /** @type {Record<string, WhiteboardObject>} */
    this.objects = {};
    /**
     * endpoint id -> connector ids that referenced it at some point (server or pending). May hold
     * stale entries, which only cost an extra recompute; rebuilt on reset.
     * @type {Map<string, Set<string>>}
     */
    this.attached = new Map();
  }

  /** @param {WhiteboardObject|null|undefined} o */
  #register(o) {
    if (!o || o.type !== "connector") return;
    for (const end of [o.from, o.to]) {
      if (!end) continue;
      let set = this.attached.get(end);
      if (!set) this.attached.set(end, (set = new Set()));
      set.add(o.id);
    }
  }

  /**
   * Connector ids currently in the view attached to `id`.
   * @param {string} id
   * @returns {string[]}
   */
  connectorsOf(id) {
    /** @type {string[]} */
    const out = [];
    for (const c of this.attached.get(id) ?? []) {
      const o = this.objects[c];
      if (o && o.type === "connector" && (o.from === id || o.to === id)) out.push(c);
    }
    return out;
  }

  /**
   * Recomputes the given ids (plus connectors attached to them) and returns the ids whose view
   * value changed.
   * @param {Iterable<string>} ids
   * @param {Record<string, WhiteboardObject>} server
   * @param {Map<string, PendingOp[]>} opsById
   * @returns {string[]}
   */
  recompute(ids, server, opsById) {
    /** @type {Set<string>} */
    const work = new Set();
    for (const id of ids) {
      work.add(id);
      for (const c of this.attached.get(id) ?? []) work.add(c);
    }
    /** @type {[string, WhiteboardObject|null][]} */
    const connectors = [];
    /** @type {string[]} */
    const changed = [];
    for (const id of work) {
      const s = server[id] ?? null;
      this.#register(s);
      let o = s;
      const ops = opsById.get(id);
      if (ops) for (const op of ops) o = applyOpToObject(o, op);
      if (o !== s) this.#register(o);
      if (o && o.type === "connector") connectors.push([id, o]);
      else this.#commit(id, o, changed);
    }
    for (const [id, o] of connectors) {
      const ok = o && o.from && o.to && this.objects[o.from] && this.objects[o.to] &&
        this.objects[o.from].type !== "connector" && this.objects[o.to].type !== "connector";
      this.#commit(id, ok ? o : null, changed);
    }
    return changed;
  }

  /**
   * Recomputes everything (snapshot install). Unchanged objects keep their identity.
   * @param {Record<string, WhiteboardObject>} server
   * @param {Map<string, PendingOp[]>} opsById
   * @returns {string[]} changed ids
   */
  reset(server, opsById) {
    this.attached.clear();
    const ids = new Set([...Object.keys(server), ...opsById.keys(), ...Object.keys(this.objects)]);
    return this.recompute(ids, server, opsById);
  }

  /**
   * @param {string} id
   * @param {WhiteboardObject|null} o
   * @param {string[]} changed
   */
  #commit(id, o, changed) {
    const prev = this.objects[id];
    if (!o) {
      if (prev) {
        delete this.objects[id];
        changed.push(id);
      }
      return;
    }
    if (prev === o || (prev && deepEqual(prev, o))) return;
    this.objects[id] = o;
    changed.push(id);
  }
}
