// The Records service on Node (canonical plan §2, §11.8): the same fetch-style adapters the Worker
// runs (gatekeeper-records http/api.ts, jira/handler.ts, http/openapi.ts) behind node:http, over
// any Postgres, with no Cloudflare bindings.
//
// What differs from the Worker (src/index.ts in gatekeeper-records), and why:
//   * Database: one shared postgres.js pool for the process (Workers must open a client per
//     request; Node may share sockets).
//   * Access: the Worker always verifies a Cloudflare Access assertion. Here the caller chooses:
//     `access: { issuer, audience }` verifies it exactly as the Worker does (same function, jose +
//     the team JWKS); `verifyAccess` plugs in another front-door check; `access: "none"` turns the
//     first factor off explicitly (the Records credential is still required). There is no default.
//   * Rate limit: an in-process fixed window per credential instead of the Workers rate limiter.
//   * Pokes: Server-Sent Events from an in-process hub (./pokes.ts), optionally shared between
//     instances through Postgres LISTEN/NOTIFY, instead of the WebSocket Durable Object. Clients ask
//     with `GET …/poke` and `Accept: text/event-stream`; api.ts authorises the subscription exactly
//     as it does the WebSocket upgrade (see `sseAsUpgrade`).
//   * The outbox publisher and the Queue consumer (webhook fan-out) do not run here: change events
//     accumulate in the outbox until a Worker (or a future Node publisher) drains them. Realtime
//     does not depend on them: pokes and pulls by `seq` do.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

import { connect, RecordsService, type Db } from "@records/core";
import { verifyAccessAssertion } from "gatekeeper-records/http/access";
import { API_PREFIX, handleApi, type ApiDeps } from "gatekeeper-records/http/api";
import { OPENAPI_PATH, openApiDocument } from "gatekeeper-records/http/openapi";
import { handleJiraApi, JIRA_PATH } from "gatekeeper-records/jira/handler";

import { SsePokeHub, type PokeHubOptions } from "./pokes.js";
import { fixedWindowLimiter } from "./rate-limit.js";

export type RecordsServerOptions = {
  /** Postgres URL for the runtime login (a member of `records_app`). Or pass `db`. */
  databaseUrl?: string;
  /** An existing postgres.js client (not closed by `close()`). */
  db?: Db;
  /** Pool size when `databaseUrl` is given (default 10). */
  poolSize?: number;
  /**
   * The service's public origin, e.g. `https://records.example.com`. Request URLs are built on it
   * (instead of the Host header) and it is the OpenAPI document's server.
   */
  publicBaseUrl?: string;
  /** The first factor: verify an Access assertion, or explicitly none. Required unless `verifyAccess`. */
  access?: { issuer: string; audience: string } | "none";
  /** A custom first-factor check; overrides `access`. */
  verifyAccess?(request: Request): Promise<boolean>;
  /**
   * Resolves credentials and trusted JWTs (delegated tokens, Access for SaaS) for the native API.
   * Default: api.ts's own, over the same service (rk1 credentials and configured trusted issuers).
   */
  authenticator?: ApiDeps["authenticator"];
  /** Requests per credential per window (default 600 per minute); false disables. */
  rateLimit?: { limit: number; windowMs: number } | false;
  /** Per-request deadline (default 15 s, as on Workers). */
  deadlineMs?: number;
  /** Poke hub settings; `pubsub: "postgres"` shares pokes between instances (default "memory"). */
  pokes?: PokeHubOptions & { pubsub?: "memory" | "postgres" };
};

export type RecordsServer = {
  /** The fetch-style handler (usable without the node:http server, e.g. in tests or other hosts). */
  handle(request: Request): Promise<Response>;
  /** The node:http server (not listening until `listen`). */
  server: Server;
  /** Start listening; resolves to the base URL (`http://host:port`). Port 0 picks a free port. */
  listen(port?: number, host?: string): Promise<string>;
  /** Stop accepting requests, end poke streams and close the pool (if this server opened it). */
  close(): Promise<void>;
  service: RecordsService;
  pokes: SsePokeHub;
};

// As index.ts (same-origin, not no-referrer: see connect-guard.ts).
const SECURITY_HEADERS: Record<string, string> = { "x-content-type-options": "nosniff", "referrer-policy": "same-origin" };
const POKE_PATH = new RegExp(`^${API_PREFIX}/datastores/[0-9a-f-]{36}/poke$`);

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function accessCheck(opts: RecordsServerOptions): (request: Request) => Promise<boolean> {
  if (opts.verifyAccess) return opts.verifyAccess;
  const access = opts.access;
  if (access === "none") return async () => true;
  if (access && access.issuer && access.audience) {
    return async (request) => (await verifyAccessAssertion(request, { issuer: access.issuer, audience: access.audience })) !== null;
  }
  throw new Error('createRecordsServer: set access ({ issuer, audience }, or "none" to rely on the Records credential alone) or verifyAccess.');
}

export async function createRecordsServer(opts: RecordsServerOptions): Promise<RecordsServer> {
  if (!opts.db && !opts.databaseUrl) throw new Error("createRecordsServer: databaseUrl or db is required.");
  const verifyAccess = accessCheck(opts);
  const ownDb = !opts.db;
  const db = opts.db ?? connect(opts.databaseUrl!, { max: opts.poolSize ?? 10 });
  const service = new RecordsService(db);
  const pokes = new SsePokeHub(opts.pokes);
  if (opts.pokes?.pubsub === "postgres") await pokes.usePostgres(db);
  const limiter = opts.rateLimit === false ? undefined : fixedWindowLimiter(opts.rateLimit ?? { limit: 600, windowMs: 60_000 });
  const rateLimit = limiter ? async (key: string) => limiter(key) : undefined;
  const publicOrigin = opts.publicBaseUrl ? new URL(opts.publicBaseUrl).origin : undefined;
  const deadlineMs = opts.deadlineMs;

  // Requests this adapter marked as SSE subscriptions (see sseAsUpgrade below).
  const sseRequests = new WeakSet<Request>();

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === OPENAPI_PATH) {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET" } });
      return new Response(JSON.stringify(openApiDocument(publicOrigin ?? url.origin)), {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" },
      });
    }
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return new Response("Not found", { status: 404 });
    if (JIRA_PATH.test(url.pathname)) {
      return handleJiraApi(request, { service, verifyAccess, ...(rateLimit ? { rateLimit } : {}), ...(deadlineMs ? { deadlineMs } : {}) });
    }
    // api.ts authorises a poke subscription only on a WebSocket upgrade. An SSE request is passed to
    // it marked as one, so the credential, datastore and issues.read checks are exactly the
    // Worker's; `subscribePokes` then answers the marked request with an event stream.
    let forwarded = request;
    if (request.method === "GET" && POKE_PATH.test(url.pathname) && /\btext\/event-stream\b/i.test(request.headers.get("accept") ?? "")
        && !request.headers.get("upgrade")) {
      const headers = new Headers(request.headers);
      headers.set("upgrade", "websocket");
      forwarded = new Request(request.url, { method: "GET", headers, signal: request.signal });
      sseRequests.add(forwarded);
    }
    return handleApi(forwarded, {
      service,
      verifyAccess,
      ...(opts.authenticator ? { authenticator: opts.authenticator } : {}),
      ...(rateLimit ? { rateLimit } : {}),
      ...(deadlineMs ? { deadlineMs } : {}),
      onCommit: (datastoreId, head) => pokes.poke(datastoreId, head),
      subscribePokes: async (datastoreId, upgrade) => {
        if (sseRequests.has(upgrade)) return pokes.subscribe(datastoreId);
        return new Response(JSON.stringify({
          type: "https://records.invalid/problems/validation_failed", title: "validation failed", status: 400, code: "validation_failed",
          detail: "This server streams pokes as Server-Sent Events: send Accept: text/event-stream without an Upgrade header.",
        }), { status: 400, headers: { "content-type": "application/problem+json", "cache-control": "no-store" } });
      },
    });
  }

  const handle = async (request: Request) => withSecurityHeaders(await route(request));

  const server = createServer((req, res) => {
    void serveNode(req, res, handle, publicOrigin);
  });
  // Poke streams are long-lived; the per-request deadline bounds everything else.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  return {
    handle,
    server,
    service,
    pokes,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address() as AddressInfo;
          const shownHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
          resolve(`http://${shownHost}:${address.port}`);
        });
      });
    },
    async close() {
      await pokes.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      if (ownDb) await db.end({ timeout: 5 });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// node:http ⇄ Fetch

/** Build a Fetch Request from a node:http request. The body streams; the adapters bound its size. */
export function toFetchRequest(req: IncomingMessage, publicOrigin?: string): { request: Request; abort: AbortController } {
  const origin = publicOrigin ?? `http://${req.headers.host ?? "localhost"}`;
  const url = new URL(req.url ?? "/", origin);
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  const abort = new AbortController();
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method, headers, signal: abort.signal };
  if (hasBody) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return { request: new Request(url, init), abort };
}

/** Write a Fetch Response to a node:http response, streaming the body (poke streams stay open). */
export async function sendFetchResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, response.statusText || undefined, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  let closed = false;
  res.on("close", () => {
    closed = true;
    reader.cancel().catch(() => {});
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      if (!res.write(value)) await new Promise<void>((resolve) => { res.once("drain", resolve); res.once("close", resolve); });
    }
  } catch {
    // the client went away, or the body errored: nothing more to send
  }
  if (!closed) res.end();
}

async function serveNode(req: IncomingMessage, res: ServerResponse, handle: (request: Request) => Promise<Response>, publicOrigin?: string): Promise<void> {
  let abort: AbortController | undefined;
  try {
    const converted = toFetchRequest(req, publicOrigin);
    abort = converted.abort;
    res.on("close", () => abort?.abort());
    await sendFetchResponse(res, await handle(converted.request));
  } catch (err) {
    console.error(JSON.stringify({ event: "records.node.unhandled", error: err instanceof Error ? err.message : String(err) }));
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/problem+json", "cache-control": "no-store" });
      res.end(JSON.stringify({ type: "https://records.invalid/problems/internal", title: "internal", status: 500, code: "internal", detail: "Something went wrong." }));
    } else res.destroy();
  }
}
