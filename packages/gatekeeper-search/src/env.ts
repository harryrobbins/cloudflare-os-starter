// Bindings, typed by hand rather than taken from the generated global `Env`.
//
// `wrangler types` turns each `vars` entry into the *literal* placeholder string in wrangler.jsonc,
// and scripts/deploy.ts overwrites those placeholders, so the literals would be misleading (the same
// reasoning as packages/gatekeeper-chat/src/env.ts). worker-configuration.d.ts still supplies the
// runtime types (VectorizeIndex, Ai, Queue, ...); only the shape of `env` comes from here.

import type { EmbedMessage } from "./shared/contract.js";
import type { SearchIndex } from "./search-index.js";
import type { ContextFeed } from "./feeds/context-feed-do.js";
import type { ContextVendorLike } from "./feeds/context.js";

/** Bindings the production Worker uses. */
export interface SearchEnv {
  readonly SEARCH_INDEX: DurableObjectNamespace<SearchIndex>;
  readonly ASSETS: Fetcher;
  /**
   * The dense half. wrangler.jsonc always binds them, so they are typed as present (which also keeps
   * this interface assignable to the generated `Cloudflare.Env` the vendor classes implement against);
   * the code still checks at runtime, and an environment without them (the tests) runs lexical-only
   * and reports `dense: "off"`.
   */
  readonly AI: Ai;
  readonly VECTORS: VectorizeIndex;
  /** Work the Worker gives itself: chunk ids to embed. Checked at runtime; absent queues nothing. */
  readonly EMBED: Queue<EmbedMessage>;

  /** Cloudflare Access team issuer, e.g. `https://surprisingly-pages.cloudflareaccess.com`. */
  readonly CF_ACCESS_ISS: string;
  /** The Access application's AUD tag. */
  readonly CF_ACCESS_AUD: string;
  /**
   * Admin email addresses. deploy.ts writes a JSON *array* (structured vars pass through verbatim);
   * wrangler.jsonc and the test bindings carry a JSON *string*. Both are accepted at runtime by
   * `adminEmails()`; the declared type is `string` only so this interface stays assignable to the
   * generated `Cloudflare.Env`.
   */
  readonly ADMINS: string;
  /** Public origin, e.g. `https://cfos.surprisingly.ltd`. Used for the `Origin` check. */
  readonly PUBLIC_BASE_URL: string;
  /** The deployment's AI Gateway id. Empty calls Workers AI directly. */
  readonly AI_GATEWAY: string;
  /** "1" turns on the reranker over the fused top 30. */
  readonly RERANK: string;
  /** The Context Library feed (src/feeds/). Always declared by wrangler.jsonc. */
  readonly CONTEXT_FEED: DurableObjectNamespace<ContextFeed>;
  /**
   * cfos-context's GatekeeperVendor with the Workshop's own `{sharingDomain}` props. Optional: absent
   * means the deployment indexes no Context content. Only the feed may use it, and only with
   * `isAdmin: false` -- the vendor trusts that flag from any caller.
   */
  readonly GATEKEEPER_CONTEXT?: ContextVendorLike;
}

/**
 * The admin email list, normalized to lowercase. A malformed value yields no admins rather than
 * throwing on every request: losing admin powers is recoverable, a 500 on `/api/me` is not.
 */
export function adminEmails(env: { readonly ADMINS: unknown }): readonly string[] {
  const configured = env.ADMINS;
  let parsed: unknown = configured;
  if (!Array.isArray(configured)) {
    if (typeof configured !== "string") return [];
    try {
      parsed = JSON.parse(configured || "[]");
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** True when this email is an admin. Case-insensitive; an empty email is never an admin. */
export function isAdminEmail(env: { readonly ADMINS: unknown }, email: string | null): boolean {
  if (email === null || email.length === 0) return false;
  return adminEmails(env).includes(email.trim().toLowerCase());
}

/** The one SearchIndex stub. */
export function indexStub(env: Pick<SearchEnv, "SEARCH_INDEX">, name: string): DurableObjectStub<SearchIndex> {
  return env.SEARCH_INDEX.get(env.SEARCH_INDEX.idFromName(name));
}
