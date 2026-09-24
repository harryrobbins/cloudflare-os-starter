// Delegated tokens: minted by the cloudflare-os Records gatekeeper after it redeems a viewer
// assertion, verified by the datastore service (canonical plan §5).
//
//   header  { alg: "ES256", typ: "records-delegated+jwt", kid: <RFC 7638 thumbprint> }
//   payload DelegatedClaims: iss, sub (principal), aud, iat, exp = iat + 60, jti (single use),
//           org, ds (datastore), scope (space-separated), act { sub: binding, kind: "binding" }

import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";
import {
  DELEGATED_AUDIENCE,
  DELEGATED_TOKEN_TTL_SECONDS,
  DelegatedClaimsSchema,
  type DelegatedClaims,
  type VerifiedIdentity,
} from "@records/contracts";
import { fromJoseError, refuse } from "./errors.js";
import { peek, tolerance, toDate } from "./jwt.js";
import type { ReplayGuard } from "./replay.js";

export const DELEGATED_ALG = "ES256";
/** Explicit type (RFC 8725 §3.11) so a delegated token cannot be confused with an ID or access token. */
export const DELEGATED_TYP = "records-delegated+jwt";

/** A P-256 private JWK as stored in the gatekeeper's secret. */
export type PrivateSigningJwk = JWK & { kty: "EC"; crv: "P-256"; d: string; x: string; y: string; kid: string; alg: "ES256" };
/** A P-256 public JWK as published in the JWKS. */
export type PublicSigningJwk = { kty: "EC"; crv: "P-256"; x: string; y: string; kid: string; alg: "ES256"; use: "sig" };

export type SigningKey = { kid: string; privateKey: CryptoKey; publicJwk: PublicSigningJwk };

const PrivateJwkSchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  d: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  kid: z.string().min(1).max(128),
  alg: z.literal(DELEGATED_ALG).optional(),
});

const PublicJwkSchema = PrivateJwkSchema.omit({ d: true });

/** Generate a new ES256 signing key as a private JWK (with `kid`), for an operator script. */
export async function generateSigningKey(): Promise<PrivateSigningJwk> {
  const { privateKey } = await generateKeyPair(DELEGATED_ALG, { extractable: true });
  const jwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint({ kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! });
  return { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y!, d: jwk.d!, kid, alg: DELEGATED_ALG };
}

/** Import a private JWK (object or JSON text, e.g. from a Worker secret). */
export async function importSigningKey(jwk: string | PrivateSigningJwk | Record<string, unknown>): Promise<SigningKey> {
  let raw: unknown = jwk;
  if (typeof jwk === "string") {
    try {
      raw = JSON.parse(jwk);
    } catch {
      throw new Error("Signing key is not valid JSON.");
    }
  }
  const parsed = PrivateJwkSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Signing key must be an EC P-256 private JWK with a kid.");
  const { kty, crv, x, y, d, kid } = parsed.data;
  const privateKey = (await importJWK({ kty, crv, x, y, d }, DELEGATED_ALG, { extractable: false })) as CryptoKey;
  return { kid, privateKey, publicJwk: { kty, crv, x, y, kid, alg: DELEGATED_ALG, use: "sig" } };
}

/**
 * The JWKS document for `/gatekeeper/records/.well-known/jwks.json`. Pass the current key first and
 * any previous keys still inside their rotation window. Private material is never included.
 */
export function publicJwks(keys: ReadonlyArray<SigningKey | PublicSigningJwk | PrivateSigningJwk>): { keys: PublicSigningJwk[] } {
  const out: PublicSigningJwk[] = [];
  const kids = new Set<string>();
  for (const key of keys) {
    const source = "publicJwk" in key ? key.publicJwk : key;
    const parsed = PublicJwkSchema.safeParse(source);
    if (!parsed.success) throw new Error("JWKS entries must be EC P-256 keys with a kid.");
    const { kty, crv, x, y, kid } = parsed.data;
    if (kids.has(kid)) throw new Error(`Duplicate kid in JWKS: ${kid}`);
    kids.add(kid);
    out.push({ kty, crv, x, y, kid, alg: DELEGATED_ALG, use: "sig" });
  }
  return { keys: out };
}

/** A key resolver over a JWKS document already in hand (tests, or a verifier colocated with the minter). */
export function localKeySet(jwks: JSONWebKeySet | { keys: PublicSigningJwk[] }): JWTVerifyGetKey {
  return createLocalJWKSet(jwks as JSONWebKeySet);
}

const MintInputSchema = z.object({
  issuer: z.string().url(),
  principalId: z.uuid(),
  orgId: z.uuid(),
  datastoreId: z.uuid(),
  bindingId: z.uuid(),
  scopes: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/)).max(64),
});

export type MintDelegatedTokenInput = {
  issuer: string;
  principalId: string;
  orgId: string;
  datastoreId: string;
  bindingId: string;
  scopes: readonly string[];
  /** Defaults to the current time. */
  now?: Date | number;
};

function randomJti(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Mint a 60-second delegated token. */
export async function mintDelegatedToken(key: SigningKey, input: MintDelegatedTokenInput): Promise<string> {
  const { issuer, principalId, orgId, datastoreId, bindingId, scopes } = MintInputSchema.parse({ ...input, scopes: [...input.scopes] });
  const iat = Math.floor(toDate(input.now).getTime() / 1000);
  const claims: DelegatedClaims = {
    iss: issuer,
    sub: principalId,
    aud: DELEGATED_AUDIENCE,
    iat,
    exp: iat + DELEGATED_TOKEN_TTL_SECONDS,
    jti: randomJti(),
    org: orgId,
    ds: datastoreId,
    scope: [...new Set(scopes)].join(" "),
    act: { sub: bindingId, kind: "binding" },
  };
  DelegatedClaimsSchema.parse(claims);
  return new SignJWT(claims).setProtectedHeader({ alg: DELEGATED_ALG, typ: DELEGATED_TYP, kid: key.kid }).sign(key.privateKey);
}

export type VerifyDelegatedTokenOptions = {
  /** The gatekeeper's issuer URL (exact match). */
  issuer: string;
  /** Key resolver: `localKeySet(...)` or a remote JWKS from `IssuerRegistry`. */
  keySet: JWTVerifyGetKey;
  /** Accepted audiences. Defaults to DELEGATED_AUDIENCE. */
  audience?: string | string[];
  now?: Date | number;
  /** Clock skew allowance in seconds. Default 5, capped at 30. */
  clockToleranceSec?: number;
  /** Single-use enforcement; claimed only after every other check passes. */
  replay: ReplayGuard;
  /** When set, a token for any other datastore is refused as `forbidden`. */
  expectedDatastoreId?: string;
};

export type DelegatedIdentity = Extract<VerifiedIdentity, { kind: "delegated" }>;

/** Verify a delegated token. Throws an IdentityError on any refusal. */
export async function verifyDelegatedToken(token: string, options: VerifyDelegatedTokenOptions): Promise<DelegatedIdentity> {
  const { header } = peek(token);
  if (header.alg !== DELEGATED_ALG) throw refuse("wrong_alg");
  if (header.typ !== DELEGATED_TYP) throw refuse("wrong_typ");
  if (typeof header.kid !== "string" || header.kid.length === 0 || header.kid.length > 128) throw refuse("malformed");
  if (header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined || header.x5u !== undefined) {
    throw refuse("malformed");
  }

  const skew = tolerance(options.clockToleranceSec);
  const currentDate = toDate(options.now);
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(token, options.keySet, {
      algorithms: [DELEGATED_ALG],
      typ: DELEGATED_TYP,
      issuer: options.issuer,
      audience: options.audience ?? DELEGATED_AUDIENCE,
      clockTolerance: skew,
      currentDate,
      requiredClaims: ["iss", "sub", "aud", "exp", "iat", "jti"],
    }));
  } catch (err) {
    throw fromJoseError(err);
  }

  const parsed = DelegatedClaimsSchema.safeParse(payload);
  if (!parsed.success) throw refuse("invalid_claims");
  const claims = parsed.data;

  const nowSec = currentDate.getTime() / 1000;
  if (claims.iat > nowSec + skew) throw refuse("not_yet_valid");
  if (claims.exp - claims.iat > DELEGATED_TOKEN_TTL_SECONDS + skew) throw refuse("ttl_too_long");
  if (claims.exp <= claims.iat) throw refuse("invalid_claims");

  const scopes = claims.scope.split(" ").filter((s) => s.length > 0);
  if (claims.scope.length > 4096 || scopes.length > 64 || scopes.some((s) => !/^[A-Za-z0-9_.:-]{1,100}$/.test(s))) {
    throw refuse("invalid_claims");
  }

  if (options.expectedDatastoreId !== undefined && claims.ds !== options.expectedDatastoreId) throw refuse("datastore_mismatch");

  let claimed: boolean;
  try {
    claimed = await options.replay.claim(claims.jti, claims.exp);
  } catch {
    throw refuse("replay_unavailable"); // The guard is unreachable: fail closed.
  }
  if (claimed !== true) throw refuse("replayed");

  return {
    kind: "delegated",
    issuer: claims.iss,
    principalId: claims.sub,
    orgId: claims.org,
    datastoreId: claims.ds,
    bindingId: claims.act.sub,
    scopes,
    tokenId: claims.jti,
  };
}
