// Virtualised Objects and Activity panels (src/client/ui/virtual-list.js, outline.js,
// activity.js): windowing math, then the real panels over the fake DOM with thousands of rows:
// bounded DOM, full counts, aria-setsize/aria-posinset, roving Tab stop and arrow keys, focus
// restoration across updates, and Select panning the object into view before focus moves on.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { windowRange, navIndex, ROW_OVERSCAN } from "../../src/client/ui/virtual-list.js";
import { createOutline, outlineRows } from "../../src/client/ui/outline.js";
import { createActivity } from "../../src/client/ui/activity.js";
import { installFakeDom } from "../performance/fake-dom.js";
import { simpleObjects } from "../performance/fixtures.js";

describe("windowRange / navIndex", () => {
  it("renders the scrolled window plus overscan, clamped", () => {
    expect(windowRange({ scrollTop: 0, viewportHeight: 580, rowHeight: 58, count: 5000 })).toEqual({ start: 0, end: 11 + ROW_OVERSCAN });
    const mid = windowRange({ scrollTop: 58 * 1000, viewportHeight: 580, rowHeight: 58, count: 5000 });
    expect(mid).toEqual({ start: 1000 - ROW_OVERSCAN, end: 1011 + ROW_OVERSCAN });
    expect(windowRange({ scrollTop: 1e9, viewportHeight: 580, rowHeight: 58, count: 5000 })).toEqual({ start: 4999 - ROW_OVERSCAN, end: 5000 });
    expect(windowRange({ scrollTop: 0, viewportHeight: 580, rowHeight: 58, count: 0 })).toEqual({ start: 0, end: 0 });
    // Unmeasured: a bounded default.
    expect(windowRange({ scrollTop: 0, viewportHeight: 0, rowHeight: 58, count: 5000 }).end).toBeLessThan(40);
  });

  it("maps navigation keys", () => {
    expect(navIndex("ArrowDown", 4, 10, 3)).toBe(5);
    expect(navIndex("ArrowDown", 9, 10, 3)).toBe(9);
    expect(navIndex("ArrowUp", 0, 10, 3)).toBe(0);
    expect(navIndex("Home", 5, 10, 3)).toBe(0);
    expect(navIndex("End", 5, 10, 3)).toBe(9);
    expect(navIndex("PageDown", 5, 10, 3)).toBe(8);
    expect(navIndex("PageUp", 2, 10, 3)).toBe(0);
    expect(navIndex("a", 2, 10, 3)).toBeNull();
    expect(navIndex("ArrowDown", 0, 0, 3)).toBeNull();
  });
});

/** @type {ReturnType<typeof installFakeDom>} */
let dom;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => dom.restore());

const key = (target, k) => {
  const list = target.closest(".panel-list");
  list.dispatchEvent({ type: "keydown", key: k, target, preventDefault() {} });
};
const rowsIn = (list) => list.querySelectorAll("li").filter((li) => !li.classList.contains("virtual-spacer"));
const active = () => document.activeElement;

function outlineApp(objects) {
  const state = { board: { objects }, history: [], peers: new Map() };
  const calls = [];
  let selection = [];
  const app = {
    store: { getState: () => state },
    canvas: {
      getSelection: () => [...selection],
      setSelection: (ids) => { selection = ids; calls.push(["setSelection", ids]); },
      focusObjects: (ids, opts) => calls.push(["focusObjects", ids, opts]),
    },
    announce: () => {},
    focusStyleBar: () => calls.push(["focusStyleBar"]),
    refreshChrome: () => {},
    outlineOpen: false,
  };
  return { app, state, calls };
}

describe("Objects panel", () => {
  it("lists and counts every object with a bounded DOM, position metadata and one Tab stop", () => {
    const objects = simpleObjects(5000);
    const { app } = outlineApp(objects);
    const outline = createOutline(/** @type {any} */ (app));
    outline.open();
    const list = document.querySelector(".outline-list");
    list.clientHeight = 580;
    outline.render(app.store.getState());
    expect(document.querySelector(".outline-count").textContent).toBe("5000");
    const rows = rowsIn(list);
    expect(rows.length).toBeLessThanOrEqual(11 + 2 * ROW_OVERSCAN);
    expect(rows[0].getAttribute("aria-setsize")).toBe("5000");
    expect(rows[0].getAttribute("aria-posinset")).toBe("1");
    // Top of the stack first.
    expect(rows[0].dataset.id).toBe(outlineRows(objects, "").rows[0].id);
    // Roving tabindex: only the first row's two buttons are tabbable.
    const tabbable = list.querySelectorAll("button").filter((b) => b.tabIndex === 0);
    expect(tabbable).toHaveLength(2);
    expect(tabbable.every((b) => rows[0].contains(b))).toBe(true);
    outline.close(false);
  });

  it("moves with the arrow keys, Home and End, rendering far rows and keeping the button column", () => {
    const { app } = outlineApp(simpleObjects(5000));
    const outline = createOutline(/** @type {any} */ (app));
    outline.open();
    const list = document.querySelector(".outline-list");
    list.clientHeight = 580;
    outline.render(app.store.getState());
    const firstSelect = list.querySelector(".outline-select");
    firstSelect.focus();
    key(firstSelect, "ArrowDown");
    expect(active().classList.contains("outline-select")).toBe(true);
    expect(active().closest("li").getAttribute("aria-posinset")).toBe("2");
    key(active(), "End");
    expect(active().closest("li").getAttribute("aria-posinset")).toBe("5000");
    expect(active().classList.contains("outline-select")).toBe(true);
    expect(list.scrollTop).toBeGreaterThan(0);
    expect(rowsIn(list).length).toBeLessThanOrEqual(11 + 2 * ROW_OVERSCAN + 1);
    key(active(), "ArrowLeft");
    expect(active().classList.contains("outline-show")).toBe(true);
    key(active(), "Home");
    expect(active().closest("li").getAttribute("aria-posinset")).toBe("1");
    expect(active().classList.contains("outline-show")).toBe(true);
    outline.close(false);
  });

  it("restores focus across updates: same object, or the row now at its place when it is gone", () => {
    const objects = simpleObjects(3000);
    const { app, state } = outlineApp(objects);
    const outline = createOutline(/** @type {any} */ (app));
    outline.open();
    const list = document.querySelector(".outline-list");
    list.clientHeight = 580;
    outline.render(state);
    const b = list.querySelector(".outline-select");
    b.focus();
    key(b, "ArrowDown");
    key(active(), "ArrowDown");
    const id = active().closest("li").dataset.id;
    // A change to that object rebuilds its row; focus follows.
    objects[id] = { ...objects[id], text: "changed", version: 2 };
    outline.render(state);
    expect(active().closest("li").dataset.id).toBe(id);
    expect(active().classList.contains("outline-select")).toBe(true);
    // Deleted: the row now at position 3 gets focus.
    delete objects[id];
    outline.render(state);
    expect(active().closest("li").getAttribute("aria-posinset")).toBe("3");
    expect(active().closest("li").getAttribute("aria-setsize")).toBe("2999");
    // Filtering to nothing: focus goes back to the filter field.
    const filter = document.querySelector(".outline-filter");
    active().focus();
    filter.value = "no such text";
    outline.render(state);
    expect(active()).toBe(filter);
    expect(document.querySelector(".outline-count").textContent).toBe("0 of 2999");
    outline.close(false);
  });

  it("Select pans the object into view without animation before focus moves to the style bar", () => {
    const { app, calls } = outlineApp(simpleObjects(400));
    const outline = createOutline(/** @type {any} */ (app));
    outline.open();
    const row = rowsIn(document.querySelector(".outline-list"))[5];
    row.querySelector(".outline-select").dispatchEvent({ type: "click" });
    expect(calls.map((c) => c[0])).toEqual(["setSelection", "focusObjects", "focusStyleBar"]);
    expect(calls[1][2]).toEqual({ animate: false });
    expect(calls[1][1]).toEqual([row.dataset.id]);
    expect(outline.isOpen).toBe(false);
  });
});

describe("Activity panel", () => {
  function activityApp(n) {
    const history = Array.from({ length: n }, (_, i) => ({
      id: "h_" + i.toString(16).padStart(12, "0"), at: 1_700_000_000_000 + i * 1000, by: "Someone", summary: `Change ${i}`,
      inverse: i % 3 ? { objectOps: [] } : null,
    }));
    const state = { board: { objects: {} }, history, peers: new Map() };
    return {
      state,
      app: { store: { getState: () => state, loadHistory: () => new Promise(() => {}) }, refreshChrome: () => {}, activityOpen: false },
    };
  }

  it("virtualises entries with position metadata, reaches entries without Undo, and keeps focus on an entry as new ones arrive", () => {
    const { app, state } = activityApp(200);
    const activity = createActivity(/** @type {any} */ (app));
    activity.open();
    const list = document.querySelector(".activity-list");
    list.clientHeight = 580;
    activity.render(state);
    const rows = rowsIn(list);
    expect(rows.length).toBeLessThanOrEqual(11 + 2 * ROW_OVERSCAN);
    expect(rows[0].getAttribute("aria-setsize")).toBe("200");
    // Newest first: entry 199 (has Undo), then 198 (has Undo), then 197... entry 198 = 198 % 3 = 0: no inverse.
    expect(rows[1].querySelector("button")).toBeNull();
    const undo = rows[0].querySelector("button");
    undo.focus();
    key(undo, "ArrowDown");
    expect(active()).toBe(rowsIn(list)[1]); // the row itself: it has no buttons
    key(active(), "ArrowDown");
    expect(active().classList.contains("undo-history-btn")).toBe(true);
    const focusedId = active().closest("li").dataset.key;
    state.history = [...state.history, { id: "h_0000000000ff", at: 1, by: "X", summary: "New", inverse: null }];
    activity.render(state);
    expect(active().closest("li").dataset.key).toBe(focusedId);
    expect(active().closest("li").getAttribute("aria-posinset")).toBe("4");
    expect(active().closest("li").getAttribute("aria-setsize")).toBe("201");
    activity.close();
  });
});
