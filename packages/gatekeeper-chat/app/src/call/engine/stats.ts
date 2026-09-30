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

/**
 * A receiver's latest audio level (0..1) from its synchronization sources: synchronous and free,
 * where `getStats()` would build a whole report. Null when no source has reported a level (nothing
 * received for ten seconds, or no audio-level header extension).
 */
export function receiverAudioLevel(receiver: Pick<RTCRtpReceiver, "getSynchronizationSources">): number | null {
  let level: number | null = null;
  for (const source of receiver.getSynchronizationSources()) {
    if (typeof source.audioLevel === "number") level = Math.max(level ?? 0, source.audioLevel);
  }
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
  const entries: Entry[] = [];
  each(report, (entry) => entries.push(entry));
  return outboundOf(index(report), entries);
}

/** The outbound sample over one sender's `outbound-rtp` entries and their `remote-inbound-rtp`. */
function outboundOf(byId: Map<string, Entry>, entries: readonly Entry[]): OutboundSample {
  let limitation = null as Limitation | null;
  let limitedSeconds = null as { cpu: number; bandwidth: number } | null;
  let rtt: number | null = null;
  let loss: number | null = null;
  let mimeType: string | null = null;
  for (const entry of entries) {
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
  }
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
    if (sample === null && entry.type === "inbound-rtp") sample = inboundOf(byId, entry);
  });
  return sample;
}

function inboundOf(byId: Map<string, Entry>, entry: Entry): InboundSample {
  const jitter = num(entry.jitter);
  return {
    // packetsLost can go negative with duplicates; clamp.
    packetsLost: Math.max(0, num(entry.packetsLost) ?? 0),
    packetsReceived: num(entry.packetsReceived) ?? 0,
    jitterMs: jitter === null ? null : jitter * 1000,
    framesPerSecond: num(entry.framesPerSecond),
    framesDecoded: num(entry.framesDecoded) ?? 0,
    framesDropped: num(entry.framesDropped) ?? 0,
    mimeType: codecOf(byId, entry),
  };
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
  return transportOf(report, index(report));
}

function transportOf(report: RTCStatsReport, byId: Map<string, Entry>): TransportSample {
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

/**
 * Every sender, every receiver and the transport from one `RTCPeerConnection.getStats()`, instead of
 * a report per sender and receiver. Senders and receivers are keyed by `mid` and by track id
 * (`inbound-rtp.trackIdentifier`, or the `media-source` an `outbound-rtp` names), since not every
 * browser reports `mid`; look them up with {@link sampleFor}.
 */
export interface ConnectionSample {
  readonly transport: TransportSample;
  readonly outbound: ReadonlyMap<string, OutboundSample>;
  readonly inbound: ReadonlyMap<string, InboundSample>;
}

export function readConnection(report: RTCStatsReport): ConnectionSample {
  const byId = index(report);
  const outboundGroups = new Map<string, Entry[]>();
  const keysOfOutbound = new Map<string, string[]>();
  const inbound = new Map<string, InboundSample>();
  const keysFor = (entry: Entry, trackId: unknown): string[] =>
    [entry.mid, trackId].filter((key): key is string => typeof key === "string" && key.length > 0);
  each(report, (entry) => {
    if (entry.type === "outbound-rtp") {
      const source = typeof entry.mediaSourceId === "string" ? byId.get(entry.mediaSourceId) : undefined;
      const keys = keysFor(entry, source?.trackIdentifier);
      if (typeof entry.id === "string") keysOfOutbound.set(entry.id, keys);
      for (const key of keys) outboundGroups.set(key, [...(outboundGroups.get(key) ?? []), entry]);
    } else if (entry.type === "inbound-rtp") {
      const sample = inboundOf(byId, entry);
      for (const key of keysFor(entry, entry.trackIdentifier)) if (!inbound.has(key)) inbound.set(key, sample);
    }
  });
  // A remote-inbound-rtp belongs to the outbound-rtp it names.
  each(report, (entry) => {
    if (entry.type !== "remote-inbound-rtp" || typeof entry.localId !== "string") return;
    for (const key of keysOfOutbound.get(entry.localId) ?? []) outboundGroups.get(key)?.push(entry);
  });
  const outbound = new Map<string, OutboundSample>();
  for (const [key, entries] of outboundGroups) outbound.set(key, outboundOf(byId, entries));
  return { transport: transportOf(report, byId), outbound, inbound };
}

/** The sample for a transceiver: by its mid, else by its track's id. */
export function sampleFor<T>(
  samples: ReadonlyMap<string, T>,
  mid: string | null,
  track: { readonly id: string } | null | undefined,
): T | null {
  return (mid !== null ? samples.get(mid) : undefined) ?? (track ? samples.get(track.id) : undefined) ?? null;
}
