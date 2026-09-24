// Production entry point for `cfos-search`.
//
// Three faces, as in chat: the Access-protected HTTP surface (SPA + JSON API), the SearchService
// entrypoint sources bind to, and the agent's Gatekeeper vendor -- all over one SearchIndex Durable
// Object. The EMBED queue consumer is the default handler's `queue()`.

import { createHandler } from "./handler.js";

export { SearchIndex } from "./search-index.js";
export { SearchService } from "./service.js";

// Indexes the Context Library's public collections on a cron (src/feeds/). Only active when the
// Worker is bound to cfos-context; see README "Context Library".
export { ContextFeed } from "./feeds/context-feed-do.js";

// The agent-facing half, reached over RPC from the Workshop. The account, verifier and facet class
// are resolved through `ctx.exports`, which is why they only have to be exported from this module.
export { GatekeeperVendor, SearchAccount, SearchVerifier, SearchGatekeeper } from "./vendor/index.js";

export default createHandler();
