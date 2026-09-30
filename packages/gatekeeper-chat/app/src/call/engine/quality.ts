// Connection-quality classification and the two adaptation state machines of quality phase 1
// (chat-video.md, "Quality roadmap"): shedding our own simulcast layers under CPU limits, and
// stepping remote video down (layer c, then audio-only) when our downlink cannot carry it. Pure; the
// engine samples stats every `QUALITY_SAMPLE_MS` and feeds them here.

import type { CallSimulcastRid } from "../../contract.js";
import { CAMERA_SIMULCAST_ENCODINGS } from "./media.js";
import type { ConnectionQuality, QualityLimitation } from "./types.js";

/** How often the engine reads `getStats()` for quality and adaptation. */
export const QUALITY_SAMPLE_MS = 2_000;

/**
 * Thresholds, each "good below the first, fair below the second, poor from the second". Loss is a
 * percentage over the last {@link LOSS_WINDOW_SAMPLES} samples; jitter and RTT in milliseconds; frame
 * rate as a fraction of what the pulled layer should deliver (good at or above the first).
 */
export const QUALITY_THRESHOLDS = Object.freeze({
  lossPercent: [2, 8] as const,
  jitterMs: [40, 100] as const,
  rttMs: [250, 500] as const,
  frameRateRatio: [0.6, 0.3] as const,
});

/** Samples (of `QUALITY_SAMPLE_MS`) the per-track loss window spans: 6 s. */
export const LOSS_WINDOW_SAMPLES = 3;

/** Send side: consecutive samples before a limitation counts as sustained (and CPU sheds a layer). */
export const SEND_SUSTAIN_SAMPLES = 3;
/** Send side: `none` for this long re-enables one layer; the next one needs another full wait. */
export const SEND_RESTORE_MS = 10_000;

/**
 * Downlink: aggregate receive loss at or above `poorLossPercent` is a poor sample, and so is an
 * `availableIncomingBitrate` below `poorBitrate` when loss is at least `goodLossPercent` too. Loss
 * below `goodLossPercent` is a good sample whatever the estimate says.
 *
 * The estimate only ever corroborates loss. On the real SFU it saws between ~300 kbps and 1.5 Mbps on a
 * healthy link, restarts near zero whenever video resumes (it took ~50 s to pass 300 kbps), and only
 * measures what is flowing, so with every camera on layer c it levelled off near 450 kbps: as a
 * condition of its own it paused video with no loss at all, and as a condition for "good" it kept a
 * recovered link on layer c for good. A probe that the link cannot carry shows up as loss, and
 * {@link DownlinkAdaptation} backs off.
 */
export const DOWNLINK_THRESHOLDS = Object.freeze({
  poorLossPercent: 10,
  poorBitrate: 300_000,
  goodLossPercent: 3,
});
/** Downlink: poor this long steps down one mode (normal -> low -> audio-only). */
export const DOWNLINK_POOR_MS = 6_000;
/** Downlink: good this long steps back up one mode (audio-only -> low -> normal). */
export const DOWNLINK_RECOVER_MS = 15_000;
/**
 * Downlink: stepping down again this soon after stepping up means the link still cannot carry it,
 * so the next recovery waits twice as long (up to `DOWNLINK_RECOVER_MAX_MS`). Audio-only has no
 * bitrate estimate and little loss, so without this a constrained link re-probes video every ~20 s,
 * and each probe freezes video and loses packets for several seconds. Holding the step for this long
 * restores the normal wait.
 */
export const DOWNLINK_RELAPSE_MS = 30_000;
export const DOWNLINK_RECOVER_MAX_MS = 120_000;

const RANK: Record<ConnectionQuality, number> = { unknown: -1, good: 0, fair: 1, poor: 2 };

/** The worst known quality; `unknown` only when nothing is known. */
export function worstQuality(values: Iterable<ConnectionQuality>): ConnectionQuality {
  let worst: ConnectionQuality = "unknown";
  for (const value of values) if (RANK[value] > RANK[worst]) worst = value;
  return worst;
}

function band(value: number | null, [fair, poor]: readonly [number, number]): ConnectionQuality {
  if (value === null || !Number.isFinite(value)) return "unknown";
  if (value < fair) return "good";
  if (value < poor) return "fair";
  return "poor";
}

export interface ReceiveMeasures {
  readonly lossPercent: number | null;
  readonly jitterMs: number | null;
  readonly framesPerSecond: number | null;
  /** Null when frame rate says nothing (audio, screen share, camera off). */
  readonly expectedFps: number | null;
}

/** One pulled track's quality. `unknown` until packets have arrived in the window. */
export function classifyReceive(measures: ReceiveMeasures): ConnectionQuality {
  const parts: ConnectionQuality[] = [band(measures.lossPercent, QUALITY_THRESHOLDS.lossPercent)];
  if (parts[0] === "unknown") return "unknown";
  parts.push(band(measures.jitterMs, QUALITY_THRESHOLDS.jitterMs));
  if (measures.expectedFps !== null && measures.expectedFps > 0 && measures.framesPerSecond !== null) {
    const ratio = measures.framesPerSecond / measures.expectedFps;
    const [good, fair] = QUALITY_THRESHOLDS.frameRateRatio;
    parts.push(ratio >= good ? "good" : ratio >= fair ? "fair" : "poor");
  }
  return worstQuality(parts);
}

export interface UplinkMeasures {
  readonly rttMs: number | null;
  /** From `remote-inbound-rtp.fractionLost`, as a percentage. */
  readonly lossPercent: number | null;
  readonly limitation: QualityLimitation;
}

/** Our own uplink: RTT and SFU-reported loss; a sustained encoder limitation caps it at fair. */
export function classifyUplink(measures: UplinkMeasures): ConnectionQuality {
  const parts = [band(measures.rttMs, QUALITY_THRESHOLDS.rttMs), band(measures.lossPercent, QUALITY_THRESHOLDS.lossPercent)];
  if (measures.limitation !== "none") parts.push("fair");
  return worstQuality(parts);
}

/** What the pulled layer should deliver, from our own simulcast encodings (a 30, b 24, c 15 fps). */
export function expectedFramerate(rid: CallSimulcastRid | null): number {
  const encoding = CAMERA_SIMULCAST_ENCODINGS.find((candidate) => candidate.rid === rid) ?? CAMERA_SIMULCAST_ENCODINGS[0];
  return encoding?.maxFramerate ?? 30;
}

/** Packet loss over the last few samples of one inbound stream's cumulative counters. */
export class LossWindow {
  private readonly samples: { lost: number; received: number }[] = [{ lost: 0, received: 0 }];

  constructor(private readonly size = LOSS_WINDOW_SAMPLES) {}

  /** Adds a cumulative sample; returns loss % over the window, or null when no packets moved. */
  push(lost: number, received: number): number | null {
    const last = this.samples.at(-1)!;
    // Counters only go up; a reset (new SSRC) restarts the window.
    if (lost < last.lost || received < last.received) this.samples.splice(0, this.samples.length, { lost: 0, received: 0 });
    this.samples.push({ lost, received });
    while (this.samples.length > this.size + 1) this.samples.shift();
    const first = this.samples[0]!;
    const lostDelta = Math.max(0, lost - first.lost);
    const receivedDelta = Math.max(0, received - first.received);
    const total = lostDelta + receivedDelta;
    return total > 0 ? (lostDelta * 100) / total : null;
  }
}

export type DownlinkVerdict = "good" | "fair" | "poor";

export function downlinkVerdict(lossPercent: number | null, availableIncomingBitrate: number | null): DownlinkVerdict {
  const t = DOWNLINK_THRESHOLDS;
  const lossy = lossPercent !== null && lossPercent >= t.goodLossPercent;
  if ((lossPercent !== null && lossPercent >= t.poorLossPercent) || (lossy && availableIncomingBitrate !== null && availableIncomingBitrate < t.poorBitrate)) {
    return "poor";
  }
  if (!lossy) return "good";
  return "fair";
}

/**
 * `normal`: tiles pick layers by size. `low`: every remote camera is pulled at layer c. `audio-only`:
 * remote cameras are paused (screen shares and audio continue). Steps one mode at a time each way.
 */
export type DownlinkMode = "normal" | "low" | "audio-only";

export class DownlinkAdaptation {
  mode: DownlinkMode = "normal";
  /** Good time needed for the next step up; doubles on each relapse. */
  recoverMs = DOWNLINK_RECOVER_MS;
  private poorSince: number | null = null;
  private goodSince: number | null = null;
  private steppedUpAt: number | null = null;

  sample(now: number, verdict: DownlinkVerdict): DownlinkMode {
    if (this.steppedUpAt !== null && now - this.steppedUpAt >= DOWNLINK_RELAPSE_MS) {
      this.steppedUpAt = null;
      this.recoverMs = DOWNLINK_RECOVER_MS;
    }
    if (verdict === "poor") {
      this.goodSince = null;
      this.poorSince ??= now;
      if (this.mode !== "audio-only" && now - this.poorSince >= DOWNLINK_POOR_MS) {
        this.mode = this.mode === "normal" ? "low" : "audio-only";
        this.poorSince = now;
        if (this.steppedUpAt !== null) this.recoverMs = Math.min(this.recoverMs * 2, DOWNLINK_RECOVER_MAX_MS);
        this.steppedUpAt = null;
      }
    } else if (verdict === "good") {
      this.poorSince = null;
      this.goodSince ??= now;
      if (this.mode !== "normal" && now - this.goodSince >= this.recoverMs) {
        this.mode = this.mode === "audio-only" ? "low" : "normal";
        this.goodSince = now;
        this.steppedUpAt = now;
      }
    } else {
      this.poorSince = null;
      this.goodSince = null;
    }
    return this.mode;
  }
}

export type SendAction = "shed" | "restore";

/**
 * Watches the camera's `qualityLimitationReason`. `limitation` is the last reason seen for
 * {@link SEND_SUSTAIN_SAMPLES} samples in a row. Every run of that many `cpu` samples asks to shed a
 * layer; `none` for {@link SEND_RESTORE_MS} asks to restore one. `bandwidth` only reports: the
 * browser's own bandwidth estimator already stops the layers it cannot send.
 */
export class SendAdaptation {
  limitation: QualityLimitation = "none";
  private streak: { reason: QualityLimitation; count: number } | null = null;
  private cpuRun = 0;
  private noneSince: number | null = null;

  sample(now: number, reason: QualityLimitation): SendAction | null {
    if (this.streak?.reason === reason) this.streak.count += 1;
    else this.streak = { reason, count: 1 };
    if (this.streak.count >= SEND_SUSTAIN_SAMPLES) this.limitation = reason;

    if (reason === "cpu") {
      this.noneSince = null;
      this.cpuRun += 1;
      if (this.cpuRun >= SEND_SUSTAIN_SAMPLES) {
        this.cpuRun = 0;
        return "shed";
      }
      return null;
    }
    this.cpuRun = 0;
    if (reason === "none") {
      this.noneSince ??= now;
      if (now - this.noneSince >= SEND_RESTORE_MS) {
        this.noneSince = now;
        return "restore";
      }
    } else {
      this.noneSince = null;
    }
    return null;
  }
}

/** Scale steps for a single-encoding camera under CPU pressure. */
export const SINGLE_ENCODING_SCALES = [1, 2, 4] as const;

/**
 * Applies one shed/restore step to camera send encodings in place; false when nothing can change.
 * Simulcast: shed deactivates the best active layer (a, then b; never c), restore re-activates the
 * worst inactive one (b, then a). Single encoding: `scaleResolutionDownBy` 1 -> 2 -> 4 and back.
 */
export function stepSendEncodings(encodings: RTCRtpEncodingParameters[], simulcast: boolean, action: SendAction): boolean {
  if (encodings.length === 0) return false;
  if (simulcast && encodings.length > 1) {
    const sheddable = encodings.slice(0, -1);
    if (action === "shed") {
      const target = sheddable.find((encoding) => encoding.active !== false);
      if (!target) return false;
      target.active = false;
      return true;
    }
    const target = [...sheddable].reverse().find((encoding) => encoding.active === false);
    if (!target) return false;
    target.active = true;
    return true;
  }
  const encoding = encodings[0]!;
  const current = encoding.scaleResolutionDownBy ?? 1;
  const index = SINGLE_ENCODING_SCALES.findIndex((scale) => scale >= current);
  const at = index < 0 ? SINGLE_ENCODING_SCALES.length - 1 : index;
  const next = action === "shed" ? SINGLE_ENCODING_SCALES[at + 1] : at > 0 ? SINGLE_ENCODING_SCALES[at - 1] : undefined;
  if (next === undefined || next === current) return false;
  encoding.scaleResolutionDownBy = next;
  return true;
}

/** Layers we send: active simulcast encodings, or 1 for a single-encoding camera. */
export function activeLayers(encodings: readonly RTCRtpEncodingParameters[], simulcast: boolean): number {
  if (!simulcast || encodings.length <= 1) return encodings.length === 0 ? 0 : 1;
  return encodings.filter((encoding) => encoding.active !== false).length;
}
