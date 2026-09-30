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
- [ ] `e2e/call-check.mjs`: five fake-media Chromium contexts against a real dev SFU app
- [ ] README section for calls; update chat.md "out of scope" note
- [ ] Production mutation summary for Harry (SFU app + TURN key creation, secrets, release)

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

See [chat-video.md, "Quality phase 1"](chat-video.md#quality-phase-1-after-the-initial-call-work-lands-this-branch).

- [ ] Capture constraints (AEC/NS/AGC, `voiceIsolation`, 720p30 cap)
- [ ] Opus FEC + DTX; RED where negotiated (verify on the real SFU)
- [ ] Degradation preferences and screen-share content hints
- [ ] CPU / bandwidth adaptation from `qualityLimitationReason` and receive stats; audio-only fallback
- [ ] Pause hidden video pulls; re-pull on show
- [ ] Connection quality indicators and unstable-connection banner
- [ ] `POST /calls/:callId/stats` telemetry route (Worker) and client summaries
- [ ] Pre-join mic check, speaker test, headphones hint
