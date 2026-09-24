// Webhook signatures.
//
// Native (every delivery, both formats):
//   X-Records-Timestamp: <unix seconds>
//   X-Records-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>
// The timestamp is inside the signed bytes, so a captured request cannot be replayed later than the
// receiver's tolerance (verifyRecordsSignature defaults to five minutes). Receivers should also
// de-duplicate on X-Records-Delivery, since delivery is at-least-once.
//
// Jira format additionally carries Jira's own `X-Hub-Signature: sha256=<hex HMAC(secret, body)>`
// (signWebhook from @records/jira), for clients that already verify Jira webhooks. That scheme has
// no timestamp; receivers that want replay protection check X-Records-Signature as well.

const encoder = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signRecordsWebhook(secret: string, timestamp: number, body: string): Promise<string> {
  return `sha256=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Receiver-side check (and the reference for integrators): the signature matches the body and the
 * timestamp, and the timestamp is within `toleranceSeconds` of `now`.
 */
export async function verifyRecordsSignature(
  secret: string,
  body: string,
  headers: { timestamp: string | null; signature: string | null },
  opts: { now?: number; toleranceSeconds?: number } = {},
): Promise<boolean> {
  const ts = Number(headers.timestamp);
  if (!headers.signature?.startsWith("sha256=") || !Number.isSafeInteger(ts)) return false;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - ts) > (opts.toleranceSeconds ?? 300)) return false;
  return constantTimeEqual(await signRecordsWebhook(secret, ts, body), headers.signature);
}
