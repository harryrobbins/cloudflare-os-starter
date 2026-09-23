// Cloudflare Access assertion verification (same approach as gatekeeper-chat/src/access.ts and the
// Workshop backend): verify `cf-access-jwt-assertion` against the team JWKS, pinned to the
// configured issuer and a path-specific audience. Any failure means "no identity".

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export type AccessConfig = { issuer?: string; audience?: string };

const jwkSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function verifyAccessAssertion(request: Request, config: AccessConfig): Promise<JWTPayload | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !config.issuer || !config.audience) return null;
  let jwks = jwkSets.get(config.issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`));
    jwkSets.set(config.issuer, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: config.issuer, audience: config.audience });
    return payload;
  } catch {
    return null;
  }
}

/** A signed-in person's verified e-mail, from a user (not service-token) assertion. */
export function userEmail(payload: JWTPayload | null): string | null {
  const email = payload?.["email"];
  return typeof email === "string" && email.includes("@") ? email : null;
}
