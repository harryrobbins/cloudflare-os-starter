// Dev-only entry for `pnpm --filter gatekeeper-search dev` (wrangler.dev.jsonc points `main` here).
//
// A local `wrangler dev` has no Cloudflare Access in front of it, so this entry takes the caller's
// identity from the DEV_IDENTITY var instead of a verified assertion. Production's src/index.ts does
// not import this module, so the bypass cannot ship: there is no flag to get wrong.

import type { EmbedMessage } from "../shared/contract.js";
import { serveSearch } from "../serve.js";
import type { SearchEnv } from "../env.js";
import { unauthenticated } from "../http.js";
import worker from "../index.js";

export * from "../index.js";

interface DevEnv extends SearchEnv {
  /** JSON `{"sub": "...", "email": "..."}`: who every request is, on this dev server only. */
  readonly DEV_IDENTITY?: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    let identity: { id: string; email: string } | null = null;
    try {
      const parsed = JSON.parse(env.DEV_IDENTITY ?? "null") as { sub?: unknown; email?: unknown } | null;
      if (typeof parsed?.sub === "string" && typeof parsed.email === "string") {
        identity = { id: parsed.sub, email: parsed.email.toLowerCase() };
      }
    } catch {
      identity = null;
    }
    if (identity === null) return unauthenticated("Set DEV_IDENTITY in wrangler.dev.jsonc.");
    return serveSearch(request, env, identity);
  },
  queue: worker.queue,
} satisfies ExportedHandler<DevEnv, EmbedMessage>;
