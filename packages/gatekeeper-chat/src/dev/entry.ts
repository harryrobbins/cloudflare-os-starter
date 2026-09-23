// Dev-only entry point. `wrangler.dev.jsonc` points `main` here; nothing in `src/` outside this
// directory imports it, so the bypass below cannot reach a production bundle.
//
// It adds exactly two routes to the production behaviour:
//   GET /gatekeeper/chat/dev/login?as=<id>   sets a signed cookie naming one of DEV_IDENTITIES
//   GET /gatekeeper/chat/dev/logout          clears it
// A request carrying a valid cookie is served as if Access had verified it. A real Access assertion
// still works and takes precedence, so the same server can be pointed at a protected hostname.
//
// `deploy.ts --check` is expected to reject any production config whose `main` points at this file
// (stream C).

import { identityFromClaims, verifyCfAccessJwt } from "../access.js";
import type { DevEnv } from "../env.js";
import { errorResponse, invalidRequest, json, unauthenticated } from "../http.js";
import { serveChat } from "../serve.js";
import { APP_BASE, DEV_PREFIX } from "../shared/routes.js";
import type { ChatIdentity } from "../shared/protocol.js";
import { isRecord } from "../shared/validate.js";
import { DEV_COOKIE_NAME, readCookie, signIdentityId, verifyIdentityCookie } from "./cookie.js";

export { ChatWorkspace } from "../workspace.js";
// Minted through `ctx.exports` by the agent outbox, so the dev entry must export it as well.
export { ChatAgentReply } from "../agent-reply.js";

// Every Durable Object class named in a `migrations` tag has to be exported by whatever `main` points
// at, or the runtime refuses to start ("Class extends value undefined"). `wrangler.dev.jsonc` carries
// the same v0 and v1 tags as `wrangler.jsonc`, so this entry must export the vendor's classes too --
// they are dead weight on a dev server, but an unexported one is a boot failure, not a missing
// feature. `__tests__/identity.test.ts` pins the two entries' exports to each other.
export { ChatAccount, ChatGatekeeper, ChatVerifier, GatekeeperVendor } from "../vendor/index.js";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === `${DEV_PREFIX}/login`) return login(request, env, url);
    if (url.pathname === `${DEV_PREFIX}/logout`) return logout();
    if (url.pathname === `${DEV_PREFIX}/identities`) {
      return json({ identities: devIdentities(env).map(({ id, email, name }) => ({ id, email, name })) });
    }

    const identity = (await accessIdentity(request, env)) ?? (await cookieIdentity(request, env));
    if (identity === null) {
      return unauthenticated(
        `No identity. Visit ${DEV_PREFIX}/login?as=<id> with one of the DEV_IDENTITIES ids.`,
      );
    }
    return serveChat(request, env, identity);
  },
} satisfies ExportedHandler<DevEnv>;

async function accessIdentity(request: Request, env: DevEnv): Promise<ChatIdentity | null> {
  // With CF_ACCESS_ISS/AUD empty in wrangler.dev.jsonc this always fails closed, which is the point:
  // a production assertion cannot be replayed against a dev server.
  if (!env.CF_ACCESS_ISS || !env.CF_ACCESS_AUD) return null;
  const claims = await verifyCfAccessJwt(request, env);
  return claims === null ? null : identityFromClaims(claims);
}

async function cookieIdentity(request: Request, env: DevEnv): Promise<ChatIdentity | null> {
  const secret = env.DEV_IDENTITY_SECRET;
  if (!secret) return null;
  const cookie = readCookie(request.headers.get("cookie"), DEV_COOKIE_NAME);
  if (cookie === null) return null;
  const id = await verifyIdentityCookie(cookie, secret);
  if (id === null) return null;
  // The cookie names an identity; it does not carry one. An id dropped from DEV_IDENTITIES stops
  // working immediately.
  return devIdentities(env).find((candidate) => candidate.id === id) ?? null;
}

async function login(request: Request, env: DevEnv, url: URL): Promise<Response> {
  const secret = env.DEV_IDENTITY_SECRET;
  if (!secret) return errorResponse("internal", "DEV_IDENTITY_SECRET is not configured.");

  const requested = url.searchParams.get("as");
  if (requested === null) return invalidRequest("Pass ?as=<id>.");

  const identities = devIdentities(env);
  if (!identities.some((candidate) => candidate.id === requested)) {
    return invalidRequest(`Unknown dev identity. Known: ${identities.map((i) => i.id).join(", ") || "(none)"}`);
  }

  const cookie = [
    `${DEV_COOKIE_NAME}=${encodeURIComponent(await signIdentityId(requested, secret))}`,
    `Path=${APP_BASE}`,
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=86400",
  ].join("; ");

  const target = url.searchParams.get("next");
  const location = target !== null && target.startsWith(APP_BASE) ? target : APP_BASE;
  return new Response(null, {
    status: 302,
    headers: { location, "set-cookie": cookie, "cache-control": "no-store" },
  });
}

function logout(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: APP_BASE,
      "set-cookie": `${DEV_COOKIE_NAME}=; Path=${APP_BASE}; HttpOnly; SameSite=Lax; Max-Age=0`,
      "cache-control": "no-store",
    },
  });
}

/**
 * Parses `DEV_IDENTITIES`: `{id, email, name?, workshopAccount?}` each. A malformed value yields none,
 * so the dev server simply refuses entry.
 */
function devIdentities(env: DevEnv): readonly ChatIdentity[] {
  try {
    const parsed: unknown = JSON.parse(env.DEV_IDENTITIES || "[]");
    if (!Array.isArray(parsed)) return [];
    const out: ChatIdentity[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry)) continue;
      const { id, email, name, workshopAccount } = entry;
      if (typeof id !== "string" || id.length === 0) continue;
      if (typeof email !== "string" || email.length === 0) continue;
      out.push({
        id,
        email: email.toLowerCase(),
        ...(typeof name === "string" ? { name } : {}),
        // The local Workshop's accounts are password accounts named by username, not by address, so
        // an identity may say which one it is; production takes the Access email verbatim instead.
        workshopAccount: typeof workshopAccount === "string" && workshopAccount.length > 0 ? workshopAccount : email,
      });
    }
    return out;
  } catch {
    return [];
  }
}
