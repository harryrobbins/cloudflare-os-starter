// Sync push (canonical plan §6; the server half of @records/sync-client's README, "What the server
// must do", points 1-5 and 10).
//
// Per request:
//   1. authorise (sync needs issues.read: a client that cannot pull cannot converge), register the
//      client (records.client_mutations, owned by the calling principal under RLS) and read its
//      lastMutationId and the saved outcomes of any replayed ids in this batch.
//   2. per mutation, in array order:
//        id <= lastMutationId  the saved outcome if it is still retained, else `skipped`
//        otherwise             the optional approval gate decides: `execute` runs the command
//                              through the CommandBus with idempotency key
//                              `sync:<clientId>:<id>` and via 'sync' (or the caller's own), and
//                              the client's lastMutationId advances in the SAME transaction
//                              (bus `inTransaction`); `settled` (pending with an actionId, or a
//                              refusal) is recorded as processed without running anything.
//                              A command refused for good (rejected, conflict) is recorded as
//                              processed in its own small transaction.
//      Every processed mutation's outcome is saved (idempotency_keys, operation 'sync.push', kept
//      for IDEMPOTENCY_RETENTION_DAYS) so a replayed id returns it, `pending` + actionId included.
//   3. `head`: the datastore clock after the batch.
//
// Gaps are accepted: any id above lastMutationId is valid. A transient failure (unavailable,
// internal) or the time budget ends the batch early; the response then covers the prefix handled
// and the client pushes the rest again. A transient failure on the very first mutation fails the
// request, so the client retries it.
//
// Concurrency: the command transaction locks the client row (FOR UPDATE) before anything else and
// re-checks lastMutationId, so two overlapping pushes of the same id (a retry racing a slow
// original) process it once; the loser returns the saved outcome.

import {
  parseInput,
  PushRequestSchema,
  RecordsError,
  requestDigest,
  type CallerContext,
  type JournalVia,
  type PushMutation,
  type PushOutcome,
  type PushRequest,
  type PushResponse,
} from "@records/contracts";

import { settle, type CommandBus } from "../bus/bus.js";
import { contextOf, withContext, type Db, type Tx } from "../db/context.js";
import { authorize } from "../domain/authorize.js";
import { IDEMPOTENCY_RETENTION_DAYS } from "../domain/idempotency.js";

/** Operation name under which push outcomes are saved in records.idempotency_keys. */
export const SYNC_OUTCOME_OPERATION = "sync.push";

/** Default time budget for one push request (the HTTP deadline is 15 s). */
export const SYNC_PUSH_BUDGET_MS = 8_000;

/**
 * The idempotency key a sync mutation's command runs under, and the `idempotencyKey` of its write
 * intent on the gadget path: `sync:<clientId>:<mutationId>` (at most 86 characters).
 */
export function syncIdempotencyKey(clientId: string, mutationId: number): string {
  return `sync:${clientId}:${mutationId}`;
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** A final outcome decided without running the command here (an approval gate, a refusal). */
export type SettledPushOutcome = WithoutId<Exclude<PushOutcome, { status: "skipped" }>>;

export type SyncGateDecision =
  /** Run the command now, in the push transaction. */
  | { kind: "execute" }
  /** Count the mutation as processed with this outcome (e.g. `pending` with the approval's actionId). */
  | { kind: "settled"; outcome: SettledPushOutcome };

/**
 * Called for each mutation that is not a replay, before anything runs. A thrown RecordsError
 * becomes that mutation's rejected/conflict outcome; a transient one ends the batch.
 */
export type SyncGate = (mutation: PushMutation, info: { idempotencyKey: string }) => Promise<SyncGateDecision>;

export type PushOptions = {
  /** Journal channel for executed commands. Default 'sync'. */
  via?: JournalVia;
  gate?: SyncGate;
  budgetMs?: number;
  now?: () => number;
};

/** Thrown inside the command transaction when another push already processed this id. */
class AlreadyProcessed extends Error {}

function outcomeKey(req: PushRequest, id: number): string {
  return `${req.clientGroupId}:${req.clientId}:${id}`;
}

function withId(id: number, outcome: SettledPushOutcome): PushOutcome {
  return { id, ...outcome } as PushOutcome;
}

export class SyncPusher {
  constructor(private readonly db: Db, private readonly bus: CommandBus) {}

  async push(caller: CallerContext, datastoreId: string, raw: unknown, opts: PushOptions = {}): Promise<PushResponse> {
    const req = parseInput(PushRequestSchema, raw);
    const now = opts.now ?? Date.now;
    const started = now();
    const budget = opts.budgetMs ?? SYNC_PUSH_BUDGET_MS;
    const ctx = contextOf(caller, datastoreId);

    let { last, saved } = await withContext(this.db, ctx, async (tx) => {
      await authorize(tx, caller, datastoreId, "listIssues");
      await tx`
        INSERT INTO records.client_mutations (org_id, datastore_id, client_group_id, client_id, principal_id)
        VALUES (${caller.orgId}, ${datastoreId}, ${req.clientGroupId}, ${req.clientId}, ${caller.principalId})
        ON CONFLICT DO NOTHING`;
      const last = await this.#lastMutationId(tx, datastoreId, req, false);
      const replayed = req.mutations.filter((m) => m.id <= last).map((m) => m.id);
      return { last, saved: await this.#savedOutcomes(tx, caller, datastoreId, req, replayed) };
    });

    const outcomes: PushOutcome[] = [];
    for (const m of req.mutations) {
      if (outcomes.length > 0 && now() - started > budget) break;
      if (m.id <= last) {
        outcomes.push(saved.get(m.id) ?? { id: m.id, status: "skipped" });
        continue;
      }
      try {
        outcomes.push(await this.#one(caller, datastoreId, req, m, opts));
      } catch (err) {
        if (outcomes.length === 0) throw err;
        break; // transient: report the prefix; the client pushes the rest again
      }
      last = m.id;
    }

    const head = await withContext(this.db, ctx, (tx) => readHead(tx, datastoreId));
    return { outcomes, head };
  }

  async #one(caller: CallerContext, datastoreId: string, req: PushRequest, m: PushMutation, opts: PushOptions): Promise<PushOutcome> {
    const idempotencyKey = syncIdempotencyKey(req.clientId, m.id);
    let settled: SettledPushOutcome;
    try {
      const decision = opts.gate ? await opts.gate(m, { idempotencyKey }) : { kind: "execute" as const };
      if (decision.kind === "settled") {
        settled = decision.outcome;
      } else {
        const out = await this.bus.execute(caller, datastoreId, { name: m.name, input: m.args }, {
          idempotencyKey,
          via: opts.via ?? "sync",
          inTransaction: {
            before: (tx) => this.#claim(tx, datastoreId, req, m.id),
            after: (tx, applied) => this.#advance(tx, caller, datastoreId, req, m, { status: "applied", seq: applied.seq }),
          },
        });
        return { id: m.id, status: "applied", seq: out.seq };
      }
    } catch (err) {
      if (err instanceof AlreadyProcessed) return this.#replay(caller, datastoreId, req, m.id);
      const outcome = await settle(Promise.reject(err)); // transient and internal failures rethrow
      if (outcome.status === "applied") throw new RecordsError("internal", "Unexpected outcome.");
      settled = outcome.status === "conflict"
        ? { status: "conflict", code: outcome.code, message: outcome.message, ...(outcome.currentRevision !== undefined ? { currentRevision: outcome.currentRevision } : {}) }
        : { status: "rejected", code: outcome.code, message: outcome.message };
    }
    // Record a mutation decided without a command commit: processed, with its outcome.
    try {
      await withContext(this.db, contextOf(caller, datastoreId), async (tx) => {
        await this.#claim(tx, datastoreId, req, m.id);
        await this.#advance(tx, caller, datastoreId, req, m, settled);
      });
    } catch (err) {
      if (err instanceof AlreadyProcessed) return this.#replay(caller, datastoreId, req, m.id);
      throw err;
    }
    return withId(m.id, settled);
  }

  async #replay(caller: CallerContext, datastoreId: string, req: PushRequest, id: number): Promise<PushOutcome> {
    const saved = await withContext(this.db, contextOf(caller, datastoreId), (tx) => this.#savedOutcomes(tx, caller, datastoreId, req, [id]));
    return saved.get(id) ?? { id, status: "skipped" };
  }

  async #lastMutationId(tx: Tx, datastoreId: string, req: PushRequest, lock: boolean): Promise<number> {
    const forUpdate = lock ? tx`FOR UPDATE` : tx``;
    const [row] = await tx`
      SELECT last_mutation_id FROM records.client_mutations
       WHERE datastore_id = ${datastoreId} AND client_group_id = ${req.clientGroupId} AND client_id = ${req.clientId}
       ${forUpdate}`;
    // Under RLS a row owned by another principal is invisible: the insert did nothing and this is empty.
    if (!row) throw new RecordsError("forbidden", "This sync client ID belongs to someone else; start a new client.");
    return Number(row.last_mutation_id);
  }

  /** Lock the client row and refuse an id another push has processed meanwhile. */
  async #claim(tx: Tx, datastoreId: string, req: PushRequest, id: number): Promise<void> {
    if ((await this.#lastMutationId(tx, datastoreId, req, true)) >= id) throw new AlreadyProcessed();
  }

  async #advance(tx: Tx, caller: CallerContext, datastoreId: string, req: PushRequest, m: PushMutation, outcome: SettledPushOutcome): Promise<void> {
    await tx`
      UPDATE records.client_mutations SET last_mutation_id = ${m.id}, updated_at = now()
       WHERE datastore_id = ${datastoreId} AND client_group_id = ${req.clientGroupId} AND client_id = ${req.clientId}`;
    const digest = await requestDigest(m.name, m.args ?? null);
    await tx`
      INSERT INTO records.idempotency_keys (org_id, datastore_id, principal_id, operation, key, request_digest, outcome)
      VALUES (${caller.orgId}, ${datastoreId}, ${caller.principalId}, ${SYNC_OUTCOME_OPERATION}, ${outcomeKey(req, m.id)}, ${digest},
              ${tx.json(withId(m.id, outcome) as never)})
      ON CONFLICT DO NOTHING`; // ids only ever increase, so a key is written once per client
  }

  async #savedOutcomes(tx: Tx, caller: CallerContext, datastoreId: string, req: PushRequest, ids: number[]): Promise<Map<number, PushOutcome>> {
    const out = new Map<number, PushOutcome>();
    if (ids.length === 0) return out;
    const rows = await tx`
      SELECT outcome FROM records.idempotency_keys
       WHERE org_id = ${caller.orgId} AND datastore_id = ${datastoreId} AND principal_id = ${caller.principalId}
         AND operation = ${SYNC_OUTCOME_OPERATION} AND key = ANY(${ids.map((id) => outcomeKey(req, id))})
         AND created_at > now() - make_interval(days => ${IDEMPOTENCY_RETENTION_DAYS})`;
    for (const r of rows) {
      const o = r.outcome as PushOutcome;
      if (typeof o?.id === "number") out.set(o.id, o);
    }
    return out;
  }
}

export async function readHead(tx: Tx, datastoreId: string): Promise<number> {
  const [clock] = await tx`SELECT seq FROM records.datastore_clock WHERE datastore_id = ${datastoreId}`;
  return clock ? Number(clock.seq) : 0;
}
