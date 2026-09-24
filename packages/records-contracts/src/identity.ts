// Identity for the portable datastore service (canonical plan §5).
//
// Every accepted credential resolves to one principal through `records.identity_mappings
// (issuer, subject)`. The service trusts a configured list of issuers stored in Postgres
// (`records.trusted_issuers`); nothing else is accepted.

import { z } from "zod";

export const ISSUER_KINDS = [
  /** A JWT minted by the cloudflare-os Records gatekeeper after it redeems a viewer assertion. */
  "delegated",
  /** Cloudflare Access for SaaS acting as an OIDC provider, for UIs outside cloudflare-os. */
  "access_saas",
  /** `Cf-Access-Jwt-Assertion` from a path-specific Access application. */
  "access",
] as const;
export type IssuerKind = (typeof ISSUER_KINDS)[number];

export const TrustedIssuerSchema = z.object({
  issuer: z.string().url(),
  kind: z.enum(ISSUER_KINDS),
  /** Accepted `aud` values. */
  audiences: z.array(z.string().min(1)).min(1),
  /** JWKS location. For `delegated`, the gatekeeper's `/.well-known/jwks.json`. */
  jwksUrl: z.string().url(),
  enabled: z.boolean(),
});
export type TrustedIssuer = z.infer<typeof TrustedIssuerSchema>;

/** Lifetime of a delegated token. Short, because it is minted per gadget call. */
export const DELEGATED_TOKEN_TTL_SECONDS = 60;

/** Audience the datastore service expects on delegated tokens. */
export const DELEGATED_AUDIENCE = "records-datastore";

/**
 * Claims of a delegated token (RFC 8693 style `act`). `sub` is the viewer's principal and `act.sub`
 * the binding that narrowed it. `jti` is single-use.
 */
export const DelegatedClaimsSchema = z.object({
  iss: z.string().url(),
  sub: z.uuid(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number().int(),
  iat: z.number().int(),
  jti: z.string().min(16).max(64),
  /** Organisation the principal belongs to. */
  org: z.uuid(),
  /** Datastore the token is limited to. */
  ds: z.uuid(),
  /** Space-separated scopes of the binding. */
  scope: z.string(),
  act: z.object({ sub: z.uuid(), kind: z.literal("binding") }),
});
export type DelegatedClaims = z.infer<typeof DelegatedClaimsSchema>;

/** What any verified credential resolves to before the principal lookup. */
export type VerifiedIdentity =
  | { kind: "delegated"; issuer: string; principalId: string; orgId: string; datastoreId: string; bindingId: string; scopes: string[]; tokenId: string }
  | { kind: "oidc"; issuer: string; subject: string; email?: string }
  | { kind: "credential"; credentialToken: string };
