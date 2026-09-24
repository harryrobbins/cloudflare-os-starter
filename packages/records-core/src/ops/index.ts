// Operator tools (canonical plan §8, Phase 6): per-datastore restore by journal replay, redaction,
// journal archival and analytics logins. All run as the migration owner, never as a runtime role.
// Runbook: docs/plans/external_datastores/records-operations.md.

export { ANALYTICS_VIEWS_V1, grantAnalyticsLogin, type AnalyticsGrant, type AnalyticsGrantPlan } from "./analytics.js";
export { archiveJournalPartitions, listJournalPartitions, type ArchivedPartition, type ArchiveOptions, type ArchiveResult, type JournalPartition } from "./archive.js";
export { canonical, CONTENT_FIELDS, JournalFold, journalBounds, rebuildAt, seqAtTime, toJournalRow, type EntityState, type JournalRow, type OpsEntityType } from "./journal.js";
export { previewRedaction, redact, REDACTABLE_FIELDS, REDACTION_MARKER, type RedactInput, type RedactionPreview } from "./redact.js";
export { restoreDatastore, type RestoreChange, type RestoreOptions, type RestoreProblem, type RestoreReport } from "./restore.js";
