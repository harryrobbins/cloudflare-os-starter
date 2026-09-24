// @ts-check
// Layouts: the force layout (worker, with a time-sliced in-thread fallback for small maps),
// circle and grid, and deterministic placement of elements that have no position yet.
//
// Determinism: placement depends only on ids and the positions already known, so every
// collaborator computes the same spot for a new element. A force layout is run by one person and
// committed as positions (see app.js), never recomputed per client.

import { createForce } from "./force-core.js";

/* global LAYOUT_WORKER_URL */
/** Replaced at build time with the worker bundle as a data: URL (scripts/build.mjs). */
// @ts-ignore defined by esbuild
const WORKER_URL = typeof LAYOUT_WORKER_URL !== "undefined" ? LAYOUT_WORKER_URL : null;

/** Largest map the in-thread fallback will lay out (the UI thread must stay responsive). */
export const FALLBACK_MAX_NODES = 3000;
export const WORKER_START_TIMEOUT_MS = 3000;

/** @param {string} s */
export function hashOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * @param {{x: Float64Array, y: Float64Array, pinned: Uint8Array, from: Uint32Array, to: Uint32Array,
 *   maxTicks?: number, onTick: (x: Float64Array, y: Float64Array, progress: number) => void,
 *   onDone: (result: {error?: string, stopped?: boolean}) => void}} args
 * @returns {{stop: () => void, mode: () => string}}
 */
export function runForceLayout(args) {
  const n = args.x.length;
  const maxTicks = args.maxTicks ?? (n > 5000 ? 200 : 300);
  const batch = n > 5000 ? 1 : n > 1000 ? 3 : 10;
  let mode = "worker";
  let stopped = false;
  /** @type {Worker|null} */
  let worker = null;
  let started = false;
  /** @type {any} */
  let startTimer = null;
  let rafId = 0;

  const fallback = (/** @type {string} */ why) => {
    if (stopped) return;
    try { worker?.terminate(); } catch { /* ignore */ }
    worker = null;
    if (n > FALLBACK_MAX_NODES) {
      args.onDone({ error: `The layout worker is unavailable (${why}), and this map is too large to lay out on the page. Use Circle or Grid.` });
      return;
    }
    mode = "in-thread";
    const force = createForce(args);
    let ticks = 0;
    const frame = () => {
      if (stopped) return;
      const t0 = performance.now();
      let alpha = 1;
      while (performance.now() - t0 < 12 && ticks < maxTicks) { alpha = force.step(1); ticks++; }
      args.onTick(args.x, args.y, ticks / maxTicks);
      if (alpha < force.alphaMin() || ticks >= maxTicks) { args.onDone({}); return; }
      rafId = requestAnimationFrame(frame);
    };
    rafId = requestAnimationFrame(frame);
  };

  if (!WORKER_URL || typeof Worker === "undefined") fallback("no worker support");
  else {
    try {
      worker = new Worker(WORKER_URL, { type: "module" });
      worker.onmessage = (e) => {
        if (stopped) return;
        started = true;
        if (startTimer) { clearTimeout(startTimer); startTimer = null; }
        const m = e.data;
        if (m.type !== "tick") return;
        args.x.set(m.x); args.y.set(m.y);
        args.onTick(args.x, args.y, m.ticks / maxTicks);
        if (m.done) { worker?.terminate(); worker = null; args.onDone({}); }
      };
      // A worker failure is asynchronous: onerror fires, the constructor does not throw.
      worker.onerror = (e) => { if (!started) fallback(e.message || "worker error"); else args.onDone({ error: "The layout worker failed" }); };
      worker.postMessage({ type: "start", x: args.x, y: args.y, pinned: args.pinned, from: args.from, to: args.to, maxTicks, batch });
      startTimer = setTimeout(() => { if (!started) fallback("no response"); }, WORKER_START_TIMEOUT_MS);
    } catch (e) {
      fallback(String(/** @type {any} */ (e)?.message ?? e));
    }
  }
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (startTimer) clearTimeout(startTimer);
      if (rafId) cancelAnimationFrame(rafId);
      try { worker?.postMessage({ type: "stop" }); worker?.terminate(); } catch { /* ignore */ }
      args.onDone({ stopped: true });
    },
    mode: () => mode,
  };
}

/**
 * Evenly on a circle, in the given order (callers sort, e.g. by type then label).
 * @param {string[]} ids
 * @returns {Map<string, {x: number, y: number}>}
 */
export function circleLayout(ids) {
  const r = Math.max(120, (ids.length * 28) / (2 * Math.PI));
  const out = new Map();
  ids.forEach((id, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, ids.length) - Math.PI / 2;
    out.set(id, { x: Math.round(r * Math.cos(a)), y: Math.round(r * Math.sin(a)) });
  });
  return out;
}

/**
 * A square-ish grid, row by row, in the given order.
 * @param {string[]} ids @param {number} [gap]
 * @returns {Map<string, {x: number, y: number}>}
 */
export function gridLayout(ids, gap = 80) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
  const out = new Map();
  const off = ((cols - 1) * gap) / 2;
  ids.forEach((id, i) => out.set(id, { x: (i % cols) * gap - off, y: Math.floor(i / cols) * gap - off }));
  return out;
}

/**
 * Deterministic spots for elements without a position: next to the centroid of their positioned
 * neighbours when they have some, else on a golden-angle spiral around the centre of what is
 * placed. Stable for a given state, so collaborators agree.
 * @param {string[]} missing
 * @param {(id: string) => {x: number, y: number}|undefined} known
 * @param {(id: string) => string[]} neighbours
 * @returns {Map<string, {x: number, y: number}>}
 */
export function placeNew(missing, known, neighbours) {
  const out = new Map();
  if (!missing.length) return out;
  const sorted = [...missing].sort();
  // The centre and spread of what is already placed.
  let cx = 0, cy = 0, count = 0, maxR = 0;
  const seen = new Set(sorted);
  const probe = (/** @type {string} */ id) => known(id);
  for (const id of sorted) {
    for (const nb of neighbours(id)) {
      if (seen.has(nb)) continue;
      const p = probe(nb);
      if (p) { cx += p.x; cy += p.y; count++; }
    }
  }
  if (count) { cx /= count; cy /= count; }
  let spiral = 0;
  for (const id of sorted) {
    const placed = neighbours(id).map((nb) => out.get(nb) ?? (seen.has(nb) ? undefined : known(nb))).filter(Boolean);
    const h = hashOf(id);
    if (placed.length) {
      const mx = placed.reduce((a, p) => a + /** @type {any} */ (p).x, 0) / placed.length;
      const my = placed.reduce((a, p) => a + /** @type {any} */ (p).y, 0) / placed.length;
      const a = ((h % 360) * Math.PI) / 180;
      const r = 50 + (h % 40);
      out.set(id, { x: Math.round(mx + r * Math.cos(a)), y: Math.round(my + r * Math.sin(a)) });
    } else {
      const k = spiral++;
      const a = k * 2.399963;
      const r = 40 * Math.sqrt(k + 1) + maxR;
      out.set(id, { x: Math.round(cx + r * Math.cos(a)), y: Math.round(cy + r * Math.sin(a)) });
    }
  }
  return out;
}
