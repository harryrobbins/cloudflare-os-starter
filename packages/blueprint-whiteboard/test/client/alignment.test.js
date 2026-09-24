// Alignment guides and snapping, Align / Distribute, and connector endpoint editing: the pure
// geometry (src/client/model/alignment.js), the update builders (src/client/ui/canvas/model.js),
// the drag / resize / endpoint gestures against a fake store, and the same commands against the
// real core over a simulated network (one undo, concurrent edits, invalid_ref stays authoritative).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TYPE_DEFAULTS } from "../../src/shared/protocol.js";
import { rotatedBounds } from "../../src/shared/geometry.js";
import {
  snapMove, snapResize, alignDeltas, distributeDeltas, SNAP_PX, ALIGN_LABELS, DISTRIBUTE_LABELS,
} from "../../src/client/model/alignment.js";
import {
  arrangeUnits, alignUpdates, distributeUpdates, snapTargets, validEndpoint, reconnectUpdate,
} from "../../src/client/ui/canvas/model.js";
import {
  endpointHandlePositions, endpointForPress, endpointRadius, ENDPOINT_TOUCH_RADIUS,
} from "../../src/client/ui/canvas/handles.js";
import { worldToScreen } from "../../src/client/ui/canvas/camera.js";
import { reconnectOptions, filterOptions } from "../../src/client/ui/object-picker.js";
import { alignMessage, distributeMessage, arrangeAvailability } from "../../src/client/ui/arrange.js";
import { Net } from "./net.js";

let seq = 0;
const nid = () => "o_" + (0x300000000000 + ++seq).toString(16).slice(-12);

/** @returns {any} */
function obj(type, fields = {}) {
  const d = TYPE_DEFAULTS[type];
  const o = {
    id: fields.id ?? nid(), type, x: 0, y: 0, w: d.w, h: d.h, rot: 0, z: "a0", frameId: null, text: d.text,
    style: { ...d.style }, version: 1, createdAt: 0, updatedAt: 0, createdBy: "t", ...fields,
  };
  if (type === "pen" && !o.points) o.points = [0, 0, 1, 1];
  if (type === "connector") Object.assign(o, { x: 0, y: 0, w: 1, h: 1, fromSide: "auto", toSide: "auto", routing: "straight", ...fields });
  return o;
}
const board = (...list) => Object.fromEntries(list.map((o) => [o.id, o]));
const R = (x, y, w, h) => ({ x, y, w, h });

describe("snapMove", () => {
  const targets = [R(100, 100, 100, 50), R(400, 300, 60, 60)];

  it("snaps edges and centres to the nearest line within the threshold, per axis", () => {
    // Left edge 3 units right of the target's left edge; top 2 below its bottom.
    const s = snapMove(R(103, 152, 40, 40), targets, { threshold: 6 });
    expect(s.dx).toBe(-3);
    expect(s.dy).toBe(-2);
    // Centre to centre: box centre x = 147 -> target centre 150.
    const c = snapMove(R(127, 500, 40, 40), targets, { threshold: 6 });
    expect(c.dx).toBe(3);
    expect(c.dy).toBe(0);
    // Right edge to right edge with mixed sizes.
    const r = snapMove(R(262, 0, 200, 10), targets, { threshold: 6 });
    expect(r.dx).toBe(-2); // 462 -> 460
  });

  it("returns only the winning vertical and horizontal guides, spanning what they align", () => {
    const s = snapMove(R(103, 152, 40, 40), [...targets, R(100, 800, 200, 10)], { threshold: 6 });
    expect(s.guides).toHaveLength(2);
    const v = s.guides.find((g) => g.axis === "x");
    const hz = s.guides.find((g) => g.axis === "y");
    expect(v).toMatchObject({ x: 100, y1: 100, y2: 810 });
    expect(hz).toMatchObject({ y: 150, x1: 100, x2: 200 });
    expect(snapMove(R(1000, 1000, 10, 10), targets, { threshold: 6 })).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("is zoom invariant in screen pixels: SNAP_PX / zoom world units", () => {
    for (const zoom of [0.25, 1, 4, 16]) {
      const threshold = SNAP_PX / zoom;
      const within = (SNAP_PX - 1) / zoom, beyond = (SNAP_PX + 1) / zoom;
      const wide = [R(100, 100, 1000, 50)];
      expect(snapMove(R(100 + within, 1000, 3000, 10), wide, { threshold }).dx).toBeCloseTo(-within);
      expect(snapMove(R(100 + beyond, 1000, 3000, 10), wide, { threshold }).dx).toBe(0);
    }
  });

  it("uses rotated bounds of rotated targets", () => {
    const rotated = obj("rect", { x: 0, y: 0, w: 200, h: 100, rot: 90 });
    const b = rotatedBounds(rotated); // 50..150 x -50..150
    const s = snapMove(R(b.x + b.w + 4, 500, 10, 10), [b], { threshold: 6 });
    expect(s.dx).toBeCloseTo(-4);
  });

  it("snaps to the grid only on an axis with no object snap, and draws no grid guide", () => {
    const s = snapMove(R(49, 1015, 10, 10), [R(0, 0, 10, 10)], { threshold: 3, grid: 24 });
    expect(s.dx).toBe(-1); // 49 -> 48
    expect(s.dy).toBe(0); // 1015, 1020 and 1025 are all over 3 from 1008 and 1032
    expect(s.guides).toEqual([]);
    const both = snapMove(R(47, 0, 10, 10), [R(45, 400, 10, 10)], { threshold: 3, grid: 24 });
    expect(both.dx).toBe(-2); // the object line (45) wins over the grid line (48)
  });
});

describe("snapResize", () => {
  it("snaps only the edges the handle moves and keeps a minimum size", () => {
    const targets = [R(300, 0, 100, 100)];
    const e = snapResize(R(0, 0, 297, 50), "e", targets, { threshold: 6 });
    expect(e.box).toEqual(R(0, 0, 300, 50));
    expect(e.guides).toHaveLength(1);
    const w = snapResize(R(303, 200, 50, 50), "w", targets, { threshold: 6 });
    expect(w.box).toEqual(R(300, 200, 53, 50));
    const se = snapResize(R(0, 0, 348, 98), "se", targets, { threshold: 6 });
    expect(se.box).toEqual(R(0, 0, 350, 100));
    expect(se.guides.map((g) => g.axis).sort()).toEqual(["x", "y"]);
    // Snapping would make the box narrower than minSize: no snap.
    expect(snapResize(R(298, 0, 4, 10), "w", targets, { threshold: 6, minSize: 8 }).box).toEqual(R(298, 0, 4, 10));
    expect(snapResize(R(0, 0, 200, 50), "n", targets, { threshold: 6 }).box).toEqual(R(0, 0, 200, 50));
  });
});

describe("Align and Distribute", () => {
  it("aligns units to the selection's edges and centres", () => {
    const units = [{ id: "a", rect: R(0, 0, 100, 50) }, { id: "b", rect: R(300, 100, 50, 150) }];
    expect(alignDeltas(units, "left").get("b")).toEqual({ dx: -300, dy: 0 });
    expect(alignDeltas(units, "right").get("a")).toEqual({ dx: 250, dy: 0 });
    expect(alignDeltas(units, "center").get("a")).toEqual({ dx: 125, dy: 0 });
    expect(alignDeltas(units, "top").get("b")).toEqual({ dx: 0, dy: -100 });
    expect(alignDeltas(units, "bottom").get("a")).toEqual({ dx: 0, dy: 200 });
    expect(alignDeltas(units, "middle").get("b")).toEqual({ dx: 0, dy: -50 });
    expect(alignDeltas(units.slice(0, 1), "left").size).toBe(0);
  });

  it("distributes by geometry with equal gaps, first and last fixed", () => {
    const units = [
      { id: "c", rect: R(500, 0, 100, 10) },
      { id: "a", rect: R(0, 0, 100, 10) },
      { id: "b", rect: R(120, 0, 50, 10) },
      { id: "d", rect: R(200, 0, 10, 10) },
    ];
    const d = distributeDeltas(units, "horizontal");
    expect(d.get("a")).toEqual({ dx: 0, dy: 0 });
    expect(d.get("c")).toEqual({ dx: 0, dy: 0 });
    // span 600, widths 260, gap (600 - 260) / 3 = 113.33
    const gap = 340 / 3;
    expect(d.get("b").dx).toBeCloseTo(100 + gap - 120);
    expect(d.get("d").dx).toBeCloseTo(100 + gap + 50 + gap - 200);
    expect(distributeDeltas(units.slice(0, 2), "vertical").size).toBe(0);
  });

  it("builds one batch; a selected frame brings its members and counts once", () => {
    const f = obj("frame", { x: 0, y: 0, w: 400, h: 400 });
    const m = obj("sticky", { x: 10, y: 10, frameId: f.id });
    const other = obj("rect", { x: 600, y: 700, w: 100, h: 100 });
    const conn = obj("connector", { from: m.id, to: other.id });
    const all = board(f, m, other, conn);
    expect(arrangeUnits(all, [f.id, m.id, conn.id, other.id]).map((u) => u.id)).toEqual([f.id, other.id]);
    const updates = alignUpdates(all, [f.id, m.id, other.id, conn.id], "top");
    expect(updates).toEqual([{ id: other.id, patch: { y: 0 } }]);
    const bottom = alignUpdates(all, [f.id, other.id], "bottom");
    expect(bottom.map((u) => u.id).sort()).toEqual([f.id, m.id].sort());
    expect(bottom.find((u) => u.id === m.id).patch).toEqual({ y: 410 });
  });

  it("updates frame membership when an aligned object's centre lands in a frame", () => {
    const f = obj("frame", { x: 0, y: 0, w: 400, h: 400 });
    const a = obj("rect", { x: 50, y: 50, w: 100, h: 100 });
    const b = obj("rect", { x: 50, y: 900, w: 100, h: 100 });
    const all = board(f, a, b);
    const up = alignUpdates(all, [a.id, b.id], "top");
    expect(up).toEqual([{ id: b.id, patch: { y: 50, frameId: f.id } }]);
  });

  it("aligns rotated objects by their rotated bounds", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const r = obj("rect", { x: 300, y: 0, w: 200, h: 100, rot: 90 }); // bounds x 350..450
    const [u] = alignUpdates(board(a, r), [a.id, r.id], "left");
    expect(u).toEqual({ id: r.id, patch: { x: -50 } }); // its bounds' left edge (350) moves to 0
  });

  it("names every command for buttons, menus and announcements", () => {
    expect(Object.keys(ALIGN_LABELS)).toHaveLength(6);
    expect(Object.keys(DISTRIBUTE_LABELS)).toHaveLength(2);
    expect(alignMessage("left", 2)).toBe("Aligned left edges, 2 objects moved");
    expect(alignMessage("middle", 0)).toBe("Already aligned");
    expect(distributeMessage("vertical", 1)).toBe("Distributed vertically, 1 object moved");
    const a = obj("rect"), b = obj("rect"), c = obj("rect");
    const conn = obj("connector", { from: a.id, to: b.id });
    const all = board(a, b, c, conn);
    expect(arrangeAvailability(all, [a.id])).toEqual({ align: false, distribute: false, reconnect: false });
    expect(arrangeAvailability(all, [a.id, b.id, conn.id])).toEqual({ align: true, distribute: false, reconnect: false });
    expect(arrangeAvailability(all, [a.id, b.id, c.id])).toEqual({ align: true, distribute: true, reconnect: false });
    expect(arrangeAvailability(all, [conn.id])).toEqual({ align: false, distribute: false, reconnect: true });
  });
});

describe("connector endpoints", () => {
  it("validates targets: no connectors, no self-links, frames allowed", () => {
    const a = obj("rect"), b = obj("rect"), f = obj("frame");
    const conn = obj("connector", { from: a.id, to: b.id });
    const other = obj("connector", { from: a.id, to: f.id });
    expect(validEndpoint(conn, "from", f)).toBe(true);
    expect(validEndpoint(conn, "from", b)).toBe(false); // the other end: a self-link
    expect(validEndpoint(conn, "to", a)).toBe(false);
    expect(validEndpoint(conn, "to", other)).toBe(false);
    expect(validEndpoint(conn, "to", conn)).toBe(false);
    expect(validEndpoint(conn, "to", undefined)).toBe(false);
    expect(reconnectUpdate(conn, "from", a)).toBeNull(); // unchanged
    expect(reconnectUpdate(conn, "to", f)).toEqual({ id: conn.id, patch: { to: f.id } });
  });

  it("places handles on the route ends; touch gets at least a 44 px target", () => {
    const cam = { x: -10, y: -20, zoom: 2 };
    const route = [{ x: 0, y: 0 }, { x: 100, y: 50 }];
    const hs = endpointHandlePositions(route, cam);
    expect(hs).toEqual([{ name: "from", ...worldToScreen(cam, route[0]) }, { name: "to", ...worldToScreen(cam, route[1]) }]);
    expect(endpointHandlePositions(null, cam)).toEqual([]);
    const end = worldToScreen(cam, route[1]);
    expect(endpointForPress(route, cam, { x: end.x + 3, y: end.y }, 8)).toBe("to");
    expect(endpointForPress(route, cam, { x: end.x + 15, y: end.y }, 8)).toBeNull();
    expect(endpointRadius(18, "touch")).toBe(ENDPOINT_TOUCH_RADIUS);
    expect(ENDPOINT_TOUCH_RADIUS * 2).toBeGreaterThanOrEqual(44);
    expect(endpointForPress(route, cam, { x: end.x + 20, y: end.y }, endpointRadius(18, "touch"))).toBe("to");
    expect(endpointRadius(8, "mouse")).toBe(8);
  });

  it("the keyboard picker lists every other non-connector object, marks the current end and filters", () => {
    const a = obj("sticky", { text: "Alpha", z: "a1" });
    const b = obj("rect", { text: "Beta", z: "a2" });
    const f = obj("frame", { text: "Plan", z: "a0" });
    const conn = obj("connector", { from: a.id, to: b.id, z: "a3" });
    const all = board(a, b, f, conn);
    const opts = reconnectOptions(all, conn, "to");
    expect(opts.map((o) => o.id)).toEqual([b.id, f.id]); // not a (self-link), not the connector
    expect(opts[0]).toMatchObject({ current: true });
    expect(opts[0].label).toContain("(current)");
    expect(opts[1].label).toBe("Frame: Plan");
    expect(filterOptions(opts, "fram pl").map((o) => o.id)).toEqual([f.id]);
    expect(filterOptions(opts, "  ")).toBe(opts);
    expect(filterOptions(opts, "zzz")).toEqual([]);
  });
});

describe("gestures: snapping and endpoint drags", () => {
  /** @type {typeof import("../../src/client/ui/canvas/gestures.js")} */
  let G;
  beforeAll(async () => {
    const fakeEl = () => ({
      setAttribute() {}, removeAttribute() {}, remove() {}, appendChild() {}, append() {},
      classList: { add() {}, remove() {} }, textContent: "",
    });
    globalThis.document ??= /** @type {any} */ ({ createElementNS: () => fakeEl() });
    G = await import("../../src/client/ui/canvas/gestures.js");
  });

  function setup(objects, { zoom = 1, grid = 0 } = {}) {
    const calls = [];
    const state = { board: { objects } };
    const overlays = [];
    const store = {
      getState: () => state,
      updateObjects: vi.fn((u) => calls.push(["update", u])),
      createObjects: vi.fn((list) => { calls.push(["create", list]); return list.map((_o, i) => `o_00000000000${i}`); }),
      setPresence: vi.fn((p) => calls.push(["presence", p])),
      flushPresence: vi.fn(() => calls.push(["flush"])),
    };
    let selection = [];
    const overrides = new Map();
    const ctx = {
      store, element: { classList: { add() {}, remove() {} } },
      objects: () => state.board.objects,
      resolve: (i) => {
        const o = state.board.objects[i];
        const ov = overrides.get(i);
        return o && ov ? { ...o, ...ov.geom } : o;
      },
      sorted: () => Object.values(state.board.objects),
      camera: () => ({ x: 0, y: 0, zoom }),
      layer: { translate() {}, rerender() {}, connectorsOf: () => new Set() },
      overrides, preview: { appendChild() {} },
      getSelection: () => [...selection], setSelection: (ids) => { selection = ids; },
      schedule() {}, setCameraByUser: vi.fn(), setOverlay: (patch) => overlays.push(patch),
      toolStyle: () => ({}), finishCreate: vi.fn(), editText: vi.fn(), contextMenu: vi.fn(),
      registerClick: vi.fn(() => false), announceSelection() {}, announce: vi.fn(),
      snapOptions: () => ({ threshold: SNAP_PX / zoom, grid }),
      snapTargets: (moving) => snapTargets(state.board.objects, Object.keys(state.board.objects), moving),
    };
    return { ctx, store, calls, overlays, state };
  }
  const pt = (x, y, extra = {}) => ({ sx: x, sy: y, x, y, shift: false, alt: false, clientX: x, clientY: y, pointerType: "mouse", time: 0, ...extra });
  const lastGuides = (overlays) => overlays.filter((o) => "guides" in o).at(-1)?.guides;

  it("a drag snaps the moving set to another object's edge and shows the guide", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 300, y: 500, w: 100, h: 100 });
    const { ctx, calls, overlays } = setup(board(a, b));
    const g = G.objectPressGesture(ctx, pt(50, 50), a);
    g.move(pt(354, 150)); // a.x -> 304, 4 from b.x = 300
    g.frame();
    expect(lastGuides(overlays)).toEqual([expect.objectContaining({ axis: "x", x: 300 })]);
    g.up(pt(354, 150));
    expect(calls.find((c) => c[0] === "update")[1]).toEqual([{ id: a.id, patch: { x: 300, y: 100 } }]);
    expect(lastGuides(overlays)).toEqual([]);
  });

  it("holding Alt bypasses snapping, also when pressed mid-drag without moving", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 300, y: 500, w: 100, h: 100 });
    const { ctx, calls } = setup(board(a, b));
    const g = G.objectPressGesture(ctx, pt(50, 50), a);
    g.move(pt(354, 150, { alt: true }));
    g.up(pt(354, 150, { alt: true }));
    expect(calls.find((c) => c[0] === "update")[1]).toEqual([{ id: a.id, patch: { x: 304, y: 100 } }]);
    const { ctx: ctx2, overlays } = setup(board(obj("rect", { id: a.id, x: 0, y: 0, w: 100, h: 100 }), b));
    const g2 = G.objectPressGesture(ctx2, pt(50, 50), ctx2.objects()[a.id]);
    g2.move(pt(354, 150));
    g2.frame();
    expect(lastGuides(overlays)).toHaveLength(1);
    g2.setAlt(true);
    g2.frame();
    expect(lastGuides(overlays)).toEqual([]);
    g2.cancel();
  });

  it("never snaps to the moving set: a frame's members move with it", () => {
    const f = obj("frame", { x: 0, y: 0, w: 1000, h: 1000 });
    const m = obj("sticky", { x: 10, y: 10, frameId: f.id });
    const { ctx, calls } = setup(board(f, m));
    const g = G.objectPressGesture(ctx, pt(0, 500), f);
    g.move(pt(13, 500)); // f.x -> 13, 3 away from m.x (10) — but m moves too
    g.up(pt(13, 500));
    const updates = calls.find((c) => c[0] === "update")[1];
    expect(updates.find((u) => u.id === f.id).patch).toEqual({ x: 13, y: 0 });
  });

  it("the snap distance is the same on screen at any zoom", () => {
    for (const zoom of [0.5, 4]) {
      const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
      const b = obj("rect", { x: 300, y: 500, w: 100, h: 100 });
      const { ctx, calls } = setup(board(a, b), { zoom });
      const g = G.objectPressGesture(ctx, pt(50, 50, { sx: 0, sy: 0 }), a);
      // 5 screen px from b's left edge, whatever the zoom.
      const x = 50 + 300 + 5 / zoom;
      g.move(pt(x, 50, { sx: 100, sy: 0 }));
      g.up(pt(x, 50, { sx: 100, sy: 0 }));
      expect(calls.find((c) => c[0] === "update")[1][0].patch.x).toBe(300);
    }
  });

  it("multi-select snaps the union box", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 200, y: 0, w: 100, h: 100 });
    const t = obj("rect", { x: 0, y: 500, w: 50, h: 50 });
    const { ctx, calls } = setup(board(a, b, t));
    ctx.setSelection([a.id, b.id]);
    const g = G.objectPressGesture(ctx, pt(50, 50), a);
    // Union 0..300 wide; centre 150 + dx should snap to t's right edge (50) at dx = -98 -> -100.
    g.move(pt(-48, 50));
    g.up(pt(-48, 50));
    const ups = calls.find((c) => c[0] === "update")[1];
    expect(ups.map((u) => u.patch.x).sort((p, q) => p - q)).toEqual([-100, 100]);
  });

  it("snaps to the grid when the board shows one", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const { ctx, calls } = setup(board(a), { grid: 24 });
    const g = G.objectPressGesture(ctx, pt(50, 50), a);
    g.move(pt(97, 50)); // x 47 -> 48
    g.up(pt(97, 50));
    expect(calls.find((c) => c[0] === "update")[1][0].patch).toEqual({ x: 48, y: 0 });
  });

  it("resize snaps the dragged edge, not with Shift, Alt or rotation", () => {
    const r = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const t = obj("rect", { x: 250, y: 400, w: 50, h: 50 });
    const { ctx, calls, overlays } = setup(board(r, t));
    const g = G.handleGesture(ctx, pt(100, 50), r.id, "e");
    g.move(pt(247, 50));
    g.frame();
    expect(lastGuides(overlays)).toEqual([expect.objectContaining({ axis: "x", x: 250 })]);
    g.up(pt(247, 50));
    expect(calls.find((c) => c[0] === "update")[1]).toEqual([{ id: r.id, patch: { w: 250 } }]);
    for (const extra of [{ alt: true }, { shift: true }]) {
      const s = setup(board(r, t));
      const h = G.handleGesture(s.ctx, pt(100, 50), r.id, "e");
      h.move(pt(247, 50, extra));
      h.up(pt(247, 50, extra));
      expect(s.calls.find((c) => c[0] === "update")[1][0].patch.w).not.toBe(250);
    }
    const rotated = obj("rect", { x: 0, y: 0, w: 100, h: 100, rot: 10 });
    const s = setup(board(rotated, t));
    const h = G.handleGesture(s.ctx, pt(100, 50), rotated.id, "e");
    h.move(pt(247, 50));
    h.up(pt(247, 50));
    expect(s.calls.find((c) => c[0] === "update")[1][0].patch.w).not.toBe(250);
  });

  it("endpoint drag reconnects only that end; empty space, self-links and connectors cancel", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 300, y: 0, w: 100, h: 100 });
    const c = obj("ellipse", { x: 0, y: 300, w: 100, h: 100 });
    const f = obj("frame", { x: 600, y: 600, w: 300, h: 300 });
    const conn = obj("connector", { from: a.id, to: b.id, text: "label", routing: "elbow", fromSide: "right", style: { ...TYPE_DEFAULTS.connector.style, stroke: "#dc2626" } });
    const conn2 = obj("connector", { from: c.id, to: f.id });
    const { ctx, calls, overlays } = setup(board(a, b, c, f, conn, conn2));
    const drag = (end, to) => {
      calls.length = 0;
      const g = G.endpointGesture(ctx, pt(400, 50), conn.id, end);
      g.move(to);
      g.frame();
      g.up(to);
      return calls.filter((x) => x[0] === "update");
    };
    // Onto an object: only `to` changes.
    expect(drag("to", pt(50, 350))).toEqual([["update", [{ id: conn.id, patch: { to: c.id } }]]]);
    expect(overlays.some((o) => o.hoverId === c.id)).toBe(true);
    expect(overlays.at(-1)).toEqual({ hoverId: null });
    // Onto a frame's border: valid.
    expect(drag("to", pt(600, 700))).toEqual([["update", [{ id: conn.id, patch: { to: f.id } }]]]);
    // Empty space, the other endpoint (self-link) and the connector's own current end: nothing.
    expect(drag("to", pt(2000, 2000))).toEqual([]);
    expect(drag("to", pt(50, 50))).toEqual([]);
    expect(drag("from", pt(350, 50))).toEqual([]);
    expect(ctx.announce).toHaveBeenCalledWith("Connector not changed");
    // A press without a drag changes nothing.
    calls.length = 0;
    G.endpointGesture(ctx, pt(400, 50), conn.id, "to").up(pt(400, 50));
    expect(calls).toEqual([]);
  });

  it("endpoint drag: the connector or the target deleted during the drag changes nothing", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 300, y: 0, w: 100, h: 100 });
    const c = obj("rect", { x: 0, y: 300, w: 100, h: 100 });
    const conn = obj("connector", { from: a.id, to: b.id });
    const { ctx, calls, state } = setup(board(a, b, c, conn));
    const g = G.endpointGesture(ctx, pt(400, 50), conn.id, "to");
    g.move(pt(50, 350));
    g.frame();
    const { [c.id]: _gone, ...rest } = state.board.objects;
    state.board.objects = rest;
    g.up(pt(50, 350));
    expect(calls.filter((x) => x[0] === "update")).toEqual([]);
    const g2 = G.endpointGesture(ctx, pt(400, 50), conn.id, "to");
    g2.move(pt(50, 50));
    const { [conn.id]: _c, ...rest2 } = state.board.objects;
    state.board.objects = rest2;
    g2.frame();
    g2.up(pt(50, 50));
    expect(calls.filter((x) => x[0] === "update")).toEqual([]);
  });
});

describe("against the real core", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const tick = (ms) => vi.advanceTimersByTimeAsync(ms);

  it("Align is one request and one undo step; concurrent moves rebase and converge", async () => {
    const net = new Net({ rng: () => 0.5, minLat: 0, maxLat: 50 });
    const a = await net.startStore("a");
    const b = await net.startStore("b");
    await tick(200);
    const ids = a.createObjects([
      { type: "rect", x: 0, y: 0, w: 100, h: 100 },
      { type: "rect", x: 300, y: 70, w: 100, h: 100 },
      { type: "rect", x: 600, y: 150, w: 100, h: 100 },
    ]);
    await tick(400);
    const before = net.calls.length;
    a.updateObjects(alignUpdates(a.getState().board.objects, ids, "top"));
    // b moves the middle one down at the same time.
    b.updateObjects([{ id: ids[1], patch: { y: 90 } }]);
    await tick(2000);
    const server = await net.board.getBoard();
    // The first request carries the whole command (the rect already at the top needs no op).
    const first = net.calls.slice(before).find((c) => c.method === "applyOperation" && c.name === "a");
    expect(first.args[0].objectOps.map((op) => op.id).sort()).toEqual([ids[1], ids[2]].sort());
    expect(server.objects[ids[0]].y).toBe(0);
    expect(server.objects[ids[2]].y).toBe(0);
    expect(server.objects[ids[1]].y).toBe(20); // a's -70 on top of b's +20
    for (const s of [a, b]) expect(s.getState().board.objects).toEqual(server.objects);
    a.undo();
    await tick(1000);
    const after = await net.board.getBoard();
    // One undo restores every object the command moved (to the values this viewer last saw).
    expect([after.objects[ids[0]].y, after.objects[ids[1]].y, after.objects[ids[2]].y]).toEqual([0, 70, 150]);
  });

  it("Distribute sends one applyOperation for the whole selection", async () => {
    const net = new Net({ rng: () => 0.5, minLat: 0, maxLat: 0 });
    const a = await net.startStore("a");
    await tick(200);
    const ids = a.createObjects([0, 50, 400, 1000].map((x) => ({ type: "rect", x, y: 0, w: 100, h: 100 })));
    await tick(400);
    const count = () => net.calls.filter((c) => c.method === "applyOperation").length;
    const n = count();
    a.updateObjects(distributeUpdates(a.getState().board.objects, ids, "horizontal"));
    await tick(500);
    expect(count() - n).toBe(1);
    const server = await net.board.getBoard();
    expect(ids.map((id) => server.objects[id].x)).toEqual([0, 333.33, 666.67, 1000]);
  });

  it("reconnecting to an object someone deleted meanwhile is refused (invalid_ref) and rolled back", async () => {
    const net = new Net({ rng: () => 0.5, minLat: 20, maxLat: 20 });
    const a = await net.startStore("a");
    const b = await net.startStore("b");
    await tick(200);
    const [x, y, z] = a.createObjects([
      { type: "rect", x: 0, y: 0 }, { type: "rect", x: 400, y: 0 }, { type: "rect", x: 0, y: 400 },
    ]);
    const [conn] = a.createObjects([{ type: "connector", from: x, to: y, text: "keep me", routing: "elbow" }]);
    await tick(500);
    const flashes = [];
    a.subscribe((_s, c) => { if (c.kind === "flash") flashes.push(...c.objects); });
    b.deleteObjects([z]);
    const update = reconnectUpdate(a.getState().board.objects[conn], "to", a.getState().board.objects[z]);
    a.updateObjects([update]);
    await tick(2000);
    const server = await net.board.getBoard();
    expect(server.objects[conn]).toMatchObject({ from: x, to: y, text: "keep me", routing: "elbow" });
    const refused = net.calls.filter((c) => c.name === "a" && c.method === "applyOperation" && c.args[0].objectOps.some((op) => op.patch?.to === z));
    expect(refused.length).toBeGreaterThan(0); // it did reach the server, which refused it
    // A race, not a mistake: the connector reverts and flashes (the app announces why).
    expect(flashes).toContain(conn);
    for (const s of [a, b]) expect(s.getState().board.objects).toEqual(server.objects);
  });
});
