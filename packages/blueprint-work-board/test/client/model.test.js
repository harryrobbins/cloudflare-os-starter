import { describe, expect, it } from "vitest";
import { buildIndex, itemByKey, personName, progressOf, projectItem, relationsFor, resolveState } from "../../src/shared/model/index.js";
import { NONE, dueBucket, groupableFields, property } from "../../src/shared/model/properties.js";
import {
  DEFAULT_STATES, actorLabel, addDays, categoryOfKind, dateOnly, daysBetween, hasPlanning, initials, instant, isIsoDate,
  keyPrefixFrom, priorityOf, refId, safeColor, validKeyPrefix, validTitle, viewerActor,
} from "../../src/shared/model/work.js";
import { ADA, BOB, CYCLE, PROJECT, TODAY, id, records } from "../wql/fixture.js";

const index = buildIndex(records(), { keyPrefix: "WRK" });
const ctx = { index, today: TODAY, viewer: ADA };
const item = (/** @type {number} */ n) => /** @type {any} */ (index.byNumber.get(n));

describe("work.js helpers", () => {
  it.each([
    ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000001"],
    ["records://x/work_item/AAAAAAAA-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000001"],
    ["not a ref", null], [42, null], ["", null],
  ])("refId(%j)", (v, out) => expect(refId(v)).toBe(out));
  it.each([["Team work", "TW"], ["Website", "WEB"], ["", "WRK"], ["a", "WRK"], ["Big Data Platform Team Extra", "BDPT"], ["9 lives", "L"]])("keyPrefixFrom(%j)", (l, p) => {
    const out = keyPrefixFrom(l);
    if (p === "L") expect(out).toBe("WRK"); else expect(out).toBe(p);
  });
  it.each([["WRK", true], ["A", false], ["ab", false], ["A1", true], ["1A", false], ["ABCDEFGHIJK", false]])("validKeyPrefix(%j)", (p, ok) => expect(validKeyPrefix(p)).toBe(ok));
  it("actor labels as today", () => {
    expect(actorLabel("cloudflare-os:ada@example.com")).toBe("ada@example.com");
    expect(actorLabel("records:principal:1")).toBe("a service credential");
    expect(actorLabel("records:operator:x")).toBe("an operator");
    expect(actorLabel(undefined)).toBe("unknown");
    expect(actorLabel(ADA, new Map([[ADA, "Ada Lovelace"]]))).toBe("Ada Lovelace");
    expect(viewerActor({ id: "ada@example.com" })).toBe(ADA);
    expect(viewerActor(null)).toBeNull();
  });
  it("small helpers", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("ada@example.com")).toBe("AD");
    expect(initials("")).toBe("?");
    expect(isIsoDate("2026-02-30")).toBe(true); // Date.parse rolls over; shape check only
    expect(isIsoDate("2026-9-1")).toBe(false);
    expect(dateOnly("2026-09-01T10:00:00Z")).toBe("2026-09-01");
    expect(dateOnly(5)).toBeNull();
    expect(instant("x")).toBeNull();
    expect(instant(5)).toBe(5);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-09-01", "2026-09-26")).toBe(25);
    expect(categoryOfKind("started")).toBe("active");
    expect(categoryOfKind("canceled")).toBe("done");
    expect(categoryOfKind("nope")).toBe("open");
    expect(safeColor("#ABCDEF", "#000")).toBe("#abcdef");
    expect(safeColor("red", "#000")).toBe("#000");
    expect(priorityOf(3)).toBe(3);
    expect(priorityOf(9)).toBe(0);
    expect(priorityOf("2")).toBe(2);
    expect(validTitle("  a   b ")).toEqual({ ok: true, title: "a b" });
    expect(validTitle("").ok).toBe(false);
  });
  it("hasPlanning from manifest, profile or records", () => {
    expect(hasPlanning({ description: { modules: [{ id: "work", entities: ["work_item", "workflow_state"] }] } })).toBe(true);
    expect(hasPlanning({ description: { modules: [{ id: "work", commands: ["work.state.create"] }] } })).toBe(true);
    expect(hasPlanning({ model: { profile: { entities: { work_item: { fields: { number: {} } } } } } })).toBe(true);
    expect(hasPlanning({ records: [{ entity: "label", data: {} }] })).toBe(true);
    expect(hasPlanning({ description: { modules: [{ id: "work", entities: ["work_item"] }] }, records: [{ entity: "work_item", data: { title: "x" } }] })).toBe(false);
  });
});

describe("buildIndex", () => {
  it("normalises items", () => {
    const a = item(1);
    expect(a).toMatchObject({ key: "WRK-1", title: "Login page redesign", state: "in_progress", kind: "started", category: "active", priority: 1, assignee: ADA, labels: ["bug", "ui"], estimate: 5, due: "2026-09-24", project: PROJECT.web, cycle: CYCLE.cur, rank: "a0" });
    expect(a.created).toBeTypeOf("number");
    expect(index.itemList).toHaveLength(12);
  });
  it("resolves state from status when state is absent", () => {
    expect(item(11)).toMatchObject({ state: "in_progress", category: "active" });
  });
  it("sorts states by position", () => {
    expect(index.states.map((s) => s.key)).toEqual(["triage", "backlog", "todo", "in_progress", "in_review", "done", "cancelled"]);
    expect(index.virtualStates).toBe(false);
  });
  it("virtual default states when a planning datastore has none yet", () => {
    const ix = buildIndex([{ id: id(1), entity: "work_item", revision: 1, data: { title: "x", status: "done", number: 1 } }], { label: "Team work" });
    expect(ix.planning).toBe(true);
    expect(ix.virtualStates).toBe(true);
    expect(ix.states.map((s) => s.key)).toEqual(DEFAULT_STATES.map((s) => s.key));
    expect(ix.states).toHaveLength(7);
    expect(ix.stateByKey.has("canceled")).toBe(true);
    expect(ix.states[0].color).toBe("#fc7840");
    expect(ix.itemList[0].state).toBe("done");
    expect(ix.itemList[0].key).toBe("TW-1");
  });
  it("v1 datastores get Open/Active/Done", () => {
    const ix = buildIndex([{ id: id(1), entity: "work_item", revision: 1, data: { title: "x", status: "active" } }]);
    expect(ix.planning).toBe(false);
    expect(ix.states.map((s) => s.key)).toEqual(["open", "active", "done"]);
    expect(ix.itemList[0].state).toBe("active");
    expect(ix.itemList[0].key).toBe(`#${id(1).slice(0, 6)}`);
  });
  it("blocking graph ignores done blockers", () => {
    expect(index.blockedBy.get(id(2))).toEqual([id(8)]);
    expect(index.blocking.get(id(8))).toEqual([id(2)]);
    expect(index.blockedBy.has(id(12))).toBe(false);
  });
  it("children, progress and relations", () => {
    expect(index.children.get(id(1))?.map((i) => i.number).toSorted((a, b) => a - b)).toEqual([3, 10]);
    expect(progressOf(index, id(1))).toEqual({ done: 0, total: 2 });
    expect(progressOf(index, id(2))).toBeNull();
    const r = relationsFor(index, id(3));
    expect(r.relates).toHaveLength(1);
    expect(relationsFor(index, id(2)).blockedBy[0].from).toBe(id(8));
    expect(relationsFor(index, id(8)).blocks[0].to).toBe(id(2));
  });
  it("inactive relations are kept but not indexed", () => {
    const ix = buildIndex([...records(), { id: "ffffffff-0000-4000-8000-000000000009", entity: "relation", revision: 99, data: { from: id(1), to: id(4), kind: "blocks", active: false } }]);
    expect(ix.relations.some((r) => !r.active)).toBe(true);
    expect(ix.blockedBy.has(id(4))).toBe(false);
  });
  it("comments and people", () => {
    const ix = buildIndex([...records(), { id: "99999999-0000-4000-8000-000000000001", entity: "comment", revision: 100, created_by: BOB, data: { item: id(1), body: "Hi", edited: true } }, { id: "99999999-0000-4000-8000-000000000002", entity: "comment", revision: 98, created_by: ADA, data: { item: id(1), body: "First" } }]);
    expect(ix.comments.get(id(1))?.map((c) => c.body)).toEqual(["First", "Hi"]);
    expect(ix.people.has(ADA) && ix.people.has(BOB)).toBe(true);
    expect(personName(ix, null)).toBe("Unassigned");
    expect(personName(ix, ADA)).toBe("ada@example.com");
  });
  it("learned times fill in missing timestamps", () => {
    const ix = buildIndex([{ id: id(1), entity: "work_item", revision: 1, data: { title: "x", number: 1 } }], { times: new Map([[id(1), { created: 5, updated: 9 }]]) });
    expect(ix.itemList[0]).toMatchObject({ created: 5, updated: 9 });
  });
  it("skips garbage records", () => {
    const ix = buildIndex([/** @type {any} */ (null), { entity: "work_item", revision: 1, data: {} }]);
    expect(ix.itemList).toHaveLength(0);
  });
});

describe("resolveState / itemByKey / projectItem", () => {
  it("resolveState falls back sensibly", () => {
    expect(resolveState("todo", "open", index.stateByKey, index.states).key).toBe("todo");
    expect(resolveState("nope", "done", index.stateByKey, index.states).key).toBe("done");
    expect(resolveState(undefined, "active", index.stateByKey, index.states).key).toBe("in_progress");
  });
  it.each([["WRK-3", 3], ["3", 3], ["wrk-3", 3], ["XYZ-3", 3], ["WRK-999", null], ["", null]])("itemByKey(%j)", (k, n) => {
    const it_ = itemByKey(index, k);
    expect(it_?.number ?? null).toBe(n);
  });
  it("itemByKey by id prefix and full id", () => {
    expect(itemByKey(index, `#${id(4).slice(0, 8)}`)?.id).toBeDefined();
    expect(itemByKey(index, id(4).toUpperCase())?.number).toBe(4);
  });
  it("projectItem previews a state change with its category", () => {
    const p = projectItem(index, item(2), { id: id(2), state: "done" });
    expect(p).toMatchObject({ state: "done", category: "done", status: "done", key: "WRK-2" });
    expect(item(2).state).toBe("todo");
  });
  it("status-only preview picks the mapped state; null clears", () => {
    const p = projectItem(index, item(1), { status: "done", assignee: null, labels: null });
    expect(p.state).toBe("done");
    expect(p.assignee).toBeNull();
    expect(p.labels).toEqual([]);
  });
  it("new item preview", () => {
    const p = projectItem(index, null, { title: "New thing", state: "todo" }, "pending:1");
    expect(p).toMatchObject({ id: "pending:1", key: "New", title: "New thing", state: "todo" });
  });
});

describe("properties", () => {
  it("unknown fields", () => {
    expect(property("nope")).toBeNull();
    expect(property(null)).toBeNull();
    expect(property("ext.bad name")).toBeNull();
  });
  it("state: groups, keys, patch (planning and v1)", () => {
    const p = /** @type {any} */ (property("state"));
    expect(p.groups(ctx, []).map((g) => g.key)).toHaveLength(7);
    expect(p.keysOf(item(1), ctx)).toEqual(["in_progress"]);
    expect(p.patch(item(1), "in_progress", "done", ctx)).toEqual({ state: "done" });
    expect(p.patch(item(1), "in_progress", "in_progress", ctx)).toBeNull();
    expect(p.patch(item(1), "x", NONE, ctx)).toBeNull();
    const v1 = buildIndex([{ id: id(1), entity: "work_item", revision: 1, data: { title: "x" } }]);
    expect(p.patch(v1.itemList[0], "open", "done", { index: v1, today: TODAY, viewer: null })).toEqual({ status: "done" });
  });
  it("status", () => {
    const p = /** @type {any} */ (property("status"));
    expect(p.groups(ctx, []).map((g) => g.key)).toEqual(["open", "active", "done"]);
    expect(p.patch(item(1), "active", "done", ctx)).toEqual({ status: "done" });
    expect(p.patch(item(1), "active", "active", ctx)).toBeNull();
  });
  it("assignee: people A–Z, Unassigned last", () => {
    const p = /** @type {any} */ (property("assignee"));
    const g = p.groups(ctx, index.itemList);
    expect(g.at(-1)).toMatchObject({ key: NONE, none: true });
    expect(g.slice(0, -1).map((x) => x.key)).toEqual([ADA, BOB]);
    expect(p.keysOf(item(4), ctx)).toEqual([NONE]);
    expect(p.patch(item(4), NONE, ADA, ctx)).toEqual({ assignee: ADA });
    expect(p.patch(item(1), ADA, NONE, ctx)).toEqual({ assignee: null });
    expect(p.patch(item(1), ADA, ADA, ctx)).toBeNull();
  });
  it("priority: urgent first, none last", () => {
    const p = /** @type {any} */ (property("priority"));
    expect(p.groups(ctx, []).map((g) => g.key)).toEqual(["1", "2", "3", "4", "0"]);
    expect(p.patch(item(1), "1", "3", ctx)).toEqual({ priority: 3 });
    expect(p.patch(item(1), "1", "1", ctx)).toBeNull();
  });
  it("project and cycle", () => {
    const pr = /** @type {any} */ (property("project"));
    expect(pr.groups(ctx, index.itemList).map((g) => g.label)).toEqual(["Public API", "Website relaunch", "No project"]);
    expect(pr.patch(item(4), NONE, PROJECT.api, ctx)).toEqual({ project: PROJECT.api });
    expect(pr.patch(item(1), PROJECT.web, NONE, ctx)).toEqual({ project: null });
    const cy = /** @type {any} */ (property("cycle"));
    const g = cy.groups(ctx, []);
    expect(g.map((x) => x.label)).toEqual(["Cycle 1", "Cycle 2 (current)", "Cycle 3", "No cycle"]);
    expect(cy.patch(item(1), CYCLE.cur, CYCLE.next, ctx)).toEqual({ cycle: CYCLE.next });
  });
  it("parent", () => {
    const p = /** @type {any} */ (property("parent"));
    const g = p.groups(ctx, index.itemList);
    expect(g[0].label).toBe("WRK-1 Login page redesign");
    expect(p.keysOf(item(3), ctx)).toEqual([id(1)]);
    expect(p.keysOf(item(2), ctx)).toEqual([NONE]);
    expect(p.patch(item(1), NONE, id(1), ctx)).toBeNull();
    expect(p.patch(item(2), NONE, id(1), ctx)).toEqual({ parent: id(1) });
    expect(p.patch(item(3), id(1), NONE, ctx)).toEqual({ parent: null });
  });
  it("label lanes: one card per label, patches swap labels", () => {
    const p = /** @type {any} */ (property("label"));
    expect(p.multi).toBe(true);
    expect(p.keysOf(item(1), ctx)).toEqual(["bug", "ui"]);
    expect(p.keysOf(item(5), ctx)).toEqual([NONE]);
    const keys = p.groups(ctx, index.itemList).map((g) => g.key);
    expect(keys.at(-1)).toBe(NONE);
    expect(keys).toContain("regression");
    expect(p.patch(item(1), "bug", "docs", ctx)).toEqual({ labels: ["ui", "docs"] });
    expect(p.patch(item(1), "bug", NONE, ctx)).toEqual({ labels: ["ui"] });
    expect(p.patch(item(5), NONE, "bug", ctx)).toEqual({ labels: ["bug"] });
    expect(p.patch(item(1), "bug", "ui", ctx)).toEqual({ labels: ["ui"] });
    expect(p.patch(item(1), "bug", "bug", ctx)).toBeNull();
  });
  it.each([[1, "overdue"], [3, "today"], [2, "week"], [8, "later"], [4, NONE], [6, "past"]])("dueBucket of item %i", (n, b) => {
    expect(dueBucket(item(n), TODAY)).toBe(b);
  });
  it("due and created_by are not settable", () => {
    for (const f of ["due", "created_by"]) {
      const p = /** @type {any} */ (property(f));
      expect(p.settable).toBe(false);
      expect(p.why).toBeTruthy();
      expect(p.patch(item(1), "a", "b", ctx)).toBeNull();
    }
    expect(/** @type {any} */ (property("due")).groups(ctx, []).map((g) => g.key)).toEqual(["overdue", "today", "week", "later", "past", NONE]);
    expect(/** @type {any} */ (property("created_by")).keysOf(item(5), ctx)).toEqual([BOB]);
  });
  it("ext.* fields", () => {
    const p = /** @type {any} */ (property("ext.team"));
    expect(p.field).toBe("ext.team");
    expect(p.groups(ctx, index.itemList).map((g) => g.key)).toEqual(["Platform", "Web", NONE]);
    expect(p.keysOf(item(1), ctx)).toEqual(["Web"]);
    expect(p.keysOf(item(2), ctx)).toEqual([NONE]);
    expect(p.patch(item(1), "Web", "Platform", ctx)).toEqual({ extensions: { team: "Platform", points: 3 } });
    expect(p.patch(item(1), "Web", NONE, ctx)).toEqual({ extensions: { points: 3 } });
    expect(p.patch(item(1), "Web", "Web", ctx)).toBeNull();
    expect(/** @type {any} */ (property("ext.tags")).keysOf(item(10), ctx)).toEqual(['["a","b"]']);
  });
  it("groupableFields includes ext fields for planning, little for v1", () => {
    const f = groupableFields(index).map((x) => x.field);
    expect(f).toContain("assignee");
    expect(f).toContain("ext.team");
    const v1 = buildIndex([{ id: id(1), entity: "work_item", revision: 1, data: { title: "x" } }]);
    expect(groupableFields(v1).map((x) => x.field)).toEqual(["state", "created_by"]);
  });
});
