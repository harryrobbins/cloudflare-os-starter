// The native API's OpenAPI 3.1 document, `GET /gatekeeper/records/v1/openapi.json` (canonical plan §7).
//
// Generated from the Zod 4 contracts with zod's own `z.toJSONSchema`, not `@hono/zod-openapi`: the
// plan named Hono, but the fetch-style adapters (api.ts, jira/handler.ts) already run unchanged on
// Workers and Node, so adding a router only to describe the routes would be a second source of truth
// and a new dependency. Instead this module holds the route descriptions and the response schemas,
// and a test (records-node/__tests__/openapi.test.ts) proves every route in api.ts's table is here.
//
// Request bodies and query parameters are the contracts' own input schemas (`io: "input"`, so fields
// with defaults are optional). Responses in @records/contracts are TypeScript types, not schemas;
// the schemas below mirror them, and the `Same<…>` checks at the bottom fail type-checking if either
// side drifts.
//
// Vendor extensions the SDK generator (packages/records-sdk/scripts/generate.ts) relies on:
//   x-records-idempotency  "safe"    a read (GET, sync pull); any retry is safe
//                          "key"     a mutation keyed by Idempotency-Key; retrying with the SAME key
//                                    replays the first outcome, so the SDK retries it
//                          "natural" sync push: idempotent by (clientId, mutation id)
//   x-records-if-match     true when If-Match (the ETag last read) is required (428 without it)
//   x-records-pagination   how to walk the pages: { style: "cursor", … } or { style: "seq", … }
//   x-records-sdk          false for routes SDKs do not wrap (the poke stream, the Jira pointer)

import { z } from "zod";

import {
  AddCommentInputSchema,
  ChangesQuerySchema,
  CreateIssueInputSchema,
  DatastoreRoleSchema,
  DISCOVERY_POLICIES,
  EditIssueInputSchema,
  ERROR_STATUS,
  JournalEntrySchema,
  LIFECYCLE_STATES,
  LIMITS,
  ListAuditInputSchema,
  ListCommentsInputSchema,
  ListIssuesInputSchema,
  PRIORITIES,
  PullRequestSchema,
  PushRequestSchema,
  TransitionIssueInputSchema,
  WORKFLOW_CATEGORIES,
  type AuditEvent,
  type ChangesPage,
  type Comment,
  type DatastoreDetail,
  type DatastoreSummary,
  type Issue,
  type Page,
  type PatchOp,
  type Problem,
  type Project,
  type PullResponse,
  type PushOutcome,
  type PushResponse,
  type Workflow,
} from "@records/contracts";

export const OPENAPI_PATH = "/gatekeeper/records/v1/openapi.json";
const PREFIX = "/gatekeeper/records/v1";
const DATASTORE = `${PREFIX}/datastores/{datastoreId}`;

// ---------------------------------------------------------------------------------------------
// Response schemas (mirrors of the contract types; checked at the bottom of this file)

const Uuid = z.uuid();
const PrincipalRefSchema = z.object({ id: Uuid, displayName: z.string(), kind: z.enum(["human", "service"]) });
const pageOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

const DatastoreSummarySchema = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string(),
  moduleId: z.string(),
  apiMajor: z.number().int(),
  features: z.array(z.string()),
  lifecycle: z.enum(LIFECYCLE_STATES),
  ownerTeam: z.string().nullable(),
  discovery: z.enum(DISCOVERY_POLICIES),
  role: DatastoreRoleSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const DatastoreDetailSchema = DatastoreSummarySchema.extend({
  owner: PrincipalRefSchema,
  retentionPolicy: z.string(),
  environment: z.string(),
  placement: z.string(),
  moduleVersion: z.string().nullable(),
  memberCount: z.number().int(),
  activeBindingCount: z.number().int(),
  activeCredentialCount: z.number().int(),
  revision: z.number().int(),
});
const DatastoreSchema = z.union([DatastoreDetailSchema, DatastoreSummarySchema]);

const ProjectSchema = z.object({
  id: Uuid, key: z.string(), name: z.string(), description: z.string(), revision: z.number().int(), createdAt: z.string(), updatedAt: z.string(),
});
const WorkflowSchema = z.object({
  states: z.array(z.object({ key: z.string(), name: z.string(), category: z.enum(WORKFLOW_CATEGORIES), position: z.number().int() })),
  transitions: z.array(z.object({ from: z.string(), to: z.string() })),
});
const CustomFieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const IssueSchema = z.object({
  id: Uuid,
  projectId: Uuid,
  number: z.number().int(),
  key: z.string(),
  title: z.string(),
  description: z.string(),
  state: z.string(),
  priority: z.enum(PRIORITIES),
  assignee: PrincipalRefSchema.nullable(),
  customFields: z.record(z.string(), CustomFieldValue),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: PrincipalRefSchema,
  updatedBy: PrincipalRefSchema,
});
const CommentSchema = z.object({ id: Uuid, issueId: Uuid, body: z.string(), author: PrincipalRefSchema, createdAt: z.string() });
const AuditEventSchema = z.object({
  id: Uuid,
  datastoreId: Uuid.nullable(),
  operation: z.string(),
  actor: PrincipalRefSchema,
  initiator: PrincipalRefSchema.nullable(),
  bindingId: Uuid.nullable(),
  via: z.enum(["gadget", "http", "management", "system"]),
  targetType: z.string().nullable(),
  targetId: Uuid.nullable(),
  summary: z.string(),
  at: z.string(),
});
const ChangesPageSchema = z.object({ entries: z.array(JournalEntrySchema), nextAfter: z.number().int(), head: z.number().int(), resetRequired: z.boolean() });
const PushOutcomeSchema = z.union([
  z.object({ id: z.number().int(), status: z.literal("applied"), seq: z.number().int() }),
  z.object({ id: z.number().int(), status: z.literal("pending"), actionId: z.number().int() }),
  z.object({ id: z.number().int(), status: z.literal("rejected"), code: z.string(), message: z.string() }),
  z.object({
    id: z.number().int(), status: z.literal("conflict"), code: z.enum(["revision_conflict", "workflow_conflict"]), message: z.string(),
    currentRevision: z.number().int().optional(),
  }),
  z.object({ id: z.number().int(), status: z.literal("skipped") }),
]);
const PushResponseSchema = z.object({ outcomes: z.array(PushOutcomeSchema), head: z.number().int() });
const PatchOpSchema = z.union([
  z.object({ op: z.literal("clear") }),
  z.object({ op: z.literal("put"), key: z.string(), value: z.unknown() }),
  z.object({ op: z.literal("del"), key: z.string() }),
]);
const PullResponseSchema = z.object({ cookie: z.number().int(), lastMutationIdChanges: z.record(z.string(), z.number().int()), patch: z.array(PatchOpSchema) });
const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.enum(Object.keys(ERROR_STATUS) as [keyof typeof ERROR_STATUS, ...(keyof typeof ERROR_STATUS)[]]),
  detail: z.string().optional(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

// Request bodies: the contracts' own input schemas, shaped as each route reads them.
const EditIssueBodySchema = EditIssueInputSchema.shape.patch;
const TransitionBodySchema = TransitionIssueInputSchema.pick({ toState: true });
const AddCommentBodySchema = AddCommentInputSchema.pick({ body: true });

const responseSchemas = {
  PrincipalRef: PrincipalRefSchema,
  Datastore: DatastoreSchema,
  Project: ProjectSchema,
  ProjectList: z.object({ items: z.array(ProjectSchema) }),
  Workflow: WorkflowSchema,
  Issue: IssueSchema,
  IssuePage: pageOf(IssueSchema),
  Comment: CommentSchema,
  CommentPage: pageOf(CommentSchema),
  AuditEvent: AuditEventSchema,
  AuditPage: pageOf(AuditEventSchema),
  JournalEntry: JournalEntrySchema,
  History: z.object({ items: z.array(JournalEntrySchema) }),
  ChangesPage: ChangesPageSchema,
  PushOutcome: PushOutcomeSchema,
  PushResponse: PushResponseSchema,
  PatchOp: PatchOpSchema,
  PullResponse: PullResponseSchema,
  Problem: ProblemSchema,
} as const;

const requestSchemas = {
  CreateIssueRequest: CreateIssueInputSchema,
  EditIssueRequest: EditIssueBodySchema,
  TransitionIssueRequest: TransitionBodySchema,
  AddCommentRequest: AddCommentBodySchema,
  PushRequest: PushRequestSchema,
  PullRequest: PullRequestSchema,
} as const;

type JsonSchema = Record<string, unknown>;

function openObjects(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(openObjects);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) if (!(k === "additionalProperties" && v === false)) out[k] = openObjects(v);
  return out;
}

function componentSchemas(): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {};
  for (const [set, io] of [[responseSchemas, "output"], [requestSchemas, "input"]] as const) {
    const registry = z.registry<{ id: string }>();
    for (const [id, schema] of Object.entries(set)) registry.add(schema as z.ZodType, { id });
    const { schemas } = z.toJSONSchema(registry, { io, unrepresentable: "any", uri: (id) => `#/components/schemas/${id}` }) as { schemas: Record<string, JsonSchema> };
    for (const [id, schema] of Object.entries(schemas)) {
      const { $schema: _dropped, $id: _id, ...rest } = schema;
      // Responses may gain fields in a minor version, so they are not closed to clients.
      out[id] = io === "output" ? (openObjects(rest) as JsonSchema) : rest;
    }
  }
  return out;
}

const inlineSchema = (schema: z.ZodType): JsonSchema => {
  const { $schema: _dropped, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  return rest;
};

// ---------------------------------------------------------------------------------------------
// Operations

type Idempotency = "safe" | "key" | "natural";
type Pagination =
  | { style: "cursor"; cursorParam: "cursor"; nextField: "nextCursor"; itemsField: "items" }
  | { style: "seq"; afterParam: "after"; nextField: "nextAfter"; itemsField: "entries"; headField: "head" };

type QueryParam = { name: string; schema: z.ZodType; description?: string };

export type ApiOperation = {
  operationId: string;
  method: "GET" | "POST" | "PATCH";
  /** Path under `/gatekeeper/records/v1/datastores/{datastoreId}` ("" for the datastore itself). */
  path: string;
  summary: string;
  tag: "datastore" | "issues" | "comments" | "journal" | "sync" | "realtime";
  idempotency: Idempotency;
  ifMatch?: boolean;
  query?: QueryParam[];
  body?: keyof typeof requestSchemas;
  /** Success status → response component name (null = no JSON body). */
  success: Record<number, keyof typeof responseSchemas | null>;
  /** The success response carries an ETag with the record's revision. */
  etag?: boolean;
  pagination?: Pagination;
  sdk?: false;
  description?: string;
};

const CURSOR: Pagination = { style: "cursor", cursorParam: "cursor", nextField: "nextCursor", itemsField: "items" };
const issuesShape = ListIssuesInputSchema.shape;
const pageQuery = (shape: { limit: z.ZodType; cursor: z.ZodType }): QueryParam[] => [
  { name: "limit", schema: shape.limit, description: `Page size (default ${LIMITS.pageSizeDefault}, at most ${LIMITS.pageSizeMax}).` },
  { name: "cursor", schema: shape.cursor, description: "The previous page's `nextCursor`; valid only for the same query." },
];

export const API_OPERATIONS: readonly ApiOperation[] = [
  { operationId: "getDatastore", method: "GET", path: "", summary: "The datastore the credential is bound to", tag: "datastore", idempotency: "safe", success: { 200: "Datastore" } },
  { operationId: "listProjects", method: "GET", path: "/projects", summary: "List projects", tag: "datastore", idempotency: "safe", success: { 200: "ProjectList" } },
  { operationId: "getWorkflow", method: "GET", path: "/workflow", summary: "The workflow states and allowed transitions", tag: "datastore", idempotency: "safe", success: { 200: "Workflow" } },
  {
    operationId: "listIssues", method: "GET", path: "/issues", summary: "Search issues", tag: "issues", idempotency: "safe", success: { 200: "IssuePage" }, pagination: CURSOR,
    query: [
      { name: "projectId", schema: issuesShape.projectId },
      { name: "state", schema: issuesShape.state },
      { name: "assigneeId", schema: issuesShape.assigneeId },
      { name: "q", schema: issuesShape.query, description: "Full-text query over title and description." },
      { name: "order", schema: issuesShape.order },
      ...pageQuery(issuesShape),
    ],
  },
  {
    operationId: "createIssue", method: "POST", path: "/issues", summary: "Create an issue", tag: "issues", idempotency: "key", body: "CreateIssueRequest",
    success: { 201: "Issue", 200: "Issue" }, etag: true,
    description: "201 on first commit; 200 with `Idempotent-Replayed: true` when the Idempotency-Key was already used for the same request.",
  },
  { operationId: "getIssue", method: "GET", path: "/issues/{issueId}", summary: "Get an issue", tag: "issues", idempotency: "safe", success: { 200: "Issue" }, etag: true },
  {
    operationId: "editIssue", method: "PATCH", path: "/issues/{issueId}", summary: "Edit an issue's fields", tag: "issues", idempotency: "key", ifMatch: true,
    body: "EditIssueRequest", success: { 200: "Issue" }, etag: true,
  },
  {
    operationId: "transitionIssue", method: "POST", path: "/issues/{issueId}/transitions", summary: "Move an issue to another workflow state", tag: "issues",
    idempotency: "key", ifMatch: true, body: "TransitionIssueRequest", success: { 200: "Issue" }, etag: true,
  },
  {
    operationId: "listComments", method: "GET", path: "/issues/{issueId}/comments", summary: "List an issue's comments", tag: "comments", idempotency: "safe",
    success: { 200: "CommentPage" }, pagination: CURSOR, query: pageQuery(ListCommentsInputSchema.shape),
  },
  {
    operationId: "addComment", method: "POST", path: "/issues/{issueId}/comments", summary: "Comment on an issue", tag: "comments", idempotency: "key",
    body: "AddCommentRequest", success: { 201: "Comment", 200: "Comment" },
  },
  { operationId: "getIssueHistory", method: "GET", path: "/issues/{issueId}/history", summary: "An issue's journal entries", tag: "journal", idempotency: "safe", success: { 200: "History" } },
  {
    operationId: "listChanges", method: "GET", path: "/changes", summary: "The commit-ordered journal after a sequence number", tag: "journal", idempotency: "safe",
    success: { 200: "ChangesPage" },
    pagination: { style: "seq", afterParam: "after", nextField: "nextAfter", itemsField: "entries", headField: "head" },
    query: [
      { name: "after", schema: ChangesQuerySchema.shape.after, description: "The last `seq` already seen (0 for the start)." },
      { name: "limit", schema: ChangesQuerySchema.shape.limit },
    ],
    description: "`resetRequired: true` means `after` is older than journal retention: reload current state, then continue from `head`.",
  },
  {
    operationId: "syncPush", method: "POST", path: "/sync/push", summary: "Push client mutations (sync protocol)", tag: "sync", idempotency: "natural",
    body: "PushRequest", success: { 200: "PushResponse" },
    description: "Idempotent by (clientId, mutation id): a mutation already processed answers `skipped`.",
  },
  {
    operationId: "syncPull", method: "POST", path: "/sync/pull", summary: "Pull the patch since a cookie (sync protocol)", tag: "sync", idempotency: "safe",
    body: "PullRequest", success: { 200: "PullResponse" },
  },
  {
    operationId: "subscribePokes", method: "GET", path: "/poke", summary: "Subscribe to pokes (`{datastoreId, head}` after each commit)", tag: "realtime",
    idempotency: "safe", success: { 101: null, 200: null }, sdk: false,
    description:
      "On Workers: a WebSocket upgrade (`Upgrade: websocket`) served by the datastore's Durable Object poke hub. " +
      "On Node (@records/node): Server-Sent Events (`Accept: text/event-stream`), `event: poke` with the same JSON. " +
      "Pokes carry no data and are at-most-once; subscribers pull on every poke and on a timer. The server closes a " +
      "subscription after a maximum lifetime, so a revoked credential stops receiving pokes; reconnect and pull.",
  },
  {
    operationId: "listAudit", method: "GET", path: "/audit", summary: "The datastore's audit log", tag: "datastore", idempotency: "safe",
    success: { 200: "AuditPage" }, pagination: CURSOR, query: pageQuery(ListAuditInputSchema.shape),
  },
];

// ---------------------------------------------------------------------------------------------
// Document

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const problemContent = { "application/problem+json": { schema: ref("Problem") } };
const header = (description: string, schema: JsonSchema = { type: "string" }) => ({ description, schema });

const PROBLEM_RESPONSES: Record<string, { status: number; description: string; headers?: Record<string, unknown> }> = {
  BadRequest: { status: 400, description: "`validation_failed`: the request did not match the contract (issue paths, never values)." },
  Unauthenticated: { status: 401, description: "`unauthenticated`: missing or invalid Access assertion or Records credential." },
  Forbidden: { status: 403, description: "`forbidden`: the credential's scopes or the principal's role do not allow this." },
  NotFound: { status: 404, description: "`not_found`: no such route, record, or a datastore other than the credential's." },
  Conflict: { status: 409, description: "`workflow_conflict`, `idempotency_conflict` (key reused for a different request), `datastore_archived` or `duplicate`." },
  PreconditionFailed: {
    status: 412, description: "`revision_conflict`: If-Match is stale. `ETag` carries the current revision; re-read, merge, retry with a new key.",
    headers: { ETag: { $ref: "#/components/headers/ETag" } },
  },
  PayloadTooLarge: { status: 413, description: `\`payload_too_large\`: bodies are at most ${LIMITS.httpBodyMaxBytes} bytes; responses at most ${LIMITS.httpResponseMaxBytes}.` },
  PreconditionRequired: { status: 428, description: "`revision_required`: send If-Match with the ETag last read." },
  RateLimited: { status: 429, description: "`rate_limited`: back off for Retry-After seconds.", headers: { "Retry-After": { $ref: "#/components/headers/Retry-After" } } },
  InternalError: { status: 500, description: "`internal`: an unexpected failure (no internals in the body)." },
  Unavailable: { status: 503, description: "`unavailable`: the request exceeded its 15 s deadline or the database was busy. Idempotent calls may be retried." },
};

function errorResponses(op: ApiOperation): Record<string, { $ref: string }> {
  const names = ["Unauthenticated", "Forbidden", "NotFound", "RateLimited", "InternalError", "Unavailable"];
  if (op.body || op.query) names.push("BadRequest");
  if (op.body) names.push("PayloadTooLarge");
  if (op.idempotency === "key") names.push("Conflict");
  if (op.ifMatch) names.push("PreconditionFailed", "PreconditionRequired");
  const out: Record<string, { $ref: string }> = {};
  for (const name of names.sort((a, b) => PROBLEM_RESPONSES[a]!.status - PROBLEM_RESPONSES[b]!.status)) {
    out[String(PROBLEM_RESPONSES[name]!.status)] = { $ref: `#/components/responses/${name}` };
  }
  return out;
}

function pathParams(path: string) {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({ $ref: `#/components/parameters/${m[1]}` }));
}

function operationObject(op: ApiOperation) {
  const parameters: unknown[] = [{ $ref: "#/components/parameters/datastoreId" }, ...pathParams(op.path)];
  for (const q of op.query ?? []) {
    parameters.push({ name: q.name, in: "query", required: false, schema: inlineSchema(q.schema), ...(q.description ? { description: q.description } : {}) });
  }
  if (op.idempotency === "key") parameters.push({ $ref: "#/components/parameters/Idempotency-Key" });
  if (op.ifMatch) parameters.push({ $ref: "#/components/parameters/If-Match" });

  const responses: Record<string, unknown> = {};
  for (const [status, schema] of Object.entries(op.success)) {
    const headers: Record<string, unknown> = {};
    if (op.etag) headers.ETag = { $ref: "#/components/headers/ETag" };
    if (op.idempotency === "key") headers["Idempotent-Replayed"] = { $ref: "#/components/headers/Idempotent-Replayed" };
    responses[status] = {
      description: status === "101" ? "Switching protocols (WebSocket, on Workers)" : status === "201" ? "Created" : "OK",
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(schema ? { content: { "application/json": { schema: ref(schema) } } } : {}),
    };
  }
  Object.assign(responses, errorResponses(op));

  return {
    operationId: op.operationId,
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    tags: [op.tag],
    parameters,
    ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: ref(op.body) } } } } : {}),
    responses,
    "x-records-idempotency": op.idempotency,
    ...(op.ifMatch ? { "x-records-if-match": true } : {}),
    ...(op.pagination ? { "x-records-pagination": op.pagination } : {}),
    ...(op.sdk === false ? { "x-records-sdk": false } : {}),
  };
}

export type OpenApiDocument = {
  openapi: "3.1.0";
  info: Record<string, unknown>;
  servers: { url: string; description?: string }[];
  paths: Record<string, Record<string, unknown>>;
  components: Record<string, unknown>;
  security: Record<string, string[]>[];
  tags: Record<string, unknown>[];
  [extension: `x-${string}`]: unknown;
};

let cachedComponents: Record<string, JsonSchema> | undefined;

/**
 * The OpenAPI 3.1 document for the native API. `baseUrl` becomes the single server entry (an origin,
 * e.g. `https://records.example.com`); paths are absolute from the origin.
 */
export function openApiDocument(baseUrl?: string): OpenApiDocument {
  cachedComponents ??= componentSchemas();
  const paths: OpenApiDocument["paths"] = {};
  for (const op of API_OPERATIONS) {
    const path = `${DATASTORE}${op.path}`;
    (paths[path] ??= {})[op.method.toLowerCase()] = operationObject(op);
  }
  paths[OPENAPI_PATH] = {
    get: {
      operationId: "getOpenApiDocument", summary: "This document", tags: ["meta"], security: [], "x-records-idempotency": "safe", "x-records-sdk": false,
      responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
    },
  };
  // The Jira-compatible surface: a pointer, not a description (its contract is Jira's own API).
  paths[`${DATASTORE}/jira/rest/api/{apiVersion}/serverInfo`] = {
    get: {
      operationId: "jiraServerInfo",
      summary: "Jira-compatible surface (pointer)",
      description:
        "The Projects module also serves a Jira REST subset at `…/datastores/{datastoreId}/jira/rest/api/{2,3,latest}/…`. " +
        "Point a Jira client's base URL at `…/datastores/{datastoreId}/jira` and authenticate with `Authorization: Bearer rk1_…` " +
        "or Basic `email:rk1_…` (the credential owner's e-mail). Errors there are Jira-shaped, not problem+json.",
      tags: ["jira"],
      parameters: [
        { $ref: "#/components/parameters/datastoreId" },
        { name: "apiVersion", in: "path", required: true, schema: { enum: ["2", "3", "latest"] } },
      ],
      responses: { 200: { description: "Jira serverInfo", content: { "application/json": { schema: { type: "object" } } } } },
      "x-records-idempotency": "safe",
      "x-records-sdk": false,
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "Records native API",
      version: "1.0.0",
      description:
        "Organisation datastores (Projects module). A request carries either a Records credential (`rk1_…`) together with a " +
        "Cloudflare Access assertion for the API's own application, or a JWT from a trusted issuer (a delegated token or an " +
        "Access for SaaS token), each bound to one datastore; the `datastoreId` " +
        "in the path is a selector and must equal the credential's. Mutations need `Idempotency-Key`; changes to an " +
        "existing record need `If-Match` with the `ETag` last read. Errors are RFC 9457 problem documents with a stable `code`.",
    },
    servers: [{ url: baseUrl ?? "/", description: "Records service origin" }],
    tags: [
      { name: "datastore", description: "The datastore, its projects, workflow and audit log" },
      { name: "issues", description: "Issues: create, read, edit, transition" },
      { name: "comments", description: "Comments on issues" },
      { name: "journal", description: "The immutable, commit-ordered journal" },
      { name: "sync", description: "Replicache-style push and pull (canonical plan §6)" },
      { name: "realtime", description: "Pokes: the clock moved; pull" },
      { name: "jira", description: "Jira-compatible REST subset (Projects module); see `jiraServerInfo`" },
      { name: "meta", description: "This document" },
    ],
    security: [
      { accessAssertion: [], recordsCredential: [] },
      // A trusted JWT (delegated token, or Access for SaaS) is itself the proof: no path Access assertion.
      { delegatedToken: [] },
    ],
    paths,
    components: {
      schemas: cachedComponents,
      securitySchemes: {
        accessAssertion: {
          type: "apiKey", in: "header", name: "Cf-Access-Jwt-Assertion",
          description:
            "Cloudflare Access assertion for the API's path-specific application, verified by the service (issuer + audience). " +
            "Scripts usually obtain it by presenting an Access service token (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) at the edge. " +
            "A Node deployment may configure another front-door check or none.",
        },
        recordsCredential: {
          type: "http", scheme: "bearer", bearerFormat: "rk1",
          description: "A datastore credential `rk1_<32 hex>_<43 base64url>`: a service principal with fixed scopes on one datastore.",
        },
        delegatedToken: {
          type: "http", scheme: "bearer", bearerFormat: "JWT",
          description:
            "A JWT from a trusted issuer (records.trusted_issuers): a delegated token minted by the cloudflare-os Records gatekeeper " +
            "after it redeems a viewer assertion (60 s, `sub` = the viewer's principal, `act` = the binding, `scope` = the binding's " +
            "scopes, `aud` = the datastore service), or an Access for SaaS token for a mapped person.",
        },
      },
      parameters: {
        datastoreId: { name: "datastoreId", in: "path", required: true, schema: { type: "string", format: "uuid" }, description: "Must equal the credential's datastore." },
        issueId: { name: "issueId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        "Idempotency-Key": {
          name: "Idempotency-Key", in: "header", required: true, schema: inlineSchema(z.string().min(LIMITS.idempotencyKeyMin).max(LIMITS.idempotencyKeyMax).regex(/^[A-Za-z0-9._:-]+$/)),
          description: "Required on every mutation. The same key with the same request replays the first outcome; with a different request it is `idempotency_conflict`.",
        },
        "If-Match": {
          name: "If-Match", in: "header", required: true, schema: { type: "string", pattern: '^"r\\d{1,9}"$' },
          description: 'The ETag last read, `"r<revision>"`. Missing: 428 `revision_required`; stale: 412 `revision_conflict`.',
        },
      },
      headers: {
        ETag: header('The record\'s revision, `"r<revision>"`. Send it back as If-Match.', { type: "string", pattern: '^"r\\d+"$' }),
        "Retry-After": header("Seconds to wait before retrying.", { type: "integer", minimum: 0 }),
        "Idempotent-Replayed": header("`true` when this response replays an earlier outcome for the same Idempotency-Key.", { enum: ["true"] }),
      },
      responses: Object.fromEntries(Object.entries(PROBLEM_RESPONSES).map(([name, r]) => [name, {
        description: r.description, content: problemContent, ...(r.headers ? { headers: r.headers } : {}),
      }])),
    },
    "x-records-limits": { ...LIMITS },
  };
}

// ---------------------------------------------------------------------------------------------
// Drift checks: each response schema must infer exactly the contract type it describes.

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Out<S extends z.ZodType> = z.output<S>;
const driftChecks: [
  Same<Out<typeof DatastoreSchema>, DatastoreSummary | DatastoreDetail>,
  Same<Out<typeof ProjectSchema>, Project>,
  Same<Out<typeof WorkflowSchema>, Workflow>,
  Same<Out<typeof IssueSchema>, Issue>,
  Same<Out<typeof CommentSchema>, Comment>,
  Same<Out<typeof AuditEventSchema>, AuditEvent>,
  Same<Out<ReturnType<typeof pageOf<typeof IssueSchema>>>, Page<Issue>>,
  Same<Out<typeof ChangesPageSchema>, ChangesPage>,
  Same<Out<typeof PushOutcomeSchema>, PushOutcome>,
  Same<Out<typeof PushResponseSchema>, PushResponse>,
  Same<Out<typeof PatchOpSchema>, PatchOp>,
  Same<Out<typeof PullResponseSchema>, PullResponse>,
  Same<Out<typeof ProblemSchema>, Problem>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true];
void driftChecks;
