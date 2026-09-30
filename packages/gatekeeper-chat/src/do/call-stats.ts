// Call-quality telemetry (docs/plans/chat-video.md, "Quality phase 1").
//
// `POST /calls/:callId/stats` takes a participant's aggregate summary -- RTT, loss, jitter, frames,
// encoder limitation, relay, codecs -- and turns it into one `chat.call.stats` log line. Nothing is
// stored: the Workers observability pipeline is where "Alice's calls are always bad" gets answered.
//
// The rules:
//
//   * **Own participants only.** The row must be the caller's and belong to `callId`; a foreign
//     participant is a logged denial (403, like every other call route), an unknown one is 404.
//   * **The final report may trail `leave`.** A participant that left up to CALL_STATS_GRACE_MS ago
//     is still accepted; after that the report is refused 404. No channel-access recheck, as with
//     leave: somebody just removed from a private channel may still report the call they were in.
//   * **Its own budget.** MAX_CALL_STATS_PER_MINUTE per participant, not charged to callSignals, so
//     telemetry can neither starve signalling nor be starved by it.
//   * **Redacted by construction.** Ids are hashed; the line is built field by field from the parsed
//     report, so whatever else a client sends never reaches the log.

import type { CallStatsReport, OkResponse } from "../shared/protocol.js";
import { allow, firstRow, refuse, type Ctx, type Outcome } from "./context.js";
import { consume, pruneScoped } from "./limits.js";
import { hashId, logDenial, logEvent } from "./logs.js";
import type { UserRow } from "./rows.js";

/** How long after leaving a participant's (final) report is still accepted. */
export const CALL_STATS_GRACE_MS = 2 * 60 * 1000;

type StatsParticipant = { id: string; call_id: string; user_id: string; left_at: number | null };

const round = (value: number): number => Math.round(value);
/** Percent and similar small values keep one decimal place. */
const round1 = (value: number): number => Math.round(value * 10) / 10;
const orUndefined = (value: number | null, shape: (n: number) => number): number | undefined =>
  value === null ? undefined : shape(value);

/**
 * A scoped budget row per participant ever reported; windows that can no longer refuse are dead
 * weight. Run by the alarm's call expiry rather than per report.
 */
export function pruneCallStatsBudgets(ctx: Ctx): void {
  pruneScoped(ctx, "callStats", CALL_STATS_GRACE_MS);
}

/** `POST /calls/:callId/stats`. The router has already answered 503 when calls are off. */
export function postCallStats(
  ctx: Ctx,
  user: UserRow,
  callId: string,
  report: CallStatsReport,
): Outcome<OkResponse> {
  const row = firstRow<StatsParticipant>(
    ctx,
    `SELECT id, call_id, user_id, left_at FROM call_participants WHERE id = ?`,
    report.participantId,
  );
  if (row === null) return refuse("not_found", "No such participant.");
  if (row.call_id !== callId || row.user_id !== user.id) {
    logDenial("call_stats", { call: hashId(callId), user: hashId(user.id) });
    return refuse("forbidden", "That participant is not yours.");
  }
  const now = ctx.now();
  if (row.left_at !== null && now - row.left_at > CALL_STATS_GRACE_MS) {
    return refuse("not_found", "You are no longer in this call.");
  }
  // Charged only once ownership is proven, so nobody can mint budget rows for arbitrary ids.
  const budget = consume(ctx, user.id, "callStats", row.id);
  if (!budget.ok) return budget;
  logEvent("chat.call.stats", {
    call: hashId(callId),
    user: hashId(user.id),
    participant: hashId(row.id),
    final: report.final,
    intervalMs: round(report.intervalMs),
    durationMs: round(report.durationMs),
    rttAvgMs: orUndefined(report.rttMs.avg, round),
    rttMaxMs: orUndefined(report.rttMs.max, round),
    lossSendPct: orUndefined(report.lossPercent.send, round1),
    lossReceivePct: orUndefined(report.lossPercent.receive, round1),
    jitterMs: orUndefined(report.jitterMs, round1),
    framesDecoded: report.framesDecoded,
    framesDropped: report.framesDropped,
    limitedCpuMs: round(report.limitedMs.cpu),
    limitedBandwidthMs: round(report.limitedMs.bandwidth),
    audioOnlyMs: round(report.audioOnlyMs),
    relayed: report.relayed ?? undefined,
    audioCodec: report.audioCodec ?? undefined,
    videoCodec: report.videoCodec ?? undefined,
    reconnects: report.reconnects,
  });
  return allow({ ok: true });
}
