import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RecordsError, type CallerContext } from "@records/contracts";

import { createWorld, key, type World } from "./world.ts";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => w?.close());

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return RecordsError.codeOf(err);
  }
  return "ok";
};

describe("datastore creation and discovery", () => {
  it("only data administrators create datastores", async () => {
    expect(await code(w.service.registry.createDatastore(w.olive.caller, { name: "x", moduleId: "projects", ownerPrincipalId: w.olive.id }))).toBe("forbidden");
  });

  it("the data administrator gets no record access from that role", async () => {
    expect(await code(w.service.projects.listIssues(w.ada.caller, w.ds1, {}))).toBe("not_found");
    const page = await w.service.registry.searchDatastores(w.ada.caller, {});
    expect(page.items).toHaveLength(0);
  });

  it("members see only their datastores by default", async () => {
    const rae = await w.service.registry.searchDatastores(w.rae.caller, {});
    expect(rae.items.map((d) => d.id)).toEqual([w.ds1]);
    expect(rae.items[0]!.role).toBe("reader");
  });

  it("organisation-discoverable datastores are listed without their details, and grant nothing", async () => {
    const page = await w.service.registry.searchDatastores(w.nia.caller, { includeRequestable: true });
    expect(page.items.map((d) => d.id)).toEqual([w.ds2]);
    expect(page.items[0]).toMatchObject({ role: null, description: "" });
    expect(await code(w.service.projects.listProjects(w.nia.caller, w.ds2))).toBe("not_found");
  });

  it("search does not reveal inaccessible names", async () => {
    const page = await w.service.registry.searchDatastores(w.nia.caller, { query: "Engineering" });
    expect(page.items).toHaveLength(0);
  });

  it("paginates", async () => {
    const first = await w.service.registry.searchDatastores(w.olive.caller, { limit: 1 });
    expect(first.items).toHaveLength(1);
    const second = await w.service.registry.searchDatastores(w.olive.caller, { limit: 1, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(second.nextCursor).toBeNull();
    expect(await code(w.service.projects.listIssues(w.olive.caller, w.ds1, { cursor: first.nextCursor! }))).toBe("validation_failed");
  });

  it("detail is for administrators only", async () => {
    expect(await w.service.registry.getDatastore(w.adam.caller, w.ds1)).toHaveProperty("memberCount", 4);
    expect(await w.service.registry.getDatastore(w.rae.caller, w.ds1)).not.toHaveProperty("memberCount");
  });
});

describe("tenant isolation", () => {
  it("another organisation cannot see or touch a datastore, even with a forged context", async () => {
    expect(await code(w.service.projects.listIssues(w.bea.caller, w.ds1, {}))).toBe("not_found");
    // Forged: a real principal of org B claiming org A.
    const forged: CallerContext = { orgId: w.orgA, principalId: w.bea.id, via: "management" };
    expect(await code(w.service.projects.listIssues(forged, w.ds1, {}))).toBe("forbidden");
    // Forged: org B context claiming an org A principal.
    const crossed: CallerContext = { orgId: w.orgB, principalId: w.olive.id, via: "management" };
    expect(await code(w.service.projects.listIssues(crossed, w.ds1, {}))).toBe("forbidden");
    // Unknown actor.
    const unknown: CallerContext = { orgId: w.orgA, principalId: crypto.randomUUID(), via: "management" };
    expect(await code(w.service.projects.listIssues(unknown, w.ds1, {}))).toBe("forbidden");
  });

  it("rejects malformed identifiers without touching the database", async () => {
    expect(await code(w.service.projects.listIssues(w.olive.caller, "not-a-uuid", {}))).toBe("not_found");
  });

  it("cannot create an issue in a project from another datastore", async () => {
    await w.service.registry.addMember(w.olive.caller, w.ds2, { principalId: w.ed.id, role: "editor" });
    const res = code(w.service.projects.createIssue(w.ed.caller, w.ds2, { projectId: w.eng, title: "cross" }, key()));
    expect(await res).toBe("not_found");
  });
});

describe("issues", () => {
  it("readers read but cannot write", async () => {
    expect((await w.service.projects.listIssues(w.rae.caller, w.ds1, {})).items).toBeInstanceOf(Array);
    expect(await code(w.service.projects.createIssue(w.rae.caller, w.ds1, { projectId: w.eng, title: "no" }, key()))).toBe("forbidden");
  });

  it("an editor creates, edits, transitions and comments, with attribution and audit", async () => {
    const created = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "First", priority: "high" }, key());
    expect(created.replayed).toBe(false);
    const issue = created.record;
    expect(issue).toMatchObject({ key: "ENG-1", state: "backlog", revision: 1, createdBy: { id: w.ed.id } });

    const edited = await w.service.projects.editIssue(w.ed.caller, w.ds1, { issueId: issue.id, expectedRevision: 1, patch: { title: "First!", assigneeId: w.rae.id } }, key());
    expect(edited.record).toMatchObject({ title: "First!", revision: 2, assignee: { id: w.rae.id } });

    const moved = await w.service.projects.transitionIssue(w.ed.caller, w.ds1, { issueId: issue.id, expectedRevision: 2, toState: "todo" }, key());
    expect(moved.record).toMatchObject({ state: "todo", revision: 3 });

    const comment = await w.service.projects.addComment(w.ed.caller, w.ds1, { issueId: issue.id, body: "Looks good" }, key());
    expect(comment.record.author.id).toBe(w.ed.id);

    const audit = await w.service.registry.listAudit(w.olive.caller, w.ds1, {});
    const ops = audit.items.map((e) => e.operation);
    expect(ops.slice(0, 4)).toEqual(["addComment", "transitionIssue", "editIssue", "createIssue"]);
    expect(audit.items[0]!.actor.id).toBe(w.ed.id);
  });

  it("refuses a stale revision with the current revision", async () => {
    const { record } = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Stale" }, key());
    await w.service.projects.editIssue(w.ed.caller, w.ds1, { issueId: record.id, expectedRevision: 1, patch: { title: "v2" } }, key());
    try {
      await w.service.projects.editIssue(w.ed.caller, w.ds1, { issueId: record.id, expectedRevision: 1, patch: { title: "v2b" } }, key());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RecordsError);
      expect((err as RecordsError).code).toBe("revision_conflict");
      expect((err as RecordsError).currentRevision).toBe(2);
    }
  });

  it("distinguishes workflow conflicts from revision conflicts", async () => {
    const { record } = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Flow" }, key());
    expect(await code(w.service.projects.transitionIssue(w.ed.caller, w.ds1, { issueId: record.id, expectedRevision: 1, toState: "done" }, key()))).toBe("workflow_conflict");
  });

  it("validates assignees and custom fields against the datastore", async () => {
    expect(await code(w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "x", assigneeId: w.nia.id }, key()))).toBe("validation_failed");
    expect(await code(w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "x", customFields: { nope: 1 } }, key()))).toBe("validation_failed");
  });

  it("rejects payloads that try to set trusted fields", async () => {
    const res = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Sneaky", createdBy: w.olive.id, orgId: w.orgB } as never, key());
    expect(res.record.createdBy.id).toBe(w.ed.id);
    expect(await code(w.service.projects.editIssue(w.ed.caller, w.ds1, { issueId: res.record.id, expectedRevision: 1, patch: { updatedBy: w.olive.id } } as never, key()))).toBe("validation_failed");
  });

  it("filters and pages issues", async () => {
    for (let i = 0; i < 5; i++) await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: `Page ${i}` }, key());
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await w.service.projects.listIssues(w.rae.caller, w.ds1, { query: "Page", limit: 2, cursor, order: "number_asc" });
      all.push(...page.items.map((i) => i.title));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(all).toEqual(["Page 0", "Page 1", "Page 2", "Page 3", "Page 4"]);
    // LIKE metacharacters match literally.
    expect((await w.service.projects.listIssues(w.rae.caller, w.ds1, { query: "%" })).items).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("replays the same request once and refuses a different request with the same key", async () => {
    const k = key("dup");
    const a = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Once" }, k);
    const b = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Once" }, k);
    expect(b.replayed).toBe(true);
    expect(b.record.id).toBe(a.record.id);
    expect(await code(w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Twice" }, k))).toBe("idempotency_conflict");
  });

  it("applies concurrent duplicates exactly once", async () => {
    const k = key("race");
    const results = await Promise.all(
      Array.from({ length: 6 }, () => w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Race" }, k)),
    );
    expect(new Set(results.map((r) => r.record.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const found = await w.service.projects.listIssues(w.ed.caller, w.ds1, { query: "Race" });
    expect(found.items).toHaveLength(1);
  });

  it("a replay still requires current access", async () => {
    const k = key("revoked");
    await w.service.projects.createIssue(w.ed.caller, w.ds2, { projectId: (await w.service.projects.createProject(w.olive.caller, w.ds2, { key: "OPS", name: "Ops" })).id, title: "Ops" }, k);
    await w.service.registry.removeMember(w.olive.caller, w.ds2, { principalId: w.ed.id });
    expect(await code(w.service.projects.createIssue(w.ed.caller, w.ds2, { projectId: crypto.randomUUID(), title: "Ops" }, k))).toBe("not_found");
  });

  it("concurrent edits against one revision: exactly one wins", async () => {
    const { record } = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Contended" }, key());
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        w.service.projects.editIssue(w.ed.caller, w.ds1, { issueId: record.id, expectedRevision: 1, patch: { title: `Winner ${i}` } }, key())
          .then(() => "ok", (err) => RecordsError.codeOf(err))),
    );
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "revision_conflict")).toHaveLength(4);
  });
});

describe("membership administration", () => {
  it("admins cannot create admins or owners; owners transfer ownership explicitly", async () => {
    expect(await code(w.service.registry.addMember(w.adam.caller, w.ds1, { principalId: w.nia.id, role: "admin" }))).toBe("forbidden");
    expect(await code(w.service.registry.addMember(w.adam.caller, w.ds1, { principalId: w.nia.id, role: "owner" } as never))).toBe("validation_failed");
    expect(await code(w.service.registry.removeMember(w.adam.caller, w.ds1, { principalId: w.olive.id }))).toBe("forbidden");
    expect(await code(w.service.registry.addMember(w.ed.caller, w.ds1, { principalId: w.nia.id, role: "reader" }))).toBe("forbidden");
  });

  it("a data administrator can recover a datastore whose owner left", async () => {
    const ds = (await w.service.registry.createDatastore(w.ada.caller, { name: "Orphan", moduleId: "projects", ownerPrincipalId: w.nia.id })).id;
    await w.service.registry.transferOwnership(w.ada.caller, ds, { newOwnerPrincipalId: w.olive.id });
    const members = await w.service.registry.listMembers(w.olive.caller, ds);
    expect(members.find((m) => m.role === "owner")!.principal.id).toBe(w.olive.id);
    expect(members.find((m) => m.principal.id === w.nia.id)!.role).toBe("admin");
  });

  it("archived datastores are read-only", async () => {
    const ds = (await w.service.registry.createDatastore(w.ada.caller, { name: "Archive me", moduleId: "projects", ownerPrincipalId: w.olive.id, initialProject: { key: "ARC", name: "Arc" } })).id;
    const project = (await w.service.projects.listProjects(w.olive.caller, ds))[0]!.id;
    expect(await code(w.service.registry.setLifecycle(w.ed.caller, ds, "archived"))).toBe("not_found");
    await w.service.registry.setLifecycle(w.olive.caller, ds, "archived");
    expect(await code(w.service.projects.createIssue(w.olive.caller, ds, { projectId: project, title: "no" }, key()))).toBe("datastore_archived");
    expect((await w.service.projects.listIssues(w.olive.caller, ds, {})).items).toEqual([]);
    await w.service.registry.setLifecycle(w.olive.caller, ds, "active");
  });
});

describe("bindings and credentials", () => {
  it("a gadget binding narrows its creator's rights and cannot exceed them", async () => {
    expect(await code(w.service.registry.createGadgetBinding(w.rae.caller, w.ds1, { label: "Board", scopes: ["issues.read", "issues.create"] }))).toBe("forbidden");
    const binding = await w.service.registry.createGadgetBinding(w.ed.caller, w.ds1, { label: "Report", scopes: ["projects.read", "issues.read"] });
    const viaBinding: CallerContext = { ...w.ed.caller, via: "gadget", bindingId: binding.id };
    expect((await w.service.projects.listIssues(viaBinding, w.ds1, {})).items.length).toBeGreaterThan(0);
    expect(await code(w.service.projects.createIssue(viaBinding, w.ds1, { projectId: w.eng, title: "x" }, key()))).toBe("forbidden");
    // Scopes claimed by the caller cannot widen the stored binding.
    const widened: CallerContext = { ...viaBinding, scopes: ["issues.create"] };
    expect(await code(w.service.projects.createIssue(widened, w.ds1, { projectId: w.eng, title: "x" }, key()))).toBe("not_found");
    // A binding is only valid for its own datastore.
    expect(await code(w.service.projects.listIssues(viaBinding, w.ds2, {}))).not.toBe("ok");
    await w.service.registry.revokeBinding(w.ed.caller, binding.id);
    expect(await code(w.service.projects.listIssues(viaBinding, w.ds1, {}))).toBe("forbidden");
  });

  it("service credentials authenticate, are scoped, show their secret once, and die on revocation", async () => {
    expect(await code(w.service.registry.createCredential(w.ed.caller, w.ds1, { label: "CI", scopes: ["issues.read"], expiresInDays: 30 }))).toBe("forbidden");
    const created = await w.service.registry.createCredential(w.adam.caller, w.ds1, { label: "CI bot", scopes: ["projects.read", "issues.read", "issues.create"], expiresInDays: 30 });
    expect(created.secret).toMatch(/^rk1_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/);
    const listed = await w.service.registry.listCredentials(w.adam.caller, w.ds1);
    expect(JSON.stringify(listed)).not.toContain(created.secret.slice(-43));

    const auth = await w.service.registry.authenticateCredential(created.secret);
    expect(auth).not.toBeNull();
    expect(auth!.datastoreId).toBe(w.ds1);
    const issue = await w.service.projects.createIssue(auth!.caller, w.ds1, { projectId: w.eng, title: "From CI" }, key());
    expect(issue.record.createdBy).toMatchObject({ kind: "service", displayName: "CI bot" });
    expect(await code(w.service.projects.editIssue(auth!.caller, w.ds1, { issueId: issue.record.id, expectedRevision: 1, patch: { title: "no" } }, key()))).toBe("forbidden");
    expect(await code(w.service.registry.listMembers(auth!.caller, w.ds1))).toBe("forbidden");

    // Tampered secrets fail.
    expect(await w.service.registry.authenticateCredential(created.secret.slice(0, -1) + (created.secret.endsWith("A") ? "B" : "A"))).toBeNull();
    expect(await w.service.registry.authenticateCredential("rk1_nope")).toBeNull();

    await w.service.registry.revokeCredential(w.adam.caller, w.ds1, created.credential.id);
    expect(await w.service.registry.authenticateCredential(created.secret)).toBeNull();
    // A caller context captured before revocation is also dead.
    expect(await code(w.service.projects.listIssues(auth!.caller, w.ds1, {}))).not.toBe("ok");
  });

  it("a credential stops working when its owner loses credentials.manage", async () => {
    const created = await w.service.registry.createCredential(w.adam.caller, w.ds1, { label: "Owner bound", scopes: ["issues.read"], expiresInDays: 1 });
    expect(await w.service.registry.authenticateCredential(created.secret)).not.toBeNull();
    await w.service.registry.setMemberRole(w.olive.caller, w.ds1, { principalId: w.adam.id, role: "editor" });
    expect(await w.service.registry.authenticateCredential(created.secret)).toBeNull();
    await w.service.registry.setMemberRole(w.olive.caller, w.ds1, { principalId: w.adam.id, role: "admin" });
  });
});

describe("revocation ordering", () => {
  it("a revocation committed before an operation's check denies it", async () => {
    await w.service.registry.addMember(w.olive.caller, w.ds1, { principalId: w.nia.id, role: "editor" });
    await w.service.projects.createIssue(w.nia.caller, w.ds1, { projectId: w.eng, title: "Before" }, key());
    await w.service.registry.removeMember(w.olive.caller, w.ds1, { principalId: w.nia.id });
    expect(await code(w.service.projects.createIssue(w.nia.caller, w.ds1, { projectId: w.eng, title: "After" }, key()))).toBe("not_found");
  });

  it("a revocation racing in-flight writes waits for them, and later writes fail", async () => {
    await w.service.registry.addMember(w.olive.caller, w.ds1, { principalId: w.nia.id, role: "editor" });
    const writes = Array.from({ length: 8 }, (_, i) =>
      w.service.projects.createIssue(w.nia.caller, w.ds1, { projectId: w.eng, title: `Racing ${i}` }, key()).then(() => "ok", (e) => RecordsError.codeOf(e)));
    const revoke = w.service.registry.removeMember(w.olive.caller, w.ds1, { principalId: w.nia.id });
    const outcomes = await Promise.all([...writes, revoke.then(() => "revoked")]);
    expect(outcomes.every((o) => o === "ok" || o === "not_found" || o === "revoked")).toBe(true);
    const audit = await w.service.registry.listAudit(w.olive.caller, w.ds1, { limit: 100 });
    const removedAt = audit.items.findIndex((e) => e.operation === "removeMember" && e.targetId === w.nia.id);
    // No write by Nia is audited after (i.e. listed before, newest-first) her removal.
    expect(audit.items.slice(0, removedAt).some((e) => e.actor.id === w.nia.id)).toBe(false);
  });
});
