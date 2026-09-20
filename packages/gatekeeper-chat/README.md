# gatekeeper-chat

Team chat for this deployment: a Worker (`cfos-chat`) that serves an SPA, a JSON API, a WebSocket and
authenticated file downloads at `/gatekeeper/chat/*`, behind Cloudflare Access like the rest of the
hostname. Design and rationale: [docs/plans/chat.md](../../docs/plans/chat.md); delivery state:
[docs/plans/chat-implementation.md](../../docs/plans/chat-implementation.md).

**Status: the Worker is complete (streams 0, A and D).** Channels, memberships, messages, threads,
reactions, mentions, unread and mention badges, FTS5 search with qualifiers, uploads with an
authenticated download, the WebSocket protocol, per-user rate limits and the agent-facing Gatekeeper
all work. Only `PUT /api/me/avatar` and the two Web Push routes still answer `501 not_implemented`,
by name, because they are phase 3. Stream B is building the SPA under `app/`.

## Layout

| Path | What it is |
| --- | --- |
| `src/index.ts` | production entry: verify the Access assertion, then serve. Exports `ChatWorkspace`. |
| `src/serve.ts` | routing shared by both entries: origin check, DO, assets with SPA fallback |
| `src/access.ts` | `cf-access-jwt-assertion` verification with `jose` |
| `src/workspace.ts` | the `ChatWorkspace` Durable Object (`idFromName("main")`): wiring only |
| `src/do/` | what the object actually does, one file per responsibility (see below) |
| `src/migrations.ts` | numbered, idempotent schema migrations |
| `src/shared/` | **the contract**: `protocol.ts`, `routes.ts`, `validate.ts`. Imported by the Worker and the SPA. |
| `src/dev/` | dev-identity entry point, reached only via `wrangler.dev.jsonc` |
| `src/vendor/` | the Gatekeeper vendor: the agent's `ChatSession` (see [Agent access](#agent-access)) |
| `app/` | the SPA (placeholder until stream B), built to `app/dist` by `pnpm build` |
| `__tests__/` | vitest-pool-workers suites, including the spikes |
| `spikes/` | phase 0 findings ([spikes/README.md](spikes/README.md)) and the `wrangler dev` FTS5 spike |

### Inside the Durable Object

`src/workspace.ts` runs the migrations, builds the `Ctx` every module is handed, and forwards `fetch`,
the hibernation callbacks and `alarm`. Everything else is a plain function over that context:

| Path | What it is |
| --- | --- |
| `src/do/context.ts` | the `Ctx` and `Broadcaster` interfaces, and the `Outcome` every refusal returns |
| `src/do/router.ts` | one named API route to one handler, plus `/ws` and `/files/:id` |
| `src/do/access.ts` | **the one definition of "member"**: `requireRead`, `requireWrite`, recipients, visibility |
| `src/do/users.ts` | the upsert that is the whole account model, plus the directory |
| `src/do/channels.ts` | the rail, creation with dm deduplication, settings, join/leave/archive, read cursors |
| `src/do/messages.ts` | paging, idempotent send, edit, delete, reactions, threads, system messages |
| `src/do/unread.ts` | the badge summary: three queries, none of which walks a message twice |
| `src/do/search.ts` | the qualifier parser, the escaped FTS5 MATCH string, the membership filter |
| `src/do/files.ts` | the streaming byte cap, magic-number sniffing, the attach, the sweep |
| `src/do/sockets.ts` | accept, fan-out, the four commands, presence |
| `src/do/limits.ts` | per-user budgets in SQLite, and the typing throttle in memory |
| `src/do/logs.ts` | structured counters with hashed ids; never a body, an address or a token |
| `src/do/rows.ts`, `ids.ts` | row shapes and their wire mappings; id generation |

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

## Agent access

The Workshop can bind this Worker as a Gatekeeper vendor, which gives **every** workspace an ambient
`ChatSession` capability -- no connecting, no picking a resource. It is off by default. The code is
`src/vendor/`; the agent-facing declarations are `src/vendor/types.d.ts`, published verbatim by
`getTypeScriptTypes()`.

### What the agent can do

```ts
listChannels(): Promise<ChatChannelInfo[]>
readMessages(channelId, options?: {before?, limit?}): Promise<ChatMessagePage>
readThread(channelId, rootId, options?: {before?, limit?}): Promise<ChatMessagePage>
search(query, options?: {cursor?, limit?}): Promise<ChatSearchResult>
postMessage(channelId, text, options?: {rootId?}): Promise<void>
```

- **Public channels only.** Private channels, group conversations and direct messages are never
  listed, read, searched or posted to. Two layers enforce it: the Durable Object treats `agent` as
  an implicit member of every public channel and a member of nothing else, and the session checks
  every channel id against the public channel list before it reads, searches or posts. Search hits
  outside a public channel are dropped rather than returned.
- **Every read is an observation.** Data is fetched, `authorizeObservation()` is awaited, and only
  then does a row reach the agent. A refusal means nothing is returned.
- **Posting is an action.** `postMessage` submits `chat.post` to the approval queue and returns; the
  message is sent by `applyAction()` once a person approves it. `getAutoApprovableActions()` is
  empty, and the submission never sets `autoApprovable`, so there is no way to turn posting into
  something that happens unattended. Posts appear as the built-in **Agent** member.
- **Nothing is simulated,** so each submission sets `awaitDecision`: the agent's turn suspends
  rather than reading back a channel its own post is missing from. `revertAction()` deletes the
  message it sent.
- Results are bounded: at most 50 messages or hits per page (20 by default) and 100 channels.
  Cursors are opaque strings.

The vendor never opens the Durable Object's database. It calls the same internal HTTP API the
browser calls, as the built-in `agent` identity, so every rule the object enforces for a person --
membership, archiving, rate limits, idempotent sends -- applies to the agent unchanged.

### Observer policy

**Every observer is accepted** (`addObserver()` is a no-op). Read this before turning the binding on:
it is the security decision that comes with it.

When a gadget is shared, its collaborators may see data the gadget read through this gatekeeper.
Accepting everyone is sound *only* because everything reachable here is a public channel, which
every signed-in user of this deployment can already read in the chat app itself -- a collaborator
learns nothing they could not have read directly. It follows that if the agent is ever given access
to anything private, this policy must change first, to an ACL check that asks the observer's own
verifier whether they are a member of the conversation (`write-gatekeeper` calls that strategy B/C).

### Turning it on

1. Review the observer policy above.
2. In `deployment.jsonc`, inside the `chat` block, set `"agentAccess": true` (it sits below
   `maxUploadBytes`, commented out, and needs a comma on the line above). `chat.enabled` must also
   be true -- `scripts/deploy.ts --check` rejects the combination that is not.
3. `pnpm deploy`. That adds `GATEKEEPER_CHAT` to the Workshop with `entrypoint: "GatekeeperVendor"`;
   the Workshop auto-discovers the vendor from the `GATEKEEPER_`-prefixed binding.
4. In `/admin`, enable the vendor as `enabled` so every user's workspaces get the session without
   opting in.

Deploy chat before the Workshop -- `deploy.ts` already orders it that way. The binding names an
entrypoint, so a Workshop deploy against a chat Worker that does not export `GatekeeperVendor`
fails; that is exactly why `agentAccess` is a separate switch from `enabled`.

## Deployment

Not wired yet — stream C adds `workers.chat` and a `chat` block to `deployment.jsonc`, the
`GATEKEEPER_CHAT` service bindings on the router and the Workshop, R2 bucket provisioning, and the
substitution of every `vars` placeholder in `wrangler.jsonc` (`CF_ACCESS_ISS`, `CF_ACCESS_AUD`,
`ADMINS`, `PUBLIC_BASE_URL`). Nothing in `wrangler.jsonc` is deployable as it stands.
