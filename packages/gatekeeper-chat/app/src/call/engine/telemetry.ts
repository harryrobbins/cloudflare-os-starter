// Accumulates the per-participant call-quality summary (`CallStatsReport`) the engine POSTs every
// minute and on leave. Numbers and codec names only: no addresses, SDP or device labels ever reach
// it, because the engine only hands it the scalars below.

import type { CallStatsReport, ParticipantId } from "../../contract.js";
import { codecName } from "./sdp.js";

/** How often a report goes out while in a call. */
export const CALL_STATS_INTERVAL_MS = 60_000;

/** One quality sample (every `QUALITY_SAMPLE_MS`); counters are deltas since the previous sample. */
export interface TelemetrySample {
  readonly rttMs: number | null;
  readonly sendLossPercent: number | null;
  readonly receivedPackets: number;
  readonly lostPackets: number;
  readonly jitterMs: number | null;
  readonly framesDecoded: number;
  readonly framesDropped: number;
  readonly limitedMs: { readonly cpu: number; readonly bandwidth: number };
  readonly relayed: boolean | null;
  /** Full mime types (`audio/opus`); reduced to names here. */
  readonly audioMimeType: string | null;
  readonly videoMimeType: string | null;
}

function average(sum: number, count: number): number | null {
  return count > 0 ? round(sum / count) : null;
}

function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export class CallTelemetry {
  private intervalStart: number;
  private rttSum = 0;
  private rttCount = 0;
  private rttMax: number | null = null;
  private sendLossSum = 0;
  private sendLossCount = 0;
  private received = 0;
  private lost = 0;
  private jitterSum = 0;
  private jitterCount = 0;
  private decoded = 0;
  private dropped = 0;
  private cpuMs = 0;
  private bandwidthMs = 0;
  private audioOnlyMs = 0;
  private audioOnlySince: number | null = null;
  private relayed: boolean | null = null;
  private audioCodec: string | null = null;
  private videoCodec: string | null = null;
  private reconnects = 0;

  constructor(private readonly startedAt: number) {
    this.intervalStart = startedAt;
  }

  record(sample: TelemetrySample): void {
    if (sample.rttMs !== null) {
      this.rttSum += sample.rttMs;
      this.rttCount += 1;
      this.rttMax = Math.max(this.rttMax ?? 0, sample.rttMs);
    }
    if (sample.sendLossPercent !== null) {
      this.sendLossSum += sample.sendLossPercent;
      this.sendLossCount += 1;
    }
    this.received += Math.max(0, sample.receivedPackets);
    this.lost += Math.max(0, sample.lostPackets);
    if (sample.jitterMs !== null) {
      this.jitterSum += sample.jitterMs;
      this.jitterCount += 1;
    }
    this.decoded += Math.max(0, sample.framesDecoded);
    this.dropped += Math.max(0, sample.framesDropped);
    this.cpuMs += Math.max(0, sample.limitedMs.cpu);
    this.bandwidthMs += Math.max(0, sample.limitedMs.bandwidth);
    if (sample.relayed !== null) this.relayed = sample.relayed;
    if (sample.audioMimeType) this.audioCodec = codecName(sample.audioMimeType);
    if (sample.videoMimeType) this.videoCodec = codecName(sample.videoMimeType);
  }

  setAudioOnly(on: boolean, now: number): void {
    if (on && this.audioOnlySince === null) this.audioOnlySince = now;
    if (!on && this.audioOnlySince !== null) {
      this.audioOnlyMs += now - this.audioOnlySince;
      this.audioOnlySince = null;
    }
  }

  countReconnect(): void {
    this.reconnects += 1;
  }

  /** The report for the interval since the previous one; starts a new interval. */
  report(participantId: ParticipantId, now: number, final: boolean): CallStatsReport {
    let audioOnlyMs = this.audioOnlyMs;
    if (this.audioOnlySince !== null) {
      audioOnlyMs += now - this.audioOnlySince;
      this.audioOnlySince = now;
    }
    const packets = this.received + this.lost;
    const report: CallStatsReport = {
      participantId,
      final,
      intervalMs: Math.max(0, now - this.intervalStart),
      durationMs: Math.max(0, now - this.startedAt),
      rttMs: { avg: average(this.rttSum, this.rttCount), max: this.rttMax === null ? null : round(this.rttMax) },
      lossPercent: {
        send: average(this.sendLossSum, this.sendLossCount),
        receive: packets > 0 ? round((this.lost * 100) / packets, 2) : null,
      },
      jitterMs: average(this.jitterSum, this.jitterCount),
      framesDecoded: this.decoded,
      framesDropped: this.dropped,
      limitedMs: { cpu: Math.round(this.cpuMs), bandwidth: Math.round(this.bandwidthMs) },
      audioOnlyMs: Math.round(audioOnlyMs),
      relayed: this.relayed,
      audioCodec: this.audioCodec,
      videoCodec: this.videoCodec,
      reconnects: this.reconnects,
    };
    this.intervalStart = now;
    this.rttSum = 0;
    this.rttCount = 0;
    this.rttMax = null;
    this.sendLossSum = 0;
    this.sendLossCount = 0;
    this.received = 0;
    this.lost = 0;
    this.jitterSum = 0;
    this.jitterCount = 0;
    this.decoded = 0;
    this.dropped = 0;
    this.cpuMs = 0;
    this.bandwidthMs = 0;
    this.audioOnlyMs = 0;
    return report;
  }
}
