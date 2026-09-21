// What every Durable Object module is handed instead of the object itself.
//
// The modules under `src/do/` are plain functions over this context: they read and write SQLite,
// and they reach live sockets only through {@link Broadcaster}. That keeps the class in
// `src/workspace.ts` to wiring (constructor, `fetch`, the hibernation callbacks, `alarm`) and lets a
// test drive any one of them directly.

import type { ChatEnv } from "../env.js";
import type { ChannelId, ErrorCode, ServerEvent, UserId } from "../shared/protocol.js";

/** Delivery to live sockets. Implemented by the Durable Object, which owns `ctx.getWebSockets`. */
export interface Broadcaster {
  /** One event to every live socket tagged with one of these user ids. */
  toUsers(userIds: Iterable<UserId>, event: ServerEvent): void;
  /**
   * One event to the sockets of the channel's current recipients.
   *
   * Recipients are derived from membership at send time, never from a cached list, so a message in a
   * private channel cannot reach somebody who has just been removed from it. A socket receives the
   * event when it subscribed to that channel or subscribed to nothing at all.
   */
  toChannel(channelId: ChannelId, event: ServerEvent, options?: { readonly exclude?: UserId }): void;
  /** One event to every live socket. Only presence uses it. */
  toAll(event: ServerEvent): void;
  /** Recomputes each user's {@link import("../shared/protocol.js").BadgeSummary} and pushes it. */
  badges(userIds: Iterable<UserId>): void;
  /** Users with at least one socket inside the presence window. */
  online(): readonly UserId[];
  /** True while this user has a socket inside the presence window. */
  isOnline(userId: UserId): boolean;
}

export interface Ctx {
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
  readonly env: ChatEnv;
  readonly bus: Broadcaster;
  /** Injectable so a test can pin time; production passes `Date.now`. */
  now(): number;
  /** Makes sure the pending-upload sweep alarm is set. Idempotent. */
  armSweep(): Promise<void>;
}

/** `?, ?, ?` for an `IN (...)` list. Bound parameters only; never interpolated values. */
export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** The first row of a query, or null. `SqlStorage.exec` has no "at most one row" mode. */
export function firstRow<T extends Record<string, SqlStorageValue>>(
  ctx: Ctx,
  query: string,
  ...params: unknown[]
): T | null {
  return ctx.sql.exec<T>(query, ...params).toArray()[0] ?? null;
}

/**
 * `UPDATE <table> SET <every defined column> WHERE <where>`, in one statement.
 *
 * The routes that patch a row all take a partial body, so "write the fields that are present" is the
 * same shape three times over. One statement rather than one per column, so a row is never seen
 * half-updated and no transaction is needed. `undefined` means "absent"; an explicit `null` is
 * written, which is how a nullable column is cleared. The table, the predicate and the column names
 * are literals from the calling module -- SQLite cannot bind an identifier -- and every value is
 * bound.
 */
export function updateRow(
  ctx: Ctx,
  table: string,
  where: string,
  whereParams: readonly unknown[],
  columns: Readonly<Record<string, unknown>>,
): void {
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [column, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  if (assignments.length === 0) return;
  ctx.sql.exec(
    `UPDATE ${table} SET ${assignments.join(", ")} WHERE ${where}`,
    ...values,
    ...whereParams,
  );
}

/**
 * The single number a `COUNT`, `MAX` or one-column query answers with.
 *
 * `MAX` over no rows is a row holding NULL rather than no row at all, so both cases collapse to
 * {@link fallback} here instead of at every call site.
 */
export function scalar(ctx: Ctx, query: string, params: readonly unknown[] = [], fallback = 0): number {
  const row = firstRow<{ value: number | null }>(ctx, query, ...params);
  return row?.value ?? fallback;
}

/**
 * A handler result that carries the error code the HTTP layer and the WebSocket layer both need.
 *
 * `validate.ts`'s `Result` covers "the input is malformed"; this covers "the request is well formed
 * and still refused", which is the shape every authorization check returns.
 */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string; readonly retryAfter?: number };

export function allow<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

export function refuse<T>(code: ErrorCode, message: string, retryAfter?: number): Outcome<T> {
  return { ok: false, code, message, ...(retryAfter === undefined ? {} : { retryAfter }) };
}
