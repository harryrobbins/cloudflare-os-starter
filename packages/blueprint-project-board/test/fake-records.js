// An in-memory RecordsSession (packages/gatekeeper-records/src/vendor/types.d.ts) for client and
// server tests, built on the sync client's own fake datastore (records-sync-client
// __tests__/fake-server.ts: one clock, journal, per-client lastMutationId, approvals).
//
// Like the real session (gatekeeper-records/src/vendor/session.ts) `syncPush`:
//   - needs one viewer assertion per mutation, in order, and recomputes each digest over
//     { operation: name without "projects.", input: args, idempotencyKey: "sync:<clientId>:<id>" },
//     so any change to a mutation between the browser and RECORDS fails the push;
//   - redeems each assertion once;
//   - keeps a client group to the viewer who first pushed into it;
//   - checks the binding's scopes and the datastore's lifecycle per mutation (a `rejected` outcome).
// Errors are thrown as "<code>: <detail>", the shape a RecordsError has after crossing RPC.

import { intentDigest } from "../../records-contracts/src/caller.ts";
import { FakeServer, WORKFLOW } from "../../records-sync-client/__tests__/fake-server.ts";
import { PokeLog } from "../src/server/pokes.js";
import { createRecordsProxy } from "../src/server/proxy.js";

export { WORKFLOW };

/** @param {string} code @param {string} detail */
export const recordsError = (code, detail = code) => new Error(`${code}: ${detail}`);

const SCOPE = {
  "projects.createIssue": "issues.create", "projects.editIssue": "issues.edit",
  "projects.transitionIssue": "issues.transition", "projects.addComment": "comments.create",
};

let assertionCounter = 0;
const clone = (v) => JSON.parse(JSON.stringify(v));

export class FakeRecords {
  constructor({ scopes, lifecycle = "active", issues = 3, approvals = false } = {}) {
    this.scopes = scopes ?? ["projects.read", "issues.read", "issues.create", "issues.edit", "issues.transition", "comments.create"];
    this.lifecycle = lifecycle;
    /** @type {Error|null} thrown by every read (describe, pull, …) when set */
    this.readError = null;
    /** @type {Error|null} thrown by the next push when set */
    this.nextPushThrows = null;
    /** When set, pushes wait for this promise before reaching the datastore. */
    this.pushGate = null;
    this.calls = [];
    this.redeemed = new Set();
    this.groups = new Map();
    this.hooks = [];
    this.server = new FakeServer();
    this.server.needsApproval = () => approvals;
    this.alice = this.server.addPrincipal("Alice", "p-alice");
    this.bob = this.server.addPrincipal("Bob", "p-bob");
    this.project = this.server.addProject("ENG", "prj-1");
    for (let n = 1; n <= issues; n++) {
      this.server.runCommand(this.alice, "projects.createIssue", {
        id: `iss-${n}`, projectId: "prj-1", title: `Issue ${n}`,
        priority: n === 1 ? "high" : "none", ...(n === 2 ? { assigneeId: "p-bob" } : {}),
      });
    }
    if (issues >= 3) this.server.runCommand(this.alice, "projects.transitionIssue", { issueId: "iss-3", expectedRevision: 1, toState: "todo" });
  }

  /** Every seeded issue starts in the first state; iss-3 is moved to "todo". */
  issue(id) { return this.server.get(`issue/${id}`); }
  comments() { return this.server.values("comment/"); }

  /** The fake host's assertions: one-use tokens bound to a digest. */
  static assertionFor(digest) { return `assert:${digest}:${++assertionCounter}`; }
  static matches(assertion, digest) { return typeof assertion === "string" && assertion.startsWith(`assert:${digest}:`); }

  /** Test helper: someone else changes an issue outside this board. */
  touch(issueId, patch) {
    const issue = this.issue(issueId);
    this.server.runCommand(this.bob, "projects.editIssue", { issueId, expectedRevision: issue.revision, patch });
    return this.issue(issueId);
  }

  #read(name, arg) {
    this.calls.push({ name, arg });
    if (this.readError) throw this.readError;
  }

  // --- RecordsSession ---
  async describe() {
    this.#read("describe");
    return { datastore: { id: this.server.datastoreId, name: "Engineering projects", description: "", lifecycle: this.lifecycle }, moduleId: "projects", apiMajor: 1, scopes: [...this.scopes] };
  }
  async intentFormat() { return "sha256(canonicalJson({v,service,operation,input,key}))"; }
  async listProjects() { this.#read("listProjects"); return this.server.values("project/"); }
  async getWorkflow() { this.#read("getWorkflow"); return this.server.get("meta/workflow"); }
  async listAssignees() { this.#read("listAssignees"); return [this.alice, this.bob]; }
  async listIssues(input = {}) {
    this.#read("listIssues", input);
    const items = this.server.values("issue/").filter((i) => !input.projectId || i.projectId === input.projectId);
    return { items, nextCursor: null };
  }
  async getIssue(issueId) {
    this.#read("getIssue", issueId);
    const issue = this.issue(issueId);
    if (!issue) throw recordsError("not_found", "no such issue");
    return issue;
  }
  async listComments(input) {
    this.#read("listComments", input);
    return { items: this.comments().filter((c) => c.issueId === input.issueId), nextCursor: null };
  }

  async syncPush(request, options) {
    this.calls.push({ name: "syncPush", request: clone(request), options: clone(options) });
    if (this.pushGate) await this.pushGate;
    if (this.nextPushThrows) { const e = this.nextPushThrows; this.nextPushThrows = null; throw e; }
    if (!Array.isArray(options) || options.length !== request.mutations.length) {
      throw recordsError("validation_failed", "Send one viewer assertion per mutation, in the same order.");
    }
    for (const [i, m] of request.mutations.entries()) {
      const digest = await intentDigest({ operation: m.name.slice("projects.".length), input: m.args, idempotencyKey: `sync:${request.clientId}:${m.id}` });
      const assertion = options[i].viewerAssertion;
      if (!FakeRecords.matches(assertion, digest)) throw recordsError("unauthenticated", "The viewer assertion does not match this change.");
      if (this.redeemed.has(assertion)) throw recordsError("unauthenticated", "The viewer assertion was already used.");
      this.redeemed.add(assertion);
    }
    const owner = this.groups.get(request.clientGroupId);
    if (owner && owner !== this.alice.id) throw recordsError("forbidden", "This sync client group belongs to another viewer.");
    this.groups.set(request.clientGroupId, this.alice.id);
    // Per-mutation prechecks, as the session's approval gate does: a refusal is that mutation's outcome.
    const refused = new Map();
    for (const m of request.mutations) {
      if (m.id <= this.server.lastMutationId(request.clientId)) continue;
      if (this.lifecycle !== "active") refused.set(m.id, { code: "datastore_archived", message: "This datastore is archived and read-only." });
      else if (!this.scopes.includes(SCOPE[m.name])) refused.set(m.id, { code: "forbidden", message: `Alice may not change this through this connection.` });
    }
    if (refused.size) {
      const allowed = { ...request, mutations: request.mutations.filter((m) => !refused.has(m.id)) };
      const res = allowed.mutations.length ? this.server.push(clone(allowed), this.alice) : { outcomes: [], head: this.server.seq };
      const byId = new Map(res.outcomes.map((o) => [o.id, o]));
      const outcomes = request.mutations.map((m) => refused.has(m.id) ? { id: m.id, status: "rejected", ...refused.get(m.id) } : byId.get(m.id));
      return clone({ outcomes, head: res.head });
    }
    return clone(this.server.push(clone(request), this.alice));
  }

  async syncPull(request) {
    this.#read("syncPull", request);
    return clone(this.server.pull(clone(request)));
  }

  async syncApprovals(actionIds) {
    this.calls.push({ name: "syncApprovals", arg: actionIds });
    const known = new Map(this.server.approvals(actionIds).map((s) => [s.actionId, s]));
    return actionIds.map((actionId) => {
      const s = known.get(actionId);
      if (!s) return { actionId, status: "expired" };
      return s.status === "approved" ? { actionId, status: "approved" } : clone(s);
    });
  }

  async onChange(callback, options) {
    this.calls.push({ name: "onChange", options });
    this.hooks.push({ callback, options });
    if (options?.deliver === "pokes") {
      this.server.subscribePokes((head) => { void callback.poked({ datastoreId: this.server.datastoreId, head }); });
    }
  }

  pushCalls() { return this.calls.filter((c) => c.name === "syncPush"); }
}

/** Map-backed stand-in for `ctx.storage.kv`. */
export function memoryKv() {
  const m = new Map();
  return { get: (k) => structuredClone(m.get(k)), put: (k, v) => { m.set(k, structuredClone(v)); } };
}

/**
 * What the browser sees as `gadget`: the real server proxy over a FakeRecords env (with a real
 * PokeLog behind the hook), plus the host-owned `$createViewerAssertion`.
 * @param {FakeRecords|null} records
 * @param {{assertion?: (binding: string, digest: string) => any}} [opts]
 */
export function fakeGadget(records, opts = {}) {
  const pokes = new PokeLog(memoryKv());
  const env = records ? { RECORDS: records } : {};
  // The persistent hook: what `ctx.restore` would hand Records (see src/server/index.js).
  const hook = { poked: (p) => pokes.poked(p), changed: () => pokes.nudge(), resync: () => pokes.nudge() };
  const proxy = createRecordsProxy(() => env, pokes, async () => hook);
  const assertions = [];
  return {
    ...proxy,
    pokes,
    assertions,
    async $createViewerAssertion(binding, digest) {
      assertions.push({ binding, digest });
      if (opts.assertion) return opts.assertion(binding, digest);
      return FakeRecords.assertionFor(digest);
    },
  };
}
