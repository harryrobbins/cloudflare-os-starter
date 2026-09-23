// Validated data transfer objects shared by the Gatekeeper RPC session, the HTTP API and the
// management UI. Inputs are parsed with these schemas at every transport boundary; outputs are
// typed with the inferred types. Nothing here carries trusted identity: actor, organisation and
// datastore ownership come from the server-side caller context, never from a payload.

import { z } from "zod";

import { DatastoreRoleSchema, RecordScopeSchema, ServiceScopeSchema } from "./permissions.js";

// ---------------------------------------------------------------------------------------------
// Limits (bounded filters, page sizes and bodies; plan §7)

export const LIMITS = {
  pageSizeDefault: 50,
  pageSizeMax: 100,
  titleMax: 200,
  descriptionMax: 20_000,
  commentMax: 10_000,
  nameMax: 120,
  datastoreDescriptionMax: 1_000,
  customFieldsMax: 50,
  customFieldValueMax: 2_000,
  searchQueryMax: 200,
  idempotencyKeyMin: 8,
  idempotencyKeyMax: 128,
  httpBodyMaxBytes: 64 * 1024,
  httpResponseMaxBytes: 1024 * 1024,
  statementTimeoutMs: 5_000,
} as const;

export const UuidSchema = z.uuid();
export type Uuid = string;

export const CursorSchema = z.string().min(1).max(512);
export const PageSizeSchema = z.number().int().min(1).max(LIMITS.pageSizeMax);

/** A page of results. `nextCursor` is opaque and valid only for the same query. */
export type Page<T> = { items: T[]; nextCursor: string | null };

export const IdempotencyKeySchema = z
  .string()
  .min(LIMITS.idempotencyKeyMin)
  .max(LIMITS.idempotencyKeyMax)
  .regex(/^[A-Za-z0-9._:-]+$/, "idempotency keys use letters, digits and . _ : -");

export const RevisionSchema = z.number().int().min(1);

// ---------------------------------------------------------------------------------------------
// People

/** A principal as shown to other people. Display attributes only; never an ownership key. */
export type PrincipalRef = { id: Uuid; displayName: string; kind: "human" | "service" };

// ---------------------------------------------------------------------------------------------
// Registry

export const LIFECYCLE_STATES = ["active", "archived"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const DISCOVERY_POLICIES = ["members", "organisation"] as const;
export type DiscoveryPolicy = (typeof DISCOVERY_POLICIES)[number];

/** What any member (or, for `organisation` discovery, any organisation principal) may see. */
export type DatastoreSummary = {
  id: Uuid;
  name: string;
  description: string;
  moduleId: string;
  apiMajor: number;
  features: string[];
  lifecycle: LifecycleState;
  ownerTeam: string | null;
  discovery: DiscoveryPolicy;
  /** The caller's role, or null for a requestable (organisation-discoverable) entry. */
  role: z.infer<typeof DatastoreRoleSchema> | null;
  createdAt: string;
  updatedAt: string;
};

/** Administrative detail, visible to datastore owners/admins. */
export type DatastoreDetail = DatastoreSummary & {
  owner: PrincipalRef;
  retentionPolicy: string;
  environment: string;
  placement: string;
  moduleVersion: string | null;
  memberCount: number;
  activeBindingCount: number;
  activeCredentialCount: number;
  revision: number;
};

export const CreateDatastoreInputSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameMax),
  description: z.string().max(LIMITS.datastoreDescriptionMax).default(""),
  moduleId: z.literal("projects"),
  ownerPrincipalId: UuidSchema,
  ownerTeam: z.string().trim().max(LIMITS.nameMax).nullable().default(null),
  retentionPolicy: z.string().trim().min(1).max(200).default("retain-until-deleted"),
  discovery: z.enum(DISCOVERY_POLICIES).default("members"),
  /** Optional initial project, created in the same transaction. */
  initialProject: z
    .object({ key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/), name: z.string().trim().min(1).max(LIMITS.nameMax) })
    .optional(),
});
export type CreateDatastoreInput = z.input<typeof CreateDatastoreInputSchema>;

export const SearchDatastoresInputSchema = z.object({
  query: z.string().trim().max(LIMITS.searchQueryMax).default(""),
  moduleId: z.string().max(64).optional(),
  apiMajor: z.number().int().min(1).optional(),
  includeArchived: z.boolean().default(false),
  includeRequestable: z.boolean().default(false),
  /**
   * Data administrators only: list every datastore in the organisation (name, module and
   * lifecycle only, no role), so an orphaned datastore can be found and its ownership recovered.
   */
  allOrganisation: z.boolean().default(false),
  limit: PageSizeSchema.default(LIMITS.pageSizeDefault),
  cursor: CursorSchema.optional(),
});
export type SearchDatastoresInput = z.input<typeof SearchDatastoresInputSchema>;

export const InvitePrincipalInputSchema = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(120),
});
export const SetDataAdminInputSchema = z.object({ principalId: UuidSchema, enabled: z.boolean() });

export type Member = { principal: PrincipalRef; role: z.infer<typeof DatastoreRoleSchema>; grantedAt: string };

export const AddMemberInputSchema = z.object({
  principalId: UuidSchema,
  role: DatastoreRoleSchema.exclude(["owner"]),
});
export const SetMemberRoleInputSchema = AddMemberInputSchema;
export const RemoveMemberInputSchema = z.object({ principalId: UuidSchema });
export const TransferOwnershipInputSchema = z.object({ newOwnerPrincipalId: UuidSchema });

// ---------------------------------------------------------------------------------------------
// Bindings and credentials

export const BINDING_KINDS = ["gadget", "service"] as const;
export type BindingKind = (typeof BINDING_KINDS)[number];

export type Binding = {
  id: Uuid;
  datastoreId: Uuid;
  kind: BindingKind;
  label: string;
  principal: PrincipalRef;
  scopes: string[];
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
};

export const CreateGadgetBindingInputSchema = z.object({
  label: z.string().trim().min(1).max(LIMITS.nameMax),
  scopes: z.array(RecordScopeSchema).min(1).max(16),
});

/** Creating a service credential creates its service principal and binding in one step. */
export const CreateCredentialInputSchema = z.object({
  label: z.string().trim().min(1).max(LIMITS.nameMax),
  scopes: z.array(ServiceScopeSchema).min(1).max(16),
  /** Lifetime in days. Bounded: credentials always expire. */
  expiresInDays: z.number().int().min(1).max(365),
});

export type CredentialInfo = {
  id: Uuid;
  bindingId: Uuid;
  label: string;
  prefix: string;
  scopes: string[];
  servicePrincipal: PrincipalRef;
  owner: PrincipalRef;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

/** Returned once, at creation. The secret is never stored or shown again. */
export type CreatedCredential = { credential: CredentialInfo; secret: string };

// ---------------------------------------------------------------------------------------------
// Audit

export type AuditEvent = {
  id: Uuid;
  datastoreId: Uuid | null;
  operation: string;
  actor: PrincipalRef;
  initiator: PrincipalRef | null;
  bindingId: Uuid | null;
  via: "gadget" | "http" | "management" | "system";
  targetType: string | null;
  targetId: Uuid | null;
  summary: string;
  at: string;
};

export const ListAuditInputSchema = z.object({
  limit: PageSizeSchema.default(LIMITS.pageSizeDefault),
  cursor: CursorSchema.optional(),
});

// ---------------------------------------------------------------------------------------------
// Projects module

export const WORKFLOW_CATEGORIES = ["todo", "in_progress", "done"] as const;
export type WorkflowCategory = (typeof WORKFLOW_CATEGORIES)[number];

export type WorkflowState = { key: string; name: string; category: WorkflowCategory; position: number };
export type Workflow = { states: WorkflowState[]; transitions: { from: string; to: string }[] };

/** The workflow every new datastore starts with. */
export const DEFAULT_WORKFLOW: Workflow = {
  states: [
    { key: "backlog", name: "Backlog", category: "todo", position: 0 },
    { key: "todo", name: "To do", category: "todo", position: 1 },
    { key: "in_progress", name: "In progress", category: "in_progress", position: 2 },
    { key: "in_review", name: "In review", category: "in_progress", position: 3 },
    { key: "done", name: "Done", category: "done", position: 4 },
  ],
  transitions: [
    { from: "backlog", to: "todo" },
    { from: "todo", to: "backlog" },
    { from: "todo", to: "in_progress" },
    { from: "in_progress", to: "todo" },
    { from: "in_progress", to: "in_review" },
    { from: "in_review", to: "in_progress" },
    { from: "in_review", to: "done" },
    { from: "done", to: "todo" },
  ],
};

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

export type Project = {
  id: Uuid;
  key: string;
  name: string;
  description: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export const CreateProjectInputSchema = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, "a project key is 2-10 capitals and digits"),
  name: z.string().trim().min(1).max(LIMITS.nameMax),
  description: z.string().max(LIMITS.datastoreDescriptionMax).default(""),
});

export type Issue = {
  id: Uuid;
  projectId: Uuid;
  number: number;
  /** Display key, e.g. `ENG-12`. */
  key: string;
  title: string;
  description: string;
  state: string;
  priority: Priority;
  assignee: PrincipalRef | null;
  customFields: Record<string, string | number | boolean | null>;
  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: PrincipalRef;
  updatedBy: PrincipalRef;
};

export type Comment = {
  id: Uuid;
  issueId: Uuid;
  body: string;
  author: PrincipalRef;
  createdAt: string;
};

const CustomFieldValueSchema = z.union([
  z.string().max(LIMITS.customFieldValueMax),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const CustomFieldsSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), CustomFieldValueSchema)
  .refine((v) => Object.keys(v).length <= LIMITS.customFieldsMax, "too many custom fields");

export const ListIssuesInputSchema = z.object({
  projectId: UuidSchema.optional(),
  state: z.string().max(40).optional(),
  assigneeId: UuidSchema.optional(),
  query: z.string().trim().max(LIMITS.searchQueryMax).optional(),
  order: z.enum(["updated_desc", "number_asc"]).default("updated_desc"),
  limit: PageSizeSchema.default(LIMITS.pageSizeDefault),
  cursor: CursorSchema.optional(),
});
export type ListIssuesInput = z.input<typeof ListIssuesInputSchema>;

export const CreateIssueInputSchema = z.object({
  projectId: UuidSchema,
  title: z.string().trim().min(1).max(LIMITS.titleMax),
  description: z.string().max(LIMITS.descriptionMax).default(""),
  state: z.string().max(40).optional(),
  priority: z.enum(PRIORITIES).default("none"),
  assigneeId: UuidSchema.nullable().default(null),
  customFields: CustomFieldsSchema.default({}),
});
export type CreateIssueInput = z.input<typeof CreateIssueInputSchema>;

export const EditIssueInputSchema = z.object({
  issueId: UuidSchema,
  expectedRevision: RevisionSchema,
  patch: z
    .object({
      title: z.string().trim().min(1).max(LIMITS.titleMax).optional(),
      description: z.string().max(LIMITS.descriptionMax).optional(),
      priority: z.enum(PRIORITIES).optional(),
      assigneeId: UuidSchema.nullable().optional(),
      customFields: CustomFieldsSchema.optional(),
    })
    .strict()
    .refine((p) => Object.keys(p).length > 0, "an edit must change something"),
});
export type EditIssueInput = z.input<typeof EditIssueInputSchema>;

export const TransitionIssueInputSchema = z.object({
  issueId: UuidSchema,
  expectedRevision: RevisionSchema,
  toState: z.string().min(1).max(40),
});
export type TransitionIssueInput = z.input<typeof TransitionIssueInputSchema>;

export const AddCommentInputSchema = z.object({
  issueId: UuidSchema,
  body: z.string().trim().min(1).max(LIMITS.commentMax),
});
export type AddCommentInput = z.input<typeof AddCommentInputSchema>;

export const ListCommentsInputSchema = z.object({
  issueId: UuidSchema,
  limit: PageSizeSchema.default(LIMITS.pageSizeDefault),
  cursor: CursorSchema.optional(),
});

// ---------------------------------------------------------------------------------------------
// Mutation outcomes (plan §6 "Approvals and revocation")

/**
 * Every mutation resolves to exactly one of these. A client must not present a change as committed
 * unless it received `applied`.
 */
export type MutationOutcome<T> =
  | { status: "applied"; record: T; replayed: boolean }
  | { status: "pending"; actionId: number; idempotencyKey: string }
  | { status: "rejected"; code: string; message: string }
  | { status: "conflict"; code: "revision_conflict" | "workflow_conflict"; message: string; currentRevision?: number };

/** Parse `input` with `schema`, throwing a RecordsError("validation_failed") on failure. */
export type Parsed<S extends z.ZodType> = z.output<S>;
