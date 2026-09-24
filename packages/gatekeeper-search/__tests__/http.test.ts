// The Worker's HTTP face: Access, the Origin check, the JSON API and the SPA.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  API_PREFIX,
  APP_BASE,
  INDEX_NAME,
  SEARCH_PREFIX,
  type DocumentText,
  type ErrorEnvelope,
  type IndexStats,
  type Me,
  type OmniSearchResult,
} from "../src/shared/contract.js";
import productionWorker from "../src/index.js";
import { createHandler } from "../src/handler.js";
import { errorFromThrown, originAllowed } from "../src/serve.js";
import { RATE_LIMIT_PREFIX } from "../src/do/limits.js";
import { adminEmails } from "../src/env.js";
import { chatDoc } from "./helpers.js";

const ORIGIN = "https://search.example.test";

// A test verifier: the "token" is the claims as JSON. Only this seam differs from production.
const testWorker = createHandler(async (token) => JSON.parse(token) as Record<string, unknown>);

type IncomingRequest = Parameters<NonNullable<typeof productionWorker.fetch>>[0];

function call(worker: ExportedHandler<never>, request: Request): Promise<Response> {
  return (worker.fetch as (r: IncomingRequest, e: unknown, c: unknown) => Promise<Response>)(
    request as IncomingRequest,
    env,
    {},
  );
}

function asUser(path: string, who: { sub: string; email: string }, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", JSON.stringify(who));
  return new Request(`${ORIGIN}${path}`, { ...init, headers });
}

const ADMIN = { sub: "sub-admin", email: "Admin@Example.test" };
const USER = { sub: "sub-user", email: "user@example.test" };

describe("Access", () => {
  it("401s with the JSON envelope when there is no assertion, API and shell alike", async () => {
    for (const path of [`${API_PREFIX}/me`, APP_BASE, `${API_PREFIX}/search?q=x`]) {
      const response = await call(productionWorker as never, new Request(`${ORIGIN}${path}`));
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("unauthenticated");
    }
  });

  it("401s an assertion production cannot verify", async () => {
    const response = await call(
      productionWorker as never,
      new Request(`${ORIGIN}${API_PREFIX}/me`, { headers: { "cf-access-jwt-assertion": JSON.stringify(USER) } }),
    );
    expect(response.status).toBe(401);
  });

  it("401s verified claims without a subject", async () => {
    const response = await call(testWorker as never, asUser(`${API_PREFIX}/me`, { sub: "", email: "x@y.z" }));
    expect(response.status).toBe(401);
  });

  it("/api/me names the principal by sub and flags admins", async () => {
    const admin = (await (await call(testWorker as never, asUser(`${API_PREFIX}/me`, ADMIN))).json()) as Me;
    expect(admin).toEqual({ id: "sub-admin", email: "admin@example.test", isAdmin: true });
    const user = (await (await call(testWorker as never, asUser(`${API_PREFIX}/me`, USER))).json()) as Me;
    expect(user.isAdmin).toBe(false);
  });

  it("accepts ADMINS as an array or a JSON string", () => {
    expect(adminEmails({ ADMINS: ["A@x.test"] })).toEqual(["a@x.test"]);
    expect(adminEmails({ ADMINS: '["b@x.test"]' })).toEqual(["b@x.test"]);
    expect(adminEmails({ ADMINS: "not json" })).toEqual([]);
  });
});

describe("API", () => {
  it("searches as the verified person, privately cached", async () => {
    const index = env.SEARCH_INDEX.get(env.SEARCH_INDEX.idFromName(INDEX_NAME));
    const word = `zq${crypto.randomUUID().slice(0, 6)}`;
    await index.ingest("chat", {
      principals: [{ scope: "chat:http-private", replace: [USER.sub] }],
      upserts: [
        chatDoc(`h-${word}-1`, `public ${word}`),
        chatDoc(`h-${word}-2`, `private ${word}`, { scope: "chat:http-private", vis: "scoped" }),
      ],
    });
    const response = await call(testWorker as never, asUser(`${API_PREFIX}/search?q=${word}&limit=5`, USER));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const result = (await response.json()) as OmniSearchResult;
    expect(result.hits).toHaveLength(2);

    const admin = (await (await call(testWorker as never, asUser(`${API_PREFIX}/search?q=${word}&facets=0`, ADMIN))).json()) as OmniSearchResult;
    expect(admin.hits.map((hit) => hit.documentId)).toEqual([`chat:h-${word}-1`]);
    expect(admin.facets).toEqual([]);

    const doc = await call(testWorker as never, asUser(`${API_PREFIX}/documents/${encodeURIComponent(`chat:h-${word}-2`)}`, USER));
    expect(doc.status).toBe(200);
    expect(((await doc.json()) as DocumentText).text).toBe(`private ${word}`);
    const hidden = await call(testWorker as never, asUser(`${API_PREFIX}/documents/${encodeURIComponent(`chat:h-${word}-2`)}`, ADMIN));
    expect(hidden.status).toBe(404);

    const sources = (await (await call(testWorker as never, asUser(`${API_PREFIX}/sources`, USER))).json()) as {
      sources: { source: string }[];
    };
    expect(sources.sources.map((s) => s.source)).toContain("chat");
  });

  it("turns caller mistakes into 400 envelopes", async () => {
    for (const path of [`${API_PREFIX}/search?q=x&cursor=zzz`, `${API_PREFIX}/search?q=x&limit=0`, `${API_PREFIX}/search?q=before:nope`]) {
      const response = await call(testWorker as never, asUser(path, USER));
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorEnvelope).error.code).toBe("invalid_request");
    }
    const unknown = await call(testWorker as never, asUser(`${API_PREFIX}/nope`, USER));
    expect(unknown.status).toBe(404);
  });

  it("maps rate limits to 429 with retry-after and hides internal errors", async () => {
    const limited = errorFromThrown(new Error(`${RATE_LIMIT_PREFIX}17`));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("17");
    const internal = errorFromThrown(new Error("SQLITE_ERROR: secret details"));
    expect(internal.status).toBe(500);
    expect(JSON.stringify(await internal.json())).not.toContain("SQLITE");
  });

  it("admin routes: 403 for non-admins, stats and requeue for admins", async () => {
    expect((await call(testWorker as never, asUser(`${API_PREFIX}/admin/stats`, USER))).status).toBe(403);
    const stats = await call(testWorker as never, asUser(`${API_PREFIX}/admin/stats`, ADMIN));
    expect(stats.status).toBe(200);
    expect(typeof ((await stats.json()) as IndexStats).documents).toBe("number");

    const post = (who: typeof USER, origin?: string) =>
      call(
        testWorker as never,
        asUser(`${API_PREFIX}/admin/requeue`, who, { method: "POST", headers: origin === undefined ? {} : { origin } }),
      );
    expect((await post(USER, ORIGIN)).status).toBe(403);
    expect((await post(ADMIN)).status).toBe(403);
    expect((await post(ADMIN, "https://evil.example")).status).toBe(403);
    const ok = await post(ADMIN, ORIGIN);
    expect(ok.status).toBe(200);
    expect(typeof ((await ok.json()) as { queued: number }).queued).toBe("number");
  });

  it("origin check: GET passes, writes need this origin", () => {
    const base = { PUBLIC_BASE_URL: ORIGIN };
    expect(originAllowed(new Request(`${ORIGIN}${API_PREFIX}/me`), base)).toBe(true);
    const post = (origin?: string) =>
      new Request(`${ORIGIN}${API_PREFIX}/admin/requeue`, { method: "POST", headers: origin ? { origin } : {} });
    expect(originAllowed(post(ORIGIN), base)).toBe(true);
    expect(originAllowed(post("https://evil.example"), base)).toBe(false);
    expect(originAllowed(post(), base)).toBe(false);
    expect(originAllowed(post(ORIGIN), { PUBLIC_BASE_URL: "not a url" })).toBe(true);
  });
});

describe("SPA", () => {
  it("redirects the bare prefix to the app base", async () => {
    const response = await call(testWorker as never, asUser(SEARCH_PREFIX, USER));
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).pathname).toBe(APP_BASE);
  });

  it("serves the shell with a CSP, for the base (with a query) and for client routes", async () => {
    for (const path of [APP_BASE, `${APP_BASE}?q=kubernetes`, `${APP_BASE}d/chat%3Am1`, `${APP_BASE}index.html`]) {
      const response = await call(testWorker as never, asUser(path, USER));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("location")).toBeNull();
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'self'");
      expect(await response.text()).toContain('<div id="root">');
    }
  });

  it("serves built assets without the shell headers and 404s a missing one", async () => {
    const asset = await call(testWorker as never, asUser(`${APP_BASE}assets/app-test.js`, USER));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-security-policy")).toBeNull();
    const boot = await call(testWorker as never, asUser(`${APP_BASE}theme-boot.js`, USER));
    expect(boot.status).toBe(200);
    expect(boot.headers.get("content-type")).toContain("javascript");
    const missing = await call(testWorker as never, asUser(`${APP_BASE}assets/index-deadbeef.js`, USER));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("application/json");
  });

  it("404s paths outside the prefix", async () => {
    const response = await call(testWorker as never, asUser("/elsewhere", USER));
    expect(response.status).toBe(404);
  });
});
