import { describe, expect, it } from "vitest";
import { recordsOsIntentDigest } from "../../records-service/src/cloudflare-os.ts";
import { FakeRecords } from "./fake-records.js";
import { SEED_PEOPLE, mulberry32, seedWork } from "../harness/seed.js";

const ADA = "cloudflare-os:ada@example.com";
const BOB = "cloudflare-os:bob@example.com";

/** Requests a command the way the client does: digest, viewer assertion, command. */
async function request(fake, command, input, { revision, key = crypto.randomUUID(), viewer = "ada@example.com", binding = "RECORDS", tamper = false } = {}) {
  const c = fake.connectionInfo;
  const digest = await recordsOsIntentDigest({ datastore: c.datastore, binding: c.binding, moduleId: "work", apiMajor: 1, command, input, expectedRevision: revision ?? null, idempotencyKey: key });
  const viewerAssertion = fake.createViewerAssertion(viewer, binding, tamper ? "0".repeat(64) : digest);
  return fake.session().command(command, input, { viewerAssertion, idempotencyKey: key, ...(revision === undefined ? {} : { revision }) });
}

const states = (fake) => [...fake.rows.values()].filter((r) => r.entity === "workflow_state").map((r) => r.data);
const item = (fake, title = "Item", extra = {}) => fake.run("work.create", { title, ...extra }, { actor: ADA });

describe("FakeRecords work.create / work.update", () => {
  it("assigns gapless numbers and seeds default states lazily", () => {
    const fake = new FakeRecords();
    expect(states(fake)).toHaveLength(0);
    const a = item(fake, "A");
    expect(() => item(fake, "")).toThrow(/^invalid_request/);
    const b = item(fake, "B");
    expect([a.data.number, b.data.number]).toEqual([1, 2]);
    expect(states(fake).map((s) => s.key)).toEqual(["backlog", "todo", "in_progress", "in_review", "done", "cancelled"]);
    expect(states(fake).find((s) => s.key === "cancelled")).toMatchObject({ kind: "canceled", category: "done" });
    expect(a.data).toMatchObject({ state: "todo", status: "open", labels: [], archived: false, priority: 0, assignee: null });
    expect(a).toMatchObject({ created_by: ADA, updated_by: ADA });
  });

  it("keeps state and status consistent", () => {
    const fake = new FakeRecords();
    expect(item(fake, "x", { status: "active" }).data).toMatchObject({ state: "in_progress", status: "active" });
    expect(item(fake, "y", { state: "in_review" }).data).toMatchObject({ state: "in_review", status: "active" });
    expect(item(fake, "z", { status: "done" }).data.state).toBe("done");
    expect(() => item(fake, "w", { state: "done", status: "open" })).toThrow(/disagree/);
    expect(() => item(fake, "w", { state: "nope" })).toThrow(/does not exist/);
    const r = item(fake, "v", { state: "in_progress" });
    expect(fake.run("work.update", { id: r.id, status: "active" }, { actor: ADA, revision: r.revision }).data.state).toBe("in_progress");
    const r2 = fake.rows.get(r.id);
    expect(fake.run("work.update", { id: r.id, status: "done" }, { actor: ADA, revision: r2.revision }).data).toMatchObject({ state: "done", status: "done" });
  });

  it.each([
    ["priority 5", { priority: 5 }], ["priority 1.5", { priority: 1.5 }], ["bad assignee", { assignee: "Ada" }],
    ["21 labels", { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }], ["duplicate labels", { labels: ["a", "a"] }],
    ["long label", { labels: ["x".repeat(61)] }], ["negative estimate", { estimate: -1 }], ["huge estimate", { estimate: 1001 }],
    ["bad due", { due_date: "2026-13-01" }], ["bad start", { start_date: "tomorrow" }], ["missing parent", { parent: "00000000-0000-4000-8000-00000000ffff" }],
    ["project not a project", { project: "nope" }], ["long rank", { rank: "r".repeat(65) }], ["archived not bool", { archived: "yes" }],
    ["unknown key", { colour: "red" }], ["extensions array", { extensions: [] }], ["title too long", { title: "t".repeat(501) }],
    ["bad status", { status: "closed" }],
  ])("refuses %s", (_, extra) => {
    const fake = new FakeRecords();
    expect(() => item(fake, "Item", extra)).toThrow(/^invalid_request/);
  });

  it("accepts references as IRIs, clears with null, replaces labels", () => {
    const fake = new FakeRecords();
    const p = fake.run("work.project.create", { name: "P" }, { actor: ADA });
    const r = item(fake, "x", { project: `records://datastore/x/project/${p.id}`, labels: ["a", "b"], estimate: 3 });
    expect(r.data.project).toBe(p.id);
    const u = fake.run("work.update", { id: r.id, project: null, labels: ["c"], estimate: null }, { actor: BOB, revision: r.revision });
    expect(u.data).toMatchObject({ project: null, labels: ["c"], estimate: null });
    expect(u).toMatchObject({ created_by: ADA, updated_by: BOB });
  });

  it("requires a current revision and refuses parent cycles", () => {
    const fake = new FakeRecords();
    const a = item(fake, "a"), b = item(fake, "b", { parent: a.id });
    expect(() => fake.run("work.update", { id: a.id, title: "x" }, { actor: ADA })).toThrow(/^revision_required/);
    expect(() => fake.run("work.update", { id: a.id, title: "x" }, { actor: ADA, revision: 1 })).toThrow(/^stale_revision/);
    expect(() => fake.run("work.update", { id: a.id, parent: b.id }, { actor: ADA, revision: a.revision })).toThrow(/cycle/);
    expect(() => fake.run("work.update", { id: a.id, parent: a.id }, { actor: ADA, revision: a.revision })).toThrow(/cycle/);
    expect(() => fake.run("work.update", { id: "00000000-0000-4000-8000-0000000000ff", title: "x" }, { actor: ADA, revision: 1 })).toThrow(/^not_found/);
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
    const s = fake.run("work.state.create", { key: "triage", name: "Triage", kind: "triage", position: 0 }, { actor: ADA });
    expect(s.data).toMatchObject({ category: "open", wip_limit: null });
    expect(() => fake.run("work.state.create", { key: "triage", name: "T", kind: "triage" }, { actor: ADA })).toThrow(/exists/);
    expect(() => fake.run("work.state.create", { key: "Bad Key", name: "T", kind: "triage" }, { actor: ADA })).toThrow(/key/);
    expect(() => fake.run("work.state.create", { key: "x", name: "X", kind: "doing" }, { actor: ADA })).toThrow(/kind/);
    expect(() => fake.run("work.state.update", { id: s.id, wip_limit: 0 }, { actor: ADA, revision: s.revision })).toThrow(/wip/);
    expect(() => fake.run("work.state.update", { id: s.id, color: "red" }, { actor: ADA, revision: s.revision })).toThrow(/color/);
    const u = fake.run("work.state.update", { id: s.id, wip_limit: 3, color: "#AABBCC", name: "Inbox" }, { actor: ADA, revision: s.revision });
    expect(u.data).toMatchObject({ key: "triage", wip_limit: 3, color: "#aabbcc", name: "Inbox" });
  });

  it("moves items when a state's kind changes category", () => {
    const fake = new FakeRecords();
    const i = item(fake, "x", { state: "in_review" });
    const s = [...fake.rows.values()].find((r) => r.entity === "workflow_state" && r.data.key === "in_review");
    fake.run("work.state.update", { id: s.id, kind: "completed" }, { actor: ADA, revision: s.revision });
    expect(fake.rows.get(i.id).data.status).toBe("done");
  });

  it("labels, projects", () => {
    const fake = new FakeRecords();
    const l = fake.run("work.label.create", { key: "bug", name: "Bug", color: "#ff0000" }, { actor: ADA });
    expect(() => fake.run("work.label.create", { key: "bug" }, { actor: ADA })).toThrow(/exists/);
    expect(fake.run("work.label.update", { id: l.id, archived: true }, { actor: ADA, revision: l.revision }).data.archived).toBe(true);
    expect(() => fake.run("work.project.create", {}, { actor: ADA })).toThrow(/name/);
    expect(() => fake.run("work.project.create", { name: "P", state: "done" }, { actor: ADA })).toThrow(/state/);
    expect(() => fake.run("work.project.create", { name: "P", lead: "ada" }, { actor: ADA })).toThrow(/lead/);
    const p = fake.run("work.project.create", { name: "P", lead: ADA, start_date: "2026-09-01" }, { actor: ADA });
    expect(p.data).toMatchObject({ state: "planned", lead: ADA, target_date: null });
  });

  it("cycles get numbers and never overlap", () => {
    const fake = new FakeRecords();
    const a = fake.run("work.cycle.create", { name: "C1", starts_on: "2026-09-01", ends_on: "2026-09-14" }, { actor: ADA });
    const b = fake.run("work.cycle.create", { starts_on: "2026-09-15", ends_on: "2026-09-28" }, { actor: ADA });
    expect([a.data.number, b.data.number]).toEqual([1, 2]);
    expect(() => fake.run("work.cycle.create", { starts_on: "2026-09-10", ends_on: "2026-09-20" }, { actor: ADA })).toThrow(/overlap/);
    expect(() => fake.run("work.cycle.create", { starts_on: "2026-10-10", ends_on: "2026-10-01" }, { actor: ADA })).toThrow(/before/);
    expect(() => fake.run("work.cycle.create", { starts_on: "2026-10-10" }, { actor: ADA })).toThrow(/required/);
    expect(() => fake.run("work.cycle.update", { id: b.id, starts_on: "2026-09-14" }, { actor: ADA, revision: b.revision })).toThrow(/overlap/);
  });

  it("relations: no self, no duplicate active, update only active", () => {
    const fake = new FakeRecords();
    const a = item(fake, "a"), b = item(fake, "b");
    const r = fake.run("work.relation.create", { from: a.id, to: b.id, kind: "blocks" }, { actor: ADA });
    expect(r.data).toEqual({ from: a.id, to: b.id, kind: "blocks", active: true });
    expect(() => fake.run("work.relation.create", { from: a.id, to: b.id, kind: "blocks" }, { actor: ADA })).toThrow(/exists/);
    expect(() => fake.run("work.relation.create", { from: a.id, to: a.id, kind: "relates" }, { actor: ADA })).toThrow(/itself/);
    expect(() => fake.run("work.relation.create", { from: a.id, to: b.id, kind: "parent" }, { actor: ADA })).toThrow(/kind/);
    expect(() => fake.run("work.relation.update", { id: r.id, kind: "relates" }, { actor: ADA, revision: r.revision })).toThrow(/Unknown field/);
    const off = fake.run("work.relation.update", { id: r.id, active: false }, { actor: ADA, revision: r.revision });
    expect(off.data.active).toBe(false);
    expect(fake.run("work.relation.create", { from: a.id, to: b.id, kind: "blocks" }, { actor: ADA }).data.active).toBe(true);
  });

  it("comments: author-only edits mark edited", () => {
    const fake = new FakeRecords();
    const a = item(fake, "a");
    const c = fake.run("work.comment.create", { item: a.id, body: "hi" }, { actor: ADA });
    expect(() => fake.run("work.comment.create", { item: a.id, body: "" }, { actor: ADA })).toThrow(/body/);
    expect(() => fake.run("work.comment.update", { id: c.id, body: "x" }, { actor: BOB, revision: c.revision })).toThrow(/^forbidden/);
    expect(fake.run("work.comment.update", { id: c.id, body: "edited" }, { actor: ADA, revision: c.revision }).data).toEqual({ item: a.id, body: "edited", edited: true });
  });
});

describe("FakeRecords reads", () => {
  it("snapshot bounds and presentation", () => {
    const fake = new FakeRecords();
    item(fake, "a");
    const snap = fake.session();
    return Promise.all([
      snap.snapshot(100).then((s) => { expect(s).toMatchObject({ seq: 7, complete: true, permission_epoch: 1 }); expect(s.records[0].created_at).toMatch(/Z$/); }),
      expect(snap.snapshot(3)).rejects.toThrow(/^too_large/),
      expect(snap.snapshot(5001)).rejects.toThrow(/^invalid_request/),
    ]);
  });

  it("omits timestamps when asked", async () => {
    const fake = new FakeRecords({ timestamps: false });
    item(fake, "a");
    const s = await fake.session().snapshot();
    expect(s.records[0].created_at).toBeUndefined();
    const c = await fake.session().changes(0);
    expect(c.changes[0].created_at).toBeUndefined();
    expect(c.changes[0].actor).toBe("records:operator:seed");
  });

  it("pages changes with the service's cursor semantics and resets on epoch change", async () => {
    const fake = new FakeRecords();
    for (let i = 0; i < 150; i++) item(fake, `i${i}`);
    const s = fake.session();
    const first = await s.changes(0, 1);
    expect(first.changes).toHaveLength(100);
    expect(first.cursor).toBe(100);
    const second = await s.changes(first.cursor, 1);
    expect(second.changes).toHaveLength(56);
    expect(second.cursor).toBe(fake.seq);
    expect((await s.changes(fake.seq, 1)).changes).toEqual([]);
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

  it("rejections use the connector's reason strings", async () => {
    const fake = new FakeRecords();
    const a = item(fake, "a");
    await request(fake, "work.create", { title: "" });
    await request(fake, "work.update", { id: a.id, title: "x" }, { revision: 1 });
    await request(fake, "work.update", { id: "00000000-0000-4000-8000-0000000000ff", title: "x" }, { revision: 1 });
    await request(fake, "work.update", { id: a.id, title: "x" });
    await request(fake, "work.create", { title: "ok" });
    fake.approveAll();
    fake.reject(5);
    const reasons = await Promise.all([1, 2, 3, 4, 5].map((id) => fake.getOutcome(id)));
    expect(reasons.map((r) => r.reason ?? r.status)).toEqual([
      "Records refused the command (400)", "Records refused the command (412)", "Records refused the command (404)",
      "Records refused the command (428)", "applied",
    ]);
    const c = fake.run("work.comment.create", { item: a.id, body: "mine" }, { actor: BOB });
    await request(fake, "work.comment.update", { id: c.id, body: "theirs" }, { revision: c.revision });
    fake.approveAll();
    expect((await fake.getOutcome(6)).reason).toBe("Records refused the command (403)");
    await request(fake, "work.create", { title: "denied" });
    fake.reject(7);
    expect((await fake.getOutcome(7)).reason).toBe("Approval was denied");
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
  const count = (fake, entity) => [...fake.rows.values()].filter((r) => r.entity === entity).length;

  it("is deterministic and realistic for 300 items", () => {
    const a = new FakeRecords(), b = new FakeRecords();
    const t0 = performance.now();
    seedWork(a, { items: 300, now: NOW, rng: mulberry32(7) });
    const ms = performance.now() - t0;
    seedWork(b, { items: 300, now: NOW, rng: mulberry32(7) });
    expect(JSON.stringify([...a.rows.values()])).toBe(JSON.stringify([...b.rows.values()]));
    console.log(`seed 300: ${ms.toFixed(0)} ms, ${a.rows.size} records, ${a.journal.length} changes`);
    expect(count(a, "work_item")).toBe(300);
    expect(count(a, "workflow_state")).toBe(7);
    expect(count(a, "label")).toBe(9);
    expect(count(a, "project")).toBe(5);
    expect(count(a, "cycle")).toBe(6);
    expect(count(a, "relation")).toBeGreaterThan(20);
    expect(count(a, "comment")).toBe(150);
    const today = new Date(NOW).toISOString().slice(0, 10);
    const cycles = [...a.rows.values()].filter((r) => r.entity === "cycle").map((r) => r.data);
    expect(cycles.filter((c) => c.starts_on <= today && today <= c.ends_on)).toHaveLength(1);
    const items = [...a.rows.values()].filter((r) => r.entity === "work_item").map((r) => r.data);
    expect(items.filter((d) => d.due_date && d.due_date < today && d.status !== "done").length).toBeGreaterThan(0);
    expect(items.filter((d) => d.parent).length).toBeGreaterThan(20);
    expect(new Set(items.map((d) => d.state)).size).toBeGreaterThanOrEqual(6);
    expect(items.filter((d) => !d.assignee).length).toBeGreaterThan(10);
    const actors = new Set(a.journal.map((e) => e.actor));
    for (const p of SEED_PEOPLE) expect(actors.has(`cloudflare-os:${p.id}`)).toBe(true);
    const times = a.journal.map((e) => Date.parse(e.created_at));
    expect(Math.min(...times)).toBeLessThanOrEqual(NOW - 69 * 86_400_000);
    expect(Math.max(...times)).toBeLessThan(NOW);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    const blocks = [...a.rows.values()].filter((r) => r.entity === "relation" && r.data.kind === "blocks");
    expect(blocks.length).toBeGreaterThanOrEqual(20);
    expect(items.map((d) => d.number).sort((x, y) => x - y)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
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
