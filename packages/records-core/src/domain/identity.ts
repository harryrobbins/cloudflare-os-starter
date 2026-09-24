// Identity lookups for the service boundary (canonical plan §5). Credential *verification* (JWT
// signatures, issuers, parsing) lives in @records/identity, which is database-free; this module is
// the database half: the shared replay guard, the trusted-issuer table, and turning a verified
// delegated grant or credential into a CallerContext against fresh state.

import { ISSUER_KINDS, RecordsError, type CallerContext, type IssuerKind } from "@records/contracts";

import { contextOf, withContext, type Db } from "../db/context.js";
import { normaliseEmail } from "./registry.js";

/**
 * Single-use `jti` enforcement shared by every isolate (migration 0007). Structurally a
 * @records/identity `ReplayGuard`. Any database failure propagates, and the verifier then fails
 * closed.
 */
export class PostgresReplayGuard {
  constructor(private readonly db: Db) {}

  async claim(jti: string, expiresAt: number): Promise<boolean> {
    const [row] = await this.db`SELECT records.claim_delegated_token(${jti}, to_timestamp(${expiresAt})) AS claimed`;
    return row?.claimed === true;
  }
}

/**
 * Delete replay-guard rows that expired more than five minutes ago. Runs as the publisher role
 * (records.prune_delegated_token_uses); returns the number removed.
 */
export async function pruneDelegatedTokenUses(publisherDb: Db): Promise<number> {
  const [row] = await publisherDb`SELECT records.prune_delegated_token_uses() AS pruned`;
  return Number(row?.pruned ?? 0);
}

/** A `records.trusted_issuers` row in the @records/contracts `TrustedIssuer` shape. */
export type TrustedIssuerRow = { issuer: string; kind: IssuerKind; audiences: string[]; jwksUrl: string; enabled: boolean };

/** The enabled trusted issuers. Service configuration: readable without a tenant context. */
export async function loadTrustedIssuers(db: Db): Promise<TrustedIssuerRow[]> {
  const rows = await db`
    SELECT issuer, kind, audiences, jwks_url, enabled FROM records.trusted_issuers WHERE enabled ORDER BY issuer`;
  return rows
    .filter((r) => (ISSUER_KINDS as readonly string[]).includes(r.kind as string))
    .map((r) => ({
      issuer: r.issuer as string,
      kind: r.kind as IssuerKind,
      audiences: r.audiences as string[],
      jwksUrl: r.jwks_url as string,
      enabled: r.enabled as boolean,
    }));
}

/** The verified claims of a delegated token, as far as authority goes. */
export type DelegatedGrant = { orgId: string; principalId: string; datastoreId: string; bindingId: string; scopes: readonly string[] };

/**
 * The caller a verified delegated token acts as. Checked against fresh state: the binding exists in
 * the token's organisation, is an active gadget binding for the token's datastore, and holds every
 * scope the token claims; the principal is active in that organisation. Membership and the
 * operation's permission are then checked by the domain operation itself (authorize), and RLS
 * checks the binding once more.
 */
export async function resolveDelegatedCaller(db: Db, grant: DelegatedGrant): Promise<CallerContext> {
  return withContext(db, { orgId: grant.orgId }, async (tx) => {
    const [b] = await tx`
      SELECT status, kind, datastore_id, scopes FROM records.bindings WHERE id = ${grant.bindingId}`;
    if (!b || b.status !== "active" || b.kind !== "gadget" || b.datastore_id !== grant.datastoreId) {
      throw new RecordsError("forbidden", "This connection has been revoked.");
    }
    const stored = b.scopes as string[];
    if (grant.scopes.some((s) => !stored.includes(s))) throw new RecordsError("forbidden", "This connection does not hold those scopes.");
    const [p] = await tx`SELECT status, expires_at FROM records.principals WHERE id = ${grant.principalId}`;
    if (!p || p.status !== "active" || (p.expires_at && (p.expires_at as Date) <= new Date())) {
      throw new RecordsError("forbidden", "This identity is not active.");
    }
    return { orgId: grant.orgId, principalId: grant.principalId, via: "gadget", bindingId: grant.bindingId, scopes: [...grant.scopes] };
  });
}

/** The e-mail of the person who owns the credential behind `caller.bindingId`, or null. */
export async function credentialOwnerEmail(db: Db, caller: CallerContext, datastoreId: string): Promise<string | null> {
  if (!caller.bindingId) return null;
  return withContext(db, contextOf(caller, datastoreId), async (tx) => {
    const [row] = await tx`
      SELECT o.email FROM records.credentials c JOIN records.principals o ON o.id = c.owner_principal_id
       WHERE c.binding_id = ${caller.bindingId!}`;
    return (row?.email as string | null | undefined) ?? null;
  });
}

/**
 * HTTP Basic `email:rk1_…`: the e-mail must equal (trimmed, case-insensitive) the e-mail of the
 * credential's owner. An owner without an e-mail cannot use Basic.
 */
export async function basicUserMatches(db: Db, caller: CallerContext, datastoreId: string, email: string): Promise<boolean> {
  const owner = await credentialOwnerEmail(db, caller, datastoreId);
  return !!owner && normaliseEmail(owner) === normaliseEmail(email);
}
