// Pure logic behind the keyboard and touch alternatives of the whiteboard UI: the resize / rotate /
// context-menu / pan key mappings, handles on small objects, keyboard resize geometry, menu
// placement away from the finger or the selection, "+N" people, and Connect eligibility.
import { describe, it, expect } from "vitest";
import { TYPE_DEFAULTS, LIMITS } from "../../src/shared/protocol.js";
import { rotatePoint, center } from "../../src/shared/geometry.js";
import { keyAction, panStep, directionWord, SHORTCUTS_HINT, PAN_STEP, PAN_STEP_BIG } from "../../src/client/ui/canvas/keymap.js";
import {
  handleMode, visibleHandles, handleForPress, insideBox, sizedBox, rotatedBy, SMALL_OBJECT_RADII,
} from "../../src/client/ui/canvas/handles.js";
import { resizeUpdates, rotateUpdates } from "../../src/client/ui/canvas/model.js";
import * as canvasIndex from "../../src/client/ui/canvas/index.js";
import { placeMenu } from "../../src/client/ui/dialogs.js";
import { shownPeople } from "../../src/client/ui/people.js";
import { canConnect } from "../../src/client/ui/stylebar.js";

let seq = 0;
/** @returns {any} */
function obj(type, fields = {}) {
  const d = TYPE_DEFAULTS[type];
  return {
    id: fields.id ?? "o_" + (++seq).toString(16).padStart(12, "0"), type, x: 0, y: 0, w: d.w, h: d.h, rot: 0, z: "a0",
    frameId: null, text: "", style: { ...d.style }, version: 1, createdAt: 0, updatedAt: 0, createdBy: "t", ...fields,
  };
}
const board = (...list) => Object.fromEntries(list.map((o) => [o.id, o]));

describe("keymap: keyboard alternatives", () => {
  it("maps Alt+Arrow to resize by 1, Shift for 10", () => {
    expect(keyAction({ key: "ArrowRight", altKey: true })).toEqual({ type: "resize", dw: 1, dh: 0 });
    expect(keyAction({ key: "ArrowLeft", altKey: true, shiftKey: true })).toEqual({ type: "resize", dw: -10, dh: 0 });
    expect(keyAction({ key: "ArrowDown", altKey: true, shiftKey: true })).toEqual({ type: "resize", dw: 0, dh: 10 });
    expect(keyAction({ key: "ArrowUp", altKey: true })).toEqual({ type: "resize", dw: 0, dh: -1 });
    expect(keyAction({ key: "ArrowUp", altKey: true, ctrlKey: true })).toBeNull();
  });

  it("maps , and . to rotate by 15 degrees", () => {
    expect(keyAction({ key: "," })).toEqual({ type: "rotate", deg: -15 });
    expect(keyAction({ key: "." })).toEqual({ type: "rotate", deg: 15 });
    expect(keyAction({ key: "<", shiftKey: true })).toBeNull();
  });

  it("maps the context menu key and Shift+F10 to the context menu", () => {
    expect(keyAction({ key: "ContextMenu" })).toEqual({ type: "contextMenu" });
    expect(keyAction({ key: "F10", shiftKey: true })).toEqual({ type: "contextMenu" });
    expect(keyAction({ key: "F10" })).toBeNull();
  });

  it("keeps plain arrows as nudges, and pans the way the arrow points when nothing is selected", () => {
    const right = keyAction({ key: "ArrowRight" });
    expect(right).toEqual({ type: "nudge", dx: 1, dy: 0 });
    // Content moves left, so the view moves right.
    expect(panStep(/** @type {any} */ (right))).toEqual({ x: -PAN_STEP, y: 0 });
    expect(panStep({ dx: 0, dy: -10 })).toEqual({ x: 0, y: PAN_STEP_BIG });
    expect(PAN_STEP_BIG).toBeGreaterThan(PAN_STEP);
  });

  it("names nudge directions", () => {
    expect(directionWord(1, 0)).toBe("right");
    expect(directionWord(0, -10)).toBe("up");
    expect(directionWord(-1, 1)).toBe("down left");
  });

  it("documents every shortcut in the hint", () => {
    for (const phrase of ["A opens the Add menu", "Shift+O", "context menu key", "Shift+F10", "pan the view", "Alt+Arrow", "comma and period rotate"]) {
      expect(SHORTCUTS_HINT).toContain(phrase);
    }
  });
});

describe("handles on small objects", () => {
  const cam = (zoom) => ({ x: 0, y: 0, zoom });

  it("shows all handles, corners only, or none depending on the on-screen size", () => {
    const o = obj("rect", { w: 200, h: 120 });
    expect(handleMode(o, 1, 8)).toBe("all");
    expect(handleMode(o, 0.12, 8)).toBe("corners"); // 24 x 14 px
    expect(handleMode(o, 0.03, 8)).toBe("none"); // 6 x 3.6 px
    expect(handleMode(o, 1, 18)).toBe("all");
    expect(handleMode({ w: 100, h: 100 }, (SMALL_OBJECT_RADII * 18 - 1) / 100, 18)).toBe("corners");
    expect(visibleHandles(o, cam(1), 8).map((hd) => hd.name)).toEqual(["nw", "n", "ne", "e", "se", "s", "sw", "w", "rotate"]);
    expect(visibleHandles(o, cam(0.12), 8).map((hd) => hd.name)).toEqual(["nw", "ne", "se", "sw", "rotate"]);
    expect(visibleHandles(o, cam(0.03), 8)).toEqual([]);
  });

  it("lets a press inside a small object move it instead of grabbing a handle", () => {
    const o = obj("rect", { x: 2000, y: 2000, w: 200, h: 120 });
    const c = cam(0.12);
    const mid = { x: 2100 * 0.12, y: 2060 * 0.12 };
    expect(handleForPress(o, c, mid, 8)).toBeNull();
    // Just outside the south-east corner still resizes.
    expect(handleForPress(o, c, { x: 2200 * 0.12 + 4, y: 2120 * 0.12 + 4 }, 8)).toBe("se");
    // A large object keeps edge handles that reach inside it.
    const big = obj("rect", { x: 0, y: 0, w: 200, h: 120 });
    expect(handleForPress(big, cam(1), { x: 198, y: 60 }, 8)).toBe("e");
  });

  it("tests points against the rotated box", () => {
    const o = obj("rect", { x: 0, y: 0, w: 100, h: 10, rot: 90 });
    expect(insideBox(o, { x: 50, y: 40 })).toBe(true);
    expect(insideBox(o, { x: 90, y: 5 })).toBe(false);
  });
});

describe("keyboard resize and rotate", () => {
  it("keeps the top-left corner fixed, also when rotated, and clamps sizes", () => {
    const b = sizedBox({ x: 10, y: 20, w: 100, h: 50, rot: 0 }, 110, 50);
    expect(b).toEqual({ x: 10, y: 20, w: 110, h: 50, rot: 0 });
    const rot = { x: 0, y: 0, w: 100, h: 50, rot: 30 };
    const r = sizedBox(rot, 140, 80);
    const corner = (box) => rotatePoint({ x: box.x, y: box.y }, center(box), box.rot);
    expect(corner(r).x).toBeCloseTo(corner(rot).x, 1);
    expect(corner(r).y).toBeCloseTo(corner(rot).y, 1);
    expect(r.w).toBe(140);
    expect(sizedBox(rot, -5, 0).w).toBe(LIMITS.sizeMin);
  });

  it("rotates within [0, 360)", () => {
    expect(rotatedBy(0, -15)).toBe(345);
    expect(rotatedBy(350, 15)).toBe(5);
    expect(rotatedBy(345, 15)).toBe(0);
  });

  it("builds one batch of updates, skipping what does not apply", () => {
    const frame = obj("frame", { x: 0, y: 0, w: 400, h: 400 });
    const sticky = obj("sticky", { x: 350, y: 100, w: 40, h: 40, frameId: frame.id });
    const pen = obj("pen", { x: 500, y: 500, w: 50, h: 50, points: [0, 0, 1, 1] });
    const conn = obj("connector", { from: sticky.id, to: pen.id });
    const all = board(frame, sticky, pen, conn);
    const grow = resizeUpdates(all, [sticky.id, pen.id, conn.id], (o) => ({ w: o.w + 100, h: o.h }));
    expect(grow.map((u) => u.id)).toEqual([sticky.id, pen.id]);
    // The sticky's centre leaves the frame.
    expect(grow[0].patch).toEqual({ w: 140, frameId: null });
    expect(resizeUpdates(all, [sticky.id], (o) => ({ w: o.w, h: o.h }))).toEqual([]);
    const turn = rotateUpdates(all, [frame.id, sticky.id, pen.id, conn.id], 15);
    expect(turn).toEqual([{ id: sticky.id, patch: { rot: 15 } }]);
  });

  it("re-exports the move, resize and rotate builders from the canvas entry point", () => {
    for (const name of ["expandMoveIds", "moveUpdates", "resizeUpdates", "rotateUpdates"]) {
      expect(typeof canvasIndex[name]).toBe("function");
    }
  });
});

describe("menu placement", () => {
  const view = { w: 414, h: 860 };
  const menu = { w: 180, h: 240 };

  it("puts a touch menu above the finger, clear of it", () => {
    const finger = { left: 200 - 48, top: 700 - 48, right: 200 + 48, bottom: 700 + 48 };
    const at = placeMenu(menu, finger, view, { prefer: "above" });
    expect(at.top + menu.h).toBeLessThanOrEqual(finger.top);
    expect(at.left + menu.w).toBeLessThanOrEqual(view.w - 8);
  });

  it("falls back to below, then beside, then clamps", () => {
    const nearTop = { left: 100, top: 20, right: 140, bottom: 60 };
    expect(placeMenu(menu, nearTop, view, { prefer: "above" }).top).toBe(64);
    const tall = { left: 10, top: 100, right: 120, bottom: 800 };
    expect(placeMenu(menu, tall, view)).toEqual({ left: 124, top: 100 });
    const huge = { left: 0, top: 0, right: 414, bottom: 860 };
    const at = placeMenu(menu, huge, view);
    expect(at.left).toBeGreaterThanOrEqual(8);
    expect(at.top + menu.h).toBeLessThanOrEqual(view.h - 8);
  });

  it("anchors a keyboard menu below the selection when it fits", () => {
    const sel = { left: 300, top: 200, right: 500, bottom: 320 };
    expect(placeMenu(menu, sel, { w: 1300, h: 820 })).toEqual({ left: 300, top: 324 });
  });
});

describe("people and connect", () => {
  it("shows every person or leaves room for the +N button", () => {
    expect(shownPeople(3, 6)).toBe(3);
    expect(shownPeople(6, 6)).toBe(6);
    expect(shownPeople(7, 6)).toBe(5);
    expect(shownPeople(10, 3)).toBe(2);
  });

  it("connects exactly two non-connector objects", () => {
    const a = obj("sticky"), b = obj("rect"), c = obj("connector", { from: a.id, to: b.id });
    expect(canConnect([a, b])).toBe(true);
    expect(canConnect([a])).toBe(false);
    expect(canConnect([a, c])).toBe(false);
    expect(canConnect([a, b, obj("text")])).toBe(false);
  });
});
