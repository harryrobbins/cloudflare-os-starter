// An in-memory RecordsSession (packages/gatekeeper-records/src/vendor/types.d.ts) for client and
// server tests. Like the real Gatekeeper it recomputes the intent digest over exactly the input and
// idempotency key it receives and redeems each viewer assertion once, so any mutation of the input
// between the browser and RECORDS shows up as a rejected write. Errors are thrown as
// "<code>: <detail>", the shape a RecordsError has after crossing RPC.

import { intentDigest } from "../../records-contracts/src/caller.ts";
import { ChangeFeed } from "../src/server/feed.js";
import { createRecordsProxy } from "../src/server/proxy.js";

export const WORKFLOW = {
  states: [
    { key: "todo", name: "To do", category: "todo", position: 1 },
    { key: "doing", name: "In progress", category: "in_progress", position: 2 },
    { key: "done", name: "Done", category: "done", position: 3 },
  ],
  transitions: [
    { from: "todo", to: "doing" }, { from: "doing", to: "todo" }, { from: "doing", to: "done" }, { from: "done", to: "doing" },
  ],
};

const ALICE = { id: "p-alice", displayName: "Alice", kind: "human" };
const BOB = { id: "p-bob", displayName: "Bob", kind: "human" };

/** @param {string} code @param {string} detail */
export const recordsError = (code, detail = code) => new Error(`${code}: ${detail}`);

export class FakeRecords {
  constructor({ scopes, lifecycle = "active", issues = 3, writeMode = "apply" } = {}) {
    this.scopes = scopes ?? ["projects.read", "issues.read", "issues.create", "issues.edit", "issues.transition", "comments.create"];
    this.lifecycle = lifecycle;
    /** "apply" | "pending": what a write does on submission. */
    this.writeMode = writeMode;
    /** @type {Error|null} thrown by every read when set */
    this.readError = null;
    /** @type {Error|null} thrown by the next write when set (simulates a lost call) */
    this.nextWriteThrows = null;
    /** When set, the next write is applied but its reply is lost in transit. */
    this.loseNextReply = false;
    this.calls = [];
    this.projects = [{ id: "prj-1", key: "ENG", name: "Engineering", description: "", revision: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }];
    this.issues = new Map();
    this.comments = [];
    this.pending = new Map();
    this.idempotency = new Map();
    this.redeemed = new Set();
    this.hooks = [];
    this.actionSeq = 100;
    this.clock = Date.parse("2026-09-20T10:00:00Z");
    for (let n = 1; n <= issues; n++) {
      this.#put({
        id: `iss-${n}`, projectId: "prj-1", number: n, key: `ENG-${n}`, title: `Issue ${n}`, description: "",
        state: n === 3 ? "doing" : "todo", priority: n === 1 ? "high" : "none", assignee: n === 2 ? BOB : null, customFields: {},
        revision: 1, createdAt: this.#now(), updatedAt: this.#now(), createdBy: ALICE, updatedBy: ALICE,
      });
    }
  }

  #now() { this.clock += 60_000; return new Date(this.clock).toISOString(); }
  #put(issue) { this.issues.set(issue.id, issue); return issue; }
  #read(name, arg) {
    this.calls.push({ name, arg });
    if (this.readError) throw this.readError;
  }

  /** The assertion the fake host mints: bound to the digest it was given. */
  static assertionFor(digest) { return `assert:${digest}`; }

  async #admit(operation, input, options) {
    this.calls.push({ name: operation, input, options });
    if (this.nextWriteThrows) { const e = this.nextWriteThrows; this.nextWriteThrows = null; throw e; }
    if (!this.scopes.includes(SCOPE[operation])) throw recordsError("forbidden", `binding lacks ${SCOPE[operation]}`);
    if (this.lifecycle !== "active") throw recordsError("datastore_archived", "datastore is archived");
    const digest = await intentDigest({ operation, input, idempotencyKey: options?.idempotencyKey });
    if (options?.viewerAssertion !== FakeRecords.assertionFor(digest)) {
      return { status: "rejected", code: "assertion_invalid", message: "viewer assertion does not match this write" };
    }
    if (this.redeemed.has(options.viewerAssertion) && !this.idempotency.has(options.idempotencyKey)) {
      return { status: "rejected", code: "assertion_reused", message: "assertion already used" };
    }
    this.redeemed.add(options.viewerAssertion);
    const saved = this.idempotency.get(options.idempotencyKey);
    if (saved) return saved.status === "applied" ? { ...saved, replayed: true } : saved;
    return null;
  }

  #finish(key, outcome) { this.idempotency.set(key, outcome); return outcome; }

  #apply(operation, input) {
    if (operation === "createIssue") {
      const number = this.issues.size + 1;
      return { status: "applied", replayed: false, record: this.#put({
        id: `iss-${number}`, projectId: input.projectId, number, key: `ENG-${number}`, title: input.title,
        description: input.description ?? "", state: input.state ?? "todo", priority: input.priority ?? "none",
        assignee: input.assigneeId === "p-bob" ? BOB : input.assigneeId === "p-alice" ? ALICE : null, customFields: {},
        revision: 1, createdAt: this.#now(), updatedAt: this.#now(), createdBy: ALICE, updatedBy: ALICE,
      }) };
    }
    if (operation === "addComment") {
      const c = { id: `c-${this.comments.length + 1}`, issueId: input.issueId, body: input.body, author: ALICE, createdAt: this.#now() };
      this.comments.push(c);
      return { status: "applied", replayed: false, record: c };
    }
    const issue = this.issues.get(input.issueId);
    if (!issue) return { status: "rejected", code: "not_found", message: "no such issue" };
    if (issue.revision !== input.expectedRevision) {
      return { status: "conflict", code: "revision_conflict", message: "issue changed", currentRevision: issue.revision };
    }
    if (operation === "transitionIssue") {
      if (!WORKFLOW.transitions.some((t) => t.from === issue.state && t.to === input.toState)) {
        return { status: "conflict", code: "workflow_conflict", message: "transition not allowed" };
      }
      return { status: "applied", replayed: false, record: this.#put({ ...issue, state: input.toState, revision: issue.revision + 1, updatedAt: this.#now() }) };
    }
    const { assigneeId, ...rest } = input.patch;
    const next = { ...issue, ...rest, revision: issue.revision + 1, updatedAt: this.#now() };
    if ("assigneeId" in input.patch) next.assignee = assigneeId === "p-bob" ? BOB : assigneeId === "p-alice" ? ALICE : null;
    return { status: "applied", replayed: false, record: this.#put(next) };
  }

  async #write(operation, input, options) {
    const early = await this.#admit(operation, input, options);
    if (early) return early;
    if (this.writeMode === "pending") {
      const actionId = ++this.actionSeq;
      this.pending.set(actionId, { operation, input, key: options.idempotencyKey });
      return this.#finish(options.idempotencyKey, { status: "pending", actionId, idempotencyKey: options.idempotencyKey });
    }
    const outcome = this.#finish(options.idempotencyKey, this.#apply(operation, input));
    if (this.loseNextReply) { this.loseNextReply = false; throw new Error("Network connection lost."); }
    return outcome;
  }

  /** Test helper: the Workshop owner approves (or denies) a queued write. */
  approve(actionId, approve = true) {
    const p = this.pending.get(actionId);
    this.pending.delete(actionId);
    const outcome = approve ? this.#apply(p.operation, p.input) : { status: "rejected", code: "denied", message: "The owner declined this change." };
    this.idempotency.set(p.key, outcome);
    this.pending.set(-actionId, outcome);
    return outcome;
  }

  /** Test helper: someone else edits an issue. */
  touch(issueId, patch) {
    const issue = this.issues.get(issueId);
    return this.#put({ ...issue, ...patch, revision: issue.revision + 1, updatedAt: this.#now(), updatedBy: BOB });
  }

  // --- RecordsSession ---
  async describe() {
    this.#read("describe");
    return { datastore: { id: "ds-1", name: "Engineering projects", description: "", lifecycle: this.lifecycle }, moduleId: "projects", apiMajor: 1, scopes: [...this.scopes] };
  }
  async intentFormat() { return "sha256(canonicalJson({v,service,operation,input,key}))"; }
  async listProjects() { this.#read("listProjects"); return this.projects; }
  async getWorkflow() { this.#read("getWorkflow"); return WORKFLOW; }
  async listAssignees() { this.#read("listAssignees"); return []; }
  async listIssues(input = {}) {
    this.#read("listIssues", input);
    let items = [...this.issues.values()].filter((i) => !input.projectId || i.projectId === input.projectId);
    if (input.order === "updated_desc") items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    else items.sort((a, b) => a.number - b.number);
    const start = input.cursor ? Number(input.cursor) : 0;
    const limit = input.limit ?? 50;
    const page = items.slice(start, start + limit);
    return { items: page, nextCursor: start + limit < items.length ? String(start + limit) : null };
  }
  async getIssue(issueId) {
    this.#read("getIssue", issueId);
    const issue = this.issues.get(issueId);
    if (!issue) throw recordsError("not_found", "no such issue");
    return issue;
  }
  async listComments(input) {
    this.#read("listComments", input);
    return { items: this.comments.filter((c) => c.issueId === input.issueId), nextCursor: null };
  }
  createIssue(input, options) { return this.#write("createIssue", input, options); }
  editIssue(input, options) { return this.#write("editIssue", input, options); }
  transitionIssue(input, options) { return this.#write("transitionIssue", input, options); }
  addComment(input, options) { return this.#write("addComment", input, options); }
  async getWriteOutcome(actionId) {
    this.calls.push({ name: "getWriteOutcome", arg: actionId });
    const settled = this.pending.get(-actionId);
    if (settled) return settled;
    const p = this.pending.get(actionId);
    if (p) return { status: "pending", actionId, idempotencyKey: p.key };
    throw recordsError("not_found", "no such action");
  }
  async onChange(callback) { this.calls.push({ name: "onChange" }); this.hooks.push(callback); }

  writeCalls() { return this.calls.filter((c) => SCOPE[c.name]); }
}

const SCOPE = { createIssue: "issues.create", editIssue: "issues.edit", transitionIssue: "issues.transition", addComment: "comments.create" };

/** Map-backed stand-in for `ctx.storage.kv`. */
export function memoryKv() {
  const m = new Map();
  return { get: (k) => structuredClone(m.get(k)), put: (k, v) => { m.set(k, structuredClone(v)); } };
}

/**
 * What the browser sees as `gadget`: the real server proxy over a FakeRecords env, plus the
 * host-owned `$createViewerAssertion`.
 * @param {FakeRecords|null} records
 * @param {{assertion?: (binding: string, digest: string) => any}} [opts]
 */
export function fakeGadget(records, opts = {}) {
  const feed = new ChangeFeed(memoryKv());
  const env = records ? { RECORDS: records } : {};
  const proxy = createRecordsProxy(() => env, feed, async () => ({ hook: "persistent-stub" }));
  const assertions = [];
  const gadget = {
    ...proxy,
    feed,
    assertions,
    async $createViewerAssertion(binding, digest) {
      assertions.push({ binding, digest });
      if (opts.assertion) return opts.assertion(binding, digest);
      return FakeRecords.assertionFor(digest);
    },
  };
  return gadget;
}
