// Retry, idempotency and error behaviour of the TypeScript runtime, with a scripted fetch.

import { describe, expect, it } from "vitest";

import { RecordsClient, RecordsNetworkError, RevisionConflictError, retryAfterMs, revisionOf } from "../src/index.js";

type Seen = { method: string; url: string; headers: Record<string, string>; body: string | null };

function scripted(responses: (Response | Error)[]) {
  const seen: Seen[] = [];
  const sleeps: number[] = [];
  const client = new RecordsClient({
    baseUrl: "https://records.test/",
    datastoreId: "0190c1a2-0000-7000-8000-000000000001",
    credential: "rk1_test",
    accessAssertion: "assertion",
    retry: { maxRetries: 3, baseDelayMs: 100 },
    sleep: async (ms) => void sleeps.push(ms),
    fetch: async (request) => {
      seen.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), body: request.body ? await request.text() : null });
      const next = responses.shift();
      if (!next) throw new Error("no scripted response left");
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { client, seen, sleeps };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json", ...headers } });
const problem = (status: number, code: string, headers: Record<string, string> = {}) => json(status, { type: "x", title: code, status, code, detail: code }, headers);
const issue = { id: "i", revision: 1 };

describe("runtime", () => {
  it("sends credentials, the Access assertion and an idempotency key, reusing the key across retries", async () => {
    const { client, seen, sleeps } = scripted([problem(503, "unavailable", { "retry-after": "2" }), json(201, issue)]);
    await client.createIssue({ projectId: "p", title: "t" });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers).toMatchObject({ authorization: "Bearer rk1_test", "cf-access-jwt-assertion": "assertion", "content-type": "application/json" });
    expect(seen[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]!.headers["idempotency-key"]).toBe(seen[0]!.headers["idempotency-key"]);
    expect(seen[0]!.url).toBe("https://records.test/gatekeeper/records/v1/datastores/0190c1a2-0000-7000-8000-000000000001/issues");
    expect(sleeps).toEqual([2000]);
  });

  it("honours Retry-After on 429 and backs off on network errors for reads", async () => {
    const { client, sleeps, seen } = scripted([problem(429, "rate_limited", { "retry-after": "1" }), new TypeError("fetch failed"), json(200, { items: [], nextCursor: null })]);
    await client.listIssues({ q: "x", limit: 5 });
    expect(seen).toHaveLength(3);
    expect(seen[0]!.url).toContain("?q=x&limit=5");
    expect(sleeps[0]).toBe(1000);
    expect(sleeps[1]).toBeGreaterThanOrEqual(0);
    expect(sleeps[1]).toBeLessThanOrEqual(200);
  });

  it("gives up after maxRetries", async () => {
    const { client, seen } = scripted([problem(503, "unavailable"), problem(503, "unavailable"), problem(503, "unavailable"), problem(503, "unavailable")]);
    await expect(client.getWorkflow()).rejects.toMatchObject({ status: 503, code: "unavailable" });
    expect(seen).toHaveLength(4);
    const net = scripted([new TypeError("down"), new TypeError("down"), new TypeError("down"), new TypeError("down")]);
    await expect(net.client.getWorkflow()).rejects.toBeInstanceOf(RecordsNetworkError);
  });

  it("never retries a conflict, a validation error or a forbidden call", async () => {
    for (const [status, code] of [[409, "workflow_conflict"], [400, "validation_failed"], [403, "forbidden"], [500, "internal"]] as const) {
      const { client, seen } = scripted([problem(status, code)]);
      await expect(client.addComment("c", { body: "b" })).rejects.toMatchObject({ status, code });
      expect(seen).toHaveLength(1);
    }
  });

  it("formats If-Match and turns 412 into RevisionConflictError", async () => {
    const { client, seen } = scripted([problem(412, "revision_conflict", { etag: '"r7"' })]);
    const err = await client.editIssue("i", { title: "x" }, { ifMatch: 3, idempotencyKey: "fixed-key-1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RevisionConflictError);
    expect((err as RevisionConflictError).currentRevision).toBe(7);
    expect(seen[0]!.headers).toMatchObject({ "if-match": '"r3"', "idempotency-key": "fixed-key-1" });
    expect(seen[0]!.method).toBe("PATCH");
  });

  it("parses Retry-After dates and ETags", () => {
    const now = Date.parse("2026-09-25T00:00:00Z");
    expect(retryAfterMs("Fri, 25 Sep 2026 00:00:05 GMT", now)).toBe(5000);
    expect(retryAfterMs("soon")).toBeNull();
    expect(revisionOf('W/"r12"')).toBe(12);
    expect(revisionOf("nope")).toBeNull();
  });
});
