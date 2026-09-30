# Plan: video calls in team chat (Cloudflare Realtime SFU)

Written 2026-09-30 against starter main 2c6f0eb (fork pin 0bef286). Status: **implementation started on
branch `feat/chat-video`** — the live checklist is [chat-video-implementation.md](chat-video-implementation.md).
Research and the API facts this plan relies on: [../research/chat-video-sfu.md](../research/chat-video-sfu.md).

Goal: decent audio/video calls of up to five people inside any chat conversation (channel, DM or
group), started and joined from the conversation, visible in its history, and usable from both the
full `/chat` page and the shell's dock. Screen share included. Recording, transcription, dial-in,
guests and calls larger than five are out of scope for this plan.

## The decision: Cloudflare Realtime SFU, not a peer-to-peer mesh

Harry chose the SFU on 2026-09-30 for call quality. The trade-offs, measured in the research note:

| | Mesh (P2P) | Cloudflare Realtime SFU (chosen) |
| --- | --- | --- |
| Upload per person, 5-way | 4 copies of their video (~2–6 Mbps) | 1 simulcast publish (~1.5–2.5 Mbps) |
| Weak laptop / phone | 4 encoders: struggles | 1 encoder; SFU picks each viewer's layer |
| Bad networks | Every pair must connect; TURN per pair | One connection to the nearest Cloudflare PoP (anycast) |
| End-to-end encryption | Yes (DTLS-SRTP peer to peer) | No by default — media is decrypted at the SFU. Insertable-streams E2EE is a later option |
| Cost | TURN egress only | $0.05/GB egress after 1,000 GB/month free; ~$0.25–0.70 per 5-way hour |
| Grows past 5 | No | Yes |

The SFU is deliberately low level: it has sessions and tracks, no rooms, participants or
permissions. **That is a fit, not a gap**: the `ChatWorkspace` Durable Object already owns identity,
membership and a live socket to every client, so it becomes the call's room.

## User experience

- **Start or join.** The conversation header gets a call button. With no call running it reads
  "Start call"; while one runs it becomes a green "Join (3)" pill showing participants' avatars.
  Joining asks for camera and microphone the first time (with a preview and device pickers; either
  can be off). A running call also shows as a small camera glyph on the conversation's rail row.
- **In the call.** A call panel takes over the conversation column (on `/chat`) or the dock body
  (compact): a responsive grid of tiles — one per participant, name label, muted-mic glyph, a ring on
  the active speaker. Screen share becomes the large tile with the cameras as a strip. The message
  list stays one click away (a "Chat" toggle on the call bar), so people can paste links during the
  call. Controls: mic, camera, screen share, device settings, leave. Keyboard: `Ctrl/Cmd+D` mic,
  `Ctrl/Cmd+E` camera, both announced to screen readers.
- **History.** Starting a call posts a system message, "Harry started a call", with a Join button
  while it runs; when the call ends the same message is edited to "Call ended · 23 min · Harry,
  Alice, Bob". It is a normal message: it threads, searches and permalinks.
- **Ringing.** In a DM or group, starting a call rings the other members: an in-app toast with
  Join/Dismiss, the shell toast via the existing `chat:notify` bridge when the dock is closed, and a
  browser notification when the tab is hidden. Channels never ring; they show the Join pill.
- **Limits and edges.** A sixth person sees "This call is full (5)". A person in the call on another
  tab or frame sees "You're in this call in another window" with "Move here". Losing the network shows
  "Reconnecting…" and rejoins automatically (ICE restart, then a fresh session). The last person
  leaving ends the call; a call whose participants all vanish is ended by the object's alarm.

## Technical design

### Components

```
 browser (chat SPA, /chat page or dock iframe)            cfos-chat Worker            Cloudflare Realtime
 ┌────────────────────────────────┐   HTTPS /api/calls/*  ┌──────────────────┐  HTTPS  ┌───────────────┐
 │ CallEngine                     │ ───────────────────▶ │ ChatWorkspace DO │ ──────▶ │ SFU HTTPS API │
 │  one RTCPeerConnection ────────┼───── WebRTC media (UDP/TCP/TLS, TURN) ───────────▶│ (nearest PoP) │
 │  publish mic/cam(simulcast)/   │   WS {t:"call"...}    │  calls tables    │         └───────────────┘
 │  screen; pull others' tracks   │ ◀─────────────────── │  SFU + TURN keys │  HTTPS  ┌───────────────┐
 └────────────────────────────────┘                       └──────────────────┘ ──────▶ │ TURN key API  │
                                                                                        └───────────────┘
```

- **Media never touches the Worker.** Each participant has exactly one `RTCPeerConnection`, to the
  SFU; that is one SFU *session*. Publishing and pulling are both tracks on that session.
- **Signalling is the chat API.** The browser never holds the SFU app secret. Every SFU operation is
  an HTTP call to the chat Worker, which the Durable Object authorises against the call and the
  caller's membership, then forwards to the SFU with the secret. The SFU's answer/offer SDP comes back
  through the same response.
- **Room state is the DO.** Who is in which call, their SFU session id, which tracks they publish and
  their mute state live in DO SQLite and are pushed over the existing WebSocket as `{t:"call"}` events.

### Why the DO, not a separate CallRoom object

Membership, identity, the socket fan-out, system messages and the alarm already live in
`ChatWorkspace`, and a five-person call adds a handful of writes per minute (join, publish, mute,
leave). A second object would need its own copy of membership checks and a cross-object hop for every
call event. If call traffic ever threatens chat latency, the call tables move behind the same
`Ctx` interface into their own object; nothing on the wire changes.

### Storage (migration 5)

```sql
CREATE TABLE calls (
  id TEXT PRIMARY KEY,               -- ULID-ish, from do/ids.ts
  channel_id TEXT NOT NULL,
  started_by TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,                  -- NULL while active
  message_id TEXT NOT NULL,          -- the system message edited on end
  peak_participants INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX calls_one_active ON calls(channel_id) WHERE ended_at IS NULL;

CREATE TABLE call_participants (
  id TEXT PRIMARY KEY,               -- participantId: one per join, not per user
  call_id TEXT NOT NULL REFERENCES calls(id),
  user_id TEXT NOT NULL,
  sfu_session_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at INTEGER,                   -- NULL while in the call
  last_seen_at INTEGER NOT NULL,     -- call heartbeat; expiry is lazy + alarm
  audio INTEGER NOT NULL DEFAULT 0,  -- published and unmuted
  video INTEGER NOT NULL DEFAULT 0,
  screen INTEGER NOT NULL DEFAULT 0,
  tracks TEXT NOT NULL DEFAULT '[]'  -- JSON [{name, kind, mid, simulcast, announced}] — mid kept for backend force-close
);
CREATE UNIQUE INDEX call_participants_live ON call_participants(call_id, user_id) WHERE left_at IS NULL;
```

- One active call per conversation (partial unique index). One live participant row per person per
  call: joining again from another tab ends the old row (`left_at`) and the old tab is told
  `call-moved` so it tears down.
- `message_id` ties the call to its system message; `Message.call` is hydrated from `calls` by
  message id (see protocol below), the same way `agentRequest` is.
- Rows are kept after the call ends, for the history message; a later sweep can prune participants
  older than 90 days.

### Protocol additions (`src/shared/protocol.ts`, additive)

Authoritative shapes land in code in the contract commit; summary:

```ts
export const MAX_CALL_PARTICIPANTS = 5;
export const CALL_HEARTBEAT_MS = 10_000;        // client → server while in a call
export const CALL_PARTICIPANT_TTL_MS = 45_000;  // no beat for this long = gone (video-room's timings)

type CallId = string; type ParticipantId = string;
type CallTrackKind = "audio" | "video" | "screen";

interface CallTrack { name: string; kind: CallTrackKind; simulcast: boolean }  // SFU trackName; only announced (bytes flowing) tracks appear
interface CallParticipant { id; userId; sessionId; joinedAt; audio; video; screen; tracks: CallTrack[] }  // sessionId = SFU session, needed to pull
interface CallState { id; channelId; startedBy; startedAt; messageId; participants: CallParticipant[] }
interface CallSummary { id; state: "active"|"ended"; startedAt; endedAt|null; participantIds: UserId[] }

Message.call?: CallSummary                  // on the system message
ChannelListResponse.calls: CallState[]      // active calls the caller can see (rail glyph)
hello.calls?: CallState[]                   // same, on (re)connect
MeResponse.calls: { enabled: boolean; maxParticipants: number }

ClientEvent  += { t:"call-beat"; call; participant; audio; video; screen }
ServerEvent  += { t:"call"; channel; call: CallState | null; ring?: boolean }
             += { t:"call-moved"; call; participant }   // this participant was replaced/removed
```

HTTP routes (all under `/gatekeeper/chat/api`, all JSON, all authorised by the DO):

| Route | Body → Response | What the DO does |
| --- | --- | --- |
| `GET /channels/:channelId/call` | → `{call: CallState \| null}` | membership check |
| `POST /channels/:channelId/call/join` | `{}` → `{call, participantId, iceServers}` | create call + system message if none (ring DM/group); enforce cap; replace own older row; `sessions/new` on the SFU; mint TURN credentials |
| `POST /calls/:callId/publish` | `{participantId, sdp(offer), tracks:[{mid, kind}]}` → `{sdp(answer), tracks:[{mid, name}]}` | owner check; names tracks `${participantId}-${kind}`; SFU `tracks/new` (local); records tracks; broadcasts |
| `POST /calls/:callId/pull` | `{participantId, tracks:[{participantId, name, rid?}]}` → `{sdp(offer)?, requiresImmediateRenegotiation, tracks:[{mid, participantId, name, error?}]}` | every requested track must be published by a live participant of the same call; SFU `tracks/new` (remote) |
| `POST /calls/:callId/announce` | `{participantId, names}` → `{call}` | marks published tracks as flowing (client saw `bytesSent > 0`); only announced tracks are visible or pullable |
| `POST /calls/:callId/reconnect` | `{participantId}` → `{call, sessionId, iceServers}` | recovery: new SFU session for the same participant; clears its tracks (force-closing the old ones best-effort) |
| `POST /calls/:callId/renegotiate` | `{participantId, sdp(answer)}` → `{}` | owner check; SFU `renegotiate` |
| `POST /calls/:callId/close-tracks` | `{participantId, mids, sdp(offer)?, force?}` → `{sdp(answer)?}` | owner check; SFU `tracks/close`; drops closed published tracks from state |
| `POST /calls/:callId/layer` | `{participantId, mid, rid}` → `{}` | simulcast layer preference for one pulled track (SFU tracks update) |
| `POST /calls/:callId/leave` | `{participantId}` → `{}` | sets `left_at`; force-closes the leaver's published tracks (subscriptions do not stop on their own); ends the call if empty |

- **Authorisation rule**: the caller must be a member (or, for public channels, anyone who can read
  the channel — joining a public channel's call joins the channel, as posting does). `participantId`
  must be a live row owned by the caller. A pulled track must be an announced track of a live
  participant of the same call. The SFU session id is always taken from the DO row, never from
  the request. So a client cannot pull media from a call it is not in, or push into someone else's
  session.
- **Mute and heartbeat** ride the WebSocket (`call-beat`): sent on every change and every
  `CALL_HEARTBEAT_MS`. The DO updates `last_seen_at` and the flags, and broadcasts only on change.
- **Expiry**: a participant with no beat for `CALL_PARTICIPANT_TTL_MS` is dropped lazily on any
  call read and by the object's alarm (`ctx.wakeAt`), which also ends empty calls and edits the
  system message. The alarm is shared with uploads/agent/search as today.
- **Rate limits**: new `RATE_LIMITS.calls` bucket for join (e.g. 10/min/user) and a generous one for
  SFU operations (e.g. 120/min/user), reusing `do/limits.ts`.
- **Kill switch**: calls are enabled only when the SFU app id + secret are configured; otherwise the
  routes answer `503 unavailable` and `MeResponse.calls.enabled` is false, so the UI hides the button.

### SFU and TURN clients (`src/do/sfu.ts`, `src/do/turn.ts`)

Thin typed wrappers around the HTTPS APIs in the research note, with `fetch` injected through
`Ctx` so tests run against a fake. They map SFU `errorCode`s into the chat error envelope
(`upstream_error` → 502) and log with the existing redacted logger (session ids hashed). TURN
credentials are minted per join with a TTL of a few hours and returned only to that participant.

### Client (`app/src/call/`)

- **`CallEngine`** (framework-free TypeScript, unit tested with a fake `RTCPeerConnection`):
  - owns the single peer connection, created with the returned `iceServers` and `bundlePolicy:
    "max-bundle"`;
  - `publish(tracks)`: `addTransceiver(track, {direction: "sendonly", sendEncodings})`, offer,
    `setLocalDescription`, POST `publish`, apply answer. Camera uses three simulcast layers
    (`rid` a/b/c at full, 1/2, 1/4 scale; ~1.2 Mbps / 450 kbps / 150 kbps — ASCII order best to
    worst, because the SFU's automatic switching walks the RIDs `asciibetical`ly); screen share one
    layer with `contentHint = "detail"`; audio Opus with DTX and `networkPriority: "high"`; after
    the answer, wait for `outbound-rtp bytesSent > 0` per track, then POST `announce`;
  - `pull(remoteTracks)`: batches every wanted track into one POST `pull`; when the SFU asks for
    renegotiation, apply its offer, answer, POST `renegotiate`; map `mid`s to incoming
    `ontrack` streams;
  - serialises all negotiation through one promise queue (an SFU session tolerates one negotiation
    at a time);
  - layer choice: pulls ask for `simulcast: {preferredRid, priorityOrdering: "asciibetical",
    ridNotAvailable: "asciibetical"}` so the SFU steps down on its own under congestion; the
    preferred RID per tile is `a` when large (≥ 640 px wide, active speaker), `b` for grid tiles,
    `c` for thumbnails and hidden tiles; changes go through `layer` (SFU `tracks/update`), debounced
    to one per second;
  - mute: never stop a sender — a track with no packets for 30 s is garbage-collected by the SFU.
    Mic mute is `track.enabled = false` (Opus keeps sending silence); camera off stops the camera
    (light off) and `replaceTrack(blackCanvasTrack)` at 1 fps, and back on `replaceTrack(newTrack)`;
    both with a `call-beat` so tiles show the right state. No renegotiation;
  - active speaker: `getStats()` `audioLevel` on inbound audio every 250 ms, with hysteresis;
  - recovery (orange's rule): `connectionState` `failed`/`closed`, or `disconnected` for more than
    7 s, rebuilds — POST `reconnect` for a new session and ICE servers, new peer connection,
    re-publish, re-announce, re-pull. `restartIce()` is tried once on `disconnected` first. A lost
    `tracks/new` or `renegotiate` outcome also rebuilds (never blind-retry `tracks/new`);
- **UI** (`CallButton`, `CallPanel`, `CallTile`, `CallControls`, `DeviceSettings`, `IncomingCall`,
  `CallMessage`) in the app's Kumo/Tailwind idiom, driven by store state: `calls` by channel from
  `{t:"call"}`, and the local call from the engine.
- **Mock mode** (`app/src/mock`): a fake engine that loops the local camera back as the remote tiles,
  so the UI can be built and screenshot-tested with no SFU.

### Shell integration (fork commit on `starter-openrouter`)

- `ChatDock.tsx` `ChatFrame` iframe gains
  `allow="camera; microphone; display-capture; autoplay; fullscreen"`. Without it `getUserMedia`
  and `getDisplayMedia` reject inside the frame.
- New bridge message `AppToShellMessage {type: "chat:call"; active: boolean; href?}`. While a
  call is active the shell keeps the dock frame mounted (no `UNMOUNT_GRACE_MS` teardown) and shows a
  live-call indicator on the Chat trigger; closing the dock only hides it. The `/chat` route mounts a
  separate frame, so opening `/chat` during a dock call shows the "in another window / Move here"
  state rather than a second join.
- The chat HTML gets `Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)`.
  The shell's own responses must not deny those features to the frame (verified in the fork stream).

### Configuration and deployment

- New Cloudflare resources: one **Realtime SFU app** (app id + secret) and one **TURN key** (key id +
  API token), created in the account's dashboard (Realtime) or by the API. **Production mutation:
  requires Harry's approval** through the operator skill's mutation summary.
- `cfos-chat` gains vars `REALTIME_SFU_APP_ID`, `REALTIME_TURN_KEY_ID` and secrets
  `REALTIME_SFU_APP_SECRET`, `REALTIME_TURN_KEY_API_TOKEN`. `deployment.jsonc` gets
  `chat.calls: { enabled: boolean, sfuAppId, turnKeyId }`; `scripts/deploy.ts` validates the block
  and, when enabled, lists the two secrets as required so wrangler refuses to deploy without them.
- Egress is billed to the account at $0.05/GB after the shared 1,000 GB/month; at a team's volume it
  is expected to stay inside the free allowance. Add a monthly usage check to the operator notes.

## Testing

- **Worker (vitest-pool-workers)**: migration 5; join/leave/replace/cap/expiry; the system message
  lifecycle; authorisation on every SFU route (non-member, wrong participant, pull from another
  call, pull an unpublished track); SFU error mapping; rate limits; the alarm ending an abandoned
  call. The SFU is a fake `fetch` recording requests.
- **CallEngine (vitest, jsdom)**: a fake `RTCPeerConnection` that records transceivers and
  descriptions; publish/pull/renegotiate ordering; the negotiation queue; layer selection; ICE
  restart then rejoin.
- **UI (vitest)**: store reducers for `call` events; component states (idle, ringing, joining, in
  call, full, moved, reconnecting).
- **End to end (Playwright, `e2e/call-check.mjs`)**: Chromium with
  `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, five signed-in contexts on the
  local platform, **against a real SFU app** (dev credentials in `.dev.vars`, never committed). Checks:
  everyone sees four remote tiles with frames decoding (`getStats` framesDecoded rising), mute
  propagates, screen share, the sixth join is refused, leave ends the call and edits the message.
  Skipped with a clear message when no dev SFU credentials are present.
- **Production (signed in, after approval)**: a two-person call across two networks (one on phone
  tethering) and a five-person call; watch Realtime analytics for egress.

## Delivery streams

Tracked in [chat-video-implementation.md](chat-video-implementation.md). The contract commit lands
first; then these run in parallel with disjoint file ownership:

| Stream | Owns | Depends on |
| --- | --- | --- |
| A. Worker + DO | `src/do/calls.ts`, `src/do/sfu.ts`, `src/do/turn.ts`, migration 5, router/sockets/messages wiring, env, `__tests__/calls.test.ts` | contract |
| B. CallEngine | `app/src/call/engine/*` + tests | contract |
| C. Call UI + store | `app/src/call/ui/*`, store/state changes, header/rail/message hooks, mock engine | contract, B's interface |
| D. Shell + deploy | fork `ChatDock.tsx` patch, `scripts/deploy.ts` + `deployment.jsonc` calls block, Permissions-Policy | contract |
| E. Integration + e2e | `e2e/call-check.mjs`, local-platform run, docs | A–D |

## Risks and open questions

- **No E2EE.** Media is decrypted at Cloudflare. Acceptable for a colleagues' tool; revisit with
  insertable streams (SFrame) if calls carry anything sensitive — Safari support for the
  RTCRtpScriptTransform API is the constraint.
- **Dock lifetime.** Pinning the frame during a call is a behaviour change in the fork; it must
  survive upstream rebases like the other dock patches.
- **Safari.** Simulcast send in Safari is supported but its layer behaviour differs; the e2e run is
  Chromium-only, so Safari needs a manual check.
- **Corporate firewalls** that block UDP rely on TURN over TCP/TLS 443; the TURN URL list must
  include `turns:…:443`.
- **One device per person per call** is a simplification (no "join from phone and laptop").
