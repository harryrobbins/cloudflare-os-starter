// @ts-check
// Measurements shared by the CI proxy tests (model.test.js: counts, bytes, scans; never timings)
// and the benchmark (scripts/benchmark.mjs: the same plus wall-clock timings). Every result is a
// number or a count: no ids, text, names or coordinates from the board.

import { buildFixture, prng } from "./fixtures.js";
import { canvasRig } from "./canvas-rig.js";
import { simulatePresence } from "./presence-sim.js";
import { createWhiteboard } from "../../src/core/whiteboard.js";
import { sortedObjects } from "../../src/shared/protocol.js";
import { SpatialIndex } from "../../src/client/model/spatial-index.js";
import { topObjectAt, stackOrder, HIT_TOLERANCE_PX } from "../../src/client/ui/canvas/model.js";
import { fitRect } from "../../src/client/ui/canvas/camera.js";

export const VIEW = { w: 1400, h: 900 };

/**
 * Runs `fn` `runs` times (after one warm-up) and returns median and p95 milliseconds.
 * @param {() => any} fn @param {number} [runs]
 */
export async function time(fn, runs = 7) {
  await fn();
  const ms = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  return { median: r3(ms[Math.floor(ms.length / 2)]), p95: r3(ms[Math.min(ms.length - 1, Math.ceil(ms.length * 0.95) - 1)]) };
}

/** @param {number} v */
export function r3(v) {
  return Math.round(v * 1000) / 1000;
}

/**
 * Snapshot size and (de)serialisation.
 * @param {any} snapshot @param {{timings?: boolean}} [opts]
 */
export async function snapshotMetrics(snapshot, { timings = false } = {}) {
  const json = JSON.stringify(snapshot);
  const out = /** @type {Record<string, any>} */ ({ bytes: Buffer.byteLength(json, "utf8"), objects: Object.keys(snapshot.objects).length });
  if (timings) {
    out.stringifyMs = await time(() => JSON.stringify(snapshot));
    out.parseMs = await time(() => JSON.parse(json));
    out.structuredCloneMs = await time(() => structuredClone(snapshot));
  }
  return out;
}

/**
 * Durable Object load proxy: a fresh core over the stored board (cold: loads and rebuilds its
 * indexes), then a second read on the same instance (warm).
 * @param {import("../../src/core/repository.js").InMemoryRepository} repo
 */
export async function loadMetrics(repo) {
  const cold = await time(async () => { await createWhiteboard(repo).getBoard(); }, 5);
  const core = createWhiteboard(repo);
  await core.getBoard();
  const warm = await time(() => core.getBoard(), 5);
  return { coldMs: cold, warmMs: warm };
}

/**
 * Core operation latency: one-object and 100-object updates (validation, commit, history).
 * @param {any} core @param {any} snapshot
 */
export async function opMetrics(core, snapshot) {
  const movable = Object.values(snapshot.objects).filter((o) => o.type !== "connector");
  const versions = new Map(movable.map((o) => [o.id, o.version]));
  let k = 0;
  const update = async (/** @type {any[]} */ list) => {
    k++;
    const res = await core.applyOperation({
      by: "Bench", senderId: "bench",
      objectOps: list.map((o) => ({ op: "update", id: o.id, baseVersion: versions.get(o.id), patch: { x: o.x + (k % 2 ? 1 : -1) } })),
    });
    for (const u of res.result.upserts) versions.set(u.id, u.version);
  };
  return {
    single: await time(() => update([movable[0]])),
    hundred: await time(() => update(movable.slice(0, 100))),
  };
}

/**
 * Client model: spatial index build and stacking sort.
 * @param {Record<string, any>} objects @param {{timings?: boolean}} [opts]
 */
export async function modelMetrics(objects, { timings = false } = {}) {
  const index = new SpatialIndex();
  index.reset(objects);
  const out = /** @type {Record<string, any>} */ ({ indexed: index.size, cells: index.cells.size, large: index.large.size });
  if (timings) {
    out.indexBuildMs = await time(() => new SpatialIndex().reset(objects));
    out.sortMs = await time(() => sortedObjects(objects));
  }
  return { index, ...out };
}

/**
 * Hit testing and viewport queries over the index, versus brute force. `scanned` counts ids the
 * index examined per query (the algorithmic proxy asserted in CI).
 * @param {Record<string, any>} objects @param {SpatialIndex} index @param {number} side
 * @param {{timings?: boolean, points?: number}} [opts]
 */
export async function queryMetrics(objects, index, side, { timings = false, points = 1000 } = {}) {
  const rng = prng(42);
  const pts = Array.from({ length: points }, () => ({ x: rng() * side, y: rng() * side }));
  const resolve = (/** @type {string} */ id) => objects[id];
  const sorted = sortedObjects(objects);
  const zoom = 1;
  const pad = HIT_TOLERANCE_PX / zoom;
  const hitIndexed = (/** @type {{x: number, y: number}} */ p) => topObjectAt(stackOrder(objects, index.queryPoint(p, pad)), p, zoom, resolve);
  const hitBrute = (/** @type {{x: number, y: number}} */ p) => topObjectAt(sorted, p, zoom, resolve);
  let mismatches = 0;
  const s0 = index.stats.scanned, q0 = index.stats.queries;
  for (const p of pts) if (hitIndexed(p)?.id !== hitBrute(p)?.id) mismatches++;
  const hitScanned = (index.stats.scanned - s0) / Math.max(1, index.stats.queries - q0);
  const views = pts.slice(0, 100).map((p) => ({ x: p.x, y: p.y, w: VIEW.w / zoom, h: VIEW.h / zoom }));
  const s1 = index.stats.scanned, q1 = index.stats.queries;
  let found = 0;
  for (const v of views) found += index.query(v).length;
  const viewScanned = (index.stats.scanned - s1) / Math.max(1, index.stats.queries - q1);
  const out = /** @type {Record<string, any>} */ ({
    hitMismatches: mismatches,
    hitScannedPerQuery: r3(hitScanned),
    viewportScannedPerQuery: r3(viewScanned),
    viewportFoundPerQuery: r3(found / views.length),
    bruteScannedPerQuery: Object.keys(objects).length,
  });
  if (timings) {
    const run = (/** @type {(p: any) => any} */ f) => () => { for (const p of pts) f(p); };
    const indexed = await time(run(hitIndexed), 5);
    const brute = await time(run(hitBrute), 3);
    out.hitIndexedUs = r3((indexed.median * 1000) / pts.length);
    out.hitBruteUs = r3((brute.median * 1000) / pts.length);
    const vq = await time(() => { for (const v of views) index.query(v); }, 5);
    out.viewportQueryUs = r3((vq.median * 1000) / views.length);
  }
  return out;
}

/**
 * The real canvas over the fake DOM: rendered object groups and SVG elements at "fit to content"
 * and at 100% zoom in the middle of the board, with culling on and off, and a pan sweep.
 * @param {Record<string, any>} objects @param {number} side @param {{timings?: boolean}} [opts]
 */
export async function canvasMetrics(objects, side, { timings = false } = {}) {
  const out = /** @type {Record<string, any>} */ ({});
  const middle = { x: side / 2 - VIEW.w / 2, y: side / 2 - VIEW.h / 2, zoom: 1 };
  for (const cull of [true, false]) {
    const label = cull ? "culled" : "unculled";
    const t = performance.now();
    const rig = canvasRig(structuredClone(objects), { width: VIEW.w, height: VIEW.h, camera: middle, cull: cull ? {} : { enabled: false } });
    const buildMs = performance.now() - t;
    const zoom1 = { groups: rig.groups(), elements: rig.nodes() };
    const fit = fitRect({ x: 0, y: 0, w: side, h: side }, VIEW.w, VIEW.h, { padding: 60 });
    rig.setCamera(fit);
    const atFit = { groups: rig.groups(), elements: rig.nodes() };
    rig.setCamera(middle);
    // A remote single-object update in view.
    const before = globalThis.window.__wbRenderStats.objectRenders;
    const inView = rig.canvas.getSpatialIndex().query(rig.canvas.getViewport()).find((id) => objects[id].type === "sticky")
      ?? rig.canvas.getSpatialIndex().query(rig.canvas.getViewport()).find((id) => objects[id].type !== "connector");
    if (inView) rig.store.updateObjects([{ id: inView, patch: { x: objects[inView].x + 1 } }]);
    const updateRenders = globalThis.window.__wbRenderStats.objectRenders - before;
    // Pan sweep: 60 steps of 150 screen px at 100%.
    const inserts0 = rig.dom.document.inserts;
    const created0 = rig.dom.document.created;
    let maxGroups = 0;
    let panTotal = 0;
    for (let i = 1; i <= 60; i++) {
      const t2 = performance.now();
      rig.setCamera({ ...middle, x: middle.x + i * 150, y: middle.y + i * 40 });
      panTotal += performance.now() - t2;
      maxGroups = Math.max(maxGroups, rig.groups());
    }
    const panMs = panTotal / 60;
    rig.destroy();
    out[label] = {
      zoom1, atFit, pan: { maxGroups, elementsCreatedPerStep: r3((rig.dom.document.created - created0) / 60), insertsPerStep: r3((rig.dom.document.inserts - inserts0) / 60) },
      remoteUpdateRenders: updateRenders,
    };
    if (timings) { out[label].buildMs = r3(buildMs); out[label].pan.msPerStep = r3(panMs); }
  }
  return out;
}

/**
 * Presence traffic for 1, 10, 50 and 200 viewers, idle and with 20% moving their pointer.
 * @param {number[]} [counts] @param {number} [seconds]
 */
export async function presenceMetrics(counts = [1, 10, 50, 200], seconds = 8) {
  const out = [];
  for (const viewers of counts) {
    for (const activeShare of [0, 0.2]) out.push(await simulatePresence({ viewers, activeShare, seconds }));
  }
  return out;
}

/**
 * Everything for one fixture size.
 * @param {number} n @param {{timings?: boolean}} [opts]
 */
export async function measureSize(n, opts = {}) {
  const fx = await buildFixture(n);
  const objects = fx.snapshot.objects;
  const model = await modelMetrics(objects, opts);
  const { index, ...modelOut } = model;
  const result = /** @type {Record<string, any>} */ ({
    objects: Object.keys(objects).length,
    composition: fx.counts,
    snapshot: await snapshotMetrics(fx.snapshot, opts),
    model: modelOut,
    queries: await queryMetrics(objects, index, fx.side, opts),
    canvas: await canvasMetrics(objects, fx.side, opts),
  });
  if (opts.timings) {
    result.load = await loadMetrics(fx.repo);
    result.ops = await opMetrics(fx.board, fx.snapshot);
  }
  return result;
}
