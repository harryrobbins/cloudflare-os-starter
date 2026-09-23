import { describe, expect, it } from "vitest";
import { csvCell, filterIssues, loadIssues, recentlyUpdated, summarise, toCsv } from "../src/client/report.js";
import { WORKFLOW, fakeSession, makeIssues } from "./fake.js";
import REQUIREMENT from "../src/service-requirement.json";
import { ServiceRequirementSchema } from "../../records-contracts/src/manifest.ts";

describe("report logic", () => {
  it("requests only read scopes", () => {
    expect(ServiceRequirementSchema.parse(REQUIREMENT).scopes).toEqual(["projects.read", "issues.read"]);
  });

  it("summarises counts", () => {
    const s = summarise(makeIssues(), WORKFLOW);
    expect({ total: s.total, open: s.open, done: s.done, unassignedOpen: s.unassignedOpen }).toEqual({ total: 6, open: 4, done: 2, unassignedOpen: 1 });
    expect(s.byState.map((r) => [r.label, r.count])).toEqual([["To do", 3], ["In progress", 1], ["Done", 2]]);
    expect(s.byPriority.map((r) => r.count)).toEqual([1, 1, 1, 1, 2]);
    expect(s.byAssignee.map((r) => [r.label, r.count])).toEqual([["Alice", 2], ["Bob", 2], ["Unassigned", 2]]);
  });

  it("filters by view", () => {
    const issues = makeIssues();
    expect(filterIssues(issues, { projectId: "prj-2", state: "", priority: "", assigneeId: "" }).map((i) => i.id)).toEqual(["i5", "i6"]);
    expect(filterIssues(issues, { projectId: "", state: "", priority: "", assigneeId: "none" }).map((i) => i.id)).toEqual(["i2", "i6"]);
    expect(recentlyUpdated(issues, 2).map((i) => i.id)).toEqual(["i6", "i5"]);
  });

  it("pages through all issues", async () => {
    const session = fakeSession({ issues: Array.from({ length: 250 }, (_, n) => ({ ...makeIssues()[0], id: `x${n}`, updatedAt: `2026-09-01T00:00:${String(n % 60).padStart(2, "0")}Z` })) });
    const { items, truncated } = await loadIssues(session.listIssues);
    expect(items).toHaveLength(250);
    expect(truncated).toBe(false);
  });

  it("writes safe CSV", () => {
    expect(csvCell('He said "hi", then left')).toBe('"He said ""hi"", then left"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    const csv = toCsv(makeIssues().slice(0, 1), [{ id: "prj-1", name: "Engineering" }], WORKFLOW);
    expect(csv.split("\r\n")[0]).toBe("Key,Title,Project,State,Priority,Assignee,Created,Updated,Updated by");
    expect(csv.split("\r\n")[1]).toBe("ENG-1,Issue 1,Engineering,To do,High,Alice,2026-09-01T09:00:00Z,2026-09-11T09:00:00Z,Alice");
  });
});
