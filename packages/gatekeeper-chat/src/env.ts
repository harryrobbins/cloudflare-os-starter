// Bindings, typed by hand rather than taken from the generated global `Env`.
//
// `wrangler types` turns each `vars` entry into the *literal* placeholder string in wrangler.jsonc
// ("https://example.cloudflareaccess.com" and so on). Those placeholders are overwritten by
// scripts/deploy.ts, so the literals are actively misleading: code guarded by `if (!env.CF_ACCESS_ISS)`
// would look unreachable. worker-configuration.d.ts still supplies the runtime types (R2Bucket,
// DurableObjectNamespace, ...); only the shape of `env` comes from here.

import { MAX_UPLOAD_BYTES } from "./shared/protocol.js";

/** Bindings the production Worker uses. */
export interface ChatEnv {
  readonly CHAT_WORKSPACE: DurableObjectNamespace;
  readonly FILES: R2Bucket;
  readonly ASSETS: Fetcher;

  /** Cloudflare Access team issuer, e.g. `https://surprisingly-pages.cloudflareaccess.com`. */
  readonly CF_ACCESS_ISS: string;
  /** The Access application's AUD tag. */
  readonly CF_ACCESS_AUD: string;
  /** JSON array of admin email addresses, mirroring `access.admins` in deployment.jsonc. */
  readonly ADMINS: string;
  /** Public origin, e.g. `https://cfos.surprisingly.ltd`. Used for the `Origin` check. */
  readonly PUBLIC_BASE_URL: string;
  /**
   * Upload cap in bytes, from `chat.maxUploadBytes` in deployment.jsonc. A number, not a string:
   * wrangler passes structured vars through verbatim. Optional so a missing var falls back to the
   * protocol default rather than failing every upload.
   */
  readonly MAX_UPLOAD_BYTES?: number;
}

/** Extra bindings only `wrangler.dev.jsonc` supplies. Production has neither. */
export interface DevEnv extends ChatEnv {
  /** JSON array of `{id, email, name?}` the dev login may mint. */
  readonly DEV_IDENTITIES?: string;
  /** HMAC key for the dev identity cookie. Only has authority on a dev server. */
  readonly DEV_IDENTITY_SECRET?: string;
}

/** The configured upload cap, or the contract's default when the var is absent or nonsensical. */
export function maxUploadBytes(env: Pick<ChatEnv, "MAX_UPLOAD_BYTES">): number {
  const configured = Number(env.MAX_UPLOAD_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : MAX_UPLOAD_BYTES;
}

/** Parses `ADMINS`. A malformed value yields no admins rather than throwing on every request. */
export function adminEmails(env: Pick<ChatEnv, "ADMINS">): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(env.ADMINS || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .map((entry) => entry.trim().toLowerCase());
  } catch {
    return [];
  }
}
