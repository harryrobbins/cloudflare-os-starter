// Idempotent mutations. Keys are scoped by (organisation, datastore, principal, operation); the
// stored request digest and outcome commit atomically with the mutation. Same key + same request
// replays the stored outcome (after the caller has been re-authorised); same key + different
// request is a conflict. Saved outcomes are kept for 7 days (publisher maintenance prunes them).

import { RecordsError, requestDigest, type CallerContext } from "@records/contracts";

import type { Tx } from "../db/context.js";

export const IDEMPOTENCY_RETENTION_DAYS = 7;

export type Idempotent<T> = { record: T; replayed: boolean };

export async function idempotent<T>(
  tx: Tx,
  caller: CallerContext,
  datastoreId: string,
  operation: string,
  key: string,
  input: unknown,
  apply: () => Promise<T>,
): Promise<Idempotent<T>> {
  const digest = await requestDigest(operation, input);
  const [existing] = await tx`
    SELECT request_digest, outcome FROM records.idempotency_keys
     WHERE org_id = ${caller.orgId} AND datastore_id = ${datastoreId} AND principal_id = ${caller.principalId}
       AND operation = ${operation} AND key = ${key}
       AND created_at > now() - make_interval(days => ${IDEMPOTENCY_RETENTION_DAYS})`;
  if (existing) {
    if (existing.request_digest !== digest) {
      throw new RecordsError("idempotency_conflict", "This idempotency key was already used for a different request.");
    }
    return { record: existing.outcome as T, replayed: true };
  }
  const record = await apply();
  // A concurrent duplicate that commits first makes this insert fail; withContext retries the
  // whole transaction, which then takes the replay branch above.
  await tx`
    INSERT INTO records.idempotency_keys (org_id, datastore_id, principal_id, operation, key, request_digest, outcome)
    VALUES (${caller.orgId}, ${datastoreId}, ${caller.principalId}, ${operation}, ${key}, ${digest}, ${tx.json(record as never)})`;
  return { record, replayed: false };
}
