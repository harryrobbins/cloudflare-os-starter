// A minimal read-only-friendly RecordsSession. Its write methods exist (a real session has them)
// but record every call, so tests can prove the report never reaches them.
//
// Sync reads follow the protocol (records-sync-client README, "What the server must do"): one
// clock, a journal of changed keys, `syncPull` from a cookie returns the coalesced changes after it
// (or `clear` + full state for a null cookie), and each commit pokes `onChange(…, {deliver:
// "pokes"})` hooks with `{datastoreId, head}`.
import { vi } from "vitest";
import { PokeLog } from "../src/server/pokes.js";
import { createReadOnlyProxy } from "../src/server/proxy.js";

export const WORKFLOW = {
  states: [
    { key: "todo", name: "To do", category: "todo", position: 1 },
    { key: "doing", name: "In progress", category: "in_progress", position: 2 },
    { key: "done", name: "Done", category: "done", position: 3 },
  ],
  transitions: [{ from: "todo", to: "doing" }, { from: "doing", to: "done" }],
};
const person = (id, displayName) => ({ id, displayName, kind: "human" });
export const ALICE = person("p-a", "Alice");
export const BOB = person("p-b", "Bob");

export function makeIssues() {
  const spec = [
    ["prj-1", "todo", "high", ALICE], ["prj-1", "todo", "none", null], ["prj-1", "doing", "urgent", BOB],
    ["prj-1", "done", "low", ALICE], ["prj-2", "todo", "medium", BOB], ["prj-2", "done", "none", null],
  ];
  return spec.map(([projectId, state, priority, assignee], n) => ({
    id: `i${n + 1}`, projectId, number: n + 1, key: `${projectId === "prj-1" ? "ENG" : "OPS"}-${n + 1}`, title: `Issue ${n + 1}`,
    description: "", state, priority, assignee, customFields: {}, revision: 1,
    createdAt: `2026-09-0${n + 1}T09:00:00Z`, updatedAt: `2026-09-1${n + 1}T09:00:00Z`, createdBy: ALICE, updatedBy: ALICE,
  }));
}

export const WRITES = ["createIssue", "editIssue", "transitionIssue", "addComment", "syncPush"];
const PROJECTS = [
  { id: "prj-1", key: "ENG", name: "Engineering", description: "", revision: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
  { id: "prj-2", key: "OPS", name: "Operations", description: "", revision: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
];
const clone = (v) => JSON.parse(JSON.stringify(v));

export function fakeSession({ issues = makeIssues(), scopes = ["projects.read", "issues.read"], readError = null } = {}) {
  const datastoreId = "ds-1";
  /** @type {Map<string, unknown>} */
  const state = new Map();
  /** @type {{seq: number, key: string, value: unknown}[]} */
  const journal = [];
  const hooks = [];
  let seq = 0;
  const commit = (/** @type {[string, unknown][]} */ changes) => {
    seq++;
    for (const [key, value] of changes) {
      if (value === null) state.delete(key); else state.set(key, value);
      journal.push({ seq, key, value });
    }
    for (const h of hooks) if (h.options?.deliver === "pokes") void h.callback.poked({ datastoreId, head: seq });
  };
  const values = (/** @type {string} */ prefix) => [...state].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  const s = {
    readError,
    reads: [],
    hooks,
    get seq() { return seq; },
    /** Test helper: someone changes an issue through another client. */
    edit(issueId, patch) {
      const issue = /** @type {any} */ (state.get(`issue/${issueId}`));
      commit([[`issue/${issueId}`, { ...issue, ...patch, revision: issue.revision + 1, updatedAt: "2026-09-30T12:00:00Z", updatedBy: BOB }]]);
    },
    describe: async () => { if (s.readError) throw s.readError; return { datastore: { id: datastoreId, name: "Engineering", description: "", lifecycle: "active" }, moduleId: "projects", apiMajor: 1, scopes }; },
    listProjects: async () => { s.reads.push("listProjects"); return values("project/"); },
    getWorkflow: async () => { s.reads.push("getWorkflow"); return WORKFLOW; },
    listIssues: async (input = {}) => {
      s.reads.push("listIssues");
      const sorted = /** @type {any[]} */ (values("issue/")).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const start = Number(input.cursor ?? 0), limit = input.limit ?? 50;
      return { items: sorted.slice(start, start + limit), nextCursor: start + limit < sorted.length ? String(start + limit) : null };
    },
    syncPull: async (request) => {
      s.reads.push({ syncPull: request.cookie });
      if (s.readError) throw s.readError;
      const patch = [];
      if (request.cookie === null || request.cookie > seq) {
        patch.push({ op: "clear" });
        for (const [key, value] of state) patch.push({ op: "put", key, value });
      } else {
        const latest = new Map();
        for (const e of journal) if (e.seq > request.cookie) latest.set(e.key, e.value);
        for (const [key, value] of latest) patch.push(value === null ? { op: "del", key } : { op: "put", key, value });
      }
      return clone({ cookie: seq, lastMutationIdChanges: {}, patch });
    },
    getIssue: vi.fn(), listComments: vi.fn(), getWriteOutcome: vi.fn(), syncApprovals: vi.fn(),
    onChange: vi.fn(async (callback, options) => { hooks.push({ callback, options }); }),
    intentFormat: vi.fn(),
  };
  for (const w of WRITES) s[w] = vi.fn(async () => { throw new Error("write reached the session"); });
  commit([["meta/workflow", WORKFLOW], ...PROJECTS.map((p) => /** @type {[string, unknown]} */ ([`project/${p.id}`, p]))]);
  commit(issues.map((i) => [`issue/${i.id}`, i]));
  return s;
}

export function memoryKv() {
  const m = new Map();
  return { get: (k) => structuredClone(m.get(k)), put: (k, v) => { m.set(k, structuredClone(v)); } };
}

/**
 * The browser's view of the gadget: the real read-only proxy (with a real PokeLog behind the
 * hook), plus a host assertion spy.
 */
export function fakeGadget(session) {
  const pokes = new PokeLog(memoryKv());
  const hook = { poked: (p) => pokes.poked(p), changed: () => pokes.nudge(), resync: () => pokes.nudge() };
  const proxy = createReadOnlyProxy(() => (session ? { RECORDS: session } : {}), pokes, async () => hook);
  return { ...proxy, pokes, $createViewerAssertion: vi.fn() };
}
