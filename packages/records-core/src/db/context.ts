// Transactions with trusted context. The only way domain code touches the database.
//
// Context is set with set_config(..., is_local = true) on the transaction's own pinned connection,
// so it ends with the transaction (commit or rollback) and never leaks to the next borrower of a
// pooled or Hyperdrive connection. Values are bound parameters; identifiers are never interpolated.
//
// Five settings, all read by RLS (migrations 0001 and 0004):
//   records.org_id        organisation
//   records.datastore_id  datastore ('' for organisation-level work)
//   records.principal_id  the principal whose rights apply ('' = none: module rows are invisible)
//   records.scopes        '*' = the principal acting directly as themself (no narrowing);
//                         otherwise the comma-separated scopes that narrow the role
//   records.binding_id    the binding or credential the call is made through, if any; the database
//                         intersects its stored scopes and refuses it once revoked
// Every value is validated before it is bound: a malformed identifier or scope is refused, never
// passed through.

import type { Sql, TransactionSql } from "postgres";

import { LIMITS, RecordsError, type CallerContext } from "@records/contracts";

export type Tx = TransactionSql<Record<string, unknown>>;
export type Db = Sql<Record<string, unknown>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE = /^[a-z]+\.[a-z_]+$/;

/** The records.scopes value meaning "no narrowing": the principal acts directly as themself. */
export const UNNARROWED_SCOPES = "*";

export type TxContext = {
  orgId: string;
  datastoreId?: string;
  /** Omitted only for pre-principal lookups; module rows are then invisible. */
  principalId?: string;
  /** `undefined` = no narrowing ('*'). An empty list narrows to nothing. */
  scopes?: readonly string[];
  bindingId?: string;
};

/** The transaction context for a caller, optionally on one datastore. */
export function contextOf(caller: CallerContext, datastoreId?: string): TxContext {
  return {
    orgId: caller.orgId,
    ...(datastoreId !== undefined ? { datastoreId } : {}),
    principalId: caller.principalId,
    ...(caller.scopes !== undefined ? { scopes: caller.scopes } : {}),
    ...(caller.bindingId !== undefined ? { bindingId: caller.bindingId } : {}),
  };
}

/** Serialization failures and deadlocks are retried; everything else propagates. */
const RETRYABLE = new Set(["40001", "40P01"]);
const UNIQUE_VIOLATION = "23505";

export function pgCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

function scopesSetting(scopes: readonly string[] | undefined): string {
  if (scopes === undefined) return UNNARROWED_SCOPES;
  for (const s of scopes) if (!SCOPE.test(s)) throw new RecordsError("forbidden", "This connection's scopes are not valid.");
  return [...new Set(scopes)].join(",");
}

export type TxOptions = {
  /** `repeatable read` gives every statement one snapshot (sync pull). Default: read committed. */
  isolation?: "read committed" | "repeatable read";
  readOnly?: boolean;
};

export async function withContext<T>(db: Db, ctx: TxContext, fn: (tx: Tx) => Promise<T>, attempts = 3, opts: TxOptions = {}): Promise<T> {
  if (!UUID.test(ctx.orgId) || (ctx.datastoreId !== undefined && !UUID.test(ctx.datastoreId))) {
    throw new RecordsError("not_found", "Unknown datastore.");
  }
  if ((ctx.principalId !== undefined && !UUID.test(ctx.principalId)) || (ctx.bindingId !== undefined && !UUID.test(ctx.bindingId))) {
    throw new RecordsError("forbidden", "This identity is not active.");
  }
  const scopes = scopesSetting(ctx.scopes);
  const mode = `isolation level ${opts.isolation ?? "read committed"}${opts.readOnly ? " read only" : ""}`;
  for (let attempt = 1; ; attempt++) {
    try {
      return (await db.begin(mode, async (tx) => {
        await tx`SELECT set_config('records.org_id', ${ctx.orgId}, true),
                        set_config('records.datastore_id', ${ctx.datastoreId ?? ""}, true),
                        set_config('records.principal_id', ${ctx.principalId ?? ""}, true),
                        set_config('records.scopes', ${scopes}, true),
                        set_config('records.binding_id', ${ctx.bindingId ?? ""}, true),
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
      // Privilege and row-level security failures are service bugs (authorize() should have
      // refused first); never tell the caller which table was involved.
      return new RecordsError("internal", "The service was not permitted to do that.");
    case "23000":
      // A journaling invariant (migration 0003) refused a write: a service bug, not caller error.
      return new RecordsError("internal", "The change could not be recorded.");
    case "08006":
    case "08001":
    case "57P01":
    case "53300":
      return new RecordsError("unavailable", "The database is unavailable. Retry shortly.");
    default:
      return err;
  }
}
