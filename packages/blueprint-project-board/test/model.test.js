import { describe, expect, it } from "vitest";
import { allowedTargets, capabilities, columns, commentsIn, conflictingFields, isProvisional, issuesIn, missingScopes, projectsIn } from "../src/client/model.js";

const issue = (id, revision, extra = {}) => ({ id, revision, number: 1, key: id, title: id, state: "todo", priority: "none", assignee: null, ...extra });

const WORKFLOW = {
  states: [
    { key: "todo", name: "To do", category: "todo", position: 1 },
    { key: "doing", name: "In progress", category: "in_progress", position: 2 },
    { key: "done", name: "Done", category: "done", position: 3 },
  ],
  transitions: [{ from: "todo", to: "doing" }, { from: "doing", to: "todo" }, { from: "doing", to: "done" }, { from: "done", to: "doing" }],
};

describe("model", () => {
  it("reads projects, issues and comments from the synced view", () => {
    const entries = new Map([
      ["project/b", { id: "b", key: "OPS" }], ["project/a", { id: "a", key: "ENG" }],
      ["issue/1", issue("1", 1, { projectId: "a" })], ["issue/2", issue("2", 1, { projectId: "b" })],
      ["comment/y", { id: "y", issueId: "1", createdAt: "2026-09-02" }], ["comment/x", { id: "x", issueId: "1", createdAt: "2026-09-01" }],
      ["comment/z", { id: "z", issueId: "2", createdAt: "2026-09-01" }],
    ]);
    const view = { get: (k) => entries.get(k), scan: (p) => [...entries].filter(([k]) => k.startsWith(p)).toSorted(([x], [y]) => (x < y ? -1 : 1)) };
    expect(projectsIn(view).map((p) => p.key)).toEqual(["ENG", "OPS"]);
    expect([...issuesIn(view, "a").keys()]).toEqual(["1"]);
    expect(commentsIn(view, "1").map((c) => c.id)).toEqual(["x", "y"]);
  });

  it("puts unnumbered local creates after numbered issues", () => {
    const cols = columns(WORKFLOW, [issue("new", 1, { number: 0, key: "ENG-?" }), issue("b", 1, { number: 2 }), issue("a", 1, { number: 1 })]);
    expect(cols[0].issues.map((i) => i.id)).toEqual(["a", "b", "new"]);
    expect(isProvisional({ number: 0 })).toBe(true);
    expect(isProvisional({ number: 3 })).toBe(false);
  });

  it("offers only workflow transitions", () => {
    expect(allowedTargets(WORKFLOW, "todo").map((s) => s.key)).toEqual(["doing"]);
    expect(allowedTargets(WORKFLOW, "doing").map((s) => s.key)).toEqual(["todo", "done"]);
  });

  it("groups by state and keeps unknown states visible", () => {
    const cols = columns(WORKFLOW, [issue("a", 1), issue("b", 1, { state: "gone" })]);
    expect(cols.map((c) => c.state.key)).toEqual(["todo", "doing", "done", "__other"]);
    expect(cols[3].issues.map((i) => i.id)).toEqual(["b"]);
  });

  it("derives capabilities from scopes and lifecycle", () => {
    const binding = { scopes: ["projects.read", "issues.read", "issues.edit"], datastore: { lifecycle: "active" } };
    expect(capabilities(binding)).toEqual({ read: true, create: false, edit: true, transition: false, comment: false });
    expect(capabilities({ ...binding, datastore: { lifecycle: "archived" } }).edit).toBe(false);
    expect(missingScopes({ scopes: ["issues.read", "issues.create"] }, binding)).toEqual(["issues.create"]);
  });

  it("lists conflicting fields", () => {
    const current = issue("a", 4, { title: "Theirs", assignee: { id: "p-bob" } });
    expect(conflictingFields({ title: "Mine", assigneeId: "p-bob" }, current)).toEqual([{ field: "title", yours: "Mine", theirs: "Theirs" }]);
  });
});
