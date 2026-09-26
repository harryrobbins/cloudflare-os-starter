// Flow datasets over a hand-built journal with a controlled clock: reopen, cancel, estimate
// change and scope change, all in UTC days.
import { describe, expect, it } from "vitest";
import { FakeRecords } from "../fake-records.js";
import { createReplica } from "../../src/shared/replica.js";
import { buildIndex } from "../../src/shared/model/index.js";
import { computeDataset, listDatasets } from "../../src/shared/datasets/index.js";
import { findCycle } from "../../src/shared/datasets/flow.js";
import { at, dayRange, percentile, stateChanges, timelines, utcDay, weekOf } from "../../src/shared/datasets/timeline.js";

const ADA = "cloudflare-os:ada@example.com", GRACE = "cloudflare-os:grace@example.com";
const T = (/** @type {string} */ iso) => Date.parse(iso);

/**
 * Cycle 7 runs 2026-09-20 … 2026-09-26. Items A (3 pts), B (5 → 8 pts) and C (2 pts) are planned
 * on 09-19; A starts 09-21, is done 09-22, is reopened 09-23 and done again 09-24; C is canceled
 * on 09-23; D (1 pt) joins the cycle on 09-23; E is created in triage and stays there. "Now" is
 * 2026-09-24 12:00Z.
 */
async function journal({ now = T("2026-09-24T12:00:00Z") } = {}) {
  let clock = T("2026-09-18T09:00:00Z");
  const fake = new FakeRecords({ now: () => clock });
  const run = (/** @type {string} */ when, /** @type {string} */ command, /** @type {any} */ input, by = ADA) => {
    clock = T(when);
    const rev = input.id ? fake.rows.get(input.id)?.revision : undefined;
    return fake.run(command, input, { actor: by, revision: rev });
  };
  const cycle = run("2026-09-18T09:00:00Z", "work.cycle.create", { name: "Cycle 7", starts_on: "2026-09-20", ends_on: "2026-09-26" }).id;
  run("2026-09-18T09:05:00Z", "work.cycle.create", { name: "Cycle 8", starts_on: "2026-09-27", ends_on: "2026-10-03" });
  const A = run("2026-09-19T10:00:00Z", "work.create", { title: "Alpha", state: "todo", estimate: 3, cycle, assignee: GRACE }).id;
  const B = run("2026-09-19T10:10:00Z", "work.create", { title: "Beta", state: "todo", estimate: 5, cycle }).id;
  const C = run("2026-09-19T10:20:00Z", "work.create", { title: "Gamma", state: "todo", estimate: 2, cycle }).id;
  run("2026-09-21T10:00:00Z", "work.update", { id: A, state: "in_progress" }, GRACE);
  run("2026-09-22T16:00:00Z", "work.update", { id: A, state: "done" }, GRACE);
  run("2026-09-22T17:00:00Z", "work.update", { id: B, estimate: 8 });
  const D = run("2026-09-23T08:00:00Z", "work.create", { title: "Delta", state: "todo", estimate: 1 }).id;
  run("2026-09-23T08:30:00Z", "work.update", { id: D, cycle });
  run("2026-09-23T09:00:00Z", "work.update", { id: C, state: "canceled" });
  run("2026-09-23T15:00:00Z", "work.update", { id: A, state: "in_progress" }, GRACE);
  run("2026-09-24T09:00:00Z", "work.update", { id: A, state: "done" }, GRACE);
  // Just before midnight UTC: counts on 09-23 whatever the local time zone.
  const E = run("2026-09-23T23:59:00Z", "work.create", { title: "Epsilon", state: "triage" }, GRACE).id;
  run("2026-09-23T23:59:30Z", "work.relation.create", { from: B, to: D, kind: "blocks" });
  run("2026-09-23T23:59:40Z", "work.relation.create", { from: E, to: B, kind: "blocks" });
  const replica = createReplica({ now: () => now });
  const source = fake.session();
  await replica.load(source);
  while (!(await replica.backfillHistory(source, 10)));
  const index = buildIndex(replica.records.values(), { planning: true, keyPrefix: "WRK", times: replica.times });
  const ctx = { index, viewer: null, now, today: utcDay(now), history: replica.history, historyComplete: true, historyVersion: replica.historyVersion };
  return { ctx, ids: { A, B, C, D, E, cycle }, fake };
}

describe("timeline helpers", () => {
  it("days, weeks, ranges and percentiles are UTC and exact", () => {
    expect(utcDay(T("2026-09-23T23:59:59Z"))).toBe("2026-09-23");
    expect(weekOf("2026-09-27")).toBe("2026-09-21");
    expect(weekOf("2026-09-21")).toBe("2026-09-21");
    expect(dayRange("2026-02-27", "2026-03-02")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10], 0.85)).toBe(10);
    expect(percentile([], 0.5)).toBeNull();
  });

  it("rebuilds each item's states over time, including the reopen", async () => {
    const { ctx, ids } = await journal();
    const tl = timelines(ctx.index, ctx.history, ctx.historyVersion).get(ids.A);
    expect(stateChanges(tl.points).map((c) => c.to.state)).toEqual(["todo", "in_progress", "done", "in_progress", "done"]);
    expect(at(tl.points, T("2026-09-23T12:00:00Z"))?.kind).toBe("completed");
    expect(at(tl.points, T("2026-09-23T16:00:00Z"))?.kind).toBe("started");
    expect(at(tl.points, T("2026-09-19T09:00:00Z"))).toBeNull();
  });
});

describe("flow datasets", () => {
  it("cycle burndown: estimate change, cancel, scope change and reopen, with the ideal line and future days", async () => {
    const { ctx } = await journal();
    const r = computeDataset("cycle_burndown", ctx, { params: { cycle: "Cycle 7" } });
    expect(r.params).toMatchObject({ cycle: "Cycle 7", starts_on: "2026-09-20", ends_on: "2026-09-26" });
    expect(r.rows.map((x) => [x.day, x.scope, x.completed, x.remaining])).toEqual([
      ["2026-09-20", 10, 0, 10],
      ["2026-09-21", 10, 0, 10],
      ["2026-09-22", 13, 3, 10], // A done, B 5 → 8
      ["2026-09-23", 12, 0, 12], // C canceled (out of scope), D joins, A reopened
      ["2026-09-24", 12, 3, 9], // A done again (read at now)
      ["2026-09-25", null, null, null],
      ["2026-09-26", null, null, null],
    ]);
    expect(r.rows.map((x) => x.ideal)).toEqual([10, 8.3, 6.7, 5, 3.3, 1.7, 0]);
    expect(r.rows[0].unit).toBe("points");
    expect(r.rows.filter((x) => x.future).length).toBe(2);
    // 3 of 12 done after 5 days: 9 remaining needs 15 more days: 13 days late.
    expect(r.summary).toBe("Scope grew 20% this cycle; 3 of 12 points done; projected to finish 13 days late.");
    const count = computeDataset("cycle_burndown", ctx, { params: { cycle: "current", unit: "count" } });
    expect(count.rows[4]).toMatchObject({ scope: 3, completed: 1, remaining: 2 });
  });

  it("burnup for the cycle and for scope", async () => {
    const { ctx } = await journal();
    const r = computeDataset("burnup", ctx, { params: { cycle: "current" } });
    expect(r.rows.slice(0, 5).map((x) => [x.scope, x.completed])).toEqual([[10, 0], [10, 0], [13, 3], [12, 0], [12, 3]]);
    expect(r.summary).toMatch(/^Cycle 7: 3 of 12 points done \(25%\)\. Scope grew 20% this cycle; projected to finish 13 days late\.$/);
    expect(() => computeDataset("burnup", ctx, { params: { scope: "project" } })).toThrow(/^invalid_request: No project matches/);
    expect(() => computeDataset("burnup", ctx, { params: { scope: "team" } })).toThrow(/scope is cycle or project/);
  });

  it("cumulative flow counts each kind at the end of each UTC day", async () => {
    const { ctx } = await journal();
    const r = computeDataset("daily_state_counts", ctx, { params: { days: 3 } });
    const on = (/** @type {string} */ day) => Object.fromEntries(r.rows.filter((x) => x.day === day).map((x) => [x.kind, x.count]));
    expect(on("2026-09-22")).toEqual({ triage: 0, backlog: 0, unstarted: 2, started: 0, completed: 1, canceled: 0 });
    expect(on("2026-09-23")).toEqual({ triage: 1, backlog: 0, unstarted: 2, started: 1, completed: 0, canceled: 1 });
    expect(on("2026-09-24")).toEqual({ triage: 1, backlog: 0, unstarted: 2, started: 0, completed: 1, canceled: 1 });
    expect(r.rows.find((x) => x.day === "2026-09-23" && x.kind === "unstarted")?.points).toBe(9); // B 8 + D 1
    expect(r.summary).toBe("Over the last 3 days work in progress held at 0 items and 0 more items were completed; 1 item waits in triage.");
  });

  it("transitions include creation, reopen and cancel with actors", async () => {
    const { ctx } = await journal();
    const r = computeDataset("transitions", ctx, { query: "key:WRK-1" });
    expect(r.rows.map((x) => `${x.from_state ?? "∅"}→${x.to_state}`)).toEqual(["∅→Todo", "Todo→In Progress", "In Progress→Done", "Done→In Progress", "In Progress→Done"]);
    expect(r.rows[1]).toMatchObject({ actor: "grace@example.com", day: "2026-09-21", at: "2026-09-21T10:00:00.000Z", to_kind: "started" });
    const all = computeDataset("transitions", ctx);
    expect(all.rows.some((x) => x.to_state === "Canceled")).toBe(true);
    expect(computeDataset("transitions", ctx, { params: { days: 1 } }).rows.map((x) => x.day)).toEqual(["2026-09-24"]);
  });

  it("created vs resolved counts a reopened item's second resolution", async () => {
    const { ctx } = await journal();
    const r = computeDataset("created_vs_resolved", ctx, { params: { days: 7 } });
    const by = Object.fromEntries(r.rows.map((x) => [x.day, [x.created, x.resolved]]));
    expect(by["2026-09-19"]).toEqual([3, 0]);
    expect(by["2026-09-22"]).toEqual([0, 1]);
    expect(by["2026-09-23"]).toEqual([2, 1]); // D and E (23:59Z) created; C canceled
    expect(by["2026-09-24"]).toEqual([0, 1]); // A resolved again
    expect(r.rows.at(-1)).toMatchObject({ created_total: 5, resolved_total: 3 });
    expect(r.summary).toBe("In the last 7 days 5 items were created and 3 resolved, so open work grew by 2.");
  });

  it("cycle time runs from first start to last completion; throughput counts the last completion's week", async () => {
    const { ctx } = await journal();
    const ct = computeDataset("cycle_time", ctx);
    expect(ct.rows).toHaveLength(1);
    expect(ct.rows[0]).toMatchObject({ key: "WRK-1", days: 3, p50: 3, p85: 3, rolling_avg: 3, started: "2026-09-21T10:00:00.000Z", completed: "2026-09-24T09:00:00.000Z" });
    expect(ct.summary).toMatch(/^Median cycle time 3 days; 85% of items finished within 3 days \(1 item completed in the last 90 days\)\.$/);
    const tp = computeDataset("throughput", ctx, { params: { weeks: 2 } });
    expect(tp.rows).toEqual([{ week: "2026-09-14", completed: 0, points: 0, partial: false }, { week: "2026-09-21", completed: 1, points: 3, partial: true }]);
  });

  it("workload counts committed work per person and kind", async () => {
    const { ctx } = await journal();
    const r = computeDataset("workload", ctx);
    expect(r.rows.map((x) => [x.assignee, x.kind, x.count, x.points])).toEqual([["Unassigned", "unstarted", 2, 9]]);
    const open = computeDataset("workload", ctx, { params: { kinds: "open" } });
    expect(open.rows.map((x) => [x.assignee, x.kind, x.count])).toEqual([["Unassigned", "triage", 1], ["Unassigned", "unstarted", 2]]);
    expect(open.summary).toBe("All 3 items are unassigned.");
    expect(() => computeDataset("workload", ctx, { params: { kinds: "done" } })).toThrow(/^invalid_request: kinds/);
  });

  it("dependencies flag chains and filter by query with context nodes", async () => {
    const { ctx } = await journal();
    const r = computeDataset("dependencies", ctx);
    const nodes = Object.fromEntries(r.rows.filter((x) => x.type === "node").map((x) => [x.key, x]));
    expect(Object.keys(nodes)).toEqual(["WRK-2", "WRK-4", "WRK-5"]);
    expect(nodes["WRK-4"]).toMatchObject({ blocked: true, depth: 2, chain: false });
    expect(nodes["WRK-2"]).toMatchObject({ blocked: true, blocking: 1, depth: 1, chain: true });
    expect(nodes["WRK-5"]).toMatchObject({ blocked: false, blocking: 1, depth: 0 });
    expect(r.rows.filter((x) => x.type === "edge").map((x) => [x.source, x.target, x.critical])).toEqual([["WRK-2", "WRK-4", true], ["WRK-5", "WRK-2", true]]);
    expect(r.summary).toBe("2 items are blocked by 2 unfinished items; the longest chain is 2 deep: WRK-5 → WRK-2 → WRK-4.");
    const q = computeDataset("dependencies", ctx, { query: "key:WRK-4" });
    expect(q.rows.filter((x) => x.type === "node").map((x) => [x.key, x.context])).toEqual([["WRK-2", true], ["WRK-4", false]]);
  });

  it("validates parameters and cycles with helpful messages", async () => {
    const { ctx } = await journal();
    expect(() => computeDataset("cycle_burndown", ctx, { params: { cycle: "Cycle 99" } })).toThrow(/No cycle matches “Cycle 99”\. Cycles: Cycle 7, Cycle 8\./);
    expect(() => computeDataset("throughput", ctx, { params: { weeks: 0 } })).toThrow(/weeks must be a whole number from 1 to 104/);
    expect(() => computeDataset("throughput", ctx, { params: { week: 3 } })).toThrow(/has no parameter “week”; it takes weeks/);
    expect(() => computeDataset("daily_state_counts", ctx, { params: { end: "yesterday" } })).toThrow(/end is a date/);
    expect(findCycle(ctx.index, "next", "2026-09-24").name).toBe("Cycle 8");
    expect(findCycle(ctx.index, "previous", "2026-09-28").name).toBe("Cycle 7");
    expect(findCycle(ctx.index, 8, "2026-09-24").name).toBe("Cycle 8");
  });

  it("a cycle that has not started or has ended reads naturally", async () => {
    const { ctx } = await journal();
    const next = computeDataset("cycle_burndown", ctx, { params: { cycle: "next" } });
    expect(next.rows.every((x) => x.future)).toBe(true);
    expect(next.summary).toBe("Cycle 8 starts on 2026-09-27 with 0 items planned.");
    const later = await journal({ now: T("2026-09-30T12:00:00Z") });
    expect(computeDataset("cycle_burndown", later.ctx, { params: { cycle: "Cycle 7" } }).summary).toBe("Cycle 7 ended with 3 of 12 points done (25%). Scope grew 20% over the cycle.");
  });

  it("without change times, flow datasets fall back to creation times and say so through history flags", async () => {
    const { ctx } = await journal();
    const bare = { ...ctx, history: new Map(), historyVersion: -1, historyComplete: false };
    const r = computeDataset("transitions", bare);
    expect(r.rows.every((x) => x.from_state === null)).toBe(true);
    expect(r.history).toEqual({ used: true, complete: false });
  });

  it("every dataset documents its columns and parameters and returns only declared columns", async () => {
    const { ctx } = await journal();
    for (const d of listDatasets()) {
      expect(d.description.length).toBeGreaterThan(20);
      const r = computeDataset(d.name, ctx, { params: d.name === "burnup" ? { cycle: "Cycle 7" } : d.name === "cycle_burndown" ? { cycle: "Cycle 7" } : {} });
      const declared = new Set(d.columns.map((c) => c.name));
      for (const row of r.rows) for (const k of Object.keys(row)) if (!["planned", "unestimated"].includes(k)) expect(declared.has(k), `${d.name}.${k}`).toBe(true);
      expect(typeof r.summary).toBe("string");
    }
  });
});
