// Tiny readers over `getStats()` reports. Each returns null when the browser has no such entry yet.

type StatsSource = { getStats(): Promise<RTCStatsReport> };

function each(report: RTCStatsReport, visit: (entry: Record<string, unknown>) => void): void {
  report.forEach((entry: unknown) => visit(entry as Record<string, unknown>));
}

/** Sum of `outbound-rtp bytesSent` over every encoding of one sender (simulcast has three). */
export async function bytesSent(sender: StatsSource): Promise<number> {
  const report = await sender.getStats();
  let total = 0;
  each(report, (entry) => {
    if (entry.type === "outbound-rtp" && typeof entry.bytesSent === "number") total += entry.bytesSent;
  });
  return total;
}

/** `inbound-rtp audioLevel` (0..1) of one receiver. */
export async function inboundAudioLevel(receiver: StatsSource): Promise<number | null> {
  const report = await receiver.getStats();
  let level: number | null = null;
  each(report, (entry) => {
    if (entry.type === "inbound-rtp" && entry.kind === "audio" && typeof entry.audioLevel === "number") {
      level = entry.audioLevel;
    }
  });
  return level;
}

/** The local microphone's `media-source audioLevel` (0..1), read from its sender. */
export async function mediaSourceAudioLevel(sender: StatsSource): Promise<number | null> {
  const report = await sender.getStats();
  let level: number | null = null;
  each(report, (entry) => {
    if (entry.type === "media-source" && entry.kind === "audio" && typeof entry.audioLevel === "number") {
      level = entry.audioLevel;
    }
  });
  return level;
}

// -----------------------------------------------------------------------------------------------
// Quality phase 1 readers. Each takes one report and keeps only numbers and codec names: never
// addresses, ports, candidate ids or anything else that identifies a network.

type Entry = Record<string, unknown>;

function index(report: RTCStatsReport): Map<string, Entry> {
  const byId = new Map<string, Entry>();
  each(report, (entry) => {
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  });
  return byId;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function codecOf(byId: Map<string, Entry>, entry: Entry): string | null {
  const codec = typeof entry.codecId === "string" ? byId.get(entry.codecId) : undefined;
  return typeof codec?.mimeType === "string" ? codec.mimeType : null;
}

const LIMITATION_RANK = { none: 0, bandwidth: 1, cpu: 2 } as const;
type Limitation = keyof typeof LIMITATION_RANK;

export interface OutboundSample {
  /** The worst `qualityLimitationReason` over the sender's encodings; null when not reported (Firefox). */
  readonly limitation: Limitation | null;
  /** Cumulative `qualityLimitationDurations` in seconds (max over encodings), when reported. */
  readonly limitedSeconds: { readonly cpu: number; readonly bandwidth: number } | null;
  /** `remote-inbound-rtp.roundTripTime`, milliseconds. */
  readonly rttMs: number | null;
  /** `remote-inbound-rtp.fractionLost`, as a percentage. */
  readonly lossPercent: number | null;
  /** Full mime type, e.g. `video/VP8`. */
  readonly mimeType: string | null;
}

/** One sender's report: limitation, SFU-reported loss and RTT, codec. */
export function readOutbound(report: RTCStatsReport): OutboundSample {
  const byId = index(report);
  let limitation: Limitation | null = null;
  let limitedSeconds: { cpu: number; bandwidth: number } | null = null;
  let rtt: number | null = null;
  let loss: number | null = null;
  let mimeType: string | null = null;
  each(report, (entry) => {
    if (entry.type === "outbound-rtp") {
      const reason = entry.qualityLimitationReason;
      if (typeof reason === "string") {
        const known: Limitation = reason === "cpu" || reason === "bandwidth" ? reason : "none";
        if (limitation === null || LIMITATION_RANK[known] > LIMITATION_RANK[limitation]) limitation = known;
      }
      const durations = entry.qualityLimitationDurations as Record<string, unknown> | undefined;
      if (durations && typeof durations === "object") {
        limitedSeconds = {
          cpu: Math.max(limitedSeconds?.cpu ?? 0, num(durations.cpu) ?? 0),
          bandwidth: Math.max(limitedSeconds?.bandwidth ?? 0, num(durations.bandwidth) ?? 0),
        };
      }
      mimeType ??= codecOf(byId, entry);
    } else if (entry.type === "remote-inbound-rtp") {
      const roundTrip = num(entry.roundTripTime);
      if (roundTrip !== null) rtt = Math.max(rtt ?? 0, roundTrip * 1000);
      const fraction = num(entry.fractionLost);
      if (fraction !== null) loss = Math.max(loss ?? 0, fraction * 100);
    }
  });
  return { limitation, limitedSeconds, rttMs: rtt, lossPercent: loss, mimeType };
}

export interface InboundSample {
  readonly packetsLost: number;
  readonly packetsReceived: number;
  readonly jitterMs: number | null;
  readonly framesPerSecond: number | null;
  readonly framesDecoded: number;
  readonly framesDropped: number;
  readonly mimeType: string | null;
}

/** One receiver's `inbound-rtp`; null before the browser has one. */
export function readInbound(report: RTCStatsReport): InboundSample | null {
  const byId = index(report);
  let sample: InboundSample | null = null;
  each(report, (entry) => {
    if (sample !== null || entry.type !== "inbound-rtp") return;
    const jitter = num(entry.jitter);
    sample = {
      // packetsLost can go negative with duplicates; clamp.
      packetsLost: Math.max(0, num(entry.packetsLost) ?? 0),
      packetsReceived: num(entry.packetsReceived) ?? 0,
      jitterMs: jitter === null ? null : jitter * 1000,
      framesPerSecond: num(entry.framesPerSecond),
      framesDecoded: num(entry.framesDecoded) ?? 0,
      framesDropped: num(entry.framesDropped) ?? 0,
      mimeType: codecOf(byId, entry),
    };
  });
  return sample;
}

export interface TransportSample {
  /** Selected pair's `availableIncomingBitrate` (rarely reported by browsers), bits/s. */
  readonly availableIncomingBitrate: number | null;
  /** Selected pair's `currentRoundTripTime`, milliseconds. */
  readonly rttMs: number | null;
  /** The selected pair's local candidate is a TURN relay; null when unknown. */
  readonly relayed: boolean | null;
}

/** The whole connection's report: the selected candidate pair. */
export function readTransport(report: RTCStatsReport): TransportSample {
  const byId = index(report);
  let pair: Entry | undefined;
  each(report, (entry) => {
    if (entry.type === "transport" && typeof entry.selectedCandidatePairId === "string") {
      pair ??= byId.get(entry.selectedCandidatePairId);
    }
  });
  if (!pair) {
    each(report, (entry) => {
      if (pair || entry.type !== "candidate-pair") return;
      if (entry.selected === true || (entry.nominated === true && entry.state === "succeeded")) pair = entry;
    });
  }
  if (!pair) return { availableIncomingBitrate: null, rttMs: null, relayed: null };
  const local = typeof pair.localCandidateId === "string" ? byId.get(pair.localCandidateId) : undefined;
  const rtt = num(pair.currentRoundTripTime);
  return {
    availableIncomingBitrate: num(pair.availableIncomingBitrate),
    rttMs: rtt === null ? null : rtt * 1000,
    relayed: typeof local?.candidateType === "string" ? local.candidateType === "relay" : null,
  };
}
