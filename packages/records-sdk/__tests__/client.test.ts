// The generated TypeScript client against a real Node server.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RecordsApiError, RecordsClient, RevisionConflictError, type Issue } from "../src/index.js";
import { startServer, type ContractStack } from "./support.js";

let stack: ContractStack;
let client: RecordsClient;
let readOnly: RecordsClient;

beforeAll(async () => {
  stack = await startServer();
  const assertion = await stack.access.sign();
  const common = { baseUrl: stack.baseUrl, datastoreId: stack.world.datastoreId, accessAssertion: () => assertion };
  client = new RecordsClient({ ...common, credential: stack.world.credential });
  readOnly = new RecordsClient({ ...common, credential: stack.world.readOnlyCredential });
});
afterAll(async () => stack?.close());

const projectId = () => stack.world.projectId;

describe("RecordsClient", () => {
  it("reads the datastore, projects and workflow", async () => {
    expect((await client.getDatastore()).id).toBe(stack.world.datastoreId);
    expect((await client.listProjects()).items.map((p) => p.id)).toContain(projectId());
    expect((await client.getWorkflow()).states.length).toBeGreaterThan(1);
  });

  it("creates with an automatic idempotency key; an explicit key replays", async () => {
    const a = await client.createIssue({ projectId: projectId(), title: "SDK one" });
    const b = await client.createIssue({ projectId: projectId(), title: "SDK one" });
    expect(a.id).not.toBe(b.id);
    const key = `sdk-${crypto.randomUUID()}`;
    const first = await client.createIssue({ projectId: projectId(), title: "SDK keyed" }, { idempotencyKey: key });
    const again = await client.createIssue({ projectId: projectId(), title: "SDK keyed" }, { idempotencyKey: key });
    expect(again.id).toBe(first.id);
    await expect(client.createIssue({ projectId: projectId(), title: "Other" }, { idempotencyKey: key })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("edits with ifMatch and surfaces a stale edit as RevisionConflictError with the current revision", async () => {
    const issue = await client.createIssue({ projectId: projectId(), title: "SDK edit", state: "backlog" });
    const edited = await client.editIssue(issue.id, { title: "SDK edited" }, { ifMatch: issue.revision });
    expect(edited.revision).toBe(2);
    const stale = await client.editIssue(issue.id, { title: "stale" }, { ifMatch: 1 }).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(RevisionConflictError);
    expect((stale as RevisionConflictError).currentRevision).toBe(2);
    expect((stale as RevisionConflictError).code).toBe("revision_conflict");
    const moved = await client.transitionIssue(issue.id, { toState: "todo" }, { ifMatch: `"r${edited.revision}"` });
    expect(moved.state).toBe("todo");
    await expect(client.transitionIssue(issue.id, { toState: "done" }, { ifMatch: moved.revision })).rejects.toMatchObject({ code: "workflow_conflict" });
    // Required at the type level too; at runtime a missing ifMatch is refused before sending.
    await expect(client.editIssue(issue.id, { title: "x" }, {} as never)).rejects.toThrow(/ifMatch/);
  });

  it("comments, reads history, and pages with the iterators", async () => {
    const marker = `sdk-page-${crypto.randomUUID().slice(0, 8)}`;
    const created: Issue[] = [];
    for (const i of [1, 2, 3]) created.push(await client.createIssue({ projectId: projectId(), title: `${marker} ${i}` }));
    const seen: string[] = [];
    for await (const issue of client.iterateIssues({ q: marker, limit: 2, order: "number_asc" })) seen.push(issue.title);
    expect(seen).toEqual([`${marker} 1`, `${marker} 2`, `${marker} 3`]);

    const target = created[0]!;
    for (const body of ["one", "two", "three"]) await client.addComment(target.id, { body });
    const bodies: string[] = [];
    for await (const c of client.iterateComments(target.id)) bodies.push(c.body);
    expect(bodies.sort()).toEqual(["one", "three", "two"]);

    const history = await client.getIssueHistory(target.id);
    expect(history.items[0]).toMatchObject({ op: "create", via: "http" });
  });

  // Regression: the comments cursor carries created_at at millisecond precision while the column
  // has microseconds; the service compares at millisecond precision so pages never overlap.
  it("pages comments without repeating the last item of a page", async () => {
    const issue = await client.createIssue({ projectId: projectId(), title: "SDK comment pages" });
    for (const body of ["one", "two", "three"]) await client.addComment(issue.id, { body });
    const ids: string[] = [];
    for await (const c of client.iterateComments(issue.id, { limit: 2 })) ids.push(c.id);
    expect(ids).toHaveLength(3);
  });

  it("walks /changes from a sequence number to the head", async () => {
    const { head } = await client.listChanges({ after: 0, limit: 1 });
    const issue = await client.createIssue({ projectId: projectId(), title: "SDK change" });
    const entries = [];
    for await (const e of client.iterateChanges({ after: head, limit: 1 })) entries.push(e);
    expect(entries.some((e) => e.entityId === issue.id && e.op === "create")).toBe(true);
    for (let i = 1; i < entries.length; i++) expect(entries[i]!.seq).toBeGreaterThanOrEqual(entries[i - 1]!.seq);
  });

  it("pushes and pulls", async () => {
    const clientGroupId = `grp_${crypto.randomUUID().replaceAll("-", "")}`;
    const clientId = `cli_${crypto.randomUUID().replaceAll("-", "")}`;
    const id = crypto.randomUUID();
    const pushed = await client.syncPush({ clientGroupId, clientId, mutations: [{ id: 1, name: "projects.createIssue", args: { id, projectId: projectId(), title: "SDK sync" } }] });
    expect(pushed.outcomes[0]).toMatchObject({ status: "applied" });
    const pulled = await client.syncPull({ clientGroupId, cookie: null });
    expect(pulled.lastMutationIdChanges[clientId]).toBe(1);
    expect(pulled.patch.some((p) => p.op === "put" && p.key === `issue/${id}`)).toBe(true);
  });

  it("raises RecordsApiError with the problem code", async () => {
    const err = await readOnly.createIssue({ projectId: projectId(), title: "no" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecordsApiError);
    expect(err).toMatchObject({ status: 403, code: "forbidden" });
    await expect(client.getIssue(crypto.randomUUID())).rejects.toMatchObject({ status: 404, code: "not_found" });
    const bad = (await client.createIssue({ projectId: projectId(), title: "" }).catch((e: unknown) => e)) as RecordsApiError;
    expect(bad.problem?.issues?.[0]?.path).toBe("title");
  });
});
