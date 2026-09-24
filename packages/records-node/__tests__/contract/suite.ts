// The Records HTTP contract suite (canonical plan §11.8): one set of HTTP-level expectations that
// every deployment of the service must meet, parameterised by a target (base URL, credentials, a
// way to send requests). It runs against the Node server (records-node) and against the Worker's
// adapters inside workerd, over the same database, and never touches the database directly.
//
// Every test creates its own records, so the suite can run repeatedly, and against several targets
// in turn, on one database.

import { describe, expect, it } from "vitest";

import type { ContractTarget } from "./target.js";

const PREFIX = "/gatekeeper/records/v1";

type Json = Record<string, any>;

export function defineContractSuite(getTarget: () => ContractTarget | Promise<ContractTarget>): void {
  let t: ContractTarget;
  let n = 0;
  const key = (label = "k") => `${label}-${Date.now().toString(36)}-${(n++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const target = async () => (t ??= await getTarget());

  type CallInit = { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; token?: string | null; access?: boolean };
  async function call(path: string, init: CallInit = {}): Promise<Response> {
    const tg = await target();
    const headers = new Headers(init.headers);
    if (init.access !== false && !headers.has("cf-access-jwt-assertion")) headers.set("cf-access-jwt-assertion", tg.accessAssertion);
    if (init.token !== null && !headers.has("authorization")) headers.set("authorization", `Bearer ${init.token ?? tg.credential}`);
    let body: string | undefined;
    if (init.rawBody !== undefined) body = init.rawBody;
    else if (init.body !== undefined) body = JSON.stringify(init.body);
    if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    return tg.fetch(new Request(`${tg.baseUrl}${path}`, { method: init.method ?? "GET", headers, ...(body !== undefined ? { body } : {}) }));
  }
  const ds = (suffix = "") => `${PREFIX}/datastores/${t.datastoreId}${suffix}`;
  async function problemOf(res: Response): Promise<Json> {
    expect(res.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    return (await res.json()) as Json;
  }
  async function createIssue(title = "Contract issue", extra: Json = {}): Promise<Json> {
    const res = await call(ds("/issues"), { method: "POST", body: { projectId: t.projectId, title, ...extra }, headers: { "idempotency-key": key("create") } });
    expect(res.status).toBe(201);
    return (await res.json()) as Json;
  }

  describe("contract: document and routing", () => {
    it("serves the OpenAPI document without credentials", async () => {
      const tg = await target();
      const res = await tg.fetch(new Request(`${tg.baseUrl}${PREFIX}/openapi.json`));
      expect(res.status).toBe(200);
      const doc = (await res.json()) as Json;
      expect(doc.openapi).toBe("3.1.0");
      expect(Object.keys(doc.paths)).toContain(`${PREFIX}/datastores/{datastoreId}/issues/{issueId}`);
      expect(doc.components.securitySchemes.recordsCredential).toMatchObject({ type: "http", scheme: "bearer" });
    });

    it("requires both the Access assertion and a Records credential", async () => {
      await target();
      const noAccess = await call(ds("/projects"), { access: false });
      expect(noAccess.status).toBe(401);
      expect((await problemOf(noAccess)).code).toBe("unauthenticated");
      const badAccess = await call(ds("/projects"), { headers: { "cf-access-jwt-assertion": `${t.accessAssertion.slice(0, -4)}AAAA` } });
      expect(badAccess.status).toBe(401);
      const noCredential = await call(ds("/projects"), { token: null });
      expect(noCredential.status).toBe(401);
      expect(noCredential.headers.get("www-authenticate")).toMatch(/^Bearer/);
      expect((await call(ds("/projects"), { token: `rk1_${"0".repeat(32)}_${"A".repeat(43)}` })).status).toBe(401);
    });

    it("treats the path datastore as a selector that must match the credential", async () => {
      await target();
      const res = await call(`${PREFIX}/datastores/${t.otherDatastoreId}/projects`);
      expect(res.status).toBe(404);
      expect((await problemOf(res)).code).toBe("not_found");
    });

    it("answers problem documents for unknown routes and 405 with Allow for wrong methods", async () => {
      await target();
      const unknown = await call(ds("/nope"));
      expect(unknown.status).toBe(404);
      expect((await problemOf(unknown)).code).toBe("not_found");
      const wrong = await call(ds("/projects"), { method: "DELETE" });
      expect(wrong.status).toBe(405);
      expect(wrong.headers.get("allow")).toBe("GET");
    });
  });

  describe("contract: datastore, projects and workflow", () => {
    it("describes the datastore, its projects and its workflow", async () => {
      await target();
      const datastore = (await (await call(ds())).json()) as Json;
      expect(datastore).toMatchObject({ id: t.datastoreId, moduleId: "projects", lifecycle: "active" });
      const projects = (await (await call(ds("/projects"))).json()) as Json;
      expect(projects.items.map((p: Json) => p.key)).toContain(t.projectKey);
      const workflow = (await (await call(ds("/workflow"))).json()) as Json;
      expect(workflow.states.length).toBeGreaterThan(1);
      expect(workflow.transitions).toContainEqual({ from: "backlog", to: "todo" });
    });

    it("reads the audit log with audit.read", async () => {
      await target();
      await createIssue("Audited");
      const res = await call(ds("/audit?limit=5"));
      expect(res.status).toBe(200);
      const page = (await res.json()) as Json;
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items[0]).toHaveProperty("operation");
    });
  });

  describe("contract: issues", () => {
    it("creates idempotently: 201 with ETag, replay 200, conflicting reuse 409", async () => {
      await target();
      const k = key("idem");
      const body = { projectId: t.projectId, title: "Idempotent create" };
      const created = await call(ds("/issues"), { method: "POST", body, headers: { "idempotency-key": k } });
      expect(created.status).toBe(201);
      expect(created.headers.get("etag")).toBe('"r1"');
      const issue = (await created.json()) as Json;
      expect(issue).toMatchObject({ title: "Idempotent create", revision: 1, state: expect.any(String), createdBy: { kind: "service" } });
      expect(issue.key).toMatch(new RegExp(`^${t.projectKey}-\\d+$`));

      const replay = await call(ds("/issues"), { method: "POST", body, headers: { "idempotency-key": k } });
      expect(replay.status).toBe(200);
      expect(replay.headers.get("idempotent-replayed")).toBe("true");
      expect(((await replay.json()) as Json).id).toBe(issue.id);

      const reuse = await call(ds("/issues"), { method: "POST", body: { ...body, title: "Different" }, headers: { "idempotency-key": k } });
      expect(reuse.status).toBe(409);
      expect((await problemOf(reuse)).code).toBe("idempotency_conflict");
    });

    it("keeps a client-chosen ID", async () => {
      await target();
      const id = crypto.randomUUID();
      const issue = await createIssue("Chosen ID", { id });
      expect(issue.id).toBe(id);
      const got = await call(ds(`/issues/${id}`));
      expect(got.status).toBe(200);
    });

    it("gets an issue with its ETag, and 404 for an unknown one", async () => {
      await target();
      const issue = await createIssue("Readable");
      const got = await call(ds(`/issues/${issue.id}`));
      expect(got.status).toBe(200);
      expect(got.headers.get("etag")).toBe('"r1"');
      expect(((await got.json()) as Json).title).toBe("Readable");
      const missing = await call(ds(`/issues/${crypto.randomUUID()}`));
      expect(missing.status).toBe(404);
      expect((await problemOf(missing)).code).toBe("not_found");
    });

    it("edits with If-Match: 428 without, 200 with the current ETag, 412 with a stale one", async () => {
      await target();
      const issue = await createIssue("Editable");
      const path = ds(`/issues/${issue.id}`);

      const missing = await call(path, { method: "PATCH", body: { title: "x" }, headers: { "idempotency-key": key() } });
      expect(missing.status).toBe(428);
      expect((await problemOf(missing)).code).toBe("revision_required");

      const k = key("edit");
      const edited = await call(path, { method: "PATCH", body: { title: "Edited", priority: "high" }, headers: { "idempotency-key": k, "if-match": '"r1"' } });
      expect(edited.status).toBe(200);
      expect(edited.headers.get("etag")).toBe('"r2"');
      expect((await edited.json()) as Json).toMatchObject({ title: "Edited", priority: "high", revision: 2 });

      const replayed = await call(path, { method: "PATCH", body: { title: "Edited", priority: "high" }, headers: { "idempotency-key": k, "if-match": '"r1"' } });
      expect(replayed.status).toBe(200);
      expect(replayed.headers.get("idempotent-replayed")).toBe("true");

      const stale = await call(path, { method: "PATCH", body: { title: "Stale" }, headers: { "idempotency-key": key(), "if-match": '"r1"' } });
      expect(stale.status).toBe(412);
      expect(stale.headers.get("etag")).toBe('"r2"');
      expect((await problemOf(stale)).code).toBe("revision_conflict");

      const malformed = await call(path, { method: "PATCH", body: { title: "x" }, headers: { "idempotency-key": key(), "if-match": "r2" } });
      expect(malformed.status).toBe(400);
    });

    it("transitions along the workflow only", async () => {
      await target();
      const issue = await createIssue("Movable", { state: "backlog" });
      const path = ds(`/issues/${issue.id}/transitions`);
      const refused = await call(path, { method: "POST", body: { toState: "done" }, headers: { "idempotency-key": key(), "if-match": '"r1"' } });
      expect(refused.status).toBe(409);
      expect((await problemOf(refused)).code).toBe("workflow_conflict");
      const moved = await call(path, { method: "POST", body: { toState: "todo" }, headers: { "idempotency-key": key(), "if-match": '"r1"' } });
      expect(moved.status).toBe(200);
      expect(moved.headers.get("etag")).toBe('"r2"');
      expect(((await moved.json()) as Json).state).toBe("todo");
      const noIfMatch = await call(path, { method: "POST", body: { toState: "in_progress" }, headers: { "idempotency-key": key() } });
      expect(noIfMatch.status).toBe(428);
    });

    it("lists and pages issues with an opaque cursor", async () => {
      await target();
      const marker = key("page");
      for (const i of [1, 2, 3]) await createIssue(`${marker} ${i}`);
      const first = await call(ds(`/issues?q=${encodeURIComponent(marker)}&limit=2&order=number_asc`));
      expect(first.status).toBe(200);
      const page1 = (await first.json()) as Json;
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toEqual(expect.any(String));
      const page2 = (await (await call(ds(`/issues?q=${encodeURIComponent(marker)}&limit=2&order=number_asc&cursor=${encodeURIComponent(page1.nextCursor)}`))).json()) as Json;
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
      expect([...page1.items, ...page2.items].map((i: Json) => i.title)).toEqual([`${marker} 1`, `${marker} 2`, `${marker} 3`]);
      const byProject = (await (await call(ds(`/issues?projectId=${t.projectId}&limit=1`))).json()) as Json;
      expect(byProject.items[0].projectId).toBe(t.projectId);
    });

    it("comments, and lists comments", async () => {
      await target();
      const issue = await createIssue("Commented");
      const k = key("comment");
      const added = await call(ds(`/issues/${issue.id}/comments`), { method: "POST", body: { body: "From the contract suite" }, headers: { "idempotency-key": k } });
      expect(added.status).toBe(201);
      const comment = (await added.json()) as Json;
      expect(comment).toMatchObject({ issueId: issue.id, body: "From the contract suite", author: { kind: "service" } });
      const replay = await call(ds(`/issues/${issue.id}/comments`), { method: "POST", body: { body: "From the contract suite" }, headers: { "idempotency-key": k } });
      expect(replay.status).toBe(200);
      expect(((await replay.json()) as Json).id).toBe(comment.id);
      const list = (await (await call(ds(`/issues/${issue.id}/comments`))).json()) as Json;
      expect(list.items.map((c: Json) => c.id)).toEqual([comment.id]);
    });
  });

  describe("contract: problem codes", () => {
    it("400 validation_failed without echoing values, and for a missing key or bad JSON", async () => {
      await target();
      const bad = await call(ds("/issues"), { method: "POST", body: { projectId: t.projectId, title: "<b>secret-value</b>".repeat(20) }, headers: { "idempotency-key": key() } });
      expect(bad.status).toBe(400);
      const text = await bad.text();
      expect(text).not.toContain("secret-value");
      expect(JSON.parse(text)).toMatchObject({ code: "validation_failed", issues: [expect.objectContaining({ path: "title" })] });
      expect((await call(ds("/issues"), { method: "POST", body: { projectId: t.projectId, title: "no key" } })).status).toBe(400);
      expect((await call(ds("/issues"), { method: "POST", rawBody: "{nope", headers: { "idempotency-key": key() } })).status).toBe(400);
      expect((await call(ds("/issues"), { method: "POST", rawBody: "{}", headers: { "idempotency-key": key(), "content-type": "text/plain" } })).status).toBe(400);
    });

    it("403 forbidden beyond the credential's scopes", async () => {
      await target();
      const res = await call(ds("/issues"), { method: "POST", token: t.readOnlyCredential, body: { projectId: t.projectId, title: "no" }, headers: { "idempotency-key": key() } });
      expect(res.status).toBe(403);
      expect((await problemOf(res)).code).toBe("forbidden");
      expect((await call(ds("/audit"), { token: t.readOnlyCredential })).status).toBe(403);
      expect((await call(ds("/issues"), { token: t.readOnlyCredential })).status).toBe(200);
    });

    it("413 payload_too_large for an oversized body", async () => {
      await target();
      const res = await call(ds("/issues"), { method: "POST", body: { projectId: t.projectId, title: "big", description: "y".repeat(70_000) }, headers: { "idempotency-key": key() } });
      expect(res.status).toBe(413);
      expect((await problemOf(res)).code).toBe("payload_too_large");
    });
  });

  describe("contract: journal", () => {
    it("pages the commit-ordered journal with /changes", async () => {
      await target();
      const start = (await (await call(ds("/changes?after=0&limit=1"))).json()) as Json;
      expect(start).toMatchObject({ head: expect.any(Number), resetRequired: false });
      const issue = await createIssue("Journaled");
      const after = start.head as number;
      const page = (await (await call(ds(`/changes?after=${after}&limit=1000`))).json()) as Json;
      expect(page.head).toBeGreaterThan(after);
      expect(page.nextAfter).toBe(page.entries.at(-1).seq);
      const mine = page.entries.filter((e: Json) => e.entityId === issue.id);
      expect(mine).toEqual([expect.objectContaining({ op: "create", entityType: "issue", command: "projects.createIssue", via: "http", entityRev: 1 })]);
      for (let i = 1; i < page.entries.length; i++) expect(page.entries[i].seq).toBeGreaterThanOrEqual(page.entries[i - 1].seq);
      const empty = (await (await call(ds(`/changes?after=${page.head}`))).json()) as Json;
      expect(empty).toMatchObject({ entries: [], nextAfter: page.head });
      expect((await call(ds("/changes?limit=0"))).status).toBe(400);
    });

    it("returns one issue's history", async () => {
      await target();
      const issue = await createIssue("Historic", { state: "backlog" });
      await call(ds(`/issues/${issue.id}`), { method: "PATCH", body: { title: "Historic (edited)" }, headers: { "idempotency-key": key(), "if-match": '"r1"' } });
      await call(ds(`/issues/${issue.id}/transitions`), { method: "POST", body: { toState: "todo" }, headers: { "idempotency-key": key(), "if-match": '"r2"' } });
      const history = (await (await call(ds(`/issues/${issue.id}/history`))).json()) as Json;
      expect(history.items.map((e: Json) => [e.op, e.entityRev])).toEqual([["create", 1], ["update", 2], ["update", 3]]);
      expect(history.items[1].after).toMatchObject({ title: "Historic (edited)" });
      expect(history.items[1].before).toMatchObject({ title: "Historic" });
    });
  });

  describe("contract: sync", () => {
    it("applies each (client, mutation id) once, replays outcomes, and pulls the result", async () => {
      await target();
      const clientGroupId = key("group").replaceAll(/[^A-Za-z0-9_-]/g, "_");
      const clientId = key("client").replaceAll(/[^A-Za-z0-9_-]/g, "_");
      const issueId = crypto.randomUUID();
      const push = { clientGroupId, clientId, mutations: [
        { id: 1, name: "projects.createIssue", args: { id: issueId, projectId: t.projectId, title: "Synced" } },
        { id: 2, name: "projects.editIssue", args: { issueId, expectedRevision: 1, patch: { title: "Synced!" } } },
        { id: 3, name: "projects.editIssue", args: { issueId, expectedRevision: 1, patch: { title: "stale" } } },
      ] };
      const pushed = await call(ds("/sync/push"), { method: "POST", body: push });
      expect(pushed.status).toBe(200);
      const res = (await pushed.json()) as Json;
      expect(res.outcomes.map((o: Json) => o.status)).toEqual(["applied", "applied", "conflict"]);
      expect(res.outcomes[2]).toMatchObject({ code: "revision_conflict", currentRevision: 2 });

      // A replayed push returns the saved outcomes and commits nothing new.
      const again = (await (await call(ds("/sync/push"), { method: "POST", body: push })).json()) as Json;
      expect(again.outcomes).toEqual(res.outcomes);
      const issueNow = (await (await call(ds(`/issues/${issueId}`))).json()) as Json;
      expect(issueNow.revision).toBe(2);

      const pulled = await call(ds("/sync/pull"), { method: "POST", body: { clientGroupId, cookie: null } });
      expect(pulled.status).toBe(200);
      const pull = (await pulled.json()) as Json;
      expect(pull.cookie).toBeGreaterThanOrEqual(res.head);
      expect(pull.lastMutationIdChanges).toEqual({ [clientId]: 3 });
      const put = pull.patch.find((p: Json) => p.op === "put" && p.key === `issue/${issueId}`);
      expect(put.value).toMatchObject({ id: issueId, title: "Synced!", revision: 2 });

      const later = (await (await call(ds("/sync/pull"), { method: "POST", body: { clientGroupId, cookie: pull.cookie } })).json()) as Json;
      expect(later.patch.filter((p: Json) => p.key === `issue/${issueId}`)).toEqual([]);

      // The sync write is journaled as such.
      const history = (await (await call(ds(`/issues/${issueId}/history`))).json()) as Json;
      expect(history.items.map((e: Json) => e.via)).toEqual(["sync", "sync"]);
    });

    it("refuses a malformed push", async () => {
      await target();
      const res = await call(ds("/sync/push"), { method: "POST", body: { clientGroupId: "short", clientId: "x", mutations: [] } });
      expect(res.status).toBe(400);
      expect((await problemOf(res)).code).toBe("validation_failed");
    });
  });

  describe("contract: Jira surface", () => {
    const jira = (suffix: string) => ds(`/jira/rest/api/2${suffix}`);
    const basic = (user: string, token: string) => `Basic ${btoa(`${user}:${token}`)}`;

    it("authenticates Bearer and Basic (owner e-mail) and refuses a wrong e-mail", async () => {
      await target();
      expect((await call(jira("/serverInfo"))).status).toBe(200);
      expect((await call(jira("/myself"), { headers: { authorization: basic(t.ownerEmail, t.credential) } })).status).toBe(200);
      expect((await call(jira("/myself"), { headers: { authorization: basic("someone@else.test", t.credential) } })).status).toBe(401);
      expect((await call(jira("/myself"), { access: false })).status).toBe(401);
    });

    it("reads an issue created through the native API", async () => {
      await target();
      const issue = await createIssue("Seen from Jira");
      const res = await call(jira(`/issue/${issue.key}`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Json;
      expect(body.key).toBe(issue.key);
      expect(body.fields.summary).toBe("Seen from Jira");
    });
  });
}
