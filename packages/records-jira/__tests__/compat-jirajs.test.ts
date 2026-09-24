// Client compatibility: the real jira.js (6.x, `createCloudClient`) against handleJira served by a
// local node:http server, with every response validated against jira.js's own schemas
// (`onSchemaMismatch: "throw"`). jira.js 6 has no Version2Client/Version3Client: it is one v3
// surface that routes string rich text through v2 (see COMPATIBILITY.md).

import { createCloudClient } from "jira.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ALICE, BOB, STATE_JIRA_IDS, createFakePort } from "./support/fake-port.js";
import { serve } from "./support/http.js";

const fake = createFakePort();
const log: string[] = [];
let server: Awaited<ReturnType<typeof serve>>;
let jira: ReturnType<typeof createCloudClient>;

beforeAll(async () => {
  server = await serve(fake.port, {}, log);
  jira = createCloudClient({
    host: server.url,
    auth: { type: "basic", email: "alice@example.test", apiToken: "not-a-real-token" },
    onSchemaMismatch: "throw",
  });
});

afterAll(async () => {
  await server.close();
  // The request log is the evidence behind COMPATIBILITY.md.
  if (process.env.JIRA_COMPAT_LOG) console.log(log.join("\n"));
  // With AUDIT_SCHEMAS=true jira.js validates strictly and records keys its schemas do not model.
  const drift = (globalThis as Record<symbol, unknown>)[Symbol.for("apis-code-gen.schemaAudit")];
  if (process.env.AUDIT_SCHEMAS === "true") console.log(JSON.stringify(drift ?? [], null, 1));
});

const doc = (text: string) => ({ type: "doc" as const, version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

describe("jira.js 6 (cloud client) against the router", () => {
  it("serverInfo, myself, users", async () => {
    const info = await jira.serverInfo.getServerInfo();
    expect(info.deploymentType).toBe("Cloud");
    const me = await jira.myself.getCurrentUser();
    expect(me).toMatchObject({ accountId: ALICE.id, displayName: "Alice Adams", active: true });
    const found = await jira.userSearch.findUsers({ query: "bob" });
    expect(found.map((u) => u.accountId)).toEqual([BOB.id]);
    const user = await jira.users.getUser({ accountId: BOB.id });
    expect(user.displayName).toBe("Bob Brown");
    const assignable = await jira.userSearch.findAssignableUsers({ project: "ENG" });
    expect(assignable.length).toBeGreaterThan(0);
  });

  it("projects, fields, priorities, statuses, issue types", async () => {
    const page = await jira.projects.searchProjects();
    expect(page.values.map((p) => p.key)).toEqual(["ENG", "OPS"]);
    const eng = await jira.projects.getProject({ projectIdOrKey: "ENG" });
    expect(eng).toMatchObject({ id: "10000", key: "ENG", name: "Engineering" });
    const fields = await jira.issueFields.getFields();
    expect(fields.map((f) => f.id)).toEqual(expect.arrayContaining(["summary", "status", "customfield_10020"]));
    const priorities = await jira.issuePriorities.searchPriorities();
    expect(priorities.values.map((p) => p.name)).toEqual(["Highest", "High", "Medium", "Low"]);
    const statuses = await jira.workflowStatuses.getStatuses();
    expect(statuses).toHaveLength(5);
    const types = await jira.issueTypes.getIssueAllTypes();
    expect(types.map((t) => t.name)).toEqual(["Task"]);
    const meta = await jira.issues.getCreateIssueMetaIssueTypes({ projectIdOrKey: "ENG" });
    expect(meta.issueTypes?.map((t) => t.name)).toEqual(["Task"]);
  });

  it("create (ADF), get, edit, assign, transition, comment", async () => {
    const created = await jira.issues.createIssue({
      fields: {
        project: { key: "ENG" },
        issuetype: { name: "Task" },
        summary: "Created by jira.js",
        description: doc("An ADF description"),
        priority: { name: "Medium" },
        customfield_10020: 8,
      },
    });
    expect(created).toMatchObject({ key: "ENG-1" });

    const issue = await jira.issues.getIssue({ issueIdOrKey: created.key });
    expect(issue.fields).toMatchObject({ summary: "Created by jira.js", description: doc("An ADF description"), priority: { name: "Medium" }, customfield_10020: 8 });

    await jira.issues.editIssue({ issueIdOrKey: created.key, fields: { summary: "Edited by jira.js", description: doc("Changed") } });
    await jira.issues.assignIssue({ issueIdOrKey: created.key, accountId: BOB.id });
    const edited = await jira.issues.getIssue({ issueIdOrKey: created.key, fields: ["summary", "assignee"] });
    expect(edited.fields).toEqual({ summary: "Edited by jira.js", assignee: expect.objectContaining({ accountId: BOB.id }) });

    const transitions = await jira.issues.getTransitions({ issueIdOrKey: created.key });
    expect(transitions.transitions?.map((t) => t.id)).toEqual([String(STATE_JIRA_IDS.todo)]);
    await jira.issues.doTransition({ issueIdOrKey: created.key, transition: { id: String(STATE_JIRA_IDS.todo) } });
    expect(fake.issues[0]!.state).toBe("todo");

    // An ADF comment goes to v3; a string comment goes to v2 and is read back through v3.
    const adfComment = await jira.issueComments.addComment({ issueIdOrKey: created.key, body: doc("ADF comment") });
    expect(adfComment.body).toEqual(doc("ADF comment"));
    const textComment = await jira.issueComments.addComment({ issueIdOrKey: created.key, body: "plain comment" });
    expect(textComment.body).toEqual(doc("plain comment"));
    const comments = await jira.issueComments.getComments({ issueIdOrKey: created.key });
    expect(comments.total).toBe(2);
  });

  it("editIssue with a string description is refused, as Jira v3 refuses it", async () => {
    // jira.js routes string rich text through v2 for createIssue and addComment, but not editIssue.
    const err = await jira.issues.editIssue({ issueIdOrKey: "ENG-1", fields: { description: "plain" } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400 });
    expect(String((err as Error).message)).toMatch(/Operation value must be an Atlassian Document/);
  });

  it("create with a string description goes through v2", async () => {
    const created = await jira.issues.createIssue({
      fields: { project: { key: "OPS" }, issuetype: { name: "Task" }, summary: "Via v2", description: "plain *text*" },
    });
    expect(created.key).toBe("OPS-1");
    expect(fake.issues.find((i) => i.key === "OPS-1")!.description).toBe("plain *text*");
  });

  it("search with /search/jql (GET and POST) and nextPageToken", async () => {
    for (let i = 0; i < 3; i++) {
      await jira.issues.createIssue({ fields: { project: { key: "ENG" }, issuetype: { name: "Task" }, summary: `Bulk ${i}` } });
    }
    const first = await jira.issueSearch.searchAndReconsileIssuesUsingJql({ jql: "project = ENG ORDER BY key ASC", maxResults: 2, fields: ["summary", "status"] });
    expect(first.issues?.map((i) => i.key)).toEqual(["ENG-1", "ENG-2"]);
    expect(first.isLast).toBe(false);
    const second = await jira.issueSearch.searchAndReconsileIssuesUsingJqlPost({
      jql: "project = ENG ORDER BY key ASC",
      maxResults: 2,
      fields: ["summary"],
      nextPageToken: first.nextPageToken!,
    });
    expect(second.issues?.map((i) => i.key)).toEqual(["ENG-3", "ENG-4"]);
    expect(second.isLast).toBe(true);
    const mine = await jira.issueSearch.searchAndReconsileIssuesUsingJql({ jql: 'assignee = currentUser() OR text ~ "jira.js"', fields: ["*navigable"] });
    expect(mine.issues?.map((i) => i.key)).toEqual(["ENG-1"]);
  });

  it("errors surface as jira.js ApiErrors with Jira bodies", async () => {
    const err = await jira.issueSearch.searchAndReconsileIssuesUsingJql({ jql: "sprint = 1" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400 });
    expect(String((err as Error).message)).toMatch(/Field 'sprint' is not supported/);
    const missing = await jira.issues.getIssue({ issueIdOrKey: "ENG-999" }).catch((e: unknown) => e);
    expect(missing).toMatchObject({ status: 404 });
  });
});
