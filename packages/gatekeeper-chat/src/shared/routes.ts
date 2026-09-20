// The URL surface, in one place, so the Worker, the Durable Object and the SPA cannot disagree.
//
// Everything is mounted under a single prefix because that is what the router forwards: it scans
// `GATEKEEPER_*` bindings and hands `/gatekeeper/<name>` plus `/gatekeeper/<name>/*` to the matching
// service (cloudflare-os/packages/router/src/index.ts). A path outside the prefix never arrives.

/** Prefix the router forwards to this Worker. No trailing slash. */
export const CHAT_PREFIX = "/gatekeeper/chat";

/** JSON API. */
export const API_PREFIX = `${CHAT_PREFIX}/api`;

/** WebSocket upgrade. */
export const WS_PATH = `${CHAT_PREFIX}/ws`;

/** Authenticated R2 streaming: `/files/:id` and `/files/:id/thumb`. */
export const FILES_PREFIX = `${CHAT_PREFIX}/files`;

/** Dev-identity endpoints. Served only by `src/dev/entry.ts`; production 404s them. */
export const DEV_PREFIX = `${CHAT_PREFIX}/dev`;

/** Where the SPA is mounted. Also Vite's `base`. */
export const APP_BASE = `${CHAT_PREFIX}/`;

/** Permalink to a single message, resolved client-side by TanStack Router. */
export function permalink(channelId: string, messageId: string): string {
  return `${CHAT_PREFIX}/c/${encodeURIComponent(channelId)}/m/${encodeURIComponent(messageId)}`;
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RouteDef {
  readonly method: HttpMethod;
  /** Path template relative to {@link API_PREFIX}, with `:name` parameter segments. */
  readonly path: string;
}

/**
 * Every JSON route, keyed by the name both sides use to refer to it. The key is the contract: a
 * handler switches on it and the client builds URLs from it, so neither has a literal path.
 */
export const API_ROUTES = {
  me: { method: "GET", path: "/me" },
  updateMe: { method: "PATCH", path: "/me" },
  setAvatar: { method: "PUT", path: "/me/avatar" },

  listChannels: { method: "GET", path: "/channels" },
  createChannel: { method: "POST", path: "/channels" },
  updateChannel: { method: "PATCH", path: "/channels/:channelId" },
  joinChannel: { method: "POST", path: "/channels/:channelId/join" },
  leaveChannel: { method: "POST", path: "/channels/:channelId/leave" },
  archiveChannel: { method: "POST", path: "/channels/:channelId/archive" },
  readChannel: { method: "POST", path: "/channels/:channelId/read" },
  updateMembership: { method: "PATCH", path: "/channels/:channelId/membership" },

  listMessages: { method: "GET", path: "/channels/:channelId/messages" },
  sendMessage: { method: "POST", path: "/channels/:channelId/messages" },
  editMessage: { method: "PATCH", path: "/messages/:messageId" },
  deleteMessage: { method: "DELETE", path: "/messages/:messageId" },
  addReaction: { method: "PUT", path: "/messages/:messageId/reactions/:emoji" },
  removeReaction: { method: "DELETE", path: "/messages/:messageId/reactions/:emoji" },

  listThreads: { method: "GET", path: "/threads" },
  followThread: { method: "POST", path: "/threads/:rootId/follow" },
  unfollowThread: { method: "DELETE", path: "/threads/:rootId/follow" },

  search: { method: "GET", path: "/search" },

  createUpload: { method: "POST", path: "/uploads" },

  listUsers: { method: "GET", path: "/users" },
  getUser: { method: "GET", path: "/users/:userId" },

  subscribePush: { method: "POST", path: "/push/subscribe" },
  unsubscribePush: { method: "DELETE", path: "/push/subscribe" },
} as const satisfies Record<string, RouteDef>;

export type ApiRouteName = keyof typeof API_ROUTES;

export type PathParams = Readonly<Record<string, string>>;

/**
 * Matches one `:name`-templated path against a concrete pathname.
 *
 * Deliberately not a regex builder: segment equality plus capture is the whole grammar, there are
 * no optional or wildcard segments, and an emoji reaction id must survive as an opaque segment.
 * Returns the decoded parameters, or null when the shape does not match.
 */
export function matchPath(template: string, pathname: string): PathParams | null {
  const want = splitSegments(template);
  const got = splitSegments(pathname);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = got[i]!;
    if (w.startsWith(":")) {
      if (g.length === 0) return null;
      params[w.slice(1)] = safeDecode(g);
      continue;
    }
    if (w !== g) return null;
  }
  return params;
}

/** Fills a template's `:name` segments. Throws on a missing parameter: that is a caller bug. */
export function buildPath(template: string, params: PathParams = {}): string {
  return (
    "/" +
    splitSegments(template)
      .map((segment) => {
        if (!segment.startsWith(":")) return segment;
        const name = segment.slice(1);
        const value = params[name];
        if (value === undefined || value === "") {
          throw new Error(`Missing path parameter ${name} for ${template}`);
        }
        return encodeURIComponent(value);
      })
      .join("/")
  );
}

/** Absolute URL path for a named API route. */
export function apiPath(name: ApiRouteName, params: PathParams = {}): string {
  return API_PREFIX + buildPath(API_ROUTES[name].path, params);
}

/** Absolute URL path for a stored file, optionally its server-generated thumbnail. */
export function filePath(attachmentId: string, thumb = false): string {
  return `${FILES_PREFIX}/${encodeURIComponent(attachmentId)}${thumb ? "/thumb" : ""}`;
}

export interface ApiMatch {
  readonly name: ApiRouteName;
  readonly params: PathParams;
}

/**
 * Resolves a request to a named API route.
 *
 * `methodMismatch` is reported separately from "no such route" so the handler can answer 405 with an
 * `Allow` header instead of a misleading 404.
 */
export function matchApiRoute(
  method: string,
  pathname: string,
): ApiMatch | { readonly methodMismatch: readonly HttpMethod[] } | null {
  if (!pathname.startsWith(API_PREFIX)) return null;
  const rest = pathname.slice(API_PREFIX.length) || "/";
  const allowed: HttpMethod[] = [];
  for (const [name, route] of Object.entries(API_ROUTES) as [ApiRouteName, RouteDef][]) {
    const params = matchPath(route.path, rest);
    if (params === null) continue;
    if (route.method === method) return { name, params };
    allowed.push(route.method);
  }
  if (allowed.length > 0) return { methodMismatch: allowed };
  return null;
}

/** True for any path this Worker must authenticate and handle itself rather than serve as an asset. */
export function isWorkerPath(pathname: string): boolean {
  return (
    pathname === WS_PATH ||
    pathname === API_PREFIX ||
    pathname.startsWith(`${API_PREFIX}/`) ||
    pathname === FILES_PREFIX ||
    pathname.startsWith(`${FILES_PREFIX}/`)
  );
}

function splitSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A lone `%` is not a decoding failure worth a 400 at the routing layer; the validator that
    // consumes the parameter rejects it.
    return segment;
  }
}
