// Quality phase 1 behaviour of the engine: capture constraints, resilient audio, sender preferences,
// CPU and downlink adaptation, pausing hidden video, and telemetry.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_CALL_STATS_PER_MINUTE, type CallState, type CallStatsReport, type PullTracksRequest } from "../../contract.js";
import { ApiError } from "../../api/types.js";
import { ENGINE_TIMINGS, createCallEngine } from "./engine.js";
import {
  CHANNEL_ID,
  SELF,
  FakeEnvironment,
  FakeSignalling,
  callState,
  installFakeMediaStream,
  participant,
  type FakeEnvOptions,
  type FakeMediaStream,
  type FakeReceiver,
  type FakeSender,
  type FakeTrack,
} from "./testing/fakes.js";
import type { CallEngine, JoinOptions } from "./types.js";

const TICK = ENGINE_TIMINGS.qualitySampleMs;

const JOIN: JoinOptions = {
  channelId: CHANNEL_ID,
  audio: true,
  video: true,
  devices: { audioInputId: null, videoInputId: null, audioOutputId: null },
};

function setup(options: FakeEnvOptions = {}) {
  const env = new FakeEnvironment(options);
  const sig = new FakeSignalling();
  const log = vi.fn();
  const engine = createCallEngine({ api: sig.api, env, send: () => undefined, log });
  return { env, sig, log, engine };
}

async function settle(ms = 20): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

async function join(engine: CallEngine, options: Partial<JoinOptions> = {}): Promise<void> {
  const pending = engine.join({ ...JOIN, ...options });
  await settle(50);
  await pending;
}

async function joinWith(state: CallState, options: FakeEnvOptions = {}, joinOptions: Partial<JoinOptions> = {}) {
  const context = setup(options);
  context.sig.state = state;
  await join(context.engine, joinOptions);
  await settle();
  return context;
}

function trackOf(stream: MediaStream | null | undefined): FakeTrack {
  const track = (stream as unknown as FakeMediaStream | null)?.getTracks()[0];
  if (!track) throw new Error("no track in stream");
  return track;
}

function receiver(env: FakeEnvironment, stream: MediaStream | null | undefined): FakeReceiver {
  const track = trackOf(stream);
  const transceiver = env.pc.transceivers.find((candidate) => candidate.receiver.track === track);
  if (!transceiver) throw new Error("no transceiver");
  return transceiver.receiver;
}

function midOf(env: FakeEnvironment, stream: MediaStream | null | undefined): string {
  const track = trackOf(stream);
  return env.pc.transceivers.find((candidate) => candidate.receiver.track === track)!.mid!;
}

function cameraSender(env: FakeEnvironment): FakeSender {
  return env.pc.transceivers[1]!.sender;
}

/** Runs `n` quality ticks, calling `each` before every one (to advance the fake counters). */
async function ticks(n: number, each: () => void = () => undefined): Promise<void> {
  for (let index = 0; index < n; index += 1) {
    each();
    await settle(TICK);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  installFakeMediaStream();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("capture constraints", () => {
  it("asks for the browser's audio processing explicitly and caps the camera at 720p30", async () => {
    const { env, engine } = setup();
    await join(engine);
    const constraints = env.gumCalls[0]!;
    expect(constraints.audio).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    expect(constraints.video).toEqual({
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 30, max: 30 },
    });
  });

  it("adds voiceIsolation when the browser supports it, also for a device switch", async () => {
    const { env, engine } = setup({ supported: { voiceIsolation: true } as MediaTrackSupportedConstraints });
    await join(engine);
    expect(env.gumCalls[0]!.audio).toMatchObject({ voiceIsolation: true });
    await engine.setDevices({ audioInputId: "mic-2" });
    expect(env.gumCalls.at(-1)!.audio).toEqual({
      deviceId: { exact: "mic-2" },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: true,
    });
  });
});

describe("resilient audio", () => {
  const OFFER = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n";
  const MUNGED = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1;usedtx=1\r\n";

  it("munges the offer before setLocalDescription and sends the same SDP to the SFU", async () => {
    const { env, sig, engine } = setup({ peer: { offerSdp: OFFER } });
    sig.override("publishTracks", async (_callId, request) => ({
      answer: { type: "answer" as const, sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10\r\n" },
      tracks: request.tracks.map((track) => ({ mid: track.mid, name: `${SELF}-${track.kind}`, kind: track.kind })),
    }));
    await join(engine);
    expect(env.pc.descriptions[0]).toEqual({ side: "local", type: "offer", sdp: MUNGED });
    expect((sig.calls("publishTracks")[0] as { offer: { sdp: string } }).offer.sdp).toBe(MUNGED);
    // The SFU's answer configures our encoder, so it gets FEC + DTX too.
    expect(env.pc.descriptions[1]!.sdp).toContain("a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1");
  });

  it("munges the offer of a negotiated close as well", async () => {
    const { env, sig, engine } = setup({ peer: { offerSdp: OFFER } });
    await join(engine);
    await engine.setScreenEnabled(true);
    await settle();
    await engine.setScreenEnabled(false);
    const close = sig.calls("closeTracks")[0] as { offer: { sdp: string } };
    expect(close.offer.sdp).toBe(MUNGED);
    expect(env.pc.descriptions.filter((d) => d.side === "local").every((d) => d.sdp === MUNGED)).toBe(true);
  });

  it("prefers RED, then Opus, on the mic transceiver when the browser offers it", async () => {
    const opus = { mimeType: "audio/opus", clockRate: 48000, channels: 2, sdpFmtpLine: "minptime=10;useinbandfec=1" };
    const red = { mimeType: "audio/red", clockRate: 48000, channels: 2 };
    const pcmu = { mimeType: "audio/PCMU", clockRate: 8000 };
    const { env, engine } = setup({ audioCapabilities: { codecs: [opus, red, pcmu], headerExtensions: [] } });
    await join(engine);
    const [audio, video] = env.pc.transceivers;
    expect(audio!.codecPreferences).toEqual([red, opus, pcmu]);
    expect(video!.codecPreferences).toBeNull();
    // Mono Opus at ~32 kbps, high priority.
    expect(audio!.init?.sendEncodings).toEqual([{ networkPriority: "high", priority: "high", maxBitrate: 32_000 }]);
  });

  it("leaves codec preferences alone without RED", async () => {
    const opus = { mimeType: "audio/opus", clockRate: 48000, channels: 2 };
    const { env, engine } = setup({ audioCapabilities: { codecs: [opus], headerExtensions: [] } });
    await join(engine);
    expect(env.pc.transceivers[0]!.codecPreferences).toBeNull();
    const other = setup();
    await join(other.engine);
    expect(other.env.pc.transceivers[0]!.codecPreferences).toBeNull();
  });
});

describe("degradation preferences", () => {
  it("camera maintains frame rate; screen maintains resolution at 15 fps with a detail hint", async () => {
    const { env, engine } = setup();
    await join(engine);
    expect(cameraSender(env).degradationPreference).toBe("maintain-framerate");
    expect(env.pc.transceivers[0]!.sender.setParametersCalls).toHaveLength(0);
    await engine.setScreenEnabled(true);
    await settle();
    const screen = env.pc.transceivers[2]!.sender;
    expect(screen.degradationPreference).toBe("maintain-resolution");
    expect(screen.encodings[0]!.maxFramerate).toBe(15);
    expect(screen.track!.contentHint).toBe("detail");
    expect(engine.snapshot().sendLayers).toBe(3);
  });

  it("tolerates browsers whose setParameters throws", async () => {
    const { env, engine, log } = setup({ peer: { rejectSetParameters: true } });
    await join(engine);
    expect(engine.snapshot().phase).toBe("connected");
    expect(cameraSender(env).setParametersCalls).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("call.sender-preferences-failed", expect.objectContaining({ kind: "video" }));
  });
});

describe("CPU adaptation", () => {
  it("sheds a, then b, never c, under sustained cpu, and restores b then a after 10 s of none each", async () => {
    const { env, engine } = await joinWith(callState([]));
    const sender = cameraSender(env);
    const active = (): boolean[] => sender.encodings.map((encoding) => encoding.active !== false);
    sender.stats = { qualityLimitationReason: "cpu" };

    await ticks(2);
    expect(active()).toEqual([true, true, true]);
    expect(engine.snapshot().limitation).toBe("none");
    await ticks(1);
    expect(active()).toEqual([false, true, true]);
    expect(engine.snapshot()).toMatchObject({ limitation: "cpu", sendLayers: 2, localQuality: "fair" });
    await ticks(3);
    expect(active()).toEqual([false, false, true]);
    expect(engine.snapshot().sendLayers).toBe(1);
    await ticks(6);
    expect(active()).toEqual([false, false, true]);

    sender.stats = { qualityLimitationReason: "none" };
    await ticks(3);
    expect(engine.snapshot().limitation).toBe("none");
    expect(active()).toEqual([false, false, true]);
    await ticks(3);
    expect(active()).toEqual([false, true, true]);
    expect(engine.snapshot().sendLayers).toBe(2);
    await ticks(4);
    expect(active()).toEqual([false, true, true]);
    await ticks(1);
    expect(active()).toEqual([true, true, true]);
    expect(engine.snapshot().sendLayers).toBe(3);
  });

  it("ignores short cpu spikes and bandwidth limits (only reports them)", async () => {
    const { env, engine } = await joinWith(callState([]));
    const sender = cameraSender(env);
    for (let round = 0; round < 4; round += 1) {
      sender.stats = { qualityLimitationReason: "cpu" };
      await ticks(2);
      sender.stats = { qualityLimitationReason: "none" };
      await ticks(1);
    }
    expect(sender.encodings.every((encoding) => encoding.active !== false)).toBe(true);
    sender.stats = { qualityLimitationReason: "bandwidth" };
    await ticks(5);
    expect(sender.encodings.every((encoding) => encoding.active !== false)).toBe(true);
    expect(engine.snapshot()).toMatchObject({ limitation: "bandwidth", sendLayers: 3 });
  });

  it("lowers resolution stepwise on a single-encoding camera", async () => {
    const { env, engine } = await joinWith(callState([]), { peer: { rejectSimulcast: true } });
    const sender = cameraSender(env);
    sender.stats = { qualityLimitationReason: "cpu" };
    await ticks(3);
    expect(sender.encodings[0]!.scaleResolutionDownBy).toBe(2);
    await ticks(3);
    expect(sender.encodings[0]!.scaleResolutionDownBy).toBe(4);
    await ticks(3);
    expect(sender.encodings[0]!.scaleResolutionDownBy).toBe(4);
    expect(engine.snapshot().sendLayers).toBe(1);
    sender.stats = { qualityLimitationReason: "none" };
    await ticks(6);
    expect(sender.encodings[0]!.scaleResolutionDownBy).toBe(2);
  });

  it("starts over with every layer after a rebuild", async () => {
    const { env, engine } = await joinWith(callState([]));
    cameraSender(env).stats = { qualityLimitationReason: "cpu" };
    await ticks(3);
    expect(engine.snapshot().sendLayers).toBe(2);
    env.pc.setConnectionState("failed");
    await settle(100);
    expect(env.pcs).toHaveLength(2);
    expect(engine.snapshot().sendLayers).toBe(3);
    expect(cameraSender(env).encodings.every((encoding) => encoding.active !== false)).toBe(true);
  });
});

describe("receive quality and downlink adaptation", () => {
  it("classifies each remote from loss, jitter and frame rate", async () => {
    const { env, engine } = await joinWith(callState([participant("p2", ["audio", "video"]), participant("p3", ["audio"])]));
    const remotes = engine.snapshot().remotes;
    expect(remotes.p2!.quality).toBe("unknown");
    const p2Audio = receiver(env, remotes.p2!.audio);
    const p2Video = receiver(env, remotes.p2!.video);
    const p3Audio = receiver(env, remotes.p3!.audio);
    await ticks(3, () => {
      p2Audio.flow(100, 0, { jitter: 0.01 });
      p2Video.flow(200, 0, { jitter: 0.02, framesPerSecond: 24 });
      p3Audio.flow(100, 5, { jitter: 0.01 });
    });
    expect(engine.snapshot().remotes.p2!.quality).toBe("good");
    expect(engine.snapshot().remotes.p3!.quality).toBe("fair");

    await ticks(3, () => {
      p2Audio.flow(100, 0, { jitter: 0.01 });
      p2Video.flow(200, 0, { jitter: 0.02, framesPerSecond: 4 });
      p3Audio.flow(100, 0, { jitter: 0.01 });
    });
    expect(engine.snapshot().remotes.p2!.quality).toBe("poor");
    expect(engine.snapshot().remotes.p3!.quality).toBe("good");
  });

  it("does not judge frame rate while their camera is off", async () => {
    const off = { ...participant("p2", ["audio", "video"]), video: false };
    const { env, engine } = await joinWith(callState([off]));
    const video = receiver(env, engine.snapshot().remotes.p2!.video);
    await ticks(3, () => video.flow(20, 0, { jitter: 0.01, framesPerSecond: 1 }));
    expect(engine.snapshot().remotes.p2!.quality).toBe("good");
  });

  it("reports our uplink from remote-inbound RTT and loss", async () => {
    const { env, engine } = await joinWith(callState([]));
    cameraSender(env).stats = { roundTripTime: 0.04, fractionLost: 0 };
    await ticks(1);
    expect(engine.snapshot().localQuality).toBe("good");
    cameraSender(env).stats = { roundTripTime: 0.7, fractionLost: 0 };
    await ticks(1);
    expect(engine.snapshot().localQuality).toBe("poor");
  });

  it("poor downlink: layer c after 6 s, audio-only 6 s later, recovery after 15 s good each step", async () => {
    const { env, sig, engine } = await joinWith(callState([participant("p2", ["audio", "video"]), participant("p3", ["screen"])]));
    engine.setTileSizes({ p2: "large", p3: "large" });
    await settle(1_100);
    expect(engine.snapshot().remotes.p2!.videoRid).toBe("a");
    const remotes = engine.snapshot().remotes;
    const audio = receiver(env, remotes.p2!.audio);
    const video = receiver(env, remotes.p2!.video);
    const screen = receiver(env, remotes.p3!.screen);
    const videoMid = midOf(env, remotes.p2!.video);
    const lossy = (): void => {
      audio.flow(100, 20);
      video.flow(300, 20);
      screen.flow(100, 20);
    };

    await ticks(3, lossy);
    expect(sig.calls("setLayer").at(-1)).toMatchObject({ rid: "a" });
    // The fourth poor sample (6 s) forces layer c; the next one also covers the 1 s layer debounce.
    await ticks(2, lossy);
    expect(sig.calls("setLayer").at(-1)).toMatchObject({ trackParticipantId: "p2", rid: "c" });
    expect(engine.snapshot().remotes.p2!.videoRid).toBe("c");
    expect(engine.snapshot().audioOnly).toBe(false);

    // A tile change does not undo the forced layer.
    engine.setTileSizes({ p2: "large", p3: "large" });
    await ticks(1, lossy);
    expect(engine.snapshot().audioOnly).toBe(false);
    await ticks(1, lossy);
    expect(engine.snapshot().audioOnly).toBe(true);
    await settle();
    const close = sig.calls("closeTracks").at(-1) as { mids: string[] };
    expect(close.mids).toEqual([videoMid]);
    const paused = engine.snapshot().remotes;
    expect(paused.p2).toMatchObject({ video: null, videoPaused: true });
    expect(paused.p2!.audio).not.toBeNull();
    // Screen shares keep flowing in audio-only mode.
    expect(paused.p3!.screen).not.toBeNull();
    expect(paused.p3!.videoPaused).toBe(false);
    expect(sig.calls("setLayer").filter((call) => (call as { rid: string }).rid === "a")).toHaveLength(1);

    const pullsBefore = sig.calls("pullTracks").length;
    const clean = (): void => {
      audio.flow(100, 0);
      screen.flow(100, 0);
    };
    await ticks(7, clean);
    expect(engine.snapshot().audioOnly).toBe(true);
    await ticks(2, clean);
    expect(engine.snapshot().audioOnly).toBe(false);
    await settle();
    const repull = sig.calls("pullTracks")[pullsBefore] as PullTracksRequest;
    expect(repull.tracks).toEqual([{ participantId: "p2", name: "p2-video", rid: "c" }]);
    expect(engine.snapshot().remotes.p2).toMatchObject({ videoPaused: false, videoRid: "c" });
    expect(engine.snapshot().remotes.p2!.video).not.toBeNull();

    const fresh = receiver(env, engine.snapshot().remotes.p2!.video);
    await ticks(8, () => {
      clean();
      fresh.flow(300, 0);
    });
    await settle(ENGINE_TIMINGS.layerDebounceMs + 100);
    expect(sig.calls("setLayer").at(-1)).toMatchObject({ trackParticipantId: "p2", rid: "a" });
  });

  it("treats a low available incoming bitrate with some loss as a poor downlink", async () => {
    const { env, sig, engine } = await joinWith(callState([participant("p2", ["video"])]));
    env.pc.transport = { relayed: false, availableIncomingBitrate: 200_000 };
    const video = receiver(env, engine.snapshot().remotes.p2!.video);
    await ticks(4, () => video.flow(100, 5));
    await settle(ENGINE_TIMINGS.layerDebounceMs + 100);
    expect(sig.calls("setLayer").at(-1)).toMatchObject({ rid: "c" });
  });

  it("ignores a low available incoming bitrate while nothing is lost", async () => {
    const { env, sig, engine } = await joinWith(callState([participant("p2", ["video"])]));
    env.pc.transport = { relayed: false, availableIncomingBitrate: 200_000 };
    const video = receiver(env, engine.snapshot().remotes.p2!.video);
    await ticks(8, () => video.flow(100, 0));
    await settle(ENGINE_TIMINGS.layerDebounceMs + 100);
    expect(sig.calls("setLayer").filter((call) => (call as { rid?: string }).rid === "c")).toHaveLength(0);
    expect(engine.snapshot().audioOnly).toBe(false);
  });
});

describe("pausing what is not seen", () => {
  it("closes a hidden participant's video pull after 5 s, keeps audio, and re-pulls on show", async () => {
    const { env, sig, engine } = await joinWith(callState([participant("p2", ["audio", "video"])]));
    const videoMid = midOf(env, engine.snapshot().remotes.p2!.video);
    engine.setTileSizes({ p2: "hidden" });
    await settle(ENGINE_TIMINGS.hiddenPauseMs - 100);
    expect(sig.calls("closeTracks")).toHaveLength(0);
    await settle(200);
    expect(sig.calls("closeTracks")).toEqual([expect.objectContaining({ mids: [videoMid], offer: expect.any(Object) })]);
    expect(engine.snapshot().remotes.p2).toMatchObject({ video: null, videoPaused: true });
    expect(engine.snapshot().remotes.p2!.audio).not.toBeNull();

    const pulls = sig.calls("pullTracks").length;
    engine.setTileSizes({ p2: "large" });
    await settle();
    expect((sig.calls("pullTracks")[pulls] as PullTracksRequest).tracks).toEqual([{ participantId: "p2", name: "p2-video", rid: "a" }]);
    expect(engine.snapshot().remotes.p2).toMatchObject({ videoPaused: false, videoRid: "a" });
    expect(engine.snapshot().remotes.p2!.video).not.toBeNull();
  });

  it("does nothing when a tile is shown again within 5 s, and never pauses audio-only participants' audio", async () => {
    const { sig, engine } = await joinWith(callState([participant("p2", ["audio", "video"]), participant("p3", ["audio"])]));
    engine.setTileSizes({ p2: "hidden", p3: "hidden" });
    await settle(4_000);
    engine.setTileSizes({ p2: "small", p3: "hidden" });
    await settle(10_000);
    expect(sig.calls("closeTracks")).toHaveLength(0);
    expect(engine.snapshot().remotes.p2!.videoPaused).toBe(false);
    expect(engine.snapshot().remotes.p3).toMatchObject({ videoPaused: false });
    expect(engine.snapshot().remotes.p3!.audio).not.toBeNull();
  });

  it("treats a hidden document as every tile hidden", async () => {
    const { env, sig, engine } = await joinWith(callState([participant("p2", ["audio", "video"]), participant("p3", ["audio", "video"])]));
    engine.setTileSizes({ p2: "large", p3: "medium" });
    env.setDocumentHidden(true);
    await settle(ENGINE_TIMINGS.hiddenPauseMs + 100);
    expect(sig.calls("closeTracks")).toHaveLength(1);
    expect((sig.calls("closeTracks")[0] as { mids: string[] }).mids).toHaveLength(2);
    expect(engine.snapshot().remotes.p2!.videoPaused).toBe(true);
    expect(engine.snapshot().remotes.p3!.videoPaused).toBe(true);
    expect(engine.snapshot().remotes.p2!.audio).not.toBeNull();

    const pulls = sig.calls("pullTracks").length;
    env.setDocumentHidden(false);
    await settle();
    const repull = sig.calls("pullTracks")[pulls] as PullTracksRequest;
    expect(repull.tracks).toEqual([
      { participantId: "p2", name: "p2-video", rid: "a" },
      { participantId: "p3", name: "p3-video", rid: "b" },
    ]);
  });

  it("keeps video playing in a hidden tab while the call is in a picture-in-picture window", async () => {
    const { env, sig, engine } = await joinWith(callState([participant("p2", ["audio", "video"])]));
    engine.setTileSizes({ p2: "large" });
    engine.setPictureInPicture(true);
    env.setDocumentHidden(true);
    await settle(ENGINE_TIMINGS.hiddenPauseMs + 100);
    expect(sig.calls("closeTracks")).toHaveLength(0);
    expect(engine.snapshot().remotes.p2!.videoPaused).toBe(false);

    // Back in the page with the tab still hidden: the usual rule applies again.
    engine.setPictureInPicture(false);
    await settle(ENGINE_TIMINGS.hiddenPauseMs + 100);
    expect(sig.calls("closeTracks")).toHaveLength(1);
    expect(engine.snapshot().remotes.p2!.videoPaused).toBe(true);
  });

  it("unsubscribes from visibility changes and clears pause timers on leave", async () => {
    const { env, engine } = await joinWith(callState([participant("p2", ["audio", "video"])]));
    expect(env.visibilityListeners.size).toBe(1);
    engine.setTileSizes({ p2: "hidden" });
    await engine.leave();
    expect(env.visibilityListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

const REPORT_KEYS = [
  "audioCodec",
  "audioOnlyMs",
  "durationMs",
  "final",
  "framesDecoded",
  "framesDropped",
  "intervalMs",
  "jitterMs",
  "limitedMs",
  "lossPercent",
  "participantId",
  "reconnects",
  "relayed",
  "rttMs",
  "videoCodec",
];

describe("chosen audio-only", () => {
  it("closes camera pulls and the camera, keeps audio and screens, and restores both", async () => {
    const { env, sig, engine } = await joinWith(callState([participant("p2", ["audio", "video"]), participant("p3", ["screen"])]));
    engine.setTileSizes({ p2: "large", p3: "large" });
    await settle(1_100);
    const videoMid = midOf(env, engine.snapshot().remotes.p2!.video);
    expect(engine.snapshot().videoEnabled).toBe(true);

    await engine.setAudioOnly(true);
    await settle();
    expect(engine.snapshot()).toMatchObject({ audioOnlyChosen: true, audioOnly: false, videoEnabled: false });
    expect((sig.calls("closeTracks").at(-1) as { mids: string[] }).mids).toEqual([videoMid]);
    expect(engine.snapshot().remotes.p2).toMatchObject({ video: null, videoPaused: true });
    expect(engine.snapshot().remotes.p2!.audio).not.toBeNull();
    expect(engine.snapshot().remotes.p3!.screen).not.toBeNull();
    // The camera sender keeps the SFU's track alive with the black placeholder.
    expect(cameraSender(env).track?.kind).toBe("video");

    const pulls = sig.calls("pullTracks").length;
    await engine.setAudioOnly(false);
    await settle();
    expect(engine.snapshot()).toMatchObject({ audioOnlyChosen: false, videoEnabled: true });
    expect((sig.calls("pullTracks")[pulls] as PullTracksRequest).tracks).toEqual([{ participantId: "p2", name: "p2-video", rid: "a" }]);
    expect(engine.snapshot().remotes.p2).toMatchObject({ videoPaused: false });
  });

  it("leaves a camera that was off, off, and one turned on meanwhile, on", async () => {
    const { engine } = await joinWith(callState([participant("p2", ["audio", "video"])]), {}, { video: false });
    await engine.setAudioOnly(true);
    await engine.setAudioOnly(false);
    expect(engine.snapshot().videoEnabled).toBe(false);

    await engine.setAudioOnly(true);
    await engine.setVideoEnabled(true);
    await engine.setAudioOnly(false);
    expect(engine.snapshot().videoEnabled).toBe(true);
  });

  it("ends with the call", async () => {
    const { engine } = await joinWith(callState([participant("p2", ["audio", "video"])]));
    await engine.setAudioOnly(true);
    await engine.leave();
    expect(engine.snapshot().audioOnlyChosen).toBe(false);
  });
});

describe("effects (quality phase 2)", () => {
  const both = { effects: { noise: true, blur: true } };
  const micSender = (env: FakeEnvironment): FakeSender => env.pc.transceivers[0]!.sender;

  it("reports unsupported effects and ignores a request for one", async () => {
    const { env, engine } = await joinWith(callState([]));
    expect(engine.snapshot()).toMatchObject({ noiseSuppression: "unsupported", backgroundBlur: "unsupported" });
    await engine.setNoiseSuppression(true);
    expect(env.effects).toHaveLength(0);
    expect(engine.snapshot().noiseSuppression).toBe("unsupported");
  });

  it("swaps the processed track onto the sender and back, with no renegotiation", async () => {
    const { env, sig, engine } = await joinWith(callState([]), both);
    expect(engine.snapshot()).toMatchObject({ noiseSuppression: "off", backgroundBlur: "off" });
    const offers = sig.calls("publishTracks").length;
    const rawMic = micSender(env).track;

    await engine.setNoiseSuppression(true);
    const noise = env.effects.find((effect) => effect.kind === "noise")!;
    expect(noise.source).toBe(rawMic);
    expect(micSender(env).track).toBe(noise.track);
    expect(engine.snapshot().noiseSuppression).toBe("on");

    await engine.setBackgroundBlur(true);
    const blur = env.effects.find((effect) => effect.kind === "blur")!;
    expect(cameraSender(env).track).toBe(blur.track);
    // The preview shows what others see.
    expect(engine.snapshot().localVideo?.getVideoTracks()[0]).toBe(blur.track);

    await engine.setNoiseSuppression(false);
    expect(micSender(env).track).toBe(rawMic);
    expect(noise.closed).toBe(true);
    expect(engine.snapshot().noiseSuppression).toBe("off");
    expect(sig.calls("publishTracks")).toHaveLength(offers);
  });

  it("starts chosen effects before the first publish", async () => {
    const { env, sig } = await joinWith(callState([]), both, { noiseSuppression: true, backgroundBlur: true });
    const published = env.effects.map((effect) => effect.track);
    expect(published).toHaveLength(2);
    expect(sig.calls("publishTracks")).toHaveLength(1);
    expect(micSender(env).track).toBe(published[0]);
    expect(cameraSender(env).track).toBe(published[1]);
  });

  it("rebuilds around a new device, and drops blur while the camera is off", async () => {
    const { env, engine } = await joinWith(callState([]), both);
    await engine.setBackgroundBlur(true);
    const first = env.effects[0]!;
    await engine.setDevices({ videoInputId: "cam-2" });
    expect(first.closed).toBe(true);
    const second = env.effects[1]!;
    expect(second.source).not.toBe(first.source);
    expect(cameraSender(env).track).toBe(second.track);

    await engine.setVideoEnabled(false);
    expect(second.closed).toBe(true);
    expect(engine.snapshot().backgroundBlur).toBe("on");
    await engine.setVideoEnabled(true);
    const third = env.effects[2]!;
    expect(cameraSender(env).track).toBe(third.track);
  });

  it("marks an effect that fails to start, and leaves the raw track on the sender", async () => {
    const { env, engine } = await joinWith(callState([]), { ...both, effectError: "no wasm" });
    const rawMic = micSender(env).track;
    await engine.setNoiseSuppression(true);
    expect(engine.snapshot().noiseSuppression).toBe("failed");
    expect(micSender(env).track).toBe(rawMic);
  });

  it("sheds blur, then noise suppression, before any simulcast layer under sustained cpu", async () => {
    const { env, engine } = await joinWith(callState([]), both);
    await engine.setBackgroundBlur(true);
    await engine.setNoiseSuppression(true);
    const sender = cameraSender(env);
    const active = (): boolean[] => sender.encodings.map((encoding) => encoding.active !== false);
    sender.stats = { qualityLimitationReason: "cpu" };
    await ticks(3);
    await settle();
    expect(engine.snapshot()).toMatchObject({ backgroundBlur: "cpu", noiseSuppression: "on" });
    expect(active()).toEqual([true, true, true]);
    await ticks(3);
    await settle();
    expect(engine.snapshot()).toMatchObject({ backgroundBlur: "cpu", noiseSuppression: "cpu" });
    expect(active()).toEqual([true, true, true]);
    await ticks(3);
    expect(active()).toEqual([false, true, true]);
    // Switching one back on is allowed.
    await engine.setNoiseSuppression(true);
    expect(engine.snapshot().noiseSuppression).toBe("on");
  });

  it("closes every processor on leave", async () => {
    const { env, engine } = await joinWith(callState([]), both, { noiseSuppression: true, backgroundBlur: true });
    await engine.leave();
    expect(env.effects.every((effect) => effect.closed)).toBe(true);
    expect(engine.snapshot().noiseSuppression).toBe("unsupported");
  });
});

describe("telemetry", () => {
  it("posts a summary every 60 s with codec names, relay flag and counters, and nothing identifying", async () => {
    const { env, sig, engine } = await joinWith(callState([participant("p2", ["audio", "video"])]));
    env.pc.transport = { relayed: true };
    env.pc.transceivers[0]!.sender.stats = { mimeType: "audio/opus", roundTripTime: 0.05, fractionLost: 0.01 };
    cameraSender(env).stats = { mimeType: "video/VP8", qualityLimitationReason: "cpu", qualityLimitationDurations: { cpu: 0 } };
    const video = receiver(env, engine.snapshot().remotes.p2!.video);
    let cpuSeconds = 0;
    const flow = (): void => {
      video.flow(100, 5, { jitter: 0.02, framesDecoded: (video.stats.framesDecoded ?? 0) + 48, framesDropped: 1 });
      cpuSeconds += 2;
      cameraSender(env).stats = { ...cameraSender(env).stats, qualityLimitationDurations: { cpu: cpuSeconds } };
    };
    await ticks(29, flow);
    expect(sig.calls("postCallStats")).toHaveLength(0);
    await ticks(1, flow);
    const reports = sig.calls("postCallStats") as CallStatsReport[];
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(Object.keys(report).sort()).toEqual(REPORT_KEYS);
    expect(report).toMatchObject({
      participantId: SELF,
      final: false,
      relayed: true,
      audioCodec: "opus",
      videoCodec: "VP8",
      reconnects: 0,
      audioOnlyMs: 0,
      framesDropped: 1,
      lossPercent: { send: 1, receive: 5 },
      rttMs: { avg: 50, max: 50 },
      jitterMs: 20,
    });
    expect(report.intervalMs).toBeGreaterThanOrEqual(59_000);
    expect(report.framesDecoded).toBeGreaterThan(1_000);
    expect(report.limitedMs.cpu).toBeGreaterThan(50_000);
    const json = JSON.stringify(report);
    expect(json).not.toMatch(/192\.0\.2|198\.51\.100|address|sdp|label|camera|mic\b|turn|stun/i);

    await settle(60_000);
    expect(sig.calls("postCallStats")).toHaveLength(2);
    expect((sig.calls("postCallStats")[1] as CallStatsReport).final).toBe(false);
  });

  it("sends a final report on leave, before leaveCall, counting reconnects", async () => {
    const { env, sig, engine } = await joinWith(callState([]));
    env.pc.setConnectionState("failed");
    await settle(100);
    await settle(5_000);
    await engine.leave();
    const methods = sig.methods();
    expect(methods.slice(-2)).toEqual(["postCallStats", "leaveCall"]);
    const report = sig.calls("postCallStats").at(-1) as CallStatsReport;
    expect(report).toMatchObject({ final: true, reconnects: 1, participantId: SELF });
    expect(report.durationMs).toBeGreaterThanOrEqual(5_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("on page unload starts the final report and the leave at once, both keepalive", async () => {
    const { sig, engine } = await joinWith(callState([]));
    const sent: [string, unknown][] = [];
    sig.override("postCallStats", async (_callId, _report, options) => {
      sent.push(["postCallStats", options]);
      return { ok: true } as never;
    });
    sig.override("leaveCall", async (_callId, _request, options) => {
      sent.push(["leaveCall", options]);
      return { ok: true } as never;
    });
    // Not awaited: an unloading page gets no later turn.
    void engine.leave({ keepalive: true });
    expect(sent).toEqual([
      ["postCallStats", { keepalive: true }],
      ["leaveCall", { keepalive: true }],
    ]);
    expect(engine.snapshot().phase).toBe("idle");
  });

  it("counts audio-only time", async () => {
    const { env, sig, engine } = await joinWith(callState([participant("p2", ["audio", "video"])]));
    const audio = receiver(env, engine.snapshot().remotes.p2!.audio);
    const video = receiver(env, engine.snapshot().remotes.p2!.video);
    await ticks(7, () => {
      audio.flow(100, 30);
      video.flow(100, 30);
    });
    expect(engine.snapshot().audioOnly).toBe(true);
    await ticks(3, () => audio.flow(100, 30));
    await engine.leave();
    const report = sig.calls("postCallStats").at(-1) as CallStatsReport;
    expect(report.audioOnlyMs).toBeGreaterThanOrEqual(6_000);
    expect(report.audioOnlyMs).toBeLessThanOrEqual(8_000);
  });

  it("ignores a failed report and still leaves", async () => {
    const { sig, engine, log } = await joinWith(callState([]));
    sig.override("postCallStats", async () => {
      throw new ApiError("rate_limited", "slow down", 429);
    });
    await engine.leave();
    expect(sig.calls("leaveCall")).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("call.stats-failed", { error: "rate_limited/429" });
    expect(engine.snapshot().phase).toBe("idle");
  });

  it(`never sends more than ${MAX_CALL_STATS_PER_MINUTE} reports a minute`, async () => {
    const { sig, engine } = setup();
    for (let round = 0; round < MAX_CALL_STATS_PER_MINUTE + 2; round += 1) {
      await join(engine);
      await engine.leave();
    }
    expect(sig.calls("leaveCall")).toHaveLength(MAX_CALL_STATS_PER_MINUTE + 2);
    expect(sig.calls("postCallStats")).toHaveLength(MAX_CALL_STATS_PER_MINUTE);
    await settle(61_000);
    await join(engine);
    await engine.leave();
    expect(sig.calls("postCallStats")).toHaveLength(MAX_CALL_STATS_PER_MINUTE + 1);
  });

  it("sends nothing on dispose or when the call never connected", async () => {
    const { sig, engine } = await joinWith(callState([]));
    engine.dispose();
    expect(sig.calls("postCallStats")).toHaveLength(0);
    const other = setup();
    other.sig.override("joinCall", async () => {
      throw new ApiError("conflict", "full", 409);
    });
    await expect(other.engine.join(JOIN)).rejects.toThrow();
    await other.engine.leave();
    expect(other.sig.calls("postCallStats")).toHaveLength(0);
  });
});

describe("snapshot throttling", () => {
  it("does not emit on stats ticks when nothing visible changes", async () => {
    const { env, engine } = await joinWith(callState([participant("p2", ["audio", "video"])]));
    const audio = receiver(env, engine.snapshot().remotes.p2!.audio);
    const video = receiver(env, engine.snapshot().remotes.p2!.video);
    cameraSender(env).stats = { qualityLimitationReason: "none", roundTripTime: 0.03, fractionLost: 0 };
    const flow = (): void => {
      audio.flow(100, 0, { jitter: 0.01 });
      video.flow(200, 0, { jitter: 0.01, framesPerSecond: 24 });
    };
    await ticks(3, flow);
    expect(engine.snapshot().remotes.p2!.quality).toBe("good");
    const listener = vi.fn();
    engine.subscribe(listener);
    await ticks(10, flow);
    expect(listener).not.toHaveBeenCalled();
  });
});
