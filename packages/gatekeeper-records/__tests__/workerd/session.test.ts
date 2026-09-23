// The gadget path, in workerd: facet + session + viewer assertions + observers + approvals, against
// real Postgres through local Hyperdrive. The ScriptedQueue in worker.ts plays the kernel's
// ApprovalQueue, including one-use digest-bound viewer assertions.

import { env } from "cloudflare:test";
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
    await expect(hooks.describe(facetName(), props("nia"))).rejects.toThrow(/not_found/);
  });

  it("refuses to bind scopes beyond the connecting person's rights", async () => {
    // The binding is created when the first session starts, so the session itself is refused.
    await expect(hooks.session(facetName(), props("rae"), [{ method: "listProjects", args: [] }])).rejects.toThrow(/forbidden/);
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
