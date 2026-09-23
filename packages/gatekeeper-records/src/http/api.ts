// Versioned machine API: /gatekeeper/records/v1/datastores/:datastoreId/...
//
// Two independent checks on every request (plan §7):
//   1. A Cloudflare Access assertion for the API's own path-specific application/audience
//      (typically an Access service token), verified here, not merely trusted from the edge.
//   2. A Records credential (`Authorization: Bearer rk1_...`), which resolves to a delegated
//      service principal with fixed scopes on one datastore.
// The datastore ID in the path is only a selector: it must equal the credential's datastore.
//
// The adapter calls the same domain operations as the Gatekeeper session, so authorization,
// workflow rules and audit are identical. HTTP-specific mapping:
//   If-Match: "r<revision>"  → expectedRevision (428 when missing on a change to an existing record)
//   Idempotency-Key header   → the mutation's idempotency key (required on every mutation)
//   ETag                      → the record's revision

import {
  LIMITS,
  RecordsError,
  type CallerContext,
  type Problem,
} from "@records/contracts";

import type { RecordsService } from "../domain/service.js";

export const API_PREFIX = "/gatekeeper/records/v1";

export type ApiDeps = {
  service: RecordsService;
  /** Verify the Access assertion for the API audience. Returns false when absent or invalid. */
  verifyAccess(request: Request): Promise<boolean>;
  /** Optional per-credential rate limit. Returns false when the caller should back off. */
  rateLimit?(key: string): Promise<boolean>;
  /** Deadline for one request, in milliseconds. */
  deadlineMs?: number;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function problem(err: RecordsError, extraHeaders: Record<string, string> = {}): Response {
  const body: Problem = err.toProblem();
  const headers: Record<string, string> = { "content-type": "application/problem+json", "cache-control": "no-store", ...extraHeaders };
  if (err.currentRevision !== undefined) headers.etag = `"r${err.currentRevision}"`;
  return new Response(JSON.stringify(body), { status: err.status, headers });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = JSON.stringify(body);
  if (text.length > LIMITS.httpResponseMaxBytes) {
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
  handle(ctx: { caller: CallerContext; datastoreId: string; params: string[]; request: Request; url: URL; service: RecordsService }): Promise<Response>;
};

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
    async handle({ caller, datastoreId, service, request }) {
      const key = idempotencyKey(request);
      const { record, replayed } = await service.projects.createIssue(caller, datastoreId, await readJson(request), key);
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
    async handle({ caller, datastoreId, service, request, params }) {
      const key = idempotencyKey(request);
      const revision = expectedRevision(request);
      const patch = await readJson(request);
      const { record, replayed } = await service.projects.editIssue(caller, datastoreId, { issueId: params[0], expectedRevision: revision, patch }, key);
      return json(record, 200, { ...etag(record.revision), ...(replayed ? { "idempotent-replayed": "true" } : {}) });
    },
  },
  {
    method: "POST", pattern: new RegExp(`^/issues/${ID}/transitions$`),
    async handle({ caller, datastoreId, service, request, params }) {
      const key = idempotencyKey(request);
      const revision = expectedRevision(request);
      const body = (await readJson(request)) as { toState?: unknown } | null;
      const { record, replayed } = await service.projects.transitionIssue(
        caller, datastoreId, { issueId: params[0], expectedRevision: revision, toState: body?.toState }, key);
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
    async handle({ caller, datastoreId, service, request, params }) {
      const key = idempotencyKey(request);
      const body = (await readJson(request)) as { body?: unknown } | null;
      const { record, replayed } = await service.projects.addComment(caller, datastoreId, { issueId: params[0], body: body?.body }, key);
      return json(record, replayed ? 200 : 201, replayed ? { "idempotent-replayed": "true" } : {});
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
  const match = DATASTORE_PATH.exec(url.pathname);
  if (!match) return problem(new RecordsError("not_found", "No such API route."));

  if (!(await deps.verifyAccess(request))) {
    return problem(new RecordsError("unauthenticated", "A valid Access service token is required."));
  }
  const auth = request.headers.get("authorization") ?? "";
  const token = /^Bearer (\S+)$/.exec(auth)?.[1];
  const resolved = token ? await deps.service.registry.authenticateCredential(token) : null;
  if (!resolved) {
    return problem(new RecordsError("unauthenticated", "A valid Records credential is required."), { "www-authenticate": 'Bearer realm="records"' });
  }
  if (resolved.datastoreId !== match[1]) return problem(new RecordsError("not_found", "Unknown datastore."));
  if (deps.rateLimit && !(await deps.rateLimit(resolved.caller.bindingId ?? resolved.caller.principalId))) {
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
