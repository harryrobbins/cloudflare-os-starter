// The command bus (canonical plan §4). Every adapter (gadget session, native HTTP, sync push, the
// Jira surface) turns its input into a Command and calls `execute`. One transaction, in this order:
//
//   1. trusted context: organisation, datastore, principal, scopes and binding (withContext)
//   2. authorise against fresh state, locking the membership and binding rows it relies on
//      (authorize.ts: principal rights ∩ binding scopes ∩ the command's permission)
//   3. idempotency: the same key and request digest returns the saved outcome, seq included; a
//      different digest is idempotency_conflict
//   4. the module handler: FOR UPDATE on what it changes, the expected-revision check, the rules
//   5. audit and outbox; then the clock, LAST; current rows with last_seq; journal entries
//      (commit.ts)
//   6. save the outcome under the idempotency key; commit
//
// Steps 2 and 3 are the other way round in the plan's list. Authorising first keeps an existing
// guarantee: a replay still requires current access, and a caller who has lost access learns
// nothing about their old keys (not even that one conflicts).
//
// `execute` resolves to an applied outcome and throws RecordsError for everything else, as the
// service always has. `settle` turns that into the outcome vocabulary (applied, rejected,
// conflict) for adapters such as sync push that must report every mutation.

import {
  COMMAND_NAMES,
  IdempotencyKeySchema,
  JOURNAL_VIA,
  parseInput,
  RecordsError,
  type CallerContext,
  type Command,
  type ErrorCode,
  type JournalVia,
} from "@records/contracts";

import { contextOf, withContext, type Db, type Tx } from "../db/context.js";
import { authorize, requireWritable } from "../domain/authorize.js";
import { findSaved, saveOutcome } from "../domain/idempotency.js";
import { PROJECTS_HANDLERS, type ProjectsCommandName } from "../projects/handlers.js";
import { commitPlan, type BusHooks } from "./commit.js";
import { uuidv7 } from "./uuidv7.js";

export type ExecuteOptions = {
  idempotencyKey: string;
  /** From HTTP If-Match. Merged into a revisioned command's input; must agree with it if both are given. */
  expectedRevision?: number;
  /** How the command arrived. Defaults to the caller's own `via`. */
  via?: JournalVia;
  /**
   * Jira surface only (`via: 'jira'`): when no revision is given, apply to the current one ("last
   * write wins"). Honoured only by handlers with `parseUnconditional`; ignored on other channels.
   */
  lastWriteWins?: boolean;
  /**
   * Extra work inside the command's own transaction, for adapters whose bookkeeping must commit
   * atomically with the command (sync push: the client's lastMutationId). `before` runs first,
   * before authorisation; throwing from it aborts the command. `after` runs once the outcome is
   * known (a fresh commit or an idempotent replay), just before COMMIT.
   */
  inTransaction?: {
    before?(tx: Tx): Promise<void>;
    after?(tx: Tx, outcome: AppliedOutcome): Promise<void>;
  };
};

export type AppliedOutcome<T = unknown> = {
  status: "applied";
  record: T;
  /** The datastore clock value this command committed at (the same on replay). */
  seq: number;
  commandId: string;
  replayed: boolean;
};

export type CommandOutcome<T = unknown> =
  | AppliedOutcome<T>
  | { status: "rejected"; code: ErrorCode; message: string }
  | { status: "conflict"; code: "revision_conflict" | "workflow_conflict"; message: string; currentRevision?: number };

/** What the idempotency record holds for a journaled command. */
type SavedOutcome = { v: 2; record: unknown; seq: number; commandId: string };

function isSaved(value: unknown): value is SavedOutcome {
  return typeof value === "object" && value !== null && (value as { v?: unknown }).v === 2;
}

const KNOWN = new Set<string>([...COMMAND_NAMES, "projects.createProject"]);

function withRevision(input: unknown, expected: number | undefined): unknown {
  const body = input as Record<string, unknown> | null;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return input; // the schema will refuse it
  if (expected === undefined) {
    if (body.expectedRevision === undefined) throw new RecordsError("revision_required", "Changing a record needs its expected revision.");
    return input;
  }
  if (body.expectedRevision !== undefined && body.expectedRevision !== expected) {
    throw new RecordsError("validation_failed", "The expected revision in the request and in If-Match disagree.");
  }
  return { ...body, expectedRevision: expected };
}

export class CommandBus {
  constructor(private readonly db: Db, private readonly hooks: BusHooks = {}) {}

  /** Run one command. Commands that change records need an idempotency key. */
  async execute(caller: CallerContext, datastoreId: string, command: Command, opts: ExecuteOptions): Promise<AppliedOutcome> {
    return this.run(caller, datastoreId, command.name, command.input, opts);
  }

  /**
   * The bus entry for every journaled command, including management commands outside the frozen
   * CommandName set (createProject). `idempotencyKey` is optional only for those.
   */
  async run(
    caller: CallerContext,
    datastoreId: string,
    name: ProjectsCommandName,
    rawInput: unknown,
    opts: Partial<ExecuteOptions>,
  ): Promise<AppliedOutcome> {
    if (!KNOWN.has(name)) throw new RecordsError("validation_failed", "Unknown command.");
    const handler = PROJECTS_HANDLERS[name];
    const isCommand = (COMMAND_NAMES as readonly string[]).includes(name);
    if (isCommand && opts.idempotencyKey === undefined) throw new RecordsError("validation_failed", "An idempotency key is required.");
    const key = opts.idempotencyKey === undefined ? null : parseInput(IdempotencyKeySchema, opts.idempotencyKey);
    const via = opts.via ?? caller.via;
    if (!(JOURNAL_VIA as readonly string[]).includes(via)) throw new RecordsError("validation_failed", "Unknown channel.");
    const unconditional = opts.lastWriteWins === true && via === "jira" && handler.parseUnconditional !== undefined &&
      opts.expectedRevision === undefined && (rawInput as { expectedRevision?: unknown } | null)?.expectedRevision === undefined;
    const input = handler.revisioned && !unconditional ? withRevision(rawInput, opts.expectedRevision) : rawInput;
    const parsed = unconditional ? handler.parseUnconditional!(input) : handler.parse(input);

    const extra = opts.inTransaction;
    return withContext(this.db, contextOf(caller, datastoreId), async (tx): Promise<AppliedOutcome> => {
      await extra?.before?.(tx);
      requireWritable(await authorize(tx, caller, datastoreId, handler.operation, { lock: true }));
      const scope = key === null ? null : { datastoreId, operation: handler.operation, key };
      const saved = scope ? await findSaved(tx, caller, scope, input) : null;
      let out: AppliedOutcome;
      if (saved && saved.outcome !== null) {
        const outcome = saved.outcome;
        // Outcomes saved before the journal existed hold the bare record.
        out = isSaved(outcome)
          ? { status: "applied", record: outcome.record, seq: outcome.seq, commandId: outcome.commandId, replayed: true }
          : { status: "applied", record: outcome, seq: 0, commandId: "", replayed: true };
      } else {
        const plan = await handler.prepare(tx, caller, datastoreId, parsed);
        const commandId = uuidv7();
        const { seq, result } = await commitPlan(tx, caller, datastoreId, { command: name, commandId, via }, plan, this.hooks);
        if (scope && saved) {
          await saveOutcome(tx, caller, scope, saved.digest, { v: 2, record: result, seq, commandId } satisfies SavedOutcome);
        }
        out = { status: "applied", record: result, seq, commandId, replayed: false };
      }
      await extra?.after?.(tx, out);
      return out;
    });
  }
}

/** Resolve a bus call to the outcome vocabulary. Transient and internal failures still throw. */
export async function settle<T>(pending: Promise<AppliedOutcome<T>>): Promise<CommandOutcome<T>> {
  try {
    return await pending;
  } catch (err) {
    if (!(err instanceof RecordsError)) throw err;
    if (err.code === "revision_conflict" || err.code === "workflow_conflict") {
      return {
        status: "conflict", code: err.code, message: err.detail,
        ...(err.currentRevision !== undefined ? { currentRevision: err.currentRevision } : {}),
      };
    }
    if (err.code === "unavailable" || err.code === "internal" || err.code === "rate_limited") throw err;
    return { status: "rejected", code: err.code, message: err.detail };
  }
}
