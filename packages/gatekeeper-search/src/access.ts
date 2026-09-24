// Cloudflare Access assertion verification, copied from packages/gatekeeper-chat/src/access.ts:
// verify `cf-access-jwt-assertion` against the team's JWKS with `jose`, pinned to the configured
// issuer and audience, and treat any failure as "no identity". The JWKS set is cached per issuer for
// the isolate's lifetime; `createRemoteJWKSet` handles its own key rotation.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import type { Principal } from "./shared/contract.js";

export type CfAccessEnv = Readonly<{
  CF_ACCESS_ISS?: string;
  CF_ACCESS_AUD?: string;
}>;

export type AccessTokenVerifier = (token: string, env: CfAccessEnv) => Promise<JWTPayload>;

/** Who is asking, once Access has vouched for them. */
export interface SearchIdentity {
  /** The Access `sub`: the principal every ACL row names. */
  readonly id: Principal;
  /** Lowercased. Used for the admin check only, never as a key. */
  readonly email: string;
}

const remoteJwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyAccessToken(token: string, env: CfAccessEnv): Promise<JWTPayload> {
  if (!env.CF_ACCESS_ISS || !env.CF_ACCESS_AUD) {
    throw new Error("Cloudflare Access issuer and audience must both be configured.");
  }
  let jwks = remoteJwkSets.get(env.CF_ACCESS_ISS);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${env.CF_ACCESS_ISS}/cdn-cgi/access/certs`));
    remoteJwkSets.set(env.CF_ACCESS_ISS, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer: env.CF_ACCESS_ISS,
    audience: env.CF_ACCESS_AUD,
  });
  return payload;
}

/** Verified Access claims, or null when the assertion is absent or cannot be trusted. */
export async function verifyCfAccessJwt(
  request: Request,
  env: CfAccessEnv,
  verifier: AccessTokenVerifier = verifyAccessToken,
): Promise<JWTPayload | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  try {
    return await verifier(token, env);
  } catch {
    return null;
  }
}

/**
 * The principal is `sub`: it survives an email change, which the address does not, and it is the id
 * chat uses for its users, so chat's membership rows name the same people. A token without both a
 * subject and an email is refused rather than patched up.
 */
export function identityFromClaims(payload: JWTPayload): SearchIdentity | null {
  const sub = payload.sub;
  const email = payload["email"];
  if (typeof sub !== "string" || sub.length === 0) return null;
  if (typeof email !== "string" || email.length === 0) return null;
  return { id: sub, email: email.trim().toLowerCase() };
}
