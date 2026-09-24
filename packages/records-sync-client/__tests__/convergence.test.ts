// (b) Convergence from any cookie under concurrent writers (§11.2), property-style with a seeded RNG.

import type { Issue, Project, Workflow } from "@records/contracts";
import { describe, expect, it } from "vitest";

import type { MutationHandle } from "../src/client.js";
import { RecordStore } from "../src/store.js";
import { FakeServer, WORKFLOW } from "./fake-server.js";
import { converge, makeClient, rng, settle, type TestClient } from "./helpers.js";

const SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);
const STEPS = 150;

async function microtasks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

async function run(seed: number) {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const server = new FakeServer({ snapshots: true });
  const projects: Project[] = [server.addProject("ENG"), server.addProject("OPS")];
  const people = [server.addPrincipal("Ana"), server.addPrincipal("Ben"), server.addPrincipal("Cy")];
  const approvalRand = rng(seed * 7919);
  server.needsApproval = () => approvalRand() < 0.08;

  const clients: TestClient[] = [];
  const handles: MutationHandle[] = [];
  const join = async (i: number) => {
    const c = makeClient(server, people[i % people.length]!);
    clients.push(c);
    await c.client.start();
  };
  await join(0);
  await join(1);
  await join(2);

  const mutate = (c: TestClient) => {
    const issues = c.client.store.values<Issue>("issue/");
    const kind = issues.length === 0 ? 0 : Math.floor(rand() * 4);
    if (kind === 0) {
      handles.push(c.client.mutate.projects.createIssue({ projectId: pick(projects).id, title: `T${Math.floor(rand() * 1000)}`, ...(rand() < 0.2 ? { priority: "high" as const } : {}) }));
      return;
    }
    const issue = pick(issues);
    if (kind === 1) {
      const patch = rand() < 0.5 ? { title: `E${Math.floor(rand() * 1000)}` } : { priority: pick(["low", "medium", "urgent"] as const) };
      handles.push(c.client.mutate.projects.editIssue({ issueId: issue.id, expectedRevision: issue.revision, patch }));
    } else if (kind === 2) {
      handles.push(c.client.mutate.projects.transitionIssue({ issueId: issue.id, expectedRevision: issue.revision, toState: pick(WORKFLOW.states).key }));
    } else {
      handles.push(c.client.mutate.projects.addComment({ issueId: issue.id, body: `C${Math.floor(rand() * 1000)}` }));
    }
  };

  for (let step = 0; step < STEPS; step++) {
    if (step === Math.floor(STEPS / 2)) await join(3); // a late joiner pulls from null mid-run
    const c = pick(clients);
    const r = rand();
    if (r < 0.45) mutate(c);
    else if (r < 0.58) void c.client.flush();
    else if (r < 0.66) await c.client.flush();
    else if (r < 0.74) void c.client.pull();
    else if (r < 0.79) c.transport.pushFailures.push(pick(["network-before", "network-after", "500"] as const));
    else if (r < 0.82) c.transport.pullFailures.push(pick(["network-before", "network-after", "500"] as const));
    else if (r < 0.87) c.dropPokes.value = !c.dropPokes.value;
    else if (r < 0.9) server.prune(Math.floor(rand() * server.seq));
    else if (r < 0.95) {
      const actions = server.pendingActions();
      if (actions.length) {
        const id = pick(actions);
        if (rand() < 0.7) server.approve(id);
        else server.reject(id, "no");
      }
    } else {
      // A writer outside sync (HTTP API, Jira), with the correct revision.
      const issue = pick(server.values<Issue>("issue/").concat([] as Issue[]));
      if (issue) server.runCommand(pick(people), "projects.editIssue", { issueId: issue.id, expectedRevision: issue.revision, patch: { description: `x${step}` } });
    }
    await microtasks(Math.floor(rand() * 12));
    if (rand() < 0.1) await settle(0);
  }

  // Quiesce: no new approvals or failures, push everything, decide all approvals, sync everyone.
  server.needsApproval = () => false;
  for (const c of clients) {
    c.transport.pushFailures = [];
    c.transport.pullFailures = [];
  }
  await settle(10);
  for (const c of clients) await converge(c, server);
  for (const id of server.pendingActions()) server.approve(id);
  for (const c of clients) {
    await c.client.checkApprovals();
    await converge(c, server);
  }
  return { server, clients, handles };
}

describe("(b) convergence under concurrent writers", () => {
  it.each(SEEDS)("seed %i: every client ends at server state", async (seed) => {
    const { server, clients, handles } = await run(seed);
    const truth = server.snapshot();
    for (const c of clients) {
      expect(c.client.store.snapshot()).toEqual(truth);
      expect(c.client.hasUnsyncedChanges).toBe(false);
      expect(c.client.pending()).toEqual([]);
      expect(c.client.awaitingApproval).toEqual([]);
      c.client.close();
    }
    // Every mutation got exactly one decision; nothing was applied twice.
    const results = await Promise.all(handles.map((h) => h.result));
    expect(results).toHaveLength(handles.length);
    const issues = server.values<Issue>("issue/");
    for (const projectId of new Set(issues.map((i) => i.projectId))) {
      const numbers = issues.filter((i) => i.projectId === projectId).map((i) => i.number).sort((a, b) => a - b);
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    }
    const createIds = new Set(handles.map((h) => (h.args as { id?: string }).id).filter(Boolean));
    for (const i of issues) expect(createIds.has(i.id)).toBe(true);
    for (const h of handles) {
      const r = await h.result;
      const id = (h.args as { id?: string; title?: string }).id;
      if (id && "title" in (h.args as object) && r.status === "confirmed") expect(server.get(`issue/${id}`)).toBeDefined();
    }
  });

  it.each(SEEDS.slice(0, 10))("seed %i: a pull from any cookie converges to current state", async (seed) => {
    const { server, clients } = await run(seed);
    for (const c of clients) c.client.close();
    const truth = server.snapshot();
    for (let cookie = 0; cookie <= server.seq; cookie++) {
      const store = new RecordStore();
      const at = server.snapshotAt(cookie);
      if (cookie > 0) {
        expect(at).toBeDefined();
        store.applyServerPatch([{ op: "clear" }, ...[...at!.entries()].map(([key, value]) => ({ op: "put" as const, key, value }))]);
      }
      const res = server.pull({ clientGroupId: "someone-else", cookie: cookie === 0 ? null : cookie });
      expect(res.cookie).toBe(server.seq);
      store.applyServerPatch(res.patch);
      store.rebase([]);
      expect(store.snapshot()).toEqual(truth);
    }
    // The workflow is always present.
    expect(server.get<Workflow>("meta/workflow")).toEqual(WORKFLOW);
  });
});
