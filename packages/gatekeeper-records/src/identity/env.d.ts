// Secrets the Records Worker reads that `wrangler types` cannot see (they are not in wrangler.jsonc,
// and are deliberately not `secrets.required`, so a deploy without them still works: see keys.ts).
// A global declaration file, so it survives regenerating worker-configuration.d.ts.

declare namespace Cloudflare {
  interface Env {
    /** ES256 private JWK (JSON) that signs delegated tokens. Absent: a per-isolate ephemeral key. */
    RECORDS_DELEGATION_SIGNING_KEY?: string;
    /** Optional public JWKS (JSON) of previous signing keys, still inside their rotation window. */
    RECORDS_DELEGATION_PREVIOUS_KEYS?: string;
  }
}
