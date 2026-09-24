// Sync push and pull against real Postgres, then the real @records/sync-client driving them.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CallerContext, Issue, PatchOp, PrincipalRef, PullResponse, PushRequest } from "@records/contracts";

import { SyncClient, type SyncTransport } from "../../records-sync-client/src/index.ts";
import { syncIdempotencyKey, type SyncGate } from "../src/index.js";
import { code, createWorld, type World } from "./world.js";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => w?.close());

let n = 0;
const id = (label: string) => `${label}${(n++).toString().padStart(8, "0")}`;
const head = async (ds: string) => (await w.service.journal.changes(w.olive.caller, ds, {})).head;

/** Apply a patch to a key/value state, as the client's store does. */
function apply(state: Map<string, unknown>, patch: PatchOp[]): Map<string, unknown> {
  const next = new Map(state);
  for (const op of patch) {
    if (op.op === "clear") next.clear();
    else if (op.op === "put") next.set(op.key, JSON.parse(JSON.stringify(op.value)));
    else next.delete(op.key);
  }
  return next;
}
const sorted = (m: Map<string, unknown>) => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : 1)));

describe("push", () => {
  it("applies in order with client-chosen ids, advancing lastMutationId with the command", async () => {
    const group = id("group");
    const client = id("client");
    const issueId = crypto.randomUUID();
    const before = await head(w.ds1);
    const res = await w.service.sync.push(w.ed.caller, w.ds1, {
      clientGroupId: group, clientId: client, mutations: [
        { id: 1, name: "projects.createIssue", args: { id: issueId, projectId: w.eng, title: "Synced" } },
        { id: 2, name: "projects.editIssue", args: { issueId, expectedRevision: 1, patch: { title: "Synced!" } } },
      ],
    });
    expect(res).toEqual({ outcomes: [{ id: 1, status: "applied", seq: before + 1 }, { id: 2, status: "applied", seq: before + 2 }], head: before + 2 });
    const [row] = await w.owner`SELECT last_mutation_id, principal_id FROM records.client_mutations WHERE client_id = ${client}`;
    expect(row).toEqual({ last_mutation_id: "2", principal_id: w.ed.id });
    const [j] = await w.owner`SELECT via, command FROM records.journal WHERE datastore_id = ${w.ds1} AND seq = ${before + 1}`;
    expect(j).toEqual({ via: "sync", command: "projects.createIssue" });
    // The command's own idempotency record uses the derived key.
    const [k] = await w.owner`SELECT 1 AS ok FROM records.idempotency_keys WHERE key = ${syncIdempotencyKey(client, 1)} AND operation = 'createIssue'`;
    expect(k).toEqual({ ok: 1 });
  });

  it("rejections and conflicts count as processed; gaps are accepted; replays return the saved outcome", async () => {
    const group = id("group");
    const client = id("client");
    const { record } = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Target" }, id("key"));
    const req: PushRequest = {
      clientGroupId: group, clientId: client, mutations: [
        { id: 3, name: "projects.createIssue", args: { projectId: w.eng, title: "" } },
        { id: 7, name: "projects.editIssue", args: { issueId: record.id, expectedRevision: 1, patch: { title: "ok" } } },
        { id: 8, name: "projects.editIssue", args: { issueId: record.id, expectedRevision: 1, patch: { title: "stale" } } },
        { id: 12, name: "projects.transitionIssue", args: { issueId: record.id, expectedRevision: 2, toState: "done" } },
      ],
    };
    const first = await w.service.sync.push(w.ed.caller, w.ds1, req);
    expect(first.outcomes).toEqual([
      { id: 3, status: "rejected", code: "validation_failed", message: expect.any(String) },
      { id: 7, status: "applied", seq: expect.any(Number) },
      { id: 8, status: "conflict", code: "revision_conflict", message: expect.any(String), currentRevision: 2 },
      { id: 12, status: "conflict", code: "workflow_conflict", message: expect.any(String) },
    ]);
    const [row] = await w.owner`SELECT last_mutation_id FROM records.client_mutations WHERE client_id = ${client}`;
    expect(row!.last_mutation_id).toBe("12");

    // A lost response: the same batch again changes nothing and reports what happened.
    const headBefore = await head(w.ds1);
    const again = await w.service.sync.push(w.ed.caller, w.ds1, req);
    expect(again).toEqual({ outcomes: first.outcomes, head: headBefore });

    // Once the saved outcome is gone (retention), a replay is a bare `skipped`.
    await w.owner`DELETE FROM records.idempotency_keys WHERE operation = 'sync.push' AND key = ${`${group}:${client}:7`}`;
    expect((await w.service.sync.push(w.ed.caller, w.ds1, req)).outcomes[1]).toEqual({ id: 7, status: "skipped" });

    // Out-of-order ids in one batch: the lower one is already covered.
    const mixed = await w.service.sync.push(w.ed.caller, w.ds1, { clientGroupId: group, clientId: client, mutations: [
      { id: 20, name: "projects.addComment", args: { issueId: record.id, body: "twenty" } },
      { id: 15, name: "projects.addComment", args: { issueId: record.id, body: "fifteen" } },
    ] });
    expect(mixed.outcomes.map((o) => o.status)).toEqual(["applied", "skipped"]);
  });

  it("a reader's writes are rejected but processed; non-members cannot push at all", async () => {
    const res = await w.service.sync.push(w.rae.caller, w.ds1, { clientGroupId: id("group"), clientId: id("client"), mutations: [
      { id: 1, name: "projects.createIssue", args: { projectId: w.eng, title: "no" } },
    ] });
    expect(res.outcomes).toEqual([{ id: 1, status: "rejected", code: "forbidden", message: expect.any(String) }]);
    expect(await code(w.service.sync.push(w.nia.caller, w.ds1, { clientGroupId: id("group"), clientId: id("client"), mutations: [
      { id: 1, name: "projects.createIssue", args: { projectId: w.eng, title: "no" } },
    ] }))).toBe("not_found");
  });

  it("refuses a client ID owned by another principal, and malformed envelopes", async () => {
    const group = id("group");
    const client = id("client");
    const m = [{ id: 1, name: "projects.addComment" as const, args: { issueId: crypto.randomUUID(), body: "x" } }];
    await w.service.sync.push(w.ed.caller, w.ds1, { clientGroupId: group, clientId: client, mutations: m });
    expect(await code(w.service.sync.push(w.olive.caller, w.ds1, { clientGroupId: group, clientId: client, mutations: m }))).toBe("forbidden");
    expect(await code(w.service.sync.push(w.ed.caller, w.ds1, { clientGroupId: "short", clientId: client, mutations: m }))).toBe("validation_failed");
    expect(await code(w.service.sync.push(w.ed.caller, w.ds1, { clientGroupId: group, clientId: client, mutations: [{ id: 2, name: "projects.dropTable", args: {} }] }))).toBe("validation_failed");
  });

  it("an approval gate can send a mutation to approval: pending, processed, nothing journaled", async () => {
    const group = id("group");
    const client = id("client");
    let action = 40;
    const seen: string[] = [];
    const gate: SyncGate = async (m, info) => {
      seen.push(info.idempotencyKey);
      return m.name === "projects.createIssue" ? { kind: "settled", outcome: { status: "pending", actionId: ++action } } : { kind: "execute" };
    };
    const { record } = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Gate" }, id("key"));
    const before = await head(w.ds1);
    const req: PushRequest = { clientGroupId: group, clientId: client, mutations: [
      { id: 1, name: "projects.createIssue", args: { projectId: w.eng, title: "Needs approval" } },
      { id: 2, name: "projects.addComment", args: { issueId: record.id, body: "straight through" } },
    ] };
    const res = await w.service.sync.push(w.ed.caller, w.ds1, req, { gate });
    expect(res).toEqual({ outcomes: [{ id: 1, status: "pending", actionId: 41 }, { id: 2, status: "applied", seq: before + 1 }], head: before + 1 });
    expect(seen).toEqual([`sync:${client}:1`, `sync:${client}:2`]);
    // The replay returns the saved pending outcome with its actionId, and the gate is not asked again.
    const again = await w.service.sync.push(w.ed.caller, w.ds1, req, { gate });
    expect(again.outcomes).toEqual(res.outcomes);
    expect(seen).toHaveLength(2);
  });

  it("overlapping pushes of the same batch process each id once", async () => {
    const req: PushRequest = { clientGroupId: id("group"), clientId: id("client"), mutations: [1, 2, 3].map((i) => (
      { id: i, name: "projects.createIssue" as const, args: { id: crypto.randomUUID(), projectId: w.eng, title: `race ${i}` } })) };
    const before = await head(w.ds1);
    const [a, b] = await Promise.all([w.service.sync.push(w.ed.caller, w.ds1, req), w.service.sync.push(w.ed.caller, w.ds1, req)]);
    expect(await head(w.ds1)).toBe(before + 3);
    for (const i of [0, 1, 2]) {
      expect(a.outcomes[i]).toEqual(b.outcomes[i]);
      expect(a.outcomes[i]!.status).toBe("applied");
    }
  });

  it("stops at the time budget and reports the prefix it handled", async () => {
    let t = 0;
    const res = await w.service.sync.push(w.ed.caller, w.ds1, { clientGroupId: id("group"), clientId: id("client"), mutations: [
      { id: 1, name: "projects.createIssue", args: { projectId: w.eng, title: "one" } },
      { id: 2, name: "projects.createIssue", args: { projectId: w.eng, title: "two" } },
    ] }, { budgetMs: 10, now: () => (t += 100) });
    expect(res.outcomes.map((o) => o.id)).toEqual([1]);
  });
});

describe("pull", () => {
  it("a null cookie gets clear, the workflow and full visible state; lastMutationIds for the group", async () => {
    const group = id("group");
    const [c1, c2] = [id("client"), id("client")];
    const m = (issueId: string) => [{ id: 1, name: "projects.addComment" as const, args: { issueId, body: "hi" } }];
    const { record } = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Pulled" }, id("key"));
    await w.service.sync.push(w.ed.caller, w.ds1, { clientGroupId: group, clientId: c1, mutations: m(record.id) });
    await w.service.sync.push(w.ed.caller, w.ds1, { clientGroupId: group, clientId: c2, mutations: [{ ...m(record.id)[0]!, id: 4 }] });
    const res = await w.service.sync.pull(w.ed.caller, w.ds1, { clientGroupId: group, cookie: null });
    expect(res.cookie).toBe(await head(w.ds1));
    expect(res.patch[0]).toEqual({ op: "clear" });
    expect(res.patch[1]).toEqual({ op: "put", key: "meta/workflow", value: await w.service.projects.getWorkflow(w.ed.caller, w.ds1) });
    expect(res.lastMutationIdChanges).toEqual({ [c1]: 1, [c2]: 4 });
    const state = apply(new Map(), res.patch);
    // Values are exactly the native DTOs.
    expect(state.get(`issue/${record.id}`)).toEqual(JSON.parse(JSON.stringify(await w.service.projects.getIssue(w.ed.caller, w.ds1, record.id))));
    expect(state.get(`project/${w.eng}`)).toEqual(JSON.parse(JSON.stringify((await w.service.projects.listProjects(w.ed.caller, w.ds1))[0])));
    const comments = (await w.service.projects.listComments(w.ed.caller, w.ds1, { issueId: record.id })).items;
    for (const c of comments) expect(state.get(`comment/${c.id}`)).toEqual(JSON.parse(JSON.stringify(c)));
    // Another principal sees none of Ed's clients, even with the group id; a trusted adapter can ask for them.
    expect((await w.service.sync.pull(w.olive.caller, w.ds1, { clientGroupId: group, cookie: res.cookie })).lastMutationIdChanges).toEqual({});
    expect((await w.service.sync.pull(w.olive.caller, w.ds1, { clientGroupId: group, cookie: res.cookie }, { clientsOf: w.ed.id })).lastMutationIdChanges).toEqual({ [c1]: 1, [c2]: 4 });
    expect((await w.service.sync.pull(w.ed.caller, w.ds1, { clientGroupId: group, cookie: res.cookie }, { clientsOf: null })).lastMutationIdChanges).toEqual({});
  });

  it("a delta is the coalesced current value of each touched key; gone entities are deleted", async () => {
    const start = await w.service.sync.pull(w.olive.caller, w.ds1, { clientGroupId: id("group"), cookie: null });
    const { record } = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Delta" }, id("key"));
    await w.service.projects.editIssue(w.ed.caller, w.ds1, { issueId: record.id, expectedRevision: 1, patch: { title: "Delta 2" } }, id("key"));
    const { record: comment } = await w.service.projects.addComment(w.ed.caller, w.ds1, { issueId: record.id, body: "gone soon" }, id("key"));
    await w.owner`DELETE FROM projects.comments WHERE id = ${comment.id}`; // stands in for a purge or loss of visibility
    const res = await w.service.sync.pull(w.olive.caller, w.ds1, { clientGroupId: id("group"), cookie: start.cookie });
    expect(res.patch.map((p) => [p.op, "key" in p ? p.key : null])).toEqual([
      ["put", "meta/workflow"], ["put", `issue/${record.id}`], ["del", `comment/${comment.id}`],
    ]);
    expect((res.patch[1] as { value: Issue }).value).toMatchObject({ title: "Delta 2", revision: 2 });
    // Nothing new: only the workflow.
    const idle = await w.service.sync.pull(w.olive.caller, w.ds1, { clientGroupId: id("group"), cookie: res.cookie });
    expect(idle.patch).toEqual([{ op: "put", key: "meta/workflow", value: expect.any(Object) }]);
    expect(idle.cookie).toBe(res.cookie);
  });

  it("a cookie ahead of the head, or older than retention, gets full state; readers can pull", async () => {
    const h = await head(w.ds2);
    const ahead = await w.service.sync.pull(w.ed.caller, w.ds2, { clientGroupId: id("group"), cookie: h + 5 });
    expect(ahead.patch[0]).toEqual({ op: "clear" });
    await w.service.projects.createIssue(w.ed.caller, w.ds2, { projectId: w.ops, title: "Before purge" }, id("key"));
    await w.owner`DELETE FROM records.journal WHERE datastore_id = ${w.ds2} AND seq <= 1`;
    const purged = await w.service.sync.pull(w.ed.caller, w.ds2, { clientGroupId: id("group"), cookie: 0 });
    expect(purged.patch[0]).toEqual({ op: "clear" });
    expect(purged.patch.some((p) => p.op === "put" && p.key === `project/${w.ops}`)).toBe(true);
    const fine = await w.service.sync.pull(w.ed.caller, w.ds2, { clientGroupId: id("group"), cookie: 1 });
    expect(fine.patch[0]).not.toEqual({ op: "clear" });
    expect((await w.service.sync.pull(w.rae.caller, w.ds1, { clientGroupId: id("group"), cookie: null })).patch.length).toBeGreaterThan(2);
    expect(await code(w.service.sync.pull(w.nia.caller, w.ds1, { clientGroupId: id("group"), cookie: null }))).toBe("not_found");
  });

  it("converges from every cookie: state(c) + pull(c) equals pull(null)", async () => {
    const group = id("group");
    const snapshots: { cookie: number; state: Map<string, unknown> }[] = [];
    const snap = async () => {
      const r = await w.service.sync.pull(w.olive.caller, w.ds1, { clientGroupId: group, cookie: null });
      snapshots.push({ cookie: r.cookie, state: apply(new Map(), r.patch) });
    };
    await snap();
    const { record } = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Every cookie" }, id("key"));
    await snap();
    await w.service.projects.transitionIssue(w.ed.caller, w.ds1, { issueId: record.id, expectedRevision: 1, toState: "todo" }, id("key"));
    await snap();
    await w.service.projects.addComment(w.olive.caller, w.ds1, { issueId: record.id, body: "c" }, id("key"));
    await w.service.projects.editIssue(w.ed.caller, w.ds1, { issueId: record.id, expectedRevision: 2, patch: { priority: "urgent" } }, id("key"));
    await snap();
    const final = snapshots.at(-1)!;
    for (const s of snapshots) {
      const res: PullResponse = await w.service.sync.pull(w.olive.caller, w.ds1, { clientGroupId: group, cookie: s.cookie });
      expect(res.cookie).toBe(final.cookie);
      expect(sorted(apply(s.state, res.patch))).toEqual(sorted(final.state));
    }
  });
});

describe("the real SyncClient against push and pull", () => {
  const principal = (p: { id: string }, name: string): PrincipalRef => ({ id: p.id, displayName: name, kind: "human" });
  const pokes = new Set<(head: number) => void>();

  function transport(caller: CallerContext, ds: string, flags: { loseNextPushResponse?: boolean } = {}): SyncTransport {
    return {
      async push(req) {
        const res = await w.service.sync.push(caller, ds, JSON.parse(JSON.stringify(req)));
        for (const p of pokes) queueMicrotask(() => p(res.head));
        if (flags.loseNextPushResponse) {
          flags.loseNextPushResponse = false;
          throw Object.assign(new Error("connection reset"), { kind: "network" });
        }
        return JSON.parse(JSON.stringify(res));
      },
      async pull(req) {
        return JSON.parse(JSON.stringify(await w.service.sync.pull(caller, ds, JSON.parse(JSON.stringify(req)))));
      },
    };
  }

  function make(caller: CallerContext, who: PrincipalRef, t: SyncTransport) {
    return new SyncClient({
      transport: t, principal: who, pushDelayMs: 0, safetyPullIntervalMs: 0, retryBaseMs: 1, retryMaxMs: 4,
      onPoke: (handler) => {
        pokes.add(handler);
        return () => pokes.delete(handler);
      },
    });
  }

  async function converge(c: SyncClient) {
    const target = await head(w.ds1);
    for (let i = 0; i < 20; i++) {
      await c.sync();
      if (!c.hasUnsyncedChanges && c.pending().length === 0 && c.cookie === target) return;
    }
    throw new Error("did not converge");
  }

  async function serverState(): Promise<Record<string, unknown>> {
    return sorted(apply(new Map(), (await w.service.sync.pull(w.olive.caller, w.ds1, { clientGroupId: id("group"), cookie: null })).patch));
  }

  const view = (c: SyncClient) => sorted(new Map(["meta/", "project/", "issue/", "comment/"].flatMap((p) => c.scan(p))));

  it("two clients edit the same issue: the loser gets a conflict and both converge to the server", async () => {
    const ed = make(w.ed.caller, principal(w.ed, "Ed"), transport(w.ed.caller, w.ds1));
    const olive = make(w.olive.caller, principal(w.olive, "Olive"), transport(w.olive.caller, w.ds1));
    await Promise.all([ed.start(), olive.start()]);

    const created = ed.mutate.projects.createIssue({ projectId: w.eng, title: "Shared" });
    const issueId = (created.args as { id: string }).id;
    expect(ed.get<Issue>(`issue/${issueId}`)).toMatchObject({ title: "Shared", number: 0 });
    await ed.flush();
    await converge(ed);
    expect(await created.result).toEqual({ status: "confirmed" });
    expect(ed.get<Issue>(`issue/${issueId}`)!.number).toBeGreaterThan(0);
    await converge(olive);
    expect(olive.get<Issue>(`issue/${issueId}`)).toEqual(ed.get(`issue/${issueId}`));

    const rejected: unknown[] = [];
    for (const c of [ed, olive]) c.on("rejected", (e) => rejected.push(e));
    const edEdit = ed.mutate.projects.editIssue({ issueId, expectedRevision: 1, patch: { title: "Ed's title" } });
    const oliveEdit = olive.mutate.projects.editIssue({ issueId, expectedRevision: 1, patch: { title: "Olive's title" } });
    expect(ed.get<Issue>(`issue/${issueId}`)!.title).toBe("Ed's title");
    expect(olive.get<Issue>(`issue/${issueId}`)!.title).toBe("Olive's title");
    await Promise.all([ed.flush(), olive.flush()]);
    await converge(ed);
    await converge(olive);
    // Whichever push reached the server first wins; the other is a conflict at revision 2.
    const results = [await edEdit.result, await oliveEdit.result];
    const winner = results[0]!.status === "confirmed" ? "Ed's title" : "Olive's title";
    expect(results.map((r) => r.status).toSorted()).toEqual(["confirmed", "conflict"]);
    expect(results.find((r) => r.status === "conflict")).toMatchObject({ code: "revision_conflict", currentRevision: 2 });
    expect(rejected).toHaveLength(1);

    const truth = await serverState();
    expect(view(ed)).toEqual(truth);
    expect(view(olive)).toEqual(truth);
    expect(olive.get<Issue>(`issue/${issueId}`)!.title).toBe(winner);
    expect(ed.get<Issue>(`issue/${issueId}`)!.title).toBe(winner);
    ed.close();
    olive.close();
  });

  it("a lost push response is retried: the replayed ids are not applied twice", async () => {
    const flags = { loseNextPushResponse: true };
    const ed = make(w.ed.caller, principal(w.ed, "Ed"), transport(w.ed.caller, w.ds1, flags));
    await ed.start();
    const before = await head(w.ds1);
    const h = ed.mutate.projects.createIssue({ projectId: w.eng, title: "Exactly once" });
    const issueId = (h.args as { id: string }).id;
    await ed.flush();
    await converge(ed);
    expect(["confirmed", "processed"]).toContain((await h.result).status);
    expect(await head(w.ds1)).toBe(before + 1);
    const [row] = await w.owner`SELECT count(*)::int AS n FROM projects.issues WHERE id = ${issueId}`;
    expect(row!.n).toBe(1);
    expect(view(ed)).toEqual(await serverState());
    ed.close();
  });

  it("a rejected mutation is dropped and the view shows the server's version", async () => {
    const rae = make(w.rae.caller, principal(w.rae, "Rae"), transport(w.rae.caller, w.ds1));
    await rae.start();
    const h = rae.mutate.projects.createIssue({ projectId: w.eng, title: "Reader tries" });
    await rae.flush();
    expect(await h.result).toMatchObject({ status: "rejected", code: "forbidden" });
    await converge(rae);
    expect(rae.get(`issue/${(h.args as { id: string }).id}`)).toBeUndefined();
    expect(view(rae)).toEqual(await serverState());
    rae.close();
  });
});
