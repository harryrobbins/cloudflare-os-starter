// The OpenAPI document covers every route in api.ts's route table, and nothing api.ts does not serve.
// The table is read from the source (it is not exported), so a route added to api.ts without a
// description here fails this test.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { API_OPERATIONS, OPENAPI_PATH, openApiDocument } from "gatekeeper-records/http/openapi";

const apiSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../gatekeeper-records/src/http/api.ts"), "utf8");
const ID = "([0-9a-f-]{36})";

/** `{ method, pattern }` for each entry of api.ts's `routes` array. */
function apiRoutes(): { method: string; pattern: RegExp }[] {
  const table = apiSource.slice(apiSource.indexOf("const routes: Route[] = ["));
  const out: { method: string; pattern: RegExp }[] = [];
  const entry = /method: "(\w+)", pattern: (?:\/((?:\\.|[^/\n])+)\/|new RegExp\(`((?:[^`])+)`\))/g;
  for (const m of table.matchAll(entry)) {
    const source = m[2] ?? m[3]!.replaceAll("${ID}", ID);
    out.push({ method: m[1]!, pattern: new RegExp(source) });
  }
  return out;
}

const DATASTORE_PREFIX = "/gatekeeper/records/v1/datastores/{datastoreId}";
const SAMPLE_ID = "0190c1a2-0000-7000-8000-000000000001";

describe("OpenAPI document", () => {
  const doc = openApiDocument("https://records.example.test");
  const routes = apiRoutes();

  it("parses api.ts's route table", () => {
    expect(routes.length).toBeGreaterThanOrEqual(16);
  });

  it("describes every route api.ts serves", () => {
    const described = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((method) => ({ method: method.toUpperCase(), path })));
    for (const route of routes) {
      const hit = described.find((d) => d.method === route.method && d.path.startsWith(DATASTORE_PREFIX)
        && route.pattern.test(d.path.slice(DATASTORE_PREFIX.length).replaceAll(/\{\w+\}/g, SAMPLE_ID)));
      expect(hit, `${route.method} ${route.pattern} is missing from the OpenAPI document`).toBeDefined();
    }
  });

  it("describes nothing api.ts does not serve (except the document and the Jira pointer)", () => {
    for (const op of API_OPERATIONS) {
      const concrete = op.path.replaceAll(/\{\w+\}/g, SAMPLE_ID);
      expect(routes.some((r) => r.method === op.method && r.pattern.test(concrete)), `${op.method} ${op.path}`).toBe(true);
    }
    const extra = Object.keys(doc.paths).filter((p) => !p.startsWith(DATASTORE_PREFIX) || p.includes("/jira/"));
    expect(extra.sort()).toEqual([OPENAPI_PATH, `${DATASTORE_PREFIX}/jira/rest/api/{apiVersion}/serverInfo`].sort());
  });

  it("resolves every $ref", () => {
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/(\w+)\/([^"]+)"/g)];
    expect(refs.length).toBeGreaterThan(50);
    const components = doc.components as Record<string, Record<string, unknown>>;
    for (const [, kind, name] of refs) expect(components[kind!]?.[name!], `${kind}/${name}`).toBeDefined();
  });

  it("marks idempotency, If-Match, pagination and the headers the SDKs rely on", () => {
    const op = (path: string, method: string) => (doc.paths[`${DATASTORE_PREFIX}${path}`] as Record<string, any>)[method];
    expect(op("/issues", "post")["x-records-idempotency"]).toBe("key");
    expect(op("/issues/{issueId}", "patch")).toMatchObject({ "x-records-idempotency": "key", "x-records-if-match": true });
    expect(op("/issues/{issueId}", "patch").responses["412"]).toEqual({ $ref: "#/components/responses/PreconditionFailed" });
    expect(op("/issues", "get")["x-records-pagination"]).toMatchObject({ style: "cursor" });
    expect(op("/changes", "get")["x-records-pagination"]).toMatchObject({ style: "seq" });
    expect(op("/sync/push", "post")["x-records-idempotency"]).toBe("natural");
    expect(op("/sync/pull", "post")["x-records-idempotency"]).toBe("safe");
    const components = doc.components as Record<string, any>;
    expect(Object.keys(components.headers)).toEqual(expect.arrayContaining(["ETag", "Retry-After", "Idempotent-Replayed"]));
    expect(Object.keys(components.parameters)).toEqual(expect.arrayContaining(["Idempotency-Key", "If-Match"]));
    expect(components.securitySchemes.delegatedToken).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    expect(components.responses.RateLimited.headers["Retry-After"]).toBeDefined();
    expect(doc.servers[0]!.url).toBe("https://records.example.test");
  });

  it("uses the contracts' own input schemas for request bodies", () => {
    const schemas = (doc.components as Record<string, any>).schemas;
    expect(schemas.CreateIssueRequest.required).toEqual(["projectId", "title"]);
    expect(schemas.CreateIssueRequest.properties.title).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(schemas.EditIssueRequest.additionalProperties).toBe(false);
    expect(schemas.PushRequest.properties.mutations.items.properties.name.enum).toContain("projects.createIssue");
    expect(schemas.Problem.properties.code.enum).toEqual(expect.arrayContaining(["revision_conflict", "revision_required", "rate_limited"]));
  });
});
