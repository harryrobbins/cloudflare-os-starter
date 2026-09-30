# Chat video calls: implementation checklist

Tracks delivery of [chat-video.md](chat-video.md). Started 2026-09-30 on branch `feat/chat-video`
(worktree `/var/web/cfos-chat-video`). Tick items as they land; each stream names the files it owns.
Baseline before any change: `pnpm --filter gatekeeper-chat build && pnpm --filter gatekeeper-chat test:run`
→ 280 Worker tests and 273 app tests green. (Without the build step, three SPA-serving tests fail
with 404 because `app/dist` is absent.)

## Stream 0: research, plan and contract (lead)

- [x] Research note [../research/chat-video-sfu.md](../research/chat-video-sfu.md): SFU/TURN API,
      negotiation sequence, simulcast, limits, pricing, gotchas
- [x] This plan and checklist
- [x] Contract commit: `src/shared/protocol.ts` call types and constants, `src/shared/routes.ts` call
      routes, `src/shared/validate.ts` parsers, `app/src/call/engine/types.ts` CallEngine interface

## Stream A: Worker and Durable Object

Owns `src/do/calls.ts`, `src/do/sfu.ts`, `src/do/turn.ts`, migration 5 in `src/migrations.ts`, the
call cases in `src/do/router.ts` and `src/do/sockets.ts`, `Message.call` hydration in
`src/do/messages.ts`, `src/env.ts`, `wrangler.jsonc` vars, `__tests__/calls.test.ts`.

- [x] Migration 5: `calls`, `call_participants`, indexes
- [x] SFU client with injected fetch; error mapping; redacted logs
- [x] TURN credential client
- [x] Join (create call + system message + ring), cap, replace-own-row (`call-moved`)
- [x] Publish / pull / renegotiate / close-tracks / layer / leave with the authorisation rule
- [x] `call-beat` frame, change-only broadcast, lazy expiry + alarm, end-of-call message edit
- [x] `Message.call`, `ChannelListResponse.calls`, `hello.calls`, `MeResponse.calls`
- [x] Rate limits; kill switch when unconfigured
- [x] Tests

Complete 2026-09-30: 302 Worker tests (22 in `calls.test.ts`). Decisions: TURN failure falls back to
STUN-only rather than failing the join; only `sessions/new`, forced closes and layer updates are
retried; foreign participant 403, unpullable track 404 (no probing); `leave` needs no channel access;
flags can only be on while a track of that kind is announced; ended message sets no `edited_at`.
Gaps: `call-beat` does not re-check membership (signalling routes do); participant rows are not
pruned; SFU closes from synchronous paths are fire-and-forget.

## Stream B: CallEngine

Owns `app/src/call/engine/*`.

- [x] Peer connection lifecycle, negotiation queue
- [x] Publish mic / camera (simulcast h/m/l) / screen; mute; camera off via `replaceTrack`
- [x] Batched pull; SFU-initiated renegotiation; `mid` → stream mapping; close on participant leave
- [x] Layer selection by tile size, debounced
- [x] Active speaker from `getStats`
- [x] ICE restart then full rejoin; device switching
- [x] Tests with a fake `RTCPeerConnection`

Complete 2026-09-30: 52 engine tests. `CallSnapshot.audioOutputId` added (apply with
`applyAudioOutput` from `engine/devices.ts`). Rebuilds share one backoff budget; pulls keyed by
publisher session so a reconnecting peer is re-pulled. Gaps: Opus DTX not enabled (no SDP munging
yet); screen share has no audio; simulcast acceptance, mid mapping, black-track keep-alive and
`restartIce()` need the real SFU.

## Stream C: Call UI and store

Owns `app/src/call/ui/*`, `app/src/call/mock-engine.ts`, and the call additions to
`app/src/store/*`, `app/src/api/*`, `app/src/components/ConversationView.tsx`, `Rail.tsx`,
`MessageRow.tsx`, `Toasts.tsx`, `app/src/lib/bridge.ts`.

- [x] Store: calls by channel from `call` events, `hello.calls`, channel list; local call state
- [x] Call button / Join pill in the conversation header; rail glyph
- [x] Pre-join preview with device pickers
- [x] Call panel: grid, screen-share layout, active speaker ring, compact (dock) mode, Chat toggle
- [x] Controls and shortcuts; accessible announcements
- [x] Ringing: toast, `chat:notify` to the shell, browser notification
- [x] Call system message rendering (`Message.call`)
- [x] Full / moved / reconnecting states
- [x] `chat:call` bridge message to the shell
- [x] Mock engine (local camera loopback) for mock mode
- [x] Tests

Complete 2026-09-30: app suite 391 tests (66 new). One engine above the router; full page
(grid, stage + filmstrip, Chat column, Focus) and compact sidebar layouts switch at runtime on
`chat:layout`; Pop out / Expand via `chat:present`; `chat:call` carries audio/video for the shell pill.
Mock mode has a seeded call in #design. Gaps: the engine has no preview API (pre-join opens its own
stream); permission refusal is detected from the warning text; a layout switch remounts the message
list (not the call).

## Stream D: shell and deployment

Owns the fork's `workshop-frontend/src/components/ChatDock.tsx` (+ tests, `chatDockBus.ts`,
`ChatTrigger.tsx`), `packages/gatekeeper-chat/src/serve.ts` Permissions-Policy, `scripts/deploy.ts`,
`deployment.jsonc` example/docs.

- [x] iframe `allow` attribute on the chat frame
- [x] `chat:call` handling: pin the frame while active; live-call indicator on the trigger
- [x] Permissions-Policy on chat HTML; confirm the shell does not deny the features
- [x] `chat.calls` deployment block, validation, vars and required secrets
- [x] Fork commit on a `feat/chat-video` branch in the submodule (not pushed; Harry pushes)

Complete 2026-09-30. Fork 8969529f (`feat/chat-video`, on 0bef2869): 19/19 dock/trigger tests; the
shell sets no Permissions-Policy of its own (only a meta CSP with `frame-src 'self'`), so nothing there
needed changing. Starter: `PERMISSIONS_POLICY` in `serve.ts`; `chat.calls {enabled, sfuAppId, turnKeyId?}`
in `scripts/deploy.ts` (32-hex ids; `REALTIME_SFU_APP_SECRET` always, `REALTIME_TURN_KEY_API_TOKEN` with a
TURN key, both `secrets.required`); 71/71 deploy tests; `docs/customization.md` "Video calls".
While a call is active the dock only hides on close, and the `/chat` page's unmount request is refused.

## Stream E: integration and end to end

- [ ] Wire engine + UI + Worker on the local platform
- [x] `e2e/call-check.mjs`: five fake-media Chromium contexts against a real dev SFU app (written;
      verified only up to the join step, see below)
- [ ] Five-person run against the real SFU (blocked on the SFU app token)

Real-SFU attempt 2026-09-30 (standalone `wrangler dev` via `CHAT_DEV_ENV_FILE`, credentials from a
file outside the repo, deleted afterwards):
- **SFU: blocked.** `sessions/new` answers 401 `Invalid bearer token, please ensure the token is
  current and not expired` for the supplied app id and token, from the Worker and from a direct
  `curl`. The app id itself exists (an unknown id answers 404). The token needs re-copying or
  regenerating in the dashboard (Realtime → SFU → the app). Nothing past the join was exercised, so
  RED, munged Opus fmtp, simulcast, black-frame keep-alive, downgrade paths, sidebar/full-page moves
  and the stats log line remain unverified.
- **Join failure path: pass.** The join answers 502, the pane shows "The call could not connect ·
  The call service refused that request (unauthorized)" with Close/Retry, and no call row or system
  message is left behind (`GET /channels/general/call` → `null`, history empty).
- **TURN: pass.** The Worker mints credentials (`chat.call.turn outcome=ok`). Two Chromium peer
  connections with `iceTransportPolicy: "relay"` and freshly minted credentials connected in 4.2 s
  over `relay/udp` (RTT 13 ms) and carried audio and video.
- Firefox/WebKit: not run.
- [x] README section for calls; update chat.md "out of scope" note (feat/chat-video-next, Stream H)
- [x] Production mutation summary for Harry, drafted below; **not executed**

### Production mutation summary (draft, for approval; nothing here has been run)

Follow `.agents/skills/cloudflare-os-operator/SKILL.md` before any of it. Facts to re-verify on the
day: account `e1376e48400a20e631b61bbf16f555f1`, route `cfos.surprisingly.ltd` on `cfos-router`, the
root and `cloudflare-os` commits being released, and each Worker's last-known-good version id.

1. **Realtime resources (Harry, dashboard).** The SFU app and TURN key created on 2026-09-30 are the
   **dev** pair (their ids and credentials are in the main checkout's `.env.local` only). Production
   gets its own: Realtime → SFU → create an app; Realtime → TURN → create a key. Keeping them apart
   means a local test can never spend or break the production allowance, and a dev credential leak
   is revoked without touching production.
2. **Code.** Merge `feat/chat-video` (and `feat/chat-video-next`, if accepted) into `main`, with the
   `cloudflare-os` gitlink on the pushed fork commit. The release carries chat Durable Object
   migrations 5 (call tables) and 6 (`hand_at`), the chat app (including ~12.6 MB of optional effect
   assets: MediaPipe's Wasm, the segmenter model, RNNoise), the Worker's CSP gaining
   `'wasm-unsafe-eval'`, and the shell's persistent chat frame and "In a call" pill (fork).
3. **`deployment.jsonc`.**
   `"chat": { ..., "calls": { "enabled": true, "sfuAppId": "<prod SFU app id>", "turnKeyId": "<prod TURN key id>" } }`.
   The ids are public; they become `REALTIME_SFU_APP_ID` and `REALTIME_TURN_KEY_ID`.
4. **Two production secrets** on `cfos-chat` (the dev pair's two stay local), installed before the
   release because the generated config lists them under `secrets.required`:
   ```sh
   CLOUDFLARE_ACCOUNT_ID=e1376e48400a20e631b61bbf16f555f1 pnpm exec wrangler secret put REALTIME_SFU_APP_SECRET --name cfos-chat
   CLOUDFLARE_ACCOUNT_ID=e1376e48400a20e631b61bbf16f555f1 pnpm exec wrangler secret put REALTIME_TURN_KEY_API_TOKEN --name cfos-chat
   ```
5. **Validate, then release.** `pnpm check` on the clean merged `main` (its summary lists the Workers
   the change touches), then, after approval, `pnpm release`. Live uploads stay serial in
   `deployOrder()`, router last.
6. **Verify signed in.** Two people (the second Access identity is still the gap `chat.md` notes)
   start a call in a DM: ring, join, see and hear each other, share a screen, move sidebar ↔ full page,
   leave; the history row reads "Call ended · N min · names". `wrangler tail cfos-chat` shows
   `chat.call.*` lines and a `chat.call.stats` line a minute in, and nothing with SDP or an address.

**Rollback limits.** The multi-Worker release is not atomic; on a failure, stop and record which
Workers went live and their version ids. `"calls": { "enabled": false }` (or removing the block) and
a redeploy turns every call route into 503 `unavailable` without touching chat. Migrations 5 and 6 are
forward-only: a rolled-back Worker ignores the extra tables and column, so rolling code back is safe
but the schema stays. Calls in progress drop on a chat deploy (clients rejoin automatically). Nothing
is stored at Cloudflare Realtime; revoking the production app token or TURN key stops new calls at
once. Realtime is billed on egress beyond its free allowance: check current pricing, and the stats log
line gives per-call volume after the first week.

## Stream F: one persistent chat frame (phase 1b)

Owns the fork's `workshop-frontend` (on `feat/chat-video` after 8969529f). Started 2026-09-30.

- [x] `PersistentChatFrame` at the shell root, positioned over the active slot (page > dock > hidden)
- [x] Slots in the dock drawer and the `/chat` route; one iframe ever, never re-parented
- [x] `chat:layout` to the app; `chat:present` from the app (with return to the page you came from)
- [x] Floating "In a call" pill with `chat:call-control`
- [x] App side (Stream C): runtime layout switching, Pop out / Expand buttons, call-control handling

Complete 2026-09-30: fork 39037ebd on `feat/chat-video`; 201 workshop-frontend tests (also fixed
12 pre-existing cold-import timeouts). One iframe owned by the root-mounted ChatDock host; slots in
the dock drawer and `/chat`; pill bottom-right above toasts. Browser-only checks outstanding: focus
when the frame moves or hides, z-index against top-bar dropdowns, uninterrupted media across moves.

## Stream G: quality phase 1 (after A–C are merged)

Contract (lead, 2026-09-30): `CallStatsReport` + `MAX_CALL_STATS_PER_MINUTE` and the `postCallStats`
route in the shared protocol; `ConnectionQuality`, `QualityLimitation`, and optional
`quality`/`videoPaused` on `RemoteMedia` and `localQuality`/`limitation`/`audioOnly`/`sendLayers` on
`CallSnapshot` in the engine types. Three parallel agents: G1 engine, G2 Worker stats route, G3 UI.

See [chat-video.md, "Quality phase 1"](chat-video.md#quality-phase-1-after-the-initial-call-work-lands-this-branch).

- [x] Capture constraints (AEC/NS/AGC, `voiceIsolation`, 720p30 cap)
- [x] Opus FEC + DTX; RED where negotiated (verify on the real SFU)
- [x] Degradation preferences and screen-share content hints
- [x] CPU / bandwidth adaptation from `qualityLimitationReason` and receive stats; audio-only fallback
- [x] Pause hidden video pulls; re-pull on show
- [x] Connection quality indicators and unstable-connection banner
- [x] `POST /calls/:callId/stats` telemetry route (Worker) and client summaries
- [x] Pre-join mic check, speaker test, headphones hint

Complete 2026-09-30: Worker 308 tests (6 in `call-stats.test.ts`), app 476 (engine 112). Engine:
`sdp.ts` munges Opus `useinbandfec=1;usedtx=1` on every description it sets (local and remote), RED
preferred via `setCodecPreferences` when offered; CPU sheds a→b (never c) after 3×2 s samples and
restores after 10 s; `bandwidth` limitation is reported only (the browser's BWE already drops layers);
downlink poor 6 s → all cameras on `c`, 6 s more → audio-only (audio and screen keep flowing), recovery
one step per 15 s good; hidden tiles/document pause camera pulls after 5 s; stats every 60 s + final on
leave. Worker: `POST /calls/:callId/stats` validated, per-participant 4/min, one redacted log line,
nothing stored; accepted up to 2 min after leave. UI: quality bars, one banner at a time (audio-only >
unstable > CPU), paused tiles, mic silence warning, speaker test tone, headphones tip.
Real-SFU/browser checks outstanding: RED negotiation, munged fmtp acceptance, Firefox `active=false` and
missing `qualityLimitationReason`, Safari simulcast, `availableIncomingBitrate` availability.

## Stream H: further improvements (feat/chat-video-next)

Branch `feat/chat-video-next` in `/var/web/cfos-chat-video-next`, from `feat/chat-video` at 80d03a0.
Started 2026-09-30, alongside the real-SFU run on `feat/chat-video`. Out of scope, left for a
decision: live captions and transcripts (cost and privacy through the LiteLLM proxy), VP9/AV1 SVC
(needs real SFU data), end-to-end encryption.

- [x] TURN over TCP and TLS on 443 guaranteed in the ICE list (`withFirewallFallbacks`); the live
      `generate-ice-servers` answer already had both on 2026-09-30, and a test pins its shape
- [x] Push-to-talk: Space held while muted, not while focus is on a field, button or menu item;
      released by key-up, window blur or a hidden tab; a mute toggle while held wins; announced
- [x] Chosen audio-only (`setAudioOnly`, `audioOnlyChosen`): the phase 1 paused-video path for every
      camera, own camera off and restored after; separate from the downlink's `audioOnly` banner
- [x] Raise hand (`call-hand`, migration 6 `hand_at`, `CallParticipant.hand`) and quick reactions
      (`call-react`, six emoji, 5 per 10 s per participant, never stored); tile badge with the queue
      place, floating reactions, People list hands-first; both frames additive
- [x] Noise suppression: RNNoise in an AudioWorklet, off by default, remembered, shed under CPU strain
- [x] Background blur: MediaPipe selfie segmenter in a module worker over insertable streams (Chrome
      and Edge), model bundled, off by default, remembered, shed first under CPU strain
- [x] Document Picture-in-Picture: the call floats over other tabs when chat is opened on its own in
      Chrome or Edge; hidden inside the shell's iframe (the API refuses there) and elsewhere
- [x] Docs: package README "Video calls", root README row, `chat.md` out-of-scope note, customization
      note on the CSP, the production mutation summary above

Checked 2026-09-30: Worker 315 tests, app 517, both type-checks. `e2e/effects-check.mjs` in headless
Chromium with fake devices, served under the app's CSP: RNNoise builds in ~40 ms and passes audio
(peak 0.52 from 1.0); blur starts in 0.4-1.2 s and produces 5-8 fps at 640x360 on software GL with
every hard edge softened (max neighbour step 120 → 6).

Not verified in a real browser or call: push-to-talk, audio-only, hands and reactions against the
real Worker and SFU; blur keeping a real person sharp, its frame rate on a real GPU, and its CPU cost;
RNNoise's effect on real noise, and on Firefox (whose AudioContext may refuse a 48 kHz context on a
44.1 kHz device); Document Picture-in-Picture (headless Chromium cannot open one); the CPU monitor
actually shedding an effect on a struggling laptop.
