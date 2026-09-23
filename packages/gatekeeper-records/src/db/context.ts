// Transactions with trusted context. The only way domain code touches the database.
//
// Context is set with set_config(..., is_local = true) on the transaction's own pinned connection,
// so it ends with the transaction (commit or rollback) and never leaks to the next borrower of a
// pooled or Hyperdrive connection. Values are bound parameters; identifiers are never interpolated.

import type { Sql, TransactionSql } from "postgres";

import { LIMITS, RecordsError } from "@records/contracts";

export type Tx = TransactionSql<Record<string, unknown>>;
export type Db = Sql<Record<string, unknown>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TxContext = { orgId: string; datastoreId?: string };

/** Serialization failures and deadlocks are retried; everything else propagates. */
const RETRYABLE = new Set(["40001", "40P01"]);
const UNIQUE_VIOLATION = "23505";

export function pgCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

export async function withContext<T>(db: Db, ctx: TxContext, fn: (tx: Tx) => Promise<T>, attempts = 3): Promise<T> {
  if (!UUID.test(ctx.orgId) || (ctx.datastoreId !== undefined && !UUID.test(ctx.datastoreId))) {
    throw new RecordsError("not_found", "Unknown datastore.");
  }
  for (let attempt = 1; ; attempt++) {
    try {
      return (await db.begin(async (tx) => {
        await tx`SELECT set_config('records.org_id', ${ctx.orgId}, true),
                        set_config('records.datastore_id', ${ctx.datastoreId ?? ""}, true),
                        set_config('statement_timeout', ${String(LIMITS.statementTimeoutMs)}, true)`;
        return fn(tx);
      })) as T;
    } catch (err) {
      const code = pgCode(err);
      // A unique violation on the idempotency key means a concurrent duplicate committed first;
      // the retry then replays its stored outcome.
      if (attempt < attempts && (RETRYABLE.has(code ?? "") || (code === UNIQUE_VIOLATION && isIdempotencyRace(err)))) continue;
      throw translate(err);
    }
  }
}

function isIdempotencyRace(err: unknown): boolean {
  return (err as { constraint_name?: string }).constraint_name === "idempotency_keys_pkey";
}

/** Map database errors to stable contract errors without leaking SQL details. */
export function translate(err: unknown): unknown {
  if (err instanceof RecordsError) return err;
  switch (pgCode(err)) {
    case "57014":
      return new RecordsError("unavailable", "The query took too long.");
    case "23505":
      return new RecordsError("duplicate", "That already exists.");
    case "23503":
      return new RecordsError("validation_failed", "A referenced record does not exist in this datastore.");
    case "23514":
    case "22P02":
      return new RecordsError("validation_failed", "A value was out of range.");
    case "42501":
      // Privilege failures are service bugs; never tell the caller which table was involved.
      return new RecordsError("internal", "The service was not permitted to do that.");
    case "08006":
    case "08001":
    case "57P01":
    case "53300":
      return new RecordsError("unavailable", "The database is unavailable. Retry shortly.");
    default:
      return err;
  }
}
