import { describe, expect, it, vi } from "vitest";

import { ApiError, createHttpApi, describeError } from "./client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiReturning(response: Response | (() => Promise<Response>)) {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    typeof response === "function" ? response() : response,
  );
  return { api: createHttpApi({ fetch: fetch as unknown as typeof globalThis.fetch }), fetch };
}

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("createHttpApi requests", () => {
  it("builds the search URL with facets=1 by default", async () => {
    const { api, fetch } = apiReturning(jsonResponse(200, { query: { text: "" }, hits: [], facets: [], cursor: null, dense: "ok", tookMs: 1 }));
    await api.search({ q: "atlas in:#design", cursor: "abc" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/gatekeeper/search/api/search?q=atlas+in%3A%23design&cursor=abc&facets=1");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.method).toBe("GET");
  });

  it("sends facets=0 when asked not to count", async () => {
    const { api, fetch } = apiReturning(jsonResponse(200, { hits: [] }));
    await api.search({ q: "x", facets: false });
    expect(String(fetch.mock.calls[0]![0])).toContain("facets=0");
  });

  it("URL-encodes document ids", async () => {
    const { api, fetch } = apiReturning(jsonResponse(200, { documentId: "chat:a/b c" }));
    await api.document("chat:a/b c");
    expect(fetch.mock.calls[0]![0]).toBe("/gatekeeper/search/api/documents/chat%3Aa%2Fb%20c");
  });

  it("unwraps sources and requeue, and POSTs requeue", async () => {
    const sources = apiReturning(jsonResponse(200, { sources: [{ source: "chat", label: "Team chat", documents: 3, lastUpdatedAt: null }] }));
    expect(await sources.api.sources()).toHaveLength(1);
    const requeue = apiReturning(jsonResponse(200, { queued: 7 }));
    expect(await requeue.api.requeue()).toBe(7);
    expect(requeue.fetch.mock.calls[0]![1]?.method).toBe("POST");
    expect(requeue.fetch.mock.calls[0]![0]).toBe("/gatekeeper/search/api/admin/requeue");
  });
});

describe("createHttpApi errors", () => {
  it("uses the ErrorEnvelope's code and message", async () => {
    const { api } = apiReturning(jsonResponse(400, { error: { code: "invalid_request", message: "No scope called #nope." } }));
    const error = await caught(api.search({ q: "in:#nope" }));
    expect(error.code).toBe("invalid_request");
    expect(error.message).toBe("No scope called #nope.");
    expect(error.status).toBe(400);
  });

  it("maps a 401 to unauthenticated and asks for sign-in", async () => {
    const { api } = apiReturning(jsonResponse(401, { error: { code: "unauthenticated", message: "no jwt" } }));
    const error = await caught(api.me());
    expect(error.code).toBe("unauthenticated");
    expect(describeError(error).signIn).toBe(true);
  });

  it("falls back to the status when the body is not an envelope", async () => {
    const { api } = apiReturning(new Response("<html>Bad gateway</html>", { status: 403 }));
    const error = await caught(api.stats());
    expect(error.code).toBe("forbidden");
    expect(error.message).toBe("Request failed (403).");
    const five = apiReturning(new Response("", { status: 502 }));
    expect((await caught(five.api.stats())).code).toBe("internal");
  });

  it("ignores an unknown code in the envelope", async () => {
    const { api } = apiReturning(jsonResponse(429, { error: { code: "made_up", message: "slow" } }));
    const error = await caught(api.search({ q: "x" }));
    expect(error.code).toBe("rate_limited");
    expect(describeError(error).message).toMatch(/Too many/u);
  });

  it("treats a redirect (Access sign-in) as unauthenticated", async () => {
    const { api } = apiReturning(new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/" } }));
    const error = await caught(api.search({ q: "x" }));
    expect(error.code).toBe("unauthenticated");
  });

  it("reports a network failure as status 0", async () => {
    const { api } = apiReturning(() => Promise.reject(new TypeError("Failed to fetch")));
    const error = await caught(api.sources());
    expect(error.status).toBe(0);
    expect(error.message).toMatch(/network/iu);
  });

  it("rethrows an abort untouched", async () => {
    const { api } = apiReturning(() => Promise.reject(new DOMException("Aborted", "AbortError")));
    await expect(api.search({ q: "x" })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects an unreadable 200", async () => {
    const { api } = apiReturning(new Response("<html>login</html>", { status: 200 }));
    const error = await caught(api.me());
    expect(error.code).toBe("internal");
  });
});
