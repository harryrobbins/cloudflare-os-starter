// Refusals. Every failure is a RecordsError, so both transports map it without extra code:
// `unauthenticated` (401) when the credential is missing, malformed or not valid;
// `forbidden` (403) when it is valid but not for this datastore; `unavailable` (503) when a trusted
// issuer's key set cannot be fetched. `reason` is for logs and tests; the detail sent to the
// caller stays generic so a refusal does not teach an attacker which check failed.

import { RecordsError, type ErrorCode } from "@records/contracts";
import { errors } from "jose";

export const REFUSAL_REASONS = [
  "missing",
  "malformed",
  "unknown_issuer",
  "kind_not_allowed",
  "wrong_alg",
  "wrong_typ",
  "no_matching_key",
  "bad_signature",
  "wrong_issuer",
  "wrong_audience",
  "expired",
  "not_yet_valid",
  "ttl_too_long",
  "invalid_claims",
  "replayed",
  "datastore_mismatch",
  "jwks_unavailable",
  "replay_unavailable",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

const CODE: Record<RefusalReason, ErrorCode> = {
  missing: "unauthenticated",
  malformed: "unauthenticated",
  unknown_issuer: "unauthenticated",
  kind_not_allowed: "unauthenticated",
  wrong_alg: "unauthenticated",
  wrong_typ: "unauthenticated",
  no_matching_key: "unauthenticated",
  bad_signature: "unauthenticated",
  wrong_issuer: "unauthenticated",
  wrong_audience: "unauthenticated",
  expired: "unauthenticated",
  not_yet_valid: "unauthenticated",
  ttl_too_long: "unauthenticated",
  invalid_claims: "unauthenticated",
  replayed: "unauthenticated",
  datastore_mismatch: "forbidden",
  jwks_unavailable: "unavailable",
  replay_unavailable: "unavailable",
};

const DETAIL: Record<ErrorCode, string> = {
  unauthenticated: "The request is not authenticated.",
  forbidden: "The credential is not valid for this datastore.",
  unavailable: "Identity verification is temporarily unavailable.",
} as Record<ErrorCode, string>;

/** A refused credential. `reason` is diagnostic only; never echo it to the caller. */
export class IdentityError extends RecordsError {
  readonly reason: RefusalReason;

  constructor(reason: RefusalReason) {
    const code = CODE[reason];
    super(code, DETAIL[code] ?? "The credential was refused.");
    this.reason = reason;
  }
}

export const refuse = (reason: RefusalReason): IdentityError => new IdentityError(reason);

/** Map a jose failure to a refusal. Non-jose errors come from fetching a remote key set. */
export function fromJoseError(err: unknown): IdentityError {
  if (err instanceof IdentityError) return err;
  if (err instanceof errors.JWTExpired) return refuse("expired");
  if (err instanceof errors.JWTClaimValidationFailed) {
    switch (err.claim) {
      case "iss":
        return refuse("wrong_issuer");
      case "aud":
        return refuse("wrong_audience");
      case "nbf":
      case "iat":
        return refuse(err.reason === "check_failed" ? "not_yet_valid" : "invalid_claims");
      case "typ":
        return refuse("wrong_typ");
      default:
        return refuse("invalid_claims");
    }
  }
  if (err instanceof errors.JOSEAlgNotAllowed || err instanceof errors.JOSENotSupported) return refuse("wrong_alg");
  if (err instanceof errors.JWSSignatureVerificationFailed) return refuse("bad_signature");
  if (err instanceof errors.JWKSNoMatchingKey || err instanceof errors.JWKSMultipleMatchingKeys) return refuse("no_matching_key");
  if (err instanceof errors.JWKSTimeout || err instanceof errors.JWKSInvalid) return refuse("jwks_unavailable");
  if (err instanceof errors.JOSEError) return refuse("malformed");
  return refuse("jwks_unavailable");
}
