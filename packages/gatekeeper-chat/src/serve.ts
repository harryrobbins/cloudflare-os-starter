// What both entry points do once the caller's identity is known: check the origin, hand API,
// WebSocket and file requests to the Durable Object, and serve the SPA for everything else.
//
// Kept separate from `index.ts` so the dev entry can reuse it without the production entry importing
// anything from `src/dev/`.

import { forbidden, notFound } from "./http.js";
import type { ChatEnv } from "./env.js";
import { APP_BASE, CHAT_PREFIX, isWorkerPath } from "./shared/routes.js";
import { IDENTITY_HEADER, type ChatIdentity } from "./shared/protocol.js";

/** The single Durable Object every signed-in user reaches. */
export const WORKSPACE_NAME = "main";

/**
 * Cross-origin defence for the browser paths.
 *
 * A WebSocket upgrade and any state-changing request must come from this deployment's own origin.
 * `Origin` is set by the browser and cannot be forged by page script, so it is the check that stops
 * another site from opening an authenticated socket or issuing a write with the visitor's Access
 * cookie. A missing `Origin` on a non-GET is rejected too: browsers always send it for those, so its
 * absence means a non-browser caller, which has no business on these routes.
 */
export function originAllowed(request: Request, env: Pick<ChatEnv, "PUBLIC_BASE_URL">): boolean {
  const url = new URL(request.url);
  const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  const stateChanging = request.method !== "GET" && request.method !== "HEAD";
  if (!upgrade && !stateChanging) return true;

  const origin = request.headers.get("origin");
  if (origin === null) return false;

  const allowed = new Set<string>();
  for (const candidate of [env.PUBLIC_BASE_URL, url.origin]) {
    if (!candidate) continue;
    try {
      allowed.add(new URL(candidate).origin);
    } catch {
      // A misconfigured PUBLIC_BASE_URL must not widen the check; `url.origin` still covers the
      // same-origin case a dev server needs.
    }
  }
  return allowed.has(origin);
}

/**
 * Serves one request on behalf of an already-verified caller.
 *
 * `identity` is authoritative: callers must not reach this function until the Access assertion (or,
 * on a dev server, the signed dev cookie) has been checked.
 */
export async function serveChat(
  request: Request,
  env: ChatEnv,
  identity: ChatIdentity,
): Promise<Response> {
  const url = new URL(request.url);

  if (!originAllowed(request, env)) {
    return forbidden("Cross-origin request rejected.");
  }

  if (isWorkerPath(url.pathname)) {
    return forwardToWorkspace(request, env, identity);
  }

  // The SPA. `assets.run_worker_first` means even the shell reaches this Worker first, so an
  // unauthenticated browser never gets the app; by here the caller is signed in.
  return serveApp(request, env, url);
}

/**
 * Forwards to the Durable Object with the identity attached.
 *
 * The DO trusts `x-chat-user` because it has no route of its own: the only way to reach it is this
 * Worker's `CHAT_WORKSPACE` binding, and a Durable Object namespace is not addressable from the
 * public internet. The browser's own copy of the header is deleted first, so a client that sets it
 * gains nothing.
 */
function forwardToWorkspace(request: Request, env: ChatEnv, identity: ChatIdentity): Promise<Response> {
  // `set` rather than `append`, so a copy the browser sent is replaced rather than joined.
  const headers = new Headers(request.headers);
  headers.set(IDENTITY_HEADER, JSON.stringify(identity));

  // A WebSocket upgrade's Request cannot be reconstructed with a body, and `new Request(request)`
  // preserves the upgrade only when the body is left alone.
  const forwarded = new Request(request, { headers });
  const stub = env.CHAT_WORKSPACE.get(env.CHAT_WORKSPACE.idFromName(WORKSPACE_NAME));
  return stub.fetch(forwarded);
}

/**
 * Static assets with a single-page-app fallback.
 *
 * `/gatekeeper/chat` (no slash) redirects so the app always runs with the trailing slash its router
 * expects, and any unknown path inside the prefix serves `index.html` so a permalink such as
 * `/gatekeeper/chat/c/<channel>/m/<id>` is routed by the client.
 *
 * The prefix is stripped before the assets binding sees the request. Measured, not assumed (see
 * spikes/README.md): the asset server resolves a URL path against the asset *directory* and does not
 * know about Vite's `base`, so `/gatekeeper/chat/assets/index-<hash>.js` 404s while
 * `/assets/index-<hash>.js` is served. `base` still has to be `/gatekeeper/chat/` because that is
 * what the browser requests.
 */
async function serveApp(request: Request, env: ChatEnv, url: URL): Promise<Response> {
  if (url.pathname === CHAT_PREFIX) {
    return Response.redirect(new URL(APP_BASE + url.search, url).toString(), 302);
  }
  if (!url.pathname.startsWith(APP_BASE)) {
    // The router only forwards this prefix, so this is unreachable in production; answering
    // explicitly keeps a misconfigured binding from serving the app off an unexpected path.
    return notFound();
  }

  const direct = await env.ASSETS.fetch(assetRequest(request, url, url.pathname));
  // 2xx is a real asset; 304 answers a conditional request and must be passed through untouched. The
  // app base itself resolves to `index.html` here, so the shell headers are added by content type.
  if (direct.ok) return withShellHeaders(direct, env, url);
  if (direct.status === 304) return direct;

  // A miss under `assets/` is a missing build artefact, never a client route: Vite writes hashed
  // filenames there and the router has no path that starts with it. Falling through to the shell
  // would answer a `<script type="module">` with HTML, and the browser reports that as a MIME-type
  // refusal rather than a 404 -- which is exactly what a rebuild under a running `wrangler dev` looks
  // like, since the assets binding keeps the manifest it started with.
  if (url.pathname.startsWith(`${APP_BASE}assets/`)) return notFound();

  // Anything else is a client-routed path. The shell is requested as the app base rather than
  // `index.html`, because the asset server's `html_handling` turns an explicit `index.html` into a
  // redirect whose Location has lost the `/gatekeeper/chat` prefix -- which is also why a redirect
  // from the asset server is never forwarded.
  const shell = await env.ASSETS.fetch(assetRequest(request, url, APP_BASE));
  if (!shell.ok) return notFound();
  const headers = new Headers(shell.headers);
  headers.delete("location");
  return withShellHeaders(new Response(shell.body, { status: 200, headers }), env, url);
}

/**
 * The app shell's Content Security Policy (chat.md, "Security checklist"), on every HTML response and
 * nothing else: a hashed script or stylesheet needs no policy of its own.
 *
 * Scripts are `'self'` only, which is why `index.html` loads its theme bootstrap from a file rather
 * than inline. Styles allow inline because React and the picker set style attributes; the policy is
 * there to stop script injection, and a style attribute is not that. Images and media allow `data:`
 * and `blob:` for monograms and upload previews. The socket is same-origin, but older Safari does not
 * read `'self'` as covering `wss:`, so the explicit socket origin is listed too. `frame-ancestors
 * 'self'` is what lets the shell's dock frame this app and nobody else.
 */
export function contentSecurityPolicy(env: Pick<ChatEnv, "PUBLIC_BASE_URL">, requestOrigin: string): string {
  const socket = socketOrigin(env.PUBLIC_BASE_URL) ?? socketOrigin(requestOrigin);
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self'${socket === null ? "" : ` ${socket}`}`,
    "worker-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
}

function socketOrigin(base: string): string | null {
  try {
    const url = new URL(base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`;
  } catch {
    return null;
  }
}

function withShellHeaders(response: Response, env: ChatEnv, url: URL): Response {
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", contentSecurityPolicy(env, url.origin));
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  return new Response(response.body, { status: response.status, headers });
}

/** Rewrites a prefixed path to the path the asset directory actually holds. */
function assetRequest(request: Request, url: URL, prefixedPath: string): Request {
  const target = new URL(url);
  target.pathname = prefixedPath.slice(CHAT_PREFIX.length) || "/";
  return new Request(target, request);
}
