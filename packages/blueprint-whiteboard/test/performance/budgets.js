// @ts-check
// Performance budgets asserted in CI by model.test.js. Only algorithmic proxies (bytes, counts,
// ids scanned, calls): never wall-clock time, which varies by machine. Timings are recorded by
// `node scripts/benchmark.mjs` instead (see baseline.md).
//
// Values are the baseline measurements (baseline.md, 2026-09-24) plus headroom. A change that
// needs a higher number should say why in its commit; phase 3.5 (adaptive presence) is expected
// to LOWER the presence budgets.

export const BUDGETS = Object.freeze({
  /** Snapshot JSON bytes per fixture size (the board cap, LIMITS.boardBytes, is 8 MiB). */
  snapshotBytes: { 500: 400_000, 2000: 1_600_000, 5000: 4_000_000 },
  index: {
    /** Ids examined per hit test (point query with the touch tolerance at 100%). */
    hitScannedPerQuery: 12,
    /** Ids examined per 1400x900 viewport query at 100%. */
    viewportScannedPerQuery: 80,
  },
  canvas: {
    /** Rendered object groups at 100% in the middle of the board, any fixture size. */
    groupsAtZoom1: 200,
    /** SVG elements under the canvas at 100% (object groups and their parts, chrome). */
    elementsAtZoom1: 1_500,
    /** Most object groups at any point of a 60-step pan at 100%. */
    panMaxGroups: 250,
    /** Object renders caused by one remote single-object update in view. */
    remoteUpdateRenders: 5,
    /**
     * 5,000 off-screen simple objects: rendered groups beyond what intersects the covered
     * (overscanned) viewport. Pins and connectors add to this only when present.
     */
    offscreenExtraGroups: 0,
  },
  presence: {
    /** 50 viewers, 20% moving their pointer: hub deliveries and estimated bytes per second. */
    active50: { deliveriesPerSecond: 1_700, bytesPerSecond: 11_000_000 },
    /** 50 idle viewers (heartbeats only). */
    idle50: { deliveriesPerSecond: 250, bytesPerSecond: 420_000 },
  },
});
