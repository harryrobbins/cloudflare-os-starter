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

Stream 0 already provides: `src/access.ts` (verification), `src/serve.ts` (`originAllowed`, DO
forwarding, the `x-chat-user` contract), `src/migrations.ts` (the runner; append version 2 onwards) and
`src/workspace.ts` (`GET /api/me`, the `users` upsert). Build on those rather than replacing them.

- [ ] Access JWT verification (`jose`) on every request and WebSocket upgrade; `Origin` check on upgrades and writes — *HTTP done in stream 0; the upgrade path lands with the WebSocket handler*
- [ ] `ChatWorkspace` DO: numbered idempotent migrations, schema from the plan, `#general` seeded — *runner and `users` done in stream 0*
- [ ] Users, channels, memberships, join/leave/archive, admin list from `ADMINS`
- [ ] Messages: send (idempotent `clientId`), edit, delete (tombstone rule), threads with `reply_count`, reactions, mentions by user id
- [ ] Unread: `last_read_seq`, manual unread marker, thread follows, badge summary
- [ ] Search: FTS5 with qualifier parser, membership filter, `snippet()`, cursor paging
- [ ] Uploads: multipart with hard byte cap, pending R2 object with expiry, atomic attach on send, magic-number image sniff, authenticated `files/:id` and thumb, cleanup alarm
- [ ] WebSocket protocol: `sub`, `typing`, `read`, `ping`; server events; per-user tags; membership rechecked per command; presence with heartbeat expiry
- [ ] Rate limits per user (messages, uploads, search)
- [ ] Structured, redacted logs
- [ ] Unit tests (vitest-pool-workers): migrations, unread arithmetic, search qualifiers, membership on every path, idempotency, rate limits

## Stream B: SPA

- [ ] Vite + React 19 + TanStack Router + Tailwind v4 + Kumo + Phosphor under `app/`, `base: "/gatekeeper/chat/"`
- [ ] Rail (Threads, Mentions, Drafts, Starred, Channels, DMs, unread and mention badges, muted state)
- [ ] Conversation view: day dividers, grouping, "New messages" line, hover and keyboard actions, reactions, thread summaries, images with lightbox, file cards
- [ ] Composer: Enter/Shift+Enter, Markdown, `@`/`#` autocomplete with id tokens, emoji picker, paste/drop uploads with progress, drafts per conversation
- [ ] Thread pane, channel details pane, search view with qualifiers and jump-to-message, Files tab
- [ ] History paging, permalinks `c/<channel>/m/<id>`, jump to date/latest
- [ ] WebSocket client with jittered backoff and `since` catch-up; optimistic send with pending/failed/retry
- [ ] Notifications: in-app toast, background-tab `Notification`, document title count
- [ ] Embedded mode (`?embed=1`) and the `postMessage` bridge
- [ ] Accessibility: focus, keyboard equivalents, live region, reduced motion; offline/reconnecting state
- [ ] Narrow layout

## Stream C: deployment wiring

- [x] `deployment.jsonc` `workers.chat` and `chat` block; `deploy.ts` builds and deploys chat before the Workshop and router
- [x] `GATEKEEPER_CHAT` bindings on router and Workshop; vars `CF_ACCESS_ISS`, `CF_ACCESS_AUD`, `ADMINS`, `PUBLIC_BASE_URL` (plus `MAX_UPLOAD_BYTES`); R2 bucket `FILES` provisioning. The Workshop's vendor binding is behind `chat.agentAccess` (default false) so the Workshop deploy cannot fail on a `GatekeeperVendor` entrypoint Stream D has not shipped yet; turn it on with that stream.
- [x] `--check` validation including "dev identity must be off in production" (any `DEV_*` var or required secret, in the base *or* generated config); `scripts/deploy.test.ts` coverage
- [x] `docs/customization.md` section and upgrade checklist note

## Stream D: agent access

- [ ] `GatekeeperVendor`, `ChatAccount` (auto-provisioned, singleton), `ChatSession` (public channels: list, read, search; post as approval-gated action), `getTypeScriptTypes`, README
- [ ] Tests for observer policy and action approval

## Stream E: end-to-end

- [ ] Playwright against `wrangler dev` with two dev identities: live updates, unread, threads, search, upload, reconnect
- [ ] Local-platform run through the router (`start-local-platform.sh` pattern)
- [ ] Protected-deployment smoke: Access assertion present on HTTP and WebSocket upgrade, invalid assertion rejected

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
