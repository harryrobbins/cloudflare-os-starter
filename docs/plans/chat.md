# Plan: team chat (Slack-like) for Cloudflare OS

Written 2026-09-20 against the pinned submodule (fork branch `starter-openrouter`, gitlink 90f0591 plus the `gadgetViewer` commit). Status: **planning, not started**.

Goal: a Slack-like chat for everyone who can sign in to this deployment. Channels, direct messages and threads; unread and mention tracking; search across everything; history and permalinks; image and file uploads; a chat pane reachable from any page; and system notifications that land you somewhere you can reply. The agent can read and post.

Background: [gadget-collaboration-runtime.md](../research/gadget-collaboration-runtime.md), [gadget-connectors-and-services.md](../research/gadget-connectors-and-services.md), [gadget-viewer-identity.md](../research/gadget-viewer-identity.md), and the [master collaboration plan](collaborative-blueprints.md). The Wave (`packages/blueprint-wave`) is the closest thing built so far and explicitly scoped out attachments, notifications, cross-wave search and personal unread state because the gadget runtime cannot provide them.

## The decision: a Chat Gatekeeper, not a gadget

**Review note (2026-09-20):** The starter has no chat Worker or `GATEKEEPER_CHAT` binding yet. The router will route that binding once `scripts/deploy.ts` generates it. The Workers Chat Demo is a transport example, not an application template: it has no Access identity, membership model, search, uploads, or delivery guarantees. Phase 0 gates the platform and identity assumptions below before committing to the full feature set.

Chat needs four things the gadget runtime does not have, all verified in the research docs and re-checked for this plan:

| Need | Gadget | Gatekeeper Worker |
| --- | --- | --- |
| Verified caller identity (who sent, who read) | None; names arrive as spoofable RPC arguments | Access JWT on every request at `/gatekeeper/chat/*` (`cf-access-jwt-assertion`, verified with `jose` exactly as `workshop-backend/src/access.ts` does) |
| One shared space for the whole deployment | Every gadget is a user-created workspace shared by explicit invitation; no "everyone" sharing | A Durable Object by name (`idFromName("main")`) that every signed-in user reaches |
| Blob storage and a URL to serve it | None; only `data:` URLs through a 45 calls/s RPC path | Own R2 bucket plus an authenticated GET route |
| Search index | None (only linear `includes()` scans exist upstream) | DO SQLite supports FTS5 ([docs](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)) |
| Cheap always-on connections, notifications when no tab is open | An open RPC channel keeps the facet billable; no Notification API in an opaque-origin iframe | Hibernatable WebSockets; a real origin for the Notification API, a service worker and Web Push |

So chat is a deployment-owned Worker, `packages/gatekeeper-chat`, deployed as `cfos-chat`, following the existing `packages/custom-gatekeeper` shape. It is three things at once:

1. **An app and API at a real origin.** The router already proxies `/gatekeeper/chat` and `/gatekeeper/chat/*` (including WebSocket upgrades) to whatever is bound as `GATEKEEPER_CHAT` (`cloudflare-os/packages/router/src/index.ts:28-35`). The chat SPA, its JSON API, its WebSocket and its file downloads all live there, behind Cloudflare Access like everything else on the hostname.
2. **A Gatekeeper vendor** with an auto-provisioned ambient account (like Scheduler), so the agent in every workspace gets a `ChatSession` capability: list channels, read, search, post (posts are actions that go through the approval queue).
3. **An external message gateway client**, so an `@agent` mention in a channel becomes a prompt to a real agent chat via the Workshop's `ExternalMessageGateway` entrypoint and the reply comes back as a chat message.

The Workshop frontend is not involved in phase 1 at all. Phase 2 adds one small fork commit that mounts the chat app as a persistent dock in the shell; it is sized in [Phase 2](#phase-2-the-dock-a-small-fork-commit) and is optional, because phase 3's Web Push notifications also satisfy the "notification takes you somewhere you can reply" fallback with no core change.

### Alternatives considered

- **A gadget/format like the Wave.** Rejected for the table above. It would also be one chat per workspace, shared by link, which is a document, not a team chat.
- **A sandboxed gatekeeper app page** (`GatekeeperUser.startAppUi`, hosted at `/gatekeepers/<id>` with a sidebar entry for free). Attractive, but the frame is `sandbox="allow-scripts allow-modals"` with `connect-src 'none'` (`workshop-frontend/src/SandboxedGatekeeperApp.tsx:363-367`): no WebSocket, no upload path except bytes over the rate-limited RPC relay, no Notification API, no deep links, and the account is minted by `createAccount()` with no identity (`workshop-shared/src/gatekeeper.ts:523-531`), so who is talking would still need a kernel patch. It gets us the same sidebar entry that the phase 2 fork commit gives, at the cost of every other feature. Not worth it.
- **Slack itself via `gatekeeper-slack`.** Its data model is a good reference (`cloudflare-os/packages/gatekeeper-slack/src/types.d.ts`), but it needs a Slack workspace and never downloads file content. The ask is chat inside this deployment.

## User experience

### Where chat lives

- **Full page:** `/gatekeeper/chat/` (phase 1), also mounted in the shell at `/chat` with the normal sidebar (phase 2). The full page is the Slack layout: channel rail, conversation, right-hand thread or detail pane.
- **Dock (phase 2):** a chat button with an unread badge in the sidebar utility strip and, on the fullscreen workspace editor, in the editor's top bar. It opens a right-hand drawer containing the same app in compact mode (rail collapses to a picker at the top). Keep one connection per visible tab; when the dock is hidden, close its socket after a short grace period and refresh badges on visibility change or reopen. Esc closes; a button expands to the full page at the same place. Keyboard: `Ctrl/Cmd+Shift+C` toggles it unless the shell already owns that shortcut.
- **Notifications:** in-app toast (Kumo `Toasty`) when a message arrives for you and the conversation is not on screen; browser notification when the tab is in the background; Web Push when no tab is open (phase 3). Every notification carries a permalink; clicking it opens the dock or page at that message with the composer focused.

### Layout of the full page

```
+-------------+---------------------------------------------+----------------------+
| [search  ⌘K]| # general   Topic: release week   12 members | Thread               |
| Threads  3  |---------------------------------------------| Alice  10:02         |
| Mentions 1  | ── Yesterday ──                             |  can we ship today?  |
| Drafts      | Alice 10:02  can we ship today?             |  ↳ 4 replies         |
|             |   ↳ 4 replies · last 10:40      [👍2]       |----------------------|
| CHANNELS    | Bob 10:05  build is green [img]             | Bob 10:10 yes if...  |
| # general   | ── New messages ──                          | Harry 10:40 done ✓   |
| # design  ● |  Cara 10:41 @harry can you look at the...   |                      |
| # random    |                                             | [Reply in thread   ] |
| DIRECT      |---------------------------------------------|                      |
| ● Alice     | [ Message #general           📎 😊  ↵ ]     |                      |
| ○ Bob   2   |                                             |                      |
+-------------+---------------------------------------------+----------------------+
```

- **Rail:** Threads, Mentions and reactions, Drafts at the top, then Starred, Channels, Direct messages. Unread conversations are bold; a mention count shows as a badge; muted ones are dimmed. Browse channels and New message live at the bottom of each group.
- **Conversation:** day dividers; consecutive messages from one author within five minutes are grouped; a "New messages" line at the first unread; hover actions (react, reply in thread, copy link, edit or delete your own, mark unread from here); reactions row; thread summary line with avatars and reply count; images inline with a lightbox; other files as cards.
- **Composer:** Enter sends, Shift+Enter is a newline; Markdown shortcuts (bold, italic, code, code block, quote, lists, links); `@` autocomplete over people and `@agent`; `#` autocomplete over channels; `:` emoji picker; paste or drop images and files; a queued upload shows a thumbnail with progress and can be removed before sending; drafts persist per conversation.
- **Right pane:** the open thread, or channel details (topic, members, pinned messages, files), or a search result's context.
- **Narrow widths:** one column at a time with a back button; the dock uses this mode. Preserve the selected channel, thread, scroll anchor and draft across dock/page transitions. Provide visible focus, keyboard equivalents for hover actions, live announcements for new messages without moving focus, reduced-motion support, and a recoverable offline/reconnecting state.

### Unread and mention model

- Every conversation keeps a per-member `last_read_seq`. A message is unread if its `seq` is above it.
- A conversation is marked read when it is visible, the window is focused, and the list is scrolled to the bottom. Scrolling up keeps the "New messages" line; "Mark unread from here" uses a separate per-user manual unread marker, since moving `last_read_seq` backward would re-notify old mentions and conflict with another tab's read acknowledgement.
- Threads are separate: you follow a thread when you start it, reply to it or are mentioned in it; followed threads with unseen replies appear under Threads with their own count.
- Mentions use immutable user IDs from autocomplete tokens, resolved and checked server-side at post time; display names are neither unique nor stable. Ship `@user` and `@agent` first; gate `@channel` and `@here` behind explicit limits and permissions to prevent team-wide notification spam. Per-conversation preference: all messages, mentions only, or nothing; muted conversations never badge.
- The document title shows the mention count (`(2) Chat`); the dock button shows a dot for unread and a number for mentions.

### Search

- One search box (`Ctrl/Cmd+K` on the chat page). Plain words search message text; qualifiers narrow it: `in:#design`, `from:@alice`, `to:me`, `has:image`, `has:file`, `has:link`, `is:thread`, `before:2026-09-01`, `after:`, `on:`.
- Results are grouped by conversation, newest first, with FTS5 `snippet()` highlights, the author, the time, and a "Jump" that opens the conversation scrolled to that message with it highlighted. Thread replies show their root.
- The same box matches channel names and people, shown above message results.
- Files tab: attachments only, filterable by type and uploader.

### History and permalinks

- Infinite scroll upwards by sequence cursor; "Jump to date" and "Jump to latest".
- Every message has a permalink `/gatekeeper/chat/c/<channel>/m/<messageId>` (`/chat/...` inside the shell in phase 2). Opening it loads the surrounding page of messages and highlights the target.
- Edits keep an "edited" marker; deletes leave a tombstone in threads that have replies and vanish otherwise. No history playback (that is the Wave's job).

### People and identity

- Signing in through Access is membership. Nobody is invited, approved or asked for a name. Display names come from Access identity (`/cdn-cgi/access/get-identity`, which returns `name` and `email`), falling back to the email's local part; see [account attribution](collaborative-blueprints.md#viewer-identity-and-change-attribution) for the rule.
- A person appears in the directory the first time they open chat. A DM to an address that has not appeared yet requires a verified directory source for allowed Access users; until then, allow DMs only to people who have opened chat. Do not expose whether an arbitrary email is allowed to sign in.
- Presence: green dot while a WebSocket for that user is connected; typing indicators in the open conversation.
- Avatars: initials monogram by default; optional upload to R2.

### Channels

- Public channels: anyone can browse, join and leave; `#general` exists on first boot and cannot be left.
- Private channels and group DMs: members only; membership enforced server-side on every read, write, search and file download.
- Channel settings: name, topic, purpose, archive. Admins (from `deployment.jsonc` `access.admins`) can rename and archive anything.

### The agent in chat

- `@agent` as a mention in any public channel or thread sends the message (plus the last 20 messages of context) to the Workshop's external message gateway. Each channel maps to one agent workspace and each thread to one agent chat, so the agent keeps context per thread. The reply arrives as a message from the "Agent" member with a link to the agent chat.
  - **Built (2026-09-23), with one change to that mapping:** the Overseer that receives a question is owned by its first caller and refuses everyone else, so a workspace per *channel* would answer only whoever asked first. It is one workspace per *person* instead (`gadgetKey = user:<chat user id>`, titled "Chat agent"), one agent chat per thread (`chatKey = channel:<id>:thread:<root>`) or per DM (`dm:<id>`), and the question is asked as the asker's own Workshop account and model. A one-to-one DM with Agent asks with every message; private channels and group conversations are refused on the message. Design, reliability and the fork fix it needed: `packages/gatekeeper-chat/README.md`, "Agent".
- In any workspace the agent can use the ambient `ChatSession`: `listChannels()`, `readMessages(channel, cursor)`, `search(query)`, `postMessage(channel, text, threadId?)`. Reads are observations; posting is an action with approval. Private conversations are not visible to the agent in v1, because the ambient account is not yet linked to a user identity (see [open questions](#open-questions)).

## Technical design

### Components

```
Browser (any page)                    cfos-router                       cfos-chat (packages/gatekeeper-chat)
┌──────────────────────────┐   /gatekeeper/chat/*    ┌─────────────────────────────────────────────┐
│ Workshop shell (React)   │ ───────────────────────►│ fetch(): Access JWT verify → assets / API /  │
│  └ ChatDock (phase 2)    │   WS upgrade passes     │   WS upgrade / files                          │
│     └ <iframe src=       │   through the service   │ ChatWorkspace DO (idFromName "main")          │
│        /gatekeeper/chat/ │   binding unchanged     │   SQLite: users, channels, memberships,       │
│        ?embed=1>         │                         │   messages, messages_fts, threads, reactions, │
│ Chat SPA (standalone or  │                         │   attachments, push_subscriptions             │
│  embedded, same origin)  │◄── WebSocket events ────│   Hibernatable WebSockets tagged by user      │
└──────────────────────────┘                         │ R2 bucket cfos-chat-files                     │
                                                     │ GatekeeperVendor + ChatAccount + ChatSession  │
                                                     │ Web Push sender (VAPID, WebCrypto)            │
cfos-workshop ◄── service binding, entrypoint ExternalMessageGateway (props.source = "chat") ─┘
cfos-workshop ── GATEKEEPER_CHAT (entrypoint GatekeeperVendor) ──► ambient ChatSession for the agent
```

### Identity

Every HTTP request and WebSocket upgrade reaching `cfos-chat` must carry a verified `cf-access-jwt-assertion`; phase 0 proves that Access and the router preserve it on upgrades. The Worker verifies it with `jose` against `CF_ACCESS_ISS` and `CF_ACCESS_AUD`, the same vars `scripts/deploy.ts` already gives the Workshop, and rejects anything else with 401. Use the verified Access `sub` as the stable user key, with normalized email as a mutable profile/contact field. Resolve display name from the Access identity endpoint only if the phase 0 test proves a safe, supported way to fetch it; never forward the visitor's Access cookie to a caller-controlled URL or trust client-supplied names. Cache the result with a refresh policy and allow a display-name preference if the IdP does not supply a useful name.

For local development, a separate test-only entrypoint/fixture supplies identities; the SPA must not send a privileged identity header. Production builds omit the bypass entirely, and `deploy.ts --check` rejects any production config that enables it. Test the real Access path on a protected evaluation hostname before launch. Verify `Origin` on WebSocket upgrades and state-changing browser requests, and use CSRF protection for cookie-authenticated writes.

### Storage: one Durable Object, SQLite, FTS5

`ChatWorkspace` starts as one SQLite-backed DO named `main`, a deliberate simplicity tradeoff for a small team. Do not assume a fixed write rate or that splitting later is mechanical: global search, read cursors, directory data and agent links would need a separate index/coordinator. Load-test expected users, sockets, search, and file metadata before launch; record p95 send/search latency, queueing, storage growth, and the threshold at which to revisit the design. Keep R2 bytes outside the DO and cap query result sizes.

```sql
users(id TEXT PK, name, avatar_key, first_seen_at, last_seen_at, tz)
channels(id TEXT PK, kind TEXT CHECK(kind IN ('public','private','dm','group')),
         name, topic, purpose, created_by, created_at, archived_at, last_seq INTEGER)
memberships(channel_id, user_id, joined_at, last_read_seq, manual_unread_seq, notify TEXT, muted INTEGER, starred INTEGER,
            PRIMARY KEY(channel_id, user_id))
messages(id TEXT PK, channel_id, seq INTEGER, root_id NULL, author_id, body TEXT, kind TEXT,
         created_at, edited_at, deleted_at, reply_count, last_reply_at,
         UNIQUE(channel_id, seq))
messages_fts USING fts5(body, author_name, channel_name, content='messages', content_rowid='rowid', tokenize='unicode61')
thread_follows(root_id, user_id, last_read_reply_seq, PRIMARY KEY(root_id, user_id))
mentions(message_id, user_id, kind)               -- kind: user | channel | here | agent
reactions(message_id, user_id, emoji, PRIMARY KEY(message_id, user_id, emoji))
attachments(id TEXT PK, message_id NULL, channel_id, uploader_id, r2_key, name, mime, bytes,
            width, height, thumb_key, created_at)
push_subscriptions(user_id, endpoint PK, p256dh, auth, user_agent, created_at, failures)
agent_links(channel_id, root_id, gadget_key, chat_key, PRIMARY KEY(channel_id, root_id))
```

- `seq` is per channel and monotonic; unread arithmetic and pagination both use it. Thread replies also get a channel `seq` so a permalink to a reply works.
- FTS5 is kept in sync by `AFTER INSERT/UPDATE/DELETE` triggers on `messages`. Search text with FTS, then filter on immutable author and channel IDs in SQL, including membership and join-time visibility rules. Do not index mutable `author_name` or `channel_name` as the source of truth. Parse qualifiers into bound SQL parameters and a safe FTS query; malformed input returns a user-facing validation error.
- Message body is Markdown, capped at 8 KiB; rendered client-side with a sanitising renderer (no raw HTML). Server stores the extracted mentions and link list.
- Bodies of deleted messages are blanked and dropped from FTS.

### Live updates: hibernatable WebSockets

The SPA opens `wss://<host>/gatekeeper/chat/ws`. The DO accepts it with `ctx.acceptWebSocket(ws, [userId])` and hibernates between messages, so idle tabs cost nothing (the opposite of the open-RPC-channel cost noted for gadgets). Events are JSON, with a per-channel `seq` so a client that reconnects asks for `since` and gets what it missed:

```
client → server: {t:"sub", channels:[...]}, {t:"typing", channel}, {t:"read", channel, seq}, {t:"ping"}
server → client: {t:"msg", message}, {t:"edit", message}, {t:"del", id}, {t:"react", ...},
                 {t:"read", channel, seq}, {t:"presence", online:[...]}, {t:"typing", channel, user},
                 {t:"badge", unread:{channel:count}, mentions:{channel:count}, threads:n}
```

Fan-out uses `ctx.getWebSockets(tag)` per user for personal events. For every channel event, derive recipients from current membership; never broadcast private or DM content to all sockets. Recheck membership on `sub` and every incoming socket command, bound subscription count and frame size, and close expired or revoked sessions on reconnect/periodic revalidation. Persist only small, necessary socket metadata with `serializeAttachment()` and reconstruct it after hibernation. Presence is approximate and expires on a heartbeat/timeout; a close event alone is insufficient.

**Reference implementation:** [cloudflare/workers-chat-demo](https://github.com/cloudflare/workers-chat-demo) demonstrates room DOs, the Hibernation API, socket attachment restoration, and a separate IP rate limiter. Its code also exposes exception stacks to clients for demo convenience; do not copy that error handler. Use its WebSocket flow as a spike reference, while defining this app's authorization, replay, idempotency, and bounded history contract independently. Cloudflare's [SQLite storage docs](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) confirm FTS5 support, and the [WebSocket docs](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) document attachment persistence and limits.

### HTTP API (JSON, all under `/gatekeeper/chat/api/`)

| Route | Purpose |
| --- | --- |
| `GET me` | identity, preferences, badge summary |
| `GET channels`, `POST channels`, `PATCH channels/:id`, `POST channels/:id/{join,leave,archive,read}` | rail and channel management |
| `GET channels/:id/messages?before=&after=&around=&limit=` | history paging; `around` serves permalinks |
| `POST channels/:id/messages` `{body, rootId?, attachmentIds?, clientId}` | send; `clientId` makes retries idempotent |
| `PATCH messages/:id`, `DELETE messages/:id`, `PUT messages/:id/reactions/:emoji`, `DELETE …` | edits and reactions |
| `GET threads?unread=1`, `POST threads/:rootId/follow`, `DELETE …` | Threads view |
| `GET search?q=&cursor=` | FTS5 query with qualifier parsing on the server |
| `POST uploads` (multipart, ≤ 10 MiB) → `{id}` | write a pending R2 object with a short expiry; attach it atomically when a message is committed, then delete abandoned objects asynchronously |
| `GET files/:id`, `GET files/:id/thumb` | R2 stream with `Content-Disposition`, after a membership check on the file's channel |
| `GET users`, `GET users/:id`, `PUT me/avatar` | directory |
| `POST push/subscribe`, `DELETE push/subscribe` | Web Push |

Rate limits per verified user (messages 30/min, uploads 20/hour, search 60/min), with tighter per-conversation and `@agent` budgets, are enforced server-side. Treat limits as starting values to tune from measurements. API and private file responses use `Cache-Control: private, no-store`; shared browser and edge caches must never serve a file after membership is revoked. Use `Range` only if its authorization and size bounds are tested.

### The SPA

`packages/gatekeeper-chat/app/`, built by Vite into the Worker's static assets (`assets` binding, served by the Worker for `/gatekeeper/chat/assets/*` and the app shell HTML for every other non-API path, with `base: "/gatekeeper/chat/"`). Stack matches the Workshop frontend so it looks native: React 19, TanStack Router (path-based under the prefix), Tailwind v4, `@cloudflare/kumo` at the submodule's version, `@phosphor-icons/react`. Theme: `prefers-color-scheme` when standalone; when embedded, the shell posts `{type:"chat:theme", mode, accent}` and the app applies the same Kumo variables the shell overrides in `workshop-frontend/src/styles.css`.

Client state: a store keyed by channel with message pages, unread cursors and drafts; WebSocket reconnect with jittered backoff and HTTP `since` catch-up; optimistic send with the `clientId`. Show pending/failed/retry states and reconcile against the server sequence before declaring a send complete. Drafts can remain in local storage, but do not cache private message bodies in IndexedDB in v1; add an opt-in, bounded cache only after shared-device and sign-out behavior is designed.

Embedded mode (`?embed=1`): a `postMessage` bridge to the parent, origin-checked both ways. The
compact one-column layout is a *separate* flag (`?compact=1`), because the shell's full `/chat` page is
bridged but wants the wide three-pane layout; a narrow viewport is compact either way:

```
app → shell: {type:"chat:badge", unread, mentions}   {type:"chat:notify", title, body, href}   {type:"chat:expand", href}
shell → app: {type:"chat:open", href}                {type:"chat:theme", mode, accent}          {type:"chat:visible", visible}
```

### Notifications

1. **In app:** the store raises a notification for a new message when its conversation is not visible and the sender is not you, subject to the conversation's `notify` setting. Standalone, it shows an in-app toast; embedded, it forwards to the shell, which shows a Kumo toast whose click opens the dock at `href`.
2. **Tab in background:** `document.visibilityState === "hidden"` → `new Notification(...)` from the app itself (same origin as the shell in phase 2, so one permission prompt covers both). Click focuses the window and navigates.
3. **No tab open (phase 3):** a service worker at `/gatekeeper/chat/sw.js` (scope `/gatekeeper/chat/`) subscribes with the deployment's VAPID public key. Request permission only after a user opts in, and offer per-conversation and quiet-hours controls. Queue delivery after the message commits, retry transient failures with bounded backoff, and remove subscriptions on 404/410. Presence is only a hint: connected but backgrounded/offline tabs can miss events, so define a short delayed fallback and deduplicate by message ID across tabs and push. For private channels and DMs, default push text to a generic notification; recheck membership on click before opening the permalink. Do not claim exactly-once delivery.
4. **Email digests** are out of scope; the platform's email gatekeeper is inbound-only.

### The agent

- **`@agent` mentions.** The Worker calls the Workshop over a service binding `WORKSHOP_GATEWAY` with `entrypoint: "ExternalMessageGateway"` and `props: {source: "chat"}` (the backend requires the `source` prop, `workshop-backend/src/external-message-gateway.ts:16`), passing `callerEmail` (the mentioning user), `gadgetKey = channel:<id>`, `chatKey = thread:<rootId or messageId>`, `messageKey = <messageId>`, and a bounded prompt. Persist an outbox record in the DO before invoking the gateway; retry with the same `messageKey`, handle delayed/duplicate callbacks, and expose failure/retry state on the placeholder. Never send private or DM context through this ambient integration. Limit context to messages the caller may see, disclose the context sent, require explicit `@agent`, and cap spend per user/channel. Verify the external gateway's caller-account behavior and returned `chatPath` in phase 0 before enabling. `deploy.ts` already uses service-binding `props` for Context and Error Reporter; this particular entrypoint remains to be tested.
- **Ambient session.** `GatekeeperVendor.describe()` sets `autoProvisionsAccount: true`; `ChatAccount.describe()` sets `singleton: {tsType: "ChatSession"}` and no `providesUi`. `ChatSession` reads go through `authorizeObservation`; `postMessage` is an action with `actionKind` `chat.post` and is not auto-approvable. Types are published through `getTypeScriptTypes()` and a README so `describeBinding` explains it, as the Wave does. Enable it in `/admin` as `enabled` so every user's workspaces get it without opting in.

### Deployment wiring (starter-owned, no submodule change)

- `deployment.jsonc`: `workers.chat: {name: "cfos-chat"}` and a `chat` block: `{enabled, filesBucket: null | "<name>", maxUploadBytes}`. Add VAPID configuration only in phase 3; keep the private key as a Wrangler secret and publish the public key as a non-secret var. Document bucket ownership, expected cost and data retention before provisioning.
- `scripts/deploy.ts`: build and deploy `packages/gatekeeper-chat` before the Workshop and router; add `GATEKEEPER_CHAT` service bindings to the router (HTTP route) and the Workshop (`entrypoint: "GatekeeperVendor"`); bind `WORKSHOP_GATEWAY` from chat to the Workshop only when agent mentions are enabled; pass `CF_ACCESS_ISS`, `CF_ACCESS_AUD`, `ADMIN_EMAILS`, `PUBLIC_BASE_URL`; provision the R2 bucket like the existing buckets. `--check` validates the block; tests in `scripts/deploy.test.ts`. The deploy is sequential, not atomic: check old/new RPC compatibility, record Worker version IDs, and have a per-Worker recovery order before rollout.
- `wrangler.jsonc` in the package: `new_sqlite_classes: ["ChatWorkspace"]`, `r2_buckets`, `assets` with `binding: "ASSETS"` and `run_worker_first: true` so auth runs before assets, `nodejs_compat`, and the `capnweb-validate` build step the custom gatekeeper uses.

### Security checklist

- Verify the Access JWT on every request including the WebSocket upgrade. Static assets may be unauthenticated only after confirming they contain no user data or secrets; `sw.js` may need public fetch for registration, but its scope and payload handling still require review.
- Membership checks on every read, write, search hit and file download for private, DM and group conversations; search filters by membership before ranking.
- Markdown rendered with an allow-list sanitiser; links get `rel="noopener noreferrer"`; images only from `/gatekeeper/chat/files/` (CSP `img-src 'self' data: blob:`; `connect-src 'self'`; `script-src 'self'`; `frame-ancestors 'self'` so only the shell can embed it).
- Uploads: stream with a hard byte cap, check membership before and after upload commit, magic-number sniff images (reuse the approach in `workshop-backend/src/chat-attachment-validation.ts`), generate trusted thumbnails server-side or treat client thumbnails as untrusted, and use `Content-Disposition: attachment` for anything that is not a verified safe image with `X-Content-Type-Options: nosniff`. Clean up abandoned R2 objects and orphaned metadata on a schedule.
- Per-user rate limits; message and channel name length caps; idempotent sends.
- Admin actions logged to the message stream as system messages ("Harry archived #old").

## Phases

### Phase 0: spikes (about a day)

Each answers a question this plan depends on, with a tiny Worker under `packages/gatekeeper-chat/spikes/` run through the local platform (`packages/blueprint-whiteboard/e2e/start-local-platform.sh` boots one on WSL). Access and production routing behavior also require a protected evaluation deployment; local success alone is insufficient:

1. A WebSocket upgrade to `/gatekeeper/<name>/ws` passes through the router's service binding and reaches a hibernatable DO; `cf-access-jwt-assertion` is present on the upgrade in an Access-protected evaluation deployment. Test missing/invalid assertions and disallowed `Origin` as well. Do not deploy a public throwaway Worker outside the protected route.
2. `CREATE VIRTUAL TABLE … USING fts5` works in a DO under `wrangler dev` (workerd) and in production; `snippet()` and `bm25()` behave.
3. The `assets` binding serves a Vite build under a `base` prefix when the Worker is reached through another Worker's service binding.
4. Determine which verified Access claims identify the user and whether `/cdn-cgi/access/get-identity` can safely supply a display name for the IdP in use. Prove cookie forwarding only to the configured same-origin Access endpoint, or use a profile preference instead.
5. Before phase 3, a Web Push message signed in the Worker reaches Chrome and Firefox from a service worker registered under `/gatekeeper/chat/`; test mobile browser support separately.
6. Before enabling `@agent`, prove the `WORKSHOP_GATEWAY` binding delivers `source` to `ExternalMessageGateway`, that `receiveExternalMessage` accepts `callerEmail` for an Access-mode account, and that retries with one message key do not create duplicate agent chats or posts.

### Phase 1: the chat app at its own origin (no core change)

Deliverable: `https://cfos.surprisingly.ltd/gatekeeper/chat/` is a working team chat.

- Package skeleton from `packages/custom-gatekeeper`; `ChatWorkspace` DO with the schema, migrations and FTS triggers; identity middleware; the HTTP API and WebSocket protocol above.
- SPA: rail, conversation, composer, threads pane, unread model, search, permalinks, uploads with thumbnails, presence and typing, in-app and background-tab notifications, drafts, IndexedDB cache.
- Ambient `ChatSession` for the agent (public-channel read, search, post with approval), enabled only after its exact authority and observer policy are reviewed in `/admin`. The chat app itself works while the Gatekeeper is disabled.
- Deployment wiring and `--check` validation; R2 bucket; `#general` seeded on first request.
- Tests: DO unit tests with `@cloudflare/vitest-pool-workers` (schema migrations, unread arithmetic, search qualifiers, membership on every read/write/WS event/file route, retries, rate limits); Playwright with two isolated test identities for live updates; a local-platform e2e through the router; and an Access-protected evaluation smoke test for the assertion and WebSocket path. Include a deploy-failure drill where chat deploys but Workshop/router do not, and verify the previous public route still works.
- Reach it from the shell without a fork commit: the admin announcement can carry a "Chat" link, and the URL is bookmarkable. Launch with a small pilot before making the link prominent; verify two real Access identities, an unauthorized identity, private-channel isolation, upload revocation, reconnect, search, and restore from backup.

### Phase 2: the dock, a small fork commit

One commit on the fork branch beside the `gadgetViewer` commit, frontend only, around 250 lines:

- `workshop-frontend/src/components/ChatDock.tsx`: mounted once in `AuthenticatedShell` (`routes/__root.tsx`, next to `AccountSelectionModal`) so it also covers the fullscreen workspace editor; a same-origin `<iframe src="/gatekeeper/chat/?embed=1">` inside a right-hand drawer (`fixed`, `z-[1200]`, between the palette and the activity popover); the `postMessage` bridge; Kumo toasts via `useKumoToastManager`; `CountBadge` on the trigger.
- Triggers: a `SidebarItem` in `SidebarUtilityStrip.tsx` and a button beside `ActivityNotifications` in `GadgetEditor.tsx`; both read the badge from a tiny `chatDockBus.ts` (same pattern as `commandPaletteBus.ts`).
- Route `routes/chat.tsx` rendering the same iframe full height under the normal shell, with `/chat/*` splat forwarded as `href`. `AppShell` gets nothing new.
- Enable through an explicit shell feature flag/config value tied to deployment wiring, not a one-time 404 probe. A transient 404 or outage should show an unavailable state and retry; it must not silently remove the navigation. Keep the link usable if the agent-facing Gatekeeper is disabled in `/admin`.
- The commit ships with an integration test next to `GadgetUI.integration.test.tsx`, and a note in `docs/customization.md` "Code extensions" and the upgrade checklist.

Why it is acceptable: it touches no backend, no shared types, and no gadget runtime; on an upstream rebase it either applies cleanly or the dock is dropped and phase 1 still works.

### Phase 3: Web Push and polish

- Service worker, VAPID secret, subscription management UI in chat settings, durable delivery outbox, sending rules and cleanup.
- ~~`@agent` mention routing through the external message gateway.~~ Done 2026-09-23 (see [The agent in chat](#the-agent-in-chat)).
- Channel details pane (pinned messages, files), Mentions & reactions view, and quiet hours. Defer message forwarding and link previews until there is a clear permission model; server-side link fetching needs SSRF protection and content limits.

## Estimates

### Operational acceptance and maintenance

- **Data lifecycle:** Set and document message, attachment, deleted-content, audit-event and push-subscription retention before the pilot. Provide an admin export of messages and attachment manifests, plus an R2 object export path. Test a point-in-time restore in a separate Worker identity before chat becomes relied upon. A SQLite size ceiling is not a retention or backup strategy.
- **Schema changes:** Use numbered, idempotent DO schema migrations with a recorded schema version. Make new code read the prior schema during a staged deploy where feasible; never roll back by deleting a DO class or bucket. Test migration from the previous shipped version with representative data and FTS rebuilds.
- **Observability:** Emit structured, redacted counters for sends, authorization denials, reconnects, stale cursors, search latency, R2 errors, outbox lag and push failures. No message bodies, files, Access assertions, cookies or push endpoint secrets in logs. Define an owner and alert thresholds for 5xx rate, send latency, failed outbox jobs and storage growth.
- **Security lifecycle:** Admin privileges come from the deployment's configured Access administrator list after verified identity, not a client flag. Record membership and archive changes in a separate audit trail. Revoke cached access, sockets and push subscriptions when membership is removed; distinguish Access sign-out from chat sign-out. Avoid treating a remembered email as proof of continuing Access eligibility.
- **Release gates:** `pnpm check`, package tests, an Access-protected staging smoke test, a two-user browser run, and a backup/restore drill are required before production. Inventory the existing Worker names, R2 bucket and routes, and approve the added identities and storage. Deploy chat, Workshop, then router in the script's established order; after any failure, inspect actual versions before resuming. Verify all non-router Workers have no public route or Preview URL.
- **Dependency ownership:** Pin package versions through the workspace catalog, keep chat's public API and RPC contract documented, and add the new Worker, bucket, secrets and DO migration to `docs/customization.md`, the operator runbook, and the pinned-submodule upgrade checklist. Keep phase 2's shell integration behind a documented flag so a submodule rebase can be tested without chat availability.

| Phase | Effort |
| --- | --- |
| 0 spikes and protected evaluation | 2 to 3 days, depending on Access and push setup |
| 1 app and API | 2 to 3 weeks with the same agent-driven process the Board and Wave used (contract → parallel streams → reviews → e2e) |
| 2 dock | 2 days including the platform e2e |
| 3 push and agent mentions | 1 week |

## Open questions

- **Access display names.** Whether the identity endpoint returns a useful `name` for Google-federated Access logins; if not, the Workshop's own profile name would be the better source and needs a way for `cfos-chat` to read it (a Workshop entrypoint, or the shell posting `currentUser` to the embedded app in phase 2).
- **Linking the ambient account to a user.** `createAccount()` carries no identity, so the agent's `ChatSession` cannot act as a specific person. Either restrict the agent to public channels (v1), or add `viewer` to the singleton's props in the fork (the same shape as `gadgetViewer`, and the thing upstream Discussion #455 asks for).
- **Retention and export.** Choose retention periods and an export/restore owner before the pilot. The DO SQLite size limit and R2 durability do not answer these policy and recovery questions.
- **Second Access identity for testing.** Production two-browser tests need a second allowed email, the same gap the Board and Whiteboard have.

## Out of scope for v1

Voice and video, huddles, message scheduling, custom emoji, per-message permissions, guest accounts, email digests, federation, and Slack import.
