// The gadget path, in workerd: facet + session + viewer assertions + observers + approvals, against
// real Postgres through local Hyperdrive. The ScriptedQueue in worker.ts plays the kernel's
// ApprovalQueue, including one-use digest-bound viewer assertions.

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { intentDigest, type MutatingRecordOperation } from "@records/contracts";

import { connect, RecordsService } from "../../src/domain/service.js";
import type { RecordsGatekeeperProps } from "../../src/vendor/gatekeeper.js";

type Seed = { orgA: string; orgB: string; ds1: string; ds2: string; eng: string; people: Record<string, { id: string; email: string }> };
const seed = JSON.parse((env as unknown as { TEST_SEED: string }).TEST_SEED) as Seed;
const hooks = (env as unknown as { TEST_HOOKS: DurableObjectNamespace }).TEST_HOOKS.getByName("hooks") as unknown as {
  mintAssertion(digest: string, viewer: { id: string; displayName: string; role: "build" | "use" }): Promise<string>;
  describe(name: string, props: RecordsGatekeeperProps): Promise<{ url: string; title: string; snippet: string }>;
  addObserver(name: string, props: RecordsGatekeeperProps, id: string, identity: { orgId: string; principalId: string }): Promise<string | null>;
  session(name: string, props: RecordsGatekeeperProps, calls: { method: string; args: unknown[] }[], opts?: { autoApply?: boolean; refuseExcluded?: boolean }): Promise<{
    results: ({ ok: any } | { error: string })[];
    log: { observations: { title: string; excludeObservers?: string[] }[]; actions: { id: number; description: { title: string; description: string; actionKind?: { tag: string } } }[] };
  }>;
  applyAction(name: string, props: RecordsGatekeeperProps, id: number): Promise<string | null>;
  registerHook(datastoreId: string, orgId: string, bindingId: string, log: string, deliver: "changes" | "pokes"): Promise<void>;
  pokesFor(log: string): Promise<unknown[]>;
  rejectAction(name: string, props: RecordsGatekeeperProps, id: number): Promise<void>;
};

const WRITE_SCOPES = ["projects.read", "issues.read", "issues.create", "issues.edit", "issues.transition", "comments.create"] as RecordsGatekeeperProps["scopes"];
const person = (k: string) => seed.people[k]!;
const props = (owner: string, scopes = WRITE_SCOPES, datastoreId = seed.ds1): RecordsGatekeeperProps => ({
  accountId: `acct-${owner}`, orgId: owner === "bea" ? seed.orgB : seed.orgA, principalId: person(owner).id, datastoreId, scopes,
});
const viewer = (k: string, role: "build" | "use" = "use") => ({ id: person(k).email, displayName: k[0]!.toUpperCase() + k.slice(1), role });
let n = 0;
const facetName = () => `facet-${n++}-${Date.now()}`;
// A Workers RPC promise handed straight to expect().rejects leaves a copy that vitest reports as an
// unhandled rejection even though the assertion saw it; adopting it in a native promise does not.
const settled = <T>(rpc: Promise<T>): Promise<T> => (async () => rpc)();

async function write(operation: MutatingRecordOperation, input: unknown, who: ReturnType<typeof viewer>, idempotencyKey = `key-${crypto.randomUUID()}`) {
  const token = await hooks.mintAssertion(await intentDigest({ operation, input, idempotencyKey }), who);
  return { method: operation, args: [input, { idempotencyKey, viewerAssertion: token }] };
}

const service = () => new RecordsService(connect(env.HYPERDRIVE.connectionString, { max: 1 }));

describe("describe and binding", () => {
  it("describes a datastore the connecting person can read", async () => {
    const d = await hooks.describe(facetName(), props("ed"));
    expect(d.title).toBe("Engineering projects");
    expect(d.url).toBe(`records://datastore/${seed.ds1}/comments.create,issues.create,issues.edit,issues.read,issues.transition,projects.read`);
  });

  it("refuses to describe a datastore the connecting person cannot read", async () => {
    await expect(settled(hooks.describe(facetName(), props("nia")))).rejects.toThrow(/not_found/);
  });

  it("refuses to bind scopes beyond the connecting person's rights", async () => {
    // The binding is created when the first session starts, so the session itself is refused.
    await expect(settled(hooks.session(facetName(), props("rae"), [{ method: "listProjects", args: [] }]))).rejects.toThrow(/forbidden/);
  });
});

describe("reads", () => {
  it("reads through the binding and records an observation for each read", async () => {
    const r = await hooks.session(facetName(), props("ed"), [
      { method: "listProjects", args: [] },
      { method: "getWorkflow", args: [] },
      { method: "listIssues", args: [{ limit: 5 }] },
      { method: "describe", args: [] },
    ]);
    expect(r.results.every((x) => "ok" in x)).toBe(true);
    expect((r.results[0] as { ok: { key: string }[] }).ok[0]!.key).toBe("ENG");
    expect(r.log.observations.map((o) => o.title)).toEqual(["List projects", "Read workflow", "List issues", "Describe Records datastore"]);
  });
});

describe("writes with viewer assertions", () => {
  it("applies a write as the viewer who asked, not the binding owner", async () => {
    const name = facetName();
    const input = { projectId: seed.eng, title: "Asserted by Ed" };
    const r = await hooks.session(name, props("olive"), [await write("createIssue", input, viewer("ed"))]);
    const outcome = (r.results[0] as { ok: { status: string; record: { createdBy: { id: string } } } }).ok;
    expect(outcome.status).toBe("applied");
    expect(outcome.record.createdBy.id).toBe(person("ed").id);
    expect(r.log.actions[0]!.description.title).toContain("Ed");
    expect(r.log.actions[0]!.description.actionKind?.tag).toBe("records.createIssue");
  });

  it("interleaved viewers get their own rights: a reader is refused on an editor's gadget", async () => {
    const name = facetName();
    const calls = [
      await write("createIssue", { projectId: seed.eng, title: "Rae tries" }, viewer("rae")),
      await write("createIssue", { projectId: seed.eng, title: "Ed succeeds" }, viewer("ed")),
      await write("createIssue", { projectId: seed.eng, title: "Rae again" }, viewer("rae")),
    ];
    const r = await hooks.session(name, props("olive"), calls);
    const statuses = r.results.map((x) => (x as { ok: { status: string } }).ok.status);
    expect(statuses).toEqual(["rejected", "applied", "rejected"]);
  });

  it("refuses a replayed assertion and an assertion for a different input", async () => {
    const idempotencyKey = `key-${crypto.randomUUID()}`;
    const input = { projectId: seed.eng, title: "Once" };
    const token = await hooks.mintAssertion(await intentDigest({ operation: "createIssue", input, idempotencyKey }), viewer("ed"));
    const r = await hooks.session(facetName(), props("olive"), [
      { method: "createIssue", args: [{ ...input, title: "Tampered" }, { idempotencyKey, viewerAssertion: token }] },
      { method: "createIssue", args: [input, { idempotencyKey, viewerAssertion: token }] },
    ]);
    expect(r.results[0]).toMatchObject({ error: expect.stringMatching(/fresh assertion/) });
    // The failed attempt consumed nothing it could use, but the token is single-use regardless.
    expect(r.results[1]).toMatchObject({ error: expect.stringMatching(/fresh assertion/) });
    expect(r.log.actions).toHaveLength(0);
  });

  it("refuses a write with no assertion, or with a forged one", async () => {
    const r = await hooks.session(facetName(), props("olive"), [
      { method: "createIssue", args: [{ projectId: seed.eng, title: "x" }, { idempotencyKey: "abcdefgh1" }] },
      { method: "createIssue", args: [{ projectId: seed.eng, title: "x" }, { idempotencyKey: "abcdefgh2", viewerAssertion: crypto.randomUUID() }] },
    ]);
    expect(r.results[0]).toMatchObject({ error: expect.stringMatching(/validation_failed/) });
    expect(r.results[1]).toMatchObject({ error: expect.stringMatching(/fresh assertion/) });
  });

  it("rejects viewers who are not in the organisation's directory", async () => {
    const stranger = { id: "mallory@evil.test", displayName: "Mallory", role: "use" as const };
    const bea = viewer("bea");
    const r = await hooks.session(facetName(), props("olive"), [
      await write("createIssue", { projectId: seed.eng, title: "x" }, stranger),
      await write("createIssue", { projectId: seed.eng, title: "x" }, bea),
    ]);
    expect(r.results.map((x) => (x as { ok: { status: string; code: string } }).ok)).toEqual([
      expect.objectContaining({ status: "rejected", code: "forbidden" }),
      expect.objectContaining({ status: "rejected", code: "forbidden" }),
    ]);
  });

  it("a binding's scopes cap even an editor", async () => {
    const readOnly = props("olive", ["projects.read", "issues.read"]);
    const r = await hooks.session(facetName(), readOnly, [await write("createIssue", { projectId: seed.eng, title: "x" }, viewer("ed"))]);
    expect((r.results[0] as { ok: { status: string } }).ok.status).toBe("rejected");
  });

  it("reports pending until approved, then applied; a rejection is final", async () => {
    const name = facetName();
    const p = props("olive");
    const r = await hooks.session(name, p, [await write("createIssue", { projectId: seed.eng, title: "Needs approval" }, viewer("ed"))], { autoApply: false });
    const pending = (r.results[0] as { ok: { status: string; actionId: number } }).ok;
    expect(pending.status).toBe("pending");
    expect(await hooks.applyAction(name, p, pending.actionId)).toBeNull();
    const after = await hooks.session(name, p, [{ method: "getWriteOutcome", args: [pending.actionId] }]);
    expect((after.results[0] as { ok: { status: string } }).ok.status).toBe("applied");

    const r2 = await hooks.session(name, p, [await write("addComment", { issueId: crypto.randomUUID(), body: "hi" }, viewer("ed"))], { autoApply: false });
    const id2 = (r2.results[0] as { ok: { actionId: number } }).ok.actionId;
    await hooks.rejectAction(name, p, id2);
    const after2 = await hooks.session(name, p, [{ method: "getWriteOutcome", args: [id2] }]);
    expect((after2.results[0] as { ok: { status: string; code: string } }).ok).toMatchObject({ status: "rejected", code: "rejected_by_approver" });
  });

  it("re-checks permissions when an approved action is applied", async () => {
    const name = facetName();
    const p = props("olive");
    const svc = service();
    // Nia becomes an editor, asks for a change, then loses access before approval.
    await svc.registry.addMember({ orgId: seed.orgA, principalId: person("olive").id, via: "management" }, seed.ds1, { principalId: person("nia").id, role: "editor" });
    const r = await hooks.session(name, p, [await write("createIssue", { projectId: seed.eng, title: "Late" }, viewer("nia"))], { autoApply: false });
    const id = (r.results[0] as { ok: { actionId: number } }).ok.actionId;
    await svc.registry.removeMember({ orgId: seed.orgA, principalId: person("olive").id, via: "management" }, seed.ds1, { principalId: person("nia").id });
    expect(await hooks.applyAction(name, p, id)).toMatch(/not_found/);
    const after = await hooks.session(name, p, [{ method: "getWriteOutcome", args: [id] }]);
    expect((after.results[0] as { ok: { status: string } }).ok.status).toBe("rejected");
    await svc.db.end();
  });

  it("surfaces revision conflicts as conflicts", async () => {
    const name = facetName();
    const p = props("olive");
    const created = await hooks.session(name, p, [await write("createIssue", { projectId: seed.eng, title: "Conflict" }, viewer("ed"))]);
    const issue = (created.results[0] as { ok: { record: { id: string } } }).ok.record;
    const r = await hooks.session(name, p, [
      await write("editIssue", { issueId: issue.id, expectedRevision: 1, patch: { title: "first" } }, viewer("ed")),
      await write("editIssue", { issueId: issue.id, expectedRevision: 1, patch: { title: "second" } }, viewer("olive", "build")),
    ]);
    expect((r.results[0] as { ok: { status: string } }).ok.status).toBe("applied");
    expect((r.results[1] as { ok: { status: string; code: string; currentRevision: number } }).ok).toMatchObject({ status: "conflict", code: "revision_conflict", currentRevision: 2 });
  });
});

describe("observers", () => {
  it("admits members, refuses non-members and other organisations", async () => {
    const name = facetName();
    const p = props("olive");
    expect(await hooks.addObserver(name, p, "obs-rae", { orgId: seed.orgA, principalId: person("rae").id })).toBeNull();
    expect(await hooks.addObserver(name, p, "obs-nia", { orgId: seed.orgA, principalId: person("nia").id })).toMatch(/cannot read/);
    expect(await hooks.addObserver(name, p, "obs-bea", { orgId: seed.orgB, principalId: person("bea").id })).toMatch(/organisation/);
  });

  it("excludes an observer who lost access, and the read fails if the platform cannot hide it", async () => {
    const name = facetName();
    const p = props("olive");
    const svc = service();
    const olive = { orgId: seed.orgA, principalId: person("olive").id, via: "management" as const };
    await svc.registry.addMember(olive, seed.ds1, { principalId: person("nia").id, role: "reader" });
    expect(await hooks.addObserver(name, p, "obs-nia", { orgId: seed.orgA, principalId: person("nia").id })).toBeNull();
    await svc.registry.removeMember(olive, seed.ds1, { principalId: person("nia").id });

    const r = await hooks.session(name, p, [{ method: "listProjects", args: [] }]);
    expect(r.log.observations[0]!.excludeObservers).toEqual(["obs-nia"]);
    const strict = await hooks.session(name, p, [{ method: "listProjects", args: [] }], { refuseExcluded: true });
    expect(strict.results[0]).toMatchObject({ error: expect.stringMatching(/cannot hide/) });
    await svc.db.end();
  });
});

describe("revocation", () => {
  it("a revoked binding stops the gadget; the records remain", async () => {
    const name = facetName();
    const p = props("ed", ["projects.read", "issues.read"]);
    const first = await hooks.session(name, p, [{ method: "describe", args: [] }]);
    expect(first.results[0]).toHaveProperty("ok");
    const svc = service();
    const ed = { orgId: seed.orgA, principalId: person("ed").id, via: "management" as const };
    await svc.registry.revokeConnection(ed, "acct-ed");
    const after = await hooks.session(name, p, [{ method: "listIssues", args: [] }]);
    expect(after.results[0]).toMatchObject({ error: expect.stringMatching(/revoked/) });
    const stillThere = await svc.projects.listIssues({ orgId: seed.orgA, principalId: person("olive").id, via: "management" }, seed.ds1, {});
    expect(stillThere.items.length).toBeGreaterThan(0);
    await svc.db.end();
  });
});

describe("sync through the gadget session", () => {
  type PushOutcome = { id: number; status: string; seq?: number; actionId?: number; code?: string };
  type SyncMutation = { id: number; name: `projects.${MutatingRecordOperation}`; args: unknown };
  let g = 0;
  const ids = () => ({ clientGroupId: `group-${g}-${crypto.randomUUID().slice(0, 8)}`, clientId: `client-${g++}-${crypto.randomUUID().slice(0, 8)}` });

  /** A syncPush call with one fresh assertion per mutation, as the gadget UI would mint them. */
  async function push(req: { clientGroupId: string; clientId: string }, mutations: SyncMutation[], who: ReturnType<typeof viewer> | ReturnType<typeof viewer>[]) {
    const options = [];
    for (const [i, m] of mutations.entries()) {
      const v = Array.isArray(who) ? who[i]! : who;
      const digest = await intentDigest({ operation: m.name.slice("projects.".length) as MutatingRecordOperation, input: m.args, idempotencyKey: `sync:${req.clientId}:${m.id}` });
      options.push({ viewerAssertion: await hooks.mintAssertion(digest, v) });
    }
    return { method: "syncPush", args: [{ ...req, mutations }, options] };
  }
  // One facet for the whole block: every facet holds its own database connections.
  const shared = facetName();
  const outcomes = (r: { results: unknown[] }, i = 0) => (r.results[i] as { ok: { outcomes: PushOutcome[]; head: number } }).ok;

  it("applies pre-approved mutations as the viewer, replays saved outcomes, and pulls them back", async () => {
    const name = shared;
    const p = props("olive");
    const req = ids();
    const issueId = crypto.randomUUID();
    const mutations: SyncMutation[] = [
      { id: 1, name: "projects.createIssue", args: { id: issueId, projectId: seed.eng, title: "Synced by Ed" } },
      { id: 2, name: "projects.editIssue", args: { issueId, expectedRevision: 1, patch: { title: "Synced by Ed!" } } },
    ];
    const r = await hooks.session(name, p, [await push(req, mutations, viewer("ed")), await push(req, mutations, viewer("ed"))]);
    const first = outcomes(r, 0);
    expect(first.outcomes).toEqual([{ id: 1, status: "applied", seq: expect.any(Number) }, { id: 2, status: "applied", seq: first.outcomes[0]!.seq! + 1 }]);
    expect(first.head).toBe(first.outcomes[1]!.seq);
    expect(outcomes(r, 1)).toEqual(first); // replayed: saved outcomes, nothing applied twice
    expect(r.log.actions.map((a) => a.description.actionKind?.tag)).toEqual(["records.createIssue", "records.editIssue"]);

    const pulled = await hooks.session(name, p, [{ method: "syncPull", args: [{ clientGroupId: req.clientGroupId, cookie: null }] }]);
    const pull = (pulled.results[0] as { ok: { cookie: number; lastMutationIdChanges: Record<string, number>; patch: { op: string; key?: string; value?: any }[] } }).ok;
    expect(pull.lastMutationIdChanges).toEqual({ [req.clientId]: 2 });
    expect(pull.patch[0]).toEqual({ op: "clear" });
    const issue = pull.patch.find((x) => x.key === `issue/${issueId}`)!.value;
    expect(issue).toMatchObject({ title: "Synced by Ed!", revision: 2, createdBy: { id: person("ed").id } });
    expect(pulled.log.observations.map((o) => o.title)).toEqual(["Sync records"]);
    // A group nobody pushed into through this connection reports no clients.
    const other = await hooks.session(name, p, [{ method: "syncPull", args: [{ clientGroupId: "group-nobody-here", cookie: pull.cookie }] }]);
    expect((other.results[0] as { ok: { lastMutationIdChanges: object; patch: { key?: string }[] } }).ok).toMatchObject({ lastMutationIdChanges: {}, patch: [{ key: "meta/workflow" }] });
  });

  it("returns pending with the actionId, keeps it on replay, and reports approval status", async () => {
    const name = shared;
    const p = props("olive");
    const req = ids();
    const mutations: SyncMutation[] = [
      { id: 1, name: "projects.createIssue", args: { id: crypto.randomUUID(), projectId: seed.eng, title: "Awaiting approval" } },
      { id: 2, name: "projects.createIssue", args: { id: crypto.randomUUID(), projectId: seed.eng, title: "Will be refused" } },
    ];
    const r = await hooks.session(name, p, [await push(req, mutations, viewer("ed"))], { autoApply: false });
    const pending = outcomes(r).outcomes;
    expect(pending).toEqual([{ id: 1, status: "pending", actionId: expect.any(Number) }, { id: 2, status: "pending", actionId: expect.any(Number) }]);
    const again = await hooks.session(name, p, [await push(req, mutations, viewer("ed"))], { autoApply: false });
    expect(outcomes(again).outcomes).toEqual(pending);
    expect(again.log.actions).toHaveLength(0); // nothing resubmitted

    const [a1, a2] = [pending[0]!.actionId!, pending[1]!.actionId!];
    expect(await hooks.applyAction(name, p, a1)).toBeNull();
    await hooks.rejectAction(name, p, a2);
    const status = await hooks.session(name, p, [
      { method: "syncApprovals", args: [[a1, a2, 9999]] },
      { method: "syncPull", args: [{ clientGroupId: req.clientGroupId, cookie: null }] },
    ]);
    expect((status.results[0] as { ok: unknown }).ok).toEqual([
      { actionId: a1, status: "approved" },
      { actionId: a2, status: "rejected", message: expect.any(String) },
      { actionId: 9999, status: "expired" },
    ]);
    const pull = (status.results[1] as { ok: { lastMutationIdChanges: Record<string, number>; patch: { key?: string }[] } }).ok;
    expect(pull.lastMutationIdChanges).toEqual({ [req.clientId]: 2 });
    expect(pull.patch.some((x) => x.key === `issue/${(mutations[0]!.args as { id: string }).id}`)).toBe(true);
    expect(pull.patch.some((x) => x.key === `issue/${(mutations[1]!.args as { id: string }).id}`)).toBe(false);
  });

  it("refuses a reader's mutations per mutation, but mixed viewers, missing assertions and a foreign group per request", async () => {
    const name = shared;
    const p = props("olive");
    const req = ids();
    const create = (id: number): SyncMutation => ({ id, name: "projects.createIssue", args: { projectId: seed.eng, title: `n${id}` } });
    const r = await hooks.session(name, p, [
      await push(req, [create(1), { id: 2, name: "projects.createIssue", args: { projectId: seed.eng, title: "" } }], [viewer("rae"), viewer("rae")]),
      await push(ids(), [create(1), create(2)], [viewer("ed"), viewer("olive")]),
      { method: "syncPush", args: [{ ...ids(), mutations: [create(1)] }, []] },
      await push(req, [create(2)], viewer("ed")),
    ]);
    expect(outcomes(r, 0).outcomes).toEqual([
      { id: 1, status: "rejected", code: "forbidden", message: expect.any(String) },
      { id: 2, status: "rejected", code: "validation_failed", message: expect.any(String) },
    ]);
    expect(r.results[1]).toMatchObject({ error: expect.stringMatching(/same viewer/) });
    expect(r.results[2]).toMatchObject({ error: expect.stringMatching(/one viewer assertion per mutation/) });
    expect(r.results[3]).toMatchObject({ error: expect.stringMatching(/another viewer/) });
    expect(r.log.actions).toHaveLength(0);
  });
});

describe("poke hub", () => {
  const hubs = (env as unknown as { POKE_HUBS: DurableObjectNamespace }).POKE_HUBS;
  const hub = (id: string) => hubs.getByName(id) as unknown as DurableObjectStub & { poke(ds: string, head: number): Promise<number>; subscriberCount(): Promise<number> };

  async function subscribe(id: string): Promise<{ ws: WebSocket; messages: string[]; closed: Promise<{ code: number }> }> {
    const res = await hub(id).fetch("https://hub/", { headers: { upgrade: "websocket", "x-records-poke-datastore": id } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    ws.accept();
    const messages: string[] = [];
    ws.addEventListener("message", (e) => {
      messages.push(String(e.data));
    });
    const closed = new Promise<{ code: number }>((resolve) => ws.addEventListener("close", (e) => resolve({ code: e.code })));
    return { ws, messages, closed };
  }

  it("broadcasts {datastoreId, head} to subscribers and refuses non-upgrades", async () => {
    const id = crypto.randomUUID();
    const a = await subscribe(id);
    const b = await subscribe(id);
    expect(await hub(id).poke(id, 42)).toBe(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(a.messages).toEqual([JSON.stringify({ datastoreId: id, head: 42 })]);
    expect(b.messages).toEqual(a.messages);
    expect((await hub(id).fetch("https://hub/", { headers: { "x-records-poke-datastore": id } })).status).toBe(426);
    a.ws.close(1000, "done");
    b.ws.close(1000, "done");
  });

  it("closes sockets past their maximum lifetime on the alarm", async () => {
    const id = crypto.randomUUID();
    const s = await subscribe(id);
    const stub = hub(id);
    await runInDurableObject(stub as never, async (_instance: unknown, state: DurableObjectState) => {
      for (const ws of state.getWebSockets()) ws.serializeAttachment({ expiresAt: Date.now() - 1 });
    });
    expect(await runDurableObjectAlarm(stub as never)).toBe(true);
    expect((await s.closed).code).toBe(4000);
  });
});


describe("poke hooks", () => {
  const hub = (id: string) => (env as unknown as { POKE_HUBS: DurableObjectNamespace }).POKE_HUBS.getByName(id) as unknown as { poke(ds: string, head: number): Promise<number> };
  const feed = () => (env as unknown as { FEEDS: DurableObjectNamespace }).FEEDS.getByName(seed.ds1) as unknown as { hookCount(deliver?: string): Promise<number>; unregister(b: string): Promise<void> };

  it("the hub forwards pokes to hooks registered for pokes only, re-checking each binding", async () => {
    const svc = service();
    const ed = { orgId: seed.orgA, principalId: person("ed").id, via: "management" as const };
    const pokes = await svc.registry.createGadgetBinding(ed, seed.ds1, { label: "Poke hook", scopes: ["projects.read", "issues.read"] }, "acct-poke-hook");
    const changes = await svc.registry.createGadgetBinding(ed, seed.ds1, { label: "Change hook", scopes: ["projects.read", "issues.read"] }, "acct-change-hook");
    const [logP, logC] = [crypto.randomUUID(), crypto.randomUUID()];
    await hooks.registerHook(seed.ds1, seed.orgA, pokes.id, logP, "pokes");
    await hooks.registerHook(seed.ds1, seed.orgA, changes.id, logC, "changes");
    expect(await feed().hookCount("pokes")).toBe(1);

    await hub(seed.ds1).poke(seed.ds1, 7);
    await hub(seed.ds1).poke(seed.ds1, 8);
    expect(await hooks.pokesFor(logP)).toEqual([{ datastoreId: seed.ds1, head: 7 }, { datastoreId: seed.ds1, head: 8 }]);
    expect(await hooks.pokesFor(logC)).toEqual([]);

    await svc.registry.revokeConnection(ed, "acct-poke-hook");
    await hub(seed.ds1).poke(seed.ds1, 9);
    expect(await hooks.pokesFor(logP)).toHaveLength(2);
    expect(await feed().hookCount("pokes")).toBe(0);
    await feed().unregister(changes.id);
    await svc.db.end();
  });
});
