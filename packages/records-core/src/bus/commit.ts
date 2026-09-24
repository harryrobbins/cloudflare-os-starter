// The tail of every journaled write (canonical plan §4, steps 5-6), inside the caller's transaction:
//
//   1. audit event and outbox rows, as before the journal existed (the Queue feed keeps working).
//      Neither needs the seq, and neither takes a contended lock, so they go before the clock and
//      do not lengthen the time it is held (the Phase 0 spike showed hold time bounds throughput).
//   2. take the datastore clock LAST: `UPDATE … SET seq = seq + 1 RETURNING seq`. Every lock a
//      handler needs (memberships, bindings, the rows it changes) is already held, so lock order is
//      the same in every transaction and the clock row is held only for the final inserts and the
//      commit. Its row lock serialises commits within one datastore: seq is gapless and in commit
//      order, and a rollback returns the value.
//   3. write the current rows with last_seq = seq (the handler's `write`),
//   4. insert the journal entries (one statement; ordinal = position in the plan).
//
// The journal-presence trigger then checks at COMMIT that every row written in step 3 names an
// entry inserted in step 4.

import { RecordsError, type CallerContext, type JournalEntityType, type JournalOp, type JournalVia } from "@records/contracts";

import type { Tx } from "../db/context.js";
import { audit, emit, type AuditEntry, type PendingEvent } from "../domain/journal.js";
import { uuidv7 } from "./uuidv7.js";

/** One journal entry a handler intends to write. `after`/`before` use wire (DTO) field names. */
export type PlannedChange = {
  entityType: JournalEntityType;
  entityId: string;
  entityRev: number;
  op: JournalOp;
  after: Record<string, unknown>;
  before: Record<string, unknown> | null;
};

/**
 * What a module handler produces after its reads, locks and rules: the journal entries, the audit
 * and outbox records, and a `write` that applies the current-row changes once the seq is known.
 */
export type Plan<T> = {
  changes: PlannedChange[];
  audit: Omit<AuditEntry, "datastoreId"> | null;
  events: Omit<PendingEvent, "datastoreId">[];
  write(seq: number): Promise<T>;
};

export type CommitMeta = { command: string; commandId: string; via: JournalVia };

/** Test and benchmark instrumentation. Never used in production paths. */
export type BusHooks = {
  /** Called while the clock row is held, before any current row is written. */
  afterClock?: (datastoreId: string, seq: number) => Promise<void>;
};

export async function commitPlan<T>(
  tx: Tx,
  caller: CallerContext,
  datastoreId: string,
  meta: CommitMeta,
  plan: Plan<T>,
  hooks: BusHooks = {},
): Promise<{ seq: number; result: T }> {
  if (plan.changes.length === 0) throw new RecordsError("internal", "A command produced no journal entries.");
  if (plan.audit) await audit(tx, caller, { ...plan.audit, datastoreId });
  for (const event of plan.events) await emit(tx, caller.orgId, { ...event, datastoreId });

  const [clock] = await tx`
    UPDATE records.datastore_clock SET seq = seq + 1 WHERE datastore_id = ${datastoreId} RETURNING seq`;
  if (!clock) throw new RecordsError("not_found", "Unknown datastore.");
  const seq = Number(clock.seq);
  await hooks.afterClock?.(datastoreId, seq);

  const result = await plan.write(seq);

  const rows = plan.changes.map((c, ordinal) => ({
    ordinal,
    change_id: uuidv7(),
    entity_type: c.entityType,
    entity_id: c.entityId,
    entity_rev: c.entityRev,
    op: c.op,
    after: c.after,
    before: c.before,
  }));
  await tx`
    INSERT INTO records.journal (org_id, datastore_id, seq, ordinal, change_id, command, command_id, entity_type, entity_id,
                                 entity_rev, op, after, before, actor_id, act_id, via)
    SELECT ${caller.orgId}, ${datastoreId}, ${seq}, e.ordinal, e.change_id, ${meta.command}, ${meta.commandId}, e.entity_type,
           e.entity_id, e.entity_rev, e.op, e.after, e.before, ${caller.principalId}, ${caller.bindingId ?? null}, ${meta.via}
      FROM jsonb_to_recordset(${tx.json(rows as never)}) AS e(ordinal smallint, change_id uuid, entity_type text, entity_id uuid,
                                                              entity_rev int, op text, after jsonb, before jsonb)`;

  return { seq, result };
}
