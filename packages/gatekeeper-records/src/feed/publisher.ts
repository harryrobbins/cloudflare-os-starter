// Outbox publisher (runs as the records_publisher role).
//
// Claim pending rows with a lease in one short statement (FOR UPDATE SKIP LOCKED, so concurrent
// publishers never claim the same row), publish outside any transaction, then mark the rows
// published only if this publisher still holds their lease. A crash between send and mark leaves
// the lease to expire, and the rows are sent again: consumers must tolerate duplicates.
//
// Rows are chosen by pending state, never by "sequence > cursor": a transaction that allocated an
// earlier ID but committed later is simply pending on the next run (decisions record §7).

import { ChangeEventSchema, type ChangeEvent } from "@records/contracts";

import type { Db } from "../db/context.js";

export type PublishOptions = { batch?: number; leaseSeconds?: number; maxAttempts?: number };
export type PublishResult = { claimed: number; published: number; failed: number };

export interface EventSink {
  sendBatch(messages: { body: ChangeEvent }[]): Promise<void>;
}

type OutboxRow = {
  event_id: string;
  org_id: string;
  datastore_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  revision: number;
  occurred_at: Date;
  attempts: number;
};

export function toEvent(row: OutboxRow): ChangeEvent {
  return ChangeEventSchema.parse({
    v: 1,
    eventId: row.event_id,
    orgId: row.org_id,
    datastoreId: row.datastore_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    revision: row.revision,
    occurredAt: row.occurred_at.toISOString(),
  });
}

/** Exponential backoff for failed publication: 5 s, 10 s, 20 s ... capped at 10 minutes. */
export function backoffSeconds(attempts: number): number {
  return Math.min(600, 5 * 2 ** Math.max(0, attempts - 1));
}

export async function publishPending(db: Db, sink: EventSink, opts: PublishOptions = {}): Promise<PublishResult> {
  const batch = opts.batch ?? 100;
  const leaseSeconds = opts.leaseSeconds ?? 60;
  const maxAttempts = opts.maxAttempts ?? 20;
  const owner = crypto.randomUUID();
  const rows = (await db`
    UPDATE records.outbox SET lease_owner = ${owner}, lease_until = now() + make_interval(secs => ${leaseSeconds}),
           attempts = attempts + 1
     WHERE event_id IN (
       SELECT event_id FROM records.outbox
        WHERE state = 'pending' AND available_at <= now() AND (lease_until IS NULL OR lease_until < now())
        ORDER BY available_at, occurred_at
        LIMIT ${batch}
        FOR UPDATE SKIP LOCKED)
    RETURNING event_id, org_id, datastore_id, event_type, entity_type, entity_id, revision, occurred_at, attempts`) as unknown as OutboxRow[];
  if (rows.length === 0) return { claimed: 0, published: 0, failed: 0 };
  const ids = rows.map((r) => r.event_id);
  try {
    // Queues accepts at most 100 messages per batch.
    for (let i = 0; i < rows.length; i += 100) {
      await sink.sendBatch(rows.slice(i, i + 100).map((row) => ({ body: toEvent(row) })));
    }
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const attempts = Math.max(...rows.map((r) => r.attempts));
    await db`
      UPDATE records.outbox SET lease_owner = NULL, lease_until = NULL, last_error = ${message},
             available_at = now() + make_interval(secs => ${backoffSeconds(attempts)}),
             state = CASE WHEN attempts >= ${maxAttempts} THEN 'dead' ELSE 'pending' END
       WHERE event_id = ANY(${ids}) AND lease_owner = ${owner}`;
    return { claimed: rows.length, published: 0, failed: rows.length };
  }
  const marked = await db`
    UPDATE records.outbox SET state = 'published', published_at = now(), lease_owner = NULL, lease_until = NULL, last_error = NULL
     WHERE event_id = ANY(${ids}) AND lease_owner = ${owner}`;
  return { claimed: rows.length, published: marked.count, failed: 0 };
}

/** Delete published rows past the replay window, and expired idempotency outcomes. */
export async function pruneDelivered(db: Db, retentionDays = 7): Promise<{ outbox: number; idempotency: number }> {
  const outbox = await db`
    DELETE FROM records.outbox WHERE state = 'published' AND published_at < now() - make_interval(days => ${retentionDays})`;
  const idempotency = await db`DELETE FROM records.idempotency_keys WHERE created_at < now() - interval '7 days'`;
  return { outbox: outbox.count, idempotency: idempotency.count };
}

/** Oldest pending event age in seconds, for the outbox-age metric. */
export async function outboxLag(db: Db): Promise<{ pending: number; oldestSeconds: number; dead: number }> {
  const [row] = await db`
    SELECT count(*) FILTER (WHERE state = 'pending')::int AS pending,
           coalesce(extract(epoch FROM now() - min(occurred_at) FILTER (WHERE state = 'pending')), 0)::float AS oldest,
           count(*) FILTER (WHERE state = 'dead')::int AS dead
      FROM records.outbox WHERE state IN ('pending', 'dead')`;
  return { pending: row!.pending as number, oldestSeconds: row!.oldest as number, dead: row!.dead as number };
}
