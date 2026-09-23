import { describe, expect, it } from "vitest";
import { allowedTargets, capabilities, columns, conflictingFields, loadAllIssues, mergeIssue, missingScopes, replaceIssues } from "../src/client/model.js";
import { FakeRecords, WORKFLOW } from "./fake-records.js";

const issue = (id, revision, extra = {}) => ({ id, revision, number: 1, key: id, title: id, state: "todo", priority: "none", assignee: null, ...extra });

describe("model", () => {
  it("ignores obsolete revisions", () => {
    const m = new Map();
    expect(mergeIssue(m, issue("a", 3))).toBe(true);
    expect(mergeIssue(m, issue("a", 2, { title: "old" }))).toBe(false);
    expect(mergeIssue(m, issue("a", 3, { title: "dup" }))).toBe(false);
    expect(m.get("a").revision).toBe(3);
    const next = replaceIssues(m, [issue("a", 1), issue("b", 1)]);
    expect(next.get("a").revision).toBe(3);
    expect([...next.keys()]).toEqual(["a", "b"]);
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

  it("pages through issues", async () => {
    const records = new FakeRecords({ issues: 230 });
    const { items, truncated } = await loadAllIssues((i) => records.listIssues(i), "prj-1");
    expect(items).toHaveLength(230);
    expect(truncated).toBe(false);
    expect(records.calls.filter((c) => c.name === "listIssues")).toHaveLength(3);
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
