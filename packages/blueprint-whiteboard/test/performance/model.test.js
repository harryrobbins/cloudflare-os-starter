// Large-board performance proxies (plan phase 0.2): deterministic 500/2,000/5,000-object fixtures
// through the real core, then snapshot bytes, spatial-index scan counts, rendered SVG groups and
// elements under viewport culling, render counts for a remote update, and presence fan-out
// through the real hub, all against BUDGETS (./budgets.js). No wall-clock assertions: timings are
// recorded by `node scripts/benchmark.mjs` (see baseline.md).
import { describe, expect, it } from "vitest";
import { LIMITS } from "../../src/shared/protocol.js";
import { expandRect, OVERSCAN } from "../../src/client/ui/canvas/culling.js";
import { BUDGETS } from "./budgets.js";
import { SIZES, fixtureOps, buildFixture, simpleObjects } from "./fixtures.js";
import { snapshotMetrics, modelMetrics, queryMetrics, canvasMetrics } from "./measure.js";
import { simulatePresence } from "./presence-sim.js";
import { canvasRig } from "./canvas-rig.js";

describe("fixtures", () => {
  it("are deterministic and have the documented mix", async () => {
    const a = JSON.stringify(fixtureOps(2000).ops);
    expect(JSON.stringify(fixtureOps(2000).ops)).toBe(a);
    expect(JSON.stringify(fixtureOps(2000, { seed: 2 }).ops)).not.toBe(a);
    const { snapshot, counts } = await buildFixture(500);
    expect(Object.keys(snapshot.objects)).toHaveLength(500);
    for (const type of ["frame", "sticky", "rect", "ellipse", "text", "pen", "connector"]) expect(counts[type]).toBeGreaterThan(0);
    const texts = Object.values(snapshot.objects).map((o) => o.text.length);
    expect(Math.max(...texts)).toBeGreaterThan(800); // long text
    const pens = Object.values(snapshot.objects).filter((o) => o.type === "pen");
    expect(Math.max(...pens.map((o) => o.points.length / 2))).toBeGreaterThan(100);
    expect(Object.values(snapshot.objects).some((o) => o.frameId)).toBe(true);
  });
});

describe.each(SIZES)("%i objects", (n) => {
  it("stays within the snapshot, index and rendering budgets", async () => {
    const fx = await buildFixture(n);
    const objects = fx.snapshot.objects;
    expect(Object.keys(objects)).toHaveLength(n);

    const snap = await snapshotMetrics(fx.snapshot);
    expect(snap.bytes).toBeLessThanOrEqual(BUDGETS.snapshotBytes[n]);
    expect(snap.bytes).toBeLessThan(LIMITS.boardBytes);

    const { index } = await modelMetrics(objects);
    expect(index.verify()).toEqual({ missing: [], extra: [], stale: [] });
    const q = await queryMetrics(objects, index, fx.side, { points: 400 });
    expect(q.hitMismatches).toBe(0);
    expect(q.hitScannedPerQuery).toBeLessThanOrEqual(BUDGETS.index.hitScannedPerQuery);
    expect(q.viewportScannedPerQuery).toBeLessThanOrEqual(BUDGETS.index.viewportScannedPerQuery);

    const c = await canvasMetrics(objects, fx.side);
    expect(c.culled.zoom1.groups).toBeLessThanOrEqual(BUDGETS.canvas.groupsAtZoom1);
    expect(c.culled.zoom1.elements).toBeLessThanOrEqual(BUDGETS.canvas.elementsAtZoom1);
    expect(c.culled.pan.maxGroups).toBeLessThanOrEqual(BUDGETS.canvas.panMaxGroups);
    expect(c.culled.remoteUpdateRenders).toBeLessThanOrEqual(BUDGETS.canvas.remoteUpdateRenders);
    // Fit to content shows everything: culling must not drop anything there.
    expect(c.culled.atFit.groups).toBe(n);
    // Without culling every object is in the DOM at any zoom.
    expect(c.unculled.zoom1.groups).toBe(n);
  }, 60_000);
});

describe("culling acceptance", () => {
  it("5,000 off-screen simple objects: rendered groups = what meets the overscanned viewport", () => {
    const near = simpleObjects(30, { x0: 40, y0: 40, gap: 150 });
    const far = simpleObjects(5000, { x0: 200_000, y0: 200_000, start: 1000 });
    const rig = canvasRig({ ...near, ...far }, { width: 1400, height: 900 });
    try {
      const covered = expandRect(rig.canvas.getViewport(), OVERSCAN);
      const inCover = rig.canvas.getSpatialIndex().query(covered).length;
      expect(rig.groups()).toBeLessThanOrEqual(inCover + BUDGETS.canvas.offscreenExtraGroups);
      expect(rig.groups()).toBe(30);
      // Twice as many off-screen objects: the same DOM.
      const more = simpleObjects(5000, { x0: -300_000, y0: 0, start: 20_000 });
      for (const [id, o] of Object.entries(more)) rig.store.state.board.objects[id] = o;
      rig.store.emit({ kind: "objects", objects: Object.keys(more) });
      expect(rig.groups()).toBe(30);
    } finally {
      rig.destroy();
    }
  });
});

describe("presence fan-out (hub simulation)", () => {
  it("50 viewers stay within the recorded presence budgets", async () => {
    const active = await simulatePresence({ viewers: 50, activeShare: 0.2, seconds: 3 });
    expect(active.deliveriesPerSecond).toBeLessThanOrEqual(BUDGETS.presence.active50.deliveriesPerSecond);
    expect(active.bytesPerSecond).toBeLessThanOrEqual(BUDGETS.presence.active50.bytesPerSecond);
    const idle = await simulatePresence({ viewers: 50, activeShare: 0, seconds: 8 });
    expect(idle.deliveriesPerSecond).toBeLessThanOrEqual(BUDGETS.presence.idle50.deliveriesPerSecond);
    expect(idle.bytesPerSecond).toBeLessThanOrEqual(BUDGETS.presence.idle50.bytesPerSecond);
    // One viewer alone: heartbeats in, nothing out.
    const solo = await simulatePresence({ viewers: 1, seconds: 8 });
    expect(solo.deliveriesPerSecond).toBe(0);
  }, 60_000);
});
