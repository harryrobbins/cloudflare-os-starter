// Cloudflare Access assertion verification.
//
// The same approach as cloudflare-os/packages/workshop-backend/src/access.ts: verify
// `cf-access-jwt-assertion` against the team's JWKS with `jose`, pinned to the configured issuer and
// audience, and treat any failure as "no identity" rather than surfacing the reason. The JWKS set is
// cached per issuer for the isolate's lifetime; `createRemoteJWKSet` handles its own key rotation.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import type { ChatIdentity } from "./shared/protocol.js";

export type CfAccessEnv = Readonly<{
  CF_ACCESS_ISS?: string;
  CF_ACCESS_AUD?: string;
}>;

export type AccessTokenVerifier = (token: string, env: CfAccessEnv) => Promise<JWTPayload>;

const remoteJwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function verifyToken(token: string, env: CfAccessEnv): Promise<JWTPayload> {
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
  verifier: AccessTokenVerifier = verifyToken,
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
 * Derives the chat identity from verified claims.
 *
 * `sub` is the user key: it survives an email change, which the address does not. A token with no
 * `sub` or no `email` is rejected rather than patched up -- a chat row whose author cannot be named
 * is worse than a failed request. The display name is deliberately *not* taken from the token: the
 * `/cdn-cgi/access/get-identity` question is still open (chat.md, phase 0 item 4), so the DO falls
 * back to the email local part until that is settled.
 */
export function identityFromClaims(payload: JWTPayload): ChatIdentity | null {
  const sub = payload.sub;
  const email = payload["email"];
  if (typeof sub !== "string" || sub.length === 0) return null;
  if (typeof email !== "string" || email.length === 0) return null;
  return { id: sub, email: email.trim().toLowerCase() };
}
