# Phase 0 spikes

Results for the platform questions [chat.md](../../../docs/plans/chat.md) gates phase 1 on. Run
2026-09-20 on branch `chat`.

Every spike is an executable test, so these notes are a record rather than the evidence:

```
pnpm --filter gatekeeper-chat test:run       # spikes 1-3, plus the identity and contract suites
pnpm exec wrangler dev -c spikes/fts-dev/wrangler.jsonc --port 8799 && curl -s localhost:8799/fts
pnpm --filter gatekeeper-chat dev            # the whole Worker on a real workerd, dev identities
```

## Versions

| | |
| --- | --- |
| Node | v24.21.0 (fnm; the system Node is too old for the repo's `engines`) |
| pnpm | 11.17.0 |
| wrangler | 4.124.0 |
| workerd | 1.20260815.1 |
| `@cloudflare/vitest-pool-workers` | 0.20.3 (miniflare 5.20260801.1-alpha) |
| vitest / vite | 4.1.10 / 7.3.6 |
| compatibility date | `2026-08-04`, flags `allow_irrevocable_stub_storage` + `nodejs_compat` |

## Spike 1 — FTS5 in a SQLite Durable Object

**Question (chat.md phase 0, item 2):** does `CREATE VIRTUAL TABLE … USING fts5` work in a DO, and do
`snippet()` and `bm25()` behave?

**Answer: yes, in both vitest-pool-workers and a real `wrangler dev`.** Tests:
[`__tests__/spikes/fts.test.ts`](../__tests__/spikes/fts.test.ts) against
[`__tests__/spikes/fts-do.ts`](../__tests__/spikes/fts-do.ts); the `wrangler dev` half is
[`spikes/fts-dev/`](fts-dev).

What was verified:

- An external-content table (`content='messages'`, `content_rowid='rowid'`, `tokenize='unicode61'`)
  plus `AFTER INSERT/UPDATE/DELETE` triggers keeps itself in sync, and `('integrity-check', 1)` passes
  after every case below.
- `MATCH` on a term, `MATCH 'deploy*'` prefix queries, `snippet(messages_fts, 0, '<mark>', '</mark>',
  '…', 10)`, and `bm25(messages_fts)`.
- Ranking: `bm25()` is **negative**, and more matches means a *lower* number, so `ORDER BY score` is
  ascending. Measured through `wrangler dev`: three occurrences scored `-1.71875e-06`, one scored
  `-9.24e-07`. A descending sort would put the worst hit first.
- The deleted-message rule from the plan: blanking `body` removes the row from the index while the row
  itself survives (tombstone), and a hard `DELETE` removes both.
- Re-running the idempotent `CREATE … IF NOT EXISTS` statements in a second DO instance does not
  double-index.

Gotchas:

- **`sqlite_version()` is not callable.** The DO SQL gateway answers
  `not authorized to use function: sqlite_version at offset 7: SQLITE_ERROR`. There is no way to
  report the engine version from inside a Durable Object, so pin behaviour with tests, not a version
  check.
- **An external-content index cannot be updated in place.** The `AFTER UPDATE` trigger must first
  insert a `('delete', old.rowid, old.body)` command row and only then insert the new values. Getting
  that wrong leaves a deleted message findable, which is why `fts.test.ts` asserts the blanked case
  explicitly.
- **Every indexed column must be a real column of the content table.** This supports the plan's
  decision to index `body` alone: `author_name` and `channel_name` would have to exist on `messages`
  as denormalised, mutable copies. Filter on immutable ids in SQL after the text match instead.
- `snippet()`'s column argument is the 0-based index of the FTS column, not the joined table's.

## Spike 2 — WebSocket upgrade through a service binding

**Question (chat.md phase 0, item 1), local half:** does a WebSocket upgrade survive the router's
service binding and reach a hibernatable DO, and does the socket attachment survive eviction?

**Answer: yes.** Test: [`__tests__/spikes/websocket.test.ts`](../__tests__/spikes/websocket.test.ts).

The chain under test is `main -> ROUTER -> CHAT -> SpikeWs`, where `ROUTER` and `CHAT` are auxiliary
Workers (`miniflare.workers` in [`vitest.config.ts`](../vitest.config.ts)). The router is a copy of
`cloudflare-os/packages/router/src/index.ts`'s prefix match and does nothing special for the upgrade —
which is the point: it is just a request with headers.

What was verified:

- `env.ROUTER.fetch(url, { headers: { Upgrade: "websocket" } })` returns `101` with a live
  `response.webSocket` two service-binding hops away from the DO.
- `ctx.acceptWebSocket(ws, [userId])` plus `serializeAttachment()` / `deserializeAttachment()` /
  `webSocketMessage` / `webSocketClose`.
- `ctx.getWebSockets(tag)` fan-out: a second socket opened with the same tag receives a message sent
  by the first, and a socket with a different tag receives nothing.
- The attachment survives a full teardown: `evictDurableObject(stub, { webSockets: "hibernate" })`,
  then the next frame continues the counter that lived only in the attachment.

Gotchas:

- **The pool's runner Worker gets a generated, per-project name**
  (`getRunnerName()` in `@cloudflare/vitest-pool-workers`), so an auxiliary Worker cannot bind back to
  the Worker under test. Anything that has to be reached *through* another Worker therefore needs its
  DO in an auxiliary Worker too, and auxiliary Workers are handed straight to Miniflare: plain
  JavaScript, no TypeScript, no workspace imports. Hence the small duplication between
  [`aux/chat.js`](../__tests__/spikes/aux/chat.js) and
  [`ws-do.ts`](../__tests__/spikes/ws-do.ts) — the latter exists only so `evictDurableObject()`, which
  works on `main`-Worker classes only, has something to evict.
- `evictDurableObject` defaults to `webSockets: "hibernate"`; pass `"close"` to test the other path.

Still open (needs a protected evaluation deployment, not a local run): that
`cf-access-jwt-assertion` is present on the upgrade behind Cloudflare Access, and that a missing or
invalid assertion is rejected there.

## Spike 3 — `assets` under a base prefix, through a service binding

**Question (chat.md phase 0, item 3):** does the `assets` binding serve a Vite build with
`base: "/gatekeeper/chat/"` when the Worker is reached over another Worker's service binding?

**Answer: yes, but the Worker must strip the prefix before calling the binding.** Test:
[`__tests__/spikes/assets.test.ts`](../__tests__/spikes/assets.test.ts), and confirmed again by curl
against `wrangler dev`.

**The finding, and the one thing this spike changed in the plan.** The asset server resolves a URL
path against the asset *directory*; it knows nothing about Vite's `base`. Measured on the binding
directly:

| request | result |
| --- | --- |
| `/` | 200 `text/html` |
| `/index.html` | 200 `text/html` |
| `/assets/index-<hash>.js` | 200 `text/javascript` |
| `/gatekeeper/chat/` | **404** |
| `/gatekeeper/chat/index.html` | **404** |
| `/gatekeeper/chat/assets/index-<hash>.js` | **404** |

Vite's `base` still has to be `/gatekeeper/chat/`, because that is what the browser requests. So
`src/serve.ts` strips `CHAT_PREFIX` from the path before `env.ASSETS.fetch()`. The alternative —
building into `app/dist/gatekeeper/chat/` so the on-disk layout mirrors the URL — was rejected because
it makes `vite preview` and the SPA's own dev server awkward for no gain: with
`assets.run_worker_first: true` every asset request already passes through the Worker, so the rewrite
costs nothing. `assets.test.ts` asserts the 404 as well as the 200, so if a future wrangler starts
stripping the prefix the test fails and the rewrite can go.

Two more things fell out of it:

- **`run_worker_first` has a Miniflare spelling.** In `vitest.config.ts` (and any hand-written
  Miniflare config) it is `assets.routerConfig.invoke_user_worker_ahead_of_assets: true` together with
  `has_user_worker: true`. Without it the asset server answers first and `/gatekeeper/chat/ws` 404s
  before the Worker ever sees it.
- **Never forward a redirect from the asset server.** Asking it for `index.html` triggers
  `html_handling` and comes back as a redirect to `/` — a Location that has lost the prefix and would
  bounce the browser out of the app. `serveApp()` therefore forwards only 2xx and 304, requests the app
  base (not `index.html`) for the SPA fallback, and deletes `location` from the shell response. This
  was a live bug caught by curl against `wrangler dev` and not by the vitest assets suite, whose
  `html_handling` defaults differ.

The shell comes back with `cache-control: public, max-age=0, must-revalidate` from the asset server.
That is acceptable for the shell (no user data), but note that API and file responses set
`private, no-store` themselves in `src/http.ts` and never go near the asset server.

## Not covered here

Items 4 (Access display names via `/cdn-cgi/access/get-identity`), 5 (Web Push) and 6 (the
`WORKSHOP_GATEWAY` external message gateway) of chat.md's phase 0 are untouched. Item 4 in particular
gates the display-name story: until it is settled, `src/access.ts` deliberately takes the name from
nowhere and the DO falls back to the email local part, with a `display_name` profile override column
already in migration 1.
