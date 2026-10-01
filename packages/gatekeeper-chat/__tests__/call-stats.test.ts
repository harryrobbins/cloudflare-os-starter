// Call-quality telemetry: `POST /calls/:callId/stats` (src/do/call-stats.ts).
//
// The route stores nothing, so the assertion is the log line itself: console.log is spied on while
// the Durable Object handles the request (it runs in this isolate under vitest-pool-workers).
// Realtime is a minimal fake -- joining needs a session and TURN credentials, nothing else here does.
//
// Fake credentials are built at runtime so no secret-shaped literal sits in the repository.
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_CALL_STATS_PER_MINUTE,
  type CallStatsReport,
  type ChannelResponse,
  type JoinCallResponse,
  type MeResponse,
  type OkResponse,
} from "../src/shared/protocol.js";
import { apiPath } from "../src/shared/routes.js";
import type { RealtimeConfig } from "../src/do/sfu.js";
import { CALL_STATS_GRACE_MS } from "../src/do/call-stats.js";
import type { ChatWorkspace } from "../src/workspace.js";
import { client, freshWorkspace, identity, type Client, type Workspace } from "./helpers.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeRealtime(): RealtimeConfig {
  let sessions = 0;
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.includes("/turn/")) {
      return jsonResponse({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] }, 201);
    }
    if (url.pathname.endsWith("/sessions/new")) return jsonResponse({ sessionId: `sfu-${++sessions}` }, 201);
    return jsonResponse({ tracks: [] });
  };
  return {
    sfuAppId: "0a".repeat(16),
    sfuAppSecret: ["5e", "a1"].join("").repeat(16),
    turnKeyId: "7c".repeat(16),
    turnKeyApiToken: ["9d", "b2"].join("").repeat(16),
    fetch: fetchImpl as typeof fetch,
  };
}

async function setup(label: string) {
  const workspace = freshWorkspace(`call-stats-${label}`);
  await runInDurableObject(workspace, (instance: ChatWorkspace) => instance.useRealtime(fakeRealtime()));
  const alice = client(workspace, identity("alice", "Alice"));
  const bob = client(workspace, identity("bob", "Bob"));
  const carol = client(workspace, identity("carol", "Carol"));
  for (const who of [alice, bob, carol]) await who.get<MeResponse>(apiPath("me"));
  return { workspace, alice, bob, carol };
}

function join(who: Client, channelId: string): Promise<JoinCallResponse> {
  return who.send<JoinCallResponse>("POST", apiPath("joinCall", { channelId }), {});
}

function report(participantId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: CallStatsReport = {
    participantId,
    final: false,
    intervalMs: 60_000,
    durationMs: 125_000.4,
    rttMs: { avg: 42.6, max: 180 },
    lossPercent: { send: 0.25, receive: null },
    jitterMs: 3.14,
    framesDecoded: 3_600,
    framesDropped: 12,
    limitedMs: { cpu: 0, bandwidth: 1_500 },
    audioOnlyMs: 0,
    relayed: true,
    audioCodec: "opus",
    videoCodec: "VP8",
    reconnects: 1,
  };
  return { ...base, ...overrides };
}

function post(who: Client, callId: string, body: unknown) {
  return who.error("POST", apiPath("postCallStats", { callId }), body);
}

async function sql(workspace: Workspace, query: string, ...params: unknown[]): Promise<void> {
  await runInDurableObject(workspace, (_instance, state) => {
    state.storage.sql.exec(query, ...params);
  });
}

function statsLines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls
    .map((args) => String(args[0]))
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line["evt"] === "chat.call.stats");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("call stats", () => {
  it("answers 503 when calls are off", async () => {
    const workspace = freshWorkspace("call-stats-off");
    const alice = client(workspace, identity("alice", "Alice"));
    expect(await post(alice, "cl_x", report("p_x"))).toEqual({ status: 503, code: "unavailable" });
  });

  it("logs one redacted line with hashed ids and the numeric fields, and stores nothing", async () => {
    const { workspace, alice } = await setup("happy");
    const joined = await join(alice, "general");
    const spy = vi.spyOn(console, "log");
    const answer = await alice.send<OkResponse>("POST", apiPath("postCallStats", { callId: joined.call.id }), {
      ...report(joined.participantId),
      // Extras are ignored and never logged.
      sdp: "v=0 secret-sdp",
      candidate: "192.0.2.7",
    });
    expect(answer).toEqual({ ok: true });

    const lines = statsLines(spy);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toMatchObject({
      evt: "chat.call.stats",
      final: false,
      intervalMs: 60_000,
      durationMs: 125_000,
      rttAvgMs: 43,
      rttMaxMs: 180,
      lossSendPct: 0.3,
      jitterMs: 3.1,
      framesDecoded: 3_600,
      framesDropped: 12,
      limitedCpuMs: 0,
      limitedBandwidthMs: 1_500,
      audioOnlyMs: 0,
      relayed: true,
      audioCodec: "opus",
      videoCodec: "VP8",
      reconnects: 1,
    });
    expect(line).not.toHaveProperty("lossReceivePct");
    for (const key of ["call", "user", "participant"]) expect(line[key]).toMatch(/^[0-9a-f]{8}$/u);
    const raw = JSON.stringify(spy.mock.calls);
    for (const secret of [joined.call.id, joined.participantId, "alice", "secret-sdp", "192.0.2.7"]) {
      expect(raw).not.toContain(secret);
    }

    const stored = await runInDurableObject(workspace, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%stat%'`)
        .toArray(),
    );
    expect(stored).toEqual([]);
  });

  it("refuses another user's participant, a participant of another call, and an unknown one", async () => {
    const { alice, bob, carol } = await setup("foreign");
    const a = await join(alice, "general");
    await join(bob, "general");
    const created = await carol.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "public",
      name: "elsewhere",
    });
    const c = await join(carol, created.channel.id);

    const spy = vi.spyOn(console, "log");
    expect(await post(bob, a.call.id, report(a.participantId))).toEqual({ status: 403, code: "forbidden" });
    expect(await post(alice, c.call.id, report(a.participantId))).toEqual({ status: 403, code: "forbidden" });
    expect(await post(alice, a.call.id, report("p_unknown"))).toEqual({ status: 404, code: "not_found" });
    expect(statsLines(spy)).toEqual([]);
  });

  it("accepts the final report just after leave and refuses one long after", async () => {
    const { workspace, alice } = await setup("left");
    const joined = await join(alice, "general");
    const callId = joined.call.id;
    await alice.send<OkResponse>("POST", apiPath("leaveCall", { callId }), { participantId: joined.participantId });

    const spy = vi.spyOn(console, "log");
    await alice.send<OkResponse>("POST", apiPath("postCallStats", { callId }), report(joined.participantId, { final: true }));
    expect(statsLines(spy).map((line) => line["final"])).toEqual([true]);

    await sql(
      workspace,
      `UPDATE call_participants SET left_at = ? WHERE id = ?`,
      Date.now() - CALL_STATS_GRACE_MS - 1_000,
      joined.participantId,
    );
    expect(await post(alice, callId, report(joined.participantId, { final: true }))).toEqual({
      status: 404,
      code: "not_found",
    });
  });

  it(`allows ${MAX_CALL_STATS_PER_MINUTE} reports a minute per participant, apart from signalling`, async () => {
    const { alice } = await setup("limit");
    const joined = await join(alice, "general");
    const callId = joined.call.id;
    const path = apiPath("postCallStats", { callId });
    for (let i = 0; i < MAX_CALL_STATS_PER_MINUTE; i++) {
      await alice.send<OkResponse>("POST", path, report(joined.participantId));
    }
    const response = await alice.request("POST", path, report(joined.participantId));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).not.toBeNull();
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("rate_limited");

    // Signalling is unaffected, and a new participant has a budget of its own.
    await alice.send<OkResponse>("POST", apiPath("leaveCall", { callId }), { participantId: joined.participantId });
    const again = await join(alice, "general");
    await alice.send<OkResponse>("POST", apiPath("postCallStats", { callId: again.call.id }), report(again.participantId));
  });

  it("rejects malformed reports with 400", async () => {
    const { alice } = await setup("invalid");
    const joined = await join(alice, "general");
    const callId = joined.call.id;
    const id = joined.participantId;
    const missing = report(id);
    delete missing["jitterMs"];
    const cases: [string, unknown][] = [
      ["not an object", [1, 2]],
      ["missing participantId", { ...report(id), participantId: undefined }],
      ["missing jitterMs", missing],
      ["missing nested", { ...report(id), rttMs: undefined }],
      ["final not boolean", report(id, { final: "yes" })],
      ["NaN is not JSON, so a string", report(id, { intervalMs: "NaN" })],
      ["negative", report(id, { framesDropped: -1 })],
      ["fractional frames", report(id, { framesDecoded: 1.5 })],
      ["duration over a day", report(id, { durationMs: 24 * 60 * 60 * 1000 + 1 })],
      ["loss over 100", report(id, { lossPercent: { send: 101, receive: 0 } })],
      ["rtt over a minute", report(id, { rttMs: { avg: 60_001, max: null } })],
      ["huge number", report(id, { reconnects: 1e308 })],
      ["codec with a slash", report(id, { videoCodec: "video/VP8" })],
      ["codec too long", report(id, { audioCodec: "o".repeat(33) })],
      ["codec empty", report(id, { audioCodec: "" })],
      ["relayed a string", report(id, { relayed: "relay" })],
    ];
    for (const [label, body] of cases) {
      expect(await post(alice, callId, body), label).toEqual({ status: 400, code: "invalid_request" });
    }
  });
});
