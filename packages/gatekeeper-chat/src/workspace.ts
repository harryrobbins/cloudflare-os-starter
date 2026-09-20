// `ChatWorkspace`: the one SQLite-backed Durable Object, reached as `idFromName("main")`.
//
// This file is wiring only. It runs the migrations, builds the {@link Ctx} every module under
// `src/do/` is handed, and forwards the four things the runtime calls: `fetch`, the two hibernation
// callbacks, and `alarm`. The behaviour lives in `src/do/`, one file per responsibility.

import { DurableObject } from "cloudflare:workers";

import type { ChatEnv } from "./env.js";
import { unauthenticated } from "./http.js";
import { runMigrations } from "./migrations.js";
import type { Broadcaster, Ctx } from "./do/context.js";
import { sweepPending } from "./do/files.js";
import { route } from "./do/router.js";
import { createBroadcaster, handleFrame, readAttachment, socketClosed } from "./do/sockets.js";
import { touchUser } from "./do/users.js";
import { IDENTITY_HEADER, type ChatIdentity } from "./shared/protocol.js";
import { isRecord } from "./shared/validate.js";

/**
 * How often the pending-upload sweep runs while anything is waiting.
 *
 * Shorter than the one-hour TTL so an abandoned object is deleted soon after it expires rather than
 * an hour later, and long enough that an idle object with no pending uploads never wakes up: the
 * alarm is only armed when an upload is written and is re-armed only while pending rows remain.
 */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

export class ChatWorkspace extends DurableObject<ChatEnv> {
  readonly #bus: Broadcaster;
  readonly #ctx: Ctx;

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    // Synchronous and inside the constructor: every later handler may assume the schema exists, and
    // SQLite access in a DO is synchronous, so no gate is needed to order it before the first fetch.
    runMigrations(ctx.storage);

    // The broadcaster needs the context and the context holds the broadcaster, so the cycle is broken
    // with a getter: by the time any fan-out happens, the field is assigned.
    this.#bus = createBroadcaster(ctx, () => this.#ctx);
    this.#ctx = {
      sql: ctx.storage.sql,
      storage: ctx.storage,
      env,
      bus: this.#bus,
      now: () => Date.now(),
      armSweep: () => this.#armSweep(),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const identity = readIdentity(request);
    if (identity === null) {
      // Only this deployment's Worker can reach the object, and it always sets the header. Reaching
      // here means a wiring mistake, not a user error.
      return unauthenticated("The workspace was reached without a verified identity.");
    }
    const user = touchUser(this.#ctx, identity);
    return route(this.#ctx, this.ctx, request, new URL(request.url), user);
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    handleFrame(this.#ctx, ws, message);
  }

  override webSocketClose(ws: WebSocket): void {
    socketClosed(this.#ctx, readAttachment(ws)?.userId ?? null);
  }

  override webSocketError(ws: WebSocket): void {
    socketClosed(this.#ctx, readAttachment(ws)?.userId ?? null);
  }

  override async alarm(): Promise<void> {
    const remaining = await sweepPending(this.#ctx);
    if (remaining > 0) await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }

  /** Test and operations seam: runs the sweep now instead of waiting for the alarm. */
  async sweepUploads(): Promise<number> {
    return sweepPending(this.#ctx);
  }

  /** Test seam: the schema version actually recorded in this object's database. */
  schemaVersion(): number {
    return (
      this.ctx.storage.sql
        .exec<{ value: number }>(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
        .toArray()[0]?.value ?? 0
    );
  }

  async #armSweep(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }
}

/** Reads and narrows the identity header the Worker set. */
export function readIdentity(request: Request): ChatIdentity | null {
  const raw = request.headers.get(IDENTITY_HEADER);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { id, email, name } = parsed;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof email !== "string" || email.length === 0) return null;
  return { id, email, ...(typeof name === "string" && name.length > 0 ? { name } : {}) };
}
