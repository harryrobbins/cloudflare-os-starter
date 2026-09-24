// Connector route editing on the client: the route handle gesture (elbow segments and the curve
// handle) against a fake store, side pinning when a connector end is dropped near a side, keyboard
// route editing through the real canvas over the fake DOM, the spatial index re-routing automatic
// elbows when an obstacle moves, and presence transforms carrying route edits.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TYPE_DEFAULTS, cleanPresence } from "../../src/shared/protocol.js";
import { anchor } from "../../src/shared/geometry.js";
import { connectorRoute, routeHandles, createRouteEnv } from "../../src/shared/connectors.js";
import { cubicPoint } from "../../src/shared/bezier.js";
import { SNAP_PX } from "../../src/client/model/alignment.js";
import { snapTargets } from "../../src/client/ui/canvas/model.js";
import { SpatialIndex } from "../../src/client/model/spatial-index.js";
import {
  sideNear, routePatch, resetRoutePatch, canResetRoute, connectorHandles, routeHandleAt, routeTransform,
  keyboardEdit, straightThroughLines,
} from "../../src/client/ui/canvas/route-edit.js";
import { keyAction } from "../../src/client/ui/canvas/keymap.js";
import { previousValues } from "../../src/client/model/undo.js";
import { canvasRig } from "../performance/canvas-rig.js";

let seq = 0;
const nid = () => "o_" + (0x400000000000 + ++seq).toString(16).slice(-12);

/** @returns {any} */
function obj(type, fields = {}) {
  const d = TYPE_DEFAULTS[type];
  const o = {
    id: fields.id ?? nid(), type, x: 0, y: 0, w: d.w, h: d.h, rot: 0, z: "a0", frameId: null, text: d.text,
    style: { ...d.style }, version: 1, createdAt: 0, updatedAt: 0, createdBy: "t", ...fields,
  };
  if (type === "connector") Object.assign(o, { x: 0, y: 0, w: 1, h: 1, fromSide: "auto", toSide: "auto", routing: "straight", ...fields });
  return o;
}
const board = (...list) => Object.fromEntries(list.map((o) => [o.id, o]));
const pt = (x, y, extra = {}) => ({ sx: x, sy: y, x, y, shift: false, alt: false, clientX: x, clientY: y, pointerType: "mouse", time: 0, ...extra });

describe("route handle gesture", () => {
  /** @type {typeof import("../../src/client/ui/canvas/route-edit.js")} */
  let R;
  /** @type {typeof import("../../src/client/ui/canvas/gestures.js")} */
  let G;
  beforeAll(async () => {
    const fakeEl = () => ({
      setAttribute() {}, removeAttribute() {}, remove() {}, appendChild() {}, append() {}, removeChild() {},
      firstChild: null, classList: { add() {}, remove() {} }, textContent: "",
    });
    globalThis.document ??= /** @type {any} */ ({ createElementNS: () => fakeEl() });
    R = await import("../../src/client/ui/canvas/route-edit.js");
    G = await import("../../src/client/ui/canvas/gestures.js");
  });

  function setup(objects, { zoom = 1 } = {}) {
    const calls = [];
    const state = { board: { objects } };
    const overlays = [];
    const rerenders = [];
    const store = {
      getState: () => state,
      updateObjects: vi.fn((u) => calls.push(["update", u])),
      createObjects: vi.fn((list) => { calls.push(["create", list]); return list.map((_o, i) => `o_00000000000${i}`); }),
      setPresence: vi.fn((p) => calls.push(["presence", p])),
      flushPresence: vi.fn(() => calls.push(["flush"])),
    };
    const routeOverrides = new Map();
    const resolve = (i) => {
      const o = state.board.objects[i];
      const r = routeOverrides.get(i);
      return o && r ? { ...o, ...r } : o;
    };
    const ctx = {
      store, element: { classList: { add() {}, remove() {} } },
      objects: () => state.board.objects, resolve,
      sorted: () => Object.values(state.board.objects),
      camera: () => ({ x: 0, y: 0, zoom }),
      layer: { translate() {}, rerender: (ids) => rerenders.push([...ids].map((i) => resolve(i))), connectorsOf: () => new Set() },
      overrides: new Map(), routeOverrides, preview: { appendChild() {} },
      getSelection: () => [], setSelection() {},
      schedule() {}, setCameraByUser: vi.fn(), setOverlay: (patch) => overlays.push(patch),
      toolStyle: () => ({}), finishCreate: vi.fn(), editText: vi.fn(), contextMenu: vi.fn(),
      registerClick: vi.fn(() => false), announceSelection() {}, announce: vi.fn(),
      snapOptions: () => ({ threshold: SNAP_PX / zoom, grid: 0 }),
      snapTargets: (moving) => snapTargets(state.board.objects, Object.keys(state.board.objects), moving),
      routeEnv: createRouteEnv(objects),
    };
    return { ctx, calls, overlays, rerenders, state };
  }

  it("drags an elbow's middle segment: live override and ghost, one update with pinned sides on release", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 400, y: 200, w: 100, h: 100 });
    const conn = obj("connector", { from: a.id, to: b.id, routing: "elbow", fromSide: "right", toSide: "left" });
    const { ctx, calls, rerenders } = setup(board(a, b, conn));
    const h = connectorHandles(conn, ctx.resolve, ctx.routeEnv, 1);
    const i = h.handles.findIndex((hd) => !hd.anchored);
    const hd = h.handles[i];
    expect(hd.axis).toBe("x");
    const g = R.routeHandleGesture(ctx, pt(hd.point.x, hd.point.y), conn.id, i);
    g.move(pt(hd.point.x + 57, hd.point.y + 30)); // only x matters for a vertical segment
    g.frame();
    // Drawn with the edit while dragging, and sent to peers as a transform on the connector.
    const drawn = rerenders.at(-1)[0];
    expect(drawn.segments).toEqual([57]);
    const presence = calls.filter((c) => c[0] === "presence").at(-1)[1];
    expect(presence.transforms).toEqual([expect.objectContaining({ id: conn.id, segments: [57], fromSide: "right", toSide: "left" })]);
    g.up(pt(hd.point.x + 57, hd.point.y));
    const updates = calls.filter((c) => c[0] === "update");
    expect(updates).toEqual([["update", [{ id: conn.id, patch: { segments: [57] } }]]]);
    expect(calls.filter((c) => c[0] === "presence").at(-1)[1]).toEqual({ transforms: [] });
    expect(ctx.routeOverrides.size).toBe(0);
    expect(ctx.announce).toHaveBeenCalledWith("Route changed");
  });

  it("snaps a segment to another object's centre line and to a straight-through line, unless Alt", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 400, y: 200, w: 100, h: 100 });
    const other = obj("sticky", { x: 250, y: 600, w: 100, h: 100 }); // centre x = 300
    const conn = obj("connector", { from: a.id, to: b.id, routing: "elbow", fromSide: "right", toSide: "left" });
    const { ctx, calls, overlays } = setup(board(a, b, other, conn));
    const h = connectorHandles(conn, ctx.resolve, ctx.routeEnv, 1);
    const i = h.handles.findIndex((hd) => !hd.anchored);
    const hd = h.handles[i];
    const drag = (x, extra = {}) => {
      calls.length = 0;
      const g = R.routeHandleGesture(ctx, pt(hd.point.x, hd.point.y), conn.id, i);
      g.move(pt(x, hd.point.y, extra));
      g.frame();
      g.up(pt(x, hd.point.y, extra));
      return calls.find((c) => c[0] === "update")?.[1][0].patch.segments;
    };
    expect(drag(303)).toEqual([50]); // 300 - 250 (midpoint of the ports)
    expect(overlays.some((o) => o.guides?.some((gd) => gd.axis === "x" && gd.x === 300))).toBe(true);
    expect(drag(303, { alt: true })).toEqual([53]);
    // The start port's line (x = 124): the segment lines up with the stub.
    expect(straightThroughLines(a, b, h.route, hd)).toContain(124);
    expect(drag(127)).toEqual([-126]);
  });

  it("drags the curve handle of a curved connector; dropping on the default midpoint clears it", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 400, y: 200, w: 100, h: 100 });
    const conn = obj("connector", { from: a.id, to: b.id, routing: "curved" });
    const { ctx, calls } = setup(board(a, b, conn));
    const h = connectorHandles(conn, ctx.resolve, ctx.routeEnv, 1);
    expect(h.handles).toHaveLength(1);
    const g = R.routeHandleGesture(ctx, pt(h.handles[0].point.x, h.handles[0].point.y), conn.id, 0);
    g.move(pt(200, 260));
    g.frame();
    g.up(pt(200, 260));
    const patch = calls.find((c) => c[0] === "update")[1][0].patch;
    expect(patch.curve).toHaveLength(2);
    const edited = connectorRoute({ ...conn, ...patch }, a, b);
    expect(cubicPoint(edited.cubic, 0.5).x).toBeCloseTo(200, 1);
    expect(cubicPoint(edited.cubic, 0.5).y).toBeCloseTo(260, 1);
    // Back onto the default midpoint: the edit is cleared.
    ctx.store.getState().board.objects[conn.id] = { ...conn, curve: patch.curve };
    const plain = connectorRoute(conn, a, b).cubic;
    const mid = cubicPoint(plain, 0.5);
    calls.length = 0;
    const g2 = R.routeHandleGesture(ctx, pt(200, 260), conn.id, 0);
    g2.move(pt(mid.x, mid.y));
    g2.up(pt(mid.x, mid.y));
    expect(calls.find((c) => c[0] === "update")[1][0].patch).toEqual({ curve: null });
    expect(ctx.announce).toHaveBeenCalledWith("Curve changed");
  });

  it("cancel restores the committed route and clears the ghost", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 400, y: 200, w: 100, h: 100 });
    const conn = obj("connector", { from: a.id, to: b.id, routing: "elbow", fromSide: "right", toSide: "left" });
    const { ctx, calls } = setup(board(a, b, conn));
    const h = connectorHandles(conn, ctx.resolve, ctx.routeEnv, 1);
    const i = h.handles.findIndex((hd) => !hd.anchored);
    const g = R.routeHandleGesture(ctx, pt(h.handles[i].point.x, 0), conn.id, i);
    g.move(pt(h.handles[i].point.x + 40, 0));
    g.frame();
    g.cancel();
    expect(ctx.routeOverrides.size).toBe(0);
    expect(calls.some((c) => c[0] === "update")).toBe(false);
    expect(calls.filter((c) => c[0] === "presence").at(-1)[1]).toEqual({ transforms: [] });
  });

  it("dropping a new connector's end near a side pins it; elsewhere stays automatic", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 400, y: 0, w: 100, h: 100 });
    const { ctx, calls } = setup(board(a, b));
    const create = (start, end) => {
      calls.length = 0;
      const g = G.connectGesture(ctx, start, a);
      g.move(end);
      g.frame();
      g.up(end);
      return calls.find((c) => c[0] === "create")[1][0];
    };
    expect(create(pt(50, 50), pt(450, 50))).toEqual({ type: "connector", from: a.id, to: b.id });
    expect(create(pt(50, 50), pt(452, 4))).toEqual({ type: "connector", from: a.id, to: b.id, toSide: "top" });
    expect(create(pt(50, 97), pt(450, 50))).toEqual({ type: "connector", from: a.id, to: b.id, fromSide: "bottom" });
  });

  it("dropping a moved end near a side pins it, and reconnecting clears stale segments", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 400, y: 0, w: 100, h: 100 });
    const c = obj("rect", { x: 400, y: 400, w: 100, h: 100 });
    const conn = obj("connector", { from: a.id, to: b.id, routing: "elbow", segments: [30], fromSide: "right", toSide: "left" });
    const { ctx, calls } = setup(board(a, b, c, conn));
    const drag = (to) => {
      calls.length = 0;
      const g = G.endpointGesture(ctx, pt(400, 50), conn.id, "to");
      g.move(to);
      g.frame();
      g.up(to);
      return calls.filter((x) => x[0] === "update").map((x) => x[1][0].patch);
    };
    expect(drag(pt(450, 497))).toEqual([{ to: c.id, toSide: "bottom", segments: [] }]);
    expect(drag(pt(450, 450))).toEqual([{ to: c.id, toSide: "auto", segments: [] }]);
    // The same end again, near another side: only the side changes.
    expect(drag(pt(450, 3))).toEqual([{ toSide: "top" }]);
  });
});

describe("route edit helpers", () => {
  const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
  const b = obj("rect", { x: 400, y: 200, w: 100, h: 100 });

  it("sideNear finds the side anchor within the radius only", () => {
    expect(sideNear(a, { x: 50, y: 2 }, 10)).toBe("top");
    expect(sideNear(a, { x: 98, y: 50 }, 10)).toBe("right");
    expect(sideNear(a, { x: 50, y: 50 }, 10)).toBeNull();
    expect(sideNear({ ...a, rot: 90 }, anchor({ ...a, rot: 90 }, "top").point, 1)).toBe("top");
  });

  it("patches carry only what changed; reset clears edits and pins", () => {
    const conn = obj("connector", { from: a.id, to: b.id, routing: "elbow", segments: [10], fromSide: "right", toSide: "left" });
    expect(routePatch(conn, { segments: [10], fromSide: "right", toSide: "left" })).toBeNull();
    expect(routePatch(conn, { segments: [20], fromSide: "right", toSide: "left" })).toEqual({ segments: [20] });
    expect(resetRoutePatch(conn)).toEqual({ segments: [], fromSide: "auto", toSide: "auto" });
    expect(canResetRoute(conn)).toBe(true);
    const plain = obj("connector", { from: a.id, to: b.id });
    expect(resetRoutePatch(plain)).toBeNull();
    expect(canResetRoute(plain)).toBe(false);
    expect(resetRoutePatch({ ...plain, routing: "curved", curve: [0.5, 0.2] })).toEqual({ curve: null });
  });

  it("keyboard moves are exact and move a segment only across itself", () => {
    const conn = obj("connector", { from: a.id, to: b.id, routing: "elbow", fromSide: "right", toSide: "left" });
    const route = connectorRoute(conn, a, b);
    const hd = routeHandles(route).find((k) => !k.anchored);
    expect(keyboardEdit(conn, a, b, route, hd, 0, 10)).toBeNull(); // a vertical segment ignores up/down
    expect(keyboardEdit(conn, a, b, route, hd, 10, 0)).toEqual({ segments: [10], fromSide: "right", toSide: "left" });
    // Automatic sides: the edit pins the sides the route uses.
    const auto = obj("connector", { from: a.id, to: b.id, routing: "elbow" });
    const r2 = connectorRoute(auto, a, b);
    const e2 = keyboardEdit(auto, a, b, r2, routeHandles(r2)[0], 10, 10);
    expect(routePatch(auto, e2)).toMatchObject({ fromSide: r2.fromSide, toSide: r2.toSide });
  });

  it("finds handles on screen with at least a 44 px touch target", () => {
    const conn = obj("connector", { from: a.id, to: b.id, routing: "elbow", fromSide: "right", toSide: "left" });
    const h = connectorHandles(conn, (id) => ({ [a.id]: a, [b.id]: b })[id], undefined, 1);
    const hd = h.handles.find((k) => !k.anchored);
    const idx = h.handles.indexOf(hd);
    const cam = { x: 0, y: 0, zoom: 1 };
    expect(routeHandleAt(h.handles, cam, { x: hd.point.x + 20, y: hd.point.y }, 22)).toBe(idx);
    expect(routeHandleAt(h.handles, cam, { x: hd.point.x + 20, y: hd.point.y }, 9)).toBeNull();
  });

  it("route edits in presence transforms are cleaned like stored fields", () => {
    const t = routeTransform("o_000000000001", { segments: [1.234, 1e12, 5], fromSide: "top", curve: null });
    const p = cleanPresence({ transforms: [t, { ...t, segments: [Number.NaN] }, { ...t, segments: new Array(40).fill(1) }] }, "c", null);
    expect(p.transforms[0]).toMatchObject({ id: "o_000000000001", segments: [1.23, 1_000_000, 5], fromSide: "top", curve: null });
    expect(p.transforms[1].segments).toBeUndefined();
    expect(p.transforms[2].segments).toBeUndefined();
  });

  it("local undo of a first route edit restores \"no edits\" on connectors without the fields", () => {
    const old = obj("connector", { from: a.id, to: b.id, routing: "elbow" });
    expect(previousValues(old, { segments: [10], curve: [0.5, 0.5] })).toEqual({ segments: [], curve: null });
  });

  it("E starts route editing; route keys only apply in the route scope", () => {
    expect(keyAction({ key: "e" })).toEqual({ type: "editRoute" });
    expect(keyAction({ key: "Tab" }, "route")).toEqual({ type: "routeHandle", step: 1 });
    expect(keyAction({ key: "Tab", shiftKey: true }, "route")).toEqual({ type: "routeHandle", step: -1 });
    expect(keyAction({ key: "ArrowUp", shiftKey: true }, "route")).toEqual({ type: "routeMove", dx: 0, dy: -10 });
    expect(keyAction({ key: "Delete" }, "route")).toEqual({ type: "routeReset" });
    expect(keyAction({ key: "Escape" }, "route")).toEqual({ type: "routeDone" });
    expect(keyAction({ key: "Tab" })).toBeNull();
  });
});

describe("keyboard route editing in the canvas", () => {
  const key = (rig, k, extra = {}) => {
    rig.el.dispatchEvent({ type: "keydown", key: k, target: rig.el, preventDefault() {}, ...extra });
    rig.flush();
  };

  it("E, Tab and arrow keys move a segment; Delete resets; Escape finishes; straight lines refuse", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 400, y: 200, w: 100, h: 100 });
    const conn = obj("connector", { from: a.id, to: b.id, routing: "elbow", fromSide: "right", toSide: "left" });
    const straight = obj("connector", { from: b.id, to: a.id });
    const rig = canvasRig(board(a, b, conn, straight));
    try {
      const announce = vi.fn();
      rig.canvas.setSelection([conn.id]);
      rig.flush();
      expect(rig.canvas.editRoute()).toBe(true);
      rig.flush();
      expect(rig.canvas.getRouteEdit()).toEqual({ id: conn.id, index: 0 });
      // Route handles are drawn, the picked one active.
      expect(rig.el.querySelectorAll(".wb-route-handle").length).toBeGreaterThan(0);
      expect(rig.el.querySelectorAll(".wb-route-handle-active")).toHaveLength(1);
      // Tab to the middle (vertical) segment, then move it right by 10.
      const handles = connectorHandles(conn, (id) => rig.store.state.board.objects[id], undefined, 1).handles;
      const middle = handles.findIndex((k) => !k.anchored);
      for (let i = 0; i < middle; i++) key(rig, "Tab");
      expect(rig.canvas.getRouteEdit().index).toBe(middle);
      key(rig, "ArrowRight", { shiftKey: true });
      expect(rig.store.state.board.objects[conn.id].segments).toEqual([10]);
      expect(rig.store.state.board.objects[conn.id].fromSide).toBe("right");
      expect(rig.store.state.board.objects[conn.id].toSide).toBe("left");
      key(rig, "ArrowRight");
      expect(rig.store.state.board.objects[conn.id].segments).toEqual([11]);
      expect(rig.canvas.getRouteEdit()).not.toBeNull();
      key(rig, "Delete");
      expect(rig.store.state.board.objects[conn.id]).toMatchObject({ segments: [], fromSide: "auto", toSide: "auto" });
      expect(rig.store.state.board.objects[conn.id]).toBeDefined(); // Delete resets, never deletes
      key(rig, "Escape");
      expect(rig.canvas.getRouteEdit()).toBeNull();
      expect(rig.canvas.getSelection()).toEqual([conn.id]); // Escape only left route editing
      expect(rig.canvas.editRoute(straight.id)).toBe(false);
      void announce;
    } finally {
      rig.destroy();
    }
  });

  it("reset route clears edits of every selected connector in one update", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 400, y: 200, w: 100, h: 100 });
    const c1 = obj("connector", { from: a.id, to: b.id, routing: "elbow", segments: [5], fromSide: "right", toSide: "left" });
    const c2 = obj("connector", { from: b.id, to: a.id, routing: "curved", curve: [0.5, 0.3] });
    const rig = canvasRig(board(a, b, c1, c2));
    try {
      const spy = vi.spyOn(rig.store, "updateObjects");
      expect(rig.canvas.resetRoute([c1.id, c2.id, a.id])).toBe(2);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(rig.store.state.board.objects[c2.id].curve).toBeNull();
    } finally {
      rig.destroy();
    }
  });
});

describe("spatial index: automatic elbows follow obstacles", () => {
  it("re-routes exactly the elbows whose route region an obstacle enters or leaves", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 600, y: 0, w: 100, h: 100 });
    const far1 = obj("rect", { x: 0, y: 5000, w: 100, h: 100 });
    const far2 = obj("rect", { x: 600, y: 5000, w: 100, h: 100 });
    const elbow = obj("connector", { from: a.id, to: b.id, routing: "elbow", fromSide: "right", toSide: "left" });
    const straight = obj("connector", { from: a.id, to: b.id });
    const other = obj("connector", { from: far1.id, to: far2.id, routing: "elbow" });
    const block = obj("sticky", { x: 300, y: 3000, w: 100, h: 100 });
    const all = board(a, b, far1, far2, elbow, straight, other, block);
    const index = new SpatialIndex();
    index.reset(all);
    const before = index.bounds(elbow.id);
    // Move the sticky between a and b: the elbow re-routes (its bounds grow), nothing else does.
    all[block.id] = { ...block, y: -20 };
    const done = index.update([block.id], all);
    expect([...done].sort()).toEqual([block.id, elbow.id].sort());
    expect(index.stats.rerouted).toBe(1);
    expect(index.bounds(elbow.id).h).toBeGreaterThan(before.h);
    expect(index.verify()).toEqual({ missing: [], extra: [], stale: [] });
    // Move it away again: the elbow goes back to the simple route.
    all[block.id] = { ...block, y: 3000 };
    expect([...index.update([block.id], all)].sort()).toEqual([block.id, elbow.id].sort());
    expect(index.bounds(elbow.id)).toEqual(before);
    // Delete it: nothing to re-route (it was far away).
    delete all[block.id];
    expect([...index.update([block.id], all)]).toEqual([block.id]);
    expect(index.verify()).toEqual({ missing: [], extra: [], stale: [] });
    // The index's routes match a plain obstacle source over the same board.
    const env = createRouteEnv(all);
    expect(connectorRoute(elbow, a, b, env).points).toEqual(connectorRoute(elbow, a, b, index.routeEnv((id) => all[id])).points);
  });
});
