// Viewport culling (src/client/ui/canvas/culling.js and its use in the canvas controller): the
// planner against the spatial index, then the real canvas over a fake DOM: rendered groups stay
// proportional to what is near the viewport, pinned objects keep their elements, connectors bring
// their endpoints, panning never leaves a visible object without an element, and small boards,
// export mode and the model itself are never culled.
import { afterEach, describe, expect, it } from "vitest";
import { TYPE_DEFAULTS } from "../../src/shared/protocol.js";
import { rectsIntersect } from "../../src/shared/geometry.js";
import { SpatialIndex } from "../../src/client/model/spatial-index.js";
import { Culler, connectorsOf, expandRect, OVERSCAN, MIN_OBJECTS } from "../../src/client/ui/canvas/culling.js";
import { viewportOf } from "../../src/client/ui/canvas/camera.js";
import { allIcons } from "../../src/shared/icons/registry.js";
import { canvasRig } from "../performance/canvas-rig.js";
import { simpleObjects, fixtureId } from "../performance/fixtures.js";

let seq = 0;
/** @returns {any} */
function obj(type, fields = {}) {
  const d = TYPE_DEFAULTS[type];
  const o = {
    id: fields.id ?? fixtureId(0x200000 + ++seq), type, x: 0, y: 0, w: d.w, h: d.h, rot: 0, z: "b" + (++seq).toString(36), frameId: null,
    text: d.text, style: { ...d.style }, version: 1, createdAt: 0, updatedAt: 0, createdBy: "t", ...fields,
  };
  if (type === "connector") Object.assign(o, { x: 0, y: 0, w: 1, h: 1, fromSide: "auto", toSide: "auto", routing: "straight", ...fields });
  return o;
}

/** 5,000 stickies far away from the origin (off screen for a camera at 0,0). */
const offscreen = () => simpleObjects(5000, { x0: 100_000, y0: 100_000, start: 10_000 });
/** `n` stickies inside the 1000x800 viewport at the origin. */
const onscreen = (n) => simpleObjects(n, { x0: 20, y0: 20, gap: 150, start: 0 });

/** @type {ReturnType<typeof canvasRig>|null} */
let rig = null;
afterEach(() => { rig?.destroy(); rig = null; });

describe("Culler", () => {
  const index = (objects) => { const i = new SpatialIndex(); i.reset(objects); return i; };

  it("plans the overscanned viewport, pins, connectors of visible objects and their endpoints", () => {
    const a = obj("rect", { x: 0, y: 0 });
    const far = obj("rect", { x: 50_000, y: 50_000 });
    const far2 = obj("rect", { x: 60_000, y: 50_000 });
    const conn = obj("connector", { from: a.id, to: far.id });
    const farConn = obj("connector", { from: far.id, to: far2.id });
    const pinned = obj("sticky", { x: -40_000, y: 0 });
    const objects = { ...offscreen(), [a.id]: a, [far.id]: far, [far2.id]: far2, [conn.id]: conn, [farConn.id]: farConn, [pinned.id]: pinned };
    const idx = index(objects);
    const culler = new Culler();
    const wanted = culler.plan({ index: idx, objects, viewport: { x: 0, y: 0, w: 1000, h: 800 }, pins: [pinned.id, "o_000000000bad"] });
    expect(wanted).not.toBeNull();
    expect([...wanted].sort()).toEqual([a.id, conn.id, far.id, pinned.id].sort());
    expect(culler.covered).toEqual(expandRect({ x: 0, y: 0, w: 1000, h: 800 }, OVERSCAN));
    expect(connectorsOf(idx, [far.id])).toEqual(new Set([conn.id, farConn.id]));
  });

  it("renders everything on small boards and when disabled, and only pins before a size is known", () => {
    const objects = onscreen(10);
    const idx = index(objects);
    expect(new Culler().plan({ index: idx, objects, viewport: { x: 0, y: 0, w: 10, h: 10 }, pins: [] })).toBeNull();
    const big = offscreen();
    const bigIdx = index(big);
    expect(new Culler({ enabled: false }).plan({ index: bigIdx, objects: big, viewport: { x: 0, y: 0, w: 10, h: 10 }, pins: [] })).toBeNull();
    const first = Object.keys(big)[0];
    expect([...new Culler().plan({ index: bigIdx, objects: big, viewport: null, pins: [first] })]).toEqual([first]);
    expect(MIN_OBJECTS).toBeGreaterThan(10);
  });

  it("keeps the covered rect while the viewport stays inside it, and re-plans when it leaves or zooms far in", () => {
    const big = offscreen();
    const idx = index(big);
    const culler = new Culler();
    const vp = { x: 0, y: 0, w: 1000, h: 800 };
    culler.plan({ index: idx, objects: big, viewport: vp, pins: [] });
    expect(culler.stale({ ...vp, x: 400 })).toBe(false);
    expect(culler.stale({ ...vp, x: 600 })).toBe(true);
    expect(culler.stale({ x: 400, y: 300, w: 100, h: 80 })).toBe(true); // 100x smaller: shrink the plan
    expect(culler.stale({ x: 0, y: 0, w: 1200, h: 900 })).toBe(false); // zoomed out a little, still covered
    expect(culler.stale({ x: 0, y: 0, w: 2500, h: 2000 })).toBe(true);
  });
});

describe("canvas culling", () => {
  it("renders groups proportional to the viewport with 5,000 off-screen objects (documented bound)", () => {
    const near = onscreen(24);
    rig = canvasRig({ ...near, ...offscreen() });
    const vp = rig.canvas.getViewport();
    const covered = expandRect(vp, OVERSCAN);
    const index = rig.canvas.getSpatialIndex();
    const inCover = index.query(covered).length;
    // Bound (culling.js): |V| + |pins| + connector closure; nothing pinned and no connectors here.
    expect(rig.groups()).toBe(inCover);
    expect(rig.groups()).toBe(24);
    expect(window.__wbRenderStats.rendered).toBe(24);
    // The model is not culled.
    expect(Object.keys(rig.store.getState().board.objects)).toHaveLength(5024);
    expect(index.size).toBe(5024);
  });

  it("never leaves a visible object without an element while panning and zooming", () => {
    const objects = simpleObjects(3000, { gap: 230 }); // ~12,600 x 12,600 world units
    rig = canvasRig(objects);
    const index = rig.canvas.getSpatialIndex();
    let maxGroups = 0;
    for (let step = 0; step < 60; step++) {
      const zoom = step < 40 ? 1 : 0.4 + (step - 40) * 0.05;
      rig.setCamera({ x: step * 173, y: step * 97, zoom });
      const vp = rig.canvas.getViewport();
      const rendered = rig.renderedIds();
      for (const id of index.query(vp)) expect(rendered.has(id), `visible ${id} rendered at step ${step}`).toBe(true);
      maxGroups = Math.max(maxGroups, rendered.size);
      // Nothing outside the covered rect (no pins here). The covered rect holds the viewport and is at
      // most sqrt(MAX_COVER_RATIO) * (1 + 2 * OVERSCAN) = 6 viewports wide, so 5 viewports around it.
      for (const id of rendered) expect(rectsIntersect(index.bounds(id), expandRect(vp, 5))).toBe(true);
    }
    expect(maxGroups).toBeLessThan(600);
  });

  it("pins the selection, text editing and collaborators' transforms, and pans an off-screen pick into view", () => {
    const objects = { ...onscreen(4), ...offscreen() };
    const far = Object.keys(objects)[100];
    const far2 = Object.keys(objects)[200];
    const far3 = Object.keys(objects)[300];
    rig = canvasRig(objects);
    expect(rig.renderedIds().has(far)).toBe(false);

    rig.canvas.setSelection([far]);
    rig.flush();
    expect(rig.renderedIds().has(far)).toBe(true);

    rig.canvas.editText(far2);
    expect(rig.renderedIds().has(far2)).toBe(true); // synchronously, before the editor opens
    expect(rig.canvas.getSelection()).toEqual([far2]);
    rig.flush();
    expect(rig.renderedIds().has(far)).toBe(false); // no longer selected
    expect(rig.renderedIds().has(far2)).toBe(true);

    rig.store.state.peers.set("peer-1", { clientId: "peer-1", name: "P", color: "#123456", selection: [], transforms: [{ id: far3, x: 0, y: 0, w: 200, h: 200, rot: 0 }], cursor: null, viewport: null, stroke: null, editingId: null, lastSeen: 0 });
    rig.store.emit({ kind: "presence", peers: ["peer-1"] });
    rig.flush();
    expect(rig.renderedIds().has(far3)).toBe(true);

    // Objects panel "Select": no animation, so the camera is on it when focus moves on.
    rig.canvas.setSelection([far]);
    rig.canvas.focusObjects([far], { animate: false });
    const vp = rig.canvas.getViewport();
    expect(rectsIntersect(vp, rig.canvas.getSpatialIndex().bounds(far))).toBe(true);
    rig.flush();
    expect(rig.renderedIds().has(far)).toBe(true);
  });

  it("renders connectors whose endpoint is visible, with both endpoints", () => {
    const a = obj("rect", { x: 100, y: 100 });
    const far = obj("rect", { x: 90_000, y: 90_000 });
    const conn = obj("connector", { from: a.id, to: far.id });
    rig = canvasRig({ ...offscreen(), [a.id]: a, [far.id]: far, [conn.id]: conn });
    const ids = rig.renderedIds();
    expect(ids.has(conn.id)).toBe(true);
    expect(ids.has(far.id)).toBe(true);
    expect(ids.size).toBe(3);
  });

  it("follows store changes: objects moving in and out of view, creates and deletes", () => {
    const objects = { ...onscreen(2), ...offscreen() };
    const far = Object.keys(objects)[50];
    rig = canvasRig(objects);
    expect(rig.groups()).toBe(2);
    rig.store.updateObjects([{ id: far, patch: { x: 300, y: 300 } }]);
    expect(rig.renderedIds().has(far)).toBe(true);
    rig.store.updateObjects([{ id: far, patch: { x: 200_000, y: 200_000 } }]);
    expect(rig.renderedIds().has(far)).toBe(false);
    const fresh = obj("sticky", { x: 500, y: 400 });
    rig.store.state.board.objects[fresh.id] = fresh;
    rig.store.emit({ kind: "objects", objects: [fresh.id] });
    expect(rig.renderedIds().has(fresh.id)).toBe(true);
    rig.store.deleteObjects([fresh.id]);
    expect(rig.renderedIds().has(fresh.id)).toBe(false);
    // A remote change far away costs no render at all.
    const before = window.__wbRenderStats.objectRenders;
    rig.store.updateObjects([{ id: Object.keys(objects)[60], patch: { text: "x" } }]);
    expect(window.__wbRenderStats.objectRenders).toBe(before);
  });

  it("culls icons like any other box object", () => {
    const [first] = allIcons();
    const near = obj("icon", { x: 300, y: 300, w: 96, h: 96, packId: first.pack.id, iconId: first.id });
    const far = obj("icon", { x: 150_000, y: 150_000, w: 96, h: 96, packId: first.pack.id, iconId: first.id });
    rig = canvasRig({ ...offscreen(), [near.id]: near, [far.id]: far });
    expect(rig.renderedIds()).toEqual(new Set([near.id]));
  });

  it("keeps small boards and export mode fully rendered", () => {
    rig = canvasRig(simpleObjects(200, { x0: 100_000, y0: 100_000 }));
    expect(rig.groups()).toBe(200);
    rig.destroy();
    rig = canvasRig(offscreen(), { exportMode: true });
    expect(rig.groups()).toBe(5000);
  });
});

describe("viewportOf", () => {
  it("is the world rect the culling plan covers", () => {
    expect(viewportOf({ x: 10, y: 20, zoom: 2 }, 1000, 800)).toEqual({ x: 10, y: 20, w: 500, h: 400 });
  });
});
