// Caller resolution: one credential per request, in a fixed precedence, to a VerifiedIdentity.
//
// Precedence (see parse.ts):
//   1. Authorization: Bearer <JWT>    delegated token or Access for SaaS token
//   2. Authorization: Bearer rk1_…    datastore credential
//      Authorization: Basic email:rk1_…  datastore credential (Jira clients)
//   3. Cf-Access-Jwt-Assertion        path-specific Access application (user or service token)
// A present but invalid Authorization header is refused; it never falls back to the Access header.
//
// This library is DB-free. The integrator then:
//   - delegated: checks the org/datastore/binding are still active and the principal is a member;
//   - oidc: maps (issuer, subject) through records.identity_mappings to a principal;
//   - credential: calls authenticateCredential(token) (digest, expiry, revocation, binding status).
// Those lookups can be injected as `lookup` to get one result type back from here.

import { RecordsError, type IssuerKind, type VerifiedIdentity } from "@records/contracts";
import { IdentityError, refuse, type RefusalReason } from "./errors.js";
import { verifyBearerJwt, type IssuerRegistry, type VerifiedJwtIdentity } from "./issuers.js";
import { parseAuthorization, type HeaderSource } from "./parse.js";

export type CredentialSource = "bearer_jwt" | "bearer_credential" | "basic" | "access";

export type ResolvedCaller = VerifiedJwtIdentity | Extract<VerifiedIdentity, { kind: "credential" }>;

export type ResolveResult<P = never> =
  | { ok: true; source: CredentialSource; identity: ResolvedCaller; basicEmail?: string; principal?: P }
  | { ok: false; error: RecordsError; reason: RefusalReason | "lookup_refused" };

export type ResolveCallerDeps<P = never> = {
  registry: IssuerRegistry;
  /** Refuse (forbidden) delegated tokens for another datastore. */
  expectedDatastoreId?: string;
  now?: Date | number;
  /** Issuer kinds accepted as `Authorization: Bearer <JWT>`. Default: delegated, access_saas. */
  bearerKinds?: readonly IssuerKind[];
  /** Issuer kinds accepted from `Cf-Access-Jwt-Assertion`. Default: access. */
  accessKinds?: readonly IssuerKind[];
  /**
   * Optional principal lookup (identity_mappings / authenticateCredential). Return null to refuse as
   * unauthenticated, or throw a RecordsError (e.g. forbidden) to refuse with that code.
   */
  lookup?: (identity: ResolvedCaller, source: CredentialSource) => Promise<P | null>;
};

const DEFAULT_BEARER_KINDS: readonly IssuerKind[] = ["delegated", "access_saas"];
const DEFAULT_ACCESS_KINDS: readonly IssuerKind[] = ["access"];

export async function resolveCaller<P = never>(headers: HeaderSource, deps: ResolveCallerDeps<P>): Promise<ResolveResult<P>> {
  const parsed = parseAuthorization(headers);
  let source: CredentialSource;
  let identity: ResolvedCaller;
  let basicEmail: string | undefined;
  try {
    const verifyOptions = {
      ...(deps.expectedDatastoreId !== undefined ? { expectedDatastoreId: deps.expectedDatastoreId } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    };
    switch (parsed.type) {
      case "none":
        throw refuse("missing");
      case "invalid":
        throw refuse("malformed");
      case "jwt":
        source = "bearer_jwt";
        identity = await verifyBearerJwt(parsed.token, deps.registry, { ...verifyOptions, kinds: deps.bearerKinds ?? DEFAULT_BEARER_KINDS });
        break;
      case "access":
        source = "access";
        identity = await verifyBearerJwt(parsed.token, deps.registry, { ...verifyOptions, kinds: deps.accessKinds ?? DEFAULT_ACCESS_KINDS });
        break;
      case "credential":
        source = "bearer_credential";
        identity = { kind: "credential", credentialToken: parsed.token };
        break;
      case "basic":
        source = "basic";
        identity = { kind: "credential", credentialToken: parsed.token };
        basicEmail = parsed.email;
        break;
    }
  } catch (err) {
    if (err instanceof IdentityError) return { ok: false, error: err, reason: err.reason };
    throw err;
  }

  const result = { ok: true as const, source, identity, ...(basicEmail !== undefined ? { basicEmail } : {}) };
  if (!deps.lookup) return result;
  try {
    const principal = await deps.lookup(identity, source);
    if (principal === null) return { ok: false, error: new RecordsError("unauthenticated", "The request is not authenticated."), reason: "lookup_refused" };
    return { ...result, principal };
  } catch (err) {
    if (err instanceof RecordsError) return { ok: false, error: err, reason: "lookup_refused" };
    throw err;
  }
}
