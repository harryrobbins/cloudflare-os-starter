// The Jira-compatible HTTP surface (canonical plan §7): `…/jira/rest/api/{2,3}/…`.
//
// `handleJira` is a pure fetch-style handler. The integrator authenticates the request, builds a
// JiraPort bound to the caller and datastore, and passes the path prefix the client uses as its
// Jira base URL. The router never sees credentials.
//
// Decisions recorded here for the integrator:
//
// * Idempotency. Jira clients send no idempotency key. When a request carries `Idempotency-Key`
//   it is used as-is. Otherwise the router derives one: SHA-256 over the caller's accountId, the
//   method, the path (API version included), the canonical JSON body and a time bucket
//   (`derivedKeyWindowMs`, default 60 s). A client retrying the same request inside the window
//   replays the first outcome instead of writing twice; the same request sent deliberately after
//   the window is a new write, as it is on Jira. The bucket is the price of determinism without
//   client help: a retry that straddles a bucket boundary is not deduplicated.
//   `idempotencyKeyDerived: true` tells the service it may retain derived keys briefly.
// * Edits and transitions have no If-Match on Jira: the port gets `expectedRevision: undefined`
//   ("last write wins"); the journal still records before/after values.
// * A write that needs approval (`pending`) is answered 409 with an explanation and the action
//   id in `X-Records-Action-Id`, never 2xx: a Jira client must not report it as saved.
// * `nextPageToken` wraps the port's own token with a hash of the JQL, so a token is refused on
//   a different query.

import { ERROR_STATUS, IdempotencyKeySchema, LIMITS, RecordsError, type ErrorCode, type IssueQuery, type MutationOutcome } from "@records/contracts";

import { JIRA_MESSAGES, JiraError, jiraErrorFromRecords } from "./errors.js";
import { parseJql } from "./jql/parser.js";
import { resolverFromLookups } from "./jql/resolver.js";
import { parseCommentBody, parseCreateIssue, parseEditIssue, parseTransition, type InboundContext } from "./map/inbound.js";
import {
  api,
  commentToJira,
  commentsPageToJira,
  fieldSelector,
  fieldsToJira,
  issueToJira,
  issueTypeToJira,
  memberToJira,
  priorityJson,
  projectToJira,
  statusCategoryJson,
  statusToJira,
  transitionsToJira,
  type ApiVersion,
  type MapContext,
} from "./map/outbound.js";
import type { JiraCustomFieldDef, JiraIssue, JiraPort, JiraProject, JiraUser, JiraWorkflow, JiraWriteOptions } from "./port.js";
import { JIRA_PRIORITIES, JIRA_STATUS_CATEGORIES } from "./values.js";

export type JiraRouterOptions = {
  now?: () => Date;
  /** Shown by /serverInfo. */
  serverTitle?: string;
  /** Time bucket for derived idempotency keys. Default 60 000 ms. */
  derivedKeyWindowMs?: number;
  /** For JQL startOfWeek()/endOfWeek(). Default 1 (Monday). */
  weekStartsOn?: 0 | 1;
};

const JSON_HEADERS = { "content-type": "application/json;charset=UTF-8", "cache-control": "no-store" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = JSON.stringify(body);
  if (text.length > LIMITS.httpResponseMaxBytes) {
    return errorResponse(new JiraError(413, ["The response is too large; request fewer fields or a smaller page."]));
  }
  return new Response(text, { status, headers: { ...JSON_HEADERS, ...headers } });
}

function errorResponse(err: JiraError): Response {
  return new Response(JSON.stringify(err.body), { status: err.status, headers: { ...JSON_HEADERS, ...err.headers } });
}

const noContent = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

// ---------------------------------------------------------------------------------------------
// Request helpers

async function readJson(request: Request): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (type && !/^application\/([\w.+-]*\+)?json\b/i.test(type)) throw new JiraError(415, ["Unsupported Media Type: send application/json."]);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > LIMITS.httpBodyMaxBytes) throw new JiraError(413, ["The request body is too large."]);
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LIMITS.httpBodyMaxBytes) {
      await reader.cancel();
      throw new JiraError(413, ["The request body is too large."]);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw JiraError.badRequest("Unexpected character in the request body: it is not valid JSON.");
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The idempotency key for a Jira write that arrived without one. Deterministic for the same
 * caller, method, path, body and time bucket.
 */
export async function deriveIdempotencyKey(input: {
  accountId: string;
  method: string;
  path: string;
  body: unknown;
  now: Date;
  windowMs: number;
}): Promise<string> {
  const bucket = Math.floor(input.now.getTime() / input.windowMs);
  const digest = await sha256Hex(canonicalJson([input.accountId, input.method.toUpperCase(), input.path, input.body ?? null, bucket]));
  return `jira-${digest.slice(0, 48)}`;
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw JiraError.badRequest(`The value '${raw}' is not valid for the parameter '${name}'.`);
  return Math.min(max, Math.max(min, n));
}

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

async function wrapPageToken(jql: string, portToken: string): Promise<string> {
  return b64url(JSON.stringify({ v: 1, q: (await sha256Hex(jql)).slice(0, 16), t: portToken }));
}

async function unwrapPageToken(jql: string, token: string): Promise<string> {
  try {
    const parsed = JSON.parse(unb64url(token)) as { v?: unknown; q?: unknown; t?: unknown };
    if (parsed.v === 1 && typeof parsed.t === "string" && parsed.q === (await sha256Hex(jql)).slice(0, 16)) return parsed.t;
  } catch {
    // fall through
  }
  throw JiraError.badRequest(JIRA_MESSAGES.invalidPageToken);
}

// ---------------------------------------------------------------------------------------------
// Per-request context

class RequestContext {
  private cache = new Map<string, Promise<unknown>>();

  constructor(
    readonly request: Request,
    readonly url: URL,
    readonly version: ApiVersion,
    readonly baseUrl: string,
    /** Path after the base, e.g. `/rest/api/3/issue`. */
    readonly path: string,
    readonly port: JiraPort,
    readonly options: JiraRouterOptions,
  ) {}

  private memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load();
      this.cache.set(key, p);
    }
    return p;
  }

  now = () => this.options.now?.() ?? new Date();
  myself = () => this.memo<JiraUser>("myself", () => this.port.myself());
  members = () => this.memo<JiraUser[]>("members", () => this.port.members());
  projects = () => this.memo<JiraProject[]>("projects", () => this.port.projects());
  workflow = () => this.memo<JiraWorkflow>("workflow", () => this.port.workflow());
  customFields = () => this.memo<JiraCustomFieldDef[]>("customFields", () => this.port.customFields());

  async mapContext(): Promise<MapContext> {
    const [projects, workflow, customFields] = await Promise.all([this.projects(), this.workflow(), this.customFields()]);
    return {
      version: this.version,
      baseUrl: this.baseUrl,
      projects: new Map(projects.map((p) => [p.id, p])),
      states: new Map(workflow.states.map((s) => [s.key, s])),
      customFields,
    };
  }

  async inboundContext(): Promise<InboundContext> {
    const [projects, workflow, customFields, members] = await Promise.all([this.projects(), this.workflow(), this.customFields(), this.members()]);
    return { version: this.version, projects, members, customFields, states: workflow.states };
  }

  async issueOr404(keyOrId: string): Promise<JiraIssue> {
    const ref = /^[a-z][a-z0-9]{1,9}-\d+$/i.test(keyOrId) ? keyOrId.toUpperCase() : keyOrId;
    if (!/^(\d{1,18}|[A-Z][A-Z0-9]{1,9}-\d{1,10})$/.test(ref)) throw new JiraError(404, [JIRA_MESSAGES.issueNotFound]);
    const issue = await this.port.getIssue(ref);
    if (!issue) throw new JiraError(404, [JIRA_MESSAGES.issueNotFound]);
    return issue;
  }

  async writeOptions(body: unknown): Promise<JiraWriteOptions> {
    const header = this.request.headers.get("idempotency-key");
    if (header) {
      const parsed = IdempotencyKeySchema.safeParse(header);
      if (!parsed.success) throw JiraError.badRequest("The Idempotency-Key header must be 8-128 letters, digits and . _ : -");
      return { idempotencyKey: header, idempotencyKeyDerived: false };
    }
    const me = await this.myself();
    const idempotencyKey = await deriveIdempotencyKey({
      accountId: me.principal.id,
      method: this.request.method,
      path: this.path,
      body,
      now: this.now(),
      windowMs: this.options.derivedKeyWindowMs ?? 60_000,
    });
    return { idempotencyKey, idempotencyKeyDerived: true };
  }
}

/** Unwrap a write outcome: applied → record; anything else → the matching Jira error. */
function applied<T>(outcome: MutationOutcome<T>, conflictStatus = 409): T {
  switch (outcome.status) {
    case "applied":
      return outcome.record;
    case "pending":
      throw new JiraError(
        409,
        [`The change is waiting for approval (action ${outcome.actionId}) and has not been applied yet.`],
        {},
        { "x-records-action-id": String(outcome.actionId) },
      );
    case "rejected": {
      const code: ErrorCode = outcome.code in ERROR_STATUS ? (outcome.code as ErrorCode) : "forbidden";
      const err = jiraErrorFromRecords(new RecordsError(code, outcome.message));
      throw new JiraError(err.status, [outcome.message], {}, err.headers);
    }
    case "conflict":
      throw new JiraError(outcome.code === "workflow_conflict" ? conflictStatus : 409, [outcome.message]);
  }
}

// ---------------------------------------------------------------------------------------------
// Routes

type Handler = (ctx: RequestContext, params: string[]) => Promise<Response>;
type Route = { method: string; pattern: RegExp; handle: Handler; notFound?: string };

const KEY = "([^/]+)";

async function searchIssues(ctx: RequestContext, input: { jql: string; nextPageToken?: string | null; maxResults: number; fields?: string[] }): Promise<Response> {
  const [me, projects, workflow, members] = await Promise.all([
    ctx.myself().catch((err) => {
      if (RecordsError.codeOf(err) === "unauthenticated") return null;
      throw err;
    }),
    ctx.projects(),
    ctx.workflow(),
    ctx.members(),
  ]);
  const query: IssueQuery = parseJql(input.jql, {
    resolver: resolverFromLookups({
      me: me?.principal.id ?? null,
      projects,
      states: workflow.states,
      members: members.map((m) => ({ id: m.principal.id, displayName: m.principal.displayName })),
    }),
    now: ctx.now(),
    weekStartsOn: ctx.options.weekStartsOn ?? 1,
  });
  const portToken = input.nextPageToken ? await unwrapPageToken(input.jql, input.nextPageToken) : null;
  const page = await ctx.port.search(query, { limit: input.maxResults, pageToken: portToken });
  const mapCtx = await ctx.mapContext();
  const select = fieldSelector(input.fields, "none");
  const issues = page.issues.map((i) => issueToJira(mapCtx, i, select));
  return json({
    issues,
    ...(page.nextPageToken ? { nextPageToken: await wrapPageToken(input.jql, page.nextPageToken) } : {}),
    isLast: !page.nextPageToken,
  });
}

function stringList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
  throw JiraError.badRequest("fields must be a list of field ids.");
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/serverInfo$/,
    async handle(ctx) {
      const now = ctx.now();
      return json({
        baseUrl: ctx.baseUrl,
        displayUrl: ctx.baseUrl,
        version: "1001.0.0-SNAPSHOT",
        versionNumbers: [1001, 0, 0],
        deploymentType: "Cloud",
        buildNumber: 100000,
        buildDate: "2026-01-01T00:00:00.000+0000",
        serverTime: now.toISOString().replace("Z", "+0000"),
        scmInfo: "records-jira",
        serverTitle: ctx.options.serverTitle ?? "Records",
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/myself$/,
    async handle(ctx) {
      const me = await ctx.myself();
      return json({ ...memberToJira(ctx, me), locale: "en_GB" });
    },
  },
  {
    method: "GET",
    pattern: /^\/user$/,
    async handle(ctx) {
      const id = ctx.url.searchParams.get("accountId");
      if (!id) throw JiraError.badRequest("The query parameter 'accountId' is required.");
      const user = (await ctx.members()).find((m) => m.principal.id === id);
      if (!user) throw new JiraError(404, [JIRA_MESSAGES.userNotFound(id)]);
      return json(memberToJira(ctx, user));
    },
  },
  ...["user/search", "user/assignable/search"].map<Route>((p) => ({
    method: "GET",
    pattern: new RegExp(`^/${p.replace("/", "\\/")}$`),
    async handle(ctx) {
      const q = (ctx.url.searchParams.get("query") ?? ctx.url.searchParams.get("username") ?? "").trim().toLowerCase();
      const accountId = ctx.url.searchParams.get("accountId");
      const startAt = intParam(ctx.url, "startAt", 0, 0, 1_000_000);
      const maxResults = intParam(ctx.url, "maxResults", 50, 0, 1000);
      let users = await ctx.members();
      if (p === "user/assignable/search") users = users.filter((u) => u.active);
      if (accountId) users = users.filter((u) => u.principal.id === accountId);
      if (ctx.url.searchParams.get("includeInactive")?.toLowerCase() === "false") users = users.filter((u) => u.active);
      // Jira Cloud's `query` matches display name, email and account id (Python `jira` relies on the last).
      if (q) {
        users = users.filter(
          (u) => u.principal.id.toLowerCase() === q || u.principal.displayName.toLowerCase().includes(q) || (u.emailAddress ?? "").toLowerCase().includes(q),
        );
      }
      return json(users.slice(startAt, startAt + maxResults).map((u) => memberToJira(ctx, u)));
    },
  })),
  {
    method: "GET",
    pattern: /^\/project$/,
    async handle(ctx) {
      return json((await ctx.projects()).map((p) => projectToJira(ctx, p, false)));
    },
  },
  {
    method: "GET",
    pattern: /^\/project\/search$/,
    async handle(ctx) {
      const startAt = intParam(ctx.url, "startAt", 0, 0, 1_000_000);
      const maxResults = intParam(ctx.url, "maxResults", 50, 1, 100);
      const q = (ctx.url.searchParams.get("query") ?? "").trim().toLowerCase();
      const keys = ctx.url.searchParams.getAll("keys").flatMap((k) => k.split(",")).filter(Boolean);
      const ids = ctx.url.searchParams.getAll("id").flatMap((k) => k.split(",")).filter(Boolean);
      let projects = [...(await ctx.projects())].sort((a, b) => (a.key < b.key ? -1 : 1));
      if (q) projects = projects.filter((p) => p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
      if (keys.length) projects = projects.filter((p) => keys.includes(p.key));
      if (ids.length) projects = projects.filter((p) => ids.includes(String(p.jiraId)));
      const values = projects.slice(startAt, startAt + maxResults).map((p) => projectToJira(ctx, p, false));
      const isLast = startAt + maxResults >= projects.length;
      const self = new URL(ctx.url.toString());
      const next = new URL(ctx.url.toString());
      next.searchParams.set("startAt", String(startAt + maxResults));
      return json({
        self: api(ctx, `project/search${self.search}`),
        ...(isLast ? {} : { nextPage: api(ctx, `project/search${next.search}`) }),
        maxResults,
        startAt,
        total: projects.length,
        isLast,
        values,
      });
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/project/${KEY}$`),
    async handle(ctx, [ref]) {
      const s = decodeURIComponent(ref!);
      const p = (await ctx.projects()).find((x) => x.key === s.toUpperCase() || String(x.jiraId) === s);
      if (!p) throw new JiraError(404, [JIRA_MESSAGES.projectNotFound(s)]);
      return json(projectToJira(ctx, p, true));
    },
  },
  {
    method: "GET",
    pattern: /^\/field$/,
    async handle(ctx) {
      return json(fieldsToJira(await ctx.customFields()));
    },
  },
  {
    method: "GET",
    pattern: /^\/priority$/,
    async handle(ctx) {
      return json(JIRA_PRIORITIES.map((p) => priorityJson(ctx, p)));
    },
  },
  {
    method: "GET",
    pattern: /^\/priority\/search$/,
    async handle(ctx) {
      const values = JIRA_PRIORITIES.map((p) => ({ ...priorityJson(ctx, p), isDefault: false }));
      return json({ self: api(ctx, "priority/search"), maxResults: 50, startAt: 0, total: values.length, isLast: true, values });
    },
  },
  {
    method: "GET",
    pattern: /^\/status$/,
    async handle(ctx) {
      return json((await ctx.workflow()).states.map((s) => statusToJira(ctx, s)));
    },
  },
  {
    method: "GET",
    pattern: /^\/statuscategory$/,
    async handle(ctx) {
      return json(JIRA_STATUS_CATEGORIES.map((c) => statusCategoryJson(ctx, c)));
    },
  },
  {
    method: "GET",
    pattern: /^\/issuetype$/,
    async handle(ctx) {
      return json([issueTypeToJira(ctx)]);
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/issue/createmeta/${KEY}/issuetypes$`),
    async handle(ctx, [ref]) {
      const s = decodeURIComponent(ref!);
      const p = (await ctx.projects()).find((x) => x.key === s.toUpperCase() || String(x.jiraId) === s);
      if (!p) throw new JiraError(404, [JIRA_MESSAGES.projectNotFound(s)]);
      return json({ maxResults: 50, startAt: 0, total: 1, issueTypes: [issueTypeToJira(ctx)] });
    },
  },
  {
    method: "POST",
    pattern: /^\/issue$/,
    async handle(ctx) {
      const payload = await readJson(ctx.request);
      const input = parseCreateIssue(payload, await ctx.inboundContext());
      const issue = applied(await ctx.port.createIssue(input, await ctx.writeOptions(payload)));
      return json({ id: String(issue.jiraId), key: issue.key, self: api(ctx, `issue/${issue.jiraId}`) }, 201);
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/issue/${KEY}$`),
    async handle(ctx, [ref]) {
      const issue = await ctx.issueOr404(decodeURIComponent(ref!));
      const select = fieldSelector(ctx.url.searchParams.getAll("fields"), "*all");
      const comments = select("comment") ? await ctx.port.listComments(issue.id, { startAt: 0, maxResults: 100 }) : undefined;
      return json(issueToJira(await ctx.mapContext(), issue, select, comments ? { comments } : {}));
    },
  },
  {
    method: "PUT",
    pattern: new RegExp(`^/issue/${KEY}$`),
    async handle(ctx, [ref]) {
      const payload = await readJson(ctx.request);
      const issue = await ctx.issueOr404(decodeURIComponent(ref!));
      const patch = parseEditIssue(payload, await ctx.inboundContext());
      let current = issue;
      if (Object.keys(patch).length > 0) {
        current = applied(await ctx.port.editIssue({ issueId: issue.id, expectedRevision: undefined, patch }, await ctx.writeOptions(payload)));
      }
      if (ctx.url.searchParams.get("returnIssue") === "true") {
        return json(issueToJira(await ctx.mapContext(), current, fieldSelector(undefined, "*navigable")));
      }
      return noContent();
    },
  },
  {
    method: "PUT",
    pattern: new RegExp(`^/issue/${KEY}/assignee$`),
    async handle(ctx, [ref]) {
      const payload = await readJson(ctx.request);
      const issue = await ctx.issueOr404(decodeURIComponent(ref!));
      const patch = parseEditIssue({ fields: { assignee: payload } }, await ctx.inboundContext());
      applied(await ctx.port.editIssue({ issueId: issue.id, expectedRevision: undefined, patch }, await ctx.writeOptions(payload)));
      return noContent();
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/issue/${KEY}/transitions$`),
    async handle(ctx, [ref]) {
      const issue = await ctx.issueOr404(decodeURIComponent(ref!));
      return json(transitionsToJira(await ctx.mapContext(), issue.state, await ctx.workflow()));
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/issue/${KEY}/transitions$`),
    async handle(ctx, [ref]) {
      const payload = await readJson(ctx.request);
      const issue = await ctx.issueOr404(decodeURIComponent(ref!));
      const workflow = await ctx.workflow();
      const toState = parseTransition(payload, await ctx.inboundContext(), workflow.transitions, issue.state);
      applied(await ctx.port.transitionIssue({ issueId: issue.id, expectedRevision: undefined, toState }, await ctx.writeOptions(payload)), 400);
      return noContent();
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/issue/${KEY}/comment$`),
    async handle(ctx, [ref]) {
      const issue = await ctx.issueOr404(decodeURIComponent(ref!));
      const startAt = intParam(ctx.url, "startAt", 0, 0, 1_000_000);
      const maxResults = intParam(ctx.url, "maxResults", 50, 1, 100);
      const page = await ctx.port.listComments(issue.id, { startAt, maxResults });
      return json(commentsPageToJira(ctx, issue, page, startAt, maxResults));
    },
  },
  {
    method: "POST",
    pattern: new RegExp(`^/issue/${KEY}/comment$`),
    async handle(ctx, [ref]) {
      const payload = await readJson(ctx.request);
      const issue = await ctx.issueOr404(decodeURIComponent(ref!));
      const body = parseCommentBody(payload, ctx.version);
      const comment = applied(await ctx.port.addComment({ issueId: issue.id, body }, await ctx.writeOptions(payload)));
      return json(commentToJira(ctx, issue, comment), 201);
    },
  },
  {
    method: "GET",
    pattern: new RegExp(`^/issue/${KEY}/comment/(\\d{1,18})$`),
    async handle(ctx, [ref, id]) {
      const issue = await ctx.issueOr404(decodeURIComponent(ref!));
      const comment = await ctx.port.getComment(issue.id, Number(id));
      if (!comment) throw new JiraError(404, [JIRA_MESSAGES.commentNotFound(id!)]);
      return json(commentToJira(ctx, issue, comment));
    },
  },
  {
    method: "GET",
    pattern: /^\/search\/jql$/,
    async handle(ctx) {
      const p = ctx.url.searchParams;
      return searchIssues(ctx, {
        jql: p.get("jql") ?? "",
        nextPageToken: p.get("nextPageToken"),
        maxResults: intParam(ctx.url, "maxResults", LIMITS.pageSizeDefault, 1, LIMITS.pageSizeMax),
        fields: p.getAll("fields"),
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/search\/jql$/,
    async handle(ctx) {
      const body = (await readJson(ctx.request)) as Record<string, unknown>;
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw JiraError.badRequest("The request body must be a JSON object.");
      const jql = body.jql ?? "";
      if (typeof jql !== "string") throw JiraError.badRequest("jql must be a string.");
      const token = body.nextPageToken;
      if (token !== undefined && token !== null && typeof token !== "string") throw JiraError.badRequest(JIRA_MESSAGES.invalidPageToken);
      const max = body.maxResults;
      if (max !== undefined && (typeof max !== "number" || !Number.isInteger(max))) throw JiraError.badRequest("maxResults must be an integer.");
      return searchIssues(ctx, {
        jql,
        nextPageToken: (token as string | null | undefined) ?? null,
        maxResults: Math.min(LIMITS.pageSizeMax, Math.max(1, (max as number | undefined) ?? LIMITS.pageSizeDefault)),
        fields: stringList(body.fields),
      });
    },
  },
  ...["GET", "POST"].map<Route>((method) => ({
    method,
    pattern: /^\/search$/,
    async handle() {
      throw new JiraError(410, [JIRA_MESSAGES.searchRemoved]);
    },
  })),
];

/**
 * Serve one Jira REST request. `basePath` is the path prefix clients use as their Jira base URL
 * (e.g. `/gatekeeper/records/v1/datastores/<id>/jira`); requests outside `basePath/rest/api/…`
 * get Jira's 404 body.
 */
export async function handleJira(request: Request, basePath: string, port: JiraPort, options: JiraRouterOptions = {}): Promise<Response> {
  const url = new URL(request.url);
  const base = basePath.replace(/\/+$/, "");
  if (!url.pathname.startsWith(`${base}/`)) return errorResponse(new JiraError(404, [JIRA_MESSAGES.notFound]));
  const rest = url.pathname.slice(base.length);
  const m = /^\/rest\/api\/(2|3|latest)(\/.*)$/.exec(rest);
  if (!m) return errorResponse(new JiraError(404, [JIRA_MESSAGES.notFound]));
  const version: ApiVersion = m[1] === "3" ? 3 : 2;
  const sub = m[2]!.replace(/\/+$/, "") || "/";
  const ctx = new RequestContext(request, url, version, `${url.origin}${base}`, rest.replace(/\/+$/, ""), port, options);

  const candidates = routes.filter((r) => r.pattern.test(sub));
  if (candidates.length === 0) return errorResponse(new JiraError(404, [JIRA_MESSAGES.notFound]));
  const method = request.method === "HEAD" ? "GET" : request.method;
  const route = candidates.find((r) => r.method === method);
  if (!route) return errorResponse(new JiraError(405, ["Method Not Allowed"], {}, { allow: [...new Set(candidates.map((r) => r.method))].join(", ") }));

  try {
    const params = route.pattern.exec(sub)!.slice(1);
    return await route.handle(ctx, params);
  } catch (err) {
    if (err instanceof JiraError) return errorResponse(err);
    const notFound = /^\/issue\//.test(sub) ? JIRA_MESSAGES.issueNotFound : /^\/project\//.test(sub) ? JIRA_MESSAGES.projectNotFound(sub.split("/")[2] ?? "") : undefined;
    const mapped = jiraErrorFromRecords(err, { ...(notFound ? { notFound } : {}), conflictStatus: /\/transitions$/.test(sub) ? 400 : 409 });
    if (mapped.status >= 500 && !(RecordsError.codeOf(err) === "unavailable")) {
      console.error("records-jira: unhandled error", err instanceof Error ? err.message : String(err));
    }
    return errorResponse(mapped);
  }
}
