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
