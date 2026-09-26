// The agent surface over the real gadget server (src/server/api.js) and the FakeRecords datastore:
// datasets, the batched insights read, reports, summaries, history, proposals and Jev triage.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeRecords } from "../fake-records.js";
import { createFakeJev } from "../fake-jev.js";
import { SEED_PEOPLE, seedWork } from "../../harness/seed.js";
import { RPC_METHODS, createGadgetApi } from "../../src/server/api.js";
import { memoryStorage } from "../../src/server/documents.js";
import { getLarge, putLarge, listLarge, deleteLarge } from "../../src/server/large.js";
import { BUILTIN_REPORTS } from "../../src/shared/insights/builtins.js";

const NOW = Date.parse("2026-09-26T12:00:00Z");

/** @param {{ items?: number, jev?: any, storage?: any }} [o] */
async function setup(o = {}) {
  const fake = new FakeRecords({ now: () => NOW });
  seedWork(fake, { items: o.items ?? 120, now: NOW });
  const storage = o.storage ?? memoryStorage();
  const env = { RECORDS: fake.session(), ...(o.jev === null ? {} : { JEV: o.jev ?? createFakeJev() }) };
  let t = NOW;
  let r = 0;
  const api = createGadgetApi({ getEnv: () => env, storage, now: () => t, ttlMs: 0, random: () => ((r = (r * 9301 + 49297) % 233280) / 233280) });
  for (const p of SEED_PEOPLE) await api.rememberViewer(p);
  return { api, fake, storage, env, tick: (/** @type {number} */ ms) => { t += ms; } };
}
const rowOf = (/** @type {FakeRecords} */ fake, /** @type {number} */ n) => [...fake.rows.values()].find((x) => x.entity === "work_item" && x.data.number === n);

describe("RPC surface", () => {
  it("exposes every RPC method on the Durable Object and the api", async () => {
    const source = readFileSync(new URL("../../src/server/index.js", import.meta.url), "utf8");
    const { api } = await setup({ items: 10 });
    for (const m of RPC_METHODS) {
      expect(typeof (/** @type {any} */ (api))[m], m).toBe("function");
      expect(source, m).toMatch(new RegExp(`\\n  ${m}\\(`));
    }
  });

  it("getSetup says whether the optional Jev binding is connected", async () => {
    expect((await (await setup({ items: 5 })).api.getSetup()).jev).toBe(true);
    expect((await (await setup({ items: 5, jev: null })).api.getSetup()).jev).toBe(false);
  });
});

describe("datasets and insights", () => {
  it("datasets() is the data dictionary; dataset() returns rows, summary and params", async () => {
    const { api } = await setup();
    const names = api.datasets().map((d) => d.name);
    expect(names).toEqual(["items", "transitions", "daily_state_counts", "cycle_burndown", "burnup", "throughput", "cycle_time", "created_vs_resolved", "workload", "dependencies"]);
    const r = await api.dataset("cycle_burndown", { params: { cycle: "current" } });
    expect(r.params.cycle).toBe("Cycle 24");
    expect(r.rows).toHaveLength(14);
    expect(r.summary).toMatch(/this cycle; .* done; /);
    expect(r.history).toEqual({ used: true, complete: true });
    const limited = await api.dataset("items", { query: "is:blocked", limit: 2 });
    expect(limited.rows.length).toBeLessThanOrEqual(2);
    await expect(api.dataset("nope")).rejects.toThrow(/^not_found: No dataset “nope”/);
    await expect(api.dataset("items", { query: "prority:high" })).rejects.toThrow(/^invalid_request: Unknown field/);
  });

  it("insights() reads many reports in one call and combines the view filter with each report's query", async () => {
    const { api } = await setup();
    const reports = BUILTIN_REPORTS.map((r) => ({ id: r.id, dataset: r.dataset, params: r.params, query: r.query }));
    const all = await api.insights({ reports });
    expect(Object.keys(all.results)).toEqual(BUILTIN_REPORTS.map((r) => r.id));
    expect(Object.values(all.results).every((x) => x.error === null && typeof x.summary === "string")).toBe(true);
    const mine = await api.insights({ query: "label:bug", reports: [{ id: "i", dataset: "items", query: "is:open" }, { id: "bad", dataset: "burnup", params: { scope: "project", project: "Nope" } }] });
    expect(mine.results.i.rows.every((x) => x.labels.includes("Bug") && x.status === "open")).toBe(true);
    expect(mine.results.bad.error).toMatch(/^invalid_request: No project matches “Nope”/);
    await expect(api.insights({ query: "(" })).rejects.toThrow(/^invalid_request: The filter has an error/);
    await expect(api.insights({ reports: Array.from({ length: 25 }, (_, i) => ({ id: String(i), dataset: "items" })) })).rejects.toThrow(/At most 24/);
  });

  it("summary() counts by properties for chat answers", async () => {
    const { api } = await setup();
    const s = await api.summary({ query: "cycle:current", by: ["kind", "assignee"] });
    expect(s.total).toBe(s.open + s.in_progress + s.done);
    expect(s.by.kind.reduce((n, x) => n + x.count, 0)).toBe(s.total);
    expect(s.by.assignee.some((x) => x.value === "Unassigned" || / /.test(x.value))).toBe(true);
    expect(s.description).toMatch(/current cycle/);
    await expect(api.summary({ by: "colour" })).rejects.toThrow(/^invalid_request: by is one of/);
  });

  it("history() reads an item's journal as sentences, newest first", async () => {
    const { api } = await setup();
    const h = await api.history("TW-12");
    expect(h.complete).toBe(true);
    expect(h.entries.at(-1).text).toMatch(/created the item$/);
    expect(h.entries.every((e) => typeof e.at === "string")).toBe(true);
    await expect(api.history("TW-9999")).rejects.toThrow(/^not_found:/);
  });
});

describe("reports", () => {
  it("lists built-ins, saves custom reports, customises, hides and restores built-ins", async () => {
    const { api } = await setup({ items: 20 });
    expect((await api.listReports()).map((r) => r.id)).toEqual(BUILTIN_REPORTS.map((r) => r.id));
    const spec = { $schema: "https://vega.github.io/schema/vega-lite/v6.json", data: { name: "items" }, mark: "bar", encoding: { y: { field: "assignee", type: "nominal" }, x: { aggregate: "count" } } };
    const saved = await api.saveReport({ title: "Bugs by person", dataset: "items", query: "label:bug", spec }, { actor: "cloudflare-os:ada@example.com" });
    expect(saved).toMatchObject({ title: "Bugs by person", version: 1, created_by: "cloudflare-os:ada@example.com", kind: "vega-lite" });
    expect(saved.id).toMatch(/^bugs-by-person-/);
    await expect(api.saveReport({ ...saved, title: "Again" }, { expectedVersion: 9 })).rejects.toThrow(/^conflict:/);
    await expect(api.saveReport({ title: "Bad", dataset: "items", spec: { ...spec, data: { url: "https://x" } } })).rejects.toThrow(/^invalid_request: .*url/);
    await api.saveReport({ ...BUILTIN_REPORTS[0], title: "Flow (30 days)", params: { days: 14 } });
    await api.deleteReport("throughput");
    const list = await api.listReports();
    expect(list.find((r) => r.id === "cfd")).toMatchObject({ customised: true, title: "Flow (30 days)", params: { days: 14 }, builtin: true });
    expect(list.find((r) => r.id === "throughput")).toMatchObject({ hidden: true });
    expect(list.at(-1).id).toBe(saved.id);
    await api.restoreReport("throughput");
    await api.restoreReport("cfd");
    const restored = await api.listReports();
    expect(restored.find((r) => r.id === "cfd")).toMatchObject({ customised: false, params: { days: 30 } });
    expect(restored.find((r) => r.id === "throughput")?.hidden).toBe(false);
    await api.deleteReport(saved.id);
    expect((await api.listReports()).some((r) => r.id === saved.id)).toBe(false);
    await expect(api.deleteReport(saved.id)).rejects.toThrow(/^not_found:/);
    expect(api.validateReport({ title: "x", dataset: "items", spec })).toMatchObject({ valid: true });
  });

  it("stores large specs in parts under the 128 KiB value cap", async () => {
    const storage = memoryStorage();
    const values = Array.from({ length: 2500 }, (_, i) => ({ label: `threshold ${i}`, y: i }));
    const { api } = await setup({ items: 5, storage });
    const spec = { $schema: "https://vega.github.io/schema/vega-lite/v6.json", data: { name: "items" }, layer: [{ mark: "bar", encoding: { x: { aggregate: "count" } } }, { data: { values }, mark: "rule", encoding: { y: { field: "y" } } }] };
    const saved = await api.saveReport({ id: "big", title: "Big", dataset: "items", spec });
    for (const [key, value] of storage.map) expect(JSON.stringify(value).length, key).toBeLessThan(64 * 1024);
    expect([...storage.map.keys()].filter((k) => k.startsWith("report:big#")).length).toBeGreaterThan(1);
    expect((await api.listReports()).find((r) => r.id === "big")?.spec).toEqual(saved.spec);
    await putLarge(storage, "report:big", { id: "big", small: true });
    expect([...storage.map.keys()].filter((k) => k.startsWith("report:big#"))).toEqual([]);
    expect(await getLarge(storage, "report:big")).toEqual({ id: "big", small: true });
    await deleteLarge(storage, "report:big");
    expect(await listLarge(storage, "report:")).toEqual([]);
  });
});

describe("proposals", () => {
  it("normalises friendly changes into exact commands with readable diffs", async () => {
    const { api, fake } = await setup();
    const twelve = rowOf(fake, 12);
    const p = await api.propose([
      { command: "work.update", input: { id: "TW-12", priority: "urgent", assignee: "Grace Hopper", labels_add: ["Bug"] }, reason: "Customer escalation" },
      { command: "work.create", input: { title: "Write the migration guide", parent: "TW-12", priority: "high" }, reason: "Split out the docs" },
      { command: "work.relation.create", input: { from: "TW-12", to: "TW-13", kind: "blocks" } },
      { command: "work.comment.create", input: { item: "TW-12", body: "Escalated by the agent." } },
    ], { title: "Escalate TW-12", reason: "Acme is blocked" });
    expect(p).toMatchObject({ title: "Escalate TW-12", reason: "Acme is blocked", status: "open", proposed_by: { kind: "agent", name: "Workshop agent", actor: null } });
    expect(p.id).toMatch(/^p-[a-z0-9]+$/);
    const [u, c, rel, cm] = p.changes;
    expect(u).toMatchObject({ n: 1, command: "work.update", key: "TW-12", revision: twelve.revision, reason: "Customer escalation", noop: false });
    expect(u.input).toMatchObject({ id: twelve.id, priority: 1, assignee: "cloudflare-os:grace@example.com" });
    expect(u.input.labels).toContain("bug");
    expect(u.text).toMatch(/^TW-12 priority \w+ → Urgent; assignee .+ → Grace Hopper; labels .*\+ Bug/);
    expect(u.intent).toEqual({ id: "TW-12", priority: "urgent", assignee: "Grace Hopper", labels_add: ["Bug"] });
    expect(c).toMatchObject({ command: "work.create", text: "New sub-issue under TW-12: “Write the migration guide” (priority High, state Triage)" });
    expect(c.input).toMatchObject({ parent: twelve.id, priority: 2, state: "triage" });
    expect(rel.text).toBe("TW-12 blocks TW-13");
    expect(cm.text).toBe("Comment on TW-12: “Escalated by the agent.”");
    expect((await api.listProposals()).map((x) => x.id)).toEqual([p.id]);
  });

  it("refuses bad changes with the change's index and a precise reason", async () => {
    const { api, fake } = await setup();
    await expect(api.propose([])).rejects.toThrow(/non-empty list/);
    await expect(api.propose([{ command: "work.delete", input: {} }])).rejects.toThrow(/changes\[0\]: command must be one of/);
    await expect(api.propose([{ command: "work.update", input: { id: "TW-1", title: "ok" } }, { command: "work.update", input: { id: "TW-9999", state: "Done" } }])).rejects.toThrow(/^not_found: changes\[1\]: No item TW-9999/);
    await expect(api.propose([{ command: "work.update", input: { id: "TW-1", state: "Shipped" } }])).rejects.toThrow(/Unknown state “Shipped”. States: Triage, Backlog/);
    await expect(api.propose([{ command: "work.update", input: { id: "TW-1", priority: "p0" } }])).rejects.toThrow(/Unknown priority/);
    await expect(api.propose([{ command: "work.update", input: { id: "TW-1", colour: "red" } }])).rejects.toThrow(/Unknown field “colour”/);
    await expect(api.propose([{ command: "work.update", input: { id: "TW-1", estimate: -2 } }])).rejects.toThrow(/estimate is a number/);
    const rev = rowOf(fake, 1).revision;
    await expect(api.propose([{ command: "work.update", input: { id: "TW-1", priority: 1 }, revision: rev - 1 }])).rejects.toThrow(/^conflict: changes\[0\]: TW-1 changed since you read it/);
    await expect(api.propose(Array.from({ length: 201 }, () => ({ command: "work.comment.create", input: { item: "TW-1", body: "x" } })))).rejects.toThrow(/at most 200 changes/);
    const same = await api.propose([{ command: "work.update", input: { id: "TW-1", title: rowOf(fake, 1).data.title } }]);
    expect(same.changes[0]).toMatchObject({ noop: true, text: "TW-1 already has these values" });
  });

  it("records who applied what, settles status, refreshes stale changes and withdraws", async () => {
    const { api, fake } = await setup();
    const p = await api.propose([
      { command: "work.update", input: { id: "TW-3", title: "Renamed by the agent (3)" } },
      { command: "work.update", input: { id: "TW-4", title: "Renamed by the agent (4)" } },
    ], { by: { name: "Claude" } });
    expect(p.proposed_by).toEqual({ kind: "agent", actor: null, name: "Claude" });
    const viewer = { id: "ada@example.com", displayName: "Ada Lovelace" };
    const partial = await api.recordProposalOutcome(p.id, [{ n: 1, status: "pending", actionId: 7 }], { viewer });
    expect(partial).toMatchObject({ status: "partial", applied_by: { actor: "cloudflare-os:ada@example.com", name: "Ada Lovelace" } });
    expect(partial.changes[0].outcome).toMatchObject({ status: "pending", actionId: 7, by: "Ada Lovelace" });
    // Someone else edits TW-4: refresh rebases the unapplied change onto the new revision.
    const four = rowOf(fake, 4);
    fake.run("work.update", { id: four.id, title: "Renamed elsewhere" }, { actor: "cloudflare-os:linus@example.com", revision: four.revision });
    const refreshed = await api.refreshProposal(p.id);
    expect(refreshed.changes[1].revision).toBe(rowOf(fake, 4).revision);
    expect(refreshed.changes[0].outcome.status).toBe("pending");
    const done = await api.recordProposalOutcome(p.id, [{ n: 2, status: "applied" }], { viewer });
    expect(done.status).toBe("applied");
    await expect(api.recordProposalOutcome(p.id, [{ n: 9, status: "applied" }])).rejects.toThrow(/Unknown change/);
    expect(await api.listProposals()).toEqual([]);
    expect((await api.listProposals({ status: "applied" })).map((x) => x.id)).toEqual([p.id]);
    const q = await api.propose([{ command: "work.comment.create", input: { item: "TW-5", body: "Hi" } }], { viewer, title: "Mine" });
    expect(q.proposed_by).toMatchObject({ kind: "viewer", name: "Ada Lovelace" });
    expect((await api.withdrawProposal(q.id, { actor: "cloudflare-os:ada@example.com" })).status).toBe("withdrawn");
    await expect(api.getProposal("p-nope")).rejects.toThrow(/^not_found/);
  });

  it("refresh explains a change that no longer applies", async () => {
    const { api, fake } = await setup();
    const p = await api.propose([{ command: "work.update", input: { id: "TW-6", cycle: "Cycle 26" } }]);
    const cycle = [...fake.rows.values()].find((r) => r.entity === "cycle" && r.data.name === "Cycle 26");
    fake.run("work.cycle.update", { id: cycle.id, name: "Cycle 26 (hardening)" }, { actor: "cloudflare-os:ada@example.com", revision: cycle.revision });
    const r = await api.refreshProposal(p.id);
    expect(r.changes[0].error).toMatch(/No cycle matches “Cycle 26”/);
  });
});

describe("Jev triage", () => {
  it("suggests priority, state, labels and duplicates with confidence bands, cached per revision", async () => {
    const jev = createFakeJev();
    const { api, fake } = await setup({ jev });
    const triageRow = [...fake.rows.values()].find((r) => r.entity === "work_item" && r.data.state === "triage" && !r.data.archived);
    const key = `TW-${triageRow.data.number}`;
    const out = await api.triage([key]);
    expect(out.model).toBe("fake-jev");
    const [res] = out.results;
    expect(res.key).toBe(key);
    expect(res.suggestions.length).toBeGreaterThan(0);
    for (const s of res.suggestions) {
      expect(s.probability).toBeGreaterThanOrEqual(0.5);
      expect(s.preselect).toBe(s.probability >= 0.9);
      expect(s.confidence).toMatch(/^\d+% likely$/);
    }
    const request = jev.calls[0];
    expect(Object.keys(request.questions)).toEqual(expect.arrayContaining(["priority", "state"]));
    expect(Object.keys(request.questions).filter((k) => k.startsWith("label_")).length).toBeLessThanOrEqual(8);
    expect(request.state.item.key).toBe(key);
    // Cached for the same revision; asked again after the item changes.
    expect((await api.triage(key)).results[0].cached).toBe(true);
    expect(jev.calls).toHaveLength(1);
    fake.run("work.update", { id: triageRow.id, title: `${triageRow.data.title} again` }, { actor: "cloudflare-os:ada@example.com", revision: triageRow.revision });
    await api.queries.refresh();
    expect((await api.triage(key)).results[0].cached).toBe(false);
    expect(jev.calls).toHaveLength(2);
  });

  it("works without Jev (not_connected), reports Jev failures, bounds batches and rate-limits", async () => {
    await expect((await setup({ items: 10, jev: null })).api.triage("TW-1")).rejects.toThrow(/^not_connected: Jev triage is optional/);
    await expect((await setup({ items: 10, jev: createFakeJev({ fail: true }) })).api.triage("TW-1")).rejects.toThrow(/^unavailable: Jev could not answer for TW-1/);
    const { api } = await setup({ items: 90 });
    await expect(api.triage(Array.from({ length: 21 }, (_, i) => `TW-${i + 1}`))).rejects.toThrow(/at most 20/);
    await expect(api.triage([])).rejects.toThrow(/takes an item key/);
    let limited = [];
    for (let batch = 0; batch < 4; batch++) {
      const out = await api.triage(Array.from({ length: 20 }, (_, i) => `TW-${batch * 20 + i + 1}`));
      limited = limited.concat(out.limited);
      if (out.limited.length) expect(out.message).toMatch(/rate-limited/);
    }
    expect(limited.length).toBe(20);
  });
});
