// @ts-check
// Runs the real canvas controller (createCanvas) over the fake DOM and a minimal in-memory store,
// for counting rendered SVG object groups under viewport culling. Used by test/client/culling.test.js,
// test/performance/model.test.js and scripts/benchmark.mjs.

import { installFakeDom } from "./fake-dom.js";
import { createCanvas } from "../../src/client/ui/canvas/index.js";

/**
 * A store with the surface the canvas uses. `emit` delivers a change to subscribers; mutations
 * through the store API apply to the board directly and emit an "objects" change.
 * @param {Record<string, any>} objects
 */
export function fakeStore(objects) {
  /** @type {Set<Function>} */
  const listeners = new Set();
  const state = { board: { objects, background: "dots", title: "", revision: 1 }, peers: new Map(), history: [], connection: "live" };
  const presence = { calls: 0, last: /** @type {any} */ (null) };
  /** @param {any} change */
  const emit = (change) => { for (const l of [...listeners]) l(state, change); };
  return {
    state, presence, emit,
    getState: () => state,
    /** @param {Function} fn */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** @param {any} p */
    setPresence(p) { presence.calls++; presence.last = { ...presence.last, ...p }; },
    flushPresence() {},
    /** @param {{id: string, patch: any}[]} updates */
    updateObjects(updates) {
      for (const { id, patch } of updates) if (state.board.objects[id]) Object.assign(state.board.objects[id], patch, { version: state.board.objects[id].version + 1 });
      emit({ kind: "objects", objects: updates.map((u) => u.id) });
    },
    /** @param {string[]} ids */
    deleteObjects(ids) {
      for (const id of ids) delete state.board.objects[id];
      emit({ kind: "objects", objects: ids });
    },
    createObjects() { return []; },
    undo() {}, redo() {}, reorder() {},
  };
}

/**
 * @param {Record<string, any>} objects
 * @param {{width?: number, height?: number, camera?: {x: number, y: number, zoom: number}, cull?: any, exportMode?: boolean}} [opts]
 */
export function canvasRig(objects, { width = 1000, height = 800, camera = { x: 0, y: 0, zoom: 1 }, cull, exportMode = false } = {}) {
  const dom = installFakeDom();
  const store = fakeStore(objects);
  const canvas = createCanvas(/** @type {any} */ (store), /** @type {any} */ ({ cull, exportMode, announce: () => {} }));
  const el = /** @type {any} */ (canvas.element);
  el.clientWidth = width;
  el.clientHeight = height;
  dom.document.body.appendChild(el);
  if (!exportMode) {
    canvas.setCamera(camera);
    dom.flushFrames();
  }
  /** Ids with an object element in the DOM. */
  const renderedIds = () => {
    /** @type {Set<string>} */
    const ids = new Set();
    const walk = (/** @type {any} */ n) => {
      const oid = n.getAttribute?.("data-oid");
      if (oid) ids.add(oid);
      for (const c of n.childNodes) walk(c);
    };
    walk(el);
    return ids;
  };
  return {
    canvas, store, dom, el,
    renderedIds,
    /** Object groups (<g class="wb-obj">) in the DOM. */
    groups: () => el.count((/** @type {any} */ n) => n.getAttribute?.("class")?.split(" ").includes("wb-obj")),
    /** All elements under the canvas. */
    nodes: () => el.size,
    /** @param {{x: number, y: number, zoom: number}} cam */
    setCamera(cam) { canvas.setCamera(cam); dom.flushFrames(); },
    flush: () => dom.flushFrames(),
    destroy() { canvas.destroy(); dom.restore(); },
  };
}
