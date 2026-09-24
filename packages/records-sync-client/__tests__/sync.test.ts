import type { Comment, Issue, Project } from "@records/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApprovalResolvedEvent, RejectedEvent } from "../src/client.js";
import { isProvisionalIssue } from "../src/mutators/projects.js";
import { FakeServer } from "./fake-server.js";
import { converge, makeClient, settle, type TestClient } from "./helpers.js";

let server: FakeServer;
let project: Project;
let alice: ReturnType<FakeServer["addPrincipal"]>;
let bob: ReturnType<FakeServer["addPrincipal"]>;
const open: TestClient[] = [];

function client(p = alice, opts: Parameters<typeof makeClient>[2] = {}, flags: Parameters<typeof makeClient>[3] = {}): TestClient {
  const c = makeClient(server, p, opts, flags);
  open.push(c);
  return c;
}

function seedIssue(title = "Seeded"): Issue {
  server.runCommand(alice, "projects.createIssue", { projectId: project.id, title });
  return server.values<Issue>("issue/").find((i) => i.title === title)!;
}

beforeEach(() => {
  server = new FakeServer();
  project = server.addProject("ENG");
  alice = server.addPrincipal("Alice");
  bob = server.addPrincipal("Bob");
});

afterEach(() => {
  for (const c of open.splice(0)) c.client.close();
  vi.useRealTimers();
});

describe("(g) optimistic create", () => {
  it("shows a placeholder key at once and keeps its id once confirmed", async () => {
    const a = client();
    await a.client.start();
    const handle = a.client.mutate.projects.createIssue({ projectId: project.id, title: "  Fix login  " });
    const id = handle.args.id;

    const guess = a.client.get<Issue>(`issue/${id}`)!;
    expect(guess).toMatchObject({ id, key: "ENG-?", number: 0, title: "Fix login", state: "backlog", priority: "none", revision: 1 });
    expect(guess.createdBy).toEqual(alice);
    expect(isProvisionalIssue(guess)).toBe(true);
    expect(a.client.hasUnsyncedChanges).toBe(true);

    // A follow-up edit made against the provisional issue.
    a.client.mutate.projects.editIssue({ issueId: id, expectedRevision: guess.revision, patch: { priority: "high" } });
    expect(a.client.get<Issue>(`issue/${id}`)).toMatchObject({ priority: "high", revision: 2 });

    await a.client.flush();
    expect(await handle.result).toEqual({ status: "confirmed" });
    const confirmed = a.client.get<Issue>(`issue/${id}`)!;
    expect(confirmed).toMatchObject({ id, key: "ENG-1", number: 1, priority: "high", revision: 2 });
    expect(confirmed).toEqual(server.get(`issue/${id}`));
    expect(a.client.hasUnsyncedChanges).toBe(false);
    expect(a.client.pending()).toEqual([]);
  });

  it("comments keep their client id too", async () => {
    const issue = seedIssue();
    const a = client();
    await a.client.start();
    const h = a.client.mutate.projects.addComment({ issueId: issue.id, body: "Looks good" });
    expect(a.client.get<Comment>(`comment/${h.args.id}`)).toMatchObject({ body: "Looks good", author: alice });
    await a.client.flush();
    expect(server.get<Comment>(`comment/${h.args.id}`)).toMatchObject({ id: h.args.id, body: "Looks good" });
    expect(a.client.store.snapshot()).toEqual(server.snapshot());
  });
});

describe("(a) two clients edit the same issue (§11.3)", () => {
  it("both see their own edit at once; the loser gets a conflict and ends at server state", async () => {
    const issue = seedIssue();
    const a = client(alice);
    const b = client(bob);
    await Promise.all([a.client.start(), b.client.start()]);

    const rejections: RejectedEvent[] = [];
    b.client.on("rejected", (e) => rejections.push(e));
    const bChanges: string[][] = [];
    b.client.subscribe((c) => bChanges.push(c.changedKeys));

    a.client.mutate.projects.editIssue({ issueId: issue.id, expectedRevision: 1, patch: { title: "Alice's title" } });
    const bh = b.client.mutate.projects.editIssue({ issueId: issue.id, expectedRevision: 1, patch: { title: "Bob's title" } });
    expect(a.client.get<Issue>(`issue/${issue.id}`)!.title).toBe("Alice's title");
    expect(b.client.get<Issue>(`issue/${issue.id}`)!.title).toBe("Bob's title");

    await a.client.flush();
    await b.client.flush();
    await settle();

    expect(await bh.result).toMatchObject({ status: "conflict", code: "revision_conflict", currentRevision: 2 });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ status: "conflict", code: "revision_conflict", currentRevision: 2, source: "push", label: expect.stringContaining("ENG-1") });
    for (const c of [a, b]) {
      await converge(c, server);
      expect(c.client.get<Issue>(`issue/${issue.id}`)).toEqual(server.get(`issue/${issue.id}`));
      expect(c.client.get<Issue>(`issue/${issue.id}`)!.title).toBe("Alice's title");
    }
    expect(bChanges.flat()).toContain(`issue/${issue.id}`);
  });

  it("the loser's guess gives way as soon as a pull brings the winner's version", async () => {
    const issue = seedIssue();
    const a = client(alice);
    const b = client(bob, { pushDelayMs: 60_000 }); // B's push waits
    await Promise.all([a.client.start(), b.client.start()]);
    b.dropPokes.value = true;

    b.client.mutate.projects.transitionIssue({ issueId: issue.id, expectedRevision: 1, toState: "todo" });
    expect(b.client.get<Issue>(`issue/${issue.id}`)!.state).toBe("todo");

    a.client.mutate.projects.editIssue({ issueId: issue.id, expectedRevision: 1, patch: { title: "Renamed" } });
    await a.client.flush();

    await b.client.pull();
    // The pending transition no longer applies locally: server version shows, flagged likely to fail.
    expect(b.client.get<Issue>(`issue/${issue.id}`)).toEqual(server.get(`issue/${issue.id}`));
    expect(b.client.pending()[0]!.likelyToFail).toMatchObject({ code: "revision_conflict", currentRevision: 2 });
    expect(b.client.hasUnsyncedChanges).toBe(true);

    await b.client.flush(); // still pushed: the server decides
    expect(b.client.pending()).toEqual([]);
    expect(server.get<Issue>(`issue/${issue.id}`)!.state).toBe("backlog");
  });

  it("a disallowed transition is predicted as a workflow conflict and confirmed by the server", async () => {
    const issue = seedIssue();
    const a = client();
    await a.client.start();
    const events: RejectedEvent[] = [];
    a.client.on("rejected", (e) => events.push(e));
    const h = a.client.mutate.projects.transitionIssue({ issueId: issue.id, expectedRevision: 1, toState: "done" });
    expect(h.likelyToFail?.code).toBe("workflow_conflict");
    expect(a.client.get<Issue>(`issue/${issue.id}`)!.state).toBe("backlog");
    await a.client.flush();
    expect(await h.result).toMatchObject({ status: "conflict", code: "workflow_conflict" });
    expect(events[0]).toMatchObject({ code: "workflow_conflict" });
  });
});

describe("(c) dropped pokes", () => {
  it("the safety pull converges", async () => {
    vi.useFakeTimers();
    const a = client(alice);
    const b = client(bob, { safetyPullIntervalMs: 30_000 });
    await a.client.start();
    await b.client.start();
    b.dropPokes.value = true;

    const h = a.client.mutate.projects.createIssue({ projectId: project.id, title: "Seen late" });
    await a.client.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(b.client.get(`issue/${h.args.id}`)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(b.client.get(`issue/${h.args.id}`)).toEqual(server.get(`issue/${h.args.id}`));
    expect(b.client.cookie).toBe(server.seq);
  });

  it("a delivered poke triggers a pull only when the head is newer", async () => {
    const a = client(alice);
    const b = client(bob);
    await a.client.start();
    await b.client.start();
    const before = b.transport.pulls;
    b.client.poke(b.client.cookie!);
    await settle();
    expect(b.transport.pulls).toBe(before);

    const h = a.client.mutate.projects.createIssue({ projectId: project.id, title: "Poked" });
    await a.client.flush();
    await settle();
    expect(b.transport.pulls).toBeGreaterThan(before);
    expect(b.client.get(`issue/${h.args.id}`)).toEqual(server.get(`issue/${h.args.id}`));
  });
});

describe("(d) out-of-order pull responses", () => {
  it("a response older than the current cookie is ignored", async () => {
    const a = client();
    await a.client.start();
    const staleResponse = a.transport.pullResponses[0]!;

    const h = a.client.mutate.projects.createIssue({ projectId: project.id, title: "Newer" });
    await a.client.flush();
    const cookie = a.client.cookie!;
    expect(cookie).toBeGreaterThan(staleResponse.cookie);
    const view = a.client.store.snapshot();

    let notified = 0;
    a.client.subscribe(() => notified++);
    a.transport.cannedPulls.push(staleResponse); // e.g. a lagging replica or a delayed duplicate
    await a.client.pull();
    expect(a.client.cookie).toBe(cookie);
    expect(a.client.store.snapshot()).toEqual(view);
    expect(a.client.get(`issue/${h.args.id}`)).toBeDefined();
    expect(notified).toBe(0);
  });

  it("an older response does not resurrect a dropped guess or un-confirm a mutation", async () => {
    const issue = seedIssue();
    const a = client();
    await a.client.start();
    a.client.mutate.projects.editIssue({ issueId: issue.id, expectedRevision: 1, patch: { title: "Edited" } });
    await a.client.flush();
    const old = { cookie: 0, lastMutationIdChanges: {}, patch: [{ op: "clear" as const }] };
    a.transport.cannedPulls.push(old);
    await a.client.pull();
    expect(a.client.get<Issue>(`issue/${issue.id}`)!.title).toBe("Edited");
    expect(a.client.pending()).toEqual([]);
  });
});

describe("(e) push failure and retry", () => {
  it("a lost push response followed by a retry does not duplicate the change", async () => {
    const a = client();
    await a.client.start();
    a.dropPokes.value = true;
    a.transport.pushFailures.push("network-after"); // server commits, the response is lost

    const h = a.client.mutate.projects.createIssue({ projectId: project.id, title: "Exactly once" });
    await a.client.flush();
    expect(a.client.status().lastError?.kind).toBe("network");
    expect(server.values<Issue>("issue/")).toHaveLength(1);
    expect(a.client.hasUnsyncedChanges).toBe(true);

    await settle(20); // backoff retry fires by itself
    await a.client.sync();
    expect(server.values<Issue>("issue/")).toHaveLength(1);
    expect(server.pushLog.map((p) => p.mutations.map((m) => m.id))).toEqual([[1], [1]]);
    expect(await h.result).toEqual({ status: "processed" });
    expect(a.client.get<Issue>(`issue/${h.args.id}`)).toMatchObject({ key: "ENG-1" });
    expect(a.client.hasUnsyncedChanges).toBe(false);
  });

  it("5xx and network failures retry with backoff and keep order", async () => {
    const issue = seedIssue();
    const a = client();
    await a.client.start();
    a.transport.pushFailures.push("500", "network-before", "500");
    a.client.mutate.projects.transitionIssue({ issueId: issue.id, expectedRevision: 1, toState: "todo" });
    a.client.mutate.projects.transitionIssue({ issueId: issue.id, expectedRevision: 2, toState: "in_progress" });
    a.client.mutate.projects.transitionIssue({ issueId: issue.id, expectedRevision: 3, toState: "done" });
    for (let i = 0; i < 50 && a.client.hasUnsyncedChanges; i++) await settle(5);
    await converge(a, server);
    expect(server.get<Issue>(`issue/${issue.id}`)).toMatchObject({ state: "done", revision: 4 });
    const ids = server.pushLog.flatMap((p) => p.mutations.map((m) => m.id));
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
  });

  it("an auth failure blocks pushes until the next mutation or retry()", async () => {
    const a = client();
    await a.client.start();
    a.transport.pushFailures.push("401");
    a.client.mutate.projects.createIssue({ projectId: project.id, title: "Blocked" });
    await a.client.flush();
    expect(a.client.status()).toMatchObject({ blocked: true, unsynced: 1 });
    await settle(20);
    expect(a.transport.pushes).toBe(1);
    await a.client.retry();
    expect(a.client.status()).toMatchObject({ blocked: false, unsynced: 0 });
    expect(server.values<Issue>("issue/")).toHaveLength(1);
  });
});

describe("(f) approvals", () => {
  it("a pending mutation shows as awaiting, then arrives by pull once approved", async () => {
    server.needsApproval = (m) => m.name === "projects.createIssue";
    const a = client();
    await a.client.start();
    const resolved: ApprovalResolvedEvent[] = [];
    a.client.on("approval", (e) => resolved.push(e));

    const h = a.client.mutate.projects.createIssue({ projectId: project.id, title: "Needs sign-off" });
    expect(a.client.get(`issue/${h.args.id}`)).toBeDefined();
    await a.client.flush();

    expect(await h.result).toMatchObject({ status: "pending", actionId: 1 });
    expect(a.client.get(`issue/${h.args.id}`)).toBeUndefined(); // no longer a local guess
    expect(a.client.awaitingApproval).toMatchObject([{ mutationId: h.id, actionId: 1, label: "Create “Needs sign-off”" }]);
    expect(a.client.hasUnsyncedChanges).toBe(false); // the server holds it

    server.approve(1); // pokes the client
    await settle();
    expect(a.client.get<Issue>(`issue/${h.args.id}`)).toMatchObject({ id: h.args.id, key: "ENG-1" });
    expect(a.client.awaitingApproval).toEqual([]);
    expect(resolved).toMatchObject([{ resolution: "applied" }]);
  });

  it("a rejected approval disappears with a message", async () => {
    server.needsApproval = () => true;
    const issue = seedIssue();
    const a = client();
    await a.client.start();
    const rejected: RejectedEvent[] = [];
    a.client.on("rejected", (e) => rejected.push(e));

    a.client.mutate.projects.editIssue({ issueId: issue.id, expectedRevision: 1, patch: { title: "Unwelcome" } });
    await a.client.flush();
    expect(a.client.awaitingApproval).toHaveLength(1);

    server.reject(1, "Not this sprint.");
    await a.client.checkApprovals();
    expect(a.client.awaitingApproval).toEqual([]);
    expect(rejected).toMatchObject([{ status: "rejected", code: "approval_rejected", message: "Not this sprint.", source: "approval" }]);
    expect(a.client.get<Issue>(`issue/${issue.id}`)!.title).toBe("Seeded");
  });

  it("approval polling retires an approved edit after the next pull", async () => {
    server.needsApproval = () => true;
    const issue = seedIssue();
    const a = client(alice, { approvalCheckIntervalMs: 5 });
    await a.client.start();
    a.dropPokes.value = true;
    a.client.mutate.projects.editIssue({ issueId: issue.id, expectedRevision: 1, patch: { priority: "urgent" } });
    await a.client.flush();
    server.approve(1);
    for (let i = 0; i < 40 && a.client.awaitingApproval.length; i++) await settle(5);
    expect(a.client.awaitingApproval).toEqual([]);
    expect(a.client.get<Issue>(`issue/${issue.id}`)!.priority).toBe("urgent");
  });

  it("awaiting entries time out or can be dismissed", async () => {
    vi.useFakeTimers();
    server.needsApproval = () => true;
    const issue = seedIssue();
    // A transport without approvals(): only pulls, timeout and dismissal retire entries.
    const a = client(alice, { approvalTimeoutMs: 60_000 }, { approvals: false });
    await a.client.start();
    const resolved: ApprovalResolvedEvent[] = [];
    a.client.on("approval", (e) => resolved.push(e));
    a.client.mutate.projects.addComment({ issueId: issue.id, body: "one" });
    a.client.mutate.projects.addComment({ issueId: issue.id, body: "two" });
    await a.client.flush();
    expect(a.client.awaitingApproval).toHaveLength(2);
    a.client.dismissApproval(a.client.awaitingApproval[0]!.mutationId);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(a.client.awaitingApproval).toEqual([]);
    expect(resolved.map((r) => r.resolution)).toEqual(["dismissed", "timeout"]);
  });
});

describe("rejections and bookkeeping", () => {
  it("a rejected mutation is dropped with a message and later mutations still apply", async () => {
    const issue = seedIssue();
    const a = client();
    await a.client.start();
    const events: RejectedEvent[] = [];
    a.client.on("rejected", (e) => events.push(e));
    const bad = a.client.mutate.projects.createIssue({ projectId: "99999999-9999-4999-8999-999999999999", title: "Orphan" });
    expect(bad.likelyToFail?.code).toBe("not_found");
    a.client.mutate.projects.addComment({ issueId: issue.id, body: "fine" });
    await converge(a, server);
    expect(await bad.result).toMatchObject({ status: "rejected", code: "not_found" });
    expect(events).toMatchObject([{ code: "not_found", source: "push" }]);
    expect(a.client.store.snapshot()).toEqual(server.snapshot());
  });

  it("subscribers are notified once per batch", async () => {
    const a = client();
    await a.client.start();
    a.dropPokes.value = true;
    const b = client(bob);
    await b.client.start();
    for (let i = 0; i < 5; i++) b.client.mutate.projects.createIssue({ projectId: project.id, title: `I${i}` });
    await b.client.flush();
    let calls = 0;
    let keys = 0;
    a.client.subscribe((c) => {
      calls++;
      keys += c.changedKeys.length;
    });
    await a.client.pull();
    expect(calls).toBe(1);
    expect(keys).toBe(5);
  });
});
