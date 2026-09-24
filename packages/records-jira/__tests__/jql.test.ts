import { IssueQuerySchema } from "@records/contracts";
import { describe, expect, it } from "vitest";

import { JqlError, parseJql, resolverFromLookups, tokenize, type JqlContext } from "../src/index.js";
import { ALICE, BOB, ENG_ID, OPS_ID, STATE_JIRA_IDS } from "./support/fake-port.js";

const NOW = new Date("2026-09-24T15:30:00.000Z"); // a Thursday

function ctx(me: string | null = ALICE.id): JqlContext {
  return {
    now: NOW,
    resolver: resolverFromLookups({
      me,
      projects: [
        { id: ENG_ID, key: "ENG", name: "Engineering", jiraId: 10000 },
        { id: OPS_ID, key: "OPS", name: "Operations", jiraId: 10001 },
      ],
      states: [
        { key: "backlog", name: "Backlog", jiraId: STATE_JIRA_IDS.backlog! },
        { key: "todo", name: "To do", jiraId: STATE_JIRA_IDS.todo! },
        { key: "in_progress", name: "In progress", jiraId: STATE_JIRA_IDS.in_progress! },
        { key: "done", name: "Done", jiraId: STATE_JIRA_IDS.done! },
      ],
      members: [{ id: ALICE.id }, { id: BOB.id }],
    }),
  };
}

const where = (jql: string, c = ctx()) => parseJql(jql, c).where;

function error(jql: string, c = ctx()): string {
  try {
    parseJql(jql, c);
  } catch (err) {
    expect(err).toBeInstanceOf(JqlError);
    const e = err as JqlError;
    expect(e.status).toBe(400);
    expect(e.body.errors).toEqual({});
    expect(e.body.errorMessages).toHaveLength(1);
    return e.body.errorMessages[0]!;
  }
  throw new Error(`expected ${jql} to fail`);
}

describe("tokenizer", () => {
  it("handles quotes, escapes, operators and symbols", () => {
    const toks = tokenize(`summary ~ "a \\"b\\"" AND status != 'In progress' && x<=-7d || !(y)`);
    expect(toks.map((t) => [t.kind, t.value])).toEqual([
      ["word", "summary"], ["op", "~"], ["str", 'a "b"'], ["word", "AND"], ["word", "status"], ["op", "!="],
      ["str", "In progress"], ["&", "&&"], ["word", "x"], ["op", "<="], ["word", "-7d"], ["|", "||"], ["!", "!"],
      ["(", "("], ["word", "y"], [")", ")"], ["eof", ""],
    ]);
  });
});

describe("parseJql: fields and values", () => {
  it("empty JQL matches everything", () => {
    expect(parseJql("", ctx())).toEqual({ where: null, orderBy: [] });
    expect(parseJql("   ", ctx())).toEqual({ where: null, orderBy: [] });
  });

  it("project by key, lower-case key, id and name", () => {
    expect(where("project = ENG")).toEqual({ type: "pred", field: "project", op: "=", values: [ENG_ID] });
    expect(where("project = eng")).toEqual({ type: "pred", field: "project", op: "=", values: [ENG_ID] });
    expect(where("project = 10001")).toEqual({ type: "pred", field: "project", op: "=", values: [OPS_ID] });
    expect(where('project in ("Engineering", OPS)')).toEqual({ type: "pred", field: "project", op: "in", values: [ENG_ID, OPS_ID] });
    expect(where("PROJECT not in (ENG)")).toEqual({ type: "pred", field: "project", op: "not_in", values: [ENG_ID] });
  });

  it("key and its aliases", () => {
    expect(where("key = eng-12")).toEqual({ type: "pred", field: "key", op: "=", values: ["ENG-12"] });
    expect(where("issuekey in (ENG-1, ENG-2, ENG-1)")).toEqual({ type: "pred", field: "key", op: "in", values: ["ENG-1", "ENG-2"] });
    expect(where("issue != OPS-3")).toEqual({ type: "pred", field: "key", op: "!=", values: ["OPS-3"] });
  });

  it("status by name, key and id; statusCategory by name, key and id", () => {
    expect(where('status = "In Progress"')).toEqual({ type: "pred", field: "status", op: "=", values: ["in_progress"] });
    expect(where(`status in (Backlog, ${STATE_JIRA_IDS.done}, todo)`)).toEqual({ type: "pred", field: "status", op: "in", values: ["backlog", "done", "todo"] });
    expect(where('statusCategory = "To Do"')).toEqual({ type: "pred", field: "statusCategory", op: "=", values: ["todo"] });
    expect(where("statusCategory in (indeterminate, 3)")).toEqual({ type: "pred", field: "statusCategory", op: "in", values: ["in_progress", "done"] });
    expect(where("statuscategory != Done")).toEqual({ type: "pred", field: "statusCategory", op: "!=", values: ["done"] });
  });

  it("assignee with accountId, currentUser() and EMPTY", () => {
    expect(where(`assignee = ${BOB.id}`)).toEqual({ type: "pred", field: "assignee", op: "=", values: [BOB.id] });
    expect(where("assignee = currentUser()")).toEqual({ type: "pred", field: "assignee", op: "=", values: [ALICE.id] });
    expect(where("assignee is EMPTY")).toEqual({ type: "pred", field: "assignee", op: "is_empty", values: [] });
    expect(where("assignee IS NOT null")).toEqual({ type: "pred", field: "assignee", op: "is_not_empty", values: [] });
    expect(where("assignee = EMPTY")).toEqual({ type: "pred", field: "assignee", op: "is_empty", values: [] });
    expect(where("assignee in (EMPTY, currentUser())")).toEqual({
      type: "or",
      clauses: [
        { type: "pred", field: "assignee", op: "is_empty", values: [] },
        { type: "pred", field: "assignee", op: "in", values: [ALICE.id] },
      ],
    });
    expect(where("assignee not in (EMPTY, currentUser())")).toEqual({
      type: "and",
      clauses: [
        { type: "pred", field: "assignee", op: "is_not_empty", values: [] },
        { type: "pred", field: "assignee", op: "not_in", values: [ALICE.id] },
      ],
    });
  });

  it("currentUser() for an anonymous caller matches nothing", () => {
    expect(where("assignee = currentUser()", ctx(null))).toEqual({ type: "pred", field: "assignee", op: "=", values: [] });
  });

  it("priority names, ids, Lowest alias and EMPTY", () => {
    expect(where("priority = Highest")).toEqual({ type: "pred", field: "priority", op: "=", values: ["urgent"] });
    expect(where("priority in (high, 3, Low, Lowest)")).toEqual({ type: "pred", field: "priority", op: "in", values: ["high", "medium", "low"] });
    expect(where("priority is empty")).toEqual({ type: "pred", field: "priority", op: "is_empty", values: [] });
  });

  it("issuetype reduces to constants", () => {
    expect(where("issuetype = Task")).toEqual({ type: "pred", field: "key", op: "not_in", values: [] });
    expect(where("type != Task")).toEqual({ type: "pred", field: "key", op: "in", values: [] });
    expect(error("issuetype = Bug")).toBe("The value 'Bug' does not exist for the field 'issuetype'.");
  });

  it("text, summary and description containment", () => {
    expect(where('text ~ "login bug"')).toEqual({ type: "pred", field: "text", op: "~", value: "login bug", in: "all" });
    expect(where("summary ~ crash")).toEqual({ type: "pred", field: "text", op: "~", value: "crash", in: "title" });
    expect(where('description !~ "wontfix*"')).toEqual({ type: "pred", field: "text", op: "!~", value: "wontfix", in: "description" });
  });
});

describe("parseJql: dates", () => {
  it("absolute formats", () => {
    expect(where('created >= "2026-09-01"')).toEqual({ type: "pred", field: "created", op: ">=", value: "2026-09-01T00:00:00.000Z" });
    expect(where('created < "2026/09/01 13:45"')).toEqual({ type: "pred", field: "created", op: "<", value: "2026-09-01T13:45:00.000Z" });
    expect(where('updated = "2026-09-01T10:00:00+02:00"')).toEqual({ type: "pred", field: "updated", op: "=", value: "2026-09-01T08:00:00.000Z" });
  });

  it("relative periods", () => {
    expect(where("updated >= -7d")).toEqual({ type: "pred", field: "updated", op: ">=", value: "2026-09-17T15:30:00.000Z" });
    expect(where("created > -2w")).toEqual({ type: "pred", field: "created", op: ">", value: "2026-09-10T15:30:00.000Z" });
    expect(where('created > "-4w 2d"')).toEqual({ type: "pred", field: "created", op: ">", value: "2026-08-25T15:30:00.000Z" });
    expect(where("created > -90m")).toEqual({ type: "pred", field: "created", op: ">", value: "2026-09-24T14:00:00.000Z" });
    expect(where("createdDate <= 1h")).toEqual({ type: "pred", field: "created", op: "<=", value: "2026-09-24T16:30:00.000Z" });
  });

  it("date functions", () => {
    expect(where("created >= startOfDay()")).toMatchObject({ value: "2026-09-24T00:00:00.000Z" });
    expect(where("created >= startOfDay(-1)")).toMatchObject({ value: "2026-09-23T00:00:00.000Z" });
    expect(where("created <= endOfDay()")).toMatchObject({ value: "2026-09-24T23:59:59.999Z" });
    expect(where("created >= startOfWeek()")).toMatchObject({ value: "2026-09-21T00:00:00.000Z" });
    expect(where("created >= startOfWeek()", { ...ctx(), weekStartsOn: 0 })).toMatchObject({ value: "2026-09-20T00:00:00.000Z" });
    expect(where('created >= startOfMonth("-1M")')).toMatchObject({ value: "2026-08-01T00:00:00.000Z" });
    expect(where("created >= startOfYear()")).toMatchObject({ value: "2026-01-01T00:00:00.000Z" });
    expect(where("updated < now()")).toMatchObject({ value: NOW.toISOString() });
  });

  it("rejects bad dates and functions", () => {
    expect(error("created > yesterday")).toMatch(/^Date value 'yesterday' for field 'created' is invalid\. Valid formats include/);
    expect(error('created > "2026-02-30"')).toMatch(/is invalid/);
    expect(error("created > nextTuesday()")).toBe("Unable to find JQL function 'nextTuesday()' for the field 'created'.");
    expect(error("created > now(1)")).toBe("Function 'now' expected '0' arguments but received '1'.");
    expect(error("created ~ -1d")).toBe("The operator '~' is not supported by the 'created' field.");
    expect(error("created is empty")).toBe("The operator 'IS' is not supported by the 'created' field.");
  });
});

describe("parseJql: boolean structure and ordering", () => {
  it("AND binds tighter than OR; parentheses and NOT", () => {
    const q = where("project = ENG AND status = Done OR priority = High");
    expect(q).toEqual({
      type: "or",
      clauses: [
        { type: "and", clauses: [{ type: "pred", field: "project", op: "=", values: [ENG_ID] }, { type: "pred", field: "status", op: "=", values: ["done"] }] },
        { type: "pred", field: "priority", op: "=", values: ["high"] },
      ],
    });
    expect(where("project = ENG and (status = Done or priority = High)")).toMatchObject({
      type: "and",
      clauses: [{ field: "project" }, { type: "or" }],
    });
    expect(where("NOT status = Done")).toEqual({ type: "not", clause: { type: "pred", field: "status", op: "=", values: ["done"] } });
    expect(where("not (assignee is empty) && !priority = low")).toEqual({
      type: "and",
      clauses: [
        { type: "not", clause: { type: "pred", field: "assignee", op: "is_empty", values: [] } },
        { type: "not", clause: { type: "pred", field: "priority", op: "=", values: ["low"] } },
      ],
    });
  });

  it("ORDER BY with defaults and aliases", () => {
    expect(parseJql("project = ENG ORDER BY created DESC, key", ctx()).orderBy).toEqual([
      { field: "created", direction: "desc" },
      { field: "key", direction: "asc" },
    ]);
    expect(parseJql("order by priority, updatedDate asc", ctx())).toEqual({
      where: null,
      orderBy: [{ field: "priority", direction: "desc" }, { field: "updated", direction: "asc" }],
    });
    expect(error("ORDER BY rank")).toBe("Not able to sort using field 'rank'.");
    expect(error("project = ENG ORDER created")).toBe("Error in the JQL Query: Expecting 'BY' but got 'created'. (line 1, character 21)");
  });

  it("output satisfies the IssueQuery schema", () => {
    const q = parseJql(
      'project in (ENG, OPS) AND (assignee = currentUser() OR assignee is EMPTY) AND NOT statusCategory = Done AND text ~ "x" AND updated > -1w ORDER BY priority DESC, updated DESC',
      ctx(),
    );
    expect(IssueQuerySchema.safeParse(q).success).toBe(true);
  });
});

describe("parseJql: Jira-shaped errors", () => {
  it("unknown and unsupported fields", () => {
    expect(error("foo = bar")).toBe("Field 'foo' does not exist or you do not have permission to view it.");
    expect(error("labels = x")).toMatch(/^Field 'labels' is not supported by this Jira-compatible API\./);
    expect(error("cf[10020] > 3")).toMatch(/^Field 'cf\[10020\]' is not supported/);
    expect(error("sprint in openSprints()")).toMatch(/^Field 'sprint' is not supported/);
  });

  it("unknown values", () => {
    expect(error("project = NOPE")).toBe("The value 'NOPE' does not exist for the field 'project'.");
    expect(error('status = "Frozen"')).toBe("The value 'Frozen' does not exist for the field 'status'.");
    expect(error("priority = Critical")).toBe("The value 'Critical' does not exist for the field 'priority'.");
    expect(error("assignee = someone-else")).toBe("The value 'someone-else' does not exist for the field 'assignee'.");
    expect(error("statusCategory = Blocked")).toBe("The value 'Blocked' does not exist for the field 'statusCategory'.");
    expect(error("key = 12")).toBe("The issue key '12' for field 'key' is invalid.");
  });

  it("unsupported operators and functions", () => {
    expect(error("project ~ ENG")).toBe("The operator '~' is not supported by the 'project' field.");
    expect(error("summary = x")).toBe("The operator '=' is not supported by the 'summary' field.");
    expect(error("priority > Medium")).toBe("The operator '>' is not supported by the 'priority' field.");
    expect(error("status is empty")).toBe("The operator 'IS' is not supported by the 'status' field.");
    expect(error("status was Done")).toBe("The operator 'WAS' is not supported by this Jira-compatible API.");
    expect(error("assignee in membersOf(devs)")).toBe("Unable to find JQL function 'membersOf()' for the field 'assignee'.");
    expect(error("status = currentUser()")).toBe("Unable to find JQL function 'currentUser()' for the field 'status'.");
    expect(error("project = EMPTY")).toBe("The field 'project' does not support searching for EMPTY values.");
  });

  it("syntax errors carry positions", () => {
    expect(error('summary ~ "abc')).toBe("Error in the JQL Query: The quoted string 'abc' has not been completed. (line 1, character 11)");
    expect(error("project ENG")).toBe(
      "Error in the JQL Query: Expecting operator but got 'ENG'. The valid operators are '=', '!=', '<', '>', '<=', '>=', '~', '!~', 'IN', 'NOT IN', 'IS' and 'IS NOT'. (line 1, character 9)",
    );
    expect(error("project =")).toBe("Error in the JQL Query: Expecting either a value, list or function before the end of the query.");
    expect(error("(project = ENG")).toBe("Error in the JQL Query: Expecting ')' before the end of the query.");
    expect(error("project = ENG status = Done")).toBe("Error in the JQL Query: Expecting either 'OR' or 'AND' but got 'status'. (line 1, character 15)");
    expect(error("project = ENG AND")).toBe("Error in the JQL Query: Expecting a field name before the end of the query.");
    expect(error("project = )")).toMatch(/^Error in the JQL Query: Expecting either a value, list or function but got '\)'/);
    expect(error("project = ENG\nAND ) ")).toMatch(/\(line 2, character 5\)$/);
  });

  it("bounds", () => {
    expect(error("x".repeat(5000))).toMatch(/too long/);
    expect(error(`${"(".repeat(40)}project = ENG${")".repeat(40)}`)).toMatch(/too complex/);
    expect(error(`${"NOT ".repeat(40)}project = ENG`)).toMatch(/too complex/);
    const many = Array.from({ length: 101 }, (_, i) => `ENG-${i + 1}`).join(",");
    expect(error(`key in (${many})`)).toMatch(/at most 100 values/);
    const wide = Array.from({ length: 201 }, () => "project = ENG").join(" OR ");
    expect(error(wide)).toMatch(/too complex/);
  });
});
