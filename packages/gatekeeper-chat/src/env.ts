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
  /**
   * Admin email addresses, mirroring `access.admins` in deployment.jsonc.
   *
   * Two shapes, both real: `scripts/deploy.ts` writes the generated config's `vars.ADMINS` as a JSON
   * *array* and wrangler passes structured vars through verbatim, so production hands this Worker a
   * `string[]`. `wrangler.jsonc` and `wrangler.dev.jsonc` carry the same value as a JSON *string*,
   * which is what a hand-written config and the test bindings can express. Accept both rather than
   * making one of them silently yield no admins.
   */
  readonly ADMINS: string | readonly string[];
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

/**
 * The admin email list, normalized to lowercase.
 *
 * Accepts the array production supplies and the JSON string a hand-written config carries. A
 * malformed value yields no admins rather than throwing on every request: losing admin powers is
 * recoverable, a 500 on `/api/me` is not.
 */
export function adminEmails(env: Pick<ChatEnv, "ADMINS">): readonly string[] {
  return normalizeEmails(readAdmins(env.ADMINS));
}

/** True when this email is an admin. Case-insensitive; an empty email is never an admin. */
export function isAdminEmail(env: Pick<ChatEnv, "ADMINS">, email: string | null): boolean {
  if (email === null || email.length === 0) return false;
  return adminEmails(env).includes(email.trim().toLowerCase());
}

function readAdmins(value: string | readonly string[]): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

function normalizeEmails(parsed: unknown): readonly string[] {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}
