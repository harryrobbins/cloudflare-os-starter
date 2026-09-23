# gatekeeper-chat

Team chat for this deployment: a Worker (`cfos-chat`) that serves an SPA, a JSON API, a WebSocket and
authenticated file downloads at `/gatekeeper/chat/*`, behind Cloudflare Access like the rest of the
hostname. Design and rationale: [docs/plans/chat.md](../../docs/plans/chat.md); delivery state:
[docs/plans/chat-implementation.md](../../docs/plans/chat-implementation.md).

**Status: the Worker and the SPA both work, against each other.** Channels, memberships, messages,
threads, reactions, mentions, unread and mention badges, FTS5 search with qualifiers, uploads with an
authenticated download, the WebSocket protocol, per-user rate limits and the agent-facing Gatekeeper
all work, and `e2e/` proves the SPA drives them in a real browser. `@agent` is answered through the
Workshop's `ExternalMessageGateway` (see [Agent](#agent)), and People lists everyone who has signed in
to the platform, not only those who opened chat (see [People](#people)). Only `PUT /api/me/avatar`
and the two Web Push routes still answer `501 not_implemented`, by name, because they are phase 3.

## Layout

| Path | What it is |
| --- | --- |
| `src/index.ts` | production entry: verify the Access assertion, then serve. Exports `ChatWorkspace` and `ChatAgentReply`. |
| `src/agent-reply.ts` | `ChatAgentReply`, the entrypoint the Workshop calls back with an `@agent` answer (see [Agent](#agent)) |
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
| `src/do/users.ts` | the upsert that is the whole account model, plus the directory and **the one directory rule**, `directoryFilter` |
| `src/do/agent.ts` | `@agent`: who may ask where, the prompt, the outbox and its alarm, posting the answer |
| `src/do/channels.ts` | the rail, creation with dm deduplication, settings, join/leave/archive, read cursors |
| `src/do/messages.ts` | paging, idempotent send, edit, delete, reactions, threads, system messages |
| `src/do/unread.ts` | the badge summary: three queries, none of which walks a message twice |
| `src/do/search.ts` | the qualifier parser, the escaped FTS5 MATCH string, the membership filter |
| `src/do/files.ts` | the streaming byte cap, magic-number sniffing, the attach, the sweep |
| `src/do/sockets.ts` | accept, fan-out, the four commands, presence |
| `src/do/limits.ts` | per-user budgets in SQLite (messages, uploads, searches, questions to the Agent), and the typing throttle in memory |
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
screenshot-tested without the Worker. Its Agent answers `@agent` the way the Worker does, a couple of
seconds later; a question containing the word "fail" is refused the way an account with no model is,
and succeeds on Retry. The mock is selected by `__CHAT_MOCK__`, a build-time constant,
so a production bundle folds the branch away and never contains it; `VITE_CHAT_MOCK=1 pnpm dev:app`
turns it on.

Against the real Worker, run `pnpm build` then `pnpm dev` and sign in at
`/gatekeeper/chat/dev/login?as=dev-user` (see [Signing in locally](#signing-in-locally)).

The SPA's keyboard surface, for anybody driving it by hand or writing a test against it:
`Ctrl/Cmd+K` opens the quick switcher (`#` narrows it to channels, `@` to people, and the last row
hands off to the search view); `?` opens the shortcut sheet unless a text field has focus; and a
message starting with a known slash command (`/me`, `/shrug`, `/topic`, `/mute`, `/unmute`, `/dm`,
`/search`) is intercepted rather than posted -- anything else beginning with a slash is an ordinary
message. `?embed=1` turns on the `postMessage` bridge; `?compact=1` -- separately -- forces the
single-column layout that a narrow viewport also produces.

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

`wrangler.dev.jsonc` also binds `WORKSHOP_GATEWAY` to the local platform's Workshop (`workshop-backend`)
for `@agent`. Run standalone, nothing answers on the other end: a question queues, backs off and ends
up "The workspace could not be reached", which is the honest answer. To see the Agent answer locally,
use the in-platform layout in [Through the real router](#through-the-real-router).

## Signing in locally

`wrangler.dev.jsonc` points `main` at `src/dev/entry.ts`, which accepts a signed cookie naming one of
its `DEV_IDENTITIES` in place of an Access assertion:

```
http://localhost:8787/gatekeeper/chat/dev/login?as=dev-admin    # or dev-user, dev-colleague
http://localhost:8787/gatekeeper/chat/dev/logout
http://localhost:8787/gatekeeper/chat/dev/identities            # what is configured
```

`src/index.ts` imports nothing from `src/dev/`, so the bypass cannot reach a production bundle — that
is the whole mechanism, and `__tests__/identity.test.ts` proves the production entry ignores a valid
dev cookie even when `DEV_IDENTITIES` and `DEV_IDENTITY_SECRET` are set. `deploy.ts` rejects a
production config whose `main` points at the dev entry, or that carries any `DEV_*` var.

Each dev identity may carry a `workshopAccount`: the local Workshop password account an `@agent`
question is asked as (`dev-admin` is `admin`, `dev-user` is `beta`, `dev-colleague` is `gamma`, the
accounts `e2e/dock-check.mjs` and `e2e/agent-check.mjs` sign up). Absent, it is the identity's email.

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
happened. A full run is about 40 s against a warm build; 13/13 green on 2026-09-23. To iterate on one test, start the server yourself and run the file directly:

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

`e2e/start-local-platform.sh` boots the local Cloudflare OS Workshop with the dev router bound to this
Worker as `GATEKEEPER_CHAT`, so `/gatekeeper/chat/*`, the WebSocket upgrade and the shell's chat dock
go through the router's `GATEKEEPER_*` scan rather than straight to this Worker. Nothing in
`cloudflare-os/` is edited: the submodule's launcher is copied to a temp dir and patched there, the
same trick `packages/blueprint-whiteboard/e2e/start-local-platform.sh` uses, with one extra patch that
reads `EXTRA_ROUTER_SERVICE`.

```sh
eval "$(fnm env)" && fnm use v24.21.0
packages/gatekeeper-chat/e2e/start-local-platform.sh     # ~2 min cold; prints PGIDs and URL
curl -s http://localhost:8787/gatekeeper/chat/dev/identities      # through the router
open http://localhost:8787/gatekeeper/chat/dev/login?as=dev-admin
open http://localhost:8787/                                       # the shell, with the Chat row
node packages/gatekeeper-chat/e2e/dock-check.mjs         # the dock, end to end (see below)
packages/gatekeeper-chat/e2e/stop-local-platform.sh      # always, also after a failure
```

It is **two `wrangler dev` processes**: the platform on :8787 and this Worker on :8788, joined by
wrangler's local dev registry (a service binding whose target runs in another `wrangler dev` on the
same machine; the upgrade survives it). The obvious layout, this package's config appended to the
platform's multi-config `wrangler dev`, does not work: the Workshop backend (the frontend dist) and
this Worker (`app/dist`) both carry an `assets` directory and one workerd serves one of them, so the
shell's `/` answered with the chat app's `index.html` while every chat path looked fine. Two rules the
registry imposes, both enforced by the script:

- **Same wrangler version on both sides.** The platform runs the submodule's wrangler; this package's
  own is newer, and the older one prunes the entry the newer one wrote, so the router answered 503
  within a minute of a good start. The chat Worker is run with `cloudflare-os/node_modules/.bin/wrangler`.
- **Chat after the platform.** A platform start prunes entries it did not see come up. Restarting the
  platform alone leaves the router on 503 until the chat process is restarted as well; the stop
  script kills both.

`VITE_CHAT_DOCK` (default `true`) is the shell's build-time flag for the dock; the script rebuilds
the frontend dist whenever the existing one was built the other way. `e2e/dock-check.mjs` is the
Playwright run against this layout (21 steps, exit 1 on any failure or framing/CSP error; screenshots
in `$TMPDIR/cfos-chat-dock`): the sidebar row, the drawer, `Ctrl/Cmd+Shift+L`, Esc, the theme
handshake, a mention arriving as a shell toast whose Open lands the dock on the permalink, the expand
button into `/chat/…` with the wide layout and exactly one frame, a direct `/chat/c/general` load, a
message typed on that page arriving live in a second browser, the button in the fullscreen
workspace editor -- and, from step 6, a third person (`gamma` / `dev-colleague`) who only signs in to
the shell: the dock announces them once (`POST /api/me/seen`, no chat frame), they appear under
People for somebody else, the Agent is listed as an app with its hint, and the composer shows what
asking it sends. 21/21 green 2026-09-23.

#### The in-platform layout, for `@agent`

The two-process layout cannot carry an `@agent` question: the question hands the Workshop a
`ctx.exports` service stub to call back, and a service stub cannot cross two workerd processes (each
encrypts its stub tokens with its own key; the platform logs `channel token failed authentication`).
`CHAT_IN_PLATFORM=1` runs this Worker inside the platform's own workerd instead, from a generated copy
of `wrangler.dev.jsonc` with no `assets` -- the API works, the SPA does not, which is why the dock is
checked in the other layout:

```sh
CHAT_IN_PLATFORM=1 packages/gatekeeper-chat/e2e/start-local-platform.sh
node packages/gatekeeper-chat/e2e/agent-check.mjs        # 10 steps; starts and stops its own fake model
packages/gatekeeper-chat/e2e/stop-local-platform.sh
```

`e2e/agent-check.mjs` needs no model access: it starts `e2e/fake-model.mjs`, an OpenAI-compatible stub
that answers by quoting the question's framing back, and gives the asking account an "Ollama" model
pointing at it through the platform's own providers page. It proves, against the real Workshop: a
question from an account with no model gets the Workshop's own "needs an AI model configured" on the
message, and only the asker may retry it; with the model, a question in `#general` is accepted, the
model sees chat's framed and bounded prompt, and the answer comes back through the stored
`ChatAgentReply` stub as the Agent, in the question's thread, with a workspace path that opens the
asker's "Chat agent" workspace in the shell; a DM with Agent is answered inline; a private channel is
refused and nothing from it reaches the model; and a refused question is answered once the asker has
a model and retries. 10/10 green 2026-09-23 (with the fork's Overseer fix, see [Agent](#agent)).

## Why the Durable Object trusts a header

API, WebSocket and file requests are forwarded to `ChatWorkspace` with the verified caller in an
`x-chat-user` JSON header. The object trusts it because it has no route of its own: a Durable Object
namespace is not addressable from the internet, and the only binding to it belongs to this Worker,
which verifies the Access assertion first. The forwarding code deletes any inbound `x-chat-user` before
setting its own, so a browser that supplies one gains nothing.

## People

Signing in through Access is membership (chat.md, "People and identity"): the object records a person
on their first request and there is no other account model. That used to mean "the first time they
open chat", because the shell's dock mounts its frame only when somebody opens it -- so colleagues who
used the platform every day never appeared under People. The dock (fork commit `07046b97`, mounted
with the signed-in shell) now sends one `POST /gatekeeper/chat/api/me/seen` per browser session, which
does nothing but let `touchUser` run. A person registered that way is a real row with their Access
`sub` as id: they can be messaged straight away, and the conversation waits for them.

Who may see whom is decided in one place, `directoryFilter()` in `src/do/users.ts`: the People
listing, the search page's people, `GET /api/users/:id`, `GET /api/users?ids=` and "may I start a
conversation with them" all go through it. Today it admits every person and the Agent, because
everyone who can sign in is one of the deployment owner's colleagues. Guests or people with more
limited access are expected later; hiding them, or hiding the directory from them, is a change to that
one function (`__tests__/directory.test.ts` pins that a row it does not admit disappears everywhere).

A tab names people it has never seen as they turn up: every `msg` event carries its author, and any
other id an event or page names (a typist, a reactor, a reader, a mention) is looked up in batches
through `GET /api/users?ids=`, with ids the directory does not return left alone for five minutes.

## Agent

`@agent` is answered by the asker's own workspace agent, through the Workshop's
`ExternalMessageGateway`, and the answer is posted back as the built-in **Agent** member. The code is
`src/do/agent.ts` (the rules, the prompt, the outbox, the answer) and `src/agent-reply.ts` (the
callback). Not to be confused with [Agent access](#agent-access), which is the opposite direction:
workspace agents reading chat.

### Who can ask, and where the answer goes

- **A mention in a public channel** -- `<@agent>` from autocomplete, or a bare `@agent` -- asks. The
  answer goes in that message's thread (a mention inside a thread is answered in the same thread).
- **Any message in a one-to-one DM with Agent** asks, and is answered inline. Anyone can open that DM:
  the Agent is listed under People, and "New message" offers it (never as part of a group).
- **A private channel or a group conversation is never asked.** A mention there is refused on the
  message itself ("The Agent only answers in public channels and in a direct message with it...") and
  no prompt is built, so nothing from that conversation leaves it.
- A question costs one of **20 per person per hour** (`RATE_LIMITS.agentRequestsPerHour`, retries
  included). Over budget, the message is still sent and the question is marked failed with the wait.

### What is sent

One workspace per person, created in their account on first use and titled "Chat agent"
(`gadgetKey = user:<chat user id>`), one workspace chat per conversation (`chatKey =
channel:<id>:thread:<root>` or `dm:<channel>`), and `messageKey` = the asking message's id. Per person
rather than per channel because the Overseer that receives a question is owned by its first caller
and refuses everybody else.

`callerEmail` is the Access `email` claim **verbatim** (`ChatIdentity.workshopAccount`), never the
lowercased address chat uses elsewhere: the Workshop names an Access account
`users.idFromName(payload.email)` without normalising it, so `Harry@Example.com` and
`harry@example.com` are different accounts there. The gateway trusts `callerEmail` completely, so it
only ever comes from the identity this Worker verified, and it is never logged or sent to a browser.

The prompt tells the model it is the Agent member of the team chat, replying to a named person in a
named channel (or a DM), and who will see the answer; then at most **20 earlier messages and 16 KiB**
of that one conversation (the thread when the question is in one, the top level otherwise), newest
kept first, with names in place of mention tokens; then the question. The composer says so before
you send (`AGENT_DISCLOSURE` in `app/src/lib/agent.ts`), and the status line on a question has it as
its tooltip.

### Reliability

An outbox row (`agent_requests`, schema version 3) is written with the message, before the Workshop is
called, and the object's alarm does the calling:

| State | Meaning |
| --- | --- |
| `pending` | queued, or backing off after a thrown call (5 attempts, 5 s to 3 min apart, same `messageKey`) |
| `accepted` | the Workshop took it; `chatPath` is known. Marked failed after 15 minutes with no answer. |
| `replied` | the answer is posted; `replyId` names it |
| `failed` | with a reason: the Workshop's own words for a refusal ("...needs an AI model configured..."), unreachable, timed out, rate limited, or a refused conversation |

- The answer arrives through `ChatAgentReply.onGadgetResponse`, which the Workshop calls at least
  once. It is posted with the fixed client id `agent-reply-<question>`, so a duplicate, a concurrent
  second delivery or a late answer to a timed-out question produces exactly one reply. An answer to a
  deleted question is dropped.
- A second question from the same person in the same conversation waits until the first is answered
  or fails, because the Workshop refuses a prompt into a chat whose agent is still running.
- **Retry** is offered to the asker alone, on a failure a retry could change. It is a new question to
  the Workshop (`messageKey` gains `.<n>`), with the prompt frozen at asking time.
- Every change is fanned out as an `agent` WebSocket event. The app shows "Asking the Agent...", "The
  Agent is working on it..." (and a typing-style line in the conversation), or the failure with its
  reason; the answer shows **Open in workspace** to the asker, opened in the top window.

### The reply target, and the fork fix it needed

The target the Workshop stores and calls back is a `ChatAgentReply` service stub minted with
`ctx.exports.ChatAgentReply({ props: { workspaceId, requestId, messageKey } })` -- the only kind of
stub workerd will persist (both Workers run with `allow_irrevocable_stub_storage`). Two runtime facts
the tests established:

- **A service stub has no `dup()` and no `Symbol.dispose`.** The upstream Overseer called
  `chatGatewayRpcTarget.dup()` before storing it, which on a service stub is pipelined as a remote
  call named "dup"; storing the RpcPromise then failed with `Could not serialize object of type
  "RpcPromise"`, so every question from an account with a model threw. Fork commit `57aa6553` on
  `feat/chat-dock` dups only a session RpcStub and keeps a service stub as received (the way the User
  DO already stores gatekeepers' account stubs), and disposes only what can be disposed. It is a
  backend change, one function in `overseer.ts`, and upstreamable; without it replies cannot work.
- **A service stub cannot cross two local workerd processes** (see
  [The in-platform layout](#the-in-platform-layout-for-agent)); in production both Workers are in one
  account and it travels like any other.

`__tests__/agent.test.ts` runs the whole round trip in vitest-pool-workers through
`__tests__/aux/workshop-gateway.js`, a mock gateway Worker that stores the target in its own Durable
Object and answers through a stub read back from storage, as the patched Overseer does.

### Configuration

`chat.agentReplies` in `deployment.jsonc`, default **on** whenever chat is enabled: `deploy.ts` gives
this Worker `WORKSHOP_GATEWAY` -> the Workshop's `ExternalMessageGateway` entrypoint with
`props: { source: "chat" }`, and deploys the Workshop before chat. `false` leaves the binding out;
`/api/me` then reports `agent.replies: "disabled"` and the app says "Agent replies are turned off for
this deployment" wherever the Agent is listed, instead of looking broken.

With `chat.agentAccess` also on, chat and the Workshop bind each other. The platform accepts that
between two Workers that already exist, and chat then deploys first (as it always has for
`agentAccess`); a **first-ever** deploy with both switched on must run once with `agentReplies: false`.

**Before the Agent can answer a colleague,** they need a Workshop account (signing in to the platform
once creates it) and an AI model configured in it (the providers page, or a deployment catalog model
chosen as preferred). Until then their question fails with the Workshop's own message saying which is
missing, and Retry works once it is fixed.

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
   `agentReplies`, commented out, and needs a comma on the line above). `chat.enabled` must also
   be true -- `scripts/deploy.ts --check` rejects the combination that is not.
3. `pnpm deploy`. That adds `GATEKEEPER_CHAT` to the Workshop with `entrypoint: "GatekeeperVendor"`;
   the Workshop auto-discovers the vendor from the `GATEKEEPER_`-prefixed binding.
4. In `/admin`, enable the vendor as `enabled` so every user's workspaces get the session without
   opting in.

Deploy chat before the Workshop -- `deploy.ts` already orders it that way. The binding names an
entrypoint, so a Workshop deploy against a chat Worker that does not export `GatekeeperVendor`
fails; that is exactly why `agentAccess` is a separate switch from `enabled`.

## Deployment

`pnpm deploy` at the repository root (`scripts/deploy.ts`) generates this Worker's production config
from `wrangler.jsonc` and the `chat` block of `deployment.jsonc`, which is also where it is switched
off (`chat.enabled: false` deploys nothing chat-related). What it sets:

- `vars`: `CF_ACCESS_ISS`, `CF_ACCESS_AUD` and `ADMINS` from `access`, `PUBLIC_BASE_URL` from the
  router's origin, and `MAX_UPLOAD_BYTES` from `chat.maxUploadBytes`. Every placeholder in
  `wrangler.jsonc` is overwritten; nothing in it is deployable as it stands.
- `FILES`, the R2 bucket (`chat.filesBucket`, or provisioned by wrangler when null).
- `WORKSHOP_GATEWAY`, for `@agent` answers, unless `chat.agentReplies` is false (see [Agent](#agent)).
- On other Workers: the router's plain-fetch `GATEKEEPER_CHAT`, which routes `/gatekeeper/chat/*`
  here, and -- only under `chat.agentAccess` -- the Workshop's vendor binding
  ([Agent access](#agent-access)).
- The shell's build flag `VITE_CHAT_DOCK`, which mounts the dock (and with it the once-per-session
  People announcement) when chat is enabled.

Deploy order: the Workshop, then chat, then the router, so every binding points at a Worker that is
already deployed; with `chat.agentAccess` on, chat goes before the Workshop.
