import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CALL_HEARTBEAT_MS, type CallState, type ClientEvent, type PullTracksRequest } from "../../contract.js";
import { ApiError } from "../../api/types.js";
import { ENGINE_TIMINGS, createCallEngine } from "./engine.js";
import {
  CALL_ID,
  CHANNEL_ID,
  SELF,
  FakeEnvironment,
  FakeSignalling,
  FakeTrack,
  callState,
  installFakeMediaStream,
  networkError,
  participant,
  type FakeEnvOptions,
  type FakeMediaStream,
  type FakeTransceiver,
} from "./testing/fakes.js";
import type { CallEngine, JoinOptions } from "./types.js";

type Beat = Extract<ClientEvent, { t: "call-beat" }>;

function setup(options: FakeEnvOptions = {}) {
  const env = new FakeEnvironment(options);
  const sig = new FakeSignalling();
  const beats: Beat[] = [];
  const log = vi.fn();
  const engine = createCallEngine({ api: sig.api, env, send: (event) => beats.push(event), log });
  return { env, sig, beats, log, engine };
}

const JOIN: JoinOptions = {
  channelId: CHANNEL_ID,
  audio: true,
  video: true,
  noiseSuppression: false,
  backgroundBlur: false,
  devices: { audioInputId: null, videoInputId: null, audioOutputId: null },
};

async function join(engine: CallEngine, options: Partial<JoinOptions> = {}): Promise<void> {
  const pending = engine.join({ ...JOIN, ...options });
  await vi.advanceTimersByTimeAsync(50);
  await pending;
}

/** Lets queued negotiation (microtasks and short timers) settle. */
async function settle(ms = 20): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function streamTrack(stream: MediaStream | null | undefined): FakeTrack {
  const track = (stream as unknown as FakeMediaStream | null)?.getTracks()[0];
  if (!track) throw new Error("no track in stream");
  return track;
}

function receiverOf(env: FakeEnvironment, track: FakeTrack): FakeTransceiver {
  const transceiver = env.pc.transceivers.find((candidate) => candidate.receiver.track === track);
  if (!transceiver) throw new Error("no transceiver for track");
  return transceiver;
}

beforeEach(() => {
  vi.useFakeTimers();
  installFakeMediaStream();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("join and initial publish", () => {
  it("publishes audio and a/b/c simulcast camera in one offer, then announces", async () => {
    const { env, sig, engine } = setup();
    await join(engine);

    expect(env.pcs).toHaveLength(1);
    expect(env.pc.config.bundlePolicy).toBe("max-bundle");
    expect(env.pc.config.iceServers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      { urls: ["turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" },
    ]);
    expect(env.pc.offersCreated).toHaveLength(1);
    expect(sig.methods()).toEqual(["joinCall", "publishTracks", "announceTracks"]);

    const publish = sig.calls("publishTracks")[0] as { tracks: { kind: string; simulcast: boolean; mid: string }[] };
    expect(publish.tracks).toEqual([
      { mid: "0", kind: "audio", simulcast: false },
      { mid: "1", kind: "video", simulcast: true },
    ]);
    const [audio, video] = env.pc.transceivers;
    expect(audio!.init?.direction).toBe("sendonly");
    expect(audio!.init?.sendEncodings?.[0]).toMatchObject({ networkPriority: "high", priority: "high" });
    expect(video!.init?.sendEncodings).toEqual([
      { rid: "a", scaleResolutionDownBy: 1, maxBitrate: 1_200_000, maxFramerate: 30 },
      { rid: "b", scaleResolutionDownBy: 2, maxBitrate: 450_000, maxFramerate: 24 },
      { rid: "c", scaleResolutionDownBy: 4, maxBitrate: 150_000, maxFramerate: 15 },
    ]);
    expect(env.pc.descriptions.map((d) => `${d.side}:${d.type}`)).toEqual(["local:offer", "remote:answer"]);
    expect(sig.calls("announceTracks")[0]).toEqual({ participantId: SELF, names: [`${SELF}-audio`, `${SELF}-video`] });

    const snap = engine.snapshot();
    expect(snap.phase).toBe("connected");
    expect(snap.callId).toBe(CALL_ID);
    expect(snap.participantId).toBe(SELF);
    expect(snap.audioEnabled).toBe(true);
    expect(snap.videoEnabled).toBe(true);
    expect(streamTrack(snap.localVideo).label).toBe("camera");
    expect(snap.error).toBeNull();
  });

  it("announces only after outbound-rtp bytesSent > 0", async () => {
    const { env, sig, engine } = setup({ peer: { bytesSentWhenConnected: 0 } });
    const pending = engine.join(JOIN);
    await settle(500);
    expect(sig.calls("announceTracks")).toHaveLength(0);
    expect(engine.snapshot().phase).toBe("joining");

    for (const sender of env.pc.senders()) sender.bytesSent = 42;
    await settle(ENGINE_TIMINGS.bytesSentPollMs + 10);
    await pending;
    expect(sig.calls("announceTracks")).toHaveLength(1);
    expect(engine.snapshot().phase).toBe("connected");
  });

  it("falls back to one camera encoding when the browser rejects simulcast", async () => {
    const { env, sig, engine } = setup({ peer: { rejectSimulcast: true } });
    await join(engine);
    const publish = sig.calls("publishTracks")[0] as { tracks: { kind: string; simulcast: boolean }[] };
    expect(publish.tracks[1]).toMatchObject({ kind: "video", simulcast: false });
    expect(env.pc.transceivers[1]!.init?.sendEncodings).toEqual([{ maxBitrate: 1_200_000, maxFramerate: 30 }]);
  });

  it("joins audio-only with a warning when there is no camera", async () => {
    const { sig, engine } = setup({ noCamera: true });
    await join(engine);
    const publish = sig.calls("publishTracks")[0] as { tracks: { kind: string }[] };
    expect(publish.tracks.map((t) => t.kind)).toEqual(["audio"]);
    expect(engine.snapshot()).toMatchObject({ phase: "connected", videoEnabled: false, localVideo: null });
    expect(engine.snapshot().error).toMatch(/camera/i);
  });

  it("joins listen-only when there is no microphone or camera", async () => {
    const { sig, engine } = setup({ noCamera: true, noMicrophone: true });
    await join(engine, { video: false });
    expect(sig.calls("publishTracks")).toHaveLength(0);
    expect(engine.snapshot()).toMatchObject({ phase: "connected", audioEnabled: false, videoEnabled: false });
    expect(engine.snapshot().error).toMatch(/microphone/i);
  });

  it("keeps the mic published but disabled when joining muted", async () => {
    const { env, engine, beats } = setup();
    await join(engine, { audio: false, video: false });
    const mic = env.tracks.find((t) => t.label === "mic")!;
    expect(mic.enabled).toBe(false);
    expect(env.pc.transceivers).toHaveLength(1);
    expect(beats.at(-1)).toMatchObject({ audio: false, video: false, screen: false });
  });

  it("fails with a readable reason when the call is full, releasing media", async () => {
    const { env, sig, engine } = setup();
    sig.override("joinCall", async () => {
      throw new ApiError("conflict", "full", 409);
    });
    await expect(engine.join(JOIN)).rejects.toThrow();
    expect(engine.snapshot()).toMatchObject({ phase: "failed", error: "The call is full." });
    expect(env.tracks.every((t) => t.stopped)).toBe(true);
  });
});

async function joinWith(remotes: CallState, options: FakeEnvOptions = {}) {
  const context = setup(options);
  context.sig.state = remotes;
  await join(context.engine);
  await settle();
  return context;
}

describe("pulling remote tracks", () => {
  it("pulls every new track in one batch, then renegotiates, and exposes streams per participant", async () => {
    const { env, sig, engine } = setup();
    await join(engine);
    const before = sig.log.length;
    engine.applyCallState(callState([participant("p2", ["audio", "video"]), participant("p3", ["audio"])]));
    await settle();

    expect(sig.methods().slice(before)).toEqual(["pullTracks", "renegotiateCall"]);
    const pull = sig.calls("pullTracks")[0] as PullTracksRequest;
    expect(pull.tracks).toEqual([
      { participantId: "p2", name: "p2-audio" },
      { participantId: "p2", name: "p2-video", rid: "b" },
      { participantId: "p3", name: "p3-audio" },
    ]);
    const tail = env.pc.descriptions.slice(-2).map((d) => `${d.side}:${d.type}`);
    expect(tail).toEqual(["remote:offer", "local:answer"]);
    expect(sig.calls("renegotiateCall")[0]).toEqual({ participantId: SELF, answer: { type: "answer", sdp: "client-answer" } });

    const { remotes } = engine.snapshot();
    expect(Object.keys(remotes).sort()).toEqual(["p2", "p3"]);
    expect(remotes.p2).toMatchObject({ userId: "u-p2", videoRid: "b", screen: null });
    expect(streamTrack(remotes.p2!.audio).kind).toBe("audio");
    expect(streamTrack(remotes.p2!.video).kind).toBe("video");
    expect(remotes.p3!.video).toBeNull();
  });

  it("pulls the tracks the announce response already lists", async () => {
    const { sig, engine } = await joinWith(callState([participant("p2", ["audio"])]));
    expect(sig.calls("pullTracks")).toHaveLength(1);
    expect(streamTrack(engine.snapshot().remotes.p2!.audio).kind).toBe("audio");
  });

  it("serialises negotiation and coalesces state changes that arrive meanwhile", async () => {
    const { sig, engine } = setup();
    await join(engine);
    const gate = sig.gate("pullTracks");
    engine.applyCallState(callState([participant("p2", ["audio"])]));
    await settle();
    engine.applyCallState(callState([participant("p2", ["audio"]), participant("p3", ["audio"])]));
    engine.applyCallState(callState([participant("p2", ["audio"]), participant("p3", ["audio"]), participant("p4", ["audio"])]));
    await settle();
    expect(sig.calls("pullTracks")).toHaveLength(1);
    expect(sig.calls("renegotiateCall")).toHaveLength(0);

    gate.resolve();
    await settle();
    const tail = sig.methods().filter((m) => m === "pullTracks" || m === "renegotiateCall");
    expect(tail).toEqual(["pullTracks", "renegotiateCall", "pullTracks", "renegotiateCall"]);
    const second = sig.calls("pullTracks")[1] as PullTracksRequest;
    expect(second.tracks.map((t) => t.name)).toEqual(["p3-audio", "p4-audio"]);

    engine.applyCallState(callState([participant("p2", ["audio"]), participant("p3", ["audio"]), participant("p4", ["audio"])]));
    await settle();
    expect(sig.calls("pullTracks")).toHaveLength(2);
  });

  it("claims a track whose `track` event fired before the pull response", async () => {
    const { env, sig, engine } = setup();
    await join(engine);
    sig.override("pullTracks", async (_callId, request) => {
      const transceiver = env.pc.addTransceiver("video", { direction: "recvonly" });
      transceiver.mid = "200";
      env.pc.fireTrack(transceiver);
      return { requiresImmediateRenegotiation: false, tracks: [{ participantId: "p2", name: request.tracks[0]!.name, mid: "200" }] };
    });
    engine.applyCallState(callState([participant("p2", ["video"])]));
    await settle();
    expect(sig.calls("renegotiateCall")).toHaveLength(0);
    expect(engine.snapshot().remotes.p2!.video).not.toBeNull();
  });

  it("claims a track whose `track` event fires after the exchange", async () => {
    const { env, engine } = setup({ peer: { fireOntrack: false } });
    await join(engine);
    engine.applyCallState(callState([participant("p2", ["video"])]));
    await settle();
    expect(engine.snapshot().remotes.p2!.video).toBeNull();
    await settle(1_000);
    env.pc.fireTrack(env.pc.transceivers.find((t) => t.mid === "100")!);
    await settle();
    expect(engine.snapshot().remotes.p2!.video).not.toBeNull();
  });

  it("drops a pull with no media after 5 s, releases its mid, and retries on the next state", async () => {
    const { env, sig, engine } = setup({ peer: { fireOntrack: false } });
    await join(engine);
    const state = callState([participant("p2", ["audio"])]);
    engine.applyCallState(state);
    await settle(ENGINE_TIMINGS.pullTrackTimeoutMs + 100);
    const close = sig.calls("closeTracks")[0] as { mids: string[]; offer?: unknown };
    expect(close.mids).toEqual(["100"]);
    expect(close.offer).toBeDefined();
    expect(env.pc.transceivers.find((t) => t.mid === "100")!.stopped).toBe(true);

    engine.applyCallState(state);
    await settle();
    expect(sig.calls("pullTracks")).toHaveLength(2);
  });

  it("skips items the SFU refused and keeps the rest", async () => {
    const { sig, engine } = setup();
    await join(engine);
    sig.override("pullTracks", async (_callId, request) => {
      const response = sig.pullResponse(request);
      return { ...response, tracks: [{ ...response.tracks[0]!, mid: null, error: "not_found_track_error" }, response.tracks[1]!] };
    });
    engine.applyCallState(callState([participant("p2", ["audio"]), participant("p3", ["audio"])]));
    await settle();
    expect(engine.snapshot().remotes.p2!.audio).toBeNull();
    expect(engine.snapshot().remotes.p3!.audio).not.toBeNull();
  });

  it("closes a departed participant's tracks with a negotiated close", async () => {
    const { env, sig, engine } = setup();
    await join(engine);
    engine.applyCallState(callState([participant("p2", ["audio", "video"]), participant("p3", ["audio"])]));
    await settle();
    const p2Tracks = [streamTrack(engine.snapshot().remotes.p2!.audio), streamTrack(engine.snapshot().remotes.p2!.video)];
    const mids = p2Tracks.map((track) => receiverOf(env, track).mid);

    engine.applyCallState(callState([participant("p3", ["audio"])]));
    await settle();
    const close = sig.calls("closeTracks")[0] as { mids: string[]; offer?: { type: string } };
    expect(close.mids.sort()).toEqual([...mids].sort());
    expect(close.offer?.type).toBe("offer");
    for (const track of p2Tracks) expect(receiverOf(env, track).stopped).toBe(true);
    expect(env.pc.descriptions.at(-1)).toMatchObject({ side: "remote", type: "answer", sdp: "sfu-close-answer" });
    expect(Object.keys(engine.snapshot().remotes)).toEqual(["p3"]);
  });

  it("skips the negotiated close when the connection is not up", async () => {
    const { env, sig, engine } = setup();
    await join(engine);
    engine.applyCallState(callState([participant("p2", ["audio"])]));
    await settle();
    env.pc.connectionState = "connecting";
    engine.applyCallState(callState([]));
    await settle();
    expect(sig.calls("closeTracks")).toHaveLength(0);
    expect(engine.snapshot().remotes).toEqual({});
  });

  it("re-pulls a participant who came back on a new session", async () => {
    const { sig, engine } = setup();
    await join(engine);
    engine.applyCallState(callState([participant("p2", ["audio"], "s-old")]));
    await settle();
    engine.applyCallState(callState([participant("p2", ["audio"], "s-new")]));
    await settle();
    expect(sig.calls("closeTracks")).toHaveLength(1);
    expect(sig.calls("pullTracks")).toHaveLength(2);
    expect(engine.snapshot().remotes.p2!.audio).not.toBeNull();
  });

  it("ignores state for another call", async () => {
    const { sig, engine } = setup();
    await join(engine);
    engine.applyCallState({ ...callState([participant("p2", ["audio"])]), id: "other" });
    await settle();
    expect(sig.calls("pullTracks")).toHaveLength(0);
  });
});

describe("simulcast layers", () => {
  it("maps tile sizes to rids and debounces switches to one per second per track", async () => {
    const { sig, engine } = await joinWith(callState([participant("p2", ["video"]), participant("p3", ["screen"])]));
    expect(engine.snapshot().remotes.p2!.videoRid).toBe("b");

    engine.setTileSizes({ p2: "large", p3: "large" });
    await settle(500);
    engine.setTileSizes({ p2: "small", p3: "large" });
    await settle(900);
    expect(sig.calls("setLayer")).toHaveLength(0);
    await settle(200);
    expect(sig.calls("setLayer")).toEqual([
      { participantId: SELF, mid: expect.any(String), trackParticipantId: "p2", name: "p2-video", rid: "c" },
    ]);
    expect(engine.snapshot().remotes.p2!.videoRid).toBe("c");

    engine.setTileSizes({ p2: "hidden", p3: "small" });
    await settle(2_000);
    expect(sig.calls("setLayer")).toHaveLength(1);

    engine.setTileSizes({ p2: "large" });
    await settle(1_100);
    expect((sig.calls("setLayer")[1] as { rid: string }).rid).toBe("a");
  });

  it("does not switch when the size flips back before the debounce ends", async () => {
    const { sig, engine } = await joinWith(callState([participant("p2", ["video"])]));
    engine.setTileSizes({ p2: "large" });
    await settle(400);
    engine.setTileSizes({ p2: "medium" });
    await settle(2_000);
    expect(sig.calls("setLayer")).toHaveLength(0);
  });

  it("pulls with the rid for the current tile size", async () => {
    const { sig, engine } = setup();
    await join(engine);
    engine.setTileSizes({ p2: "large" });
    engine.applyCallState(callState([participant("p2", ["video"])]));
    await settle();
    expect((sig.calls("pullTracks")[0] as PullTracksRequest).tracks[0]!.rid).toBe("a");
  });
});

describe("mute, camera and devices", () => {
  it("mutes by disabling the track, never stopping the sender", async () => {
    const { env, engine, beats } = setup();
    await join(engine);
    const mic = env.tracks.find((t) => t.label === "mic")!;
    const audio = env.pc.transceivers[0]!;
    const beatsBefore = beats.length;
    engine.setAudioEnabled(false);
    expect(mic.enabled).toBe(false);
    expect(mic.stopped).toBe(false);
    expect(audio.stopped).toBe(false);
    expect(audio.sender.replaced).toEqual([]);
    expect(engine.snapshot().audioEnabled).toBe(false);
    expect(beats.length).toBe(beatsBefore + 1);
    expect(beats.at(-1)).toMatchObject({ audio: false, video: true });
  });

  it("turns the camera off with replaceTrack(black) and back on with a fresh camera, without renegotiating", async () => {
    const { env, sig, engine, beats } = setup();
    await join(engine);
    const camera = env.tracks.find((t) => t.label === "camera")!;
    const video = env.pc.transceivers[1]!;
    const offers = env.pc.offersCreated.length;

    await engine.setVideoEnabled(false);
    expect(video.sender.replaced).toEqual([env.blackTracks[0]]);
    expect(camera.stopped).toBe(true);
    expect(video.stopped).toBe(false);
    expect(engine.snapshot()).toMatchObject({ videoEnabled: false, localVideo: null });
    expect(beats.at(-1)).toMatchObject({ video: false });

    await engine.setVideoEnabled(true);
    const fresh = env.tracks.filter((t) => t.label === "camera").at(-1)!;
    expect(fresh).not.toBe(camera);
    expect(video.sender.replaced.at(-1)).toBe(fresh);
    expect(streamTrack(engine.snapshot().localVideo)).toBe(fresh);
    expect(env.pc.offersCreated.length).toBe(offers);
    expect(sig.calls("publishTracks")).toHaveLength(1);
    expect(beats.at(-1)).toMatchObject({ video: true });
  });

  it("publishes the camera late when the call was joined with it off", async () => {
    const { env, sig, engine } = setup();
    await join(engine, { video: false });
    expect(env.pc.transceivers).toHaveLength(1);
    await engine.setVideoEnabled(true);
    await settle();
    const second = sig.calls("publishTracks")[1] as { tracks: { kind: string; simulcast: boolean }[] };
    expect(second.tracks).toEqual([expect.objectContaining({ kind: "video", simulcast: true })]);
    expect((sig.calls("announceTracks")[1] as { names: string[] }).names).toEqual([`${SELF}-video`]);
    expect(env.pc.transceivers[1]!.init?.sendEncodings).toHaveLength(3);
  });

  it("reports a camera error without throwing", async () => {
    const { env, engine } = setup();
    await join(engine, { video: false });
    env.options.noCamera = true;
    await engine.setVideoEnabled(true);
    expect(engine.snapshot().videoEnabled).toBe(false);
    expect(engine.snapshot().error).toMatch(/camera/i);
  });

  it("switches inputs with replaceTrack and exposes the output choice", async () => {
    const { env, engine } = setup();
    await join(engine);
    const oldMic = env.tracks.find((t) => t.label === "mic")!;
    const offers = env.pc.offersCreated.length;
    await engine.setDevices({ audioInputId: "mic-2", audioOutputId: "spk-1" });
    const newMic = env.tracks.filter((t) => t.label === "mic").at(-1)!;
    expect(newMic).not.toBe(oldMic);
    expect(oldMic.stopped).toBe(true);
    expect(env.pc.transceivers[0]!.sender.replaced).toEqual([newMic]);
    expect(env.gumCalls.at(-1)).toMatchObject({ audio: { deviceId: { exact: "mic-2" } } });
    expect(env.pc.offersCreated.length).toBe(offers);
    expect(engine.snapshot().audioOutputId).toBe("spk-1");
  });

  it("lists devices by kind", async () => {
    const { engine } = setup();
    const devices = await engine.listDevices();
    expect(devices.audioInputs.map((d) => d.deviceId)).toEqual(["mic-1"]);
    expect(devices.videoInputs.map((d) => d.deviceId)).toEqual(["cam-1"]);
    expect(devices.audioOutputs.map((d) => d.deviceId)).toEqual(["spk-1"]);
  });
});

describe("screen share", () => {
  it("publishes one detail-hinted layer as kind screen and closes it when stopped", async () => {
    const { env, sig, engine, beats } = setup();
    await join(engine);
    await expect(engine.setScreenEnabled(true)).resolves.toBe(true);
    await settle();
    const screen = env.tracks.find((t) => t.label === "screen")!;
    expect(screen.contentHint).toBe("detail");
    const publish = sig.calls("publishTracks")[1] as { tracks: { kind: string; simulcast: boolean; mid: string }[] };
    expect(publish.tracks).toEqual([{ mid: "2", kind: "screen", simulcast: false }]);
    const transceiver = env.pc.transceivers[2]!;
    expect(transceiver.init?.sendEncodings).toEqual([{ maxBitrate: 2_000_000, maxFramerate: 15 }]);
    expect((sig.calls("announceTracks")[1] as { names: string[] }).names).toEqual([`${SELF}-screen`]);
    expect(engine.snapshot().screenEnabled).toBe(true);
    expect(streamTrack(engine.snapshot().localScreen)).toBe(screen);
    expect(beats.at(-1)).toMatchObject({ screen: true });

    await expect(engine.setScreenEnabled(false)).resolves.toBe(true);
    expect(sig.calls("closeTracks")).toEqual([expect.objectContaining({ mids: ["2"], offer: expect.any(Object) })]);
    expect(transceiver.stopped).toBe(true);
    expect(screen.stopped).toBe(true);
    expect(engine.snapshot()).toMatchObject({ screenEnabled: false, localScreen: null });
    expect(beats.at(-1)).toMatchObject({ screen: false });
  });

  it("stops sharing when the browser ends the track", async () => {
    const { env, sig, engine } = setup();
    await join(engine);
    await engine.setScreenEnabled(true);
    await settle();
    env.tracks.find((t) => t.label === "screen")!.end();
    await settle();
    expect(sig.calls("closeTracks")).toHaveLength(1);
    expect(engine.snapshot().screenEnabled).toBe(false);
  });

  it("resolves false when the user cancels the picker", async () => {
    const { sig, engine } = setup({ displayError: "NotAllowedError" });
    await join(engine);
    await expect(engine.setScreenEnabled(true)).resolves.toBe(false);
    expect(sig.calls("publishTracks")).toHaveLength(1);
    expect(engine.snapshot()).toMatchObject({ screenEnabled: false, error: null });
  });
});

describe("active speaker", () => {
  it("switches only after a speaker dominates for a second, and clears in silence", async () => {
    const { env, engine } = await joinWith(callState([participant("p2", ["audio"]), participant("p3", ["audio"])]));
    const p2 = receiverOf(env, streamTrack(engine.snapshot().remotes.p2!.audio)).receiver;
    const p3 = receiverOf(env, streamTrack(engine.snapshot().remotes.p3!.audio)).receiver;
    const mic = env.pc.transceivers[0]!.sender;

    p2.audioLevel = 0.8;
    await settle(600);
    expect(engine.snapshot().activeSpeaker).toBeNull();
    await settle(1_000);
    expect(engine.snapshot().activeSpeaker).toBe("p2");

    p2.audioLevel = 0.3;
    p3.audioLevel = 0.9;
    await settle(600);
    expect(engine.snapshot().activeSpeaker).toBe("p2");
    await settle(1_000);
    expect(engine.snapshot().activeSpeaker).toBe("p3");

    p2.audioLevel = 0;
    p3.audioLevel = 0;
    mic.audioLevel = 0;
    await settle(2_500);
    expect(engine.snapshot().activeSpeaker).toBeNull();
    // Remote levels come from synchronization sources and quality from one pc.getStats(): no
    // receiver is asked for a report of its own.
    expect(p2.getStatsCalls + p3.getStatsCalls).toBe(0);
  });

  // Found on the real SFU: it negotiates no ssrc-audio-level extension, so synchronization sources
  // carry no level and nobody was ever highlighted.
  it("falls back to inbound-rtp audioLevel from one connection report when SSRC levels are missing", async () => {
    const { env, engine } = await joinWith(callState([participant("p2", ["audio"]), participant("p3", ["audio"])]));
    const p2 = receiverOf(env, streamTrack(engine.snapshot().remotes.p2!.audio)).receiver;
    const p3 = receiverOf(env, streamTrack(engine.snapshot().remotes.p3!.audio)).receiver;
    p2.ssrcLevels = false;
    p3.ssrcLevels = false;
    p3.audioLevel = 0.7;
    await settle(1_800);
    expect(engine.snapshot().activeSpeaker).toBe("p3");
    expect(p2.getStatsCalls + p3.getStatsCalls).toBe(0);
  });

  it("makes the local speaker active from media-source stats, and never publishes raw levels", async () => {
    const { env, engine } = await joinWith(callState([]));
    const mic = env.pc.transceivers[0]!.sender;
    mic.audioLevel = 0.6;
    await settle(3_000);
    expect(engine.snapshot().activeSpeaker).toBe(engine.snapshot().participantId);
    const listener = vi.fn();
    engine.subscribe(listener);
    mic.audioLevel = 0.3;
    await settle(1_000);
    expect(listener).toHaveBeenCalledTimes(0);
  });

  it("never makes a muted local participant the active speaker", async () => {
    const { env, engine } = await joinWith(callState([]));
    engine.setAudioEnabled(false);
    env.pc.transceivers[0]!.sender.audioLevel = 0.9;
    await settle(2_000);
    expect(engine.snapshot().activeSpeaker).toBeNull();
  });
});

describe("recovery", () => {
  it("rebuilds on connection failure: new session, republish, announce, re-pull", async () => {
    const { env, sig, engine } = await joinWith(callState([participant("p2", ["audio", "video"])]));
    const firstPc = env.pc;
    expect(sig.calls("pullTracks")).toHaveLength(1);

    firstPc.setConnectionState("failed");
    expect(engine.snapshot().phase).toBe("reconnecting");
    expect(firstPc.closed).toBe(true);
    await settle(100);

    expect(env.pcs).toHaveLength(2);
    expect(sig.calls("reconnectCall")).toEqual([{ participantId: SELF }]);
    expect(sig.calls("publishTracks")).toHaveLength(2);
    expect((sig.calls("publishTracks")[1] as { tracks: unknown[] }).tracks).toHaveLength(2);
    expect(sig.calls("announceTracks")).toHaveLength(2);
    expect(sig.calls("pullTracks")).toHaveLength(2);
    expect(engine.snapshot().phase).toBe("connected");
    expect(streamTrack(engine.snapshot().remotes.p2!.video).kind).toBe("video");
    // Local media survives the rebuild.
    expect(env.tracks.filter((t) => t.label === "mic" || t.label === "camera").every((t) => !t.stopped)).toBe(true);
  });

  it("tries restartIce once on disconnected, then rebuilds after 7 s", async () => {
    const { env, sig } = await joinWith(callState([]));
    env.pc.setConnectionState("disconnected");
    expect(env.pc.restartIceCalls).toBe(1);
    await settle(ENGINE_TIMINGS.disconnectedGraceMs - 100);
    expect(sig.calls("reconnectCall")).toHaveLength(0);
    await settle(200);
    expect(sig.calls("reconnectCall")).toHaveLength(1);
  });

  it("does not rebuild when a disconnection recovers in time", async () => {
    const { env, sig, engine } = await joinWith(callState([]));
    env.pc.setConnectionState("disconnected");
    await settle(3_000);
    env.pc.setConnectionState("connected");
    await settle(10_000);
    expect(sig.calls("reconnectCall")).toHaveLength(0);
    expect(engine.snapshot().phase).toBe("connected");
  });

  it("rebuilds when a renegotiate outcome is lost to the network", async () => {
    const { sig, engine } = setup();
    await join(engine);
    sig.override("renegotiateCall", async () => {
      sig.clearOverride("renegotiateCall");
      throw networkError();
    });
    sig.state = callState([participant("p2", ["audio"])]);
    engine.applyCallState(sig.state);
    await settle(100);
    expect(sig.calls("reconnectCall")).toHaveLength(1);
    expect(engine.snapshot().phase).toBe("connected");
    expect(sig.calls("pullTracks")).toHaveLength(2);
    expect(sig.calls("renegotiateCall")).toHaveLength(2);
    expect(engine.snapshot().remotes.p2!.audio).not.toBeNull();
  });

  it("keeps backing off when rebuilt connections keep failing, then fails", async () => {
    const { sig, engine } = setup();
    await join(engine);
    sig.override("renegotiateCall", async () => {
      throw networkError();
    });
    sig.state = callState([participant("p2", ["audio"])]);
    engine.applyCallState(sig.state);
    await settle(100);
    expect(sig.calls("reconnectCall")).toHaveLength(1);
    await settle(700);
    expect(sig.calls("reconnectCall")).toHaveLength(1);
    await settle(500);
    expect(sig.calls("reconnectCall")).toHaveLength(2);
    await settle(40_000);
    expect(engine.snapshot().phase).toBe("failed");
    expect(sig.calls("reconnectCall").length).toBeLessThanOrEqual(8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off exponentially and gives up after ~30 s", async () => {
    const { env, sig, engine } = await joinWith(callState([]));
    sig.override("reconnectCall", async () => {
      throw networkError();
    });
    env.pc.setConnectionState("failed");
    await settle(10);
    expect(sig.calls("reconnectCall")).toHaveLength(1);
    await settle(1_000);
    expect(sig.calls("reconnectCall")).toHaveLength(2);
    await settle(2_000);
    expect(sig.calls("reconnectCall")).toHaveLength(3);
    await settle(4_000);
    expect(sig.calls("reconnectCall")).toHaveLength(4);
    expect(engine.snapshot().phase).toBe("reconnecting");
    await settle(30_000);
    expect(engine.snapshot().phase).toBe("failed");
    expect(engine.snapshot().error).toMatch(/connection/i);
    const attempts = sig.calls("reconnectCall").length;
    expect(attempts).toBeGreaterThanOrEqual(6);
    expect(attempts).toBeLessThanOrEqual(7);
    expect(env.tracks.every((t) => t.stopped)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up at once when the call is gone", async () => {
    const { env, sig, engine } = await joinWith(callState([]));
    sig.override("reconnectCall", async () => {
      throw new ApiError("not_found", "gone", 404);
    });
    env.pc.setConnectionState("failed");
    await settle(10);
    expect(engine.snapshot().phase).toBe("failed");
    expect(sig.calls("reconnectCall")).toHaveLength(1);
  });
});

describe("moved, leave and dispose", () => {
  it("tears down on call-moved for our own participant without calling leave", async () => {
    const { env, sig, engine } = await joinWith(callState([participant("p2", ["audio"])]));
    engine.handleMoved(CALL_ID, "someone-else");
    expect(engine.snapshot().phase).toBe("connected");
    engine.handleMoved(CALL_ID, SELF);
    expect(engine.snapshot()).toMatchObject({ phase: "moved", remotes: {}, localVideo: null });
    expect(sig.calls("leaveCall")).toHaveLength(0);
    expect(env.pc.closed).toBe(true);
    expect(env.tracks.filter((t) => t.label !== "receiver" && !t.label.startsWith("remote")).every((t) => t.stopped)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leave calls the server, stops every track and clears every timer", async () => {
    const { env, sig, engine } = await joinWith(callState([participant("p2", ["audio", "video"])]));
    await engine.setVideoEnabled(false);
    await engine.setScreenEnabled(true);
    await settle();
    await engine.leave();
    expect(sig.calls("leaveCall")).toEqual([{ participantId: SELF }]);
    expect(engine.snapshot().phase).toBe("idle");
    expect(env.pc.closed).toBe(true);
    const local = env.tracks.filter((t) => ["mic", "camera", "screen", "black"].includes(t.label));
    expect(local.length).toBeGreaterThanOrEqual(4);
    expect(local.every((t) => t.stopped)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose tears down without the server", async () => {
    const { env, sig, engine } = await joinWith(callState([]));
    engine.dispose();
    expect(sig.calls("leaveCall")).toHaveLength(0);
    expect(engine.snapshot().phase).toBe("idle");
    expect(env.pc.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leave during join cancels it and leaves the server-side participant", async () => {
    const { sig, engine } = setup();
    const gate = sig.gate("joinCall");
    const pending = engine.join(JOIN);
    await settle();
    await engine.leave();
    gate.resolve();
    await expect(pending).rejects.toThrow(/cancelled/);
    await settle();
    expect(sig.calls("leaveCall")).toEqual([{ participantId: SELF }]);
    expect(sig.calls("publishTracks")).toHaveLength(0);
    expect(engine.snapshot().phase).toBe("idle");
  });
});

describe("heartbeat and snapshots", () => {
  it("beats on join, every CALL_HEARTBEAT_MS, and immediately on a flag change", async () => {
    const { engine, beats } = setup();
    await join(engine);
    expect(beats).toHaveLength(1);
    expect(beats[0]).toEqual({ t: "call-beat", call: CALL_ID, participant: SELF, audio: true, video: true, screen: false });
    await settle(CALL_HEARTBEAT_MS);
    expect(beats).toHaveLength(2);
    await settle(CALL_HEARTBEAT_MS);
    expect(beats).toHaveLength(3);
    engine.setAudioEnabled(false);
    expect(beats).toHaveLength(4);
    engine.setAudioEnabled(false);
    expect(beats).toHaveLength(4);
  });

  it("keeps snapshot identity when nothing changed and supports unsubscribe", async () => {
    const { engine } = await joinWith(callState([]));
    const listener = vi.fn();
    const unsubscribe = engine.subscribe(listener);
    const before = engine.snapshot();
    engine.applyCallState(callState([]));
    await settle(1_000);
    expect(engine.snapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(Object.isFrozen(before)).toBe(true);
    unsubscribe();
    engine.setAudioEnabled(false);
    expect(listener).not.toHaveBeenCalled();
    expect(engine.snapshot()).not.toBe(before);
  });

  it("never logs SDP", async () => {
    const { engine, log } = await joinWith(callState([participant("p2", ["audio", "video"])]));
    await engine.leave();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toMatch(/client-offer|sfu-answer|client-answer|remote/);
    expect(logged).not.toMatch(/credential/);
  });
});
