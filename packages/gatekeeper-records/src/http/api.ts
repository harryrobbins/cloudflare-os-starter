// Versioned machine API: /gatekeeper/records/v1/datastores/:datastoreId/...
//
// Authentication (src/identity/authenticator.ts, canonical plan §5):
//   - A Records credential (`Authorization: Bearer rk1_...`) needs two independent checks, as
//     before: a Cloudflare Access assertion for the API's own path-specific application/audience
//     (typically an Access service token), verified here, and the credential itself, which resolves
//     to a service principal with fixed scopes on one datastore.
//   - `Authorization: Bearer <JWT>` from a trusted issuer (records.trusted_issuers): a delegated
//     token (scoped to one binding and datastore) or an Access for SaaS token (a mapped person).
//     The token is the proof; the path Access application is not required for it.
// The datastore ID in the path is only a selector: it must equal the credential's datastore.
//
// The adapter calls the same domain operations as the Gatekeeper session, so authorization,
// workflow rules and audit are identical. HTTP-specific mapping:
//   If-Match: "r<revision>"  → expectedRevision (428 when missing on a change to an existing record)
//   Idempotency-Key header   → the mutation's idempotency key (required on every mutation)
//   ETag                      → the record's revision
//
// Sync and change routes (canonical plan §6-7):
//   POST …/sync/push, POST …/sync/pull   the sync protocol (@records/contracts sync.ts); the body is
//                                        the request as is; pull responses may be up to
//                                        SYNC_LIMITS.pullMaxBytes (the other routes: 1 MiB)
//   GET  …/changes?after=&limit=         the commit-ordered journal (ChangesPage)
//   GET  …/issues/:id/history            one issue's journal entries
//   GET  …/poke                          WebSocket upgrade: `Poke` messages ({datastoreId, head})
//                                        after each committed write. Authorised (issues.read) on
//                                        connect; the hub closes every socket after a maximum
//                                        lifetime, so a revoked credential stops receiving pokes.
// Native writes journal with via 'http'; sync push journals with via 'sync'. After a commit the
// adapter reports the new head through `onCommit`, which the Worker turns into a poke.

import {
  LIMITS,
  RecordsError,
  type CallerContext,
  type Problem,
} from "@records/contracts";

import { SYNC_LIMITS, type RecordsService } from "@records/core";

import { ServiceAuthenticator } from "../identity/authenticator.js";
import { OPENAPI_PATH, openApiDocument } from "./openapi.js";

export const API_PREFIX = "/gatekeeper/records/v1";

export type ApiDeps = {
  service: RecordsService;
  /** Verify the Access assertion for the API audience. Returns false when absent or invalid. */
  verifyAccess(request: Request): Promise<boolean>;
  /** Resolves credentials and trusted JWTs. Default: one over `service` without delegation keys. */
  authenticator?: ServiceAuthenticator;
  /** Optional per-credential rate limit. Returns false when the caller should back off. */
  rateLimit?(key: string): Promise<boolean>;
  /** Deadline for one request, in milliseconds. */
  deadlineMs?: number;
  /** Called after a write committed, with the datastore's clock at or after it (best effort). */
  onCommit?(datastoreId: string, head: number): void;
  /** Hand an authorised WebSocket upgrade to the datastore's poke hub. Absent: no poke route. */
  subscribePokes?(datastoreId: string, request: Request): Promise<Response>;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function problem(err: RecordsError, extraHeaders: Record<string, string> = {}): Response {
  const body: Problem = err.toProblem();
  const headers: Record<string, string> = { "content-type": "application/problem+json", "cache-control": "no-store", ...extraHeaders };
  if (err.currentRevision !== undefined) headers.etag = `"r${err.currentRevision}"`;
  return new Response(JSON.stringify(body), { status: err.status, headers });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}, maxBytes: number = LIMITS.httpResponseMaxBytes): Response {
  const text = JSON.stringify(body);
  if (text.length > maxBytes) {
    return problem(new RecordsError("payload_too_large", "The response is too large; narrow the query or page it."));
  }
  return new Response(text, { status, headers: { ...JSON_HEADERS, ...headers } });
}

async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw new RecordsError("validation_failed", "Send a JSON body with Content-Type: application/json.");
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > LIMITS.httpBodyMaxBytes) throw new RecordsError("payload_too_large", "The request body is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new RecordsError("validation_failed", "A JSON body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LIMITS.httpBodyMaxBytes) {
      await reader.cancel();
      throw new RecordsError("payload_too_large", "The request body is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RecordsError("validation_failed", "The body is not valid JSON.");
  }
}

function idempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key");
  if (!key) throw new RecordsError("validation_failed", "Mutations need an Idempotency-Key header.");
  return key;
}

function expectedRevision(request: Request): number {
  const header = request.headers.get("if-match");
  if (!header) throw new RecordsError("revision_required", "Send If-Match with the ETag you last read.");
  const match = /^"r(\d{1,9})"$/.exec(header.trim());
  if (!match) throw new RecordsError("validation_failed", "If-Match must be an ETag from this API.");
  return Number(match[1]);
}

const etag = (revision: number) => ({ etag: `"r${revision}"` });

function searchInput(url: URL): Record<string, unknown> {
  const p = url.searchParams;
  const limit = p.get("limit");
  return {
    ...(p.get("projectId") ? { projectId: p.get("projectId") } : {}),
    ...(p.get("state") ? { state: p.get("state") } : {}),
    ...(p.get("assigneeId") ? { assigneeId: p.get("assigneeId") } : {}),
    ...(p.get("q") ? { query: p.get("q") } : {}),
    ...(p.get("order") ? { order: p.get("order") } : {}),
    ...(p.get("cursor") ? { cursor: p.get("cursor") } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  };
}

type Route = {
  method: string;
  pattern: RegExp;
  handle(ctx: { caller: CallerContext; datastoreId: string; params: string[]; request: Request; url: URL; service: RecordsService; deps: ApiDeps }): Promise<Response>;
};

function committed(deps: ApiDeps, datastoreId: string, result: { replayed: boolean; seq?: number }): void {
  if (!result.replayed && result.seq) deps.onCommit?.(datastoreId, result.seq);
}

const ID = "([0-9a-f-]{36})";

const routes: Route[] = [
  {
    method: "GET", pattern: /^$/,
    async handle({ caller, datastoreId, service }) {
      return json(await service.registry.getDatastore(caller, datastoreId));
    },
  },
  {
    method: "GET", pattern: /^\/projects$/,
    async handle({ caller, datastoreId, service }) {
      return json({ items: await service.projects.listProjects(caller, datastoreId) });
    },
  },
  {
    method: "GET", pattern: /^\/workflow$/,
    async handle({ caller, datastoreId, service }) {
      return json(await service.projects.getWorkflow(caller, datastoreId));
    },
  },
  {
    method: "GET", pattern: /^\/issues$/,
    async handle({ caller, datastoreId, service, url }) {
      return json(await service.projects.listIssues(caller, datastoreId, searchInput(url)));
    },
  },
  {
    method: "POST", pattern: /^\/issues$/,
    async handle({ caller, datastoreId, service, request, deps }) {
      const key = idempotencyKey(request);
      const result = await service.projects.createIssue(caller, datastoreId, await readJson(request), key);
      committed(deps, datastoreId, result);
      const { record, replayed } = result;
      return json(record, replayed ? 200 : 201, { ...etag(record.revision), ...(replayed ? { "idempotent-replayed": "true" } : {}) });
    },
  },
  {
    method: "GET", pattern: new RegExp(`^/issues/${ID}$`),
    async handle({ caller, datastoreId, service, params }) {
      const issue = await service.projects.getIssue(caller, datastoreId, params[0]!);
      return json(issue, 200, etag(issue.revision));
    },
  },
  {
    method: "PATCH", pattern: new RegExp(`^/issues/${ID}$`),
    async handle({ caller, datastoreId, service, request, params, deps }) {
      const key = idempotencyKey(request);
      const revision = expectedRevision(request);
      const patch = await readJson(request);
      const result = await service.projects.editIssue(caller, datastoreId, { issueId: params[0], expectedRevision: revision, patch }, key);
      committed(deps, datastoreId, result);
      const { record, replayed } = result;
      return json(record, 200, { ...etag(record.revision), ...(replayed ? { "idempotent-replayed": "true" } : {}) });
    },
  },
  {
    method: "POST", pattern: new RegExp(`^/issues/${ID}/transitions$`),
    async handle({ caller, datastoreId, service, request, params, deps }) {
      const key = idempotencyKey(request);
      const revision = expectedRevision(request);
      const body = (await readJson(request)) as { toState?: unknown } | null;
      const result = await service.projects.transitionIssue(
        caller, datastoreId, { issueId: params[0], expectedRevision: revision, toState: body?.toState }, key);
      committed(deps, datastoreId, result);
      const { record, replayed } = result;
      return json(record, 200, { ...etag(record.revision), ...(replayed ? { "idempotent-replayed": "true" } : {}) });
    },
  },
  {
    method: "GET", pattern: new RegExp(`^/issues/${ID}/comments$`),
    async handle({ caller, datastoreId, service, params, url }) {
      const limit = url.searchParams.get("limit");
      return json(await service.projects.listComments(caller, datastoreId, {
        issueId: params[0], ...(limit ? { limit: Number(limit) } : {}),
        ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
      }));
    },
  },
  {
    method: "POST", pattern: new RegExp(`^/issues/${ID}/comments$`),
    async handle({ caller, datastoreId, service, request, params, deps }) {
      const key = idempotencyKey(request);
      const body = (await readJson(request)) as { body?: unknown } | null;
      const result = await service.projects.addComment(caller, datastoreId, { issueId: params[0], body: body?.body }, key);
      committed(deps, datastoreId, result);
      const { record, replayed } = result;
      return json(record, replayed ? 200 : 201, replayed ? { "idempotent-replayed": "true" } : {});
    },
  },
  {
    method: "GET", pattern: new RegExp(`^/issues/${ID}/history$`),
    async handle({ caller, datastoreId, service, params }) {
      return json({ items: await service.journal.history(caller, datastoreId, "issue", params[0]!) });
    },
  },
  {
    method: "GET", pattern: /^\/changes$/,
    async handle({ caller, datastoreId, service, url }) {
      const p = url.searchParams;
      return json(await service.journal.changes(caller, datastoreId, {
        ...(p.has("after") ? { after: p.get("after") } : {}),
        ...(p.has("limit") ? { limit: p.get("limit") } : {}),
      }));
    },
  },
  {
    method: "POST", pattern: /^\/sync\/push$/,
    async handle({ caller, datastoreId, service, request, deps }) {
      const response = await service.sync.push(caller, datastoreId, await readJson(request));
      if (response.outcomes.some((o) => o.status === "applied")) deps.onCommit?.(datastoreId, response.head);
      return json(response);
    },
  },
  {
    method: "POST", pattern: /^\/sync\/pull$/,
    async handle({ caller, datastoreId, service, request }) {
      return json(await service.sync.pull(caller, datastoreId, await readJson(request)), 200, {}, SYNC_LIMITS.pullMaxBytes);
    },
  },
  {
    method: "GET", pattern: /^\/poke$/,
    async handle({ caller, datastoreId, service, request, deps }) {
      if (!deps.subscribePokes) throw new RecordsError("not_found", "No such API route.");
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        throw new RecordsError("validation_failed", "Connect with a WebSocket upgrade (Upgrade: websocket).");
      }
      // Authorised now, on connect; the hub bounds how long the socket then lives.
      await service.registry.checkAccess(caller, datastoreId, "listIssues");
      return deps.subscribePokes(datastoreId, request);
    },
  },
  {
    method: "GET", pattern: /^\/audit$/,
    async handle({ caller, datastoreId, service, url }) {
      const limit = url.searchParams.get("limit");
      return json(await service.registry.listAudit(caller, datastoreId, {
        ...(limit ? { limit: Number(limit) } : {}),
        ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
      }));
    },
  },
];

const DATASTORE_PATH = new RegExp(`^${API_PREFIX}/datastores/${ID}(/.*)?$`);

async function route(request: Request, deps: ApiDeps): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === OPENAPI_PATH && request.method === "GET") return json(openApiDocument(url.origin));
  const match = DATASTORE_PATH.exec(url.pathname);
  if (!match) return problem(new RecordsError("not_found", "No such API route."));

  const authenticator = deps.authenticator ?? new ServiceAuthenticator({ service: deps.service });
  const resolved = await authenticator.authenticate(request.headers, {
    datastoreId: match[1]!,
    verifyAccess: () => deps.verifyAccess(request),
    allowJwt: true,
  });
  if (!resolved.ok) {
    return problem(resolved.error, resolved.stage === "credential" && resolved.error.code === "unauthenticated" ? { "www-authenticate": 'Bearer realm="records"' } : {});
  }
  if (deps.rateLimit && !(await deps.rateLimit(resolved.rateKey))) {
    return problem(new RecordsError("rate_limited", "Too many requests; slow down."), { "retry-after": "10" });
  }

  const rest = match[2] ?? "";
  const candidates = routes.filter((r) => r.pattern.test(rest));
  if (candidates.length === 0) return problem(new RecordsError("not_found", "No such API route."));
  const r = candidates.find((c) => c.method === request.method);
  if (!r) {
    return new Response(null, { status: 405, headers: { allow: candidates.map((c) => c.method).join(", ") } });
  }
  return r.handle({
    caller: resolved.caller,
    datastoreId: resolved.datastoreId,
    params: r.pattern.exec(rest)!.slice(1),
    request,
    url,
    service: deps.service,
    deps,
  });
}

export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RecordsError("unavailable", "The request exceeded its deadline.")), deps.deadlineMs ?? 15_000);
    });
    return await Promise.race([route(request, deps), deadline]);
  } catch (err) {
    if (err instanceof RecordsError) return problem(err);
    // Unexpected failures: no internals in the response.
    console.error(JSON.stringify({ event: "records.http.unhandled", error: err instanceof Error ? err.message : String(err) }));
    return problem(new RecordsError("internal", "Something went wrong."));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
