// The gatekeeper's delegated-token signing keys and issuer URL (canonical plan §5).
//
//   RECORDS_DELEGATION_SIGNING_KEY    secret: the current ES256 private JWK (JSON, with `kid`), made
//                                     once by @records/identity generateSigningKey()
//   RECORDS_DELEGATION_PREVIOUS_KEYS  optional secret: a public JWKS ({"keys":[…]}) or an array of
//                                     public JWKs still inside their rotation window
//
// The issuer is `${origin of PUBLIC_BASE_URL}/gatekeeper/records`. Verification in this Worker uses
// these keys directly (a local key set, never a network fetch). The same public keys are served at
// JWKS_PATH for a datastore service running elsewhere.
//
// Without a signing key (a Worker deployed before the secret was installed, local development),
// each isolate generates an ephemeral key. Its tokens are minted and verified inside that isolate
// only, it is never published, and a warning is logged once. A configured but unusable key is an
// error: nothing falls back from a broken secret.

import {
  generateSigningKey,
  importSigningKey,
  localKeySet,
  publicJwks,
  type PublicSigningJwk,
  type SigningKey,
} from "@records/identity";
import type { JWTVerifyGetKey } from "jose";

export const DELEGATION_ISSUER_PATH = "/gatekeeper/records";
export const JWKS_PATH = "/gatekeeper/records/.well-known/jwks.json";
/** Used when PUBLIC_BASE_URL is unset or not an http(s) URL (local development and tests). */
export const FALLBACK_ISSUER = "http://localhost/gatekeeper/records";

export type DelegationEnv = {
  PUBLIC_BASE_URL?: string;
  RECORDS_DELEGATION_SIGNING_KEY?: string;
  RECORDS_DELEGATION_PREVIOUS_KEYS?: string;
};

export type DelegationKeys = {
  /** The exact `iss` of tokens minted here. */
  issuer: string;
  /** Signs new tokens. */
  current: SigningKey;
  /** Public keys this Worker publishes (current, then previous). Empty for an ephemeral key. */
  published: PublicSigningJwk[];
  /** Local resolver over current and previous public keys. */
  keySet: JWTVerifyGetKey;
  /** True when no signing key is configured and this isolate made its own. */
  ephemeral: boolean;
};

/** `${origin}/gatekeeper/records` for PUBLIC_BASE_URL; any path, query or trailing slash is dropped. */
export function delegationIssuer(publicBaseUrl: string | undefined): string {
  if (!publicBaseUrl) return FALLBACK_ISSUER;
  try {
    const url = new URL(publicBaseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return FALLBACK_ISSUER;
    return `${url.origin}${DELEGATION_ISSUER_PATH}`;
  } catch {
    return FALLBACK_ISSUER;
  }
}

function previousKeys(raw: string | undefined): PublicSigningJwk[] {
  if (!raw || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("RECORDS_DELEGATION_PREVIOUS_KEYS is not valid JSON.");
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) throw new Error("RECORDS_DELEGATION_PREVIOUS_KEYS must be a JWKS ({\"keys\": [...]}) or an array of JWKs.");
  // publicJwks validates each entry and strips private members.
  return publicJwks(list as PublicSigningJwk[]).keys;
}

async function build(env: DelegationEnv): Promise<DelegationKeys> {
  const issuer = delegationIssuer(env.PUBLIC_BASE_URL);
  const secret = env.RECORDS_DELEGATION_SIGNING_KEY?.trim();
  const ephemeral = !secret;
  let current: SigningKey;
  if (secret) {
    try {
      current = await importSigningKey(secret);
    } catch (err) {
      throw new Error(`RECORDS_DELEGATION_SIGNING_KEY is unusable: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    current = await importSigningKey(await generateSigningKey());
    console.warn(JSON.stringify({ event: "records.delegation.ephemeral_key", message: "RECORDS_DELEGATION_SIGNING_KEY is not set; using a per-isolate key for in-process tokens." }));
  }
  const previous = previousKeys(env.RECORDS_DELEGATION_PREVIOUS_KEYS).filter((k) => k.kid !== current.kid);
  const verifying = publicJwks([current, ...previous]).keys;
  return {
    issuer,
    current,
    published: ephemeral ? previous : verifying,
    keySet: localKeySet({ keys: verifying }),
    ephemeral,
  };
}

// Per isolate: key import is not free, and an ephemeral key must be the same for every call here.
let cached: { fingerprint: string; keys: Promise<DelegationKeys> } | undefined;

/** The delegation keys for this environment, built once per isolate (and rebuilt if the env changes). */
export function delegationKeys(env: DelegationEnv): Promise<DelegationKeys> {
  const fingerprint = JSON.stringify([env.PUBLIC_BASE_URL ?? "", env.RECORDS_DELEGATION_SIGNING_KEY ?? "", env.RECORDS_DELEGATION_PREVIOUS_KEYS ?? ""]);
  if (cached?.fingerprint !== fingerprint) {
    const keys = build(env);
    cached = { fingerprint, keys };
    // A failure is not cached: the next call retries (and fails the same way until fixed).
    keys.catch(() => {
      if (cached?.keys === keys) cached = undefined;
    });
  }
  return cached.keys;
}

/** The JWKS response: public keys only, briefly cacheable. */
export async function jwksResponse(env: DelegationEnv): Promise<Response> {
  let body: { keys: PublicSigningJwk[] };
  try {
    body = { keys: (await delegationKeys(env)).published };
  } catch (err) {
    console.error(JSON.stringify({ event: "records.delegation.jwks_failed", error: err instanceof Error ? err.message : String(err) }));
    return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/jwk-set+json", "cache-control": "public, max-age=300" },
  });
}
