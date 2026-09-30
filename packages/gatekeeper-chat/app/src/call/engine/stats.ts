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
