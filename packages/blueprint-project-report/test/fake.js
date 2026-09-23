// A minimal read-only-friendly RecordsSession. Its write methods exist (a real session has them)
// but record every call, so tests can prove the report never reaches them.
import { vi } from "vitest";
import { ChangeFeed } from "../src/server/feed.js";
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

export const WRITES = ["createIssue", "editIssue", "transitionIssue", "addComment"];

export function fakeSession({ issues = makeIssues(), scopes = ["projects.read", "issues.read"], readError = null } = {}) {
  const s = {
    readError,
    reads: [],
    describe: async () => { if (s.readError) throw s.readError; return { datastore: { id: "ds", name: "Engineering", description: "", lifecycle: "active" }, moduleId: "projects", apiMajor: 1, scopes }; },
    listProjects: async () => { s.reads.push("listProjects"); return [{ id: "prj-1", key: "ENG", name: "Engineering" }, { id: "prj-2", key: "OPS", name: "Operations" }]; },
    getWorkflow: async () => { s.reads.push("getWorkflow"); return WORKFLOW; },
    listIssues: async (input = {}) => {
      s.reads.push("listIssues");
      const sorted = [...issues].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const start = Number(input.cursor ?? 0), limit = input.limit ?? 50;
      return { items: sorted.slice(start, start + limit), nextCursor: start + limit < sorted.length ? String(start + limit) : null };
    },
    getIssue: vi.fn(), listComments: vi.fn(), getWriteOutcome: vi.fn(), onChange: vi.fn(async () => {}),
    intentFormat: vi.fn(),
  };
  for (const w of WRITES) s[w] = vi.fn(async () => { throw new Error("write reached the session"); });
  return s;
}

export function memoryKv() {
  const m = new Map();
  return { get: (k) => structuredClone(m.get(k)), put: (k, v) => { m.set(k, structuredClone(v)); } };
}

/** The browser's view of the gadget: the real read-only proxy, plus a host assertion spy. */
export function fakeGadget(session) {
  const proxy = createReadOnlyProxy(() => (session ? { RECORDS: session } : {}), new ChangeFeed(memoryKv()), async () => ({ stub: true }));
  return { ...proxy, $createViewerAssertion: vi.fn() };
}
