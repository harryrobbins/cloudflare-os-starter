// End to end: the real jira.js 6.2 client (`createCloudClient`, every response validated against
// its schemas) → a local node:http server → handleJiraApi → the Records service → embedded
// Postgres. Access is stubbed (true); the credential is a real rk1 token minted by the registry
// and sent as Jira's "email + API token" Basic auth.
//
// jira.js is a devDependency of @records/jira only, so it is imported from that package's
// node_modules by path. Adding it as a devDependency here would allow a bare import.

import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCloudClient } from "../../records-jira/node_modules/jira.js/dist/index.js";
import { handleJiraApi } from "../src/jira/handler.ts";
import { createWorld, type World } from "./world.ts";

let w: World;
let server: http.Server;
let jira: ReturnType<typeof createCloudClient>;
let serviceAccountId: string;
const log: string[] = [];

const doc = (text: string) => ({ type: "doc" as const, version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

beforeAll(async () => {
  w = await createWorld();
  const created = await w.service.registry.createCredential(w.olive.caller, w.ds1, {
    label: "jira.js", scopes: ["projects.read", "issues.read", "issues.create", "issues.edit", "issues.transition", "comments.create"], expiresInDays: 7,
  });
  await w.owner`
    INSERT INTO projects.custom_fields (org_id, datastore_id, key, name, type, options)
    VALUES (${w.orgA}, ${w.ds1}, 'story_points', 'Story points', 'number', '{}')`;

  server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const { port } = server.address() as AddressInfo;
      const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
        method: req.method!,
        headers,
        ...(body.length && req.method !== "GET" && req.method !== "HEAD" ? { body } : {}),
      });
      const response = await handleJiraApi(request, { service: w.service, verifyAccess: async () => true });
      log.push(`${req.method} ${req.url} -> ${response.status}`);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  jira = createCloudClient({
    host: `http://127.0.0.1:${port}/gatekeeper/records/v1/datastores/${w.ds1}/jira`,
    auth: { type: "basic", email: w.olive.email, apiToken: created.secret },
    onSchemaMismatch: "throw",
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (process.env.JIRA_COMPAT_LOG) console.log(log.join("\n"));
  await w?.close();
});

describe("jira.js against the Records service", () => {
  it("serverInfo, myself, projects, fields, statuses", async () => {
    expect((await jira.serverInfo.getServerInfo()).deploymentType).toBe("Cloud");
    const me = await jira.myself.getCurrentUser();
    expect(me).toMatchObject({ displayName: "jira.js", active: true });
    serviceAccountId = me.accountId!;
    const page = await jira.projects.searchProjects();
    expect(page.values.map((p) => p.key)).toEqual(["ENG"]);
    const eng = await jira.projects.getProject({ projectIdOrKey: "ENG" });
    expect(eng).toMatchObject({ key: "ENG", name: "Engineering" });
    const fields = await jira.issueFields.getFields();
    expect(fields.map((f) => f.id)).toEqual(expect.arrayContaining(["summary", "status", "customfield_10000"]));
    const statuses = await jira.workflowStatuses.getStatuses();
    expect(statuses.map((s) => s.name)).toEqual(["Backlog", "To do", "In progress", "In review", "Done"]);
    const users = await jira.userSearch.findUsers({ query: "ed" });
    expect(users.map((u) => u.displayName)).toContain("Ed");
  });

  it("create, get, edit, assign, transition, comment", async () => {
    const created = await jira.issues.createIssue({
      fields: {
        project: { key: "ENG" },
        issuetype: { name: "Task" },
        summary: "Created by jira.js",
        description: doc("An ADF description"),
        priority: { name: "Medium" },
        customfield_10000: 8,
      },
    });
    expect(created.key).toBe("ENG-1");

    const issue = await jira.issues.getIssue({ issueIdOrKey: created.key });
    expect(issue.fields).toMatchObject({ summary: "Created by jira.js", description: doc("An ADF description"), priority: { name: "Medium" }, customfield_10000: 8 });
    expect((await jira.issues.getIssue({ issueIdOrKey: created.id })).key).toBe("ENG-1");

    await jira.issues.editIssue({ issueIdOrKey: created.key, fields: { summary: "Edited by jira.js", description: doc("Changed") } });
    await jira.issues.assignIssue({ issueIdOrKey: created.key, accountId: serviceAccountId });
    const edited = await jira.issues.getIssue({ issueIdOrKey: created.key, fields: ["summary", "assignee"] });
    expect(edited.fields).toEqual({ summary: "Edited by jira.js", assignee: expect.objectContaining({ accountId: serviceAccountId }) });

    const transitions = await jira.issues.getTransitions({ issueIdOrKey: created.key });
    expect(transitions.transitions?.map((t) => t.name)).toEqual(["To do"]);
    await jira.issues.doTransition({ issueIdOrKey: created.key, transition: { id: transitions.transitions![0]!.id! } });
    expect((await jira.issues.getIssue({ issueIdOrKey: created.key, fields: ["status"] })).fields?.status?.name).toBe("To do");

    const adfComment = await jira.issueComments.addComment({ issueIdOrKey: created.key, body: doc("ADF comment") });
    expect(adfComment.body).toEqual(doc("ADF comment"));
    const textComment = await jira.issueComments.addComment({ issueIdOrKey: created.key, body: "plain comment" });
    expect(textComment.body).toEqual(doc("plain comment"));
    const comments = await jira.issueComments.getComments({ issueIdOrKey: created.key });
    expect(comments.total).toBe(2);

    // The journal attributes every Jira write to the credential's principal, via 'jira'.
    const [row] = await w.owner`SELECT id FROM projects.issues WHERE jira_id = ${created.id}::bigint`;
    const vias = await w.owner`SELECT DISTINCT via FROM records.journal WHERE entity_id = ${row!.id as string}`;
    expect(vias.map((r) => r.via)).toEqual(["jira"]);
  });

  it("searches with JQL: status, currentUser(), text, ORDER BY, pagination", async () => {
    for (let i = 0; i < 4; i++) {
      await jira.issues.createIssue({
        fields: { project: { key: "ENG" }, issuetype: { name: "Task" }, summary: `Bulk ${i}`, priority: { name: i % 2 ? "High" : "Low" } },
      });
    }
    const first = await jira.issueSearch.searchAndReconsileIssuesUsingJql({ jql: "project = ENG ORDER BY key ASC", maxResults: 2, fields: ["summary", "status"] });
    expect(first.issues?.map((i) => i.key)).toEqual(["ENG-1", "ENG-2"]);
    expect(first.isLast).toBe(false);
    const second = await jira.issueSearch.searchAndReconsileIssuesUsingJqlPost({
      jql: "project = ENG ORDER BY key ASC", maxResults: 2, fields: ["summary"], nextPageToken: first.nextPageToken!,
    });
    expect(second.issues?.map((i) => i.key)).toEqual(["ENG-3", "ENG-4"]);
    const third = await jira.issueSearch.searchAndReconsileIssuesUsingJql({ jql: "project = ENG ORDER BY key ASC", maxResults: 2, nextPageToken: second.nextPageToken! });
    expect(third.issues?.map((i) => i.key)).toEqual(["ENG-5"]);
    expect(third.isLast).toBe(true);

    const mine = await jira.issueSearch.searchAndReconsileIssuesUsingJql({ jql: "assignee = currentUser()", fields: ["summary"] });
    expect(mine.issues?.map((i) => i.key)).toEqual(["ENG-1"]);
    const todo = await jira.issueSearch.searchAndReconsileIssuesUsingJql({ jql: 'status = "To do"' });
    expect(todo.issues?.map((i) => i.key)).toEqual(["ENG-1"]);
    const backlog = await jira.issueSearch.searchAndReconsileIssuesUsingJql({ jql: "statusCategory = new AND status != \"To do\" ORDER BY key DESC" });
    expect(backlog.issues?.map((i) => i.key)).toEqual(["ENG-5", "ENG-4", "ENG-3", "ENG-2"]);
    const text = await jira.issueSearch.searchAndReconsileIssuesUsingJql({ jql: 'text ~ "bulk" AND priority = High ORDER BY priority DESC, key ASC' });
    expect(text.issues?.map((i) => i.key)).toEqual(["ENG-3", "ENG-5"]);
    const byPriority = await jira.issueSearch.searchAndReconsileIssuesUsingJql({ jql: "project = ENG ORDER BY priority DESC, key ASC", fields: ["priority"] });
    expect(byPriority.issues?.map((i) => i.key)).toEqual(["ENG-3", "ENG-5", "ENG-1", "ENG-2", "ENG-4"]);
    const unassigned = await jira.issueSearch.searchAndReconsileIssuesUsingJql({ jql: "assignee is EMPTY ORDER BY created ASC" });
    expect(unassigned.issues?.map((i) => i.key)).toEqual(["ENG-2", "ENG-3", "ENG-4", "ENG-5"]);
  });

  it("errors surface as jira.js ApiErrors with Jira bodies", async () => {
    const bad = await jira.issueSearch.searchAndReconsileIssuesUsingJql({ jql: "sprint = 1" }).catch((e: unknown) => e);
    expect(bad).toMatchObject({ status: 400 });
    const missing = await jira.issues.getIssue({ issueIdOrKey: "ENG-999" }).catch((e: unknown) => e);
    expect(missing).toMatchObject({ status: 404 });
    const invalid = await jira.issues.doTransition({ issueIdOrKey: "ENG-2", transition: { id: "999999" } }).catch((e: unknown) => e);
    expect(invalid).toMatchObject({ status: 400 });
  });
});
