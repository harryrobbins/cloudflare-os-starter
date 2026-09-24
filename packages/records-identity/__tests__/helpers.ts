import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { base64url } from "jose";

export const ISSUER = "https://cfos.example.test/gatekeeper/records";
export const ACCESS_ISSUER = "https://team.cloudflareaccess.com";
export const SAAS_ISSUER = "https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client123";
export const ACCESS_AUD = "a".repeat(64);
export const SAAS_AUD = "client123";

export const ids = {
  principal: "11111111-1111-4111-8111-111111111111",
  org: "22222222-2222-4222-8222-222222222222",
  datastore: "33333333-3333-4333-8333-333333333333",
  otherDatastore: "44444444-4444-4444-8444-444444444444",
  binding: "55555555-5555-4555-8555-555555555555",
};

export const T0 = Date.UTC(2026, 8, 24, 12, 0, 0);

/** An RS256 key pair standing in for a Cloudflare Access team key. */
export async function accessKey(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return {
    jwk,
    sign: (payload: JWTPayload, header: Record<string, unknown> = {}) =>
      new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid, ...header }).sign(privateKey),
  };
}

/** Build an unsigned or HMAC token by hand for alg-confusion tests. */
export async function handToken(header: object, payload: object, hmacKey?: Uint8Array): Promise<string> {
  const enc = (o: object) => base64url.encode(new TextEncoder().encode(JSON.stringify(o)));
  const input = `${enc(header)}.${enc(payload)}`;
  if (!hmacKey) return `${input}.`;
  const key = await crypto.subtle.importKey("raw", new Uint8Array(hmacKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
  return `${input}.${base64url.encode(sig)}`;
}

/** A fetch that serves JWKS documents from memory and records calls. No network. */
export function memoryFetch(docs: Record<string, { keys: unknown[] }>) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const doc = docs[url];
    if (!doc) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls, docs };
}

export const secs = (ms: number) => Math.floor(ms / 1000);
