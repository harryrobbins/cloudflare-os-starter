import { describe, expect, it } from "vitest";
import { PLANNING_FIELDS, V1_FIELDS, checkEntityInput, checkItemFields, friendlyReason, inversePatch, updateInput } from "../../src/client/store/commands.js";

const P = { planning: true };
const U = "11111111-2222-4333-8444-555555555555";
const item = (/** @type {Record<string, unknown>} */ data) => ({ id: U, raw: { data } });

describe("checkItemFields: valid", () => {
  it.each([
    [{ title: "  A   title " }, { title: "A title" }],
    [{ description: "x" }, { description: "x" }],
    [{ status: "done" }, { status: "done" }],
    [{ state: "in_review" }, { state: "in_review" }],
    [{ priority: 0 }, { priority: 0 }],
    [{ priority: 4 }, { priority: 4 }],
    [{ assignee: "cloudflare-os:ada@example.com" }, { assignee: "cloudflare-os:ada@example.com" }],
    [{ labels: [" bug ", "ui"] }, { labels: ["bug", "ui"] }],
    [{ labels: [] }, { labels: [] }],
    [{ estimate: 0 }, { estimate: 0 }],
    [{ estimate: 1000 }, { estimate: 1000 }],
    [{ estimate: 2.5 }, { estimate: 2.5 }],
    [{ due_date: "2026-10-01" }, { due_date: "2026-10-01" }],
    [{ start_date: "2026-10-01", due_date: "2026-10-01" }, { start_date: "2026-10-01", due_date: "2026-10-01" }],
    [{ parent: U }, { parent: U }],
    [{ project: U, cycle: U }, { project: U, cycle: U }],
    [{ rank: "a0i" }, { rank: "a0i" }],
    [{ archived: true }, { archived: true }],
    [{ extensions: { team: "Web" } }, { extensions: { team: "Web" } }],
    [{ assignee: null, labels: null, due_date: null }, { assignee: null, labels: null, due_date: null }],
    [{ title: undefined, priority: 2 }, { priority: 2 }],
  ])("%j", (fields, input) => {
    expect(checkItemFields(fields, P)).toEqual({ ok: true, input });
  });
});

describe("checkItemFields: refused", () => {
  it.each([
    [{ title: "" }, "title"], [{ title: "x".repeat(501) }, "title"], [{ title: 5 }, "title"],
    [{ description: 5 }, "description"], [{ description: "x".repeat(20_001) }, "description"],
    [{ status: "blocked" }, "status"], [{ status: null }, "status"], [{ state: null }, "state"], [{ state: "" }, "state"],
    [{ priority: 5 }, "priority"], [{ priority: -1 }, "priority"], [{ priority: 1.5 }, "priority"], [{ priority: "1" }, "priority"],
    [{ assignee: "ada" }, "assignee"], [{ assignee: "Cloudflare:ada" }, "assignee"],
    [{ labels: "bug" }, "labels"], [{ labels: ["bug", "bug"] }, "labels"], [{ labels: ["  "] }, "labels"], [{ labels: ["x".repeat(61)] }, "labels"],
    [{ labels: ["a\u0007b"] }, "labels"], [{ labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }, "labels"],
    [{ estimate: -1 }, "estimate"], [{ estimate: 1001 }, "estimate"], [{ estimate: Number.NaN }, "estimate"], [{ estimate: "3" }, "estimate"],
    [{ due_date: "30/09/2026" }, "due_date"], [{ start_date: "2026-9-1" }, "start_date"],
    [{ parent: "not-an-id" }, "parent"], [{ project: 3 }, "project"], [{ cycle: "" }, "cycle"],
    [{ rank: "a0" }, "rank"], [{ rank: "A" }, "rank"], [{ archived: "yes" }, "archived"], [{ extensions: [] }, "extensions"],
    [{ bogus: 1 }, "bogus"],
    [{ start_date: "2026-10-05", due_date: "2026-10-01" }, "due_date"],
  ])("%j → %s", (fields, field) => {
    const r = checkItemFields(fields, P);
    expect(r.ok).toBe(false);
    expect(/** @type {any} */ (r).field).toBe(field);
    expect(/** @type {any} */ (r).error).toBeTruthy();
  });

  it("v1 datastores refuse planning fields with an explanation", () => {
    const r = /** @type {any} */ (checkItemFields({ priority: 1 }, { planning: false }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/migration 010/);
    expect(checkItemFields({ title: "x", status: "open" }, { planning: false })).toEqual({ ok: true, input: { title: "x", status: "open" } });
    expect(V1_FIELDS.every((f) => PLANNING_FIELDS.includes(f))).toBe(true);
  });
});

describe("checkItemFields: create", () => {
  it("needs a title and drops nulls", () => {
    expect(checkItemFields({ description: "x" }, { ...P, create: true })).toMatchObject({ ok: false, field: "title" });
    expect(checkItemFields({ title: "x", assignee: null, extensions: null }, { ...P, create: true })).toEqual({ ok: true, input: { title: "x" } });
  });
  it("passes a client id through, only when it is a UUID", () => {
    expect(checkItemFields({ id: U, title: "x" }, { ...P, create: true })).toEqual({ ok: true, input: { title: "x", id: U } });
    expect(checkItemFields({ id: "nope", title: "x" }, { ...P, create: true })).toEqual({ ok: true, input: { title: "x" } });
    expect(checkItemFields({ id: U, title: "x" }, P)).toEqual({ ok: true, input: { title: "x" } });
  });
});

describe("due ≥ start with the committed item", () => {
  const current = { start_date: "2026-10-10", due_date: "2026-10-20" };
  it.each([
    [{ due_date: "2026-10-01" }, false],
    [{ due_date: "2026-10-10" }, true],
    [{ start_date: "2026-10-25" }, false],
    [{ start_date: "2026-10-25", due_date: null }, true],
    [{ due_date: null }, true],
    [{ title: "x" }, true],
  ])("%j ok=%s", (fields, ok) => expect(checkItemFields(fields, { ...P, current }).ok).toBe(ok));
});

describe("updateInput", () => {
  it("returns only changed fields with the id", () => {
    expect(updateInput(item({ title: "A", priority: 2 }), { title: "A", priority: 3 }, P)).toEqual({ ok: true, input: { id: U, priority: 3 } });
  });
  it("returns null when nothing changes", () => {
    expect(updateInput(item({ title: "A", labels: ["x"] }), { title: "A", labels: ["x"] }, P)).toBeNull();
  });
  it("absent and empty are the same", () => {
    expect(updateInput(item({ title: "A" }), { labels: [], assignee: null, estimate: undefined }, P)).toBeNull();
  });
  it("clearing labels sends null; clearing a field sends null", () => {
    expect(updateInput(item({ labels: ["x"], assignee: "a:b" }), { labels: [], assignee: null }, P)).toEqual({ ok: true, input: { id: U, labels: null, assignee: null } });
  });
  it("validates what changed", () => {
    expect(updateInput(item({ priority: 1 }), { priority: 9 }, P)).toMatchObject({ ok: false, field: "priority" });
    expect(updateInput(item({ start_date: "2026-10-10" }), { due_date: "2026-10-01" }, P)).toMatchObject({ ok: false, field: "due_date" });
  });
  it("object values compare structurally", () => {
    expect(updateInput(item({ extensions: { a: 1 } }), { extensions: { a: 1 } }, P)).toBeNull();
    expect(updateInput(item({ extensions: { a: 1 } }), { extensions: { a: 2 } }, P)).toEqual({ ok: true, input: { id: U, extensions: { a: 2 } } });
  });
});

describe("inversePatch", () => {
  it("restores previous values, null for absent", () => {
    expect(inversePatch(item({ priority: 2, state: "todo", status: "open" }), { id: U, priority: 1, assignee: "a:b", state: "done" })).toEqual({ priority: 2, assignee: null, state: "todo" });
  });
  it("never clears state or status", () => {
    expect(inversePatch(item({}), { id: U, state: "done", status: "done" })).toEqual({});
  });
});

describe("checkEntityInput", () => {
  it.each([
    ["work.state.create", { key: "in_qa", name: "In QA", kind: "started", color: "#112233", position: 3 }, true],
    ["work.state.create", { key: "In QA", name: "In QA", kind: "started" }, false],
    ["work.state.create", { key: "qa", name: "QA" }, false],
    ["work.state.create", { key: "qa", name: "", kind: "started" }, false],
    ["work.state.create", { key: "qa", name: "QA", kind: "doing" }, false],
    ["work.state.update", { id: U, wip_limit: 5 }, true],
    ["work.state.update", { id: U, wip_limit: null }, true],
    ["work.state.update", { id: U, wip_limit: 0 }, false],
    ["work.state.update", { id: U, color: "red" }, false],
    ["work.state.update", { id: U, position: -1 }, false],
    ["work.state.update", { id: U, position: 100_001 }, false],
    ["work.state.update", { id: U, name: "x".repeat(61) }, false],
    ["work.label.create", { name: "Bug", color: "#ff0000" }, true],
    ["work.label.create", { name: "" }, false],
    ["work.label.update", { id: U, color: "#12" }, false],
    ["work.label.update", { id: U, archived: true }, true],
    ["work.project.create", { name: "Web", state: "planned" }, true],
    ["work.project.create", { name: "Web", state: "canceled" }, false],
    ["work.project.update", { id: U, start_date: "2026-10-10", target_date: "2026-10-01" }, false],
    ["work.project.update", { id: U, target_date: "soon" }, false],
    ["work.project.update", { id: U, target_date: null }, true],
    ["work.cycle.create", { starts_on: "2026-10-01", ends_on: "2026-10-14" }, true],
    ["work.cycle.create", { starts_on: "2026-10-01" }, false],
    ["work.cycle.create", { starts_on: "2026-10-14", ends_on: "2026-10-01" }, false],
    ["work.cycle.update", { id: U, goal: "x".repeat(2001) }, false],
    ["work.cycle.update", { id: U, name: "Cycle 9" }, true],
    ["work.relation.create", { from: U, to: "b", kind: "blocks" }, true],
    ["work.relation.create", { from: U, to: U, kind: "blocks" }, false],
    ["work.relation.create", { from: U, to: "b", kind: "parent" }, false],
    ["work.relation.create", { from: U, kind: "relates" }, false],
    ["work.relation.update", { id: U, active: false }, true],
    ["work.comment.create", { item: U, body: "  hi  " }, true],
    ["work.comment.create", { item: U, body: "   " }, false],
    ["work.comment.update", { id: U, body: "x".repeat(20_001) }, false],
    ["work.nope", {}, false],
  ])("%s %j ok=%s", (command, input, ok) => {
    expect(checkEntityInput(command, input).ok).toBe(ok);
  });
  it("normalises names, label keys and comment bodies", () => {
    expect(checkEntityInput("work.label.create", { name: " Bug " })).toEqual({ ok: true, input: { name: "Bug", key: "Bug" } });
    expect(checkEntityInput("work.comment.create", { item: U, body: "  hi " })).toEqual({ ok: true, input: { item: U, body: "hi" } });
    expect(checkEntityInput("work.state.create", { key: "qa", name: " QA ", kind: "started" })).toMatchObject({ input: { name: "QA" } });
  });
});

describe("friendlyReason", () => {
  it.each([
    ["", "Records refused the command (412)", "", /changed this first/],
    ["", "Records refused the command (428)", "", /changed this first/],
    ["stale_revision", "", "", /changed this first/],
    ["revision_required", "", "", /changed this first/],
    ["", "Approval was denied", "", /declined/],
    ["", "Viewer authority was revoked or changed", "", /access changed/],
    ["", "Records refused the command (400)", "", /invalid\. Check/],
    ["", "Records refused the command (400): Due date is before start date", "", /invalid: Due date is before start date/],
    ["invalid_request", "bad", "", /invalid/],
    ["", "Records refused the command (403)", "", /not allowed/],
    ["forbidden", "The Workshop could not confirm this change came from you", "", /could not confirm/],
    ["", "Records refused the command (404)", "", /no longer exists/],
    ["not_found", "x", "", /no longer exists/],
    ["read_only", "", "", /read-only/],
    ["unavailable", "", "", /could not be reached/],
    ["", "Something odd", "", /Something odd/],
    ["", "", "", /could not be saved/],
    ["", "Records refused the command (409)", "work.update", /loop of parents/],
    ["", "Records refused the command (409)", "work.cycle.create", /overlap/],
    ["", "Records refused the command (409)", "work.cycle.update", /overlap/],
    ["", "Records refused the command (409)", "work.relation.create", /already related/],
    ["", "Records refused the command (409)", "work.state.create", /key already exists/],
    ["", "Records refused the command (409)", "work.state.update", /category/],
    ["", "Records refused the command (409)", "work.label.create", /label with that key/],
    ["", "Records refused the command (409)", "work.create", /id already exists/],
    ["conflict", "", "work.comment.create", /conflicts with existing data/],
  ])("%s %j %s", (code, detail, command, re) => expect(friendlyReason(code, detail, command)).toMatch(re));
});
