import { describe, expect, it } from "vitest";
import { SINGLE_LANE, movePatch, project } from "../../src/client/board/projection.js";
import { buildIndex } from "../../src/shared/model/index.js";
import { NONE } from "../../src/shared/model/properties.js";
import { compare, compile, parse, run } from "../../src/shared/wql/index.js";
import { ADA, BOB, NOW, TODAY, id, records } from "../wql/fixture.js";

const index = buildIndex(records(), { keyPrefix: "WRK" });
const ctx = { index, today: TODAY, viewer: ADA };
const wctx = { ...ctx, now: NOW };
const item = (/** @type {number} */ n) => /** @type {any} */ (index.byNumber.get(n));
const live = run("", wctx);
const cmp = compare([{ field: "rank", dir: "asc" }, { field: "priority", dir: "asc" }], wctx);

let nextChange = 1;
/** @param {Partial<import("../../src/client/store/store.js").Change>} c */
const change = (c) => /** @type {any} */ ({ id: nextChange++, status: "pending", itemId: null, command: "work.update", input: {}, settledAt: null, resultId: null, resultRevision: null, label: "x", ...c });

/** @param {any} p */
const base = (p = {}) => project({ index, items: live, columnsBy: "state", swimlanesBy: null, ctx, compare: cmp, ...p });
/** @param {any} proj @param {string} lane @param {string} col */
const keys = (proj, lane, col) => proj.lanes.find((l) => l.key === lane).cells.get(col).map((e) => e.key);
/** @param {any} proj @param {string} lane @param {string} col */
const nums = (proj, lane, col) => proj.lanes.find((l) => l.key === lane).cells.get(col).filter((e) => e.kind === "card").map((e) => e.item.number);

describe("project: columns and lanes", () => {
  it("one lane with one cell per state", () => {
    const p = base();
    expect(p.columns.map((c) => c.group.key)).toEqual(["triage", "backlog", "todo", "in_progress", "in_review", "done", "cancelled"]);
    expect(p.lanes).toHaveLength(1);
    expect(p.lanes[0].key).toBe(SINGLE_LANE);
    expect(p.total).toBe(11);
    expect(nums(p, SINGLE_LANE, "todo").toSorted((a, b) => a - b)).toEqual([2, 10, 12]);
    expect(p.columns.find((c) => c.group.key === "in_progress")).toMatchObject({ count: 3, estimate: 18 });
  });
  it("keeps the order of the items it is given (manual order: ranked first)", () => {
    expect(nums(base({ items: [...live].toSorted(cmp) }), SINGLE_LANE, "todo")[0]).toBe(2);
  });
  it("lanes by assignee with Unassigned last and counts", () => {
    const p = base({ swimlanesBy: "assignee" });
    expect(p.lanes.map((l) => l.key)).toEqual([ADA, BOB, NONE]);
    expect(p.lanes[0].count).toBe(3);
    expect(nums(p, ADA, "in_review")).toEqual([3]);
    expect(p.swimlanesBy).toBe("assignee");
  });
  it("label lanes mirror a card into every label lane", () => {
    const p = base({ swimlanesBy: "label" });
    expect(keys(p, "bug", "in_progress")).toEqual([id(1)]);
    expect(keys(p, "ui", "in_progress")).toEqual([`${id(1)}@ui`]);
    const ui = p.lanes.find((l) => l.key === "ui").cells.get("in_progress")[0];
    expect(ui.mirror).toBe(true);
    expect(p.lanes.find((l) => l.key === NONE).count).toBeGreaterThan(0);
  });
  it("hides empty lanes and columns", () => {
    const items = run("assignee:bob", wctx);
    const p = base({ items, swimlanesBy: "priority", hideEmptyLanes: true, hideEmptyColumns: true });
    expect(p.lanes.every((l) => l.count > 0)).toBe(true);
    expect(p.columns.map((c) => c.group.key)).toEqual(["todo", "in_progress", "done"]);
  });
  it("hides sub-issues when asked", () => {
    const p = base({ showSubIssues: false });
    expect(p.total).toBe(9);
    expect(nums(p, SINGLE_LANE, "in_review")).toEqual([]);
  });
  it("flags WIP limits", () => {
    const recs = records().map((r) => (r.entity === "workflow_state" && r.data.key === "in_progress" ? { ...r, data: { ...r.data, wip_limit: 2 } } : r));
    const ix = buildIndex(recs);
    const p = project({ index: ix, items: run("", { ...wctx, index: ix }), columnsBy: "state", swimlanesBy: null, ctx: { ...ctx, index: ix } });
    expect(p.columns.find((c) => c.group.key === "in_progress").wip).toEqual({ limit: 2, over: true });
    expect(p.columns.find((c) => c.group.key === "todo").wip).toBeNull();
  });
  it("columns by priority", () => {
    const p = base({ columnsBy: "priority" });
    expect(p.columns.map((c) => c.group.key)).toEqual(["1", "2", "3", "4", "0"]);
    expect(p.columnsBy).toBe("priority");
  });
  it("unknown column field falls back to state", () => {
    expect(base({ columnsBy: "nope" }).columnsBy).toBe("state");
  });
});

describe("project: pending overlay", () => {
  it("ghost for a pending create in its target cell; real cards untouched", () => {
    const c = change({ command: "work.create", input: { title: "Brand new", state: "todo", priority: 1 } });
    const p = base({ changes: [c] });
    const cell = p.lanes[0].cells.get("todo");
    const ghost = cell.find((e) => e.kind === "ghost");
    expect(ghost).toMatchObject({ create: true, key: `ghost-${c.id}` });
    expect(ghost.item.title).toBe("Brand new");
    expect(p.total).toBe(11);
  });
  it("ghost for a pending move; the real card stays and carries the change", () => {
    const c = change({ itemId: id(2), input: { id: id(2), state: "done" } });
    const p = base({ changes: [c] });
    expect(nums(p, SINGLE_LANE, "todo")).toContain(2);
    const real = p.lanes[0].cells.get("todo").find((e) => e.kind === "card" && e.item.number === 2);
    expect(real.pending).toBe(c);
    expect(p.lanes[0].cells.get("done").some((e) => e.kind === "ghost" && e.item.number === 2)).toBe(true);
  });
  it("no ghost when the change does not move the card", () => {
    const c = change({ itemId: id(2), input: { id: id(2), title: "Renamed" } });
    const p = base({ changes: [c] });
    expect(p.lanes[0].cells.get("todo").some((e) => e.kind === "ghost")).toBe(false);
  });
  it("a rank change ghosts within the same column", () => {
    const c = change({ itemId: id(2), input: { id: id(2), rank: "0a" } });
    const p = base({ changes: [c] });
    expect(p.lanes[0].cells.get("todo")[0].kind).toBe("ghost");
  });
  it("no ghost when the result no longer matches the filter", () => {
    const { ast } = parse("state:todo");
    const items = run(ast, wctx);
    const c = change({ itemId: id(2), input: { id: id(2), state: "done" } });
    const p = base({ items, changes: [c], matches: compile(ast, wctx) });
    expect(p.lanes[0].cells.get("done").length).toBe(0);
  });
  it("applied but unsettled changes still ghost; settled ones do not", () => {
    const c = change({ itemId: id(2), input: { id: id(2), state: "done" }, status: "applied", resultRevision: 999 });
    expect(base({ changes: [c] }).lanes[0].cells.get("done").some((e) => e.kind === "ghost")).toBe(true);
    const arrived = change({ itemId: id(2), input: { id: id(2), state: "done" }, status: "applied", resultRevision: 1 });
    expect(base({ changes: [arrived] }).lanes[0].cells.get("done").some((e) => e.kind === "ghost")).toBe(false);
    const settled = change({ itemId: id(2), input: { id: id(2), state: "done" }, status: "applied", settledAt: 1 });
    expect(base({ changes: [settled] }).lanes[0].cells.get("done").some((e) => e.kind === "ghost")).toBe(false);
  });
  it("applied creates stop ghosting once the item exists", () => {
    const c = change({ command: "work.create", input: { title: "x", state: "todo" }, status: "applied", resultId: id(2) });
    expect(base({ changes: [c] }).lanes[0].cells.get("todo").some((e) => e.kind === "ghost")).toBe(false);
  });
  it("failed changes never ghost", () => {
    for (const status of ["conflict", "rejected"]) {
      const c = change({ itemId: id(2), input: { id: id(2), state: "done" }, status });
      const p = base({ changes: [c] });
      expect(p.lanes[0].cells.get("done").some((e) => e.kind === "ghost")).toBe(false);
      expect(p.lanes[0].cells.get("todo").find((e) => e.item?.number === 2).pending).toBeNull();
    }
  });
  it("ghosts appear in each label lane of the target", () => {
    const c = change({ command: "work.create", input: { title: "x", state: "todo", labels: ["bug", "ui"] } });
    const p = base({ swimlanesBy: "label", changes: [c] });
    expect(keys(p, "bug", "todo")).toContain(`ghost-${c.id}@bug`);
    expect(keys(p, "ui", "todo")).toContain(`ghost-${c.id}@ui`);
  });
});

describe("movePatch", () => {
  const opts = (/** @type {any} */ o = {}) => ({ ctx, columnsBy: "state", swimlanesBy: null, ...o });
  it("column move", () => {
    expect(movePatch(opts(), item(2), { toCol: "done", toLane: SINGLE_LANE, fromLane: SINGLE_LANE })).toEqual({ patch: { state: "done" } });
  });
  it("same place, only rank", () => {
    expect(movePatch(opts(), item(2), { toCol: "todo", toLane: SINGLE_LANE, fromLane: SINGLE_LANE, rank: "0z" })).toEqual({ patch: { rank: "0z" } });
    expect(movePatch(opts(), item(2), { toCol: "todo", toLane: SINGLE_LANE, fromLane: SINGLE_LANE, rank: "a1" })).toEqual({ patch: {} });
  });
  it("lane move sets the lane property", () => {
    expect(movePatch(opts({ swimlanesBy: "assignee" }), item(2), { toCol: "in_progress", toLane: ADA, fromLane: BOB })).toEqual({ patch: { state: "in_progress", assignee: ADA } });
    expect(movePatch(opts({ swimlanesBy: "assignee" }), item(2), { toCol: "todo", toLane: NONE, fromLane: BOB })).toEqual({ patch: { assignee: null } });
  });
  it("label lane move swaps the dragged-from label", () => {
    expect(movePatch(opts({ swimlanesBy: "label" }), item(1), { toCol: "in_progress", toLane: "docs", fromLane: "ui" })).toEqual({ patch: { labels: ["bug", "docs"] } });
  });
  it("refuses non-settable properties", () => {
    expect(movePatch(opts({ swimlanesBy: "due" }), item(2), { toCol: "todo", toLane: "today", fromLane: "week" })).toHaveProperty("error");
    expect(movePatch(opts({ columnsBy: "created_by" }), item(2), { toCol: BOB, toLane: SINGLE_LANE, fromLane: SINGLE_LANE })).toHaveProperty("error");
  });
});
