// Idempotent mutations. Keys are scoped by (organisation, datastore, principal, operation); the
// stored request digest and outcome commit atomically with the mutation. Same key + same request
// replays the stored outcome (after the caller has been re-authorised); same key + different
// request is a conflict. Saved outcomes are kept for 7 days (publisher maintenance prunes them).

import { RecordsError, requestDigest, type CallerContext } from "@records/contracts";

import type { Tx } from "../db/context.js";

export const IDEMPOTENCY_RETENTION_DAYS = 7;

/** A mutation's result. `seq` is the datastore clock value it committed at (journaled writes). */
export type Idempotent<T> = { record: T; replayed: boolean; seq?: number };

export type IdempotencyScope = { datastoreId: string; operation: string; key: string };

/**
 * The saved outcome for this key, or null when the key is unused. Throws idempotency_conflict when
 * the key was used for a different request.
 */
export async function findSaved(tx: Tx, caller: CallerContext, scope: IdempotencyScope, input: unknown): Promise<{ outcome: unknown; digest: string } | { outcome: null; digest: string }> {
  const digest = await requestDigest(scope.operation, input);
  const [existing] = await tx`
    SELECT request_digest, outcome FROM records.idempotency_keys
     WHERE org_id = ${caller.orgId} AND datastore_id = ${scope.datastoreId} AND principal_id = ${caller.principalId}
       AND operation = ${scope.operation} AND key = ${scope.key}
       AND created_at > now() - make_interval(days => ${IDEMPOTENCY_RETENTION_DAYS})`;
  if (!existing) return { outcome: null, digest };
  if (existing.request_digest !== digest) {
    throw new RecordsError("idempotency_conflict", "This idempotency key was already used for a different request.");
  }
  return { outcome: existing.outcome, digest };
}

/**
 * Save an outcome. A concurrent duplicate that commits first makes this insert fail; withContext
 * retries the whole transaction, which then takes the replay branch.
 */
export async function saveOutcome(tx: Tx, caller: CallerContext, scope: IdempotencyScope, digest: string, outcome: unknown): Promise<void> {
  await tx`
    INSERT INTO records.idempotency_keys (org_id, datastore_id, principal_id, operation, key, request_digest, outcome)
    VALUES (${caller.orgId}, ${scope.datastoreId}, ${caller.principalId}, ${scope.operation}, ${scope.key}, ${digest},
            ${tx.json(outcome as never)})`;
}

/** Run `apply` once per key: the generic form, for mutations outside the command bus. */
export async function idempotent<T>(
  tx: Tx,
  caller: CallerContext,
  datastoreId: string,
  operation: string,
  key: string,
  input: unknown,
  apply: () => Promise<T>,
): Promise<Idempotent<T>> {
  const scope = { datastoreId, operation, key };
  const saved = await findSaved(tx, caller, scope, input);
  if (saved.outcome !== null) return { record: saved.outcome as T, replayed: true };
  const record = await apply();
  await saveOutcome(tx, caller, scope, saved.digest, record);
  return { record, replayed: false };
}
