// Per-user rate limits.
//
// Fixed windows in SQLite. The table, not a map in the isolate, is the source of truth: a Durable
// Object can be evicted between two requests, and an in-memory-only limiter would hand the caller a
// fresh budget every time that happened. Module state is also shared by every instance of the class
// in one isolate, so a cache in front of this would leak one object's counters into another's.
//
// Fixed windows, not a sliding log: the worst case is twice the budget across a window boundary,
// which is the right trade for limits whose purpose is stopping a runaway client rather than metering.

import { RATE_LIMITS } from "../shared/protocol.js";
import { allow, firstRow, refuse, type Ctx, type Outcome } from "./context.js";
import { hashId, logEvent } from "./logs.js";

export type Bucket = "messages" | "uploads" | "search" | "agent";

interface Budget {
  readonly limit: number;
  readonly windowMs: number;
}

const BUDGETS: Readonly<Record<Bucket, Budget>> = {
  messages: { limit: RATE_LIMITS.messagesPerMinute, windowMs: 60_000 },
  uploads: { limit: RATE_LIMITS.uploadsPerHour, windowMs: 60 * 60 * 1000 },
  search: { limit: RATE_LIMITS.searchesPerMinute, windowMs: 60_000 },
  agent: { limit: RATE_LIMITS.agentRequestsPerHour, windowMs: 60 * 60 * 1000 },
};

type WindowRow = { window_start: number; count: number };

/**
 * Charges one unit to a budget.
 *
 * Returns a `rate_limited` refusal carrying `retryAfter` in seconds, which the HTTP layer turns into
 * a 429 with a `Retry-After` header and the socket layer into an `error` event.
 */
export function consume(ctx: Ctx, userId: string, bucket: Bucket): Outcome<void> {
  const { limit, windowMs } = BUDGETS[bucket];
  const now = ctx.now();

  const current: WindowRow = firstRow<WindowRow>(
    ctx,
    `SELECT window_start, count FROM rate_limits WHERE user_id = ? AND bucket = ?`,
    userId,
    bucket,
  ) ?? { window_start: now, count: 0 };

  const fresh = now - current.window_start >= windowMs;
  const windowStart = fresh ? now : current.window_start;
  const count = fresh ? 1 : current.count + 1;

  if (count > limit) {
    const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
    logEvent("chat.rate_limited", { bucket, user: hashId(userId), retryAfter });
    return refuse("rate_limited", `Too many requests. Try again in ${retryAfter}s.`, retryAfter);
  }

  ctx.sql.exec(
    `INSERT INTO rate_limits (user_id, bucket, window_start, count) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, bucket) DO UPDATE SET
       window_start = excluded.window_start,
       count        = excluded.count`,
    userId,
    bucket,
    windowStart,
    count,
  );
  return allow(undefined);
}

/**
 * The per-conversation typing throttle.
 *
 * In memory only and deliberately not persisted: a typing indicator is cosmetic, it is never replayed
 * after a restart, and a write per keystroke would be the most expensive thing in the object.
 */
const typingSeen = new Map<string, number>();

export function typingAllowed(userId: string, channelId: string, now: number, throttleMs: number): boolean {
  // Both halves are restricted character sets, so the colon cannot make two keys collide.
  const key = `${userId}:${channelId}`;
  const last = typingSeen.get(key);
  if (last !== undefined && now - last < throttleMs) return false;
  typingSeen.set(key, now);
  // Bounded: one entry per conversation somebody is typing in. The sweep only runs once the map is
  // larger than any real deployment reaches.
  if (typingSeen.size > 4096) {
    for (const [entry, at] of typingSeen) {
      if (now - at > throttleMs * 10) typingSeen.delete(entry);
    }
  }
  return true;
}
