// The identity boundary: what the production entry point refuses, what the dev entry point allows,
// and the fact that the two are not the same Worker.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { identityFromClaims } from "../src/access.js";
import devWorker, * as devEntry from "../src/dev/entry.js";
import { DEV_COOKIE_NAME, signIdentityId } from "../src/dev/cookie.js";
import productionWorker, * as productionEntry from "../src/index.js";
import { serveChat, originAllowed } from "../src/serve.js";
import { IDENTITY_HEADER, type ErrorEnvelope, type MeResponse } from "../src/shared/protocol.js";
import { apiPath, APP_BASE, CHAT_PREFIX, WS_PATH } from "../src/shared/routes.js";

const ORIGIN = "https://chat.example.test";

// `ExportedHandler` types its request as an *incoming* one (`IncomingRequestCfProperties`), which a
// hand-built Request is not. Narrowing here keeps the cast out of every test.
type IncomingRequest = Parameters<typeof productionWorker.fetch>[0];

function callProduction(request: Request): Promise<Response> {
  return productionWorker.fetch(request as IncomingRequest, env);
}

function callDev(request: Request): Promise<Response> {
  return devWorker.fetch(request as IncomingRequest, env);
}

async function devCookieHeader(id: string): Promise<string> {
  return `${DEV_COOKIE_NAME}=${encodeURIComponent(await signIdentityId(id, env.DEV_IDENTITY_SECRET))}`;
}

describe("production entry point", () => {
  it("rejects a request with no Access assertion", async () => {
    const response = await callProduction(new Request(`${ORIGIN}${apiPath("me")}`));
    expect(response.status).toBe(401);
    const body = (await response.json()) as ErrorEnvelope;
    expect(body.error.code).toBe("unauthenticated");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects an assertion that is not a well-formed token", async () => {
    const response = await callProduction(
      new Request(`${ORIGIN}${apiPath("me")}`, { headers: { "cf-access-jwt-assertion": "not-a-jwt" } }),
    );
    expect(response.status).toBe(401);
  });

  it("ignores a valid dev identity cookie", async () => {
    // The bypass is not compiled into this entry point, so a cookie the dev server would accept has
    // no effect here. DEV_IDENTITIES and DEV_IDENTITY_SECRET are both configured in this environment.
    const response = await callProduction(
      new Request(`${ORIGIN}${apiPath("me")}`, { headers: { cookie: await devCookieHeader("dev-admin") } }),
    );
    expect(response.status).toBe(401);
  });

  it("ignores a client-supplied identity header", async () => {
    const response = await callProduction(
      new Request(`${ORIGIN}${apiPath("me")}`, {
        headers: { [IDENTITY_HEADER]: JSON.stringify({ id: "attacker", email: "a@b.test" }) },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects the SPA shell too, so run_worker_first is load bearing", async () => {
    const response = await callProduction(new Request(`${ORIGIN}${APP_BASE}`));
    expect(response.status).toBe(401);
  });
});

describe("identityFromClaims", () => {
  it("uses the Access subject as the user key", () => {
    expect(identityFromClaims({ sub: "abc123", email: "Harry@Example.Test" })).toEqual({
      id: "abc123",
      email: "harry@example.test",
    });
  });

  it("refuses claims with no subject or no email", () => {
    expect(identityFromClaims({ email: "harry@example.test" })).toBeNull();
    expect(identityFromClaims({ sub: "abc123" })).toBeNull();
    expect(identityFromClaims({ sub: "", email: "harry@example.test" })).toBeNull();
  });
});

describe("origin check", () => {
  const publicBase = { PUBLIC_BASE_URL: ORIGIN };

  it("allows a plain GET with no Origin", () => {
    expect(originAllowed(new Request(`${ORIGIN}${apiPath("me")}`), publicBase)).toBe(true);
  });

  it("requires a matching Origin on a WebSocket upgrade", () => {
    const upgrade = (origin?: string) =>
      new Request(`${ORIGIN}${WS_PATH}`, {
        headers: { Upgrade: "websocket", ...(origin === undefined ? {} : { Origin: origin }) },
      });
    expect(originAllowed(upgrade(ORIGIN), publicBase)).toBe(true);
    expect(originAllowed(upgrade("https://evil.example"), publicBase)).toBe(false);
    expect(originAllowed(upgrade(), publicBase)).toBe(false);
  });

  it("requires a matching Origin on a write", () => {
    const post = (origin?: string) =>
      new Request(`${ORIGIN}${apiPath("createChannel")}`, {
        method: "POST",
        headers: origin === undefined ? {} : { Origin: origin },
      });
    expect(originAllowed(post(ORIGIN), publicBase)).toBe(true);
    expect(originAllowed(post("https://evil.example"), publicBase)).toBe(false);
    expect(originAllowed(post(), publicBase)).toBe(false);
  });

  it("falls back to the request's own origin when PUBLIC_BASE_URL is unusable", () => {
    const post = new Request(`${ORIGIN}${apiPath("createChannel")}`, {
      method: "POST",
      headers: { Origin: ORIGIN },
    });
    expect(originAllowed(post, { PUBLIC_BASE_URL: "not a url" })).toBe(true);
  });
});

describe("serveChat, with an already-verified identity", () => {
  const identity = { id: "sub-1", email: "admin@example.test", name: "Test Admin" };

  it("answers /api/me from the Durable Object", async () => {
    const response = await serveChat(new Request(`${ORIGIN}${apiPath("me")}`), env, identity);
    expect(response.status).toBe(200);
    const me = (await response.json()) as MeResponse;
    expect(me.user).toMatchObject({ id: "sub-1", email: "admin@example.test", name: "Test Admin" });
    // ADMINS in this environment lists admin@example.test.
    expect(me.admin).toBe(true);
    expect(me.limits.maxBodyBytes).toBe(8 * 1024);
    // From the MAX_UPLOAD_BYTES var (scripts/deploy.ts sets it from chat.maxUploadBytes), not the
    // protocol default of 10 MiB.
    expect(me.limits.maxUploadBytes).toBe(4 * 1024 * 1024);
  });

  it("does not make a non-admin an admin", async () => {
    const response = await serveChat(new Request(`${ORIGIN}${apiPath("me")}`), env, {
      id: "sub-2",
      email: "someone@example.test",
    });
    const me = (await response.json()) as MeResponse;
    expect(me.admin).toBe(false);
    // No name in the assertion, so the email local part is the display name.
    expect(me.user.name).toBe("someone");
  });

  it("rejects a cross-origin write before it reaches the object", async () => {
    const response = await serveChat(
      new Request(`${ORIGIN}${apiPath("createChannel")}`, {
        method: "POST",
        headers: { Origin: "https://evil.example", "content-type": "application/json" },
        body: "{}",
      }),
      env,
      identity,
    );
    expect(response.status).toBe(403);
  });

  it("reports an unimplemented route by name rather than 404", async () => {
    // Web Push is phase 3. A route the contract names but the object does not serve answers 501 with
    // the route's name, so a client can tell "not yet" from "wrong URL".
    const response = await serveChat(
      new Request(`${ORIGIN}${apiPath("subscribePush")}`, {
        method: "POST",
        headers: { Origin: ORIGIN, "content-type": "application/json" },
        body: "{}",
      }),
      env,
      identity,
    );
    expect(response.status).toBe(501);
    const body = (await response.json()) as ErrorEnvelope;
    expect(body.error).toMatchObject({ code: "not_implemented" });
    expect(body.error.message).toContain("subscribePush");
  });

  it("404s a path that is not in the route table", async () => {
    const response = await serveChat(new Request(`${ORIGIN}${CHAT_PREFIX}/api/nope`), env, identity);
    expect(response.status).toBe(404);
  });

  it("serves the SPA shell and falls back to it for a permalink", async () => {
    const shell = await serveChat(new Request(`${ORIGIN}${APP_BASE}`), env, identity);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toContain("text/html");

    const permalink = await serveChat(
      new Request(`${ORIGIN}${CHAT_PREFIX}/c/general/m/abc`),
      env,
      identity,
    );
    expect(permalink.status).toBe(200);
    expect(permalink.headers.get("content-type")).toContain("text/html");
    // The asset server answers an explicit `index.html` with a redirect whose Location has lost the
    // prefix; forwarding it would bounce the browser out of the app.
    expect(permalink.headers.get("location")).toBeNull();
    expect(await permalink.text()).toContain('<div id="root">');
  });

  it("serves the shell for an explicit index.html rather than redirecting out of the prefix", async () => {
    const response = await serveChat(new Request(`${ORIGIN}${APP_BASE}index.html`), env, identity);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("404s a missing build asset instead of serving the shell", async () => {
    // A hashed filename that is not in the manifest is a stale bundle, not a client route. Answering
    // the shell would hand a `<script type="module">` an HTML body, which the browser reports as a
    // MIME-type refusal -- a much worse error than a 404.
    const response = await serveChat(
      new Request(`${ORIGIN}${APP_BASE}assets/index-deadbeef.js`),
      env,
      identity,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("redirects the prefix without a trailing slash", async () => {
    const response = await serveChat(new Request(`${ORIGIN}${CHAT_PREFIX}`), env, identity);
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).pathname).toBe(APP_BASE);
  });
});

describe("dev entry point", () => {
  it("refuses an unknown dev identity", async () => {
    const response = await callDev(new Request(`${ORIGIN}${CHAT_PREFIX}/dev/login?as=nobody`));
    expect(response.status).toBe(400);
  });

  it("mints a signed, HttpOnly cookie scoped to the app", async () => {
    const response = await callDev(new Request(`${ORIGIN}${CHAT_PREFIX}/dev/login?as=dev-admin`));
    expect(response.status).toBe(302);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${DEV_COOKIE_NAME}=dev-admin.`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain(`Path=${APP_BASE}`);
    expect(response.headers.get("location")).toBe(APP_BASE);
  });

  it("serves the API for a request carrying the cookie", async () => {
    const response = await callDev(
      new Request(`${ORIGIN}${apiPath("me")}`, { headers: { cookie: await devCookieHeader("dev-admin") } }),
    );
    expect(response.status).toBe(200);
    const me = (await response.json()) as MeResponse;
    expect(me.user.id).toBe("dev-admin");
    expect(me.user.name).toBe("Dev Admin");
  });

  it("rejects a cookie whose signature does not match", async () => {
    const forged = `${DEV_COOKIE_NAME}=dev-admin.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const response = await callDev(new Request(`${ORIGIN}${apiPath("me")}`, { headers: { cookie: forged } }));
    expect(response.status).toBe(401);
  });

  it("rejects a cookie signed for an identity that is not configured", async () => {
    const response = await callDev(
      new Request(`${ORIGIN}${apiPath("me")}`, { headers: { cookie: await devCookieHeader("retired-user") } }),
    );
    expect(response.status).toBe(401);
  });

  it("clears the cookie on logout", async () => {
    const response = await callDev(new Request(`${ORIGIN}${CHAT_PREFIX}/dev/logout`));
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("answers 401 with a usable hint when there is no identity at all", async () => {
    const response = await callDev(new Request(`${ORIGIN}${apiPath("me")}`));
    expect(response.status).toBe(401);
    const body = (await response.json()) as ErrorEnvelope;
    expect(body.error.message).toContain("/dev/login");
  });
});

/** The exported classes of an entry module, by name. A `default` handler is an object, not a class. */
function classesOf(module: Record<string, unknown>): string[] {
  return Object.keys(module)
    .filter((name) => typeof module[name] === "function")
    .toSorted();
}

describe("Durable Object exports", () => {
  /**
   * A class named in a `migrations` tag must be exported by whatever `main` points at, or workerd
   * refuses to start the Worker at all: "Class extends value undefined is not a constructor or null",
   * from miniflare's DO wrapper. `wrangler.dev.jsonc` carries the same v0/v1 tags as `wrangler.jsonc`,
   * so the dev entry needs every class the production entry has -- which is not obvious, because the
   * vendor is useless on a dev server and the failure is a boot error rather than a missing feature.
   */
  it("the dev entry exports every class the production entry does", () => {
    expect(classesOf(devEntry)).toEqual(classesOf(productionEntry));
  });

  it("names the classes the migrations declare", () => {
    expect(Object.keys(devEntry)).toContain("ChatWorkspace");
    expect(Object.keys(devEntry)).toContain("ChatGatekeeper");
  });
});
