# Research: Cloudflare Realtime SFU and TURN for chat video calls

Researched 2026-09-30 for [../plans/chat-video.md](../plans/chat-video.md). Sources are the Realtime
docs (pages last updated 22–25 Sep 2026, index at <https://developers.cloudflare.com/realtime/llms.txt>),
the official OpenAPI schema
(<https://developers.cloudflare.com/realtime/static/realtime-api-2024-05-21.yaml>), and three
Cloudflare repositories read at source: `cloudflare/orange` (HEAD 314d424, the reference conferencing
app), `cloudflare/partykit/packages/partytracks` (where orange's negotiation code now lives, v0.0.56)
and `cloudflare/realtime-examples` (the renamed `calls-examples`, notably `video-room`). Anything the
sources did not settle is marked **UNCONFIRMED**.

## Summary

- **Cost is not a constraint.** $0.05/GB egress after 1,000 GB/month free (shared with TURN);
  ingress is free. A 5-way call is roughly 3–14 GB per hour depending on the layers people pull, so
  a team stays inside the free allowance for dozens to hundreds of call-hours a month.
- **The SFU is a media router with an HTTP control API and no room concept.** Sessions (one per
  `RTCPeerConnection`) hold tracks; any session can pull a track published on another session if it
  knows `{sessionId, trackName}`. Discovery, permissions and presence are the app's job — the chat
  Durable Object already has all three.
- **The app secret must stay server-side**, and the proxy must check which sessions and tracks each
  user may touch (Cloudflare's own best-practice note). The chat Worker/DO is that proxy.
- **Negotiation must be serialised per session**, and an SFU offer must be answered through
  `/renegotiate` before anything else happens on that session.
- **Simulcast works and switches layers automatically** — but only if RIDs are named so ASCII order
  runs best to worst and the puller opts in with `priorityOrdering: "asciibetical"`.
- **A track that sends no packets for 30 s is garbage-collected.** Mute by sending silence/black,
  never by stopping the sender.
- **Recovery is a new session**, not an ICE restart: after 30 s without connectivity a session cannot
  be reused, and both reference apps rebuild (new session, re-publish, re-pull).
- **No E2EE by default**, but the SFU forwards encoded frames, so insertable-streams E2EE works
  (orange ships an MLS-based mode). Out of scope for v1.

## The model

| Concept | Meaning |
| --- | --- |
| App | An `appId` + `appSecret` pair. One per environment. |
| Session | One WebRTC transport between one `RTCPeerConnection` and Cloudflare's anycast network. Identified by `sessionId`. |
| Track | A published (`location: "local"`) or pulled (`location: "remote"`) media stream on a session, named by `trackName` and bound to a transceiver `mid` *of that session*. |
| Mid | Per-peer-connection. A subscriber receives a publication on its own, different `mid`; never share mids between clients. |

There are no regions: every Cloudflare server runs SFU/TURN/STUN and clients connect to their
nearest PoP by anycast; media between PoPs rides Cloudflare's backbone
(<https://developers.cloudflare.com/realtime/sfu/concepts/architecture/>).

## HTTP API

Base `https://rtc.live.cloudflare.com/v1/apps/{appId}`, header `Authorization: Bearer <appSecret>`,
JSON bodies. `SessionDescription` is `{sdp: string, type: "offer" | "answer"}`. Source for all of this
section: <https://developers.cloudflare.com/realtime/sfu/api/> and the OpenAPI schema.

| Operation | Method and path |
| --- | --- |
| Create session | `POST /sessions/new` (no body; optional `?correlationId=` diagnostic label, not an idempotency key) → `201 {sessionId}` |
| Publish or pull tracks | `POST /sessions/{sessionId}/tracks/new` |
| Answer an SFU offer | `PUT /sessions/{sessionId}/renegotiate` `{sessionDescription: answer}` → `200 {}` |
| Change a pulled track (simulcast layer) | `PUT /sessions/{sessionId}/tracks/update` |
| Close tracks | `PUT /sessions/{sessionId}/tracks/close` |
| Inspect | `GET /sessions/{sessionId}` → `{tracks:[{location, mid, trackName, sessionId?, status}], dataChannels:[…]}` |

### Publish (client offers, SFU answers)

```json
POST /sessions/{sid}/tracks/new
{ "sessionDescription": {"type":"offer","sdp":"…"},
  "tracks": [ {"location":"local","mid":"0","trackName":"p1-audio"},
              {"location":"local","mid":"1","trackName":"p1-video"} ] }
→ { "requiresImmediateRenegotiation": false,
    "tracks": [ {"trackName":"p1-audio","mid":"0"}, … ],
    "sessionDescription": {"type":"answer","sdp":"…"} }
```

Apply the answer with `setRemoteDescription`; no `/renegotiate` is needed.

### Pull (SFU offers, client answers)

```json
POST /sessions/{sid}/tracks/new
{ "tracks": [ {"location":"remote","sessionId":"<publisher sid>","trackName":"p2-video",
               "simulcast": {"preferredRid":"b","priorityOrdering":"asciibetical","ridNotAvailable":"asciibetical"}} ] }
→ { "requiresImmediateRenegotiation": true,
    "tracks": [ {"sessionId":"…","trackName":"p2-video","mid":"7"} ],
    "sessionDescription": {"type":"offer","sdp":"…"} }
```

When `requiresImmediateRenegotiation` is true: `setRemoteDescription(offer)` → `createAnswer()` →
`setLocalDescription()` → `PUT /renegotiate` with the answer, **before any other mutation on that
session**. A browser reaching `signalingState: "stable"` does not prove the answer reached the SFU
(<https://developers.cloudflare.com/realtime/sfu/concepts/negotiation/>). One request may pull from
several publishers, but a batch is all `local` or all `remote`, at most 64 tracks.

### Close

Negotiated (endpoint healthy): `transceiver.stop()` → offer → `PUT tracks/close
{tracks:[{mid}], sessionDescription: offer, force: false}` → apply the returned answer even if some
items failed. Forced (backend cleanup, no SDP): `{tracks:[{mid},…], force: true}`. The `mid` is always
the one on the session being modified. Closing a published track stops the source for every
subscriber; **removing a track from the app's discovery does not stop existing subscriptions**, so a
leaving participant's published tracks must be closed explicitly
(<https://developers.cloudflare.com/realtime/sfu/best-practices/>). Per-item `close_track_error`
("doesn't exist or was already closed"), HTTP 404 and 410 all mean "already gone".

### Errors

Top-level and per-item `errorCode` / `errorDescription`; **HTTP 200 can carry failed items**, so check
every item. Notable codes
(<https://developers.cloudflare.com/realtime/sfu/observability/error-codes/>):

| Code | Meaning | Handling |
| --- | --- | --- |
| `session_error` + 425 | transport not ready | wait for connection, retry |
| `session_error` + 410 | session expired/closed | replace the session; retrying cannot revive it |
| `invalid_session_description` | bad SDP or offer/answer out of order | client bug; rebuild the connection |
| `not_found_track_error`, `empty_track_error` | publisher not sending (yet) | pull only tracks whose publisher confirmed bytes flowing |
| `update_track_error` | layer change on a non-simulcast track | ignore for screen share |
| `retryable_transient_error`, `temporarily_unavailable_error`, `transport_unavailable_error`, `backend_error`, `internal_error` | service side | bounded retry with backoff |
| HTTP 406 | often overlapping mutations on one session | serialise |

## Negotiation, as the reference apps do it

**orange / partytracks** (`PartyTracks.ts`, `Peer.utils.ts`):

- One `RTCPeerConnection` and one SFU session per client, for both publishing and pulling,
  `bundlePolicy: "max-bundle"`. `sessions/new` and TURN credentials are fetched in parallel.
- Every negotiation runs through one FIFO promise queue for the connection.
- Requests made in the same tick are batched (up to 32–64 tracks) into one `tracks/new` or
  `tracks/close`.
- Publish: `addTransceiver(track, {direction: "sendonly", sendEncodings})` → offer →
  `tracks/new` (local) → apply answer → **wait until `sender.getStats()` shows `outbound-rtp
  bytesSent > 0` before advertising `{sessionId, trackName}`**, to avoid pullers hitting
  `empty_track_error`. Mids are never shared.
- Pull: `tracks/new` (remote) → renegotiate if asked → resolve the stream from the `track` event
  whose `transceiver.mid` equals the returned mid (5 s timeout).
- Close: negotiated, batched, skipped when not connected.
- Reconnect on `connectionState` `failed`/`closed`, `iceConnectionState` `failed`, or `disconnected`
  for more than 7 s: new session, new ICE credentials, new peer connection, re-publish and re-pull
  everything, with backoff. No ICE restart.
- The server proxy forwards to the SFU with the secret and pins each session to its creator with an
  HS256 JWT cookie. (The chat DO does the equivalent with its participant rows.)

**realtime-examples/video-room** (`ARCHITECTURE.md`, `src/server/realtime.ts`): two peer
connections per browser (publish and receive), a Durable Object for room discovery, an SFU offer
locks that session's queue until `/renegotiate` succeeds (15 s, then the session is invalidated),
10 s Worker timeout, retry on network errors/timeouts/429/5xx, `force: true` closes for cleanup,
**10 s heartbeat and 45 s abandonment expiry**.

Chosen for chat: orange's single connection and batching; video-room's heartbeat/expiry timings and
backend force-close.

## Simulcast

(<https://developers.cloudflare.com/realtime/sfu/features/simulcast/>)

Publish with encodings configured before the offer:

```js
pc.addTransceiver(track, { direction: "sendonly", sendEncodings: [
  { rid: "a", scaleResolutionDownBy: 1, maxBitrate: 1_200_000 },
  { rid: "b", scaleResolutionDownBy: 2, maxBitrate:   450_000 },
  { rid: "c", scaleResolutionDownBy: 4, maxBitrate:   150_000 },
]});
```

Pull with a `simulcast` object; change later with `PUT tracks/update {tracks:[{location:"remote",
sessionId, trackName, mid, simulcast:{preferredRid}}]}`.

- `priorityOrdering`: `none` (default) keeps sending the preferred layer regardless of bandwidth;
  `asciibetical` steps down through the layers in a→z order under bandwidth pressure.
- `ridNotAvailable`: `none` (default) does nothing when the preferred layer vanishes (e.g. the sender's
  encoder dropped it); `asciibetical` falls to the next layer.
- **With the defaults there is no automatic switching**, so RIDs are `a` (best), `b`, `c` and both
  options are `asciibetical`.

orange's own settings (behind an experimental flag): two layers, `a` 1.3 Mbps 30 fps and `b` at half
scale 500 kbps 24 fps; audio with `networkPriority: "high"`.

## TURN

(<https://developers.cloudflare.com/realtime/turn/>, `/generate-credentials/`, `/faq/`)

```
POST https://rtc.live.cloudflare.com/v1/turn/keys/{turnKeyId}/credentials/generate-ice-servers
Authorization: Bearer <turnKeyApiToken>
{"ttl": 43200}
→ 201 {"iceServers":[{"urls":["stun:stun.cloudflare.com:3478"]},
        {"urls":["turn:turn.cloudflare.com:3478?transport=udp", "turn:…:443?transport=udp",
                 "turn:…:3478?transport=tcp", "turn:…:80?transport=tcp",
                 "turns:…:5349?transport=tcp", "turns:…:443?transport=tcp"],
         "username":"…","credential":"…"}]}
```

- Pass `iceServers` straight to `new RTCPeerConnection`. `turns:…:443` is the path through
  firewalls that only allow HTTPS.
- **Filter out any port-53 URL**: browsers block it and a non-trickle gather waits for its timeout.
- TTL max 48 h; when a credential expires the allocation is dropped shortly after. Refresh with
  `pc.setConfiguration()` if needed. Revoke: `POST /v1/turn/keys/{keyId}/credentials/{username}/revoke`.
- TURN key token stays server-side; it is not itself a TURN credential.
- The TURN overview says TURN is free with the SFU; the pricing page only says SFU↔TURN traffic is not
  billed twice. Plan on SFU egress being billed either way.
- Per-allocation limits (packets dropped beyond): ~5 new peer IPs/s, 5–10 kpps, 50–100 Mbps.

## Limits

(<https://developers.cloudflare.com/realtime/sfu/platform/limits/>)

| Limit | Value |
| --- | --- |
| API rate | 50 requests/s **per session** |
| Tracks per request | 64 |
| Tracks per session | no fixed bound |
| No media packets on a track | garbage-collected after **30 s** |
| Session reuse after losing connectivity | **30 s**, then a new session is required |
| Wait for transport on operations that need it | 5 s |
| Unconnected session lifetime | expires before first use; duration **UNCONFIRMED** — create it right before negotiating |
| SFU max bitrate | not documented (**UNCONFIRMED**) |
| Codecs | video H.264, H.265, VP8, VP9, AV1; audio Opus, G.711 |

A 5-person join pulls at most 8 tracks (4 × audio + video) in one request, far below every limit.

## Creating the resources

- Dashboard: Realtime → Serverless SFU gives the App ID and secret; Realtime → TURN gives the key id
  and token.
- API (token permission **Calls Write**):
  - `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/calls/apps {"name":"cfos-chat"}` →
    `result {uid (App ID, 32 chars), secret (64 chars), …}`
  - `POST …/accounts/{account_id}/calls/turn_keys {"name":"cfos-chat"}` → `result {uid (key id), key
    (token, 64 chars), …}`
- Use separate apps for dev and production; store secrets as Worker secrets.

## Pricing

(<https://developers.cloudflare.com/realtime/sfu/platform/pricing/>)

$0.05 per GB of egress from Cloudflare to clients; first 1,000 GB/month free, shared by SFU and TURN;
ingress free; one line item. Estimate for a 5-way hour (each person pulls 4 video + 4 audio):

| What each person pulls | GB per call-hour | $ per call-hour | Call-hours in the free tier |
| --- | --- | --- | --- |
| audio only | ~0.4 | ~0.02 | ~2,800 |
| 4 × layer `c`/`b` (grid) | ~4.5 | ~0.23 | ~220 |
| mixed (speaker on `a`, rest `b`) | ~9 | ~0.45 | ~110 |
| 4 × layer `a` | ~13.5 | ~0.68 | ~74 |

## Gotchas that shape the design

1. **Mute keeps packets flowing.** Stopping a sender or `replaceTrack(null)` risks the 30 s
   garbage collection (inference from the limit; **UNCONFIRMED** in docs). orange swaps in a
   black-canvas video track and an inaudible audio track. Chat: mic mute = `track.enabled = false`
   (Opus keeps sending comfort-noise/DTX packets); camera off = stop the camera (so its light goes
   off) and `replaceTrack(blackCanvasTrack)` at 1 fps.
2. **Advertise a track only when bytes flow** (`bytesSent > 0`), or pullers get
   `empty_track_error`. Chat: the DO keeps published tracks `pending` until the client announces them.
3. **Serialise per session; never blindly retry `tracks/new`** (duplicates get allocated). If a
   `tracks/new` response or `/renegotiate` outcome is lost, rebuild the connection.
4. **Backend cleanup.** Abandoned tabs are the norm; the DO force-closes a departed participant's
   published tracks (it knows their mids) and ends empty calls from its alarm.
5. **Autoplay** needs a user gesture — the Join click provides it; remote `<video>` elements are
   `playsInline autoplay` and remote audio plays through `<audio>` elements created after the click.
6. **ICE restart** is not described by the SFU docs (**UNCONFIRMED**); the TURN FAQ recommends clients
   support it because allocations can move during maintenance. Chat tries `restartIce()` once on
   `disconnected`, then rebuilds within the 30 s reuse window if not recovered.
7. **Candidate gathering.** The docs gather before sending `localDescription`; orange sends
   immediately. Chat waits for gathering with a 1.5 s cap.
8. **E2EE.** orange's mode forces VP8 and uses `RTCRtpScriptTransform` (Safari/Firefox) or
   `createEncodedStreams()` (Chrome), with MLS key agreement in a Rust Worker. Worth revisiting only
   if calls carry sensitive content.
9. **Cloudflare's own framing**: for a conferencing product it suggests RealtimeKit (higher-level
   SDK, recording, per-minute pricing) and the raw SFU "when you need direct control"
   (<https://developers.cloudflare.com/realtime/sfu/>). Chat needs direct control because rooms,
   identity and history already live in the chat DO; RealtimeKit would duplicate them.
