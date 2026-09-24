// In-memory stand-in for the datastore service's sync endpoints, written independently of the
// client's mutators so that tests compare the client's predictions with separate authoritative
// rules.
//
// Faithful to the protocol the client relies on:
// - one datastore clock: every committed command takes the next `seq`; the journal records each
//   changed key at that seq
// - per-client lastMutationId, updated in the same step as the command (processed = counted, even
//   when rejected or sent for approval); ids at or below it are `skipped`; gaps are allowed
// - pull: patch from the journal after the cookie, coalesced per key; `clear` + full state for a
//   null cookie or one older than retention; cookie = head; every client of the group's lmid
// - approvals: `pending` outcomes create actions that are later approved (the command runs then,
//   under the original principal, and may still fail) or rejected

import type {
  Comment,
  Issue,
  PatchOp,
  PrincipalRef,
  Project,
  PullRequest,
  PullResponse,
  PushMutation,
  PushOutcome,
  PushRequest,
  PushResponse,
  Workflow,
} from "@records/contracts";

import type { ApprovalStatus, SyncTransport } from "../src/client.js";
import { SyncTransportError } from "../src/errors.js";

export const WORKFLOW: Workflow = {
  states: [
    { key: "backlog", name: "Backlog", category: "todo", position: 0 },
    { key: "todo", name: "To do", category: "todo", position: 1 },
    { key: "in_progress", name: "In progress", category: "in_progress", position: 2 },
    { key: "done", name: "Done", category: "done", position: 3 },
  ],
  transitions: [
    { from: "backlog", to: "todo" },
    { from: "todo", to: "backlog" },
    { from: "todo", to: "in_progress" },
    { from: "in_progress", to: "todo" },
    { from: "in_progress", to: "done" },
    { from: "done", to: "todo" },
  ],
};

class CommandError extends Error {
  constructor(
    readonly kind: "rejected" | "conflict",
    readonly code: string,
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
  }
}

type Action = {
  actionId: number;
  principal: PrincipalRef;
  mutation: PushMutation;
  status: "pending" | "approved" | "rejected";
  message?: string;
};

let uuidCounter = 0;
/** Deterministic UUID-shaped ids for server-side creates without a client id. */
export function testUuid(prefix = 0): string {
  const n = (++uuidCounter).toString(16).padStart(12, "0");
  return `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${n}`;
}

export class FakeServer {
  readonly datastoreId = "11111111-1111-4111-8111-111111111111";
  seq = 0;
  private readonly state = new Map<string, unknown>();
  private journal: { seq: number; key: string; value: unknown }[] = [];
  /** Journal entries with seq below this have been pruned. */
  private retainFrom = 1;
  private readonly snapshots = new Map<number, Map<string, unknown>>();
  private readonly clients = new Map<string, { group: string; lmid: number }>();
  private readonly actions = new Map<number, Action>();
  private nextActionId = 1;
  private readonly numbers = new Map<string, number>();
  private readonly pokeListeners = new Set<(head: number) => void>();
  readonly principals = new Map<string, PrincipalRef>();
  readonly pushLog: PushRequest[] = [];
  /** Decide which mutations go to approval. */
  needsApproval: (m: PushMutation, principal: PrincipalRef) => boolean = () => false;

  constructor(opts: { snapshots?: boolean } = {}) {
    this.keepSnapshots = opts.snapshots ?? false;
    this.commit([["meta/workflow", WORKFLOW]]);
  }
  private readonly keepSnapshots: boolean;

  // ---- setup --------------------------------------------------------------------------------

  addProject(key: string, id = testUuid(1)): Project {
    const project: Project = { id, key, name: `${key} project`, description: "", revision: 1, createdAt: this.time(), updatedAt: this.time() };
    this.numbers.set(id, 1);
    this.commit([[`project/${id}`, project]]);
    return project;
  }

  addPrincipal(displayName: string, id = testUuid(2)): PrincipalRef {
    const p: PrincipalRef = { id, displayName, kind: "human" };
    this.principals.set(id, p);
    return p;
  }

  /** A direct write by someone outside sync (e.g. the HTTP API). */
  runCommand(principal: PrincipalRef, name: string, args: unknown): number {
    this.execute(principal, name, args);
    return this.seq;
  }

  // ---- reads --------------------------------------------------------------------------------

  get<T>(key: string): T | undefined {
    return this.state.get(key) as T | undefined;
  }

  values<T>(prefix: string): T[] {
    return [...this.state.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v as T);
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries([...this.state.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  snapshotAt(seq: number): Map<string, unknown> | undefined {
    return this.snapshots.get(seq);
  }

  lastMutationId(clientId: string): number {
    return this.clients.get(clientId)?.lmid ?? 0;
  }

  // ---- journal ------------------------------------------------------------------------------

  private time(): string {
    return new Date(Date.UTC(2026, 0, 1) + this.seq * 1000).toISOString();
  }

  private commit(changes: Array<[string, unknown]>): number {
    this.seq++;
    for (const [key, value] of changes) {
      if (value === null) this.state.delete(key);
      else this.state.set(key, value);
      this.journal.push({ seq: this.seq, key, value });
    }
    if (this.keepSnapshots) this.snapshots.set(this.seq, new Map(this.state));
    const head = this.seq;
    for (const l of [...this.pokeListeners]) l(head);
    return head;
  }

  /** Drops journal entries up to `seq`, as retention would. */
  prune(seq: number): void {
    this.journal = this.journal.filter((e) => e.seq > seq);
    this.retainFrom = Math.max(this.retainFrom, seq + 1);
  }

  subscribePokes(listener: (head: number) => void): () => void {
    this.pokeListeners.add(listener);
    return () => this.pokeListeners.delete(listener);
  }

  // ---- commands (authoritative rules) -------------------------------------------------------

  private execute(principal: PrincipalRef, name: string, raw: unknown): void {
    const args = (raw ?? {}) as Record<string, any>;
    const now = () => new Date(Date.UTC(2026, 0, 1) + (this.seq + 1) * 1000).toISOString();
    const ref = (id: string | null | undefined): PrincipalRef | null => {
      if (!id) return null;
      const p = this.principals.get(id);
      if (!p) throw new CommandError("rejected", "validation_failed", "Unknown assignee.");
      return p;
    };
    const issueOf = (id: string): Issue => {
      const issue = this.get<Issue>(`issue/${id}`);
      if (!issue) throw new CommandError("rejected", "not_found", "Unknown issue.");
      return issue;
    };
    switch (name) {
      case "projects.createIssue": {
        const title = typeof args.title === "string" ? args.title.trim() : "";
        if (!title) throw new CommandError("rejected", "validation_failed", "title: required");
        const project = this.get<Project>(`project/${args.projectId}`);
        if (!project) throw new CommandError("rejected", "not_found", "Unknown project.");
        const id: string = args.id ?? testUuid(3);
        if (this.state.has(`issue/${id}`)) throw new CommandError("rejected", "duplicate", "That id is taken.");
        const workflow = this.get<Workflow>("meta/workflow")!;
        const first = [...workflow.states].sort((a, b) => a.position - b.position)[0]!.key;
        const state: string = args.state ?? first;
        if (!workflow.states.some((s) => s.key === state)) throw new CommandError("rejected", "validation_failed", "Unknown state.");
        const number = this.numbers.get(project.id)!;
        this.numbers.set(project.id, number + 1);
        const at = now();
        const issue: Issue = {
          id,
          projectId: project.id,
          number,
          key: `${project.key}-${number}`,
          title,
          description: args.description ?? "",
          state,
          priority: args.priority ?? "none",
          assignee: ref(args.assigneeId),
          customFields: args.customFields ?? {},
          revision: 1,
          createdAt: at,
          updatedAt: at,
          createdBy: principal,
          updatedBy: principal,
        };
        this.commit([[`issue/${id}`, issue]]);
        return;
      }
      case "projects.editIssue": {
        const issue = issueOf(args.issueId);
        if (issue.revision !== args.expectedRevision) {
          throw new CommandError("conflict", "revision_conflict", "The issue changed since you last read it.", issue.revision);
        }
        const p = args.patch ?? {};
        if (!Object.keys(p).length) throw new CommandError("rejected", "validation_failed", "an edit must change something");
        const next: Issue = { ...issue, revision: issue.revision + 1, updatedAt: now(), updatedBy: principal };
        if (p.title !== undefined) {
          const t = String(p.title).trim();
          if (!t) throw new CommandError("rejected", "validation_failed", "title: required");
          next.title = t;
        }
        if (p.description !== undefined) next.description = p.description;
        if (p.priority !== undefined) next.priority = p.priority;
        if (p.assigneeId !== undefined) next.assignee = ref(p.assigneeId);
        if (p.customFields !== undefined) next.customFields = { ...issue.customFields, ...p.customFields };
        this.commit([[`issue/${issue.id}`, next]]);
        return;
      }
      case "projects.transitionIssue": {
        const issue = issueOf(args.issueId);
        if (issue.revision !== args.expectedRevision) {
          throw new CommandError("conflict", "revision_conflict", "The issue changed since you last read it.", issue.revision);
        }
        const workflow = this.get<Workflow>("meta/workflow")!;
        if (!workflow.transitions.some((t) => t.from === issue.state && t.to === args.toState)) {
          throw new CommandError("conflict", "workflow_conflict", `The workflow does not allow ${issue.state} → ${args.toState}.`);
        }
        this.commit([[`issue/${issue.id}`, { ...issue, state: args.toState, revision: issue.revision + 1, updatedAt: now(), updatedBy: principal }]]);
        return;
      }
      case "projects.addComment": {
        issueOf(args.issueId);
        const body = typeof args.body === "string" ? args.body.trim() : "";
        if (!body) throw new CommandError("rejected", "validation_failed", "body: required");
        const id: string = args.id ?? testUuid(4);
        if (this.state.has(`comment/${id}`)) throw new CommandError("rejected", "duplicate", "That id is taken.");
        const comment: Comment = { id, issueId: args.issueId, body, author: principal, createdAt: now() };
        this.commit([[`comment/${id}`, comment]]);
        return;
      }
      default:
        throw new CommandError("rejected", "validation_failed", `Unknown command ${name}.`);
    }
  }

  // ---- sync endpoints -----------------------------------------------------------------------

  push(req: PushRequest, principal: PrincipalRef): PushResponse {
    this.pushLog.push(structuredClone(req));
    let client = this.clients.get(req.clientId);
    if (!client) {
      client = { group: req.clientGroupId, lmid: 0 };
      this.clients.set(req.clientId, client);
    }
    const outcomes: PushOutcome[] = [];
    for (const m of req.mutations) {
      if (m.id <= client.lmid) {
        outcomes.push({ id: m.id, status: "skipped" });
        continue;
      }
      client.lmid = m.id;
      if (this.needsApproval(m, principal)) {
        const actionId = this.nextActionId++;
        this.actions.set(actionId, { actionId, principal, mutation: structuredClone(m), status: "pending" });
        outcomes.push({ id: m.id, status: "pending", actionId });
        continue;
      }
      try {
        this.execute(principal, m.name, m.args);
        outcomes.push({ id: m.id, status: "applied", seq: this.seq });
      } catch (err) {
        if (!(err instanceof CommandError)) throw err;
        if (err.kind === "conflict") {
          const o: PushOutcome = { id: m.id, status: "conflict", code: err.code as "revision_conflict", message: err.message };
          if (err.currentRevision !== undefined) o.currentRevision = err.currentRevision;
          outcomes.push(o);
        } else outcomes.push({ id: m.id, status: "rejected", code: err.code, message: err.message });
      }
    }
    return { outcomes, head: this.seq };
  }

  pull(req: PullRequest): PullResponse {
    const lastMutationIdChanges: Record<string, number> = {};
    for (const [id, c] of this.clients) if (c.group === req.clientGroupId) lastMutationIdChanges[id] = c.lmid;
    const patch: PatchOp[] = [];
    if (req.cookie === null || req.cookie < this.retainFrom - 1 || req.cookie > this.seq) {
      patch.push({ op: "clear" });
      for (const [key, value] of this.state) patch.push({ op: "put", key, value });
    } else {
      const latest = new Map<string, unknown>();
      for (const e of this.journal) if (e.seq > req.cookie) latest.set(e.key, e.value);
      for (const [key, value] of latest) patch.push(value === null ? { op: "del", key } : { op: "put", key, value });
    }
    return { cookie: this.seq, lastMutationIdChanges, patch: structuredClone(patch) };
  }

  // ---- approvals ----------------------------------------------------------------------------

  pendingActions(): number[] {
    return [...this.actions.values()].filter((a) => a.status === "pending").map((a) => a.actionId);
  }

  approve(actionId: number): void {
    const a = this.actions.get(actionId);
    if (!a || a.status !== "pending") throw new Error(`no pending action ${actionId}`);
    try {
      this.execute(a.principal, a.mutation.name, a.mutation.args);
      a.status = "approved";
    } catch (err) {
      if (!(err instanceof CommandError)) throw err;
      a.status = "rejected";
      a.message = `Approved, but it could not be applied: ${err.message}`;
    }
  }

  reject(actionId: number, message = "An approver declined this change."): void {
    const a = this.actions.get(actionId);
    if (!a || a.status !== "pending") throw new Error(`no pending action ${actionId}`);
    a.status = "rejected";
    a.message = message;
  }

  approvals(ids: number[]): ApprovalStatus[] {
    return ids.flatMap((id) => {
      const a = this.actions.get(id);
      if (!a) return [];
      const s: ApprovalStatus = { actionId: id, status: a.status };
      if (a.message) s.message = a.message;
      return [s];
    });
  }

  // ---- transports ---------------------------------------------------------------------------

  transport(principal: PrincipalRef): FakeTransport {
    return new FakeTransport(this, principal);
  }
}

type Failure = "network-before" | "network-after" | "500" | "401";

/** Yield a few microtasks (not timers, so fake timers do not stall the transport). */
const tick = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

/** Serialises through JSON both ways, like a network, with failure injection. */
export class FakeTransport implements SyncTransport {
  pushFailures: Failure[] = [];
  pullFailures: Failure[] = [];
  /** Responses to return instead of asking the server (e.g. a stale or duplicated response). */
  cannedPulls: PullResponse[] = [];
  readonly pullResponses: PullResponse[] = [];
  pushes = 0;
  pulls = 0;

  constructor(
    private readonly server: FakeServer,
    private readonly principal: PrincipalRef,
  ) {}

  private fail(f: Failure): never {
    if (f === "500") throw new SyncTransportError("server", "Internal error", 500, "internal");
    if (f === "401") throw new SyncTransportError("client", "Sign in again", 401, "unauthenticated");
    throw new SyncTransportError("network", "Network error");
  }

  async push(req: PushRequest): Promise<PushResponse> {
    this.pushes++;
    await tick();
    const failure = this.pushFailures.shift();
    if (failure && failure !== "network-after") this.fail(failure);
    const res = this.server.push(JSON.parse(JSON.stringify(req)) as PushRequest, this.principal);
    await tick();
    if (failure === "network-after") this.fail(failure);
    return JSON.parse(JSON.stringify(res)) as PushResponse;
  }

  async pull(req: PullRequest): Promise<PullResponse> {
    this.pulls++;
    await tick();
    const failure = this.pullFailures.shift();
    if (failure && failure !== "network-after") this.fail(failure);
    const canned = this.cannedPulls.shift();
    const res = canned ?? this.server.pull(JSON.parse(JSON.stringify(req)) as PullRequest);
    await tick();
    if (failure === "network-after") this.fail(failure);
    const copy = JSON.parse(JSON.stringify(res)) as PullResponse;
    this.pullResponses.push(copy);
    return JSON.parse(JSON.stringify(copy)) as PullResponse;
  }

  async approvals(ids: number[]): Promise<ApprovalStatus[]> {
    await tick();
    return this.server.approvals(ids);
  }
}
