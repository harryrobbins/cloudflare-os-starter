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
