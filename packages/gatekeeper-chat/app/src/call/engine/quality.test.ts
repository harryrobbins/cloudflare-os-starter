import { describe, expect, it } from "vitest";

import { audioConstraints, videoConstraints } from "./media.js";
import {
  DOWNLINK_POOR_MS,
  DOWNLINK_RECOVER_MS,
  DownlinkAdaptation,
  LossWindow,
  SEND_RESTORE_MS,
  SendAdaptation,
  activeLayers,
  classifyReceive,
  classifyUplink,
  downlinkVerdict,
  expectedFramerate,
  stepSendEncodings,
  worstQuality,
} from "./quality.js";
import { codecName, ensureOpusParams, mergeFmtp, redFirst } from "./sdp.js";
import { readInbound, readOutbound, readTransport } from "./stats.js";
import { CallTelemetry } from "./telemetry.js";

function report(entries: Record<string, unknown>[]): RTCStatsReport {
  return new Map(entries.map((entry, index) => [String(entry.id ?? index), entry])) as unknown as RTCStatsReport;
}

const OFFER = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0 1 2",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 0",
  "a=mid:0",
  "a=rtpmap:111 opus/48000/2",
  "a=rtcp-fb:111 transport-cc",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "a=fmtp:63 111/111",
  "a=rtpmap:0 PCMU/8000",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=mid:1",
  "a=rtpmap:96 VP8/90000",
  "m=audio 9 UDP/TLS/RTP/SAVPF 109",
  "a=mid:2",
  "a=rtpmap:109 opus/48000/2",
  "",
].join("\r\n");

describe("ensureOpusParams", () => {
  it("adds usedtx to an existing fmtp, keeps other params and does not duplicate useinbandfec", () => {
    const out = ensureOpusParams(OFFER);
    expect(out).toContain("a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1\r\n");
    expect(out.match(/useinbandfec/g)).toHaveLength(2);
  });

  it("leaves non-Opus fmtp lines (RED, video) alone", () => {
    const out = ensureOpusParams(OFFER);
    expect(out).toContain("a=fmtp:63 111/111\r\n");
    expect(out).not.toMatch(/a=fmtp:96/);
  });

  it("inserts an fmtp line after the rtpmap when an Opus section has none, per media section", () => {
    const out = ensureOpusParams(OFFER);
    expect(out).toContain("a=rtpmap:109 opus/48000/2\r\na=fmtp:109 useinbandfec=1;usedtx=1\r\n");
  });

  it("is idempotent and keeps line endings and the trailing newline", () => {
    const once = ensureOpusParams(OFFER);
    expect(ensureOpusParams(once)).toBe(once);
    expect(once.endsWith("\r\n")).toBe(true);
    expect(once.split("\r\n")).toHaveLength(OFFER.split("\r\n").length + 1);
  });

  it("overwrites a disabled value instead of adding a second key", () => {
    const sdp = "m=audio 9 RTP/AVP 111\na=rtpmap:111 OPUS/48000/2\na=fmtp:111 usedtx=0; stereo=1\n";
    expect(ensureOpusParams(sdp)).toBe("m=audio 9 RTP/AVP 111\na=rtpmap:111 OPUS/48000/2\na=fmtp:111 usedtx=1;stereo=1;useinbandfec=1\n");
  });

  it("handles several Opus payload types in one section", () => {
    const sdp = "m=audio 9 RTP/AVP 111 112\na=rtpmap:111 opus/48000/2\na=rtpmap:112 opus/48000/2\na=fmtp:112 minptime=10\n";
    const out = ensureOpusParams(sdp);
    expect(out).toContain("a=fmtp:111 useinbandfec=1;usedtx=1");
    expect(out).toContain("a=fmtp:112 minptime=10;useinbandfec=1;usedtx=1");
    expect(out.match(/a=fmtp:111/g)).toHaveLength(1);
  });

  it("returns anything that is not SDP with Opus unchanged", () => {
    expect(ensureOpusParams("client-offer-1")).toBe("client-offer-1");
    expect(ensureOpusParams('{"remote":[]}')).toBe('{"remote":[]}');
    const video = "m=video 9 RTP/AVP 96\r\na=rtpmap:96 VP8/90000\r\n";
    expect(ensureOpusParams(video)).toBe(video);
  });

  it("mergeFmtp keeps flags and order", () => {
    expect(mergeFmtp("a=1;flag; b=2", { B: "3", c: "4" })).toBe("a=1;flag;b=3;c=4");
    expect(mergeFmtp("", { x: "1" })).toBe("x=1");
  });
});

describe("codec preferences", () => {
  const opus = { mimeType: "audio/opus", clockRate: 48000, channels: 2 };
  const red = { mimeType: "audio/red", clockRate: 48000, channels: 2 };
  const pcmu = { mimeType: "audio/PCMU", clockRate: 8000 };
  const g722 = { mimeType: "audio/G722", clockRate: 8000 };

  it("puts RED first, then Opus, then the rest in order", () => {
    expect(redFirst([opus, g722, red, pcmu])).toEqual([red, opus, g722, pcmu]);
    expect(redFirst([{ ...red, mimeType: "audio/RED" }, opus])?.[0]?.mimeType).toBe("audio/RED");
  });

  it("returns null when RED is not offered", () => {
    expect(redFirst([opus, pcmu])).toBeNull();
    expect(redFirst([])).toBeNull();
  });

  it("codecName strips the media type", () => {
    expect(codecName("audio/opus")).toBe("opus");
    expect(codecName("video/VP8")).toBe("VP8");
    expect(codecName("audio/red")).toBe("red");
  });
});

describe("capture constraints", () => {
  it("asks for echo cancellation, noise suppression and gain control explicitly", () => {
    expect(audioConstraints(null, {})).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    expect(audioConstraints("mic-2", {})).toMatchObject({ deviceId: { exact: "mic-2" } });
  });

  it("adds voiceIsolation only where supported", () => {
    expect(audioConstraints(null, { voiceIsolation: true } as MediaTrackSupportedConstraints)).toMatchObject({ voiceIsolation: true });
    expect(audioConstraints(null, { voiceIsolation: false } as MediaTrackSupportedConstraints)).not.toHaveProperty("voiceIsolation");
    // jsdom has no navigator.mediaDevices: detection falls back to "unsupported".
    expect(audioConstraints(null)).not.toHaveProperty("voiceIsolation");
  });

  it("caps the camera at 1280x720 and 30 fps", () => {
    expect(videoConstraints(null)).toEqual({
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 30, max: 30 },
    });
    expect(videoConstraints("cam-1")).toMatchObject({ deviceId: { exact: "cam-1" } });
  });
});

describe("quality classification", () => {
  it("classifies receive loss: <2% good, <8% fair, else poor", () => {
    const at = (lossPercent: number) => classifyReceive({ lossPercent, jitterMs: 5, framesPerSecond: null, expectedFps: null });
    expect(at(0)).toBe("good");
    expect(at(1.9)).toBe("good");
    expect(at(2)).toBe("fair");
    expect(at(7.9)).toBe("fair");
    expect(at(8)).toBe("poor");
  });

  it("is unknown until packets arrive, and takes the worst of loss, jitter and frame rate", () => {
    expect(classifyReceive({ lossPercent: null, jitterMs: 500, framesPerSecond: 1, expectedFps: 30 })).toBe("unknown");
    expect(classifyReceive({ lossPercent: 0, jitterMs: 60, framesPerSecond: null, expectedFps: null })).toBe("fair");
    expect(classifyReceive({ lossPercent: 0, jitterMs: 150, framesPerSecond: null, expectedFps: null })).toBe("poor");
    expect(classifyReceive({ lossPercent: 0, jitterMs: 5, framesPerSecond: 24, expectedFps: 24 })).toBe("good");
    expect(classifyReceive({ lossPercent: 0, jitterMs: 5, framesPerSecond: 10, expectedFps: 24 })).toBe("fair");
    expect(classifyReceive({ lossPercent: 0, jitterMs: 5, framesPerSecond: 3, expectedFps: 24 })).toBe("poor");
    // Frame rate is ignored where nothing is expected (audio, screen, camera off).
    expect(classifyReceive({ lossPercent: 0, jitterMs: 5, framesPerSecond: 1, expectedFps: null })).toBe("good");
  });

  it("classifies the uplink from RTT, remote-reported loss and a sustained limitation", () => {
    expect(classifyUplink({ rttMs: null, lossPercent: null, limitation: "none" })).toBe("unknown");
    expect(classifyUplink({ rttMs: 40, lossPercent: 0, limitation: "none" })).toBe("good");
    expect(classifyUplink({ rttMs: 300, lossPercent: 0, limitation: "none" })).toBe("fair");
    expect(classifyUplink({ rttMs: 600, lossPercent: 0, limitation: "none" })).toBe("poor");
    expect(classifyUplink({ rttMs: 40, lossPercent: 12, limitation: "none" })).toBe("poor");
    expect(classifyUplink({ rttMs: 40, lossPercent: 0, limitation: "cpu" })).toBe("fair");
    expect(classifyUplink({ rttMs: null, lossPercent: null, limitation: "bandwidth" })).toBe("fair");
  });

  it("worstQuality ignores unknown", () => {
    expect(worstQuality([])).toBe("unknown");
    expect(worstQuality(["unknown", "good"])).toBe("good");
    expect(worstQuality(["good", "poor", "fair"])).toBe("poor");
  });

  it("expects the frame rate of the pulled layer", () => {
    expect(expectedFramerate("a")).toBe(30);
    expect(expectedFramerate("b")).toBe(24);
    expect(expectedFramerate("c")).toBe(15);
    expect(expectedFramerate(null)).toBe(30);
  });

  it("LossWindow reports loss over the last three samples and survives counter resets", () => {
    const window = new LossWindow(3);
    expect(window.push(0, 0)).toBeNull();
    expect(window.push(10, 90)).toBe(10);
    expect(window.push(10, 190)).toBe(5);
    expect(window.push(10, 290)).toBeCloseTo(3.33, 1);
    // The first 10 lost fall out of the window.
    expect(window.push(10, 390)).toBe(0);
    expect(window.push(0, 50)).toBe(0);
  });
});

describe("send adaptation", () => {
  it("sheds after three cpu samples, again after three more, and reports cpu as sustained", () => {
    const adapt = new SendAdaptation();
    expect(adapt.sample(0, "cpu")).toBeNull();
    expect(adapt.sample(2_000, "cpu")).toBeNull();
    expect(adapt.limitation).toBe("none");
    expect(adapt.sample(4_000, "cpu")).toBe("shed");
    expect(adapt.limitation).toBe("cpu");
    expect(adapt.sample(6_000, "cpu")).toBeNull();
    expect(adapt.sample(8_000, "cpu")).toBeNull();
    expect(adapt.sample(10_000, "cpu")).toBe("shed");
  });

  it("does not shed on a short spike, and restores only after 10 s of none, one step at a time", () => {
    const adapt = new SendAdaptation();
    adapt.sample(0, "cpu");
    adapt.sample(2_000, "cpu");
    expect(adapt.sample(4_000, "none")).toBeNull();
    expect(adapt.sample(6_000, "cpu")).toBeNull();
    let restores = 0;
    for (let t = 8_000; t <= 8_000 + SEND_RESTORE_MS; t += 2_000) if (adapt.sample(t, "none") === "restore") restores += 1;
    expect(restores).toBe(1);
    expect(adapt.limitation).toBe("none");
    expect(adapt.sample(8_000 + SEND_RESTORE_MS + 2_000, "none")).toBeNull();
  });

  it("reports bandwidth without shedding and resets the none timer", () => {
    const adapt = new SendAdaptation();
    for (let t = 0; t < 10_000; t += 2_000) expect(adapt.sample(t, "bandwidth")).toBeNull();
    expect(adapt.limitation).toBe("bandwidth");
    expect(adapt.sample(10_000, "none")).toBeNull();
  });

  it("steps simulcast encodings a then b, never c, and restores b then a", () => {
    const encodings: RTCRtpEncodingParameters[] = [{ rid: "a" }, { rid: "b" }, { rid: "c" }];
    expect(stepSendEncodings(encodings, true, "shed")).toBe(true);
    expect(encodings.map((e) => e.active !== false)).toEqual([false, true, true]);
    expect(stepSendEncodings(encodings, true, "shed")).toBe(true);
    expect(encodings.map((e) => e.active !== false)).toEqual([false, false, true]);
    expect(stepSendEncodings(encodings, true, "shed")).toBe(false);
    expect(activeLayers(encodings, true)).toBe(1);
    expect(stepSendEncodings(encodings, true, "restore")).toBe(true);
    expect(encodings.map((e) => e.active !== false)).toEqual([false, true, true]);
    expect(stepSendEncodings(encodings, true, "restore")).toBe(true);
    expect(stepSendEncodings(encodings, true, "restore")).toBe(false);
    expect(activeLayers(encodings, true)).toBe(3);
  });

  it("scales a single encoding 1 -> 2 -> 4 and back", () => {
    const encodings: RTCRtpEncodingParameters[] = [{ maxBitrate: 1 }];
    expect(stepSendEncodings(encodings, false, "restore")).toBe(false);
    expect(stepSendEncodings(encodings, false, "shed")).toBe(true);
    expect(encodings[0]!.scaleResolutionDownBy).toBe(2);
    expect(stepSendEncodings(encodings, false, "shed")).toBe(true);
    expect(encodings[0]!.scaleResolutionDownBy).toBe(4);
    expect(stepSendEncodings(encodings, false, "shed")).toBe(false);
    expect(stepSendEncodings(encodings, false, "restore")).toBe(true);
    expect(encodings[0]!.scaleResolutionDownBy).toBe(2);
    expect(activeLayers(encodings, false)).toBe(1);
  });
});

describe("downlink adaptation", () => {
  it("verdicts from loss and available bitrate", () => {
    expect(downlinkVerdict(12, null)).toBe("poor");
    expect(downlinkVerdict(0, 200_000)).toBe("poor");
    expect(downlinkVerdict(1, null)).toBe("good");
    expect(downlinkVerdict(null, null)).toBe("good");
    expect(downlinkVerdict(5, null)).toBe("fair");
    expect(downlinkVerdict(1, 400_000)).toBe("fair");
  });

  it("steps normal -> low -> audio-only on sustained poor, and back one step per 15 s of good", () => {
    const adapt = new DownlinkAdaptation();
    const modes: string[] = [];
    let t = 0;
    const run = (verdict: "good" | "fair" | "poor", ms: number): void => {
      for (const end = t + ms; t < end; t += 2_000) modes.push(adapt.sample(t, verdict));
    };
    run("poor", DOWNLINK_POOR_MS);
    expect(adapt.mode).toBe("normal");
    run("poor", 2_000);
    expect(adapt.mode).toBe("low");
    run("poor", DOWNLINK_POOR_MS);
    expect(adapt.mode).toBe("audio-only");
    run("poor", 20_000);
    expect(adapt.mode).toBe("audio-only");
    run("fair", 30_000);
    expect(adapt.mode).toBe("audio-only");
    run("good", DOWNLINK_RECOVER_MS + 2_000);
    expect(adapt.mode).toBe("low");
    run("good", DOWNLINK_RECOVER_MS);
    expect(adapt.mode).toBe("normal");
  });

  it("a fair sample breaks a poor streak", () => {
    const adapt = new DownlinkAdaptation();
    for (let t = 0; t < 30_000; t += 2_000) adapt.sample(t, t % 6_000 === 4_000 ? "fair" : "poor");
    expect(adapt.mode).toBe("normal");
  });
});

describe("stats readers", () => {
  it("reads the worst limitation, durations, remote-inbound RTT/loss and codec from a sender", () => {
    const sample = readOutbound(
      report([
        { id: "o1", type: "outbound-rtp", qualityLimitationReason: "none", qualityLimitationDurations: { cpu: 1, bandwidth: 4 }, codecId: "c1" },
        { id: "o2", type: "outbound-rtp", qualityLimitationReason: "cpu", qualityLimitationDurations: { cpu: 3, bandwidth: 0 } },
        { id: "c1", type: "codec", mimeType: "video/VP8" },
        { id: "r1", type: "remote-inbound-rtp", roundTripTime: 0.05, fractionLost: 0.02 },
      ]),
    );
    expect(sample).toEqual({ limitation: "cpu", limitedSeconds: { cpu: 3, bandwidth: 4 }, rttMs: 50, lossPercent: 2, mimeType: "video/VP8" });
    expect(readOutbound(report([{ id: "o", type: "outbound-rtp" }])).limitation).toBeNull();
  });

  it("reads inbound counters", () => {
    expect(readInbound(report([]))).toBeNull();
    expect(
      readInbound(
        report([
          { id: "i", type: "inbound-rtp", packetsLost: -1, packetsReceived: 10, jitter: 0.012, framesPerSecond: 24, codecId: "c" },
          { id: "c", type: "codec", mimeType: "audio/opus" },
        ]),
      ),
    ).toEqual({ packetsLost: 0, packetsReceived: 10, jitterMs: 12, framesPerSecond: 24, framesDecoded: 0, framesDropped: 0, mimeType: "audio/opus" });
  });

  it("finds the selected pair via the transport or the nominated pair, relay or not", () => {
    const viaTransport = readTransport(
      report([
        { id: "T", type: "transport", selectedCandidatePairId: "P" },
        { id: "P", type: "candidate-pair", localCandidateId: "L", availableIncomingBitrate: 250_000, currentRoundTripTime: 0.03 },
        { id: "L", type: "local-candidate", candidateType: "relay", address: "192.0.2.1" },
      ]),
    );
    expect(viaTransport).toEqual({ availableIncomingBitrate: 250_000, rttMs: 30, relayed: true });
    const nominated = readTransport(
      report([
        { id: "P0", type: "candidate-pair", state: "failed", localCandidateId: "L" },
        { id: "P", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "L" },
        { id: "L", type: "local-candidate", candidateType: "srflx" },
      ]),
    );
    expect(nominated).toEqual({ availableIncomingBitrate: null, rttMs: null, relayed: false });
    expect(readTransport(report([]))).toEqual({ availableIncomingBitrate: null, rttMs: null, relayed: null });
  });
});

describe("CallTelemetry", () => {
  const sample = {
    rttMs: 40,
    sendLossPercent: 1,
    receivedPackets: 90,
    lostPackets: 10,
    jitterMs: 12,
    framesDecoded: 48,
    framesDropped: 2,
    limitedMs: { cpu: 2_000, bandwidth: 0 },
    relayed: true,
    audioMimeType: "audio/opus",
    videoMimeType: "video/VP8",
  };

  it("summarises an interval and starts the next one", () => {
    const telemetry = new CallTelemetry(1_000);
    telemetry.record(sample);
    telemetry.record({ ...sample, rttMs: 80, sendLossPercent: 3 });
    telemetry.setAudioOnly(true, 5_000);
    telemetry.countReconnect();
    const first = telemetry.report("p1", 11_000, false);
    expect(first).toEqual({
      participantId: "p1",
      final: false,
      intervalMs: 10_000,
      durationMs: 10_000,
      rttMs: { avg: 60, max: 80 },
      lossPercent: { send: 2, receive: 10 },
      jitterMs: 12,
      framesDecoded: 96,
      framesDropped: 4,
      limitedMs: { cpu: 4_000, bandwidth: 0 },
      audioOnlyMs: 6_000,
      relayed: true,
      audioCodec: "opus",
      videoCodec: "VP8",
      reconnects: 1,
    });
    telemetry.setAudioOnly(false, 12_000);
    const second = telemetry.report("p1", 21_000, true);
    expect(second).toMatchObject({
      final: true,
      intervalMs: 10_000,
      durationMs: 20_000,
      rttMs: { avg: null, max: null },
      lossPercent: { send: null, receive: null },
      framesDecoded: 0,
      audioOnlyMs: 1_000,
      reconnects: 1,
      audioCodec: "opus",
    });
  });
});
