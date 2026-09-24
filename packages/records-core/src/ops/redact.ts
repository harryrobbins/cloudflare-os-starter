// Redaction (canonical plan §8, "Erasure"): the operator wrapper around records_ops.redact
// (migration 0009), which only the migration owner can execute. The preview never returns the text
// being removed, only where it occurs, so a dry run does not copy it into a terminal or a log.

import type { Sql } from "postgres";

import type { OpsEntityType } from "./journal.js";

export const REDACTABLE_FIELDS: Record<OpsEntityType, readonly string[]> = {
  project: ["name", "description"],
  issue: ["title", "description"],
  comment: ["body"],
};

export const REDACTION_MARKER = "[redacted]";

export type RedactInput = {
  datastoreId: string;
  entityType: OpsEntityType;
  entityId: string;
  fields: string[];
  reason: string;
  /** The operator's principal, in the datastore's organisation. */
  actorId: string;
  marker?: string;
};

export type RedactionPreview = {
  exists: boolean;
  /** Journal entries whose `after` or `before` holds one of the fields. */
  journalEntries: number;
  /** Saved command outcomes that mention the record. */
  idempotencyRows: number;
  /** Current length of each field, never its content. */
  currentLengths: Record<string, number>;
};

function check(input: RedactInput): string[] {
  const allowed = REDACTABLE_FIELDS[input.entityType];
  if (!allowed) throw new Error(`Unknown entity type ${String(input.entityType)}.`);
  const fields = [...new Set(input.fields)].toSorted();
  if (fields.length === 0 || fields.some((f) => !allowed.includes(f))) {
    throw new Error(`Fields must be a non-empty subset of ${allowed.join(", ")}.`);
  }
  return fields;
}

const TABLE: Record<OpsEntityType, string> = { project: "projects", issue: "issues", comment: "comments" };

export async function previewRedaction(sql: Sql, input: RedactInput): Promise<RedactionPreview> {
  const fields = check(input);
  const [row] = await sql`
    SELECT to_jsonb(x) AS doc FROM ${sql("projects")}.${sql(TABLE[input.entityType])} x
     WHERE x.datastore_id = ${input.datastoreId} AND x.id = ${input.entityId}`;
  const [counts] = await sql`
    SELECT (SELECT count(*) FROM records.journal j
             WHERE j.datastore_id = ${input.datastoreId} AND j.entity_id = ${input.entityId}
               AND (j.after ?| ${fields}::text[] OR coalesce(j.before ?| ${fields}::text[], false))) AS journal,
           (SELECT count(*) FROM records.idempotency_keys k
             WHERE k.datastore_id = ${input.datastoreId} AND strpos(k.outcome::text, ${input.entityId}) > 0) AS idem`;
  const doc = (row?.doc ?? {}) as Record<string, unknown>;
  return {
    exists: Boolean(row),
    journalEntries: Number(counts!.journal),
    idempotencyRows: Number(counts!.idem),
    currentLengths: Object.fromEntries(fields.map((f) => [f, typeof doc[f] === "string" ? (doc[f] as string).length : 0])),
  };
}

export async function redact(sql: Sql, input: RedactInput): Promise<{ seq: number; journalEntries: number; idempotencyRows: number }> {
  const fields = check(input);
  const [row] = await sql`
    SELECT * FROM records_ops.redact(${input.datastoreId}::uuid, ${input.entityType}, ${input.entityId}::uuid, ${fields}::text[],
                                     ${input.reason}, ${input.actorId}::uuid, ${input.marker ?? REDACTION_MARKER})`;
  return { seq: Number(row!.seq), journalEntries: Number(row!.journal_entries), idempotencyRows: Number(row!.idempotency_rows) };
}
