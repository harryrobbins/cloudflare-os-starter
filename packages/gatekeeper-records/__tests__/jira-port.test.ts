// The Jira surface over the real service: authentication (Access + Bearer or Basic rk1), the
// JiraPort (numeric ids, members, workflow, custom fields, lookups, comments) and last-write-wins
// writes, driven through handleJiraApi against embedded Postgres.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createJiraPort } from "../src/jira/port.ts";
import { handleJiraApi, JIRA_PATH, type JiraApiDeps } from "../src/jira/handler.ts";
import { createWorld, key, type World } from "./world.ts";

let w: World;
let secret: string;
let readOnly: string;
let adamSecret: string;
let deps: JiraApiDeps;

const ALL_SCOPES = ["projects.read", "issues.read", "issues.create", "issues.edit", "issues.transition", "comments.create"];

beforeAll(async () => {
  w = await createWorld();
  secret = (await w.service.registry.createCredential(w.olive.caller, w.ds1, { label: "Jira client", scopes: ALL_SCOPES, expiresInDays: 7 })).secret;
  readOnly = (await w.service.registry.createCredential(w.olive.caller, w.ds1, { label: "Jira reader", scopes: ["projects.read", "issues.read"], expiresInDays: 7 })).secret;
  adamSecret = (await w.service.registry.createCredential(w.adam.caller, w.ds1, { label: "Adam's tool", scopes: ALL_SCOPES, expiresInDays: 7 })).secret;
  await w.owner`
    INSERT INTO projects.custom_fields (org_id, datastore_id, key, name, type, options)
    VALUES (${w.orgA}, ${w.ds1}, 'story_points', 'Story points', 'number', '{}'),
           (${w.orgA}, ${w.ds1}, 'team', 'Team', 'enum', '{Core,Edge}')`;
  deps = { service: w.service, verifyAccess: async (r) => r.headers.get("cf-access-jwt-assertion") === "valid" };
});
afterAll(async () => w?.close());

const bearer = (token: string) => `Bearer ${token}`;
const basic = (email: string, token: string) => `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

type Call = { status: number; body: any; headers: Headers };

async function call(method: string, path: string, init: { body?: unknown; auth?: string | null; access?: boolean; ds?: string; version?: 2 | 3; headers?: Record<string, string> } = {}): Promise<Call> {
  const headers = new Headers(init.headers);
  if (init.access !== false) headers.set("cf-access-jwt-assertion", "valid");
  if (init.auth !== null) headers.set("authorization", init.auth ?? bearer(secret));
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const url = `https://records.test/gatekeeper/records/v1/datastores/${init.ds ?? w.ds1}/jira/rest/api/${init.version ?? 2}${path}`;
  const res = await handleJiraApi(new Request(url, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), deps);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

describe("mounting", () => {
  it("JIRA_PATH matches the Jira base and everything under it, and nothing else", () => {
    const ds = "0f0f0f0f-0000-4000-8000-000000000000";
    expect(JIRA_PATH.exec(`/gatekeeper/records/v1/datastores/${ds}/jira/rest/api/3/myself`)?.[1]).toBe(ds);
    expect(JIRA_PATH.test(`/gatekeeper/records/v1/datastores/${ds}/jira`)).toBe(true);
    expect(JIRA_PATH.test(`/gatekeeper/records/v1/datastores/${ds}/issues`)).toBe(false);
    expect(JIRA_PATH.test(`/gatekeeper/records/v1/datastores/${ds}/jirax/rest`)).toBe(false);
  });
});

describe("authentication", () => {
  it("needs the Access assertion and a Records credential, answering in Jira's shape", async () => {
    const noAccess = await call("GET", "/myself", { access: false });
    expect(noAccess.status).toBe(401);
    expect(noAccess.body).toEqual({ errorMessages: [expect.stringMatching(/not authenticated/)], errors: {} });
    expect((await call("GET", "/myself", { auth: null })).status).toBe(401);
    expect((await call("GET", "/myself", { auth: bearer(`rk1_${"0".repeat(32)}_${"A".repeat(43)}`) })).status).toBe(401);
    expect((await call("GET", "/myself", { auth: "Bearer not-a-credential" })).status).toBe(401);
    const ok = await call("GET", "/myself");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ displayName: "Jira client", active: true, accountType: expect.any(String) });
  });

  it("accepts Basic <owner e-mail>:<rk1 token>, case-insensitively, and nothing else as the user", async () => {
    expect((await call("GET", "/myself", { auth: basic("olive@a.test", secret) })).status).toBe(200);
    expect((await call("GET", "/myself", { auth: basic("  OLIVE@A.TEST", secret) })).status).toBe(401); // no trimming inside Basic
    expect((await call("GET", "/myself", { auth: basic("Olive@A.test", secret) })).status).toBe(200);
    expect((await call("GET", "/myself", { auth: basic("ed@a.test", secret) })).status).toBe(401);
    expect((await call("GET", "/myself", { auth: basic("olive@a.test", "password") })).status).toBe(401);
  });

  it("refuses Basic when the credential's owner has no e-mail; Bearer still works", async () => {
    await w.owner`UPDATE records.principals SET email = NULL WHERE id = ${w.adam.id}`;
    try {
      expect((await call("GET", "/myself", { auth: basic("adam@a.test", adamSecret) })).status).toBe(401);
      expect((await call("GET", "/myself", { auth: bearer(adamSecret) })).status).toBe(200);
    } finally {
      await w.owner`UPDATE records.principals SET email = ${w.adam.email} WHERE id = ${w.adam.id}`;
    }
  });

  it("treats the path datastore as a selector that must match the credential", async () => {
    const res = await call("GET", "/project", { ds: w.ds2 });
    expect(res.status).toBe(404);
    expect(res.body.errorMessages).toHaveLength(1);
  });

  it("answers Jira's 404 for unknown routes", async () => {
    expect((await call("GET", "/agile/board")).status).toBe(404);
  });
});

describe("the port over the service", () => {
  it("lists projects, statuses and fields with numeric ids; custom fields from 10000", async () => {
    const projects = await call("GET", "/project");
    expect(projects.body).toEqual([expect.objectContaining({ key: "ENG", id: expect.stringMatching(/^\d+$/) })]);
    const statuses = await call("GET", "/status");
    expect(statuses.body.map((s: { name: string }) => s.name)).toEqual(["Backlog", "To do", "In progress", "In review", "Done"]);
    expect(new Set(statuses.body.map((s: { id: string }) => s.id)).size).toBe(5);
    const fields = await call("GET", "/field");
    const custom = fields.body.filter((f: { custom: boolean }) => f.custom).map((f: { id: string }) => f.id);
    expect(custom).toEqual(["customfield_10000", "customfield_10001"]);
  });

  it("lists members (people and the credential's own principal) with active flags", async () => {
    const users = await call("GET", "/user/search?query=");
    const names = users.body.map((u: { displayName: string }) => u.displayName);
    expect(names).toEqual(expect.arrayContaining(["Olive", "Ed", "Rae", "Jira client"]));
    await w.owner`UPDATE records.principals SET status = 'disabled' WHERE id = ${w.rae.id}`;
    try {
      const assignable = await call("GET", "/user/assignable/search?project=ENG");
      expect(assignable.body.map((u: { displayName: string }) => u.displayName)).not.toContain("Rae");
    } finally {
      await w.owner`UPDATE records.principals SET status = 'active' WHERE id = ${w.rae.id}`;
    }
  });

  it("creates, reads by key, numeric id and UUID, edits last-write-wins, transitions and comments", async () => {
    const created = await call("POST", "/issue", {
      body: { fields: { project: { key: "ENG" }, issuetype: { name: "Task" }, summary: "From Jira", description: "plain", priority: { name: "High" }, customfield_10000: 5 } },
    });
    expect(created.status).toBe(201);
    const { id, key: issueKey } = created.body as { id: string; key: string };
    expect(issueKey).toMatch(/^ENG-\d+$/);

    const byKey = await call("GET", `/issue/${issueKey}`);
    expect(byKey.body).toMatchObject({ id, key: issueKey, fields: { summary: "From Jira", customfield_10000: 5, priority: { name: "High" } } });
    expect((await call("GET", `/issue/${id}`)).body.key).toBe(issueKey);
    expect((await call("GET", `/issue/${issueKey.toLowerCase()}`)).status).toBe(200);
    const port = createJiraPort(w.service, (await w.service.registry.authenticateCredential(secret))!.caller, w.ds1);
    const issue = (await port.getIssue(issueKey))!;
    expect((await port.getIssue(issue.id))!.jiraId).toBe(Number(id));
    expect(await port.getIssue("ENG-99999")).toBeNull();
    expect(await port.getIssue("nonsense")).toBeNull();

    // A native edit moves the revision on; the Jira edit (no If-Match) still applies.
    await w.service.projects.editIssue(w.olive.caller, w.ds1, { issueId: issue.id, expectedRevision: 1, patch: { title: "Native edit" } }, key("n"));
    const edit = await call("PUT", `/issue/${issueKey}`, { body: { fields: { summary: "Jira edit wins" } } });
    expect(edit.status).toBe(204);
    const after = await w.service.projects.getIssue(w.olive.caller, w.ds1, issue.id);
    expect(after).toMatchObject({ title: "Jira edit wins", revision: 3 });
    const [entry] = await w.owner`SELECT via, before, after FROM records.journal WHERE entity_id = ${issue.id} ORDER BY seq DESC LIMIT 1`;
    expect(entry).toMatchObject({ via: "jira", before: { title: "Native edit" }, after: { title: "Jira edit wins" } });

    const transitions = await call("GET", `/issue/${issueKey}/transitions`);
    const toDo = transitions.body.transitions.find((t: { to: { name: string } }) => t.to.name === "To do");
    expect((await call("POST", `/issue/${issueKey}/transitions`, { body: { transition: { id: toDo.id } } })).status).toBe(204);
    expect((await w.service.projects.getIssue(w.olive.caller, w.ds1, issue.id)).state).toBe("todo");
    const done = (await call("GET", "/status")).body.find((s: { name: string }) => s.name === "Done");
    const refused = await call("POST", `/issue/${issueKey}/transitions`, { body: { transition: { id: done.id } } });
    expect(refused.status).toBe(400);

    for (let i = 0; i < 3; i++) {
      expect((await call("POST", `/issue/${issueKey}/comment`, { body: { body: `comment ${i}` }, headers: { "idempotency-key": key("cm") } })).status).toBe(201);
    }
    const page = await call("GET", `/issue/${issueKey}/comment?startAt=1&maxResults=1`);
    expect(page.body).toMatchObject({ startAt: 1, maxResults: 1, total: 3, comments: [expect.objectContaining({ body: "comment 1" })] });
    const one = await call("GET", `/issue/${issueKey}/comment/${page.body.comments[0].id}`);
    expect(one.body.body).toBe("comment 1");
    expect((await call("GET", `/issue/${issueKey}/comment/999999`)).status).toBe(404);
  });

  it("replays a retried write inside the derived-key window instead of writing twice", async () => {
    const body = { fields: { project: { key: "ENG" }, issuetype: { name: "Task" }, summary: "Retried create" } };
    const first = await call("POST", "/issue", { body });
    const second = await call("POST", "/issue", { body });
    expect(second.body.key).toBe(first.body.key);
  });

  it("keeps the credential's scopes: a read-only credential cannot write", async () => {
    const res = await call("POST", "/issue", {
      auth: bearer(readOnly),
      body: { fields: { project: { key: "ENG" }, issuetype: { name: "Task" }, summary: "Nope" } },
    });
    expect(res.status).toBe(403);
    expect((await call("GET", "/project", { auth: bearer(readOnly) })).status).toBe(200);
  });

  it("searches with JQL and pages with nextPageToken", async () => {
    for (let i = 0; i < 3; i++) {
      await call("POST", "/issue", { body: { fields: { project: { key: "ENG" }, issuetype: { name: "Task" }, summary: `Paged ${i}` } }, headers: { "idempotency-key": key("p") } });
    }
    const first = await call("GET", `/search/jql?jql=${encodeURIComponent('text ~ "paged" ORDER BY key ASC')}&maxResults=2&fields=summary`);
    expect(first.body.issues.map((i: { fields: { summary: string } }) => i.fields.summary)).toEqual(["Paged 0", "Paged 1"]);
    expect(first.body.isLast).toBe(false);
    const second = await call("POST", "/search/jql", { body: { jql: 'text ~ "paged" ORDER BY key ASC', maxResults: 2, fields: ["summary"], nextPageToken: first.body.nextPageToken } });
    expect(second.body.issues.map((i: { fields: { summary: string } }) => i.fields.summary)).toEqual(["Paged 2"]);
    expect(second.body.isLast).toBe(true);
    const wrong = await call("POST", "/search/jql", { body: { jql: "project = ENG", nextPageToken: first.body.nextPageToken } });
    expect(wrong.status).toBe(400);
  });
});
