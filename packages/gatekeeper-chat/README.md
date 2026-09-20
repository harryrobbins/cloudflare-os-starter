# gatekeeper-chat

Team chat for this deployment: a Worker (`cfos-chat`) that serves an SPA, a JSON API, a WebSocket and
authenticated file downloads at `/gatekeeper/chat/*`, behind Cloudflare Access like the rest of the
hostname. Design and rationale: [docs/plans/chat.md](../../docs/plans/chat.md); delivery state:
[docs/plans/chat-implementation.md](../../docs/plans/chat-implementation.md).

**Status: stream 0 only.** The skeleton, the shared contract, the identity path and the phase 0 spikes
are in place. `GET /api/me` works; every other route answers `501 not_implemented` by name, so a client
built against the contract can tell "not yet" from "wrong URL". Streams A and B fill it in.

## Layout

| Path | What it is |
| --- | --- |
| `src/index.ts` | production entry: verify the Access assertion, then serve. Exports `ChatWorkspace`. |
| `src/serve.ts` | routing shared by both entries: origin check, DO, assets with SPA fallback |
| `src/access.ts` | `cf-access-jwt-assertion` verification with `jose` |
| `src/workspace.ts` | the `ChatWorkspace` Durable Object (`idFromName("main")`) |
| `src/migrations.ts` | numbered, idempotent schema migrations |
| `src/shared/` | **the contract**: `protocol.ts`, `routes.ts`, `validate.ts`. Imported by the Worker and the SPA. |
| `src/dev/` | dev-identity entry point, reached only via `wrangler.dev.jsonc` |
| `app/` | the SPA (placeholder until stream B), built to `app/dist` by `pnpm build` |
| `__tests__/` | vitest-pool-workers suites, including the spikes |
| `spikes/` | phase 0 findings ([spikes/README.md](spikes/README.md)) and the `wrangler dev` FTS5 spike |

## Commands

```sh
pnpm --filter gatekeeper-chat build        # Vite build of app/ into app/dist (run this first: the
                                          # assets binding needs the directory, and app/dist is
                                          # gitignored build output)
pnpm --filter gatekeeper-chat dev          # wrangler dev -c wrangler.dev.jsonc, on :8787
pnpm --filter gatekeeper-chat test:run     # vitest
pnpm --filter gatekeeper-chat types:check  # tsc --noEmit
```

After `wrangler types`, re-apply the hand edit marked at the top of `worker-configuration.d.ts`: it
rewrites two `import("./.wrangler/validate/src/index")` paths to `./src/index`. Wrangler follows
`main`, which is the capnweb-validate build output, and an import from that `.d.ts` drags the
generated copy of `src/` into the type-check — reporting every error twice, or reporting errors from a
stale copy. `exclude` cannot prevent it; it filters `include`, not imports.

## Signing in locally

`wrangler.dev.jsonc` points `main` at `src/dev/entry.ts`, which accepts a signed cookie naming one of
its `DEV_IDENTITIES` in place of an Access assertion:

```
http://localhost:8787/gatekeeper/chat/dev/login?as=dev-admin    # or dev-user
http://localhost:8787/gatekeeper/chat/dev/logout
http://localhost:8787/gatekeeper/chat/dev/identities            # what is configured
```

`src/index.ts` imports nothing from `src/dev/`, so the bypass cannot reach a production bundle — that
is the whole mechanism, and `__tests__/identity.test.ts` proves the production entry ignores a valid
dev cookie even when `DEV_IDENTITIES` and `DEV_IDENTITY_SECRET` are set. Stream C adds a
`deploy.ts --check` rule that rejects a production config whose `main` points at the dev entry.

## Why the Durable Object trusts a header

API, WebSocket and file requests are forwarded to `ChatWorkspace` with the verified caller in an
`x-chat-user` JSON header. The object trusts it because it has no route of its own: a Durable Object
namespace is not addressable from the internet, and the only binding to it belongs to this Worker,
which verifies the Access assertion first. The forwarding code deletes any inbound `x-chat-user` before
setting its own, so a browser that supplies one gains nothing.

## Deployment

Not wired yet — stream C adds `workers.chat` and a `chat` block to `deployment.jsonc`, the
`GATEKEEPER_CHAT` service bindings on the router and the Workshop, R2 bucket provisioning, and the
substitution of every `vars` placeholder in `wrangler.jsonc` (`CF_ACCESS_ISS`, `CF_ACCESS_AUD`,
`ADMINS`, `PUBLIC_BASE_URL`). Nothing in `wrangler.jsonc` is deployable as it stands.
