# Chat implementation checklist

Tracks delivery of [chat.md](chat.md). Started 2026-09-20 on branch `chat`. Tick items as they land; each stream names the agent that owns it. Keep this file current after every stream completes.

## Stream 0: skeleton, contract and local spikes

Complete 2026-09-20. 79 tests green (`pnpm --filter gatekeeper-chat test:run`), `types:check` clean.

- [x] `packages/gatekeeper-chat` scaffolded from `packages/custom-gatekeeper` (package.json, tsconfig, wrangler.jsonc, wrangler.dev.jsonc, vitest config, workspace membership)
- [x] `src/shared/protocol.ts`: HTTP and WebSocket contract as TypeScript types, shared by the Worker and the SPA — with `src/shared/routes.ts` (route table plus path matcher) and `src/shared/validate.ts` (hand-written inbound validators, no new dependency)
- [x] Spike 2: FTS5 virtual table, triggers, `snippet()`, `bm25()` in a SQLite DO under vitest-pool-workers and `wrangler dev`
- [x] Spike 1 (local half): WebSocket upgrade through a router-like service binding reaches a hibernatable DO; attachment survives eviction
- [x] Spike 3: `assets` binding serves a Vite build under `base: "/gatekeeper/chat/"` through a service binding
- [x] Dev identity: `src/dev/entry.ts` wrapper used only by `wrangler.dev.jsonc`; production `src/index.ts` has no bypass
- [x] Also landed early, because the identity path is untestable without them: Access JWT verification with `jose`, the `Origin` check on upgrades and writes, the `ChatWorkspace` migration runner, and `GET /api/me`

**What the spikes changed in the plan** (full write-up in [`packages/gatekeeper-chat/spikes/README.md`](../../packages/gatekeeper-chat/spikes/README.md)):

- **The `assets` binding does not know about Vite's `base`.** It resolves a URL path against the asset directory, so `/gatekeeper/chat/assets/index-<hash>.js` 404s while `/assets/index-<hash>.js` is served. The Worker strips `CHAT_PREFIX` before calling `env.ASSETS.fetch()`; `base` stays `/gatekeeper/chat/` because that is what the browser requests. The plan's "served by the Worker for `/gatekeeper/chat/assets/*`" should be read as "after the prefix is stripped".
- **Never forward a redirect from the asset server.** Requesting `index.html` triggers `html_handling` and returns a redirect to `/` — a Location without the prefix, which bounces the browser out of the app. The SPA fallback requests the app base instead, forwards only 2xx and 304, and drops `location`.
- **`sqlite_version()` is not callable inside a Durable Object** (`not authorized to use function`). FTS5 behaviour has to be pinned by tests, not a version check.
- **FTS5's `bm25()` is negative and lower is better**, so ranking is `ORDER BY score` ascending. Every indexed column must be a real column of the content table, which confirms the plan's decision to index `body` alone and filter on immutable ids in SQL.
- **`jose` was added to the workspace catalog** (`^6.2.8`, matching what `workshop-backend` declares). It is the first starter-only catalog entry; the comment in `pnpm-workspace.yaml` says so.
- **An auxiliary Worker cannot bind back to the Worker under test** under vitest-pool-workers (the runner Worker's name is generated per project). Anything that must be reached *through* another Worker needs its Durable Object in an auxiliary Worker, in plain JavaScript. Stream E's local-platform run through the real router is therefore still worth doing.
- **`packages/*/wrangler.dev.jsonc` is gitignored**; `.gitignore` now carries an exception for this package's hand-written one. `app/dist` stays ignored, so `pnpm --filter gatekeeper-chat build` must run before `wrangler dev` on a fresh checkout.
- Still open from phase 0 and unchanged: Access display names (item 4), Web Push (5), the external message gateway (6), and the protected-deployment half of item 1 (assertion present on the upgrade, invalid assertion rejected).

## Stream A: Worker and Durable Object

Complete 2026-09-20. `src/do/` (13 modules), migration 2, 198 tests green
(`pnpm --filter gatekeeper-chat test:run`), `tsc --noEmit` clean, no lint findings outside `app/`.

- [x] Access JWT verification (`jose`) on every request and WebSocket upgrade; `Origin` check on upgrades and writes — the upgrade reaches the DO through the same `serveChat` path, so both checks already cover it
- [x] `ChatWorkspace` DO: numbered idempotent migrations, schema from the plan, `#general` seeded
- [x] Users, channels, memberships, join/leave/archive, admin list from `ADMINS`
- [x] Messages: send (idempotent `clientId`), edit, delete (tombstone rule), threads with `reply_count`, reactions, mentions by user id
- [x] Unread: `last_read_seq`, manual unread marker, thread follows, badge summary
- [x] Search: FTS5 with qualifier parser, membership filter, `snippet()`, cursor paging
- [x] Uploads: multipart with hard byte cap, pending R2 object with expiry, atomic attach on send, magic-number image sniff, authenticated `files/:id` and thumb, cleanup alarm
- [x] WebSocket protocol: `sub`, `typing`, `read`, `ping`; server events; per-user tags; membership rechecked per command; presence with heartbeat expiry
- [x] Rate limits per user (messages, uploads, search)
- [x] Structured, redacted logs
- [x] Unit tests (vitest-pool-workers): migrations, unread arithmetic, search qualifiers, membership on every path, idempotency, rate limits

Decisions the other streams need:

- **`protocol.ts` gained constants only, all additive**: `UserKind` and an optional `User.kind`;
  `AGENT_USER_ID` / `AGENT_USER_NAME`; `GENERAL_CHANNEL_ID` / `GENERAL_CHANNEL_NAME`;
  `MENTION_TOKEN_SOURCE`; and `WS_HEARTBEAT_MS`, `PRESENCE_TTL_MS`, `TYPING_THROTTLE_MS`,
  `PENDING_UPLOAD_TTL_MS`. `validate.ts` gained `mentionToken()` and `extractMentionIds()`. Nothing
  existing changed shape.
- **A mention is the token `<@userId>`**, inserted by autocomplete and resolved against a real user at
  post time. A token naming nobody stays plain text and writes no row.
- **Subscriptions are a filter, not a permission.** Membership decides who may receive a channel
  event; a socket that has subscribed receives only the channels it named, and a socket that has
  subscribed to nothing receives everything it is entitled to. A public channel fans out to every
  connected user, because anybody may browse one.
- **Presence expires lazily.** Every inbound frame is a heartbeat; a user is online while one of their
  sockets sent a frame inside `PRESENCE_TTL_MS` (90s) and clients ping every `WS_HEARTBEAT_MS` (30s).
  There is no presence alarm — the only alarm is the pending-upload sweep — so the set is recomputed
  when it is asked for and re-broadcast on connect and disconnect.
- **Writing to a public channel joins you**, because the read cursor lives in the membership row. The
  same is true of adding a reaction.
- **Search dates are resolved in UTC** and the search cursor is a bounded offset; both are noted as
  TODOs in `src/do/search.ts`. `GET files/:id/thumb` serves the full object until server-side
  thumbnails exist (`src/do/files.ts`).
- **A malformed search is `invalid_request` (400)**, since `ERROR_CODES` has no `validation` member.
- **`PATCH /api/channels/:id/membership`** (added after the first pass, for the SPA rail) takes a
  partial `{notify?, muted?, starred?}` and returns `{membership, badges}`, pushing a fresh `badge` to
  the caller's sockets because muting changes the counts. It needs a membership row, so browsing a
  public channel you have not joined is a 403 while a channel you cannot see is a 404. The three
  fields were already on every `Membership` in `GET /api/channels`, so the rail reads them from there.
  `UpdateMembershipRequest` and `MembershipResponse` are additive types; `parseUpdateMembership` is
  the validator.
- **"Seen by" in direct and group conversations** (added after the first pass). Every
  `GET /api/channels/:id/messages` page carries `readCursors: ReadCursor[]` — the *other* members'
  `lastReadSeq` — for `dm` and `group` only; `public` and `private` omit the field, because a channel
  can hold the whole deployment and the caller's own cursor is already on their `Membership`. A manual
  unread marker is deliberately not reflected: it is a private note to yourself. The existing
  `{t:"read"}` server event gained an optional `userId` (the server always sets it; optional so a mock
  need not) and is now fanned out to the other members of a `dm` or `group` as well as to the reader's
  own tabs. A read in a public or private channel stays private to the reader.

## Stream B: SPA

Built 2026-09-20 against the contract in `src/shared/`, with a `VITE_CHAT_MOCK=1` transport
(`app/src/mock/`) standing in for stream A's routes. 133 SPA tests in `app/src/**/*.test.ts`
(`pnpm --filter gatekeeper-chat test:run` runs them after the workers-pool suite; `types:check`
now covers `app/` through `app/tsconfig.json`).

- [x] Vite + React 19 + TanStack Router + Tailwind v4 + Kumo + Phosphor under `app/`, `base: "/gatekeeper/chat/"`
- [x] Rail (Threads, Mentions, Drafts, Starred, Channels, DMs, unread and mention badges, muted state)
- [x] Conversation view: day dividers, grouping, "New messages" line, hover and keyboard actions, reactions, thread summaries, images with lightbox, file cards
- [x] Composer: Enter/Shift+Enter, Markdown, `@`/`#` autocomplete with id tokens, emoji picker, paste/drop uploads with progress, drafts per conversation
- [x] Thread pane, channel details pane, search view with qualifiers and jump-to-message, Files tab
- [x] History paging, permalinks `c/<channel>/m/<id>`, jump to latest — *"jump to date" is not built: `ListMessagesQuery` has no date cursor, so it needs a contract addition (see below)*
- [x] WebSocket client with jittered backoff and `since` catch-up; optimistic send with pending/failed/retry
- [x] Notifications: in-app toast, background-tab `Notification` (permission asked only from the settings opt-in), document title count
- [x] Embedded mode (`?embed=1`) and the `postMessage` bridge
- [x] Accessibility: focus, keyboard equivalents, live region, reduced motion; offline/reconnecting state
- [x] Narrow layout

**Contract gaps the SPA worked around.** All but two were closed in stream E, once the SPA ran
against the real Worker; the entries are kept so the reasoning survives:

- ~~**Mention token syntax.**~~ Closed. `app/src/lib/mentions.ts` now builds and parses the user half
  with `mentionToken` / `extractMentionIds` and `MENTION_TOKEN_SOURCE` from `src/shared/`, so there is
  one definition and the client cannot drift from the rows the object writes. `<#channelId>` stays
  client-only sugar over the same id charset, because the server stores no channel mention. The
  composer still holds the *display* form (`@Alice Chen`) and `resolveMentions` converts on send.
- **No `GET /api/mentions`.** Still true, still fine: the Mentions view runs the `to:me` search
  qualifier, which the contract already resolves server-side.
- ~~**No route for per-conversation `notify` / `muted` / `starred`.**~~ Closed. The store calls
  `PATCH channels/:id/membership` and adopts the response (badges included), rolling the optimistic
  change back and toasting on a refusal. The `localStorage` mirror is gone.
- ~~**`SearchHit.snippet` mark syntax is unspecified.**~~ Closed. The server emits exactly
  `snippet(messages_fts, 0, '<mark>', '</mark>', '…', n)`, so the renderer reinstates `<mark>` and
  nothing else; the `<b>` and `[[…]]` variants are gone.
- ~~**`GET messages?rootId=` does not say whether the root is included.**~~ Closed. It does
  (`root_id = ? OR id = ?` in `src/do/messages.ts`), which is also what the agent vendor needs, so the
  thread pane's `around=<rootId>` recovery pass is gone.
- **No date cursor for "jump to date"**, as above. Unchanged: it still needs a contract addition.
- **`Attachment` carries no URL.** Unchanged, and correct as it stands: the client builds one with
  `filePath()` and the `/files/:id` route serves it, authenticated; only the mock installs a resolver.

## Stream C: deployment wiring

- [x] `deployment.jsonc` `workers.chat` and `chat` block; `deploy.ts` builds and deploys chat before the Workshop and router
- [x] `GATEKEEPER_CHAT` bindings on router and Workshop; vars `CF_ACCESS_ISS`, `CF_ACCESS_AUD`, `ADMINS`, `PUBLIC_BASE_URL` (plus `MAX_UPLOAD_BYTES`); R2 bucket `FILES` provisioning. The Workshop's vendor binding is behind `chat.agentAccess` (default false) so the Workshop deploy cannot fail on a `GatekeeperVendor` entrypoint Stream D has not shipped yet; turn it on with that stream.
- [x] `--check` validation including "dev identity must be off in production" (any `DEV_*` var or required secret, in the base *or* generated config); `scripts/deploy.test.ts` coverage
- [x] `docs/customization.md` section and upgrade checklist note

## Stream D: agent access

Complete 2026-09-20. `packages/gatekeeper-chat/src/vendor/`, 23 tests in `__tests__/vendor.test.ts`.

- [x] `GatekeeperVendor`, `ChatAccount` (auto-provisioned, singleton), `ChatSession` (public channels: list, read, search; post as approval-gated action), `getTypeScriptTypes`, README
- [x] Tests for observer policy and action approval

Notes for the other streams:

- The vendor reaches chat through the **Durable Object's own HTTP API**, as the built-in `agent`
  identity (`src/vendor/bridge.ts`), never through SQLite. It uses `listChannels`, `listMessages`
  (with `before`, `limit`, `rootId`), `search` (`?q=&limit=&cursor=`), `sendMessage` and
  `deleteMessage`. Two expectations of stream A beyond the header contract: `?rootId=` returns the
  thread **including its root message**, and `GET /api/search` takes `q`, `limit` and `cursor`.
- `ChatGatekeeper` is a Durable Object class, so `wrangler.jsonc` and `wrangler.dev.jsonc` gained a
  `v1` migration for it and `worker-configuration.d.ts` lists it under `durableNamespaces`.
- Posts are **not simulated**: every submission sets `awaitDecision`, and `revertAction()` deletes
  the message. The observer policy accepts everyone, which is only sound while nothing private is
  reachable -- README.md, "Agent access", is the thing to read before `/admin` enables it.

## Stream E: end-to-end

Complete 2026-09-20 apart from the protected-deployment smoke, which needs a deployed hostname.

- [x] The SPA reconciled with the real API: every contract gap in stream B's list closed except the
      two noted there (no date cursor, no `GET /api/mentions`)
- [x] Playwright against `wrangler dev` with two dev identities, in `packages/gatekeeper-chat/e2e/`:
      13 scenarios (live delivery, threads, unread, mentions, mark-unread, private-channel
      invisibility, DM and "seen by", uploads of an image and a non-image, search qualifiers and
      Jump, permalink, narrow viewport, kill-and-restart reconnect with catch-up, 429 toast).
      Its own runner (`e2e/run.sh`), deliberately **not** in `test:run`; how to run it is in the
      package README.
- [x] Local-platform run through the router (`e2e/start-local-platform.sh`, the whiteboard's
      patched-launcher pattern plus `EXTRA_ROUTER_SERVICE` / `EXTRA_WRANGLER_CONFIGS`)
- [ ] Protected-deployment smoke: Access assertion present on HTTP and WebSocket upgrade, invalid
      assertion rejected — still open; it needs the deployed hostname, so it belongs with the release
      smoke test rather than here

**Bugs the integration found**, all of which only appear when the two halves run against each other:

- **The dev server could not boot at all.** `wrangler.dev.jsonc` carries the same `v1` migration for
  `ChatGatekeeper` as production, but `src/dev/entry.ts` exported only `ChatWorkspace`, and workerd
  refuses to start a Worker whose migration names a class it cannot find ("Class extends value
  undefined"). The dev entry now exports the vendor's classes too, and `__tests__/identity.test.ts`
  pins the two entries' exports to each other.
- **Nobody was in `#general`.** The channel was seeded with only the agent in it, so a person's first
  visit showed an empty rail and a "You are not in #general / Join" card for the one channel the
  server refuses to let anybody leave. `touchUser` now inserts the membership at the channel's
  high-water mark, so history is not unread (`__tests__/channels.test.ts`).
- **A stale asset answered with the app shell.** The `assets` binding reads its manifest at start-up,
  so rebuilding `app/dist` under a running `wrangler dev` made every hashed filename fall through the
  SPA fallback: the browser then reports "MIME type text/html" instead of a 404. A miss under
  `assets/` is now a 404 (`src/serve.ts`), and the README says to restart after a build.
- **Messages were silently marked read while you were elsewhere.** `activeChannelId` was set by
  `ChannelScreen` and never cleared, so anything arriving while you were on Threads, People, Search
  or Drafts was marked read and never badged. `ViewShell` now clears it.
- **A conversation created after the socket connected was invisible to it.** `sub` is a filter over
  the channels the socket named, so a new DM's `msg`, `read` and `typing` never arrived: the creator
  never saw the reply and the recipient never saw the conversation. The store now re-sends `sub`
  whenever a channel response lands, and refetches the rail when a `badge` names a channel it does
  not know (which is how the *recipient* of a new DM learns about it, since there is no
  "channel created" event).
- **The New message dialog was empty on a quiet deployment.** It filtered `state.users`, which only
  holds people this client has already seen; it now loads the directory the way the People view does.
- `RailToggle` in `AppShell.tsx` was dead code: the narrow layout's rail is opened by the
  "Conversations" button that `ConversationView` and `ViewShell` already render. Removed.

## Delight pass (after Stream B, before cleanup)

Ranked by effect against complexity; work top-down and stop at diminishing returns.

- [ ] 1. Unread return: "N new messages" pill when scrolled up, jump to first unread on entry, sticky date header
- [ ] 2. Reactions: recent-emoji quick picks, pop animation, "who reacted" tooltip
- [ ] 3. Send lifecycle: optimistic slide-in, pending state, inline retry; reduced-motion aware
- [ ] 4. Empty states: first-run `#general` card, channel header card on join
- [ ] 5. Composer smarts: URL-over-selection makes a link, pasted code becomes a fence, draft pencil in the rail
- [ ] 6. Quick switcher (`Ctrl/Cmd+K`) with fuzzy channels and people; `?` shortcut sheet
- [ ] 7. Landing inbox: greeting, unread digest, resume where you left off
- [ ] 8. Slash commands: `/me`, `/shrug`, `/topic`, `/mute`, `/dm`, `/search`
- [ ] 9. Images: aspect-ratio placeholders, blur-up, keyboard lightbox, download
- [ ] 10. Seen-by *avatars* in DMs and groups. The data and a plain "Seen by Alice" line landed in
      stream E (`readCursors` on the page, the `read` event's `userId`, `ConversationView`'s
      `data-testid="seen-by"` line); what is left is the avatar stack.

## Phase 2: dock fork commit (submodule)

- [ ] `ChatDock.tsx` in `AuthenticatedShell`, `chatDockBus.ts`, triggers in the sidebar utility strip and editor top bar, `/chat` route, feature flag
- [ ] Integration test; `docs/customization.md` note

## Phase 3 (follow-up)

- [ ] Web Push (service worker, VAPID secret, outbox)
- [ ] `@agent` mentions through `ExternalMessageGateway`

## Release

- [ ] `pnpm check`, package tests, review pass, simplification pass
- [ ] Commit on `chat`, fast-forward `main`
- [ ] `pnpm deploy`; record Worker versions; smoke test in a signed-in browser
- [ ] Update `chat.md` status line and this file
