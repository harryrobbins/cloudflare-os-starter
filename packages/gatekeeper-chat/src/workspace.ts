// `ChatWorkspace`: the one SQLite-backed Durable Object, reached as `idFromName("main")`.
//
// This file is wiring only. It runs the migrations, builds the {@link Ctx} every module under
// `src/do/` is handed, and forwards the four things the runtime calls: `fetch`, the two hibernation
// callbacks, and `alarm` -- plus the one RPC method the Worker's `ChatAgentReply` entrypoint calls
// when the Workshop answers a question. The behaviour lives in `src/do/`, one file per
// responsibility.

import { DurableObject } from "cloudflare:workers";

import type { SubmitExternalMessageInput } from "@gadgets/workshop-shared/external-message-gateway";

import type { ChatEnv } from "./env.js";
import { errorResponse, unauthenticated } from "./http.js";
import { runMigrations } from "./migrations.js";
import { deliverAgentReply, runAgentOutbox, type AgentGateway } from "./do/agent.js";
import type { Broadcaster, Ctx } from "./do/context.js";
import { sweepPending } from "./do/files.js";
import { logEvent } from "./do/logs.js";
import { route } from "./do/router.js";
import { ensureSearchStarted, runSearchOutbox, searchSyncStatus } from "./do/search-sync.js";
import { createBroadcaster, handleFrame, readAttachment, socketClosed } from "./do/sockets.js";
import { touchUser } from "./do/users.js";
import { IDENTITY_HEADER, type ChatIdentity, type SearchSyncStatus } from "./shared/protocol.js";
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
  #outbox: Promise<unknown> = Promise.resolve();
  #searchRun: Promise<unknown> = Promise.resolve();
  /** The alarm wake a search write asked for, awaited before the response leaves. */
  #searchKick: Promise<void> | null = null;
  #searchChecked = false;

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
      armSweep: () => this.#wakeAt(Date.now() + SWEEP_INTERVAL_MS),
      wakeAt: (at) => this.#wakeAt(at),
      agentGateway: workshopGateway(ctx, env),
      searchChanged: () => this.#kickSearch(),
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const identity = readIdentity(request);
    if (identity === null) {
      // Only this deployment's Worker can reach the object, and it always sets the header. Reaching
      // here means a wiring mistake, not a user error.
      return unauthenticated("The workspace was reached without a verified identity.");
    }
    try {
      this.#startSearchOnce();
      const user = touchUser(this.#ctx, identity);
      const response = await route(this.#ctx, this.ctx, request, new URL(request.url), user, identity);
      await this.#settleSearchKick();
      return response;
    } catch (error) {
      // Anything reaching here is a bug in this object, not a client mistake. The client still gets
      // the one error envelope the contract defines: the runtime's own 500 carries a stack trace, and
      // "never return a stack trace" is in chat.md's security checklist. The cause is logged instead,
      // with no request body and no identity in it.
      logEvent("chat.error", {
        method: request.method,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      });
      return errorResponse("internal", "Team chat could not handle that request.");
    }
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

  /**
   * The one alarm, shared by the pending-upload sweep, the agent outbox and the omni-search outbox.
   * Each part says when it next needs to run; the earliest is set. A throw leaves the runtime to retry
   * the alarm, which is what a failed agent outbox write should get -- the search part never throws,
   * so a search outage cannot cause that retry.
   */
  override async alarm(): Promise<void> {
    const remaining = await sweepPending(this.#ctx);
    const agentNext = await this.#runOutbox();
    const searchNext = await this.#runSearch();
    const wakes = [remaining > 0 ? Date.now() + SWEEP_INTERVAL_MS : null, agentNext, searchNext].filter(
      (at): at is number => at !== null,
    );
    if (wakes.length > 0) await this.#wakeAt(Math.min(...wakes));
  }

  /** Test and operations seam: runs the sweep now instead of waiting for the alarm. */
  async sweepUploads(): Promise<number> {
    return sweepPending(this.#ctx);
  }

  /** Test and operations seam: runs the agent outbox now instead of waiting for the alarm. */
  async runAgentOutbox(): Promise<number | null> {
    return this.#runOutbox();
  }

  /** Test and operations seam: flushes the omni-search outbox now instead of waiting for the alarm. */
  async runSearchOutbox(): Promise<number | null> {
    return this.#runSearch();
  }

  /** Operations seam: the omni-search outbox and backfill state, as `GET /api/admin/search-reindex`. */
  searchStatus(): SearchSyncStatus {
    return searchSyncStatus(this.#ctx);
  }

  /**
   * One search flush at a time, for the same reason as the agent outbox below: two overlapping runs
   * would push the same rows twice. Never rejects -- the alarm it shares must not fail because of
   * search -- so an unexpected bug is logged and retried in a minute.
   */
  #runSearch(): Promise<number | null> {
    const run = this.#searchRun.then(() => runSearchOutbox(this.#ctx));
    this.#searchRun = run.catch(() => undefined);
    return run.catch((error: unknown) => {
      logEvent("chat.search.error", {
        message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      });
      return Date.now() + 60_000;
    });
  }

  /** The first request an instance serves with SEARCH bound starts the backfill if it never ran. */
  #startSearchOnce(): void {
    if (this.#searchChecked) return;
    this.#searchChecked = true;
    if (ensureSearchStarted(this.#ctx)) this.#kickSearch();
  }

  /**
   * Asks for the alarm now, without making the write that queued search work wait for it. The wake
   * is awaited once the handler is done ({@link #settleSearchKick}) so it is durable before the
   * response leaves; a failure to set it is harmless, because the next write or alarm sets it again.
   */
  #kickSearch(): void {
    if (this.env.SEARCH === undefined || this.#searchKick !== null) return;
    const kick: Promise<void> = this.#wakeAt(Date.now())
      .catch(() => undefined)
      .finally(() => {
        if (this.#searchKick === kick) this.#searchKick = null;
      });
    this.#searchKick = kick;
  }

  async #settleSearchKick(): Promise<void> {
    if (this.#searchKick !== null) await this.#searchKick;
  }

  /**
   * One outbox run at a time. The alarm is the only production caller and the runtime never overlaps
   * two alarms, but the test seam above can land mid-run, and two overlapping runs would each hand the
   * same question to the Workshop.
   */
  #runOutbox(): Promise<number | null> {
    const run = this.#outbox.then(() => runAgentOutbox(this.#ctx));
    this.#outbox = run.catch(() => undefined);
    return run;
  }

  /**
   * The Workshop's answer to one question, from `ChatAgentReply.onGadgetResponse`. At least once:
   * posting is idempotent per question, and a throw asks the Workshop to deliver it again.
   */
  async deliverAgentReply(
    requestId: string,
    messageKey: string,
    text: string,
  ): Promise<"posted" | "duplicate" | "ignored"> {
    return deliverAgentReply(this.#ctx, requestId, messageKey, text);
  }

  /** Test seam: the schema version actually recorded in this object's database. */
  schemaVersion(): number {
    return (
      this.ctx.storage.sql
        .exec<{ value: number }>(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
        .toArray()[0]?.value ?? 0
    );
  }

  /**
   * Moves the alarm earlier, never later. Inside `alarm()` the runtime reports no alarm (the one
   * running has been consumed) unless something set a new one during the run, so the handler's own
   * re-arm and a wake requested mid-run both land.
   */
  async #wakeAt(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current !== null && current <= at) return;
    await this.ctx.storage.setAlarm(at);
  }
}

/**
 * The Workshop's `ExternalMessageGateway`, as the agent outbox calls it, or null when this deployment
 * has no `WORKSHOP_GATEWAY` binding.
 *
 * The reply target is a `ChatAgentReply` stub from `ctx.exports`: a service stub of this Worker with
 * the question's ids in its props, which the Workshop's Overseer `dup()`s and keeps in its own storage
 * until the answer is ready -- that is what `allow_irrevocable_stub_storage` is for. The stub minted
 * here is only lent to the call, so it is disposed as soon as the call settles; the Overseer's copy is
 * the Overseer's to dispose.
 */
function workshopGateway(state: DurableObjectState, env: ChatEnv): AgentGateway | null {
  const gateway = env.WORKSHOP_GATEWAY;
  if (gateway === undefined) return null;
  return {
    async submit(submission) {
      const target = state.exports.ChatAgentReply({
        props: {
          workspaceId: state.id.toString(),
          requestId: submission.requestId,
          messageKey: submission.messageKey,
        },
      });
      try {
        return await gateway.submitExternalMessage({
          callerEmail: submission.callerEmail,
          gadgetKey: submission.gadgetKey,
          chatKey: submission.chatKey,
          messageKey: submission.messageKey,
          gadgetTitle: submission.gadgetTitle,
          prompt: submission.prompt,
          // A service stub, not an `RpcTarget`: the contract's type describes what the Workshop calls
          // (`onGadgetResponse`), which `ChatAgentReply` implements, and only a service stub can be
          // stored durably on the other side.
          chatGatewayRpcTarget: target as unknown as SubmitExternalMessageInput["chatGatewayRpcTarget"],
        });
      } finally {
        (target as Partial<Disposable>)[Symbol.dispose]?.();
      }
    },
  };
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
  const { id, email, name, workshopAccount } = parsed;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof email !== "string" || email.length === 0) return null;
  return {
    id,
    email,
    ...(typeof name === "string" && name.length > 0 ? { name } : {}),
    ...(typeof workshopAccount === "string" && workshopAccount.length > 0 ? { workshopAccount } : {}),
  };
}
