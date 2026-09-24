// Trusted issuers (canonical plan §5): the integrator loads `records.trusted_issuers` from Postgres
// and builds an IssuerRegistry. A bearer JWT is routed by its (unverified) `iss` to exactly one
// configured issuer, then verified strictly against that issuer's keys, audiences and algorithms.

import { createRemoteJWKSet, customFetch, jwtVerify, type FetchImplementation, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { TrustedIssuerSchema, type IssuerKind, type TrustedIssuer, type VerifiedIdentity } from "@records/contracts";
import { verifyDelegatedToken, type DelegatedIdentity } from "./delegated.js";
import { fromJoseError, refuse } from "./errors.js";
import { peek, tolerance, toDate } from "./jwt.js";
import type { ReplayGuard } from "./replay.js";

/** Asymmetric algorithms accepted from Access and Access for SaaS. HS* and `none` never are. */
export const OIDC_ALGORITHMS = ["RS256", "ES256"] as const;

/**
 * An OIDC identity, with how its subject was derived. For an Access **service token** there is no
 * user: `sub` is empty and the token carries `common_name` (the service token's client ID), which
 * becomes `subject` with `subjectType: "service_token"`. Map it through identity_mappings
 * (issuer, common_name) to a service principal.
 */
export type OidcIdentity = Extract<VerifiedIdentity, { kind: "oidc" }> & { subjectType: "user" | "service_token" };

/** VerifiedIdentity, with the OIDC arm refined. Assignable to VerifiedIdentity. */
export type VerifiedJwtIdentity = DelegatedIdentity | OidcIdentity;

export type IssuerRegistryOptions = {
  /** Required to accept delegated tokens; without it, delegated issuers refuse every token. */
  replay?: ReplayGuard;
  /** Fetch used for remote JWKS (tests, or a service binding). Defaults to global fetch. */
  fetch?: FetchImplementation;
  /** Key resolvers by issuer URL, overriding `jwksUrl` (tests, or a colocated minter). */
  keySets?: Record<string, JWTVerifyGetKey>;
  /** Clock skew allowance in seconds. Default 5, capped at 30. */
  clockToleranceSec?: number;
  /** Remote JWKS cache lifetime in ms (jose default 10 min). A removed kid verifies until this lapses. */
  jwksCacheMaxAgeMs?: number;
  /** Minimum ms between refetches triggered by an unknown kid (jose default 30 s). */
  jwksCooldownMs?: number;
  /** Remote JWKS fetch timeout in ms (jose default 5 s). */
  jwksTimeoutMs?: number;
};

export class IssuerRegistry {
  readonly #issuers = new Map<string, TrustedIssuer>();
  readonly #keySets = new Map<string, JWTVerifyGetKey>();
  readonly #options: IssuerRegistryOptions;

  constructor(issuers: readonly TrustedIssuer[], options: IssuerRegistryOptions = {}) {
    this.#options = options;
    for (const raw of issuers) {
      const issuer = TrustedIssuerSchema.parse(raw);
      if (this.#issuers.has(issuer.issuer)) throw new Error(`Duplicate trusted issuer: ${issuer.issuer}`);
      this.#issuers.set(issuer.issuer, issuer);
    }
  }

  get replay(): ReplayGuard | undefined {
    return this.#options.replay;
  }

  get clockToleranceSec(): number {
    return tolerance(this.#options.clockToleranceSec);
  }

  /** The enabled issuer for an exact `iss`, or undefined. */
  lookup(iss: string): TrustedIssuer | undefined {
    const issuer = this.#issuers.get(iss);
    return issuer?.enabled ? issuer : undefined;
  }

  /** The key resolver for an issuer; remote sets are created once and cached with jose's JWKS cache. */
  keySet(issuer: TrustedIssuer): JWTVerifyGetKey {
    const override = this.#options.keySets?.[issuer.issuer];
    if (override) return override;
    let set = this.#keySets.get(issuer.jwksUrl);
    if (!set) {
      const o = this.#options;
      set = createRemoteJWKSet(new URL(issuer.jwksUrl), {
        ...(o.jwksCacheMaxAgeMs !== undefined ? { cacheMaxAge: o.jwksCacheMaxAgeMs } : {}),
        ...(o.jwksCooldownMs !== undefined ? { cooldownDuration: o.jwksCooldownMs } : {}),
        ...(o.jwksTimeoutMs !== undefined ? { timeoutDuration: o.jwksTimeoutMs } : {}),
        ...(o.fetch ? { [customFetch]: o.fetch } : {}),
      });
      this.#keySets.set(issuer.jwksUrl, set);
    }
    return set;
  }
}

export type VerifyBearerJwtOptions = {
  /** Issuer kinds accepted at this entry point. Default: all kinds. */
  kinds?: readonly IssuerKind[];
  /** For delegated tokens: refuse (forbidden) a token for another datastore. */
  expectedDatastoreId?: string;
  now?: Date | number;
};

/** Verify a JWT from any trusted issuer. Throws an IdentityError on any refusal. */
export async function verifyBearerJwt(token: string, registry: IssuerRegistry, options: VerifyBearerJwtOptions = {}): Promise<VerifiedJwtIdentity> {
  const { payload } = peek(token);
  const iss = payload.iss;
  if (typeof iss !== "string" || iss.length === 0 || iss.length > 512) throw refuse("malformed");
  const issuer = registry.lookup(iss);
  if (!issuer) throw refuse("unknown_issuer");
  if (options.kinds && !options.kinds.includes(issuer.kind)) throw refuse("kind_not_allowed");

  if (issuer.kind === "delegated") {
    const replay = registry.replay;
    if (!replay) throw refuse("replay_unavailable");
    return verifyDelegatedToken(token, {
      issuer: issuer.issuer,
      keySet: registry.keySet(issuer),
      audience: issuer.audiences,
      clockToleranceSec: registry.clockToleranceSec,
      replay,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.expectedDatastoreId !== undefined ? { expectedDatastoreId: options.expectedDatastoreId } : {}),
    });
  }
  return verifyOidc(token, issuer, registry, options);
}

async function verifyOidc(token: string, issuer: TrustedIssuer, registry: IssuerRegistry, options: VerifyBearerJwtOptions): Promise<OidcIdentity> {
  const { header } = peek(token);
  if (typeof header.alg !== "string" || !(OIDC_ALGORITHMS as readonly string[]).includes(header.alg)) throw refuse("wrong_alg");
  if (header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) {
    throw refuse("malformed");
  }
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, registry.keySet(issuer), {
      algorithms: [...OIDC_ALGORITHMS],
      issuer: issuer.issuer,
      audience: issuer.audiences,
      clockTolerance: registry.clockToleranceSec,
      currentDate: toDate(options.now),
      requiredClaims: ["iss", "aud", "exp"],
    }));
  } catch (err) {
    throw fromJoseError(err);
  }

  const email = typeof payload["email"] === "string" && payload["email"].includes("@") && payload["email"].length <= 320 ? payload["email"] : undefined;
  const sub = typeof payload.sub === "string" && payload.sub.length > 0 && payload.sub.length <= 256 ? payload.sub : undefined;
  const commonName = payload["common_name"];

  if (sub) {
    return { kind: "oidc", issuer: issuer.issuer, subject: sub, ...(email ? { email } : {}), subjectType: "user" };
  }
  if (!email && typeof commonName === "string" && commonName.length > 0 && commonName.length <= 256) {
    return { kind: "oidc", issuer: issuer.issuer, subject: commonName, subjectType: "service_token" };
  }
  throw refuse("invalid_claims");
}
