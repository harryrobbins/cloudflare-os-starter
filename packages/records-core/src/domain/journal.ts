// Audit and outbox writes. Both are inserted in the caller's transaction, so a business change,
// its audit event and its pending change event commit or roll back together. They are separate
// tables with separate readers: audit is evidence (append-only, `audit.read`), the outbox is a
// delivery queue (identifiers and revisions only, readable by the publisher alone).

import type { CallerContext, EntityType, EventType } from "@records/contracts";

import type { Tx } from "../db/context.js";

export type AuditEntry = {
  datastoreId: string | null;
  operation: string;
  targetType?: string;
  targetId?: string;
  summary: string;
  /** Bounded, non-secret detail. Never credentials or full record bodies. */
  detail?: Record<string, string | number | boolean | null | string[]>;
};

export async function audit(tx: Tx, caller: CallerContext, entry: AuditEntry): Promise<void> {
  await tx`
    INSERT INTO records.audit_events
      (org_id, id, datastore_id, operation, actor_principal_id, initiator_principal_id, binding_id, via,
       target_type, target_id, summary, detail)
    VALUES
      (${caller.orgId}, ${crypto.randomUUID()}, ${entry.datastoreId}, ${entry.operation}, ${caller.principalId},
       ${caller.initiatorPrincipalId ?? null}, ${caller.bindingId ?? null}, ${caller.via},
       ${entry.targetType ?? null}, ${entry.targetId ?? null}, ${entry.summary.slice(0, 300)},
       ${tx.json(entry.detail ?? {})})`;
}

export type PendingEvent = {
  datastoreId: string;
  eventType: EventType;
  entityType: EntityType;
  entityId: string;
  revision: number;
};

/**
 * Insert a pending change event. The row's datastore must match the transaction's datastore
 * context (RLS WITH CHECK), so registry-level operations set it before emitting.
 */
export async function emit(tx: Tx, orgId: string, event: PendingEvent): Promise<void> {
  await tx`
    INSERT INTO records.outbox (event_id, org_id, datastore_id, event_type, entity_type, entity_id, revision)
    VALUES (${crypto.randomUUID()}, ${orgId}, ${event.datastoreId}, ${event.eventType}, ${event.entityType},
            ${event.entityId}, ${event.revision})`;
}

/** Switch the transaction's datastore context (registry operations spanning a new datastore). */
export async function useDatastore(tx: Tx, datastoreId: string): Promise<void> {
  await tx`SELECT set_config('records.datastore_id', ${datastoreId}, true)`;
}
