// The dev identity cookie: `<identityId>.<base64url HMAC-SHA-256>`.
//
// Signed rather than plain so a dev server cannot be driven into an arbitrary identity by editing a
// cookie in devtools -- the same property the real Access assertion has, at a fraction of the setup.
// The key is a var, not a secret, because it only has authority on a machine that is already running
// the dev entry point.

export const DEV_COOKIE_NAME = "chat_dev_identity";

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function base64Url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function signIdentityId(id: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(id));
  return `${id}.${base64Url(signature)}`;
}

/** Returns the identity id when the signature checks out, else null. */
export async function verifyIdentityCookie(value: string, secret: string): Promise<string | null> {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const id = value.slice(0, separator);
  const expected = await signIdentityId(id, secret);
  // Re-signing and comparing the whole cookie keeps the comparison constant-time-ish via the same
  // length on both sides; `crypto.subtle.verify` would need the raw signature decoded first.
  if (expected.length !== value.length) return null;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ value.charCodeAt(i);
  }
  return mismatch === 0 ? id : null;
}

/** Reads one cookie out of a `Cookie` header. */
export function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}
