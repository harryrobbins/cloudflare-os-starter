// The Worker's default handler, built by a factory so tests can supply an Access verifier (the same
// seam as `verifyCfAccessJwt`'s `verifier` argument in chat). Production uses `createHandler()` with
// no argument, i.e. the real JWKS verification.

import { INDEX_NAME, type EmbedMessage } from "./shared/contract.js";
import { identityFromClaims, verifyCfAccessJwt, verifyAccessToken, type AccessTokenVerifier } from "./access.js";
import { denseIndexFor } from "./dense.js";
import { indexStub, type SearchEnv } from "./env.js";
import { unauthenticated } from "./http.js";
import { consumeEmbedBatch } from "./queue.js";
import { serveSearch } from "./serve.js";
import { CONTEXT_FEED_NAME } from "./feeds/context-feed-do.js";

export function createHandler(verifier: AccessTokenVerifier = verifyAccessToken): ExportedHandler<SearchEnv, EmbedMessage> {
  return {
    async fetch(request, env): Promise<Response> {
      const claims = await verifyCfAccessJwt(request, env, verifier);
      if (claims === null) return unauthenticated();
      const identity = identityFromClaims(claims);
      if (identity === null) return unauthenticated("The Access assertion carries no subject and email.");
      return serveSearch(request, env, identity);
    },

    async queue(batch, env): Promise<void> {
      const index = indexStub(env, INDEX_NAME);
      await consumeEmbedBatch(batch, env, index, denseIndexFor(env, index.id.toString()));
    },

    // The Context Library feed. Dormant unless deploy.ts bound GATEKEEPER_CONTEXT: without it there
    // is nothing to read, and the feed object is never created.
    async scheduled(_controller, env, ctx): Promise<void> {
      if (env.GATEKEEPER_CONTEXT === undefined) return;
      const feed = env.CONTEXT_FEED.get(env.CONTEXT_FEED.idFromName(CONTEXT_FEED_NAME));
      ctx.waitUntil(feed.sync().then(() => undefined));
    },
  };
}
