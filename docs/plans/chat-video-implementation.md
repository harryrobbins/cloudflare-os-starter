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

- [ ] Migration 5: `calls`, `call_participants`, indexes
- [ ] SFU client with injected fetch; error mapping; redacted logs
- [ ] TURN credential client
- [ ] Join (create call + system message + ring), cap, replace-own-row (`call-moved`)
- [ ] Publish / pull / renegotiate / close-tracks / layer / leave with the authorisation rule
- [ ] `call-beat` frame, change-only broadcast, lazy expiry + alarm, end-of-call message edit
- [ ] `Message.call`, `ChannelListResponse.calls`, `hello.calls`, `MeResponse.calls`
- [ ] Rate limits; kill switch when unconfigured
- [ ] Tests

## Stream B: CallEngine

Owns `app/src/call/engine/*`.

- [ ] Peer connection lifecycle, negotiation queue
- [ ] Publish mic / camera (simulcast h/m/l) / screen; mute; camera off via `replaceTrack`
- [ ] Batched pull; SFU-initiated renegotiation; `mid` → stream mapping; close on participant leave
- [ ] Layer selection by tile size, debounced
- [ ] Active speaker from `getStats`
- [ ] ICE restart then full rejoin; device switching
- [ ] Tests with a fake `RTCPeerConnection`

## Stream C: Call UI and store

Owns `app/src/call/ui/*`, `app/src/call/mock-engine.ts`, and the call additions to
`app/src/store/*`, `app/src/api/*`, `app/src/components/ConversationView.tsx`, `Rail.tsx`,
`MessageRow.tsx`, `Toasts.tsx`, `app/src/lib/bridge.ts`.

- [ ] Store: calls by channel from `call` events, `hello.calls`, channel list; local call state
- [ ] Call button / Join pill in the conversation header; rail glyph
- [ ] Pre-join preview with device pickers
- [ ] Call panel: grid, screen-share layout, active speaker ring, compact (dock) mode, Chat toggle
- [ ] Controls and shortcuts; accessible announcements
- [ ] Ringing: toast, `chat:notify` to the shell, browser notification
- [ ] Call system message rendering (`Message.call`)
- [ ] Full / moved / reconnecting states
- [ ] `chat:call` bridge message to the shell
- [ ] Mock engine (local camera loopback) for mock mode
- [ ] Tests

## Stream D: shell and deployment

Owns the fork's `workshop-frontend/src/components/ChatDock.tsx` (+ tests, `chatDockBus.ts`,
`ChatTrigger.tsx`), `packages/gatekeeper-chat/src/serve.ts` Permissions-Policy, `scripts/deploy.ts`,
`deployment.jsonc` example/docs.

- [ ] iframe `allow` attribute on the chat frame
- [ ] `chat:call` handling: pin the frame while active; live-call indicator on the trigger
- [ ] Permissions-Policy on chat HTML; confirm the shell does not deny the features
- [ ] `chat.calls` deployment block, validation, vars and required secrets
- [ ] Fork commit on a `feat/chat-video` branch in the submodule (not pushed; Harry pushes)

## Stream E: integration and end to end

- [ ] Wire engine + UI + Worker on the local platform
- [ ] `e2e/call-check.mjs`: five fake-media Chromium contexts against a real dev SFU app
- [ ] README section for calls; update chat.md "out of scope" note
- [ ] Production mutation summary for Harry (SFU app + TURN key creation, secrets, release)
