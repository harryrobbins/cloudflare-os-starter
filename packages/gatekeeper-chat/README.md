# gatekeeper-chat

Team chat for this deployment: a Worker (`cfos-chat`) that serves an SPA, a JSON API, a WebSocket and
authenticated file downloads at `/gatekeeper/chat/*`, behind Cloudflare Access like the rest of the
hostname. Design and rationale: [docs/plans/chat.md](../../docs/plans/chat.md); delivery state:
[docs/plans/chat-implementation.md](../../docs/plans/chat-implementation.md).

**Status: the Worker and the SPA both work, against each other.** Channels, memberships, messages,
threads, reactions, mentions, unread and mention badges, FTS5 search with qualifiers, uploads with an
authenticated download, the WebSocket protocol, per-user rate limits and the agent-facing Gatekeeper
all work, and `e2e/` proves the SPA drives them in a real browser. Only `PUT /api/me/avatar` and the
two Web Push routes still answer `501 not_implemented`, by name, because they are phase 3.

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
| `app/` | the SPA: React 19, TanStack Router, Tailwind v4, Kumo. Built to `app/dist` by `pnpm build` (see below) |
| `__tests__/` | vitest-pool-workers suites, including the spikes |
| `spikes/` | phase 0 findings ([spikes/README.md](spikes/README.md)) and the `wrangler dev` FTS5 spike |
| `e2e/` | Playwright against `wrangler dev`, plus the dev-server and local-platform scripts (see [End-to-end tests](#end-to-end-tests)) |

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
pnpm --filter gatekeeper-chat test:run     # both suites: workers-pool, then the SPA's jsdom one
pnpm --filter gatekeeper-chat types:check  # tsc --noEmit for the Worker, then for app/
VITE_CHAT_MOCK=1 pnpm --filter gatekeeper-chat dev:app   # the SPA alone, on an in-memory fake
packages/gatekeeper-chat/e2e/run.sh        # Playwright, two identities, against wrangler dev
```

### Working on the SPA

`app/` imports the contract through `app/src/contract.ts`, which re-exports `src/shared/` and is the
only place a path or a wire type enters the client. Two transports sit behind one interface
(`app/src/api/types.ts`): the real HTTP + WebSocket pair, and `app/src/mock/` — an in-memory workspace
seeded with channels, DMs, threads, attachments and unread state, so the whole UI can be built and
screenshot-tested without the Worker. The mock is selected by `__CHAT_MOCK__`, a build-time constant,
so a production bundle folds the branch away and never contains it; `VITE_CHAT_MOCK=1 pnpm dev:app`
turns it on.

Against the real Worker, run `pnpm build` then `pnpm dev` and sign in at
`/gatekeeper/chat/dev/login?as=dev-user` (see [Signing in locally](#signing-in-locally)).

After `wrangler types`, re-apply the hand edit marked at the top of `worker-configuration.d.ts`: it
rewrites two `import("./.wrangler/validate/src/index")` paths to `./src/index`. Wrangler follows
`main`, which is the capnweb-validate build output, and an import from that `.d.ts` drags the
generated copy of `src/` into the type-check — reporting every error twice, or reporting errors from a
stale copy. `exclude` cannot prevent it; it filters `include`, not imports.

## Running locally

Two commands, in this order, from the repo root:

```sh
eval "$(fnm env)" && fnm use v24.21.0
pnpm --filter gatekeeper-chat build        # app/dist; gitignored, so a fresh checkout has none
pnpm --filter gatekeeper-chat dev          # wrangler dev -c wrangler.dev.jsonc, on :8787
```

Then open one identity per browser profile (or one per incognito window -- the dev cookie is
`HttpOnly` and scoped to `/gatekeeper/chat/`, so two identities need two cookie jars):

```
http://localhost:8787/gatekeeper/chat/dev/login?as=dev-admin    # Dev Admin,  an ADMINS member
http://localhost:8787/gatekeeper/chat/dev/login?as=dev-user     # Dev User
```

Each URL sets the cookie and redirects to the app. Both land in `#general`, which everybody is in and
nobody can leave, so the second window sees the first one type straight away.

**Build before you start the server, and restart it after a rebuild.** The `assets` binding reads its
manifest once, when the Worker starts: rebuilding `app/dist` underneath a running `wrangler dev`
leaves every hashed filename unknown to it. The Worker answers those with a 404 rather than the app
shell (`src/serve.ts`), which is a legible failure instead of a "MIME type text/html" console error --
but the fix is still to restart.

`e2e/start-dev.sh` and `e2e/stop-dev.sh` do all of that, refuse to start a second server, and put the
server in its own process group so one `kill` takes wrangler, workerd and the build child with it.

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

## End-to-end tests

`e2e/` drives the real bundle in a real browser against a real `wrangler dev`: two dev identities in
two browser contexts, one Durable Object between them. It is **not** part of `pnpm test:run`, because
it needs a port and a browser and a unit-test run should assume neither.

```sh
eval "$(fnm env)" && fnm use v24.21.0
ps -ef | grep -E 'wrangler|workerd' | grep -v grep     # must be empty: one server at a time
CHAT_SHOTS=/tmp/chat-e2e packages/gatekeeper-chat/e2e/run.sh
```

`run.sh` builds `app/dist`, clears `.wrangler/state` (`CHAT_KEEP_STATE=1` keeps it), starts the
server, runs `node --test --test-concurrency=1 e2e/chat.test.mjs` and stops the server whatever
happened. A full run is about 40 s against a warm build; 13/13 green on 2026-09-20. To iterate on one test, start the server yourself and run the file directly:

```sh
packages/gatekeeper-chat/e2e/start-dev.sh
cd packages/gatekeeper-chat && node --test --test-concurrency=1 e2e/chat.test.mjs
cd ../.. && packages/gatekeeper-chat/e2e/stop-dev.sh    # always, also after a failure
```

- `playwright@1.61.0` is a devDependency, matching the Chromium already in `~/.cache/ms-playwright`.
  Never run `playwright install` on this distro; run the suite with the Linux node **from this package
  directory** so `import 'playwright'` resolves.
- Serial, and ordered. Every test shares one workspace, T12 restarts the server, and T13 burns a
  per-user rate-limit budget, so those two are last. A `beforeEach` presses Escape on both pages, so
  one failure's open modal does not swallow the next test's clicks.
- Screenshots go to `CHAT_SHOTS` (default `/tmp/chat-e2e`), plus `console-problems.txt` if either page
  logged a console error, a page error or a 5xx.
- `CHAT_URL` points the suite at a different origin -- which is how it runs through the local
  platform's router (see below).

| Test | What it proves |
| --- | --- |
| T1 | Two identities in `#general` see each other's messages arrive over the socket, both ways. |
| T2 | Reply in thread from the hover bar; the root grows a "1 reply" summary; the Threads view lists it. |
| T3 | The other identity's rail goes unread, and clears when they open the channel. |
| T4 | A `<@dev-user>` token badges a mention with a count, and reading clears it. |
| T5 | "Mark unread from here" puts the conversation back to unread with a New messages rule. |
| T6 | A private channel 404s for a non-member on read *and* write, and is absent from Browse. |
| T7 | A DM opened from the New message dialog; the other side reading it shows "Seen by Dev User". |
| T8 | An image renders inline from `/files/:id`; a `.txt` downloads with `content-disposition: attachment`. |
| T9 | `in:#general from:@dev-admin <term>` finds it, `from:@dev-user <term>` does not, and Jump opens the permalink. |
| T10 | A permalink deep link in a fresh tab centres the message. |
| T11 | 390x780: the rail is a dialog behind "Open the conversation list". |
| T12 | The server is killed mid-session: the banner shows, the socket reconnects, and a message posted while the tab was down arrives through the `since` catch-up. |
| T13 | A 429 from the message budget surfaces as a "Message not sent" toast with Retry. |

### Through the real router

`e2e/start-local-platform.sh` boots the local Cloudflare OS Workshop with this package added to the
same multi-config `wrangler dev` and bound to the dev router as `GATEKEEPER_CHAT`, so
`/gatekeeper/chat/*` and the WebSocket upgrade go through the router's `GATEKEEPER_*` scan rather than
straight to this Worker. Nothing in `cloudflare-os/` is edited: the submodule's launcher is copied to
a temp dir and patched there, the same trick `packages/blueprint-whiteboard/e2e/start-local-platform.sh`
uses, with two extra patches that read `EXTRA_ROUTER_SERVICE` and `EXTRA_WRANGLER_CONFIGS`.

```sh
eval "$(fnm env)" && fnm use v24.21.0
packages/gatekeeper-chat/e2e/start-local-platform.sh     # ~2 min cold; prints PGID and URL
curl -s http://localhost:8787/gatekeeper/chat/dev/identities      # through the router
open http://localhost:8787/gatekeeper/chat/dev/login?as=dev-admin
packages/gatekeeper-chat/e2e/stop-local-platform.sh      # always, also after a failure
```

Verified 2026-09-20: `/gatekeeper/chat/`, the hashed assets, `/api/*`, a send and
`GET /gatekeeper/chat/ws -> 101 Switching Protocols` all reach the chat Worker through the router,
with no console errors in the SPA. Two things the submodule's launcher does not do for a config it did
not generate, both handled by the script:

- **`build.cwd`.** The multi-config `wrangler dev` runs from `cloudflare-os/`, and a custom build
  inherits that directory, so `pnpm exec capnweb-validate` would run where it is not installed. The
  script writes a copy of this package's `wrangler.dev.jsonc` into its state dir with `build.cwd`,
  `main` and `assets.directory` made absolute.
- **`\|` is alternation in GNU sed's BRE**, so the obvious anchor for `config.services || []` matches
  the empty string on every line and silently rewrites the whole launcher; and both the router and the
  workshop-backend generator have that line, so the substitution is addressed to the first match only.
  The script checks both, and fails loudly rather than starting something half-patched.

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
