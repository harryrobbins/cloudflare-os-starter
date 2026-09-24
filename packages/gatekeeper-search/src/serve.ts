// What the fetch handler does once Access has vouched for the caller: the Origin check, the JSON API
// (contract "HTTP"), and the SPA from ASSETS for everything else under the prefix.

import {
  API_PREFIX,
  APP_BASE,
  INDEX_NAME,
  INPUT_ERROR_PREFIX,
  SEARCH_PREFIX,
  type Me,
  type SearchCaller,
  type SearchRequest,
} from "./shared/contract.js";
import type { SearchIdentity } from "./access.js";
import { indexStub, isAdminEmail, type SearchEnv } from "./env.js";
import { errorResponse, forbidden, invalidRequest, json, notFound } from "./http.js";
import { RATE_LIMIT_PREFIX } from "./do/limits.js";
import { logEvent } from "./do/log.js";

/**
 * Cross-origin defence: a state-changing request must come from this deployment's own origin. A
 * missing `Origin` on a non-GET is rejected too, since browsers always send it for those.
 */
export function originAllowed(request: Request, env: Pick<SearchEnv, "PUBLIC_BASE_URL">): boolean {
  const url = new URL(request.url);
  if (request.method === "GET" || request.method === "HEAD") return true;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  const allowed = new Set<string>();
  for (const candidate of [env.PUBLIC_BASE_URL, url.origin]) {
    if (!candidate) continue;
    try {
      allowed.add(new URL(candidate).origin);
    } catch {
      // A misconfigured PUBLIC_BASE_URL must not widen the check.
    }
  }
  return allowed.has(origin);
}

/** Serves one request for an already-verified caller. */
export async function serveSearch(request: Request, env: SearchEnv, identity: SearchIdentity): Promise<Response> {
  const url = new URL(request.url);
  if (!originAllowed(request, env)) return forbidden("Cross-origin request rejected.");
  if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
    try {
      return await serveApi(request, env, identity, url);
    } catch (error) {
      return errorFromThrown(error);
    }
  }
  return serveApp(request, env, url);
}

function person(identity: SearchIdentity): SearchCaller {
  return { kind: "person", principal: identity.id };
}

async function serveApi(request: Request, env: SearchEnv, identity: SearchIdentity, url: URL): Promise<Response> {
  const path = url.pathname.slice(API_PREFIX.length);
  const index = indexStub(env, INDEX_NAME);
  const isAdmin = isAdminEmail(env, identity.email);
  const method = request.method;

  if (path === "/me") {
    if (method !== "GET") return methodNotAllowed();
    const me: Me = { id: identity.id, email: identity.email, isAdmin };
    return json(me);
  }
  if (path === "/search") {
    if (method !== "GET") return methodNotAllowed();
    const search: SearchRequest = { q: url.searchParams.get("q") ?? "" };
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && cursor !== "") search.cursor = cursor;
    const limit = url.searchParams.get("limit");
    if (limit !== null && limit !== "") {
      const parsed = Number(limit);
      if (!Number.isInteger(parsed) || parsed < 1) return invalidRequest("limit must be a positive integer.");
      search.limit = parsed;
    }
    const facets = url.searchParams.get("facets");
    if (facets === "0" || facets === "false") search.facets = false;
    return json(await index.search(person(identity), search));
  }
  if (path === "/sources") {
    if (method !== "GET") return methodNotAllowed();
    return json({ sources: await index.sources(person(identity)) });
  }
  if (path.startsWith("/documents/")) {
    if (method !== "GET") return methodNotAllowed();
    let id: string;
    try {
      id = decodeURIComponent(path.slice("/documents/".length));
    } catch {
      return invalidRequest("The document id is not valid URL encoding.");
    }
    if (id.length === 0) return notFound();
    const document = await index.open(person(identity), id);
    return document === null ? notFound("No such document.") : json(document);
  }
  if (path === "/admin/stats") {
    if (method !== "GET") return methodNotAllowed();
    if (!isAdmin) return forbidden("Admins only.");
    return json(await index.stats());
  }
  if (path === "/admin/requeue") {
    if (method !== "POST") return methodNotAllowed();
    if (!isAdmin) return forbidden("Admins only.");
    return json({ queued: await index.requeuePending() });
  }
  return notFound();
}

function methodNotAllowed(): Response {
  return invalidRequest("That method is not supported on this path.");
}

/** Maps the index's thrown errors to the contract's envelope. Never returns a stack trace. */
export function errorFromThrown(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(INPUT_ERROR_PREFIX)) {
    return invalidRequest(message.slice(INPUT_ERROR_PREFIX.length));
  }
  if (message.startsWith(RATE_LIMIT_PREFIX)) {
    const retryAfter = Number(message.slice(RATE_LIMIT_PREFIX.length));
    return errorResponse("rate_limited", "Too many searches; try again shortly.", Number.isFinite(retryAfter) ? retryAfter : 60);
  }
  logEvent("search.error", { message: message.slice(0, 200) });
  return errorResponse("internal", "Search could not handle that request.");
}

// ---------------------------------------------------------------------------
// The SPA (the same recipe as packages/gatekeeper-chat/src/serve.ts and its spikes/README.md)
// ---------------------------------------------------------------------------

/**
 * Static assets with a single-page-app fallback. The prefix is stripped before the assets binding
 * sees the request, because the asset server resolves paths against the directory and knows nothing
 * of Vite's `base`.
 */
async function serveApp(request: Request, env: SearchEnv, url: URL): Promise<Response> {
  if (url.pathname === SEARCH_PREFIX) {
    return Response.redirect(new URL(APP_BASE + url.search, url).toString(), 302);
  }
  if (!url.pathname.startsWith(APP_BASE)) return notFound();

  const direct = await env.ASSETS.fetch(assetRequest(request, url, url.pathname));
  if (direct.ok) return withShellHeaders(direct);
  if (direct.status === 304) return direct;

  // A miss under assets/ is a missing build artefact, never a client route: answering the shell
  // would hand a module script an HTML body.
  if (url.pathname.startsWith(`${APP_BASE}assets/`)) return notFound();

  // Requested as the app base rather than `index.html`: the asset server turns an explicit
  // `index.html` into a redirect whose Location has lost the prefix.
  const shell = await env.ASSETS.fetch(assetRequest(request, url, APP_BASE));
  if (!shell.ok) return notFound();
  const headers = new Headers(shell.headers);
  headers.delete("location");
  return withShellHeaders(new Response(shell.body, { status: 200, headers }));
}

/**
 * The shell's Content Security Policy. Same-origin JSON only (no socket), scripts from 'self', inline
 * styles allowed for React style attributes. `frame-ancestors 'self'` lets the shell frame it.
 */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

function withShellHeaders(response: Response): Response {
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", contentSecurityPolicy());
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  // The shell is served only to a verified caller; no shared cache may keep it.
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, { status: response.status, headers });
}

function assetRequest(request: Request, url: URL, prefixedPath: string): Request {
  const target = new URL(url);
  target.pathname = prefixedPath.slice(SEARCH_PREFIX.length) || "/";
  return new Request(target, request);
}
