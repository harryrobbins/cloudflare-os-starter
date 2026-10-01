// The adapt block's library side (src/client/ui/adapt.js): validation of the block, and the `app`
// handle's verbs over a real store and the fake gadget. The DOM side (actions in the board menu,
// styles, onReady) is covered in e2e/adapt.test.mjs against the built client.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLORS } from "../../src/shared/protocol.js";
import { normalizeAdapt, createAppHandle, runSafely } from "../../src/client/ui/adapt.js";
import { FakeServer, settle, startStore } from "./helpers.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** A canvas controller stand-in: a 1000 by 800 view at the origin and a settable selection. */
function fakeCanvas() {
  let selection = /** @type {string[]} */ ([]);
  return /** @type {any} */ ({
    getViewport: () => ({ x: 0, y: 0, w: 1000, h: 800 }),
    getSelection: () => selection,
    setSelection: (/** @type {string[]} */ ids) => { selection = ids; },
    focusObjects: vi.fn(),
  });
}

async function setup() {
  const server = new FakeServer({ latency: 5 });
  const frameId = server.seed({ type: "frame", x: 2000, y: 0, w: 1000, h: 800, text: "Planning" });
  const { store } = await startStore(server, "alice");
  const toasts = /** @type {string[]} */ ([]);
  const canvas = fakeCanvas();
  const app = createAppHandle({ store, canvas, toast: (m) => toasts.push(m) });
  return { server, store, app, canvas, toasts, frameId };
}

describe("normalizeAdapt", () => {
  it("keeps valid fields, ignores unknown keys and reports bad actions without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = () => {};
    const s = normalizeAdapt({
      unknownSetting: 1,
      newObjectColors: { sticky: "blue", text: { textColor: "#123456" }, nope: "red", rect: "not-a-colour" },
      minimap: false,
      styles: ".x { color: red }",
      actions: [
        { id: "a", label: "Do A", run },
        { label: "No run" },
        { id: "a", label: "Duplicate", run },
        null,
        { label: "  Label as id  ", run },
      ],
      onReady: "not a function",
    });
    expect(s.newObjectColors.get("sticky")).toEqual({ fill: COLORS.blue });
    expect(s.newObjectColors.get("text")).toEqual({ textColor: "#123456" });
    expect(s.newObjectColors.has("nope")).toBe(false);
    expect(s.newObjectColors.has("rect")).toBe(false);
    expect(s.minimap).toBe(false);
    expect(s.styles).toBe(".x { color: red }");
    expect(s.actions.map((a) => [a.id, a.label])).toEqual([["a", "Do A"], ["Label as id", "Label as id"]]);
    expect(s.onReady).toBeNull();
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it("defaults to no change when the block is missing or empty", () => {
    for (const raw of [undefined, null, {}, "x"]) {
      expect(normalizeAdapt(raw)).toEqual({ newObjectColors: new Map(), minimap: true, styles: "", actions: [], onReady: null });
    }
  });

  it("maps a pen or connector colour to its line", () => {
    const s = normalizeAdapt({ newObjectColors: { pen: "red", connector: "#00ff00" } });
    expect(s.newObjectColors.get("pen")).toEqual({ stroke: COLORS.red });
    expect(s.newObjectColors.get("connector")).toEqual({ stroke: "#00ff00" });
  });
});

describe("app handle", () => {
  it("addStickies lays notes out in a row, centred in the view, with named colours, as one undo step", async () => {
    const { server, store, app } = await setup();
    const { created, errors } = app.addStickies({ stickies: ["Mon", { text: "Tue", color: "pink" }, "Wed"], columns: 3 });
    expect(errors).toEqual([]);
    expect(created.map((o) => o.text)).toEqual(["Mon", "Tue", "Wed"]);
    expect(new Set(created.map((o) => o.y)).size).toBe(1);
    expect(created[1].x - created[0].x).toBe(240);
    expect(created[1].style.fill).toBe(COLORS.pink);
    // Centred: the row's middle is the view's.
    expect((created[0].x + created[2].x + created[2].w) / 2).toBe(500);
    await settle(100);
    expect(Object.values(server.objects).filter((o) => o.type === "sticky")).toHaveLength(3);
    store.undo();
    await settle(100);
    expect(Object.values(server.objects).filter((o) => o.type === "sticky")).toHaveLength(0);
  });

  it("addStickies into a frame by name, and reports an unknown frame or colour", async () => {
    const { app, frameId } = await setup();
    const { created } = app.addStickies({ stickies: ["In"], frame: "planning" });
    expect(created[0].frameId).toBe(frameId);
    expect(created[0].x).toBe(2040);
    expect(app.addStickies({ stickies: ["x"], frame: "Nope" }).errors[0].message).toMatch(/No frame/);
    const bad = app.addStickies({ stickies: [{ text: "x", color: "sparkly" }, "ok"] });
    expect(bad.errors).toEqual([{ index: 0, message: "Unknown colour sparkly" }]);
    expect(bad.created.map((o) => o.text)).toEqual(["ok"]);
  });

  it("finds, connects, updates, moves, arranges and deletes like the server's verbs", async () => {
    const { server, app } = await setup();
    const { created: [a, b, c] } = app.addObjects({ objects: [
      { type: "rect", x: 0, y: 0, text: "Start", color: "green" },
      { type: "rect", x: 500, y: 300, text: "Middle" },
      { type: "ellipse", x: 900, y: 50, text: "End" },
    ] });
    expect(a.style.fill).toBe(COLORS.green);
    expect(app.findObjects({ type: "rect" }).map((o) => o.text)).toEqual(["Start", "Middle"]);
    expect(app.findObjects({ text: "end" }).map((o) => o.id)).toEqual([c.id]);

    const { connector, errors } = app.connectObjects({ from: a.id, to: b.id, label: "then", routing: "elbow", color: "blue" });
    expect(errors).toEqual([]);
    expect(connector).toMatchObject({ from: a.id, to: b.id, text: "then", routing: "elbow" });
    expect(connector?.style.stroke).toBe(COLORS.blue);
    expect(app.connectObjects({ from: a.id, to: "o_000000000bad" }).connector).toBeNull();

    app.updateObjects({ updates: [{ id: b.id, fields: { text: "Renamed", color: "yellow" } }] });
    expect(app.findObjects({ text: "renamed" })[0].style.fill).toBe(COLORS.yellow);
    app.moveObjects({ ids: [a.id], dx: 10, dy: 20 });
    expect(app.findObjects({ text: "Start" })[0]).toMatchObject({ x: 10, y: 20 });
    app.arrangeGrid({ ids: [c.id, b.id, a.id], columns: 3, gap: 10, at: { x: 0, y: 0 } });
    const [cc, bb, aa] = [c, b, a].map((o) => app.getBoard().objects.find((x) => x.id === o.id));
    const cell = Math.max(a.w, b.w, c.w) + 10;
    expect([cc.x, bb.x, aa.x]).toEqual([0, cell, 2 * cell]);
    expect(new Set([cc.y, bb.y, aa.y])).toEqual(new Set([0]));
    expect(app.deleteObjects({ ids: [a.id, "o_000000000bad"] }).errors).toEqual([{ index: 1, message: "No object o_000000000bad" }]);
    // Deleting an end deletes its connector, as on the server.
    expect(app.findObjects({ type: "connector" })).toEqual([]);
    await settle(100);
    expect(Object.keys(server.objects).sort()).toEqual(app.getBoard().objects.map((o) => o.id).sort());
  });

  it("reads and sets the selection, shows objects, toasts and reports changes", async () => {
    const { app, canvas, toasts } = await setup();
    const { created: [n] } = app.addStickies({ stickies: ["Pick me"] });
    app.setSelection([n.id, 42]);
    expect(app.getSelection()).toEqual([n.id]);
    app.showObjects([n.id, "o_000000000bad"]);
    expect(canvas.focusObjects).toHaveBeenCalledWith([n.id]);
    app.toast("Hello");
    expect(toasts).toEqual(["Hello"]);
    const seen = /** @type {number[]} */ ([]);
    const off = app.onChange((board) => seen.push(board.objects.length));
    app.addStickies({ stickies: ["Another"] });
    off();
    app.addStickies({ stickies: ["Unseen"] });
    expect(seen[0]).toBe(3);
    expect(seen.every((n) => n === 3)).toBe(true);
  });

  it("returns copies, so an action cannot change the board by mutating what it read", async () => {
    const { app } = await setup();
    app.getBoard().objects[0].text = "Mutated";
    expect(app.findObjects({ type: "frame" })[0].text).toBe("Planning");
    expect(Object.isFrozen(app)).toBe(true);
  });
});

describe("runSafely", () => {
  it("reports a thrown error or a rejected promise as a toast, never throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const toasts = /** @type {string[]} */ ([]);
    runSafely("Boom", () => { throw new Error("bad"); }, (m) => toasts.push(m));
    runSafely("Later", () => Promise.reject(new Error("worse")), (m) => toasts.push(m));
    await settle(1);
    expect(toasts).toEqual(["Boom failed: bad", "Later failed: worse"]);
  });
});
