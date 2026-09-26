import { describe, expect, it } from "vitest";
import { recordsOsIntentDigest } from "../../records-service/src/cloudflare-os.ts";
import { DEFAULT_STATES, FakeRecords } from "./fake-records.js";
import { SEED_PEOPLE, mulberry32, seedWork } from "../harness/seed.js";

const ADA = "cloudflare-os:ada@example.com";
const BOB = "cloudflare-os:bob@example.com";
const MISSING = "00000000-0000-4000-8000-00000000ffff";

/** Requests a command the way the client does: digest, viewer assertion, command. */
async function request(fake, command, input, { revision, key = crypto.randomUUID(), viewer = "ada@example.com", binding = "RECORDS", tamper = false } = {}) {
  const c = fake.connectionInfo;
  const digest = await recordsOsIntentDigest({ datastore: c.datastore, binding: c.binding, moduleId: "work", apiMajor: 1, command, input, expectedRevision: revision ?? null, idempotencyKey: key });
  const viewerAssertion = fake.createViewerAssertion(viewer, binding, tamper ? "0".repeat(64) : digest);
  return fake.session().command(command, input, { viewerAssertion, idempotencyKey: key, ...(revision === undefined ? {} : { revision }) });
}

const rows = (fake, entity) => [...fake.rows.values()].filter((r) => r.entity === entity);
const states = (fake) => rows(fake, "workflow_state").map((r) => r.data);
const stateRow = (fake, key) => rows(fake, "workflow_state").find((r) => r.data.key === key);
const item = (fake, title = "Item", extra = {}) => fake.run("work.create", { title, ...extra }, { actor: ADA });
const update = (fake, id, patch, actor = ADA) => fake.run("work.update", { id, ...patch }, { actor, revision: fake.rows.get(id).revision });

describe("FakeRecords work.create / work.update", () => {
  it("seeds the 7 default states in the first command's commit and numbers items gaplessly", () => {
    const fake = new FakeRecords();
    expect(states(fake)).toHaveLength(0);
    const a = item(fake, "A");
    expect(fake.seq).toBe(1);
    expect(states(fake).map((s) => s.key)).toEqual(["triage", "backlog", "todo", "in_progress", "in_review", "done", "canceled"]);
    expect(rows(fake, "workflow_state").every((r) => r.revision === 1 && r.created_by === ADA)).toBe(true);
    expect(fake.journal.map((e) => [e.seq, e.ordinal, e.entity])).toEqual([[1, 0, "work_item"], ...DEFAULT_STATES.map((s) => [1, s.position + 1, "workflow_state"])]);
    expect(stateRow(fake, "canceled").data).toEqual({ key: "canceled", name: "Canceled", kind: "canceled", category: "done", position: 6, color: "#95a2b3" });
    expect(() => item(fake, "")).toThrow(/^invalid_request/);
    const b = item(fake, "B");
    expect([a.data.number, b.data.number, a.revision, b.revision]).toEqual([1, 2, 1, 2]);
    expect(a).toMatchObject({ created_by: ADA, updated_by: ADA });
  });

  it("presents empty optional fields as absent", () => {
    const fake = new FakeRecords();
    expect(item(fake, "x").data).toEqual({ title: "x", description: "", extensions: {}, status: "open", state: "todo", number: 1, archived: false });
    expect(item(fake, "y", { labels: [] }).data.labels).toBeUndefined();
  });

  it("a failed command changes nothing, not even the default states", () => {
    const fake = new FakeRecords();
    expect(() => item(fake, "x", { priority: 9 })).toThrow(/^invalid_request/);
    expect(fake.rows.size).toBe(0);
    expect(fake.journal).toHaveLength(0);
    expect(fake.seq).toBe(0);
    expect(item(fake, "y").data.number).toBe(1);
  });

  it("resolves state and status like records_work.resolve_state", () => {
    const fake = new FakeRecords();
    expect(item(fake, "x", { status: "active" }).data).toMatchObject({ state: "in_progress", status: "active" });
    expect(item(fake, "y", { state: "in_review" }).data).toMatchObject({ state: "in_review", status: "active" });
    expect(item(fake, "z", { status: "done" }).data.state).toBe("done");
    expect(item(fake, "t", { state: "triage" }).data.status).toBe("open");
    expect(() => item(fake, "w", { state: "done", status: "open" })).toThrow(/disagree/);
    expect(() => item(fake, "w", { state: "nope" })).toThrow(/Unknown workflow state/);
    const r = item(fake, "v", { state: "in_review" });
    expect(update(fake, r.id, { status: "active" }).data.state).toBe("in_review");
    expect(update(fake, r.id, { status: "done" }).data).toMatchObject({ state: "done", status: "done" });
    expect(update(fake, r.id, { title: "renamed" }).data.state).toBe("done");
  });

  it.each([
    ["priority 5", { priority: 5 }], ["priority 1.5", { priority: 1.5 }], ["priority as text", { priority: "1" }], ["bad assignee", { assignee: "Ada" }],
    ["21 labels", { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }], ["duplicate labels", { labels: ["a", "a"] }],
    ["long label", { labels: ["x".repeat(61)] }], ["label with spaces around", { labels: [" bug"] }], ["label with control char", { labels: ["a\nb"] }],
    ["non-string label", { labels: [1] }], ["negative estimate", { estimate: -1 }], ["huge estimate", { estimate: 1001 }],
    ["bad due", { due_date: "2026-13-01" }], ["Feb 30", { due_date: "2026-02-30" }], ["bad start", { start_date: "tomorrow" }],
    ["due before start", { start_date: "2026-10-02", due_date: "2026-10-01" }], ["missing parent", { parent: MISSING }],
    ["IRI parent", { parent: `records://x/work_item/${MISSING}` }], ["project not a project", { project: "nope" }], ["unknown cycle", { cycle: MISSING }],
    ["long rank", { rank: "r".repeat(65) }], ["empty rank", { rank: "" }], ["rank with space", { rank: "a b" }], ["archived not bool", { archived: "yes" }],
    ["unknown key", { colour: "red" }], ["extensions array", { extensions: [] }], ["title too long", { title: "t".repeat(501) }],
    ["bad status", { status: "closed" }], ["null title", { title: null }], ["null state", { state: null }], ["bad client id", { id: "abc" }],
  ])("refuses %s (400)", (_, extra) => {
    const fake = new FakeRecords();
    expect(() => item(fake, "Item", extra)).toThrow(/^invalid_request/);
  });

  it("accepts a client id, refusing one already used by any entity (409)", () => {
    const fake = new FakeRecords();
    const id = "11111111-2222-4333-8444-555555555555";
    expect(item(fake, "x", { id: id.toUpperCase() }).id).toBe(id);
    expect(() => item(fake, "y", { id })).toThrow(/^conflict/);
    const label = fake.run("work.label.create", { key: "bug" }, { actor: ADA });
    expect(() => item(fake, "z", { id: label.id })).toThrow(/^conflict/);
    expect(() => fake.run("work.project.create", { id, name: "P" }, { actor: ADA })).toThrow(/^conflict/);
  });

  it("uses bare UUID references, clears with null, replaces labels", () => {
    const fake = new FakeRecords();
    const p = fake.run("work.project.create", { name: "P" }, { actor: ADA });
    const r = item(fake, "x", { project: p.id.toUpperCase(), labels: ["a", "b"], estimate: 3, priority: 2 });
    expect(r.data).toMatchObject({ project: p.id, labels: ["a", "b"], estimate: 3, priority: 2 });
    const u = update(fake, r.id, { project: null, labels: ["c"], estimate: null, priority: null }, BOB);
    expect(u.data.project).toBeUndefined();
    expect(u.data.estimate).toBeUndefined();
    expect(u.data.priority).toBeUndefined();
    expect(u.data.labels).toEqual(["c"]);
    expect(update(fake, r.id, { labels: [] }).data.labels).toBeUndefined();
    expect(u).toMatchObject({ created_by: ADA, updated_by: BOB });
    expect(() => update(fake, r.id, { start_date: "2026-10-05", due_date: "2026-10-01" })).toThrow(/Due date/);
  });

  it("requires a current revision, refuses self parents (400) and parent loops (409)", () => {
    const fake = new FakeRecords();
    const a = item(fake, "a"), b = item(fake, "b", { parent: a.id });
    expect(() => fake.run("work.update", { id: a.id, title: "x" }, { actor: ADA })).toThrow(/^revision_required/);
    expect(() => fake.run("work.update", { id: a.id, title: "x" }, { actor: ADA, revision: 99 })).toThrow(/^stale_revision/);
    expect(() => update(fake, a.id, { parent: b.id })).toThrow(/^conflict/);
    expect(() => update(fake, a.id, { parent: a.id })).toThrow(/^invalid_request/);
    expect(() => fake.run("work.update", { id: MISSING, title: "x" }, { actor: ADA, revision: 1 })).toThrow(/^not_found/);
    expect(() => fake.run("work.create", { title: "x" }, { actor: ADA, revision: 3 })).toThrow(/Create cannot have revision/);
    expect(update(fake, b.id, { parent: null }).data.parent).toBeUndefined();
  });

  it("v1-only datastores accept only the v1 fields and commands", () => {
    const fake = new FakeRecords({ planning: false });
    const r = item(fake, "x", { status: "active" });
    expect(r.data).toEqual({ title: "x", description: "", status: "active", extensions: {} });
    expect(() => item(fake, "y", { priority: 1 })).toThrow(/^invalid_request/);
    expect(() => fake.run("work.label.create", { key: "bug" }, { actor: ADA })).toThrow(/Unknown command/);
    expect(states(fake)).toHaveLength(0);
    expect(fake.describe().modules[0].entities).toEqual(["work_item"]);
    expect(fake.model().profile.entities.workflow_state).toBeUndefined();
  });
});

describe("FakeRecords planning entities", () => {
  it("creates and updates workflow states", () => {
    const fake = new FakeRecords();
    const s = fake.run("work.state.create", { key: "qa", name: "QA", kind: "started" }, { actor: ADA });
    expect(s.data).toEqual({ key: "qa", name: "QA", kind: "started", category: "active", position: 7 });
    expect(fake.run("work.state.create", { key: "later", name: "Later", category: "open" }, { actor: ADA }).data.kind).toBe("unstarted");
    expect(() => fake.run("work.state.create", { key: "qa", name: "T", kind: "triage" }, { actor: ADA })).toThrow(/^conflict/);
    expect(() => fake.run("work.state.create", { key: "Bad Key", name: "T", kind: "triage" }, { actor: ADA })).toThrow(/keys/);
    expect(() => fake.run("work.state.create", { key: "x", name: "X", kind: "doing" }, { actor: ADA })).toThrow(/kind/);
    expect(() => fake.run("work.state.create", { key: "x", name: "X" }, { actor: ADA })).toThrow(/needs a kind/);
    expect(() => fake.run("work.state.create", { key: "x", name: "X", kind: "started", category: "done" }, { actor: ADA })).toThrow(/disagree/);
    expect(() => fake.run("work.state.create", { key: "x", name: "X", kind: "started", position: 100001 }, { actor: ADA })).toThrow(/Position/);
    const upd = (patch) => fake.run("work.state.update", { id: s.id, ...patch }, { actor: ADA, revision: fake.rows.get(s.id).revision });
    expect(() => upd({ wip_limit: 0 })).toThrow(/WIP/);
    expect(() => upd({ color: "red" })).toThrow(/Colours/);
    expect(() => upd({ key: "renamed" })).toThrow(/Invalid workflow state fields/);
    const u = upd({ wip_limit: 3, color: "#AABBCC", name: "Quality" });
    expect(u.data).toMatchObject({ key: "qa", wip_limit: 3, color: "#AABBCC", name: "Quality" });
    expect(upd({ wip_limit: null, color: null }).data).toEqual({ key: "qa", name: "Quality", kind: "started", category: "active", position: 7 });
  });

  it("refuses a category change for a state in use (409) but allows it when unused", () => {
    const fake = new FakeRecords();
    item(fake, "x", { state: "in_review" });
    const review = stateRow(fake, "in_review");
    expect(() => fake.run("work.state.update", { id: review.id, kind: "completed" }, { actor: ADA, revision: review.revision })).toThrow(/^conflict/);
    expect(fake.run("work.state.update", { id: review.id, kind: "started", name: "Review" }, { actor: ADA, revision: review.revision }).data.name).toBe("Review");
    const backlog = stateRow(fake, "backlog");
    expect(fake.run("work.state.update", { id: backlog.id, category: "active" }, { actor: ADA, revision: backlog.revision }).data).toMatchObject({ kind: "started", category: "active" });
  });

  it("labels", () => {
    const fake = new FakeRecords();
    const l = fake.run("work.label.create", { key: "bug", color: "#ff0000" }, { actor: ADA });
    expect(l.data).toEqual({ key: "bug", name: "bug", color: "#ff0000", description: "", archived: false });
    expect(() => fake.run("work.label.create", { key: "bug" }, { actor: ADA })).toThrow(/^conflict/);
    expect(() => fake.run("work.label.create", { key: " bug" }, { actor: ADA })).toThrow(/^invalid_request/);
    expect(() => fake.run("work.label.update", { id: l.id, key: "x" }, { actor: ADA, revision: l.revision })).toThrow(/^invalid_request/);
    expect(fake.run("work.label.update", { id: l.id, archived: true, color: null }, { actor: ADA, revision: l.revision }).data).toEqual({ key: "bug", name: "bug", description: "", archived: true });
  });

  it("projects", () => {
    const fake = new FakeRecords();
    expect(() => fake.run("work.project.create", {}, { actor: ADA })).toThrow(/name/);
    expect(() => fake.run("work.project.create", { name: "x".repeat(201) }, { actor: ADA })).toThrow(/1-200/);
    expect(() => fake.run("work.project.create", { name: "P", state: "done" }, { actor: ADA })).toThrow(/state/);
    expect(() => fake.run("work.project.create", { name: "P", lead: "ada" }, { actor: ADA })).toThrow(/Lead/);
    expect(() => fake.run("work.project.create", { name: "P", start_date: "2026-10-02", target_date: "2026-10-01" }, { actor: ADA })).toThrow(/Target/);
    const p = fake.run("work.project.create", { name: "P", lead: ADA, start_date: "2026-09-01" }, { actor: ADA });
    expect(p.data).toEqual({ name: "P", description: "", state: "planned", lead: ADA, start_date: "2026-09-01", archived: false });
    expect(fake.run("work.project.update", { id: p.id, lead: null, state: "active" }, { actor: ADA, revision: p.revision }).data.lead).toBeUndefined();
  });

  it("cycles get numbers and never overlap (409)", () => {
    const fake = new FakeRecords();
    const a = fake.run("work.cycle.create", { name: "C1", starts_on: "2026-09-01", ends_on: "2026-09-14" }, { actor: ADA });
    const b = fake.run("work.cycle.create", { starts_on: "2026-09-15", ends_on: "2026-09-28" }, { actor: ADA });
    expect([a.data.number, b.data.number]).toEqual([1, 2]);
    expect(b.data).toEqual({ number: 2, starts_on: "2026-09-15", ends_on: "2026-09-28" });
    expect(() => fake.run("work.cycle.create", { starts_on: "2026-09-10", ends_on: "2026-09-20" }, { actor: ADA })).toThrow(/^conflict/);
    expect(() => fake.run("work.cycle.create", { starts_on: "2026-10-10", ends_on: "2026-10-01" }, { actor: ADA })).toThrow(/^invalid_request.*before/);
    expect(() => fake.run("work.cycle.create", { starts_on: "2026-10-10" }, { actor: ADA })).toThrow(/starts_on and ends_on/);
    expect(() => fake.run("work.cycle.create", { starts_on: "2026-11-01", ends_on: "2026-11-02", goal: "" }, { actor: ADA })).toThrow(/goal/);
    expect(() => fake.run("work.cycle.update", { id: b.id, starts_on: "2026-09-14" }, { actor: ADA, revision: b.revision })).toThrow(/^conflict/);
    expect(fake.run("work.cycle.update", { id: a.id, name: null, goal: "Ship" }, { actor: ADA, revision: a.revision }).data).toEqual({ number: 1, starts_on: "2026-09-01", ends_on: "2026-09-14", goal: "Ship" });
  });

  it("relations: no self (400), no duplicate active (409, relates symmetric), update only active", () => {
    const fake = new FakeRecords();
    const a = item(fake, "a"), b = item(fake, "b");
    const r = fake.run("work.relation.create", { from: a.id, to: b.id, kind: "blocks" }, { actor: ADA });
    expect(r.data).toEqual({ from: a.id, to: b.id, kind: "blocks", active: true });
    expect(() => fake.run("work.relation.create", { from: a.id, to: b.id, kind: "blocks" }, { actor: ADA })).toThrow(/^conflict/);
    expect(fake.run("work.relation.create", { from: b.id, to: a.id, kind: "blocks" }, { actor: ADA }).data.kind).toBe("blocks");
    fake.run("work.relation.create", { from: a.id, to: b.id, kind: "relates" }, { actor: ADA });
    expect(() => fake.run("work.relation.create", { from: b.id, to: a.id, kind: "relates" }, { actor: ADA })).toThrow(/^conflict/);
    expect(() => fake.run("work.relation.create", { from: a.id, to: a.id, kind: "relates" }, { actor: ADA })).toThrow(/itself/);
    expect(() => fake.run("work.relation.create", { from: a.id, to: MISSING, kind: "relates" }, { actor: ADA })).toThrow(/Unknown work item/);
    expect(() => fake.run("work.relation.create", { from: a.id, to: b.id, kind: "parent" }, { actor: ADA })).toThrow(/kind/);
    expect(() => fake.run("work.relation.update", { id: r.id, kind: "relates" }, { actor: ADA, revision: r.revision })).toThrow(/Invalid relation fields/);
    const off = fake.run("work.relation.update", { id: r.id, active: false }, { actor: ADA, revision: r.revision });
    expect(off.data.active).toBe(false);
    const again = fake.run("work.relation.create", { from: a.id, to: b.id, kind: "blocks" }, { actor: ADA });
    expect(() => fake.run("work.relation.update", { id: r.id, active: true }, { actor: ADA, revision: off.revision })).toThrow(/^conflict/);
    expect(again.data.active).toBe(true);
  });

  it("comments: author-only edits (403), edited set only when the body changes", () => {
    const fake = new FakeRecords();
    const a = item(fake, "a");
    const c = fake.run("work.comment.create", { item: a.id, body: "hi" }, { actor: ADA });
    expect(c.data).toEqual({ item: a.id, body: "hi", edited: false });
    expect(() => fake.run("work.comment.create", { item: a.id, body: "" }, { actor: ADA })).toThrow(/body/);
    expect(() => fake.run("work.comment.create", { item: MISSING, body: "x" }, { actor: ADA })).toThrow(/Unknown work item/);
    expect(() => fake.run("work.comment.update", { id: c.id, body: "x" }, { actor: BOB, revision: c.revision })).toThrow(/^forbidden/);
    expect(() => fake.run("work.comment.update", { id: c.id, edited: true }, { actor: ADA, revision: c.revision })).toThrow(/Invalid comment fields/);
    const same = fake.run("work.comment.update", { id: c.id, body: "hi" }, { actor: ADA, revision: c.revision });
    expect(same.data.edited).toBe(false);
    expect(fake.run("work.comment.update", { id: c.id, body: "edited" }, { actor: ADA, revision: same.revision }).data).toEqual({ item: a.id, body: "edited", edited: true });
  });
});

describe("FakeRecords reads", () => {
  it("snapshot bounds and presentation (timestamps top-level, as migration 011)", async () => {
    const fake = new FakeRecords();
    item(fake, "a");
    const s = fake.session();
    const snap = await s.snapshot(100);
    expect(snap).toMatchObject({ seq: 1, complete: true, permission_epoch: 1 });
    expect(snap.records).toHaveLength(8);
    expect(typeof snap.records[0].created_at).toBe("string");
    expect(snap.records[0].data.created_at).toBeUndefined();
    await expect(s.snapshot(3)).rejects.toThrow(/^too_large/);
    await expect(s.snapshot(5001)).rejects.toThrow(/^invalid_request/);
  });

  it("carries timestamps (and can reproduce a service without them)", async () => {
    const fake = new FakeRecords({ timestamps: true, now: () => Date.parse("2026-09-26T10:00:00Z") });
    item(fake, "a");
    expect((await fake.session().snapshot()).records[0].created_at).toBe("2026-09-26T10:00:00.000Z");
    const c = await fake.session().changes(0);
    expect(c.changes[0]).toMatchObject({ created_at: "2026-09-26T10:00:00.000Z", actor: ADA });
    const plain = new FakeRecords({ timestamps: false });
    item(plain, "a");
    expect(Object.keys((await plain.session().changes(0)).changes[0]).toSorted()).toEqual(["actor", "data", "entity", "ordinal", "record_id", "revision", "seq"]);
  });

  it("pages changes without splitting a commit", async () => {
    const fake = new FakeRecords();
    for (let i = 0; i < 150; i++) item(fake, `i${i}`);
    const s = fake.session();
    const first = await s.changes(0, 1);
    expect(first.changes).toHaveLength(100);
    expect(first.cursor).toBe(93);
    expect(first.changes.at(-1)).toMatchObject({ seq: 93, ordinal: 0 });
    const second = await s.changes(first.cursor, 1);
    expect(second.changes).toHaveLength(57);
    expect(second.cursor).toBe(fake.seq);
    expect((await s.changes(fake.seq, 1)).changes).toEqual([]);
    // A page never ends inside the first commit (item + 7 states).
    const small = fake.changes(0, 1, 3);
    expect(small.changes.map((e) => e.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(small.cursor).toBe(1);
    fake.setEpoch(2);
    await expect(s.changes(0, 1)).rejects.toThrow(/^reset_required/);
    await expect(s.changes(fake.seq + 1)).rejects.toThrow(/^invalid_request/);
  });

  it("records pages by id", async () => {
    const fake = new FakeRecords();
    for (let i = 0; i < 5; i++) item(fake, `i${i}`);
    const page = await fake.session().records({ entity: "work_item", limit: 2 });
    expect(page.records.map((r) => r.data.title)).toEqual(["i0", "i1"]);
    const next = await fake.session().records({ entity: "work_item", after: page.records[1].id, limit: 10 });
    expect(next.records).toHaveLength(3);
  });

  it("failNext makes a method throw once", async () => {
    const fake = new FakeRecords();
    fake.failNext("snapshot", "unavailable: down");
    await expect(fake.session().snapshot()).rejects.toThrow("unavailable: down");
    await expect(fake.session().snapshot()).resolves.toBeTruthy();
  });
});

describe("FakeRecords approval path", () => {
  it("manual approval: pending, then applied with the viewer as actor", async () => {
    const fake = new FakeRecords();
    const out = await request(fake, "work.create", { title: "From Ada" });
    expect(out).toEqual({ status: "pending", actionId: 1 });
    expect(fake.pendingActions()).toHaveLength(1);
    fake.approve(1);
    const outcome = await fake.session().getOutcome(1);
    expect(outcome.status).toBe("applied");
    expect(outcome.result.record).toMatchObject({ created_by: ADA, data: { title: "From Ada", number: 1 } });
  });

  it("auto approval applies immediately", async () => {
    const fake = new FakeRecords({ approval: "auto" });
    const out = await request(fake, "work.create", { title: "x" });
    expect(out.status).toBe("applied");
    expect(out.result.seq).toBe(fake.seq);
  });

  it("rejections carry only the connector's status strings", async () => {
    const fake = new FakeRecords();
    const a = item(fake, "a"), b = item(fake, "b", { parent: a.id });
    await request(fake, "work.create", { title: "" });
    await request(fake, "work.update", { id: a.id, title: "x" }, { revision: 99 });
    await request(fake, "work.update", { id: MISSING, title: "x" }, { revision: 1 });
    await request(fake, "work.update", { id: a.id, title: "x" });
    await request(fake, "work.update", { id: a.id, parent: b.id }, { revision: a.revision });
    await request(fake, "work.create", { title: "ok" });
    fake.approveAll();
    const reasons = await Promise.all([1, 2, 3, 4, 5, 6].map((id) => fake.getOutcome(id)));
    expect(reasons.map((r) => r.reason ?? r.status)).toEqual([
      "Records refused the command (400)", "Records refused the command (412)", "Records refused the command (404)",
      "Records refused the command (428)", "Records refused the command (409)", "applied",
    ]);
    const c = fake.run("work.comment.create", { item: a.id, body: "mine" }, { actor: BOB });
    await request(fake, "work.comment.update", { id: c.id, body: "theirs" }, { revision: c.revision });
    fake.approveAll();
    expect((await fake.getOutcome(7)).reason).toBe("Records refused the command (403)");
    await request(fake, "work.create", { title: "denied" });
    fake.reject(8);
    expect((await fake.getOutcome(8)).reason).toBe("Approval was denied");
  });

  it("is idempotent by key and refuses mismatched or reused assertions", async () => {
    const fake = new FakeRecords();
    const first = await request(fake, "work.create", { title: "x" }, { key: "k1" });
    const again = await request(fake, "work.create", { title: "x" }, { key: "k1" });
    expect(again).toEqual(first);
    expect(fake.actions.size).toBe(1);
    await expect(request(fake, "work.create", { title: "y" }, { key: "k1" })).rejects.toThrow(/^conflict/);
    await expect(request(fake, "work.create", { title: "x" }, { tamper: true })).rejects.toThrow(/^forbidden/);
    await expect(request(fake, "work.create", { title: "x" }, { binding: "OTHER" })).rejects.toThrow(/^forbidden/);
    await expect(fake.session().getOutcome(99)).rejects.toThrow(/^not_found/);
  });

  it("read-only connections refuse commands", async () => {
    const fake = new FakeRecords({ access: "read" });
    await expect(request(fake, "work.create", { title: "x" })).rejects.toThrow(/^read_only/);
    expect(fake.connectionInfo.scopes).toEqual(["work.read"]);
  });
});

describe("seedWork", () => {
  const NOW = Date.parse("2026-09-26T12:00:00Z");
  const count = (fake, entity) => rows(fake, entity).length;

  it("is deterministic and realistic for 300 items", () => {
    const a = new FakeRecords(), b = new FakeRecords();
    const t0 = performance.now();
    seedWork(a, { items: 300, now: NOW, rng: mulberry32(7) });
    const ms = performance.now() - t0;
    seedWork(b, { items: 300, now: NOW, rng: mulberry32(7) });
    expect(JSON.stringify([...a.rows.values()])).toBe(JSON.stringify([...b.rows.values()]));
    console.log(`seed 300: ${ms.toFixed(0)} ms, ${a.rows.size} records, ${a.journal.length} changes`);
    expect(count(a, "work_item")).toBe(300);
    expect(states(a).map((s) => s.key).toSorted()).toEqual(DEFAULT_STATES.map((s) => s.key).toSorted());
    expect(stateRow(a, "in_review").data.wip_limit).toBe(5);
    expect(count(a, "label")).toBe(9);
    expect(count(a, "project")).toBe(5);
    expect(count(a, "cycle")).toBe(6);
    expect(count(a, "relation")).toBeGreaterThan(20);
    expect(count(a, "comment")).toBe(150);
    const today = new Date(NOW).toISOString().slice(0, 10);
    const cycles = rows(a, "cycle").map((r) => r.data);
    expect(cycles.filter((c) => c.starts_on <= today && today <= c.ends_on)).toHaveLength(1);
    const items = rows(a, "work_item").map((r) => r.data);
    expect(items.filter((d) => d.due_date && d.due_date < today && d.status !== "done").length).toBeGreaterThan(0);
    expect(items.filter((d) => d.parent).length).toBeGreaterThan(20);
    expect(new Set(items.map((d) => d.state)).size).toBe(7);
    expect(items.filter((d) => !d.assignee).length).toBeGreaterThan(10);
    expect(items.every((d) => d.labels === undefined || d.labels.length > 0)).toBe(true);
    const actors = new Set(a.journal.map((e) => e.actor));
    for (const p of SEED_PEOPLE) expect(actors.has(`cloudflare-os:${p.id}`)).toBe(true);
    const times = a.journal.map((e) => Date.parse(e.created_at));
    expect(Math.min(...times)).toBeLessThanOrEqual(NOW - 69 * 86_400_000);
    expect(Math.max(...times)).toBeLessThan(NOW);
    expect([...times].toSorted((x, y) => x - y)).toEqual(times);
    const blocks = rows(a, "relation").filter((r) => r.data.kind === "blocks");
    expect(blocks.length).toBeGreaterThanOrEqual(20);
    expect(items.map((d) => d.number).toSorted((x, y) => x - y)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
  });

  it("scales to 2,000 items under the 5,000-record snapshot bound", async () => {
    const fake = new FakeRecords();
    const t0 = performance.now();
    seedWork(fake, { items: 2000, now: NOW });
    console.log(`seed 2000: ${(performance.now() - t0).toFixed(0)} ms, ${fake.rows.size} records, ${fake.journal.length} changes`);
    expect(count(fake, "work_item")).toBe(2000);
    expect(fake.rows.size).toBeLessThanOrEqual(5000);
    expect((await fake.session().snapshot(5000)).records).toHaveLength(fake.rows.size);
  });
});
