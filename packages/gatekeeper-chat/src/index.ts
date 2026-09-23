// Production entry point for `cfos-chat`.
//
// Deliberately imports nothing from `src/dev/`: the dev-identity bypass exists only in
// `src/dev/entry.ts`, which `wrangler.dev.jsonc` points `main` at. That is the whole mechanism that
// keeps it out of production builds -- there is no flag to get it wrong.

import { verifyCfAccessJwt, identityFromClaims } from "./access.js";
import type { ChatEnv } from "./env.js";
import { unauthenticated } from "./http.js";
import { serveChat } from "./serve.js";

export { ChatWorkspace } from "./workspace.js";

// Where the Workshop delivers an `@agent` answer (src/agent-reply.ts). Never bound: the agent outbox
// mints it through `ctx.exports`, which is why it only has to be exported from this module.
export { ChatAgentReply } from "./agent-reply.js";

// The agent-facing half, reached over RPC from the Workshop rather than over HTTP (see
// `src/vendor/`). `ChatAccount`, `ChatVerifier` and `ChatGatekeeper` are resolved through
// `ctx.exports`, which is why they only have to be exported from this module.
export { ChatAccount, ChatGatekeeper, ChatVerifier, GatekeeperVendor } from "./vendor/index.js";

export default {
  async fetch(request, env): Promise<Response> {
    const claims = await verifyCfAccessJwt(request, env);
    if (claims === null) return unauthenticated();

    const identity = identityFromClaims(claims);
    if (identity === null) {
      return unauthenticated("The Access assertion carries no subject and email.");
    }

    return serveChat(request, env, identity);
  },
} satisfies ExportedHandler<ChatEnv>;
