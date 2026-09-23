import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_PREFIX, handleApi, type ApiDeps } from "../src/http/api.ts";
import { createWorld, key, type World } from "./world.ts";

let w: World;
let secret: string;
let readOnlySecret: string;
let deps: ApiDeps;

beforeAll(async () => {
  w = await createWorld();
  secret = (await w.service.registry.createCredential(w.olive.caller, w.ds1, {
    label: "Integration", scopes: ["projects.read", "issues.read", "issues.create", "issues.edit", "issues.transition", "comments.create"], expiresInDays: 7,
  })).secret;
  readOnlySecret = (await w.service.registry.createCredential(w.olive.caller, w.ds1, { label: "BI", scopes: ["projects.read", "issues.read"], expiresInDays: 7 })).secret;
  deps = { service: w.service, verifyAccess: async (r) => r.headers.get("cf-access-jwt-assertion") === "valid" };
});
afterAll(async () => w?.close());

function call(path: string, init: RequestInit & { token?: string | null; access?: boolean } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.access !== false) headers.set("cf-access-jwt-assertion", "valid");
  if (init.token !== null) headers.set("authorization", `Bearer ${init.token ?? secret}`);
  if (init.body) headers.set("content-type", "application/json");
  return handleApi(new Request(`https://records.test${API_PREFIX}${path}`, { ...init, headers }), deps);
}
const ds = () => `/datastores/${w.ds1}`;

describe("authentication", () => {
  it("requires both the Access assertion and a Records credential", async () => {
    expect((await call(`${ds()}/projects`, { access: false })).status).toBe(401);
    expect((await call(`${ds()}/projects`, { token: null })).status).toBe(401);
    expect((await call(`${ds()}/projects`, { token: "rk1_" + "0".repeat(32) + "_" + "A".repeat(43) })).status).toBe(401);
    expect((await call(`${ds()}/projects`)).status).toBe(200);
  });

  it("treats the path datastore as a selector that must match the credential", async () => {
    const res = await call(`/datastores/${w.ds2}/projects`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "not_found" });
  });

  it("answers problem documents for unknown routes and 405 for wrong methods", async () => {
    expect((await call(`${ds()}/nope`)).status).toBe(404);
    const res = await call(`${ds()}/projects`, { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });
});

describe("issues over HTTP", () => {
  it("creates idempotently, then edits with If-Match and transitions", async () => {
    const k = key("http");
    const body = JSON.stringify({ projectId: w.eng, title: "Via HTTP" });
    const created = await call(`${ds()}/issues`, { method: "POST", body, headers: { "idempotency-key": k } });
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe('"r1"');
    const issue = (await created.json()) as { id: string; createdBy: { kind: string } };
    expect(issue.createdBy.kind).toBe("service");

    const replay = await call(`${ds()}/issues`, { method: "POST", body, headers: { "idempotency-key": k } });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(((await replay.json()) as { id: string }).id).toBe(issue.id);

    const conflictKey = await call(`${ds()}/issues`, { method: "POST", body: JSON.stringify({ projectId: w.eng, title: "Other" }), headers: { "idempotency-key": k } });
    expect(conflictKey.status).toBe(409);
    expect(await conflictKey.json()).toMatchObject({ code: "idempotency_conflict" });

    const noIfMatch = await call(`${ds()}/issues/${issue.id}`, { method: "PATCH", body: JSON.stringify({ title: "x" }), headers: { "idempotency-key": key() } });
    expect(noIfMatch.status).toBe(428);

    const edited = await call(`${ds()}/issues/${issue.id}`, { method: "PATCH", body: JSON.stringify({ title: "Edited" }), headers: { "idempotency-key": key(), "if-match": '"r1"' } });
    expect(edited.status).toBe(200);
    expect(edited.headers.get("etag")).toBe('"r2"');

    const stale = await call(`${ds()}/issues/${issue.id}`, { method: "PATCH", body: JSON.stringify({ title: "Stale" }), headers: { "idempotency-key": key(), "if-match": '"r1"' } });
    expect(stale.status).toBe(412);
    expect(stale.headers.get("etag")).toBe('"r2"');

    const badFlow = await call(`${ds()}/issues/${issue.id}/transitions`, { method: "POST", body: JSON.stringify({ toState: "done" }), headers: { "idempotency-key": key(), "if-match": '"r2"' } });
    expect(badFlow.status).toBe(409);
    expect(await badFlow.json()).toMatchObject({ code: "workflow_conflict" });

    const moved = await call(`${ds()}/issues/${issue.id}/transitions`, { method: "POST", body: JSON.stringify({ toState: "todo" }), headers: { "idempotency-key": key(), "if-match": '"r2"' } });
    expect(moved.status).toBe(200);

    const comment = await call(`${ds()}/issues/${issue.id}/comments`, { method: "POST", body: JSON.stringify({ body: "from the API" }), headers: { "idempotency-key": key() } });
    expect(comment.status).toBe(201);
    const comments = (await (await call(`${ds()}/issues/${issue.id}/comments`)).json()) as { items: unknown[] };
    expect(comments.items).toHaveLength(1);
  });

  it("enforces credential scopes", async () => {
    const res = await call(`${ds()}/issues`, { method: "POST", token: readOnlySecret, body: JSON.stringify({ projectId: w.eng, title: "no" }), headers: { "idempotency-key": key() } });
    expect(res.status).toBe(403);
    expect((await call(`${ds()}/audit`)).status).toBe(403);
  });

  it("bounds bodies and validates them without echoing values", async () => {
    const big = JSON.stringify({ projectId: w.eng, title: "x", description: "y".repeat(70_000) });
    expect((await call(`${ds()}/issues`, { method: "POST", body: big, headers: { "idempotency-key": key() } })).status).toBe(413);
    const bad = await call(`${ds()}/issues`, { method: "POST", body: JSON.stringify({ projectId: w.eng, title: "<script>secret</script>".repeat(20) }), headers: { "idempotency-key": key() } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("secret");
    expect((await call(`${ds()}/issues`, { method: "POST", body: "{nope", headers: { "idempotency-key": key() } })).status).toBe(400);
    expect((await call(`${ds()}/issues`, { method: "POST", body: JSON.stringify({ projectId: w.eng, title: "k" }) })).status).toBe(400);
  });

  it("applies rate limits per credential", async () => {
    const limited: ApiDeps = { ...deps, rateLimit: async () => false };
    const res = await handleApi(new Request(`https://records.test${API_PREFIX}${ds()}/projects`, {
      headers: { "cf-access-jwt-assertion": "valid", authorization: `Bearer ${secret}` },
    }), limited);
    expect(res.status).toBe(429);
  });
});

describe("HTTP / domain parity", () => {
  it("returns the same issue list as the domain call made with the same caller", async () => {
    const auth = (await w.service.registry.authenticateCredential(secret))!;
    const direct = await w.service.projects.listIssues(auth.caller, w.ds1, { order: "number_asc", limit: 10 });
    const viaHttp = await (await call(`${ds()}/issues?order=number_asc&limit=10`)).json();
    expect(viaHttp).toEqual(JSON.parse(JSON.stringify(direct)));
  });

  it("revoking the credential stops the API immediately", async () => {
    const created = await w.service.registry.createCredential(w.olive.caller, w.ds1, { label: "Short-lived", scopes: ["issues.read"], expiresInDays: 1 });
    expect((await call(`${ds()}/issues`, { token: created.secret })).status).toBe(200);
    await w.service.registry.revokeCredential(w.olive.caller, w.ds1, created.credential.id);
    expect((await call(`${ds()}/issues`, { token: created.secret })).status).toBe(401);
  });
});
