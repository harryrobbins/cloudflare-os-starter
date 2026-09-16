// Pure logic of the canvas (src/client/ui/canvas): camera math, handles, hit testing, frame
// membership, move/duplicate payloads, keyboard mapping, text editor geometry and the gesture
// state machine against a fake store. No DOM: the few elements gestures create use a stub.
import { describe, it, expect, beforeAll, vi } from "vitest";
import { TYPE_DEFAULTS, ZOOM_MAX, ZOOM_MIN, LIMITS } from "../../src/shared/protocol.js";
import { rotatePoint, center, textObjectHeight } from "../../src/shared/geometry.js";
import {
  screenToWorld, worldToScreen, zoomAt, panBy, clampZoom, viewportOf, fitRect, revealRect, gridSpacing,
  lerpCamera, wheelZoomFactor, cameraTransform,
} from "../../src/client/ui/canvas/camera.js";
import {
  hitObject, topObjectAt, objectsInRect, frameAtPoint, expandMoveIds, moveUpdates, buildDuplicates,
  creationBox, validIds, withFrameMembership,
} from "../../src/client/ui/canvas/model.js";
import { handlePositions, handleAt, resizeBox, rotationToward, cursorForHandle } from "../../src/client/ui/canvas/handles.js";
import { keyAction } from "../../src/client/ui/canvas/keymap.js";
import { editorBox, textPatch } from "../../src/client/ui/canvas/text-editor.js";

let seq = 0;
const id = () => "o_" + (++seq).toString(16).padStart(12, "0");

/** @returns {any} */
function obj(type, fields = {}) {
  const d = TYPE_DEFAULTS[type];
  const o = {
    id: fields.id ?? id(), type, x: 0, y: 0, w: d.w, h: d.h, rot: 0, z: "a0", frameId: null, text: d.text,
    style: { ...d.style }, version: 1, createdAt: 0, updatedAt: 0, createdBy: "t", ...fields,
  };
  if (type === "pen" && !o.points) o.points = [0, 0, 1, 1];
  if (type === "connector") Object.assign(o, { x: 0, y: 0, w: 1, h: 1, fromSide: "auto", toSide: "auto", routing: "straight", ...fields });
  return o;
}
const board = (...list) => Object.fromEntries(list.map((o) => [o.id, o]));

describe("camera", () => {
  it("round-trips screen and world coordinates", () => {
    const cam = { x: 100, y: -50, zoom: 2.5 };
    const w = screenToWorld(cam, { x: 30, y: 40 });
    expect(worldToScreen(cam, w)).toEqual({ x: 30, y: 40 });
  });

  it("zooms about a screen point, keeping the world point under it fixed", () => {
    const cam = { x: 10, y: 20, zoom: 1 };
    const s = { x: 200, y: 150 };
    const before = screenToWorld(cam, s);
    const next = zoomAt(cam, s, 3);
    expect(next.zoom).toBe(3);
    const after = screenToWorld(next, s);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps zoom", () => {
    expect(clampZoom(1000)).toBe(ZOOM_MAX);
    expect(clampZoom(0)).toBe(ZOOM_MIN);
    expect(clampZoom(NaN)).toBe(1);
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0 }, 99).zoom).toBe(ZOOM_MAX);
  });

  it("pans so content follows the pointer", () => {
    const cam = { x: 0, y: 0, zoom: 2 };
    const w = screenToWorld(cam, { x: 50, y: 50 });
    const next = panBy(cam, 20, -10);
    const s = worldToScreen(next, w);
    expect(s.x).toBeCloseTo(70);
    expect(s.y).toBeCloseTo(40);
  });

  it("computes the viewport and fits rects", () => {
    expect(viewportOf({ x: 5, y: 6, zoom: 2 }, 800, 600)).toEqual({ x: 5, y: 6, w: 400, h: 300 });
    const cam = fitRect({ x: 0, y: 0, w: 1000, h: 500 }, 1040, 580, { padding: 20 });
    expect(cam.zoom).toBeCloseTo(1);
    const capped = fitRect({ x: 0, y: 0, w: 10, h: 10 }, 800, 600, { maxZoom: 1 });
    expect(capped.zoom).toBe(1);
  });

  it("reveals a rect by panning when it fits at the current zoom", () => {
    const cam = { x: 0, y: 0, zoom: 1 };
    expect(revealRect(cam, { x: 100, y: 100, w: 50, h: 50 }, 800, 600)).toBe(cam);
    const moved = revealRect(cam, { x: 2000, y: 2000, w: 100, h: 100 }, 800, 600);
    expect(moved.zoom).toBe(1);
    const vp = viewportOf(moved, 800, 600);
    expect(vp.x + vp.w / 2).toBeCloseTo(2050);
    const out = revealRect(cam, { x: 0, y: 0, w: 5000, h: 100 }, 800, 600);
    expect(out.zoom).toBeLessThan(1);
  });

  it("interpolates cameras ending exactly at the target", () => {
    const a = { x: 0, y: 0, zoom: 1 }, b = { x: 100, y: 50, zoom: 4 };
    expect(lerpCamera(a, b, 1, 800, 600)).toEqual(b);
    const mid = lerpCamera(a, b, 0.5, 800, 600);
    expect(mid.zoom).toBeCloseTo(2);
  });

  it("keeps background spacing readable and wheel zoom bounded", () => {
    expect(gridSpacing(1)).toBe(24);
    expect(gridSpacing(0.1)).toBeGreaterThanOrEqual(12);
    expect(wheelZoomFactor(100, false)).toBeLessThan(1);
    expect(wheelZoomFactor(-100, true)).toBeGreaterThan(1);
    expect(wheelZoomFactor(1e9, false)).toBeGreaterThan(0.5);
    expect(cameraTransform({ x: 10, y: 5, zoom: 2 })).toBe("matrix(2 0 0 2 -20 -10)");
  });
});

describe("handles", () => {
  it("places 8 resize handles plus rotate for rotatable objects, none for connectors", () => {
    const cam = { x: 0, y: 0, zoom: 1 };
    expect(handlePositions(obj("sticky", { x: 0, y: 0, w: 100, h: 100 }), cam)).toHaveLength(9);
    expect(handlePositions(obj("frame"), cam)).toHaveLength(8);
    expect(handlePositions(obj("pen"), cam)).toHaveLength(8);
    expect(handlePositions(obj("connector"), cam)).toHaveLength(0);
  });

  it("finds the handle under the pointer in the rotated frame", () => {
    const o = obj("rect", { x: 0, y: 0, w: 100, h: 50, rot: 90 });
    const cam = { x: -100, y: -100, zoom: 1 };
    const hs = handlePositions(o, cam);
    const se = rotatePoint({ x: 100, y: 50 }, center(o), 90);
    const s = worldToScreen(cam, se);
    expect(handleAt(hs, { x: s.x + 2, y: s.y - 2 }, 8)).toBe("se");
    expect(handleAt(hs, { x: -500, y: -500 }, 8)).toBeNull();
  });

  it("resizes keeping the opposite corner fixed (unrotated)", () => {
    const o = { x: 10, y: 10, w: 100, h: 100, rot: 0 };
    expect(resizeBox(o, "se", { x: 210, y: 60 })).toEqual({ x: 10, y: 10, w: 200, h: 50, rot: 0 });
    expect(resizeBox(o, "nw", { x: 60, y: -40 })).toEqual({ x: 60, y: -40, w: 50, h: 150, rot: 0 });
    expect(resizeBox(o, "e", { x: 60, y: 999 })).toEqual({ x: 10, y: 10, w: 50, h: 100, rot: 0 });
  });

  it("keeps the anchor fixed in world space when rotated", () => {
    const o = { x: 0, y: 0, w: 100, h: 60, rot: 30 };
    const anchorBefore = rotatePoint({ x: 0, y: 0 }, center(o), 30); // nw corner stays for se drag
    const target = rotatePoint({ x: 180, y: 120 }, center(o), 30);
    const r = resizeBox(o, "se", target);
    expect(r.w).toBeCloseTo(180, 1);
    expect(r.h).toBeCloseTo(120, 1);
    const anchorAfter = rotatePoint({ x: r.x, y: r.y }, center(r), 30);
    expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 1);
    expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 1);
  });

  it("keeps aspect ratio with shift and never inverts", () => {
    const o = { x: 0, y: 0, w: 200, h: 100, rot: 0 };
    const r = resizeBox(o, "se", { x: 400, y: 120 }, true);
    expect(r.w / r.h).toBeCloseTo(2);
    expect(r.w).toBe(400);
    const tiny = resizeBox(o, "se", { x: -500, y: -500 });
    expect(tiny.w).toBeGreaterThan(0);
    expect(tiny.x).toBe(0);
  });

  it("rotates toward the pointer and snaps with shift", () => {
    const o = { x: 0, y: 0, w: 100, h: 100 };
    expect(rotationToward(o, { x: 50, y: -100 })).toBe(0);
    expect(rotationToward(o, { x: 200, y: 50 })).toBe(90);
    expect(rotationToward(o, { x: 50, y: 200 })).toBe(180);
    expect(rotationToward(o, { x: 200, y: 42 }, true) % 15).toBe(0);
    expect(cursorForHandle("e", 0)).toBe("ew-resize");
    expect(cursorForHandle("e", 90)).toBe("ns-resize");
    expect(cursorForHandle("rotate", 0)).toBe("grab");
  });
});

describe("hit testing and marquee", () => {
  const zoom = 1;
  it("hits boxes, ellipses by shape, pens and connectors by distance", () => {
    const r = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const e = obj("ellipse", { x: 200, y: 0, w: 100, h: 100 });
    const p = obj("pen", { x: 0, y: 200, w: 100, h: 100, points: [0, 0, 1, 1] });
    const c = obj("connector", { from: r.id, to: e.id });
    const all = board(r, e, p, c);
    const resolve = (i) => all[i];
    expect(hitObject(r, { x: 50, y: 50 }, zoom, resolve)).toBe(true);
    expect(hitObject(e, { x: 202, y: 2 }, zoom, resolve)).toBe(false);
    expect(hitObject(e, { x: 250, y: 50 }, zoom, resolve)).toBe(true);
    expect(hitObject(p, { x: 52, y: 250 }, zoom, resolve)).toBe(true);
    expect(hitObject(p, { x: 90, y: 210 }, zoom, resolve)).toBe(false);
    expect(hitObject(c, { x: 150, y: 52 }, zoom, resolve)).toBe(true);
    expect(hitObject(c, { x: 150, y: 80 }, zoom, resolve)).toBe(false);
  });

  it("selects a frame only by its title or border, not its interior", () => {
    const f = obj("frame", { x: 0, y: 0, w: 400, h: 300, text: "Ideas" });
    const resolve = () => undefined;
    expect(hitObject(f, { x: 200, y: 150 }, zoom, resolve)).toBe(false);
    expect(hitObject(f, { x: 1, y: 150 }, zoom, resolve)).toBe(true);
    expect(hitObject(f, { x: 20, y: -10 }, zoom, resolve)).toBe(true);
    expect(hitObject(f, { x: 390, y: -10 }, zoom, resolve)).toBe(false);
  });

  it("returns the topmost hit", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100, z: "a0" });
    const b = obj("sticky", { x: 50, y: 50, w: 100, h: 100, z: "a1" });
    const f = obj("frame", { x: -50, y: -50, w: 500, h: 500, z: "a2" });
    const sorted = [f, a, b];
    const resolve = (i) => board(a, b, f)[i];
    expect(topObjectAt(sorted, { x: 75, y: 75 }, 1, resolve).id).toBe(b.id);
    expect(topObjectAt(sorted, { x: 25, y: 25 }, 1, resolve).id).toBe(a.id);
    expect(topObjectAt(sorted, { x: 300, y: 300 }, 1, resolve)).toBeNull();
    expect(topObjectAt(sorted, { x: 75, y: 75 }, 1, resolve, (o) => o.id !== b.id).id).toBe(a.id);
  });

  it("marquee selects intersecting objects, frames only when enclosed", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 500, y: 500, w: 100, h: 100 });
    const f = obj("frame", { x: -10, y: -10, w: 300, h: 300 });
    const all = board(a, b, f);
    const resolve = (i) => all[i];
    expect(objectsInRect(Object.values(all), { x: 90, y: 90, w: 20, h: 20 }, resolve)).toEqual([a.id]);
    expect(objectsInRect(Object.values(all), { x: -20, y: -20, w: 400, h: 400 }, resolve).sort()).toEqual([a.id, f.id].sort());
  });
});

describe("frames and moves", () => {
  it("picks the smallest frame containing a point", () => {
    const big = obj("frame", { x: 0, y: 0, w: 1000, h: 1000 });
    const small = obj("frame", { x: 100, y: 100, w: 200, h: 200 });
    const all = board(big, small);
    expect(frameAtPoint(all, { x: 150, y: 150 })).toBe(small.id);
    expect(frameAtPoint(all, { x: 900, y: 900 })).toBe(big.id);
    expect(frameAtPoint(all, { x: -5, y: 0 })).toBeNull();
  });

  it("expands frames to their members and drops connectors", () => {
    const f = obj("frame", { x: 0, y: 0, w: 500, h: 500 });
    const m = obj("sticky", { x: 10, y: 10, frameId: f.id });
    const dangling = obj("sticky", { x: 10, y: 10, frameId: "o_ffffffffffff" });
    const other = obj("rect", { x: 900, y: 900 });
    const c = obj("connector", { from: m.id, to: other.id });
    const all = board(f, m, dangling, other, c);
    expect(expandMoveIds(all, [f.id, c.id]).sort()).toEqual([f.id, m.id].sort());
  });

  it("moves with frame membership only when it changes", () => {
    const f = obj("frame", { x: 0, y: 0, w: 500, h: 500 });
    const inside = obj("sticky", { x: 10, y: 10, w: 100, h: 100, frameId: f.id });
    const outside = obj("rect", { x: 1000, y: 1000, w: 100, h: 100 });
    const all = board(f, inside, outside);
    // Moving a member within the frame: no frameId change.
    expect(moveUpdates(all, [inside.id], 5, 5)).toEqual([{ id: inside.id, patch: { x: 15, y: 15 } }]);
    // Moving it out: frameId cleared.
    expect(moveUpdates(all, [inside.id], 2000, 0)[0].patch.frameId).toBeNull();
    // Moving the outside rect into the frame: joins it.
    expect(moveUpdates(all, [outside.id], -900, -900)[0].patch.frameId).toBe(f.id);
    // Moving the frame with its member: member stays, frame gets no frameId.
    const both = moveUpdates(all, expandMoveIds(all, [f.id]), 3000, 0);
    expect(both.find((u) => u.id === f.id).patch).toEqual({ x: 3000, y: 0 });
    expect(both.find((u) => u.id === inside.id).patch).toEqual({ x: 3010, y: 10 });
    // A moved frame landing on a still object does not pull it in (only moved objects change).
    expect(both.some((u) => u.id === outside.id)).toBe(false);
  });

  it("adds membership to resize patches", () => {
    const f = obj("frame", { x: 0, y: 0, w: 500, h: 500 });
    const r = obj("rect", { x: 600, y: 0, w: 100, h: 100 });
    const all = board(f, r);
    expect(withFrameMembership(all, r, { x: 400, y: 0, w: 100, h: 100 }, {})).toEqual({ frameId: f.id });
    expect(withFrameMembership(all, f, { x: 0, y: 0, w: 1, h: 1 }, {})).toEqual({});
  });

  it("duplicates with fresh ids, offsets, members and internal connectors", () => {
    const f = obj("frame", { x: 0, y: 0, w: 500, h: 500, z: "a0" });
    const a = obj("sticky", { x: 10, y: 10, w: 100, h: 100, frameId: f.id, z: "a1", text: "A" });
    const b = obj("rect", { x: 200, y: 10, w: 100, h: 100, frameId: f.id, z: "a2" });
    const out = obj("rect", { x: 2000, y: 0, w: 100, h: 100, z: "a3" });
    const c1 = obj("connector", { from: a.id, to: b.id, z: "a4" });
    const c2 = obj("connector", { from: a.id, to: out.id, z: "a5" });
    const all = board(f, a, b, out, c1, c2);
    let n = 0;
    const { creates, ids } = buildDuplicates(all, [f.id], () => "o_" + String(++n).padStart(12, "a"));
    expect(creates).toHaveLength(4); // frame, a, b, c1
    expect(new Set(ids).size).toBe(4);
    const fc = creates.find((c) => c.type === "frame");
    const ac = creates.find((c) => c.text === "A");
    expect(ac.x).toBe(30);
    expect(ac.frameId).toBe(fc.id);
    const cc = creates.find((c) => c.type === "connector");
    expect(cc.from).toBe(ac.id);
    expect(creates.some((c) => c.id === a.id)).toBe(false);
    const single = buildDuplicates(all, [out.id, "missing"], () => "o_bbbbbbbbbbbb");
    expect(single.creates).toHaveLength(1);
    expect(single.creates[0].frameId).toBeNull();
  });

  it("builds creation boxes for clicks and drags", () => {
    const click = creationBox("sticky", { x: 100, y: 100 }, { x: 100, y: 100 }, Infinity);
    expect(click).toEqual({ x: 0, y: 0, w: 200, h: 200 });
    const drag = creationBox("rect", { x: 100, y: 100 }, { x: 40, y: 300 }, 4);
    expect(drag).toEqual({ x: 40, y: 100, w: 60, h: 200 });
    const text = creationBox("text", { x: 0, y: 0 }, { x: 300, y: 2 }, 4);
    expect(text.h).toBe(textObjectHeight("", 300, TYPE_DEFAULTS.text.style.fontSize));
    expect(validIds({ a: 1, b: 2 }, ["a", "x", "a", "b"])).toEqual(["a", "b"]);
  });
});

describe("keymap", () => {
  it("maps shortcuts", () => {
    expect(keyAction({ key: "Delete" })).toEqual({ type: "delete" });
    expect(keyAction({ key: "Backspace" })).toEqual({ type: "delete" });
    expect(keyAction({ key: "ArrowLeft", shiftKey: true })).toEqual({ type: "nudge", dx: -10, dy: 0 });
    expect(keyAction({ key: "ArrowDown" })).toEqual({ type: "nudge", dx: 0, dy: 1 });
    expect(keyAction({ key: "z", ctrlKey: true })).toEqual({ type: "undo" });
    expect(keyAction({ key: "Z", metaKey: true, shiftKey: true })).toEqual({ type: "redo" });
    expect(keyAction({ key: "y", ctrlKey: true })).toEqual({ type: "redo" });
    expect(keyAction({ key: "d", ctrlKey: true })).toEqual({ type: "duplicate" });
    expect(keyAction({ key: "a", metaKey: true })).toEqual({ type: "selectAll" });
    expect(keyAction({ key: "]" })).toEqual({ type: "front" });
    expect(keyAction({ key: "[" })).toEqual({ type: "back" });
    expect(keyAction({ key: "n" })).toEqual({ type: "tool", tool: "sticky" });
    expect(keyAction({ key: "O" })).toEqual({ type: "tool", tool: "ellipse" });
    expect(keyAction({ key: "!", code: "Digit1", shiftKey: true })).toEqual({ type: "fit" });
    expect(keyAction({ key: "+" })).toEqual({ type: "zoomIn" });
    expect(keyAction({ key: "-" })).toEqual({ type: "zoomOut" });
    expect(keyAction({ key: "Escape" })).toEqual({ type: "escape" });
    expect(keyAction({ key: "Enter" })).toEqual({ type: "edit" });
    expect(keyAction({ key: "c", ctrlKey: true })).toBeNull();
    expect(keyAction({ key: "v", altKey: true })).toBeNull();
    expect(keyAction({ key: "q" })).toBeNull();
  });
});

describe("text editor geometry", () => {
  it("covers the text box of shapes and the name strip of frames", () => {
    const s = obj("sticky", { x: 0, y: 0, w: 200, h: 200, rot: 15 });
    const b = editorBox(s, () => undefined);
    expect(b.rot).toBe(15);
    expect(b.cx).toBe(100);
    expect(b.singleLine).toBe(false);
    expect(b.centerVertically).toBe(true);
    const f = editorBox(obj("frame", { x: 0, y: 100, w: 400, h: 300 }), () => undefined);
    expect(f.singleLine).toBe(true);
    expect(f.y + f.h).toBeLessThanOrEqual(100);
    expect(editorBox(obj("pen"), () => undefined)).toBeNull();
  });

  it("centres connector labels on the route", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 300, y: 0, w: 100, h: 100 });
    const c = obj("connector", { from: a.id, to: b.id });
    const all = board(a, b, c);
    const box = editorBox(c, (i) => all[i]);
    expect(box.cx).toBe(200);
    expect(box.singleLine).toBe(true);
    expect(editorBox(obj("connector", { from: "o_000000000999", to: b.id }), (i) => all[i])).toBeNull();
  });

  it("builds text patches: cleaned, single line for names, auto height for text", () => {
    const s = obj("sticky", { text: "hi" });
    expect(textPatch(s, "hi")).toBeNull();
    expect(textPatch(s, "a\r\nb")).toEqual({ text: "a\nb" });
    const f = obj("frame", { text: "Frame" });
    expect(textPatch(f, "  Road\nmap ")).toEqual({ text: "Road map" });
    const t = obj("text", { w: 100, h: 30, text: "" });
    const p = textPatch(t, "one two three four five six seven");
    expect(p.h).toBe(textObjectHeight(p.text, 100, t.style.fontSize));
    expect(p.h).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------------------------
// Gestures against a fake store and layer
// ---------------------------------------------------------------------------------------------

describe("gestures", () => {
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

  function setup(objects) {
    const calls = [];
    const state = { board: { objects } };
    const store = {
      getState: () => state,
      updateObjects: vi.fn((u) => calls.push(["update", u])),
      createObjects: vi.fn((list) => { calls.push(["create", list]); return list.map((o, i) => o.id ?? `o_00000000000${i}`); }),
      setPresence: vi.fn((p) => calls.push(["presence", p])),
      flushPresence: vi.fn(() => calls.push(["flush"])),
    };
    let selection = [];
    const overrides = new Map();
    const translates = new Map();
    const ctx = {
      store, element: { classList: { add() {}, remove() {} } },
      objects: () => state.board.objects,
      resolve: (i) => {
        const o = state.board.objects[i];
        const ov = overrides.get(i);
        return o && ov ? { ...o, ...ov.geom } : o;
      },
      sorted: () => Object.values(state.board.objects),
      camera: () => ({ x: 0, y: 0, zoom: 1 }),
      layer: {
        translate: (i, dx, dy) => translates.set(i, [dx, dy]), rerender() {}, connectorsOf: () => new Set(),
      },
      overrides, preview: { appendChild() {} },
      getSelection: () => [...selection], setSelection: (ids) => { selection = ids; },
      schedule() {}, setCameraByUser: vi.fn(), setOverlay: vi.fn(),
      toolStyle: () => ({}), finishCreate: vi.fn(), editText: vi.fn(), contextMenu: vi.fn(),
      registerClick: vi.fn(() => false), announceSelection() {},
    };
    return { ctx, store, calls, translates, getSelection: () => selection, overrides };
  }
  const pt = (x, y, extra = {}) => ({ sx: x, sy: y, x, y, shift: false, clientX: x, clientY: y, pointerType: "mouse", time: 0, ...extra });

  it("drag: selects on press, sends transforms, commits one update and clears presence", () => {
    const f = obj("frame", { x: 0, y: 0, w: 1000, h: 1000 });
    const a = obj("sticky", { x: 10, y: 10, frameId: f.id });
    const { ctx, calls, translates, getSelection, overrides } = setup(board(f, a));
    const g = G.objectPressGesture(ctx, pt(20, 20), f);
    expect(getSelection()).toEqual([f.id]);
    g.move(pt(21, 20)); // below threshold
    g.frame();
    expect(calls.filter((c) => c[0] === "presence")).toHaveLength(0);
    g.move(pt(70, 40));
    g.frame();
    const presence = calls.filter((c) => c[0] === "presence").at(-1)[1];
    expect(presence.transforms.map((t) => t.id).sort()).toEqual([f.id, a.id].sort());
    expect(translates.get(a.id)).toEqual([50, 20]);
    calls.length = 0;
    g.up(pt(120, 20));
    expect(calls.map((c) => c[0])).toEqual(["update", "presence", "flush"]);
    const updates = calls[0][1];
    expect(updates.find((u) => u.id === f.id).patch).toEqual({ x: 100, y: 0 });
    expect(calls[1][1]).toEqual({ transforms: [] });
    expect(overrides.size).toBe(0);
    expect(translates.get(a.id)).toEqual([0, 0]);
  });

  it("drag: cancel restores and clears presence without committing", () => {
    const a = obj("rect", { x: 0, y: 0 });
    const { ctx, calls, overrides } = setup(board(a));
    const g = G.objectPressGesture(ctx, pt(10, 10), a);
    g.move(pt(100, 100));
    g.frame();
    g.cancel();
    expect(calls.some((c) => c[0] === "update")).toBe(false);
    expect(calls.at(-2)).toEqual(["presence", { transforms: [] }]);
    expect(overrides.size).toBe(0);
  });

  it("click on a selected object in a multi-selection selects only it; shift-click toggles", () => {
    const a = obj("rect", { x: 0, y: 0 });
    const b = obj("rect", { x: 300, y: 0 });
    const { ctx, getSelection } = setup(board(a, b));
    ctx.setSelection([a.id, b.id]);
    G.objectPressGesture(ctx, pt(10, 10), a).up(pt(10, 10));
    expect(getSelection()).toEqual([a.id]);
    G.objectPressGesture(ctx, pt(310, 10, { shift: true }), b).up(pt(310, 10, { shift: true }));
    expect(getSelection()).toEqual([a.id, b.id]);
    G.objectPressGesture(ctx, pt(10, 10, { shift: true }), a).up(pt(10, 10, { shift: true }));
    expect(getSelection()).toEqual([b.id]);
  });

  it("double click opens the editor", () => {
    const a = obj("sticky", { x: 0, y: 0 });
    const { ctx } = setup(board(a));
    ctx.registerClick = () => true;
    G.objectPressGesture(ctx, pt(10, 10), a).up(pt(10, 10));
    expect(ctx.editText).toHaveBeenCalledWith(a.id);
  });

  it("resize commits geometry and membership in one update", () => {
    const f = obj("frame", { x: 0, y: 0, w: 1000, h: 1000 });
    const r = obj("rect", { x: 1100, y: 0, w: 100, h: 100 });
    const { ctx, calls } = setup(board(f, r));
    const g = G.handleGesture(ctx, pt(1100, 0), r.id, "nw");
    g.move(pt(700, 0));
    g.frame();
    expect(calls.filter((c) => c[0] === "presence").at(-1)[1].transforms[0]).toMatchObject({ id: r.id, x: 700, w: 500 });
    calls.length = 0;
    g.up(pt(700, 0));
    expect(calls.map((c) => c[0])).toEqual(["update", "presence", "flush"]);
    expect(calls[0][1]).toEqual([{ id: r.id, patch: { x: 700, w: 500, frameId: f.id } }]);
  });

  it("rotate snaps with shift", () => {
    const r = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const { ctx, calls } = setup(board(r));
    const g = G.handleGesture(ctx, pt(50, -28), r.id, "rotate");
    g.move(pt(150, 40, { shift: true }));
    g.up(pt(150, 40, { shift: true }));
    expect(calls[0]).toEqual(["update", [{ id: r.id, patch: { rot: 90 } }]]);
  });

  it("marquee selects live, shift adds, cancel restores", () => {
    const a = obj("rect", { x: 0, y: 0, w: 50, h: 50 });
    const b = obj("rect", { x: 200, y: 0, w: 50, h: 50 });
    const { ctx, getSelection } = setup(board(a, b));
    ctx.setSelection([b.id]);
    const g = G.marqueeGesture(ctx, pt(-10, -10, { shift: true }));
    g.move(pt(60, 60));
    g.frame();
    expect(getSelection().sort()).toEqual([a.id, b.id].sort());
    g.cancel();
    expect(getSelection()).toEqual([b.id]);
    const click = G.marqueeGesture(ctx, pt(500, 500));
    click.up(pt(500, 500));
    expect(getSelection()).toEqual([]);
  });

  it("pen: sends simplified world strokes, commits a normalised pen and clears the stroke", () => {
    const { ctx, calls } = setup({});
    const g = G.penGesture(ctx, pt(0, 0));
    for (let i = 1; i <= 100; i++) g.move(pt(i, i % 2 ? 0.1 : 0));
    g.frame();
    const stroke = calls.filter((c) => c[0] === "presence").at(-1)[1].stroke;
    expect(stroke.points.length / 2).toBeLessThanOrEqual(LIMITS.presenceStrokePoints);
    expect(stroke.points.length).toBeLessThan(200);
    calls.length = 0;
    g.up(pt(100, 0));
    expect(calls.map((c) => c[0])).toEqual(["create", "presence", "flush"]);
    const pen = calls[0][1][0];
    expect(pen.type).toBe("pen");
    expect(pen.points.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(pen.w).toBeGreaterThan(100);
    expect(calls[1][1]).toEqual({ stroke: null });
    expect(ctx.finishCreate).toHaveBeenCalled();
  });

  it("pen: a tap makes a dot", () => {
    const { ctx, calls } = setup({});
    G.penGesture(ctx, pt(5, 5)).up(pt(5, 5));
    expect(calls[0][1][0].points).toHaveLength(4);
  });

  it("create: click makes a default object in the frame under it; drag makes a box", () => {
    const f = obj("frame", { x: 0, y: 0, w: 1000, h: 1000 });
    const { ctx, calls } = setup(board(f));
    G.createGesture(ctx, pt(500, 500), "sticky").up(pt(500, 500));
    expect(calls[0][1][0]).toEqual({ type: "sticky", x: 400, y: 400, w: 200, h: 200, frameId: f.id });
    calls.length = 0;
    const g = G.createGesture(ctx, pt(2000, 2000), "rect");
    g.move(pt(2100, 2050));
    g.up(pt(2100, 2050));
    expect(calls[0][1][0]).toEqual({ type: "rect", x: 2000, y: 2000, w: 100, h: 50, frameId: null });
  });

  it("connector: creates only over a valid target", () => {
    const a = obj("rect", { x: 0, y: 0, w: 100, h: 100 });
    const b = obj("rect", { x: 300, y: 0, w: 100, h: 100 });
    const { ctx, calls } = setup(board(a, b));
    G.connectGesture(ctx, pt(50, 50), a).up(pt(60, 60));
    expect(calls).toHaveLength(0);
    G.connectGesture(ctx, pt(50, 50), a).up(pt(350, 50));
    expect(calls[0][1][0]).toEqual({ type: "connector", from: a.id, to: b.id });
  });
});
