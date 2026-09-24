import { RecordsError } from "@records/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { deriveIdempotencyKey, handleJira } from "../src/index.js";
import { ALICE, BOB, CAROL_INACTIVE, ENG_ID, STATE_JIRA_IDS, createFakePort, type Fake } from "./support/fake-port.js";
import { BASE, ORIGIN, caller } from "./support/http.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");
let fake: Fake;
let call: ReturnType<typeof caller>;

const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

async function create(fields: Record<string, unknown> = {}, version: 2 | 3 = 3) {
  const res = await call("POST", "/issue", { fields: { project: { key: "ENG" }, issuetype: { name: "Task" }, summary: "First issue", ...fields } }, { version });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; key: string; self: string };
}

beforeEach(() => {
  fake = createFakePort();
  call = caller(fake.port, { now: () => NOW });
});

describe("metadata endpoints", () => {
  it("serverInfo says Cloud", async () => {
    const r = await call("GET", "/serverInfo");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ deploymentType: "Cloud", baseUrl: `${ORIGIN}${BASE}`, versionNumbers: [1001, 0, 0] });
  });

  it("myself, user and user search", async () => {
    expect((await call("GET", "/myself")).body).toMatchObject({ accountId: ALICE.id, displayName: "Alice Adams", active: true, accountType: "atlassian", emailAddress: "alice@example.test" });
    expect((await call("GET", `/user?accountId=${BOB.id}`)).body).toMatchObject({ accountId: BOB.id, displayName: "Bob Brown" });
    const missing = await call("GET", "/user?accountId=nobody");
    expect(missing).toMatchObject({ status: 404, body: { errorMessages: ["The user with account ID 'nobody' does not exist."], errors: {} } });
    expect((await call("GET", "/user/search?query=bro")).body.map((u: any) => u.accountId)).toEqual([BOB.id]);
    expect((await call("GET", "/user/search?query=example.test")).body).toHaveLength(2);
    const bot = (await call("GET", "/user/search?query=bot")).body[0];
    expect(bot.accountType).toBe("app");
    const assignable = (await call("GET", "/user/assignable/search?project=ENG")).body.map((u: any) => u.accountId);
    expect(assignable).not.toContain(CAROL_INACTIVE.id);
  });

  it("projects: search, get, list", async () => {
    const page = (await call("GET", "/project/search?maxResults=1")).body;
    expect(page).toMatchObject({ startAt: 0, maxResults: 1, total: 2, isLast: false, values: [{ key: "ENG", id: "10000", name: "Engineering" }] });
    expect(page.nextPage).toContain("startAt=1");
    expect((await call("GET", "/project/search?query=oper")).body.values.map((p: any) => p.key)).toEqual(["OPS"]);
    const eng = (await call("GET", "/project/eng")).body;
    expect(eng).toMatchObject({ key: "ENG", id: "10000", description: "Builds things", issueTypes: [{ name: "Task", id: "10001" }], lead: { accountId: ALICE.id } });
    expect((await call("GET", "/project/10001")).body.key).toBe("OPS");
    expect(await call("GET", "/project/NOPE")).toMatchObject({ status: 404, body: { errorMessages: ["No project could be found with key 'NOPE'."] } });
    expect((await call("GET", "/project")).body).toHaveLength(2);
  });

  it("fields, priorities, statuses, issue types", async () => {
    const fields = (await call("GET", "/field")).body;
    expect(fields.find((f: any) => f.id === "summary")).toMatchObject({ custom: false, schema: { type: "string", system: "summary" } });
    expect(fields.find((f: any) => f.id === "customfield_10020")).toMatchObject({ name: "Story points", custom: true, schema: { type: "number", customId: 10020 }, clauseNames: ["cf[10020]"] });
    expect((await call("GET", "/priority")).body.map((p: any) => p.name)).toEqual(["Highest", "High", "Medium", "Low"]);
    const statuses = (await call("GET", "/status")).body;
    expect(statuses.map((s: any) => [s.id, s.name, s.statusCategory.key])).toEqual([
      ["10000", "Backlog", "new"],
      ["10001", "To do", "new"],
      ["10002", "In progress", "indeterminate"],
      ["10003", "In review", "indeterminate"],
      ["10004", "Done", "done"],
    ]);
    expect((await call("GET", "/issuetype")).body).toEqual([expect.objectContaining({ id: "10001", name: "Task", subtask: false })]);
    expect((await call("GET", "/issue/createmeta/ENG/issuetypes")).body.issueTypes).toHaveLength(1);
  });
});

describe("issues", () => {
  it("create (v3 ADF) and get", async () => {
    const created = await create({
      description: adf("Hello **not bold** in ADF"),
      priority: { name: "High" },
      assignee: { accountId: BOB.id },
      customfield_10020: 5,
      customfield_10021: { value: "Edge" },
      labels: [],
    });
    expect(created).toEqual({ id: "20001", key: "ENG-1", self: `${ORIGIN}${BASE}/rest/api/3/issue/20001` });
    const stored = fake.issues[0]!;
    expect(stored).toMatchObject({ title: "First issue", description: "Hello \\*\\*not bold\\*\\* in ADF", priority: "high", assignee: BOB, customFields: { story_points: 5, team: "Edge" } });

    const got = (await call("GET", "/issue/ENG-1")).body;
    expect(got).toMatchObject({ id: "20001", key: "ENG-1" });
    expect(got.fields).toMatchObject({
      summary: "First issue",
      description: adf("Hello **not bold** in ADF"),
      status: { id: "10000", name: "Backlog", statusCategory: { key: "new", name: "To Do" } },
      priority: { id: "2", name: "High" },
      assignee: { accountId: BOB.id },
      reporter: { accountId: ALICE.id },
      project: { key: "ENG", id: "10000" },
      issuetype: { name: "Task" },
      created: "2026-09-01T09:05:00.000+0000",
      customfield_10020: 5,
      customfield_10021: { value: "Edge", id: "2" },
      customfield_10022: null,
      comment: { comments: [], total: 0 },
    });
    // lower-case key and numeric id also work
    expect((await call("GET", "/issue/eng-1")).body.key).toBe("ENG-1");
    expect((await call("GET", "/issue/20001?fields=summary,priority")).body.fields).toEqual({ summary: "First issue", priority: expect.anything() });
  });

  it("v2 takes and returns plain text", async () => {
    await create({ description: "Plain *text* stays" }, 2);
    expect(fake.issues[0]!.description).toBe("Plain *text* stays");
    expect((await call("GET", "/issue/ENG-1", undefined, { version: 2 })).body.fields.description).toBe("Plain *text* stays");
    expect((await call("GET", "/issue/ENG-1")).body.fields.description.type).toBe("doc");
  });

  it("none priority is an absent field; empty description is null", async () => {
    await create();
    const f = (await call("GET", "/issue/ENG-1")).body.fields;
    expect("priority" in f).toBe(false);
    expect(f.description).toBeNull();
  });

  it("create validation uses Jira's field errors", async () => {
    const r = await call("POST", "/issue", { fields: { issuetype: { name: "Bug" }, priority: { name: "Critical" }, labels: ["x"], customfield_99: 1, description: "string in v3" } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      errorMessages: [],
      errors: {
        issuetype: "The issue type selected is invalid.",
        priority: "Priority name 'Critical' is not valid",
        labels: "Field 'labels' cannot be set. It is not on the appropriate screen, or unknown.",
        customfield_99: "Field 'customfield_99' cannot be set. It is not on the appropriate screen, or unknown.",
        description: "Operation value must be an Atlassian Document (see the Atlassian Document Format)",
        summary: "You must specify a summary of the issue.",
        project: "Specify a valid project ID or key",
      },
    });
    const unsupported = await call("POST", "/issue", { fields: { project: { key: "ENG" }, summary: "x", description: { type: "doc", version: 1, content: [{ type: "table", content: [] }] } } });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.errors.description).toMatch(/Unsupported ADF node type 'table'/);
    const inactive = await call("POST", "/issue", { fields: { project: { key: "ENG" }, summary: "x", assignee: { accountId: CAROL_INACTIVE.id } } });
    expect(inactive.body.errors.assignee).toBe(`User '${CAROL_INACTIVE.id}' cannot be assigned issues.`);
    expect(fake.issues).toHaveLength(0);
  });

  it("create with an initial transition and with Lowest priority", async () => {
    await create({ priority: { name: "Lowest" } });
    expect(fake.issues[0]!.priority).toBe("low");
    const r = await call("POST", "/issue", { fields: { project: { id: "10000" }, summary: "second" }, transition: { id: String(STATE_JIRA_IDS.todo) } });
    expect(r.status).toBe(201);
    expect(fake.issues[1]!.state).toBe("todo");
  });

  it("edit: fields and update-set, last write wins, 204", async () => {
    await create();
    const r = await call("PUT", "/issue/ENG-1", {
      fields: { summary: "Renamed", priority: { id: "1" }, customfield_10021: { value: "Core" } },
      update: { description: [{ set: adf("New body") }] },
    });
    expect(r.status).toBe(204);
    expect(r.body).toBeNull();
    const edit = fake.calls.find((c) => c.op === "editIssue")!;
    expect(edit.input).toEqual({ issueId: fake.issues[0]!.id, expectedRevision: undefined, patch: { title: "Renamed", priority: "urgent", customFields: { team: "Core" }, description: "New body" } });
    expect(fake.issues[0]).toMatchObject({ title: "Renamed", priority: "urgent", description: "New body", revision: 2 });

    const unassign = await call("PUT", "/issue/ENG-1?returnIssue=true", { fields: { assignee: null, priority: null } });
    expect(unassign.status).toBe(200);
    expect(unassign.body.fields.assignee).toBeNull();
    expect("priority" in unassign.body.fields).toBe(false);

    expect((await call("PUT", "/issue/ENG-1", { fields: {} })).status).toBe(204);
    expect(fake.issues[0]!.revision).toBe(3);

    const bad = await call("PUT", "/issue/ENG-1", { fields: { project: { key: "OPS" } }, update: { labels: [{ add: "x" }] } });
    expect(bad.status).toBe(400);
    expect(bad.body.errors).toEqual({
      project: "Field 'project' cannot be set. It is not on the appropriate screen, or unknown.",
      labels: "The operation 'add' is not supported for the field 'labels'; use 'set' or fields.",
    });
  });

  it("assign endpoint", async () => {
    await create();
    expect((await call("PUT", "/issue/ENG-1/assignee", { accountId: BOB.id })).status).toBe(204);
    expect(fake.issues[0]!.assignee).toEqual(BOB);
    expect((await call("PUT", "/issue/ENG-1/assignee", { accountId: null })).status).toBe(204);
    expect(fake.issues[0]!.assignee).toBeNull();
  });

  it("404s are Jira-shaped", async () => {
    expect(await call("GET", "/issue/ENG-99")).toMatchObject({ status: 404, body: { errorMessages: ["Issue does not exist or you do not have permission to see it."], errors: {} } });
    expect((await call("GET", "/issue/..%2Fx")).status).toBe(404);
    expect((await call("PUT", "/issue/ENG-99", { fields: { summary: "x" } })).status).toBe(404);
  });
});

describe("transitions", () => {
  it("lists workflow edges from the current state, ids = target state ids", async () => {
    await create();
    const t = (await call("GET", "/issue/ENG-1/transitions")).body;
    expect(t.transitions.map((x: any) => [x.id, x.name, x.to.name])).toEqual([["10001", "To do", "To do"]]);
    expect(t.transitions[0]).toMatchObject({ isGlobal: true, hasScreen: false, to: { statusCategory: { key: "new" } } });
  });

  it("performs a transition and refuses invalid ones", async () => {
    await create();
    expect((await call("POST", "/issue/ENG-1/transitions", { transition: { id: "10001" } })).status).toBe(204);
    expect(fake.issues[0]!.state).toBe("todo");
    expect(fake.calls.find((c) => c.op === "transitionIssue")!.input).toEqual({ issueId: fake.issues[0]!.id, expectedRevision: undefined, toState: "todo" });

    const invalid = await call("POST", "/issue/ENG-1/transitions", { transition: { id: "10004" } });
    expect(invalid).toMatchObject({ status: 400, body: { errorMessages: ["Transition id '10004' is not valid for this issue."], errors: {} } });
    expect((await call("POST", "/issue/ENG-1/transitions", {})).body.errors).toEqual({ transition: "Missing 'transition' identifier" });
    expect((await call("POST", "/issue/ENG-1/transitions", { transition: { id: "10002" }, fields: { resolution: { name: "Done" } } })).body.errors).toEqual({
      resolution: "Field 'resolution' cannot be set. It is not on the appropriate screen, or unknown.",
    });
  });

  it("a workflow conflict raised by the service is a 400", async () => {
    await create();
    const port = { ...fake.port, transitionIssue: async () => ({ status: "conflict" as const, code: "workflow_conflict" as const, message: "Moved meanwhile." }) };
    const r = await caller(port)("POST", "/issue/ENG-1/transitions", { transition: { id: "10001" } });
    expect(r).toMatchObject({ status: 400, body: { errorMessages: ["Moved meanwhile."] } });
    const thrown = { ...fake.port, transitionIssue: async () => { throw new RecordsError("workflow_conflict", "nope"); } };
    expect((await caller(thrown)("POST", "/issue/ENG-1/transitions", { transition: { id: "10001" } })).status).toBe(400);
  });
});

describe("comments", () => {
  it("adds (v3 ADF and v2 text), lists and gets", async () => {
    const issue = await create();
    const c3 = await call("POST", "/issue/ENG-1/comment", { body: adf("Looks _good_") });
    expect(c3.status).toBe(201);
    expect(c3.body).toMatchObject({ id: "20002", author: { accountId: ALICE.id }, body: adf("Looks _good_") });
    expect(c3.body.self).toBe(`${ORIGIN}${BASE}/rest/api/3/issue/${issue.id}/comment/20002`);
    expect(fake.comments[0]!.body).toBe("Looks \\_good\\_");

    await call("POST", "/issue/ENG-1/comment", { body: "v2 *plain*" }, { version: 2 });
    const list = (await call("GET", "/issue/ENG-1/comment?maxResults=1&startAt=1", undefined, { version: 2 })).body;
    expect(list).toMatchObject({ startAt: 1, maxResults: 1, total: 2, comments: [{ body: "v2 *plain*" }] });
    expect((await call("GET", "/issue/ENG-1/comment/20002")).body.id).toBe("20002");
    expect((await call("GET", "/issue/ENG-1/comment/99")).status).toBe(404);
    expect((await call("GET", "/issue/ENG-1")).body.fields.comment.total).toBe(2);
  });

  it("refuses empty bodies and visibility", async () => {
    await create();
    expect((await call("POST", "/issue/ENG-1/comment", { body: adf("   ") })).body.errors).toEqual({ comment: "Comment body can not be empty!" });
    expect((await call("POST", "/issue/ENG-1/comment", { body: adf("x"), visibility: { type: "role", value: "Admins" } })).status).toBe(400);
  });
});

describe("search", () => {
  beforeEach(async () => {
    for (let i = 1; i <= 5; i++) await create({ summary: `Issue ${i}`, priority: { name: i % 2 ? "High" : "Low" }, ...(i === 3 ? { assignee: { accountId: ALICE.id } } : {}) });
  });

  it("GET /search/jql defaults to id-only fields and pages with nextPageToken", async () => {
    const first = (await call("GET", `/search/jql?jql=${encodeURIComponent("project = ENG ORDER BY key ASC")}&maxResults=2`)).body;
    expect(first.issues.map((i: any) => i.key)).toEqual(["ENG-1", "ENG-2"]);
    expect(first.issues[0].fields).toEqual({});
    expect(first.isLast).toBe(false);
    const second = (await call("GET", `/search/jql?jql=${encodeURIComponent("project = ENG ORDER BY key ASC")}&maxResults=2&nextPageToken=${first.nextPageToken}`)).body;
    expect(second.issues.map((i: any) => i.key)).toEqual(["ENG-3", "ENG-4"]);
    const third = (await call("GET", `/search/jql?jql=${encodeURIComponent("project = ENG ORDER BY key ASC")}&maxResults=2&nextPageToken=${second.nextPageToken}`)).body;
    expect(third).toMatchObject({ isLast: true, issues: [{ key: "ENG-5" }] });
    expect("nextPageToken" in third).toBe(false);

    const replay = await call("GET", `/search/jql?jql=${encodeURIComponent("project = OPS")}&nextPageToken=${first.nextPageToken}`);
    expect(replay).toMatchObject({ status: 400, body: { errorMessages: ["The provided next page token is invalid or expired."] } });
    expect((await call("GET", "/search/jql?jql=x&nextPageToken=garbage")).status).toBe(400);
  });

  it("POST /search/jql with fields lists, *all and *navigable", async () => {
    const r = (await call("POST", "/search/jql", { jql: "assignee = currentUser()", fields: ["summary", "status", "assignee"] })).body;
    expect(r.issues).toHaveLength(1);
    expect(Object.keys(r.issues[0].fields).sort()).toEqual(["assignee", "status", "summary"]);
    const nav = (await call("POST", "/search/jql", { jql: "priority = High ORDER BY created DESC", fields: ["*navigable", "-description"] })).body;
    expect(nav.issues.map((i: any) => i.key)).toEqual(["ENG-5", "ENG-3", "ENG-1"]);
    expect(nav.issues[0].fields.summary).toBe("Issue 5");
    expect("description" in nav.issues[0].fields).toBe(false);
    expect("comment" in nav.issues[0].fields).toBe(false);
    const all = (await call("GET", "/search/jql?jql=key%3DENG-2&fields=*all")).body;
    expect(all.issues[0].fields.customfield_10020).toBeNull();
  });

  it("JQL errors come back as Jira 400s; /search is gone", async () => {
    const r = await call("POST", "/search/jql", { jql: "sprint in openSprints()" });
    expect(r.status).toBe(400);
    expect(r.body.errorMessages[0]).toMatch(/Field 'sprint' is not supported/);
    expect(await call("GET", "/search?jql=x")).toMatchObject({ status: 410, body: { errorMessages: [expect.stringMatching(/search\/jql/)] } });
    expect((await call("POST", "/search", { jql: "x" })).status).toBe(410);
  });

  it("clamps maxResults", async () => {
    const r = (await call("GET", "/search/jql?jql=&maxResults=100000")).body;
    expect(r.issues).toHaveLength(5);
  });
});

describe("writes: idempotency and outcomes", () => {
  it("derives a deterministic key when the client sends none, and replays within the window", async () => {
    await create();
    const writes = fake.calls.filter((c) => c.op === "createIssue");
    expect(writes[0]!.options).toMatchObject({ idempotencyKeyDerived: true });
    expect(writes[0]!.options!.idempotencyKey).toMatch(/^jira-[0-9a-f]{48}$/);
    // Same request again within the window: replayed, not a second issue.
    const again = await call("POST", "/issue", { fields: { summary: "First issue", issuetype: { name: "Task" }, project: { key: "ENG" } } });
    expect(again.status).toBe(201);
    expect(fake.issues).toHaveLength(1);
    // Next window: a new write, as on Jira.
    const later = caller(fake.port, { now: () => new Date(NOW.getTime() + 61_000) });
    await later("POST", "/issue", { fields: { project: { key: "ENG" }, issuetype: { name: "Task" }, summary: "First issue" } });
    expect(fake.issues).toHaveLength(2);
  });

  it("uses a client Idempotency-Key verbatim and validates it", async () => {
    await call("POST", "/issue", { fields: { project: { key: "ENG" }, summary: "x" } }, { headers: { "idempotency-key": "client-key-123" } });
    expect(fake.calls[0]!.options).toEqual({ idempotencyKey: "client-key-123", idempotencyKeyDerived: false });
    expect((await call("POST", "/issue", { fields: { project: { key: "ENG" }, summary: "x" } }, { headers: { "idempotency-key": "bad key!" } })).status).toBe(400);
  });

  it("derived keys depend on caller, method, path, body and bucket", async () => {
    const base = { accountId: ALICE.id, method: "POST", path: "/rest/api/3/issue", body: { a: 1, b: [1, 2] }, now: NOW, windowMs: 60_000 };
    const k = await deriveIdempotencyKey(base);
    expect(await deriveIdempotencyKey({ ...base, body: { b: [1, 2], a: 1 } })).toBe(k);
    expect(await deriveIdempotencyKey({ ...base, accountId: BOB.id })).not.toBe(k);
    expect(await deriveIdempotencyKey({ ...base, path: "/rest/api/2/issue" })).not.toBe(k);
    expect(await deriveIdempotencyKey({ ...base, now: new Date(NOW.getTime() + 60_000) })).not.toBe(k);
  });

  it("pending writes are 409 with the action id, never success", async () => {
    fake.pendNext();
    const r = await call("POST", "/issue", { fields: { project: { key: "ENG" }, summary: "x" } });
    expect(r.status).toBe(409);
    expect(r.body.errorMessages[0]).toMatch(/waiting for approval \(action 7\)/);
    expect(r.headers.get("x-records-action-id")).toBe("7");
  });

  it("maps port errors to Jira statuses", async () => {
    const mk = (code: ConstructorParameters<typeof RecordsError>[0]) => caller({ ...fake.port, myself: async () => { throw new RecordsError(code, "x"); } });
    expect((await mk("unauthenticated")("GET", "/myself")).body).toEqual({ errorMessages: ["You are not authenticated. Authentication required to perform this operation."], errors: {} });
    expect((await mk("unauthenticated")("GET", "/myself")).status).toBe(401);
    expect((await mk("forbidden")("GET", "/myself")).status).toBe(403);
    const limited = await mk("rate_limited")("GET", "/myself");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("5");
    // An error crossing an RPC boundary keeps only its message.
    const rpc = caller({ ...fake.port, projects: async () => { throw new Error("forbidden: not a member"); } });
    expect((await rpc("GET", "/project/search")).status).toBe(403);
    const boom = caller({ ...fake.port, projects: async () => { throw new Error("kaboom"); } });
    expect(await boom("GET", "/project/search")).toMatchObject({ status: 500, body: { errorMessages: ["Internal server error."] } });
    const conflict = caller({ ...fake.port, editIssue: async () => ({ status: "conflict" as const, code: "revision_conflict" as const, message: "Changed." }) });
    await create();
    expect((await conflict("PUT", "/issue/ENG-1", { fields: { summary: "y" } })).status).toBe(409);
    const rejected = caller({ ...fake.port, editIssue: async () => ({ status: "rejected" as const, code: "forbidden", message: "Not yours." }) });
    expect(await rejected("PUT", "/issue/ENG-1", { fields: { summary: "y" } })).toMatchObject({ status: 403, body: { errorMessages: ["Not yours."] } });
  });
});

describe("routing and request hygiene", () => {
  it("404 outside the API, 405 wrong method, 415 wrong type, 400 bad JSON, latest = v2", async () => {
    const res = await handleJira(new Request(`${ORIGIN}/elsewhere/rest/api/3/myself`), BASE, fake.port);
    expect(res.status).toBe(404);
    expect((await call("GET", "/nope")).status).toBe(404);
    const m = await call("DELETE", "/issue/ENG-1");
    expect(m.status).toBe(405);
    expect(m.headers.get("allow")).toBe("GET, PUT");
    expect((await call("POST", "/issue", "not json")).body).toEqual({ errorMessages: ["Unexpected character in the request body: it is not valid JSON."], errors: {} });
    expect((await call("POST", "/issue", "x", { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await call("POST", "/issue", "x".repeat(70_000))).status).toBe(413);
    const latest = await handleJira(new Request(`${ORIGIN}${BASE}/rest/api/latest/serverInfo`), BASE, fake.port);
    expect(latest.status).toBe(200);
    expect(((await latest.json()) as { baseUrl: string }).baseUrl).toBe(`${ORIGIN}${BASE}`);
  });

  it("a Jira project key in the resolver uses the port's lookups once per request", async () => {
    let loads = 0;
    const counting = caller({ ...fake.port, projects: async () => { loads++; return fake.projects; } });
    await counting("POST", "/search/jql", { jql: "project = ENG", fields: ["project"] });
    expect(loads).toBe(1);
    expect(ENG_ID).toBeTruthy();
  });
});
