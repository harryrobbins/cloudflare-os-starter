// Video calls: the Durable Object as the room, in front of a fake Cloudflare Realtime.
//
// The SFU and TURN APIs are a fake `fetch` injected through the object's `useRealtime` test seam
// (the same `RealtimeConfig` production builds from its env), so every request the object forwards
// is recorded and can be asserted on -- the body shapes, the session it names, the secret it
// carries. Nothing here reaches Cloudflare.
//
// Fake credentials are built at runtime so no secret-shaped literal sits in the repository.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  CALL_PARTICIPANT_TTL_MS,
  CALL_TURN_TTL_SECONDS,
  MAX_CALL_PARTICIPANTS,
  MAX_SDP_BYTES,
  RATE_LIMITS,
  type CallResponse,
  type ChannelListResponse,
  type ChannelResponse,
  type JoinCallResponse,
  type MeResponse,
  type MessagePageResponse,
  type OkResponse,
  type PublishTracksResponse,
  type PullTracksResponse,
} from "../src/shared/protocol.js";
import { apiPath } from "../src/shared/routes.js";
import type { RealtimeConfig } from "../src/do/sfu.js";
import { TARGET_SCHEMA_VERSION } from "../src/migrations.js";
import type { ChatWorkspace } from "../src/workspace.js";
import { client, freshWorkspace, identity, tick, type Client, type Workspace } from "./helpers.js";

// ---------------------------------------------------------------------------
// The fake Realtime
// ---------------------------------------------------------------------------

const APP_ID = "0a".repeat(16);
const APP_SECRET = ["5e", "a1"].join("").repeat(16);
const TURN_KEY_ID = "7c".repeat(16);
const TURN_TOKEN = ["9d", "b2"].join("").repeat(16);

interface Recorded {
  readonly method: string;
  /** Path after `/v1`, e.g. `/apps/<id>/sessions/sfu-1/tracks/new`. */
  readonly path: string;
  readonly auth: string | null;
  readonly body: Record<string, unknown> | null;
}

type Responder = (request: Recorded) => Response | null;

interface FakeRealtime {
  readonly requests: Recorded[];
  /** SFU requests only, as `METHOD op` with the session id kept, e.g. `POST sfu-1/tracks/new`. */
  ops(): string[];
  /** One-shot override for the next request it matches (returns non-null). */
  once(responder: Responder): void;
  config(turn?: boolean): RealtimeConfig;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeRealtime(): FakeRealtime {
  const requests: Recorded[] = [];
  const overrides: Responder[] = [];
  let sessions = 0;

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const raw = typeof init?.body === "string" ? init.body : null;
    const recorded: Recorded = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/v1/u, ""),
      auth: headers.get("authorization"),
      body: raw === null ? null : (JSON.parse(raw) as Record<string, unknown>),
    };
    requests.push(recorded);
    for (let i = 0; i < overrides.length; i++) {
      const response = overrides[i]!(recorded);
      if (response !== null) {
        overrides.splice(i, 1);
        return response;
      }
    }
    return defaultResponse(recorded);
  };

  function defaultResponse(request: Recorded): Response {
    const path = request.path;
    if (path.startsWith("/turn/")) {
      return jsonResponse(
        {
          iceServers: [
            { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
            {
              urls: [
                "turn:turn.cloudflare.com:3478?transport=udp",
                "turn:turn.cloudflare.com:53?transport=udp",
                "turns:turn.cloudflare.com:443?transport=tcp",
              ],
              username: "minted-user",
              credential: "minted-credential",
            },
          ],
        },
        201,
      );
    }
    if (path.endsWith("/sessions/new")) return jsonResponse({ sessionId: `sfu-${++sessions}` }, 201);
    const body = request.body ?? {};
    const tracks = (body["tracks"] as Record<string, unknown>[] | undefined) ?? [];
    if (path.endsWith("/tracks/new")) {
      if (body["sessionDescription"] !== undefined) {
        return jsonResponse({
          requiresImmediateRenegotiation: false,
          sessionDescription: { type: "answer", sdp: "v=0 answer" },
          tracks: tracks.map((track) => ({ mid: track["mid"], trackName: track["trackName"] })),
        });
      }
      return jsonResponse({
        requiresImmediateRenegotiation: true,
        sessionDescription: { type: "offer", sdp: "v=0 sfu-offer" },
        tracks: tracks.map((track, index) => ({
          sessionId: track["sessionId"],
          trackName: track["trackName"],
          mid: String(100 + index),
        })),
      });
    }
    if (path.endsWith("/renegotiate")) return jsonResponse({});
    if (path.endsWith("/tracks/close")) {
      return jsonResponse({
        tracks: tracks.map((track) => ({ mid: track["mid"] })),
        ...(body["sessionDescription"] === undefined ? {} : { sessionDescription: { type: "answer", sdp: "v=0 close" } }),
      });
    }
    if (path.endsWith("/tracks/update")) return jsonResponse({ tracks });
    return jsonResponse({ errorCode: "not_found", errorDescription: "fake has no such route" }, 404);
  }

  return {
    requests,
    ops() {
      return requests
        .filter((request) => request.path.startsWith(`/apps/${APP_ID}/`))
        .map((request) => `${request.method} ${request.path.slice(`/apps/${APP_ID}/`.length).replace(/^sessions\//u, "")}`);
    },
    once(responder) {
      overrides.push(responder);
    },
    config(turn = true) {
      return {
        sfuAppId: APP_ID,
        sfuAppSecret: APP_SECRET,
        turnKeyId: turn ? TURN_KEY_ID : null,
        turnKeyApiToken: turn ? TURN_TOKEN : null,
        fetch: fetchImpl as typeof fetch,
      };
    },
  };
}

async function enableCalls(workspace: Workspace, fake: FakeRealtime, turn = true): Promise<void> {
  await runInDurableObject(workspace, (instance: ChatWorkspace) => instance.useRealtime(fake.config(turn)));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function setup(label: string, { turn = true }: { turn?: boolean } = {}) {
  const workspace = freshWorkspace(`calls-${label}`);
  const fake = fakeRealtime();
  await enableCalls(workspace, fake, turn);
  const alice = client(workspace, identity("alice", "Alice"));
  const bob = client(workspace, identity("bob", "Bob"));
  const carol = client(workspace, identity("carol", "Carol"));
  // Everybody signs in once, so the directory knows them.
  for (const who of [alice, bob, carol]) await who.get<MeResponse>(apiPath("me"));
  return { workspace, fake, alice, bob, carol };
}

async function createChannel(owner: Client, body: Record<string, unknown>): Promise<string> {
  const created = await owner.send<ChannelResponse>("POST", apiPath("createChannel"), body);
  return created.channel.id;
}

function join(who: Client, channelId: string): Promise<JoinCallResponse> {
  return who.send<JoinCallResponse>("POST", apiPath("joinCall", { channelId }), {});
}

const OFFER = { type: "offer", sdp: "v=0 client-offer" } as const;

async function publishAndAnnounce(
  who: Client,
  joined: JoinCallResponse,
  tracks: { mid: string; kind: "audio" | "video" | "screen"; simulcast: boolean }[],
): Promise<PublishTracksResponse> {
  const callId = joined.call.id;
  const published = await who.send<PublishTracksResponse>("POST", apiPath("publishTracks", { callId }), {
    participantId: joined.participantId,
    offer: OFFER,
    tracks,
  });
  await who.send<CallResponse>("POST", apiPath("announceTracks", { callId }), {
    participantId: joined.participantId,
    names: published.tracks.map((track) => track.name),
  });
  return published;
}

async function sql<T extends Record<string, SqlStorageValue>>(workspace: Workspace, query: string, ...params: unknown[]): Promise<T[]> {
  return runInDurableObject(workspace, (_instance, state) => state.storage.sql.exec<T>(query, ...params).toArray());
}

// ---------------------------------------------------------------------------
// Schema and the kill switch
// ---------------------------------------------------------------------------

describe("migration 5", () => {
  it("creates the call tables and their partial unique indexes", async () => {
    const workspace = freshWorkspace("calls-migration");
    await expect(workspace.schemaVersion()).resolves.toBe(TARGET_SCHEMA_VERSION);
    expect(TARGET_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    const indexes = await sql<{ name: string }>(
      workspace,
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('calls', 'call_participants') ORDER BY name`,
    );
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining(["calls_one_active", "call_participants_live"]),
    );
    const columns = await sql<{ name: string }>(workspace, `SELECT name FROM pragma_table_info('call_participants')`);
    expect(columns.map((row) => row.name)).toEqual([
      "id",
      "call_id",
      "user_id",
      "sfu_session_id",
      "joined_at",
      "left_at",
      "last_seen_at",
      "audio",
      "video",
      "screen",
      "tracks",
    ]);
  });
});

describe("the kill switch", () => {
  it("answers every call route 503 unavailable and reports calls disabled without SFU credentials", async () => {
    const workspace = freshWorkspace("calls-off");
    const alice = client(workspace, identity("alice", "Alice"));
    const me = await alice.get<MeResponse>(apiPath("me"));
    expect(me.calls).toEqual({ enabled: false, maxParticipants: MAX_CALL_PARTICIPANTS });

    const body = { participantId: "p_x" };
    const routes: [string, string][] = [
      ["GET", apiPath("getCall", { channelId: "general" })],
      ["POST", apiPath("joinCall", { channelId: "general" })],
      ["POST", apiPath("publishTracks", { callId: "cl_x" })],
      ["POST", apiPath("announceTracks", { callId: "cl_x" })],
      ["POST", apiPath("pullTracks", { callId: "cl_x" })],
      ["POST", apiPath("renegotiateCall", { callId: "cl_x" })],
      ["POST", apiPath("closeTracks", { callId: "cl_x" })],
      ["POST", apiPath("setLayer", { callId: "cl_x" })],
      ["POST", apiPath("reconnectCall", { callId: "cl_x" })],
      ["POST", apiPath("leaveCall", { callId: "cl_x" })],
      ["POST", apiPath("postCallStats", { callId: "cl_x" })],
    ];
    for (const [method, path] of routes) {
      expect(await alice.error(method, path, body), path).toEqual({ status: 503, code: "unavailable" });
    }
    const rail = await alice.get<ChannelListResponse>(apiPath("listChannels"));
    expect(rail.calls).toEqual([]);
  });

  it("reports calls enabled once the SFU is configured", async () => {
    const { alice } = await setup("on");
    const me = await alice.get<MeResponse>(apiPath("me"));
    expect(me.calls).toEqual({ enabled: true, maxParticipants: MAX_CALL_PARTICIPANTS });
  });
});

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

describe("joining", () => {
  it("starts a call with a system message, a fresh SFU session and filtered TURN servers", async () => {
    const { workspace, fake, alice, bob } = await setup("start");
    const channelId = await createChannel(alice, { kind: "public", name: "standup" });
    const bobSocket = await bob.socket();

    const joined = await join(alice, channelId);
    expect(joined.sessionId).toBe("sfu-1");
    expect(joined.call).toMatchObject({ channelId, startedBy: "alice" });
    expect(joined.call.participants).toEqual([
      expect.objectContaining({ id: joined.participantId, userId: "alice", sessionId: "sfu-1", tracks: [] }),
    ]);
    // Port-53 URLs are gone; the rest are passed through as minted.
    expect(joined.iceServers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
        username: "minted-user",
        credential: "minted-credential",
      },
    ]);

    const sessionNew = fake.requests.find((request) => request.path.endsWith("/sessions/new"))!;
    expect(sessionNew).toMatchObject({ method: "POST", path: `/apps/${APP_ID}/sessions/new`, auth: `Bearer ${APP_SECRET}` });
    const turn = fake.requests.find((request) => request.path.startsWith("/turn/"))!;
    expect(turn).toMatchObject({
      method: "POST",
      path: `/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`,
      auth: `Bearer ${TURN_TOKEN}`,
      body: { ttl: CALL_TURN_TTL_SECONDS },
    });

    // The system message carries the call, active, with the starter in it.
    const msg = await bobSocket.next("msg");
    expect(msg.message).toMatchObject({
      kind: "system",
      body: "Alice started a call",
      call: { id: joined.call.id, state: "active", endedAt: null, participantIds: ["alice"] },
    });
    const event = await bobSocket.next("call");
    expect(event).toMatchObject({ channel: channelId, call: { id: joined.call.id } });
    expect(event.ring).toBeUndefined();

    // History, the rail, hello and GET all see it.
    const page = await bob.get<MessagePageResponse>(apiPath("listMessages", { channelId }));
    expect(page.messages.find((message) => message.id === joined.call.messageId)?.call?.state).toBe("active");
    const rail = await bob.get<ChannelListResponse>(apiPath("listChannels"));
    expect(rail.calls?.map((call) => call.id)).toEqual([joined.call.id]);
    const hello = await (await bob.socket()).next("hello");
    expect(hello.calls?.map((call) => call.id)).toEqual([joined.call.id]);
    const got = await bob.get<CallResponse>(apiPath("getCall", { channelId }));
    expect(got.call?.participants.map((participant) => participant.userId)).toEqual(["alice"]);

    // A second joiner joins the same call; joining a public channel's call joins the channel.
    const second = await join(bob, channelId);
    expect(second.call.id).toBe(joined.call.id);
    expect(second.call.participants.map((participant) => participant.userId)).toEqual(["alice", "bob"]);
    const membership = await sql(workspace, `SELECT 1 FROM memberships WHERE channel_id = ? AND user_id = 'bob'`, channelId);
    expect(membership).toHaveLength(1);
    const calls = await sql<{ peak_participants: number }>(workspace, `SELECT peak_participants FROM calls`);
    expect(calls).toEqual([{ peak_participants: 2 }]);
  });

  it("hands out STUN only when no TURN key is configured", async () => {
    const { fake, alice } = await setup("stun", { turn: false });
    const joined = await join(alice, "general");
    expect(joined.iceServers).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
    expect(fake.requests.some((request) => request.path.startsWith("/turn/"))).toBe(false);
  });

  it("rings the other members of a DM, but not the starter, and never a channel", async () => {
    const { alice, bob } = await setup("ring");
    const dm = await createChannel(alice, { kind: "dm", memberIds: ["bob"] });
    const aliceSocket = await alice.socket();
    const bobSocket = await bob.socket();

    await join(alice, dm);
    expect((await bobSocket.next("call")).ring).toBe(true);
    expect((await aliceSocket.next("call")).ring).toBeUndefined();

    const channelId = await createChannel(alice, { kind: "public", name: "no-ring" });
    await join(alice, channelId);
    const event = await bobSocket.next("call");
    expect(event.channel).toBe(channelId);
    expect(event.ring).toBeUndefined();
  });

  // Found on the real SFU: Bob's socket subscribed to the conversations it knew when it connected, so a
  // DM Alice created afterwards (the usual first call) never rang him.
  it("rings a member whose socket subscribed before the DM existed", async () => {
    const { alice, bob } = await setup("ring-late-dm");
    const bobSocket = await bob.socket();
    await bobSocket.next("hello");
    bobSocket.send({ t: "sub", channels: ["general"] });
    const dm = await createChannel(alice, { kind: "dm", memberIds: ["bob"] });

    await join(alice, dm);
    const event = await bobSocket.next("call");
    expect(event).toMatchObject({ channel: dm, ring: true });
  });

  it(`refuses the participant after ${MAX_CALL_PARTICIPANTS} with conflict, before creating an SFU session`, async () => {
    const { workspace, fake } = await setup("cap");
    const people = Array.from({ length: MAX_CALL_PARTICIPANTS + 1 }, (_, i) => client(workspace, identity(`u${i}`)));
    for (const who of people.slice(0, MAX_CALL_PARTICIPANTS)) await join(who, "general");
    const sessions = fake.requests.filter((request) => request.path.endsWith("/sessions/new")).length;
    expect(await people.at(-1)!.error("POST", apiPath("joinCall", { channelId: "general" }), {})).toEqual({
      status: 409,
      code: "conflict",
    });
    expect(fake.requests.filter((request) => request.path.endsWith("/sessions/new")).length).toBe(sessions);
    // Rejoining from another tab is not a sixth person.
    await join(people[0]!, "general");
  });

  it("replaces a person's older participant: call-moved to their sockets, old tracks force-closed", async () => {
    const { workspace, fake, alice } = await setup("replace");
    const first = await join(alice, "general");
    await publishAndAnnounce(alice, first, [{ mid: "0", kind: "audio", simulcast: false }]);
    const socket = await alice.socket();

    const second = await join(alice, "general");
    expect(second.participantId).not.toBe(first.participantId);
    expect(second.call.participants.map((participant) => participant.id)).toEqual([second.participantId]);
    expect(await socket.next("call-moved")).toEqual({
      t: "call-moved",
      call: first.call.id,
      participant: first.participantId,
      reason: "replaced",
    });
    const close = fake.requests.find((request) => request.path.endsWith(`/sessions/${first.sessionId}/tracks/close`));
    expect(close?.body).toEqual({ tracks: [{ mid: "0" }], force: true });

    // The replaced participant can no longer signal.
    expect(
      await alice.error("POST", apiPath("renegotiateCall", { callId: first.call.id }), {
        participantId: first.participantId,
        answer: { type: "answer", sdp: "v=0" },
      }),
    ).toEqual({ status: 404, code: "not_found" });
    const live = await sql(workspace, `SELECT id FROM call_participants WHERE left_at IS NULL`);
    expect(live).toEqual([{ id: second.participantId }]);
  });
});

// ---------------------------------------------------------------------------
// Publish, announce, pull
// ---------------------------------------------------------------------------

describe("publishing and pulling", () => {
  it("names tracks, forwards the offer, and pulls from the publisher's session with simulcast options", async () => {
    const { fake, alice, bob } = await setup("media");
    const bobSocket = await bob.socket();
    const a = await join(alice, "general");
    const b = await join(bob, "general");
    const callId = a.call.id;

    const published = await alice.send<PublishTracksResponse>("POST", apiPath("publishTracks", { callId }), {
      participantId: a.participantId,
      offer: OFFER,
      tracks: [
        { mid: "0", kind: "audio", simulcast: false },
        { mid: "1", kind: "video", simulcast: true },
      ],
    });
    expect(published).toEqual({
      answer: { type: "answer", sdp: "v=0 answer" },
      tracks: [
        { mid: "0", name: `${a.participantId}-audio`, kind: "audio" },
        { mid: "1", name: `${a.participantId}-video`, kind: "video" },
      ],
    });
    const publish = fake.requests.find((request) => request.path.endsWith(`/sessions/${a.sessionId}/tracks/new`))!;
    expect(publish.body).toEqual({
      sessionDescription: OFFER,
      tracks: [
        { location: "local", mid: "0", trackName: `${a.participantId}-audio` },
        { location: "local", mid: "1", trackName: `${a.participantId}-video` },
      ],
    });

    // Unannounced tracks are invisible and unpullable.
    const pullBody = {
      participantId: b.participantId,
      tracks: [
        { participantId: a.participantId, name: `${a.participantId}-audio` },
        { participantId: a.participantId, name: `${a.participantId}-video`, rid: "c" },
      ],
    };
    expect(await bob.error("POST", apiPath("pullTracks", { callId }), pullBody)).toEqual({ status: 404, code: "not_found" });

    // Publishing the same kind twice is refused.
    expect(
      await alice.error("POST", apiPath("publishTracks", { callId }), {
        participantId: a.participantId,
        offer: OFFER,
        tracks: [{ mid: "2", kind: "audio", simulcast: false }],
      }),
    ).toEqual({ status: 409, code: "conflict" });

    const announced = await alice.send<CallResponse>("POST", apiPath("announceTracks", { callId }), {
      participantId: a.participantId,
      names: [`${a.participantId}-audio`, `${a.participantId}-video`],
    });
    const aliceState = announced.call!.participants.find((participant) => participant.id === a.participantId)!;
    expect(aliceState).toMatchObject({
      audio: true,
      video: true,
      screen: false,
      tracks: [
        { name: `${a.participantId}-audio`, kind: "audio", simulcast: false },
        { name: `${a.participantId}-video`, kind: "video", simulcast: true },
      ],
    });
    // Bob's socket sees the announcement.
    for (;;) {
      const event = await bobSocket.next("call");
      if (event.call?.participants.some((participant) => participant.tracks.length === 2)) break;
    }

    const pulled = await bob.send<PullTracksResponse>("POST", apiPath("pullTracks", { callId }), pullBody);
    expect(pulled).toEqual({
      offer: { type: "offer", sdp: "v=0 sfu-offer" },
      requiresImmediateRenegotiation: true,
      tracks: [
        { participantId: a.participantId, name: `${a.participantId}-audio`, mid: "100" },
        { participantId: a.participantId, name: `${a.participantId}-video`, mid: "101" },
      ],
    });
    const pull = fake.requests.filter((request) => request.path.endsWith(`/sessions/${b.sessionId}/tracks/new`)).at(-1)!;
    expect(pull.body).toEqual({
      tracks: [
        { location: "remote", sessionId: a.sessionId, trackName: `${a.participantId}-audio` },
        {
          location: "remote",
          sessionId: a.sessionId,
          trackName: `${a.participantId}-video`,
          simulcast: { preferredRid: "c", priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" },
        },
      ],
    });

    await bob.send<OkResponse>("POST", apiPath("renegotiateCall", { callId }), {
      participantId: b.participantId,
      answer: { type: "answer", sdp: "v=0 bob-answer" },
    });
    expect(fake.requests.at(-1)).toMatchObject({
      method: "PUT",
      path: `/apps/${APP_ID}/sessions/${b.sessionId}/renegotiate`,
      body: { sessionDescription: { type: "answer", sdp: "v=0 bob-answer" } },
    });

    await bob.send<OkResponse>("POST", apiPath("setLayer", { callId }), {
      participantId: b.participantId,
      mid: "101",
      trackParticipantId: a.participantId,
      name: `${a.participantId}-video`,
      rid: "a",
    });
    expect(fake.requests.at(-1)).toMatchObject({
      method: "PUT",
      path: `/apps/${APP_ID}/sessions/${b.sessionId}/tracks/update`,
      body: {
        tracks: [
          {
            location: "remote",
            sessionId: a.sessionId,
            trackName: `${a.participantId}-video`,
            mid: "101",
            simulcast: { preferredRid: "a", priorityOrdering: "asciibetical", ridNotAvailable: "asciibetical" },
          },
        ],
      },
    });
    // A single-layer track has no layers to choose.
    expect(
      await bob.error("POST", apiPath("setLayer", { callId }), {
        participantId: b.participantId,
        mid: "100",
        trackParticipantId: a.participantId,
        name: `${a.participantId}-audio`,
        rid: "a",
      }),
    ).toEqual({ status: 400, code: "invalid_request" });
  });

  it("reports per-item pull errors in request order, and fails a publish whose 200 carries a failed item", async () => {
    const { fake, alice, bob } = await setup("item-errors");
    const a = await join(alice, "general");
    const b = await join(bob, "general");
    const callId = a.call.id;
    await publishAndAnnounce(alice, a, [
      { mid: "0", kind: "audio", simulcast: false },
      { mid: "1", kind: "video", simulcast: false },
    ]);

    fake.once((request) =>
      request.path.endsWith(`/sessions/${b.sessionId}/tracks/new`)
        ? jsonResponse({
            requiresImmediateRenegotiation: true,
            sessionDescription: { type: "offer", sdp: "v=0" },
            tracks: [
              { sessionId: a.sessionId, trackName: `${a.participantId}-audio`, mid: "5" },
              { sessionId: a.sessionId, trackName: `${a.participantId}-video`, errorCode: "not_found_track_error" },
            ],
          })
        : null,
    );
    const pulled = await bob.send<PullTracksResponse>("POST", apiPath("pullTracks", { callId }), {
      participantId: b.participantId,
      tracks: [
        { participantId: a.participantId, name: `${a.participantId}-audio` },
        { participantId: a.participantId, name: `${a.participantId}-video` },
      ],
    });
    expect(pulled.tracks).toEqual([
      { participantId: a.participantId, name: `${a.participantId}-audio`, mid: "5" },
      { participantId: a.participantId, name: `${a.participantId}-video`, mid: null, error: "not_found_track_error" },
    ]);

    fake.once((request) =>
      request.path.endsWith(`/sessions/${b.sessionId}/tracks/new`)
        ? jsonResponse({
            sessionDescription: { type: "answer", sdp: "v=0" },
            tracks: [{ mid: "0", trackName: `${b.participantId}-audio`, errorCode: "invalid_track_error" }],
          })
        : null,
    );
    expect(
      await bob.error("POST", apiPath("publishTracks", { callId }), {
        participantId: b.participantId,
        offer: OFFER,
        tracks: [{ mid: "0", kind: "audio", simulcast: false }],
      }),
    ).toEqual({ status: 502, code: "upstream_error" });
    // Nothing was recorded for the failed publish, so a retry is not a "second audio track".
    const state = await bob.get<CallResponse>(apiPath("getCall", { channelId: "general" }));
    expect(state.call!.participants.find((participant) => participant.id === b.participantId)!.tracks).toEqual([]);

  });

  it("maps a failed session creation to upstream_error and retries a transient one", async () => {
    const { fake, alice } = await setup("session-errors");
    fake.once((request) => (request.path.endsWith("/sessions/new") ? jsonResponse({ errorCode: "session_error" }, 400) : null));
    expect(await alice.error("POST", apiPath("joinCall", { channelId: "general" }), {})).toEqual({
      status: 502,
      code: "upstream_error",
    });
    // A 503 is transient and sessions/new is safe to repeat: the second attempt succeeds.
    fake.once((request) => (request.path.endsWith("/sessions/new") ? new Response("busy", { status: 503 }) : null));
    const before = fake.requests.length;
    const joined = await join(alice, "general");
    expect(joined.sessionId).toMatch(/^sfu-/u);
    expect(fake.requests.slice(before).filter((request) => request.path.endsWith("/sessions/new"))).toHaveLength(2);

    // tracks/new is never retried blind.
    fake.once((request) => (request.path.endsWith("/tracks/new") ? new Response("busy", { status: 503 }) : null));
    const count = fake.requests.length;
    expect(
      await alice.error("POST", apiPath("publishTracks", { callId: joined.call.id }), {
        participantId: joined.participantId,
        offer: OFFER,
        tracks: [{ mid: "0", kind: "audio", simulcast: false }],
      }),
    ).toEqual({ status: 502, code: "upstream_error" });
    expect(fake.requests.slice(count).filter((request) => request.path.endsWith("/tracks/new"))).toHaveLength(1);
  });

  it("closes tracks negotiated or forced and drops them from the call", async () => {
    const { fake, alice } = await setup("close");
    const a = await join(alice, "general");
    const callId = a.call.id;
    await publishAndAnnounce(alice, a, [
      { mid: "0", kind: "audio", simulcast: false },
      { mid: "1", kind: "screen", simulcast: false },
    ]);
    let state = await alice.get<CallResponse>(apiPath("getCall", { channelId: "general" }));
    expect(state.call!.participants[0]).toMatchObject({ audio: true, screen: true });

    const closed = await alice.send<{ answer?: unknown }>("POST", apiPath("closeTracks", { callId }), {
      participantId: a.participantId,
      mids: ["1"],
      offer: OFFER,
    });
    expect(closed).toEqual({ answer: { type: "answer", sdp: "v=0 close" } });
    expect(fake.requests.at(-1)!.body).toEqual({ tracks: [{ mid: "1" }], sessionDescription: OFFER, force: false });
    state = await alice.get<CallResponse>(apiPath("getCall", { channelId: "general" }));
    expect(state.call!.participants[0]).toMatchObject({ audio: true, screen: false });
    expect(state.call!.participants[0]!.tracks.map((track) => track.kind)).toEqual(["audio"]);

    expect(
      await alice.send("POST", apiPath("closeTracks", { callId }), { participantId: a.participantId, mids: ["0"] }),
    ).toEqual({});
    expect(fake.requests.at(-1)!.body).toEqual({ tracks: [{ mid: "0" }], force: true });
  });

  it("reconnects onto a new session, clearing tracks and closing the old ones", async () => {
    const { fake, alice } = await setup("reconnect");
    const a = await join(alice, "general");
    await publishAndAnnounce(alice, a, [{ mid: "0", kind: "audio", simulcast: false }]);
    const again = await alice.send<JoinCallResponse>("POST", apiPath("reconnectCall", { callId: a.call.id }), {
      participantId: a.participantId,
    });
    expect(again.participantId).toBe(a.participantId);
    expect(again.sessionId).not.toBe(a.sessionId);
    expect(again.call.participants[0]).toMatchObject({ sessionId: again.sessionId, audio: false, tracks: [] });
    expect(again.iceServers.length).toBeGreaterThan(0);
    const close = fake.requests.find((request) => request.path.endsWith(`/sessions/${a.sessionId}/tracks/close`));
    expect(close?.body).toEqual({ tracks: [{ mid: "0" }], force: true });
  });
});

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

describe("authorisation", () => {
  it("keeps outsiders out of a private conversation's call", async () => {
    const { alice, bob, carol } = await setup("private");
    const secret = await createChannel(alice, { kind: "private", name: "secret", memberIds: ["bob"] });
    const joined = await join(alice, secret);
    expect(await carol.error("POST", apiPath("joinCall", { channelId: secret }), {})).toEqual({
      status: 404,
      code: "not_found",
    });
    expect(await carol.error("GET", apiPath("getCall", { channelId: secret }))).toEqual({ status: 404, code: "not_found" });
    const rail = await carol.get<ChannelListResponse>(apiPath("listChannels"));
    expect(rail.calls?.some((call) => call.id === joined.call.id)).toBe(false);
    // Carol cannot use Alice's participant either.
    expect(
      await carol.error("POST", apiPath("pullTracks", { callId: joined.call.id }), {
        participantId: joined.participantId,
        tracks: [{ participantId: joined.participantId, name: `${joined.participantId}-audio` }],
      }),
    ).toEqual({ status: 404, code: "not_found" });
    await join(bob, secret);
  });

  it("refuses a participant the caller does not own", async () => {
    const { alice, bob } = await setup("foreign");
    const a = await join(alice, "general");
    await join(bob, "general");
    for (const [route, body] of [
      ["publishTracks", { participantId: a.participantId, offer: OFFER, tracks: [{ mid: "0", kind: "audio", simulcast: false }] }],
      ["renegotiateCall", { participantId: a.participantId, answer: { type: "answer", sdp: "v=0" } }],
      ["reconnectCall", { participantId: a.participantId }],
      ["leaveCall", { participantId: a.participantId }],
    ] as const) {
      expect(await bob.error("POST", apiPath(route, { callId: a.call.id }), body), route).toEqual({
        status: 403,
        code: "forbidden",
      });
    }
  });

  it("only pulls announced tracks of live participants of the same call", async () => {
    const { workspace, alice, bob, carol } = await setup("pull-rules");
    const other = await createChannel(carol, { kind: "public", name: "elsewhere" });
    const c = await join(carol, other);
    await publishAndAnnounce(carol, c, [{ mid: "0", kind: "audio", simulcast: false }]);

    const a = await join(alice, "general");
    const b = await join(bob, "general");
    await publishAndAnnounce(bob, b, [{ mid: "0", kind: "audio", simulcast: false }]);
    const pull = (participantId: string, name: string) =>
      alice.error("POST", apiPath("pullTracks", { callId: a.call.id }), {
        participantId: a.participantId,
        tracks: [{ participantId, name }],
      });

    // A track in another call, even though Carol's call is public and live.
    expect(await pull(c.participantId, `${c.participantId}-audio`)).toEqual({ status: 404, code: "not_found" });
    // A name the publisher never announced.
    expect(await pull(b.participantId, `${b.participantId}-video`)).toEqual({ status: 404, code: "not_found" });
    // A client-supplied session id is not part of the contract and is ignored by validation; the
    // pull still resolves Bob's session from his row.
    const ok = await alice.send<PullTracksResponse>("POST", apiPath("pullTracks", { callId: a.call.id }), {
      participantId: a.participantId,
      tracks: [{ participantId: b.participantId, name: `${b.participantId}-audio`, sessionId: c.sessionId }],
    });
    expect(ok.tracks[0]!.mid).toBe("100");

    // A departed participant's track.
    await bob.send<OkResponse>("POST", apiPath("leaveCall", { callId: a.call.id }), { participantId: b.participantId });
    expect(await pull(b.participantId, `${b.participantId}-audio`)).toEqual({ status: 404, code: "not_found" });
    const rows = await sql(workspace, `SELECT left_at IS NOT NULL AS gone FROM call_participants WHERE id = ?`, b.participantId);
    expect(rows).toEqual([{ gone: 1 }]);
  });

  it("validates SDP, mids, rids and track counts", async () => {
    const { alice } = await setup("validation");
    const a = await join(alice, "general");
    const route = apiPath("publishTracks", { callId: a.call.id });
    const base = { participantId: a.participantId, tracks: [{ mid: "0", kind: "audio", simulcast: false }] };
    const bad = [
      { ...base, offer: { type: "answer", sdp: "v=0" } },
      { ...base, offer: { type: "offer", sdp: "x".repeat(MAX_SDP_BYTES + 1) } },
      { ...base, offer: OFFER, tracks: [{ mid: "0 1", kind: "audio", simulcast: false }] },
      { ...base, offer: OFFER, tracks: [{ mid: "0", kind: "hologram", simulcast: false }] },
      { ...base, offer: OFFER, tracks: [] },
      { ...base, offer: OFFER, participantId: "not an id" },
    ];
    for (const body of bad) expect(await alice.status("POST", route, body)).toBe(400);
    expect(
      await alice.status("POST", apiPath("pullTracks", { callId: a.call.id }), {
        participantId: a.participantId,
        tracks: [{ participantId: a.participantId, name: "x", rid: "z" }],
      }),
    ).toBe(400);
    expect(
      await alice.status("POST", apiPath("pullTracks", { callId: a.call.id }), {
        participantId: a.participantId,
        tracks: Array.from({ length: 33 }, (_, i) => ({ participantId: a.participantId, name: `t${i}` })),
      }),
    ).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Leaving, the end of a call, expiry
// ---------------------------------------------------------------------------

describe("the end of a call", () => {
  it("force-closes a leaver's tracks, ends the call when the last one leaves, and edits the message", async () => {
    const { workspace, fake, alice, bob, carol } = await setup("leave");
    const watcher = await carol.socket();
    const a = await join(alice, "general");
    const b = await join(bob, "general");
    const published = await publishAndAnnounce(bob, b, [
      { mid: "3", kind: "audio", simulcast: false },
      { mid: "4", kind: "video", simulcast: true },
    ]);
    expect(published.tracks.map((track) => track.mid)).toEqual(["3", "4"]);

    await bob.send<OkResponse>("POST", apiPath("leaveCall", { callId: a.call.id }), { participantId: b.participantId });
    const close = fake.requests.find((request) => request.path.endsWith(`/sessions/${b.sessionId}/tracks/close`));
    expect(close?.body).toEqual({ tracks: [{ mid: "3" }, { mid: "4" }], force: true });
    // Leaving twice is not an error.
    await bob.send<OkResponse>("POST", apiPath("leaveCall", { callId: a.call.id }), { participantId: b.participantId });

    await alice.send<OkResponse>("POST", apiPath("leaveCall", { callId: a.call.id }), { participantId: a.participantId });
    const edit = await watcher.next("edit");
    expect(edit.message).toMatchObject({
      id: a.call.messageId,
      call: { id: a.call.id, state: "ended", participantIds: ["alice", "bob"] },
    });
    expect(edit.message.call!.endedAt).toEqual(expect.any(Number));
    expect(edit.message.body).toMatch(/^Call ended · under a minute · Alice, Bob$/u);
    for (;;) {
      const event = await watcher.next("call");
      if (event.call === null) break;
    }
    expect(await alice.get<CallResponse>(apiPath("getCall", { channelId: "general" }))).toEqual({ call: null });
    const ended = await sql<{ ended_at: number | null }>(workspace, `SELECT ended_at FROM calls WHERE id = ?`, a.call.id);
    expect(ended[0]!.ended_at).not.toBeNull();

    // A new join starts a new call.
    const next = await join(alice, "general");
    expect(next.call.id).not.toBe(a.call.id);
  });

  it("expires silent participants from the alarm, telling their sockets and ending an empty call", async () => {
    const { workspace, fake, alice, bob } = await setup("expiry");
    const a = await join(alice, "general");
    const b = await join(bob, "general");
    await publishAndAnnounce(bob, b, [{ mid: "7", kind: "audio", simulcast: false }]);
    const bobSocket = await bob.socket();
    const aliceSocket = await alice.socket();

    const alarm = await runInDurableObject(workspace, (_instance, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();

    const stale = Date.now() - CALL_PARTICIPANT_TTL_MS - 1_000;
    await sql(workspace, `UPDATE call_participants SET last_seen_at = ? WHERE id = ?`, stale, b.participantId);
    expect(await runDurableObjectAlarm(workspace)).toBe(true);

    expect(await bobSocket.next("call-moved")).toMatchObject({ participant: b.participantId, reason: "expired" });
    expect(fake.requests.find((request) => request.path.endsWith(`/sessions/${b.sessionId}/tracks/close`))?.body).toEqual({
      tracks: [{ mid: "7" }],
      force: true,
    });
    const state = await alice.get<CallResponse>(apiPath("getCall", { channelId: "general" }));
    expect(state.call!.participants.map((participant) => participant.id)).toEqual([a.participantId]);
    // The alarm is re-armed for the remaining participant.
    expect(await runInDurableObject(workspace, (_instance, s) => s.storage.getAlarm())).not.toBeNull();

    await sql(workspace, `UPDATE call_participants SET last_seen_at = ? WHERE id = ?`, stale, a.participantId);
    await runInDurableObject(workspace, (instance: ChatWorkspace) => instance.runCallExpiry());
    for (;;) {
      const event = await aliceSocket.next("call");
      if (event.call === null) break;
    }
    const ended = await sql<{ ended_at: number | null }>(workspace, `SELECT ended_at FROM calls WHERE id = ?`, a.call.id);
    expect(ended[0]!.ended_at).not.toBeNull();
  });

  it("expires lazily on the next call read", async () => {
    const { workspace, alice, bob } = await setup("lazy");
    const a = await join(alice, "general");
    const b = await join(bob, "general");
    await sql(workspace, `UPDATE call_participants SET last_seen_at = ? WHERE id = ?`, Date.now() - CALL_PARTICIPANT_TTL_MS - 1, b.participantId);
    const state = await alice.get<CallResponse>(apiPath("getCall", { channelId: "general" }));
    expect(state.call!.participants.map((participant) => participant.id)).toEqual([a.participantId]);
  });
});

// ---------------------------------------------------------------------------
// call-beat
// ---------------------------------------------------------------------------

describe("call-beat", () => {
  it("records the heartbeat, broadcasts only when a flag changes, and answers a foreign beat with an error", async () => {
    const { workspace, alice, bob } = await setup("beat");
    const a = await join(alice, "general");
    await publishAndAnnounce(alice, a, [
      { mid: "0", kind: "audio", simulcast: false },
      { mid: "1", kind: "video", simulcast: true },
    ]);
    const watcher = await bob.socket();
    await watcher.next("hello");
    const socket = await alice.socket();
    await sql(workspace, `UPDATE call_participants SET last_seen_at = 1 WHERE id = ?`, a.participantId);

    // Same flags as stored: a heartbeat, no broadcast.
    socket.send({ t: "call-beat", call: a.call.id, participant: a.participantId, audio: true, video: true, screen: false });
    await tick(50);
    expect(watcher.all("call")).toHaveLength(0);
    const seen = await sql<{ last_seen_at: number }>(workspace, `SELECT last_seen_at FROM call_participants WHERE id = ?`, a.participantId);
    expect(seen[0]!.last_seen_at).toBeGreaterThan(1);

    // Muting is a change.
    socket.send({ t: "call-beat", call: a.call.id, participant: a.participantId, audio: false, video: true, screen: false });
    const muted = await watcher.next("call");
    expect(muted.call!.participants[0]).toMatchObject({ audio: false, video: true });

    // Screen without an announced screen track stays off, so nothing changed.
    socket.send({ t: "call-beat", call: a.call.id, participant: a.participantId, audio: false, video: true, screen: true });
    await tick(50);
    expect(watcher.all("call")).toHaveLength(1);

    // Somebody else's participant: an error event, and the socket stays open.
    const bobSocket = await bob.socket();
    bobSocket.send({ t: "call-beat", call: a.call.id, participant: a.participantId, audio: true, video: true, screen: true });
    expect(await bobSocket.next("error")).toMatchObject({ code: "forbidden" });
    bobSocket.send({ t: "call-beat", call: a.call.id, participant: "p_unknown", audio: true, video: true, screen: true });
    expect(await bobSocket.next("error")).toMatchObject({ code: "forbidden" });
    bobSocket.send({ t: "ping" });
    await tick(20);
    expect(bobSocket.ws.readyState).toBe(WebSocket.OPEN);
    // A malformed beat is invalid_request.
    bobSocket.send({ t: "call-beat", call: a.call.id, participant: a.participantId, audio: "yes" });
    expect(await bobSocket.next("error")).toMatchObject({ code: "invalid_request" });
  });
});

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

describe("rate limits", () => {
  it(`allows ${RATE_LIMITS.callJoinsPerMinute} joins and reconnects a minute`, async () => {
    const { alice } = await setup("limits");
    let last: JoinCallResponse | null = null;
    for (let i = 0; i < RATE_LIMITS.callJoinsPerMinute - 1; i++) last = await join(alice, "general");
    await alice.send<JoinCallResponse>("POST", apiPath("reconnectCall", { callId: last!.call.id }), {
      participantId: last!.participantId,
    });
    const response = await alice.request("POST", apiPath("joinCall", { channelId: "general" }), {});
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    // Signalling has its own budget.
    await alice.send<OkResponse>("POST", apiPath("leaveCall", { callId: last!.call.id }), { participantId: last!.participantId });
  });
});
