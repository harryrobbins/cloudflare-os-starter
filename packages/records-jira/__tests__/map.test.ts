import { IssueQuerySchema, compareIssues, evaluateIssueQuery, type Issue, type JournalEntry } from "@records/contracts";
import { describe, expect, it } from "vitest";

import {
  buildCommentCreated,
  buildIssueCreated,
  buildIssueUpdated,
  changelogItems,
  fieldSelector,
  issueToJira,
  jiraDate,
  parseCreateIssue,
  parseEditIssue,
  priorityFromJira,
  signWebhook,
  statusCategoryFromJira,
  transitionsToJira,
  verifyWebhookSignature,
  type InboundContext,
  type JiraIssue,
  type MapContext,
  type WebhookContext,
} from "../src/index.js";
import { ALICE, BOB, CUSTOM_FIELDS, ENG_ID, OPS_ID, createFakePort } from "./support/fake-port.js";

const fake = createFakePort();
const states = fake.workflow.states;
const mapCtx = (version: 2 | 3): MapContext => ({
  version,
  baseUrl: "https://h.test/jira",
  projects: new Map(fake.projects.map((p) => [p.id, p])),
  states: new Map(states.map((s) => [s.key, s])),
  customFields: CUSTOM_FIELDS,
});
const inCtx = (version: 2 | 3): InboundContext => ({ version, projects: fake.projects, members: fake.members, customFields: CUSTOM_FIELDS, states });

const issue: JiraIssue = {
  id: "bbbbbbbb-0000-4000-8000-000000000001",
  projectId: ENG_ID,
  number: 7,
  key: "ENG-7",
  title: "Fix login",
  description: "Steps:\n\n1. open **app**",
  state: "in_progress",
  priority: "urgent",
  assignee: BOB,
  customFields: { story_points: 3, team: "Core", unknown_key: "ignored" },
  revision: 4,
  createdAt: "2026-09-20T08:00:00.000Z",
  updatedAt: "2026-09-21T08:00:00.000Z",
  createdBy: ALICE,
  updatedBy: BOB,
  jiraId: 30007,
};

describe("vocabularies", () => {
  it("priorities and status categories", () => {
    expect(["Highest", "high", "3", "LOW", "Lowest", "5", "none"].map(priorityFromJira)).toEqual(["urgent", "high", "medium", "low", "low", "low", null]);
    expect(["To Do", "new", "2", "In Progress", "indeterminate", "4", "done", "3", "todo", "nope"].map(statusCategoryFromJira)).toEqual([
      "todo", "todo", "todo", "in_progress", "in_progress", "in_progress", "done", "done", "todo", null,
    ]);
    expect(jiraDate("2026-09-20T08:00:00Z")).toBe("2026-09-20T08:00:00.000+0000");
  });
});

describe("outbound mapping", () => {
  it("issue in v2 and v3", () => {
    const v2 = issueToJira(mapCtx(2), issue, fieldSelector(undefined, "*all")) as any;
    expect(v2).toMatchObject({ id: "30007", key: "ENG-7", self: "https://h.test/jira/rest/api/2/issue/30007" });
    expect(v2.fields).toMatchObject({
      summary: "Fix login",
      description: "Steps:\n\n1. open **app**",
      status: { id: "10002", name: "In progress", statusCategory: { id: 4, key: "indeterminate", colorName: "yellow", name: "In Progress" } },
      priority: { id: "1", name: "Highest" },
      assignee: { accountId: BOB.id, displayName: "Bob Brown", active: true },
      project: { id: "10000", key: "ENG" },
      customfield_10020: 3,
      customfield_10021: { value: "Core", id: "1" },
      customfield_10022: null,
    });
    expect(Object.keys(v2.fields)).not.toContain("unknown_key");
    const v3 = issueToJira(mapCtx(3), issue, fieldSelector(["description"], "none")) as any;
    expect(v3.fields).toEqual({
      description: {
        type: "doc",
        version: 1,
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Steps:" }] },
          { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "open " }, { type: "text", text: "app", marks: [{ type: "strong" }] }] }] }] },
        ],
      },
    });
  });

  it("field selection", () => {
    const sel = fieldSelector(["*navigable,-summary", "comment"], "none");
    expect(["summary", "status", "comment", "customfield_10020"].map(sel)).toEqual([false, true, true, true]);
    expect(fieldSelector([], "none")("summary")).toBe(false);
    expect(fieldSelector(undefined, "*all")("comment")).toBe(true);
  });

  it("transitions", () => {
    const t = transitionsToJira(mapCtx(3), "in_progress", fake.workflow);
    expect(t.transitions.map((x) => [x.id, x.name])).toEqual([["10001", "To do"], ["10003", "In review"]]);
  });
});

describe("inbound mapping", () => {
  it("create payload → CreateIssueInput", () => {
    expect(
      parseCreateIssue(
        {
          fields: {
            project: { id: "10001" },
            summary: "S",
            description: "d",
            issuetype: { id: "10001" },
            priority: { id: "4" },
            assignee: { accountId: ALICE.id },
            customfield_10020: 2.5,
            customfield_10021: { id: "2" },
            customfield_10022: "note",
            components: [],
          },
        },
        inCtx(2),
      ),
    ).toEqual({ projectId: OPS_ID, title: "S", description: "d", priority: "low", assigneeId: ALICE.id, customFields: { story_points: 2.5, team: "Edge", notes: "note" } });
  });

  it("type errors per custom field and v2 rich text", () => {
    try {
      parseCreateIssue({ fields: { project: { key: "ENG" }, summary: "S", description: { type: "doc" }, customfield_10020: "3", customfield_10021: { value: "Nope" } } }, inCtx(2));
      throw new Error("expected failure");
    } catch (err: any) {
      expect(err.status).toBe(400);
      expect(err.body.errors).toEqual({
        description: "Operation value must be a string",
        customfield_10020: "Operation value must be a number",
        customfield_10021: "Option value 'Nope' is not valid",
      });
    }
  });

  it("edit payload with update ops", () => {
    expect(parseEditIssue({ update: { summary: [{ set: "T" }], assignee: [{ set: null }] } }, inCtx(3))).toEqual({ title: "T", assigneeId: null });
    expect(parseEditIssue({ fields: { issuetype: { name: "task" } } }, inCtx(3))).toEqual({});
  });
});

describe("IssueQuery reference semantics", () => {
  const base: Issue = { ...issue };
  const ctx = { categoryOf: (s: string) => states.find((x) => x.key === s)?.category ?? null, projectKeyOf: (id: string) => (id === ENG_ID ? "ENG" : null) };

  it("evaluates predicates the Jira way", () => {
    const yes = (where: any, i: Issue = base) => evaluateIssueQuery(where, i, ctx);
    expect(yes({ type: "pred", field: "project", op: "=", values: ["ENG"] })).toBe(true);
    expect(yes({ type: "pred", field: "statusCategory", op: "=", values: ["in_progress"] })).toBe(true);
    expect(yes({ type: "pred", field: "assignee", op: "!=", values: [ALICE.id] })).toBe(true);
    expect(yes({ type: "pred", field: "assignee", op: "!=", values: [ALICE.id] }, { ...base, assignee: null })).toBe(false);
    expect(yes({ type: "pred", field: "priority", op: "is_empty", values: [] }, { ...base, priority: "none" })).toBe(true);
    expect(yes({ type: "pred", field: "priority", op: "!=", values: ["low"] }, { ...base, priority: "none" })).toBe(false);
    expect(yes({ type: "pred", field: "text", op: "~", value: "LOGIN fix", in: "title" })).toBe(true);
    expect(yes({ type: "pred", field: "text", op: "~", value: "app", in: "title" })).toBe(false);
    expect(yes({ type: "pred", field: "created", op: "<", value: "2026-09-21T00:00:00Z" })).toBe(true);
    expect(yes({ type: "pred", field: "key", op: "in", values: [] })).toBe(false);
    expect(yes({ type: "pred", field: "key", op: "not_in", values: [] })).toBe(true);
    expect(yes({ type: "not", clause: { type: "or", clauses: [{ type: "pred", field: "status", op: "=", values: ["done"] }] } })).toBe(true);
  });

  it("orders with priority desc = most urgent first and a stable tiebreak", () => {
    const a = { ...base, id: "a", key: "ENG-10", priority: "low" as const };
    const b = { ...base, id: "b", key: "ENG-9", priority: "urgent" as const };
    const c = { ...base, id: "c", key: "OPS-1", priority: "none" as const };
    expect([a, b, c].sort(compareIssues([{ field: "priority", direction: "desc" }])).map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect([c, a, b].sort(compareIssues([{ field: "key", direction: "asc" }])).map((x) => x.key)).toEqual(["ENG-9", "ENG-10", "OPS-1"]);
  });

  it("schema bounds", () => {
    const deep = (n: number): any => (n === 0 ? { type: "pred", field: "key", op: "=", values: ["ENG-1"] } : { type: "not", clause: deep(n - 1) });
    expect(IssueQuerySchema.safeParse({ where: deep(11), orderBy: [] }).success).toBe(true);
    expect(IssueQuerySchema.safeParse({ where: deep(12), orderBy: [] }).success).toBe(false);
    expect(IssueQuerySchema.safeParse({ where: { type: "pred", field: "created", op: "<", value: "yesterday" }, orderBy: [] }).success).toBe(false);
    expect(IssueQuerySchema.safeParse({ where: null, orderBy: [{ field: "rank", direction: "asc" }] }).success).toBe(false);
  });
});

describe("webhooks", () => {
  const whCtx: WebhookContext = { ...mapCtx(2), principal: (id) => [ALICE, BOB].find((p) => p.id === id) ?? null };

  it("issue_created", () => {
    const p = buildIssueCreated({ ctx: whCtx, issue, actor: ALICE, timestamp: "2026-09-20T08:00:00.000Z" }) as any;
    expect(p).toMatchObject({ webhookEvent: "jira:issue_created", issue_event_type_name: "issue_created", timestamp: Date.parse("2026-09-20T08:00:00.000Z"), user: { accountId: ALICE.id } });
    expect(p.issue.fields.description).toBe(issue.description);
  });

  it("issue_updated changelog from a journal entry", () => {
    const entry: JournalEntry = {
      seq: 41, ordinal: 2, changeId: "cccccccc-0000-4000-8000-000000000001", command: "projects.editIssue",
      entityType: "issue", entityId: issue.id, entityRev: 5, op: "update",
      before: { title: "Old", state: "todo", priority: "none", assigneeId: null, customFields: { story_points: 1, team: "Core" } },
      after: { title: "Fix login", state: "in_progress", priority: "urgent", assigneeId: BOB.id, customFields: { story_points: 3, team: "Core" } },
      actorId: ALICE.id, actId: null, via: "jira", occurredAt: "2026-09-21T08:00:00.000Z",
    };
    const p = buildIssueUpdated({ ctx: whCtx, issue, entry }) as any;
    expect(p).toMatchObject({ webhookEvent: "jira:issue_updated", issue_event_type_name: "issue_updated", changelog: { id: "41002" }, user: { displayName: "Alice Adams" } });
    expect(p.changelog.items).toEqual([
      { field: "summary", fieldtype: "jira", fieldId: "summary", from: null, fromString: "Old", to: null, toString: "Fix login" },
      { field: "status", fieldtype: "jira", fieldId: "status", from: "10001", fromString: "To do", to: "10002", toString: "In progress" },
      { field: "priority", fieldtype: "jira", fieldId: "priority", from: null, fromString: null, to: "1", toString: "Highest" },
      { field: "assignee", fieldtype: "jira", fieldId: "assignee", from: null, fromString: null, to: BOB.id, toString: "Bob Brown" },
      { field: "Story points", fieldtype: "custom", fieldId: "customfield_10020", from: null, fromString: "1", to: null, toString: "3" },
    ]);
    const transition = buildIssueUpdated({ ctx: whCtx, issue, entry: { ...entry, before: { state: "todo" }, after: { state: "in_progress" } } });
    expect(transition.issue_event_type_name).toBe("issue_generic");
    expect(changelogItems({ before: { assignee: null }, after: { assignee: ALICE } }, whCtx)[0]).toMatchObject({ to: ALICE.id, toString: "Alice Adams" });
    expect(buildIssueUpdated({ ctx: whCtx, issue, entry: { ...entry, before: { assigneeId: null }, after: { assigneeId: ALICE.id } } }).issue_event_type_name).toBe("issue_assigned");
  });

  it("comment_created", () => {
    const p = buildCommentCreated({ ctx: whCtx, issue, comment: { id: "c", issueId: issue.id, body: "Hi", author: BOB, createdAt: "2026-09-22T08:00:00.000Z", jiraId: 50 } }) as any;
    expect(p).toMatchObject({ webhookEvent: "comment_created", comment: { id: "50", body: "Hi", author: { accountId: BOB.id } }, issue: { key: "ENG-7", id: "30007" } });
    expect(Object.keys(p.issue.fields).sort()).toEqual(["assignee", "issuetype", "priority", "project", "status", "summary"]);
  });

  it("X-Hub-Signature", async () => {
    const body = JSON.stringify({ a: 1 });
    const sig = await signWebhook("s3cret", body);
    // HMAC-SHA256("s3cret", '{"a":1}'), checked against node:crypto.
    const { createHmac } = await import("node:crypto");
    expect(sig).toBe(`sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`);
    expect(await verifyWebhookSignature("s3cret", body, sig)).toBe(true);
    expect(await verifyWebhookSignature("other", body, sig)).toBe(false);
    expect(await verifyWebhookSignature("s3cret", body, null)).toBe(false);
    expect(await verifyWebhookSignature("s3cret", new TextEncoder().encode(body), sig)).toBe(true);
  });
});
