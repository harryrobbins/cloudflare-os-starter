// A fixed-window rate limit per principal and bucket, persisted in the object so an eviction does
// not reset it. Chat's approach (packages/gatekeeper-chat/src/do/limits.ts), reduced to one budget.

import type { Ctx } from "./context.js";

/** Recognised by src/serve.ts and turned into a 429. Internal: not part of the contract. */
export const RATE_LIMIT_PREFIX = "search: rate limited: ";

export const SEARCH_BUDGET = { limit: 60, windowMs: 60_000 } as const;

/** Throws a rate-limit error when the principal has used this window's budget. */
export function consume(ctx: Ctx, principal: string, bucket: string, budget = SEARCH_BUDGET): void {
  const now = ctx.now();
  const row = ctx.sql
    .exec<{ window_start: number; count: number }>(
      `SELECT window_start, count FROM rate_limits WHERE principal = ? AND bucket = ?`,
      principal,
      bucket,
    )
    .toArray()[0];
  if (row === undefined || now - row.window_start >= budget.windowMs) {
    ctx.sql.exec(
      `INSERT INTO rate_limits (principal, bucket, window_start, count) VALUES (?, ?, ?, 1)
       ON CONFLICT (principal, bucket) DO UPDATE SET window_start = excluded.window_start, count = 1`,
      principal,
      bucket,
      now,
    );
    return;
  }
  if (row.count >= budget.limit) {
    const retryAfter = Math.max(1, Math.ceil((row.window_start + budget.windowMs - now) / 1000));
    throw new Error(`${RATE_LIMIT_PREFIX}${retryAfter}`);
  }
  ctx.sql.exec(`UPDATE rate_limits SET count = count + 1 WHERE principal = ? AND bucket = ?`, principal, bucket);
}
