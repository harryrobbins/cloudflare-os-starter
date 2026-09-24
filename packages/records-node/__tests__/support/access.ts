// A stand-in Cloudflare Access team for tests: an RS256 key, its JWKS served at
// `<issuer>/cdn-cgi/access/certs` over plain HTTP on 127.0.0.1, and signed assertions. Both runtimes
// verify these with the production verifyAccessAssertion (jose + remote JWKS), so the first factor
// is exercised for real rather than stubbed.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type TestAccess = {
  issuer: string;
  audience: string;
  /** A signed assertion for `audience` (or another audience), valid for `ttlSeconds`. */
  sign(opts?: { audience?: string; ttlSeconds?: number; sub?: string }): Promise<string>;
  close(): Promise<void>;
};

const b64url = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString("base64url");

export async function startTestAccess(audience = "records-api-aud"): Promise<TestAccess> {
  const keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const kid = crypto.randomUUID();
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid, alg: "RS256", use: "sig" };
  const server = createServer((req, res) => {
    if (req.url === "/cdn-cgi/access/certs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer,
    audience,
    async sign({ audience: aud = audience, ttlSeconds = 3600, sub = "service-token" } = {}) {
      const now = Math.floor(Date.now() / 1000);
      const header = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
      const payload = b64url(JSON.stringify({ iss: issuer, aud: [aud], sub, iat: now, nbf: now - 5, exp: now + ttlSeconds, type: "app", common_name: sub }));
      const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${payload}`));
      return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
    },
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
