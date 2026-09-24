// SyncClient: optimistic mutations, push/pull, and rebase over server state (plan §6).
//
// Lifecycle of one mutation:
//   mutate → applied to the view at once, queued {id, name, args}
//   push   → outcome per mutation:
//              applied   stays in the replay queue until a pull's lastMutationId covers it
//              skipped   (already processed) likewise; its effect shows via pull
//              pending   leaves the replay queue, joins `awaitingApproval`
//              rejected/conflict leaves the replay queue, `rejected` event; the view shows the
//                        server version in place of the guess
//   pull   → patch applied to server state; mutations with id ≤ lastMutationId dropped; the rest
//            replayed; subscribers notified once.
//
// Nothing is persisted. Pending mutations live in memory only; `hasUnsyncedChanges` tells a page
// to warn before unload (see `guardUnload`).

import type {
  CommandName,
  PrincipalRef,
  PullRequest,
  PullResponse,
  PushOutcome,
  PushRequest,
  PushResponse,
} from "@records/contracts";

import { asTransportError, MutationError, SyncTransportError } from "./errors.js";
import { describeProjectMutation, prepareProjectArgs, projectAppliedIn, projectMutators } from "./mutators/projects.js";
import { RecordStore, type ReplayStep, type StoreListener } from "./store.js";
import type { MutationContext, MutatorArgs, MutatorDefs, ReadTx } from "./types.js";

// ---------------------------------------------------------------------------------------------
// Public types

export type ApprovalStatus = {
  actionId: number;
  status: "pending" | "approved" | "rejected" | "expired";
  message?: string;
};

export interface SyncTransport {
  push(request: PushRequest): Promise<PushResponse>;
  pull(request: PullRequest): Promise<PullResponse>;
  /**
   * Optional: current status of approval actions (from `pending` outcomes). Without it, an
   * awaiting entry retires when a pull shows its change, on timeout, or on dismissal.
   */
  approvals?(actionIds: number[]): Promise<ApprovalStatus[]>;
}

export type MutationResult =
  /** Applied, and a pull has delivered the server's version. */
  | { status: "confirmed" }
  /** The server had already processed it (a retried push); the pull shows the outcome. */
  | { status: "processed" }
  | { status: "pending"; actionId: number }
  | { status: "rejected"; code: string; message: string }
  | { status: "conflict"; code: "revision_conflict" | "workflow_conflict"; message: string; currentRevision?: number };

export type MutationHandle<A = unknown> = {
  /** Client mutation id (monotonic per client). */
  id: number;
  /** The args as queued and pushed (creates carry their client-chosen `id`). */
  args: A;
  /** Set when the local prediction already failed; the server still decides. */
  likelyToFail: MutationError | null;
  /** Resolves once the server's decision is known. Never rejects. */
  result: Promise<MutationResult>;
};

export type PendingMutation = {
  id: number;
  name: string;
  args: unknown;
  label: string;
  /** queued: not sent yet; sending: in a push in flight; sent: applied, waiting for the pull. */
  state: "queued" | "sending" | "sent";
  likelyToFail: MutationError | null;
};

export type AwaitingApproval = {
  mutationId: number;
  actionId: number;
  name: string;
  args: unknown;
  label: string;
  since: number;
  /** The approval service said approved; the change is on its way through a pull. */
  approved: boolean;
};

export type RejectedEvent = {
  mutationId: number;
  name: string;
  args: unknown;
  label: string;
  status: "rejected" | "conflict";
  code: string;
  message: string;
  currentRevision?: number;
  /** push: the server refused it; approval: an approver refused it or it expired; local: the
   * request itself was refused (never processed by the server). */
  source: "push" | "approval" | "local";
};

export type ApprovalResolvedEvent = {
  entry: AwaitingApproval;
  resolution: "applied" | "rejected" | "expired" | "timeout" | "dismissed";
  message?: string;
};

export type SyncStatus = {
  cookie: number | null;
  /** Mutations the server has not acknowledged yet: lost if the page closes. */
  unsynced: number;
  /** Mutations still replayed over server state (unsynced + applied-awaiting-pull). */
  pending: number;
  awaitingApproval: number;
  pushing: boolean;
  pulling: boolean;
  /** Pushes stopped after a non-retryable error; resumes on the next mutate or `retry()`. */
  blocked: boolean;
  lastError: SyncTransportError | null;
};

export type SyncEvents = {
  rejected: RejectedEvent;
  awaiting: readonly AwaitingApproval[];
  approval: ApprovalResolvedEvent;
  status: SyncStatus;
};

export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type SyncClientOptions<M extends MutatorDefs> = {
  transport: SyncTransport;
  /** The signed-in principal; used for local predictions (createdBy, author, …) only. */
  principal: PrincipalRef;
  mutators?: M;
  /** Normalises args before queuing (must make them deterministic: ids, plain JSON). */
  prepare?: (name: string, args: unknown, env: { randomUUID: () => string }) => unknown;
  /** Whether a mutation that went to approval now shows in server state. */
  appliedIn?: (name: string, server: ReadTx, args: any) => boolean;
  describe?: (name: string, args: any, view: ReadTx) => string;
  /** Shared by tabs that share a login; defaults to a fresh id. */
  clientGroupId?: string;
  /**
   * Defaults to a fresh id per page load, which is what the protocol needs: mutation ids restart at
   * 1 per client. Never pass an id used by an earlier page load.
   */
  clientId?: string;
  /** Subscribes to pokes; returns an unsubscribe. `pokeSource(...)` builds one. */
  onPoke?: (handler: (head: number) => void) => (() => void) | void;
  /** Debounce before a push, so rapid edits share a request. Default 20 ms. */
  pushDelayMs?: number;
  /** Pull at least this often even without pokes. Default 30 s; 0 disables. */
  safetyPullIntervalMs?: number;
  /** Poll `transport.approvals` this often while approvals are awaited. Default 5 s. */
  approvalCheckIntervalMs?: number;
  /** Retire an awaiting approval after this long. Default 15 min. */
  approvalTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxBatch?: number;
  timers?: Timers;
  now?: () => number;
  randomUUID?: () => string;
  random?: () => number;
};

type NS<K> = K extends `${infer N}.${string}` ? N : never;
type Op<K, N extends string> = K extends `${N}.${infer O}` ? O : never;
/** Args as callers pass them: creates may omit `id` (prepare fills it). */
type CallerArgs<A> = A extends { id: string } ? Omit<A, "id"> & { id?: string } : A;
/** `client.mutate.projects.createIssue(args)` for a mutator named `projects.createIssue`. */
export type MutateApi<M extends MutatorDefs> = {
  [N in NS<keyof M & string>]: {
    [K in keyof M & string as Op<K, N>]: (args: CallerArgs<MutatorArgs<M[K]>>) => MutationHandle<MutatorArgs<M[K]>>;
  };
};

// ---------------------------------------------------------------------------------------------
// Internals

type Entry = {
  id: number;
  name: string;
  args: unknown;
  timestamp: number;
  label: string;
  inFlight: boolean;
  outcome: PushOutcome | null;
  /** A pull's lastMutationId covers it. */
  confirmed: boolean;
  /** Out of the replay queue because of its outcome (pending/rejected/conflict). */
  dropped: boolean;
  likelyToFail: MutationError | null;
  settled: boolean;
  resolve: (r: MutationResult) => void;
};

type AwaitingInternal = AwaitingApproval & { retireAfterPull: number | null };

function newId(randomUUID: () => string): string {
  return randomUUID().replaceAll("-", "").slice(0, 32);
}

function toMutationError(err: unknown): MutationError {
  if (err instanceof MutationError) return err;
  return new MutationError("validation_failed", err instanceof Error ? err.message : String(err));
}

const defaultTimers: Timers = {
  // Looked up at call time so test fake timers apply.
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

// ---------------------------------------------------------------------------------------------

export class SyncClient<M extends MutatorDefs = typeof projectMutators> {
  readonly clientGroupId: string;
  readonly clientId: string;
  /** The optimistic view. Read with get/scan; subscribe for batched change notifications. */
  readonly store = new RecordStore();
  readonly mutate: MutateApi<M>;

  private readonly transport: SyncTransport;
  private readonly principal: PrincipalRef;
  private readonly mutators: M;
  private readonly prepare: NonNullable<SyncClientOptions<M>["prepare"]>;
  private readonly appliedIn: NonNullable<SyncClientOptions<M>["appliedIn"]>;
  private readonly describe: NonNullable<SyncClientOptions<M>["describe"]>;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly randomUUID: () => string;
  private readonly random: () => number;
  private readonly opts: Required<
    Pick<
      SyncClientOptions<M>,
      "pushDelayMs" | "safetyPullIntervalMs" | "approvalCheckIntervalMs" | "approvalTimeoutMs" | "retryBaseMs" | "retryMaxMs" | "maxBatch"
    >
  >;
  private readonly onPoke: SyncClientOptions<M>["onPoke"];

  private entries: Entry[] = [];
  private nextMutationId = 1;
  private cookieValue: number | null = null;
  private lastMutationId = 0;
  private awaiting: AwaitingInternal[] = [];
  private listeners: { [K in keyof SyncEvents]: Set<(e: SyncEvents[K]) => void> } = {
    rejected: new Set(),
    awaiting: new Set(),
    approval: new Set(),
    status: new Set(),
  };

  private started = false;
  private closed = false;
  private unsubscribePoke: (() => void) | null = null;

  private pushTimer: unknown = null;
  private pushRetryTimer: unknown = null;
  private pushInFlight: Promise<boolean> | null = null;
  private pushAttempts = 0;
  private pushBlocked = false;
  /** After a request-level validation failure, push one at a time up to this id. */
  private isolateUntilId = 0;

  private pulling: Promise<void> | null = null;
  private pullWanted = false;
  private pullAttempts = 0;
  private pullRetryTimer: unknown = null;
  private safetyTimer: unknown = null;
  private pullsStarted = 0;

  private approvalTimer: unknown = null;
  private lastError: SyncTransportError | null = null;
  private lastStatusJson = "";

  constructor(options: SyncClientOptions<M>) {
    this.transport = options.transport;
    this.principal = options.principal;
    this.mutators = (options.mutators ?? projectMutators) as M;
    this.prepare = options.prepare ?? prepareProjectArgs;
    this.appliedIn = options.appliedIn ?? projectAppliedIn;
    this.describe = options.describe ?? describeProjectMutation;
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? (() => Date.now());
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.random = options.random ?? Math.random;
    this.clientGroupId = options.clientGroupId ?? newId(this.randomUUID);
    this.clientId = options.clientId ?? newId(this.randomUUID);
    this.onPoke = options.onPoke;
    this.opts = {
      pushDelayMs: options.pushDelayMs ?? 20,
      safetyPullIntervalMs: options.safetyPullIntervalMs ?? 30_000,
      approvalCheckIntervalMs: options.approvalCheckIntervalMs ?? 5_000,
      approvalTimeoutMs: options.approvalTimeoutMs ?? 15 * 60_000,
      retryBaseMs: options.retryBaseMs ?? 500,
      retryMaxMs: options.retryMaxMs ?? 30_000,
      maxBatch: Math.min(100, Math.max(1, options.maxBatch ?? 100)),
    };
    this.mutate = this.buildMutateApi();
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  /** Subscribes to pokes, does the first pull, and starts the safety pull. */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    const unsub = this.onPoke?.((head) => this.poke(head));
    if (typeof unsub === "function") this.unsubscribePoke = unsub;
    await this.pull();
    if (this.unpushed().length) this.schedulePush(0);
  }

  /** Stops timers and poke delivery. In-memory unsynced mutations are abandoned. */
  close(): void {
    this.closed = true;
    this.unsubscribePoke?.();
    this.unsubscribePoke = null;
    for (const t of [this.pushTimer, this.pushRetryTimer, this.pullRetryTimer, this.safetyTimer, this.approvalTimer]) {
      if (t !== null) this.timers.clearTimeout(t);
    }
    this.pushTimer = this.pushRetryTimer = this.pullRetryTimer = this.safetyTimer = this.approvalTimer = null;
  }

  // ---- reads --------------------------------------------------------------------------------

  get<T = unknown>(key: string): T | undefined {
    return this.store.get<T>(key);
  }
  scan<T = unknown>(prefix: string): Array<[string, T]> {
    return this.store.scan<T>(prefix);
  }
  /** Fires once per batch with the keys whose visible value changed. */
  subscribe(listener: StoreListener): () => void {
    return this.store.subscribe(listener);
  }

  get cookie(): number | null {
    return this.cookieValue;
  }

  /** True while a mutation has not been acknowledged by the server (it would be lost on unload). */
  get hasUnsyncedChanges(): boolean {
    return this.entries.some((e) => this.isUnsynced(e));
  }

  /** Mutations still shown as local guesses, in order. */
  pending(): PendingMutation[] {
    return this.live().map((e) => ({
      id: e.id,
      name: e.name,
      args: e.args,
      label: e.label,
      state: e.outcome ? "sent" : e.inFlight ? "sending" : "queued",
      likelyToFail: e.likelyToFail,
    }));
  }

  get awaitingApproval(): readonly AwaitingApproval[] {
    return this.awaiting.map(({ retireAfterPull: _r, ...a }) => a);
  }

  status(): SyncStatus {
    return {
      cookie: this.cookieValue,
      unsynced: this.entries.filter((e) => this.isUnsynced(e)).length,
      pending: this.live().length,
      awaitingApproval: this.awaiting.length,
      pushing: this.pushInFlight !== null,
      pulling: this.pulling !== null,
      blocked: this.pushBlocked,
      lastError: this.lastError,
    };
  }

  on<K extends keyof SyncEvents>(event: K, listener: (e: SyncEvents[K]) => void): () => void {
    const set = this.listeners[event] as Set<(e: SyncEvents[K]) => void>;
    set.add(listener);
    return () => set.delete(listener);
  }

  // ---- mutations ----------------------------------------------------------------------------

  /** Untyped entry point; `mutate.<module>.<op>(args)` is the typed one. */
  mutateByName(name: string, args: unknown): MutationHandle {
    if (this.closed) throw new Error("SyncClient is closed");
    const fn = this.mutators[name];
    if (!fn) throw new Error(`Unknown mutator ${name}`);
    const prepared = this.prepare(name, args, { randomUUID: this.randomUUID });
    let resolve!: (r: MutationResult) => void;
    const result = new Promise<MutationResult>((r) => (resolve = r));
    const entry: Entry = {
      id: this.nextMutationId++,
      name,
      args: prepared,
      timestamp: this.now(),
      label: "",
      inFlight: false,
      outcome: null,
      confirmed: false,
      dropped: false,
      likelyToFail: null,
      settled: false,
      resolve,
    };
    entry.label = this.describe(name, prepared, this.store);
    try {
      this.store.applyLocal(this.stepFor(entry));
    } catch (err) {
      entry.likelyToFail = toMutationError(err);
    }
    this.entries.push(entry);
    this.pushBlocked = false;
    this.emitStatus();
    this.schedulePush(this.opts.pushDelayMs);
    return {
      id: entry.id,
      args: prepared,
      get likelyToFail() {
        return entry.likelyToFail;
      },
      result,
    };
  }

  /** Pushes everything queued now (skipping the debounce and any backoff) and waits for it. */
  async flush(): Promise<void> {
    this.clearPushTimers();
    this.pushBlocked = false;
    while (!this.closed) {
      if (this.pushInFlight) {
        await this.pushInFlight;
        continue;
      }
      if (!this.unpushed().length || this.pushBlocked) break;
      const ok = await this.pushOnce();
      if (!ok) break;
    }
    if (this.pulling) await this.pulling;
  }

  /** flush() then pull(). */
  async sync(): Promise<void> {
    await this.flush();
    await this.pull();
  }

  /** Clears a push block after a non-retryable error and tries again. */
  retry(): Promise<void> {
    return this.sync();
  }

  /** Removes an awaiting-approval entry from the list (the server's decision is unaffected). */
  dismissApproval(mutationId: number): void {
    const entry = this.awaiting.find((a) => a.mutationId === mutationId);
    if (entry) this.retireApproval(entry, "dismissed");
  }

  // ---- pokes and pulls ----------------------------------------------------------------------

  /** A poke says the datastore head is now `head`; pull if that is newer than what we hold. */
  poke(head: number): void {
    if (this.closed) return;
    if (this.cookieValue === null || head > this.cookieValue) void this.pull();
  }

  /** Pulls now. Concurrent calls coalesce into one follow-up pull. Never rejects. */
  pull(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pulling) {
      this.pullWanted = true;
      return this.pulling;
    }
    this.pulling = (async () => {
      try {
        do {
          this.pullWanted = false;
          await this.pullOnce();
        } while (this.pullWanted && !this.closed);
      } finally {
        this.pulling = null;
        this.scheduleSafetyPull();
        this.emitStatus();
      }
    })();
    this.emitStatus();
    return this.pulling;
  }

  private async pullOnce(): Promise<void> {
    if (this.pullRetryTimer !== null) {
      this.timers.clearTimeout(this.pullRetryTimer);
      this.pullRetryTimer = null;
    }
    const pullNumber = ++this.pullsStarted;
    let res: PullResponse;
    try {
      res = await this.transport.pull({ clientGroupId: this.clientGroupId, cookie: this.cookieValue });
    } catch (err) {
      const e = asTransportError(err);
      this.lastError = e;
      if (e.retryable && !this.closed) {
        this.pullAttempts++;
        this.pullRetryTimer = this.timers.setTimeout(() => {
          this.pullRetryTimer = null;
          void this.pull();
        }, this.backoff(this.pullAttempts));
      }
      return;
    }
    this.pullAttempts = 0;
    this.lastError = null;
    this.applyPull(res, pullNumber);
  }

  /** Applies a pull response. Responses older than the current cookie are ignored. */
  private applyPull(res: PullResponse, pullNumber: number): void {
    if (this.closed) return;
    if (this.cookieValue !== null && res.cookie < this.cookieValue) return;
    this.store.applyServerPatch(res.patch);
    this.cookieValue = res.cookie;

    const lmid = res.lastMutationIdChanges[this.clientId];
    if (typeof lmid === "number" && lmid > this.lastMutationId && lmid < this.nextMutationId) {
      this.lastMutationId = lmid;
    }
    for (const e of this.entries) {
      if (e.id > this.lastMutationId || e.confirmed) continue;
      e.confirmed = true;
      if (e.outcome?.status === "applied") this.settle(e, { status: "confirmed" });
      else if (e.outcome?.status === "skipped") this.settle(e, { status: "processed" });
      else if (!e.outcome && !e.inFlight) this.settle(e, { status: "processed" });
    }
    this.gc();
    this.rebase();
    this.checkAwaiting(pullNumber);
  }

  private scheduleSafetyPull(): void {
    if (this.safetyTimer !== null) this.timers.clearTimeout(this.safetyTimer);
    this.safetyTimer = null;
    if (!this.started || this.closed || this.opts.safetyPullIntervalMs <= 0) return;
    this.safetyTimer = this.timers.setTimeout(() => {
      this.safetyTimer = null;
      void this.pull();
    }, this.opts.safetyPullIntervalMs);
  }

  // ---- push ---------------------------------------------------------------------------------

  private unpushed(): Entry[] {
    return this.entries.filter((e) => !e.outcome && !e.confirmed && !e.dropped && !e.inFlight);
  }

  private schedulePush(delay: number): void {
    if (this.closed || this.pushBlocked) return;
    if (this.pushInFlight || this.pushRetryTimer !== null || this.pushTimer !== null) return;
    this.pushTimer = this.timers.setTimeout(() => {
      this.pushTimer = null;
      void this.pushLoop();
    }, delay);
  }

  private clearPushTimers(): void {
    if (this.pushTimer !== null) this.timers.clearTimeout(this.pushTimer);
    if (this.pushRetryTimer !== null) this.timers.clearTimeout(this.pushRetryTimer);
    this.pushTimer = this.pushRetryTimer = null;
  }

  private async pushLoop(): Promise<void> {
    while (!this.closed && !this.pushBlocked && this.unpushed().length) {
      if (this.pushInFlight) {
        await this.pushInFlight;
        continue;
      }
      if (!(await this.pushOnce())) return;
    }
  }

  /** One push request. Resolves true on a response, false on failure (retry already arranged). */
  private pushOnce(): Promise<boolean> {
    if (this.pushInFlight) return this.pushInFlight;
    const first = this.unpushed()[0];
    if (!first) return Promise.resolve(true);
    const limit = first.id <= this.isolateUntilId ? 1 : this.opts.maxBatch;
    const batch = this.unpushed().slice(0, limit);
    for (const e of batch) e.inFlight = true;
    const request: PushRequest = {
      clientGroupId: this.clientGroupId,
      clientId: this.clientId,
      mutations: batch.map((e) => ({ id: e.id, name: e.name as CommandName, args: e.args, timestamp: e.timestamp })),
    };
    const run = (async (): Promise<boolean> => {
      let res: PushResponse;
      try {
        res = await this.transport.push(request);
      } catch (err) {
        for (const e of batch) e.inFlight = false;
        this.onPushFailure(batch, asTransportError(err));
        return false;
      }
      for (const e of batch) e.inFlight = false;
      this.pushAttempts = 0;
      this.lastError = null;
      this.onPushResponse(batch, res);
      return true;
    })();
    this.pushInFlight = run.finally(() => {
      this.pushInFlight = null;
      this.emitStatus();
      if (!this.closed && !this.pushBlocked && this.pushRetryTimer === null && this.unpushed().length) this.schedulePush(0);
    });
    this.emitStatus();
    return this.pushInFlight;
  }

  private onPushResponse(batch: Entry[], res: PushResponse): void {
    const byId = new Map(batch.map((e) => [e.id, e]));
    let dropped = false;
    for (const o of res.outcomes ?? []) {
      const e = byId.get(o.id);
      if (!e || e.outcome) continue;
      e.outcome = o;
      switch (o.status) {
        case "applied":
          if (e.confirmed) this.settle(e, { status: "confirmed" });
          break;
        case "skipped":
          if (e.confirmed) this.settle(e, { status: "processed" });
          break;
        case "pending":
          e.dropped = dropped = true;
          this.settle(e, { status: "pending", actionId: o.actionId });
          this.addAwaiting(e, o.actionId);
          break;
        case "rejected":
          e.dropped = dropped = true;
          this.settle(e, { status: "rejected", code: o.code, message: o.message });
          this.emitRejected(e, { status: "rejected", code: o.code, message: o.message, source: "push" });
          break;
        case "conflict": {
          e.dropped = dropped = true;
          const r: MutationResult = { status: "conflict", code: o.code, message: o.message };
          if (o.currentRevision !== undefined) r.currentRevision = o.currentRevision;
          this.settle(e, r);
          this.emitRejected(e, { status: "conflict", code: o.code, message: o.message, currentRevision: o.currentRevision, source: "push" });
          break;
        }
      }
    }
    // A mutation the pull already confirmed but that got no outcome here is done.
    for (const e of batch) if (e.confirmed && !e.outcome) this.settle(e, { status: "processed" });
    this.gc();
    if (dropped) this.rebase();
    if (typeof res.head === "number" && (this.cookieValue === null || res.head > this.cookieValue)) void this.pull();
  }

  private onPushFailure(batch: Entry[], err: SyncTransportError): void {
    this.lastError = err;
    for (const e of batch) if (e.confirmed && !e.outcome) this.settle(e, { status: "processed" });
    this.gc();
    if (err.retryable) {
      this.pushAttempts++;
      if (!this.closed) {
        this.pushRetryTimer = this.timers.setTimeout(() => {
          this.pushRetryTimer = null;
          void this.pushLoop();
        }, this.backoff(this.pushAttempts));
      }
      return;
    }
    const requestInvalid = err.code === "validation_failed" || err.code === "payload_too_large" || err.status === 400 || err.status === 413;
    if (requestInvalid && batch.length > 1) {
      // Find the bad mutation by sending the batch one at a time.
      this.isolateUntilId = batch[batch.length - 1]!.id;
      return;
    }
    if (requestInvalid && batch.length === 1) {
      // The server never processed it (the request was refused), so drop it here. The next
      // mutation id skips over it; servers accept any id above the last processed one.
      const e = batch[0]!;
      e.dropped = true;
      const message = err.message || "The server refused this change.";
      const code = err.code ?? "validation_failed";
      this.settle(e, { status: "rejected", code, message });
      this.emitRejected(e, { status: "rejected", code, message, source: "local" });
      this.gc();
      this.rebase();
      return;
    }
    // Auth or similar: stop pushing until the next mutate or retry().
    this.pushBlocked = true;
  }

  private backoff(attempt: number): number {
    const base = Math.min(this.opts.retryMaxMs, this.opts.retryBaseMs * 2 ** Math.max(0, attempt - 1));
    return Math.round(base * (0.8 + 0.4 * this.random()));
  }

  // ---- replay -------------------------------------------------------------------------------

  private isUnsynced(e: Entry): boolean {
    return !e.outcome && !e.confirmed && !e.dropped;
  }

  /** Mutations replayed over server state. */
  private live(): Entry[] {
    return this.entries.filter((e) => !e.confirmed && !e.dropped);
  }

  private stepFor(e: Entry): ReplayStep {
    const context: MutationContext = { principal: this.principal, timestamp: e.timestamp };
    const fn = this.mutators[e.name]!;
    return {
      context,
      run: (tx) => fn(tx, e.args),
      onError: (err) => {
        e.likelyToFail = toMutationError(err);
      },
    };
  }

  private rebase(): void {
    const steps = this.live().map((e) => {
      e.likelyToFail = null;
      return this.stepFor(e);
    });
    this.store.rebase(steps);
    this.emitStatus();
  }

  private settle(e: Entry, r: MutationResult): void {
    if (e.settled) return;
    e.settled = true;
    e.resolve(r);
  }

  /** Forget entries that are settled and no longer replayed. */
  private gc(): void {
    this.entries = this.entries.filter((e) => !(e.settled && (e.confirmed || e.dropped)));
  }

  // ---- approvals ----------------------------------------------------------------------------

  private addAwaiting(e: Entry, actionId: number): void {
    this.awaiting.push({
      mutationId: e.id,
      actionId,
      name: e.name,
      args: e.args,
      label: e.label,
      since: this.now(),
      approved: false,
      retireAfterPull: null,
    });
    this.emit("awaiting", this.awaitingApproval);
    this.scheduleApprovalCheck();
  }

  private checkAwaiting(pullNumber: number): void {
    if (!this.awaiting.length) return;
    const server = this.store.server;
    for (const a of [...this.awaiting]) {
      let shown = false;
      try {
        shown = this.appliedIn(a.name, server, a.args);
      } catch {
        shown = false;
      }
      if (shown || (a.retireAfterPull !== null && pullNumber >= a.retireAfterPull)) this.retireApproval(a, "applied");
    }
  }

  private retireApproval(a: AwaitingInternal, resolution: ApprovalResolvedEvent["resolution"], message?: string): void {
    const i = this.awaiting.indexOf(a);
    if (i < 0) return;
    this.awaiting.splice(i, 1);
    const { retireAfterPull: _r, ...entry } = a;
    const ev: ApprovalResolvedEvent = { entry, resolution };
    if (message !== undefined) ev.message = message;
    this.emit("approval", ev);
    if (resolution === "rejected" || resolution === "expired" || resolution === "timeout") {
      const defaults = {
        rejected: "The change was not approved.",
        expired: "The approval request expired.",
        timeout: "No approval decision arrived in time; the change may still be approved later.",
      } as const;
      this.emit("rejected", {
        mutationId: a.mutationId,
        name: a.name,
        args: a.args,
        label: a.label,
        status: "rejected",
        code: `approval_${resolution}`,
        message: message || defaults[resolution],
        source: "approval",
      });
    }
    this.emit("awaiting", this.awaitingApproval);
    this.emitStatus();
    if (!this.awaiting.length && this.approvalTimer !== null) {
      this.timers.clearTimeout(this.approvalTimer);
      this.approvalTimer = null;
    }
  }

  private scheduleApprovalCheck(): void {
    if (this.closed || this.approvalTimer !== null || !this.awaiting.length) return;
    const now = this.now();
    const nextExpiry = Math.min(...this.awaiting.map((a) => a.since + this.opts.approvalTimeoutMs)) - now;
    const delay = Math.max(0, this.transport.approvals ? Math.min(this.opts.approvalCheckIntervalMs, nextExpiry) : nextExpiry);
    this.approvalTimer = this.timers.setTimeout(() => {
      this.approvalTimer = null;
      void this.checkApprovals().finally(() => this.scheduleApprovalCheck());
    }, delay);
  }

  /** Asks the transport about awaited approvals and retires timed-out ones. */
  async checkApprovals(): Promise<void> {
    const now = this.now();
    for (const a of [...this.awaiting]) if (now - a.since >= this.opts.approvalTimeoutMs) this.retireApproval(a, "timeout");
    const open = this.awaiting.filter((a) => !a.approved);
    if (!open.length || !this.transport.approvals) return;
    let statuses: ApprovalStatus[];
    try {
      statuses = await this.transport.approvals(open.map((a) => a.actionId));
    } catch {
      return;
    }
    let approved = false;
    for (const s of statuses) {
      const a = this.awaiting.find((x) => x.actionId === s.actionId);
      if (!a) continue;
      if (s.status === "approved" && !a.approved) {
        a.approved = approved = true;
        // Retire once a pull that starts after this point completes (it will carry the change).
        a.retireAfterPull = this.pullsStarted + 1;
      } else if (s.status === "rejected" || s.status === "expired") {
        this.retireApproval(a, s.status, s.message);
      }
    }
    if (approved) {
      this.emit("awaiting", this.awaitingApproval);
      await this.pull();
    }
  }

  // ---- events -------------------------------------------------------------------------------

  private emitRejected(e: Entry, r: Pick<RejectedEvent, "status" | "code" | "message" | "source"> & { currentRevision?: number | undefined }): void {
    const ev: RejectedEvent = { mutationId: e.id, name: e.name, args: e.args, label: e.label, status: r.status, code: r.code, message: r.message, source: r.source };
    if (r.currentRevision !== undefined) ev.currentRevision = r.currentRevision;
    this.emit("rejected", ev);
  }

  private emit<K extends keyof SyncEvents>(event: K, payload: SyncEvents[K]): void {
    for (const l of [...this.listeners[event]]) {
      try {
        (l as (e: SyncEvents[K]) => void)(payload);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  private emitStatus(): void {
    const s = this.status();
    const json = JSON.stringify({ ...s, lastError: s.lastError?.message ?? null });
    if (json === this.lastStatusJson) return;
    this.lastStatusJson = json;
    this.emit("status", s);
  }

  private buildMutateApi(): MutateApi<M> {
    const api: Record<string, Record<string, (args: unknown) => MutationHandle>> = {};
    for (const name of Object.keys(this.mutators)) {
      const dot = name.indexOf(".");
      if (dot < 0) continue;
      const ns = name.slice(0, dot);
      const op = name.slice(dot + 1);
      (api[ns] ??= {})[op] = (args: unknown) => this.mutateByName(name, args);
    }
    return api as unknown as MutateApi<M>;
  }
}
