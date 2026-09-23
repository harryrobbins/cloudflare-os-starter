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
      patched-launcher pattern plus `EXTRA_ROUTER_SERVICE`). **Reworked 2026-09-21 into two
      `wrangler dev` processes** joined by wrangler's local dev registry, because the first version
      (the chat config appended to the platform's multi-config run) silently served the chat app's
      `index.html` as the shell's `/`: the Workshop backend and the chat Worker both carry an `assets`
      directory and one workerd serves one of them. Every chat path looked fine, which is why the
      2026-09-20 verification passed. The registry needs the same wrangler version on both sides (the
      submodule's older one prunes the entry the package's newer one writes: 503 within a minute) and
      the chat process started after the platform. The script and the package README say all this.
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

Complete 2026-09-21, all ten items. 217 Worker tests and 254 SPA tests green
(`pnpm --filter gatekeeper-chat test:run`), `types:check` clean, no lint findings in the package,
13/13 Playwright scenarios green. **The Worker is untouched**: every change is under `app/`, plus two
lines in `docs/plans/chat.md` and two e2e assertions noted at the end.

First, a divergence closed: **the client no longer counts `@channel` or `@here` as mentions.**
`extractMentionIds` only ever writes `<@id>` rows, so a badge for a bare form vanished on the next
`badge` event or reload. `mentionsUser` now matches `kind === "user"` alone (`app/src/lib/mentions.ts`);
chat.md still gates the two bare forms behind explicit limits.

- [x] 1. Unread return: a "N new messages ↓" pill counting what arrived below since the reader left
      the bottom, a "Jump to first unread" pill when the New-messages rule opens above the viewport
      (it grows the mounted window when the rule is beyond it, and retires once the rule is reached),
      and the sticky date band made opaque with a soft tail so it stays legible over the scroll.
- [x] 2. Reactions: a quick-pick row driven by a localStorage frequency table (`lib/reactions.ts`,
      shared by the hover bar and a "Frequently used" group at the top of the picker), a `chat-pop`
      scale on any count change including somebody else's, and a `describeReactors` tooltip and label
      ("You and Bob Okafor reacted with 👍").
- [x] 3. Send lifecycle: an optimistic row enters with `chat-rise`, keyed on `local` so the entrance
      does not replay when the row is re-keyed under its server id; pending is a 40%-opacity timestamp
      and no spinner; a failure is a quiet inline "Not sent · Retry · Discard" with the cause on the
      tooltip. All reduced-motion aware through the stylesheet's existing block.
- [x] 4. Empty states: `ChannelStartCard` at the top of history (topic, purpose, creator and date,
      member count, Join when not a member) and a `FirstRunCard` for a `#general` with no human
      messages yet -- what the channel is, and three next steps.
- [x] 5. Composer smarts: `lib/paste.ts` turns a URL pasted over a selection into a Markdown link and
      a multi-line paste that scores as code into a fenced block, each with an eight-second Undo hint
      (a programmatic `setDraft` is invisible to the textarea's undo stack); a pencil marks every rail
      row holding an unsent draft, threads included.
- [x] 6. Quick switcher on `Ctrl/Cmd+K` and from the rail's box: `lib/fuzzy.ts` ranks channels and
      people with word-start and prefix bonuses and highlights the hits, recency wins an empty query
      (`store/recents.ts`), `#` and `@` narrow it, and the last row hands off to the search view.
      Plus a `?` sheet listing every shortcut, suppressed while a text field has focus.
- [x] 7. Landing inbox at `/`: `lib/digest.ts` computes greeting, mentions, unread (direct messages
      first), followed threads with new replies and recent conversations; "Pick up where you left
      off" resumes the last channel. Redirecting straight to a conversation is now opt-in
      ("Skip the inbox" in Settings).
- [x] 8. Slash commands: `lib/slash.ts` parses `/me`, `/shrug`, `/topic`, `/mute`, `/unmute`, `/dm`
      and `/search`, with an inline picker while typing `/…`. **Only a known command is intercepted**,
      so `/deploy the thing` still posts, and no escape syntax is needed.
- [x] 9. Images: the aspect-ratio box is now reserved for unmeasured images too, a shimmer fills it
      until `load` (and a cached image that completed before React attached is handled), and the
      lightbox pages through a message's images with ←/→, Home/End and Esc, showing "2 of 3".
- [x] 10. Seen-by avatars: `lib/seen.ts` places each other member's monogram after the last message
      they have read, stacked where several share a position, with `describeSeen` as the tooltip and
      the accessible label. **Times are shown only for a read this tab watched arrive** over the
      socket (`ChatState.readCursors` gained a client-side `seenAt`): `ReadCursor` carries a sequence
      number and nothing else, so a time for a cursor that arrived with the page would be invented.
      Giving every cursor a real time needs an additive `readAt` on the contract plus a migration and
      a write-path change, which is more than a tooltip is worth.

Also landed in this pass, because the shell's dock needed it:

- **`?embed=1` and `?compact=1` are now separate.** `embed=1` means only "a shell is listening on
  `postMessage`"; the single-column layout applies when `compact=1` is present *or* the viewport is
  narrow, exactly as the narrow rule always worked. `parseEmbedOptions` in `app/src/lib/bridge.ts`
  (with its own tests), `ChatState.compact`, and `AppShell`'s `narrow` now reads `compact`. The shell
  loads the dock with `?embed=1&compact=1` and the full `/chat` page with `?embed=1` alone, so that
  page is bridged *and* wide.

Two things the mock had wrong, found while building against it and fixed to match `src/do/`:

- `badgeSummary` counts every live message above the cursor, thread replies included; the mock
  excluded replies, so the rail (membership arithmetic) and the badge summary disagreed in `#general`.
- `GET channels/:id/messages` returns `readCursors` for `dm` and `group`; the mock never sent them,
  so nothing exercised the seen-by markers.

Two e2e assertions were rewritten for intentional UI changes, not to paper over a break: T7 reads the
seen-by marker's `aria-label` now that the line is an avatar stack, and T9 reaches the search view
through the switcher's hand-off row and matches "Jump" exactly (the rail's own button is called
"Search or jump to…").

## Phase 2: dock fork commit (submodule)

Complete 2026-09-21 as one commit on the fork branch `feat/chat-dock`, from `a1909a38`
(`gadgetViewer`), amended the same day after the live check below (`78962428`; the branch is local
to this machine, not yet pushed to the fork). Frontend only: 6 new files, 4 call sites and one line
of `index.html`, plus the generated route tree. 184 frontend tests green
(`pnpm --filter @gadgets/workshop-frontend test:run`, 7 of them new),
`tsc --noEmit` and `tsc -p tsconfig.vite.json` clean, `vite build` clean with the flag on and off.

- [x] `src/components/ChatDock.tsx`: the drawer (`fixed`, full height, 420px, `z-[1200]` — above the
      activity popover's 1100, below the command palette's 1500) mounted once in `AuthenticatedShell`
      beside `AccountSelectionModal`, so it also covers the fullscreen workspace editor; the
      same-origin `<iframe src="/gatekeeper/chat/?embed=1&compact=1">`; the bridge, origin-checked
      against `window.location.origin` *and* the frame's own `contentWindow`; `chat:badge` into the
      bus, `chat:notify` into a Kumo toast whose action opens the dock at the permalink, `chat:expand`
      into a `/chat` navigation, `chat:theme` / `chat:visible` / `chat:open` out; Esc, and
      Ctrl/Cmd+Shift+L (Ctrl/Cmd+K is the palette's own and Shift+C is Chrome's inspector); an
      unavailable state with Retry that never removes the trigger
- [x] `src/chatDockBus.ts`: the flag, the two path bases, open/close/toggle, the badge store
      (`useSyncExternalStore`-shaped) and the path conversions, in `commandPaletteBus.ts`'s style
- [x] `src/components/ChatTrigger.tsx`: the rail row (dot for unread, count for mentions) in
      `Sidebar.tsx`'s primary nav, and the icon button beside `ActivityNotifications` in
      `GadgetEditor.tsx`'s top bar; plus a flag-gated "Toggle chat" command in `CommandPalette.tsx`,
      because a chord nobody is told about is not a way in
- [x] `src/routes/chat.tsx` and `src/routes/chat_.$.tsx` (`chat_` so `/chat/$` does not nest inside
      the `/chat` component, the `gatekeepers_.$appId` shape), title "Chat"
- [x] `VITE_CHAT_DOCK` gates all of it; `scripts/deploy.ts` sets it when `chat.enabled`, with a test
      in `scripts/deploy.test.ts`
- [x] `src/ChatDock.integration.test.tsx` next to `GadgetUI.integration.test.tsx`; the Team chat
      section and the upgrade checklist in `docs/customization.md`

Decisions worth knowing:

- **The bridge types are re-declared in the shell, not imported.** `packages/gatekeeper-chat` is not a
  dependency of the submodule and must not become one: the commit has to keep applying to an upstream
  tree that has never heard of chat. `protocol.ts` remains the one definition of the wire format, and
  this file's comment says where it is.
- **The handshake is an inbound message, not the iframe's `load` event.** `load` also fires for the
  router's 404 page and for an Access sign-in redirect, both of which are a blank drawer; the app
  posts its badge totals as soon as its store starts, so that is the proof. No inbound message within
  15s shows the unavailable state with Retry, and any later message heals it. This is also why
  `chat:theme` / `chat:visible` are posted on that signal rather than on mount: the app's listener is
  attached after an `await` in its `main()`, so a post on `load` can be dropped.
- **The mounting path rides in the `src`; only later changes are `chat:open`.** A permalink opened
  cold therefore never waits on the handshake, and an in-shell navigation keeps the socket, the drafts
  and the scroll position.
- **The frame is unmounted 60s after the drawer closes**, and rebuilt on the next open. The plan says
  to close the socket when the dock is hidden; the app owns its socket and reacts to
  `chat:visible false`, so the shell's lever is the frame itself.
- ~~**The `/chat` page also embeds with `?embed=1`**, so the bridge works there too, but embedded mode
  forces the compact one-column layout.~~ Closed in the delight pass: `?embed=1` and `?compact=1` are
  now separate flags (`parseEmbedOptions` in `app/src/lib/bridge.ts`, `ChatState.compact`). `embed=1`
  means only "a shell is listening on `postMessage`"; the single-column layout applies when
  `compact=1` is present *or* the viewport is narrow, exactly as the narrow rule always worked. The
  shell loads the dock with `?embed=1&compact=1` and the full `/chat` page with `?embed=1` alone, so
  that page is bridged and wide.
- **With the flag off the bundle keeps `chatDockBus.ts`'s constants** (a few hundred bytes, because
  `__root.tsx` imports the flag from it) and the route chunks' "not enabled" message. The dock, the
  triggers, the iframe and the bridge are all gone — verified by grepping `dist/assets` after a build
  each way.

## Live dock check through the router (2026-09-21)

`packages/gatekeeper-chat/e2e/dock-check.mjs`, a Playwright run against the two-process local
platform, driving the shell (fork commit `feat/chat-dock`, amended to `78962428` from `9b5516ae`;
the gitlink follows) against this Worker through the real router: 17 steps, all green at the end,
and the standalone 13-scenario suite still green afterwards. Two browser contexts, one in the shell
and one on the standalone chat page. Three real bugs, none of which the unit or integration tests
could see because each needs the shell, the frame and the Worker together:

- **The shell's CSP blocked the dock outright.** `workshop-frontend/index.html` carries
  `<meta http-equiv="Content-Security-Policy" content="frame-src srcdoc:;">` ("prevents Gadget UI
  frames from navigating away from their srcdoc. DO NOT REMOVE"), so every `<iframe
  src="/gatekeeper/chat/…">` was refused with "Framing … violates the following Content Security
  Policy directive". The dock commit never touched the file. It now reads `frame-src srcdoc: 'self'`,
  with the comment extended: gadget frames stay sandboxed, and nothing off this origin can be framed
  either way. Folded into the fork commit.
- **Notifications never left a closed drawer.** The store forwarded to the shell only when
  `document.visibilityState === "hidden"`; a frame inside a `display: none` drawer still reports a
  visible document, so the toast rendered inside the iframe nobody could see. Embedded, every
  notification now goes to the shell (`#maybeNotify` in `app/src/store/store.ts`, with a store test).
  The badge was unaffected, which is why the sidebar count worked while the toast did not.
- **Two frames on `/chat`.** `ChatPage` closed the dock but a plain close keeps the drawer's frame
  for its 60 s grace, so the page ran two sockets on one conversation for a minute and the "one frame
  at a time" comment was wrong. `closeChatDock({ unmount: true })` drops it immediately (bus, dock,
  and an integration test; folded into the fork commit).

Also found and fixed on the way, from chat.md's security checklist: **the chat app's own HTML sent no
CSP.** `src/serve.ts` now sets `default-src 'self'; script-src 'self'; style-src 'self'
'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' <ws origin>;
worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self';
frame-ancestors 'self'` plus `nosniff` and `referrer-policy` on every HTML response, and nothing on
hashed assets. `script-src 'self'` meant moving the theme bootstrap out of `index.html`'s inline
script into `app/public/theme-boot.js`; the test asserts the served shell has no inline script.
`'unsafe-inline'` for styles is deliberate (React and the picker set style attributes; the policy is
against script injection).

## Review and simplification pass (2026-09-21)

Worker-side, on top of the streams above. Nothing changed shape on the wire.

- **Three SQL helpers in `src/do/context.ts`** replaced the same `.toArray()[0] ?? null` and
  per-column `UPDATE` patterns across the modules: `firstRow`, `scalar` (which folds `MAX` over no
  rows and `COUNT` into one fallback) and `updateRow` (one statement for a partial patch, so a row is
  never seen half-updated and the three `transactionSync` blocks are gone). `idArray` in
  `validate.ts` is the one bounded-deduplicated-identifier list every inbound list now goes through.
- **Findings fixed with tests:** a followed thread in a channel the follower was removed from, or
  has muted, badged forever (the Threads view filters by visibility, so nothing could clear it); a
  lone `%` in `/files/:id` threw a `URIError` out of the object, which the runtime answered with a bare
  500 and a stack trace (`matchFilePath` in `routes.ts` decodes without throwing); and any exception
  inside the object did the same, so `ChatWorkspace.fetch` now answers the contract's `internal`
  error envelope and logs the cause without the request or the identity. `leaveChannel` explains why
  a conversation cannot be left (`unleavableReason`); `recipientsOf` no longer loads a member list it
  will not use for a public channel; the `typing` handler had two access checks that agreed; the
  search runs one query shape with two SQL texts.
- **Removed:** dead exports (`methodNotAllowed`, `effectiveReadSeq`, `resetTypingThrottle`,
  `channelMemberIds`, `MentionKind`, the `*EventType` aliases, a `MAGIC.at` offset nothing used) and
  a second `delete` before `set` on the identity header.

## Phase 3 (follow-up)

- [ ] Web Push (service worker, VAPID secret, outbox)
- [x] `@agent` mentions through `ExternalMessageGateway` (branch `chat-agent`, 2026-09-23). One "Chat
      agent" workspace per person rather than per channel (the Overseer is owned by its first caller);
      outbox as schema version 3; `ChatAgentReply` as the stored reply target; `chat.agentReplies` in
      deployment.jsonc (default on); a fork fix to the Overseer (`57aa6553`), which called `dup()` on a
      service stub. Proved end to end against the real Workshop by `e2e/agent-check.mjs` (10/10, fake
      model) -- README, "Agent".
- [x] People lists everyone who has signed in to the platform: the shell's dock posts `/api/me/seen`
      once per session (fork `07046b97`), and one `directoryFilter` decides who sees whom.
- [x] Authors a tab has never seen are named, not "Unknown": `msg` carries its author, and the store
      resolves any other unknown id through `GET /api/users?ids=`.

## Release

- [x] `pnpm check` (needs Docker Desktop up for the gatekeeper-runtime image, even in dry run),
      package tests, review pass, simplification pass (above)
- [ ] Commit on `chat`, fast-forward `main`
- [ ] `pnpm deploy`; record Worker versions; smoke test in a signed-in browser
- [ ] Update `chat.md` status line and this file
