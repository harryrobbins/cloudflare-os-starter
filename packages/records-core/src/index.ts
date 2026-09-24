// @records/core: the portable datastore core. No Cloudflare imports: postgres.js, zod and the
// contracts only, so the same code runs in a Worker (through Hyperdrive) and on Node.

export { contextOf, pgCode, translate, UNNARROWED_SCOPES, withContext, type Db, type Tx, type TxContext, type TxOptions } from "./db/context.js";
export { authorize, hasOrgRole, requireOrgRole, requireWritable, type DatastoreAccess } from "./domain/authorize.js";
export { decodeCursor, encodeCursor, likePattern } from "./domain/cursor.js";
export { findSaved, idempotent, IDEMPOTENCY_RETENTION_DAYS, saveOutcome, type Idempotent } from "./domain/idempotency.js";
export { audit, emit, useDatastore, type AuditEntry, type PendingEvent } from "./domain/journal.js";
export { ProjectsService, seedWorkflow } from "./domain/projects.js";
export { normaliseEmail, RegistryService, WORKSHOP_ISSUER, type Whoami } from "./domain/registry.js";
export { connect, RecordsService } from "./domain/service.js";
export { CommandBus, settle, type AppliedOutcome, type CommandOutcome, type ExecuteOptions } from "./bus/bus.js";
export { JournalReader } from "./bus/changes.js";
export { commitPlan, type BusHooks, type CommitMeta, type Plan, type PlannedChange } from "./bus/commit.js";
export { uuidv7 } from "./bus/uuidv7.js";
export { PROJECTS_HANDLERS, type Handler, type ProjectsCommandName } from "./projects/handlers.js";
export { SyncService } from "./sync/service.js";
export {
  readHead,
  SYNC_OUTCOME_OPERATION,
  SYNC_PUSH_BUDGET_MS,
  syncIdempotencyKey,
  type PushOptions,
  type SettledPushOutcome,
  type SyncGate,
  type SyncGateDecision,
} from "./sync/push.js";
export { SYNC_LIMITS, WORKFLOW_KEY, type PullOptions } from "./sync/pull.js";
export { searchIssues, type IssueSearchPage, type SearchedIssue } from "./projects/search.js";
export { issueSelect, jiraIdOf, toComment, toIssue, toJiraComment, toJiraIssue, toProject } from "./projects/rows.js";
export {
  basicUserMatches,
  credentialOwnerEmail,
  loadTrustedIssuers,
  PostgresReplayGuard,
  pruneDelegatedTokenUses,
  resolveDelegatedCaller,
  type DelegatedGrant,
  type TrustedIssuerRow,
} from "./domain/identity.js";
export {
  claimWebhookDeliveries,
  CreateWebhookInputSchema,
  expandWebhookDeliveries,
  matchesWebhook,
  pruneWebhookDeliveries,
  readWebhookChange,
  requireWebhookUrl,
  settleWebhookDelivery,
  WEBHOOK_EVENTS,
  WEBHOOK_FORMATS,
  WEBHOOK_LIMITS,
  webhookBackoffSeconds,
  webhookCaller,
  webhookEventOf,
  webhookLag,
  webhookUrlProblem,
  WebhookService,
  type ClaimedDelivery,
  type CreatedWebhook,
  type CreateWebhookInput,
  type DeliveryResult,
  type Webhook,
  type WebhookDelivery,
  type WebhookEvent,
  type WebhookFormat,
} from "./domain/webhooks.js";
export {
  ANALYTICS_VIEWS_V1,
  archiveJournalPartitions,
  grantAnalyticsLogin,
  JournalFold,
  listJournalPartitions,
  previewRedaction,
  rebuildAt,
  redact,
  REDACTABLE_FIELDS,
  REDACTION_MARKER,
  restoreDatastore,
  seqAtTime,
  type ArchivedPartition,
  type ArchiveOptions,
  type ArchiveResult,
  type EntityState,
  type RedactInput,
  type RestoreOptions,
  type RestoreReport,
} from "./ops/index.js";
