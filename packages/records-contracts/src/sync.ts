// Journal, change feed and sync contracts (canonical plan §3, §6 and §7).
//
// Every committed change is one or more immutable journal entries, all sharing the `seq` the
// transaction took from its datastore's clock. `seq` is gapless and in commit order within one
// datastore, so "I have seen seq 41" means "I have seen everything up to 41". That makes it safe
// to use as a cursor for `/changes` and as the sync `cookie`.

import { z } from "zod";

import { MUTATING_RECORD_OPERATIONS } from "./permissions.js";

// ---------------------------------------------------------------------------------------------
// Commands

/** A command's name, qualified by module: `projects.createIssue`. */
export const COMMAND_NAMES = MUTATING_RECORD_OPERATIONS.map((op) => `projects.${op}` as const);
export type CommandName = (typeof COMMAND_NAMES)[number];

/** One command, as every adapter hands it to the command bus. `input` is validated by the module. */
export type Command = { name: CommandName; input: unknown };

// ---------------------------------------------------------------------------------------------
// Journal

export const JOURNAL_OPS = ["create", "update", "archive", "restore", "redact"] as const;
export type JournalOp = (typeof JOURNAL_OPS)[number];

/** How a change reached the service. Wider than the audit `Via`: sync and Jira are adapters too. */
export const JOURNAL_VIA = ["gadget", "http", "sync", "jira", "management", "system"] as const;
export type JournalVia = (typeof JOURNAL_VIA)[number];

/** Entities the Projects module journals. Other modules add their own. */
export const JOURNAL_ENTITY_TYPES = ["project", "issue", "comment"] as const;
export type JournalEntityType = (typeof JOURNAL_ENTITY_TYPES)[number];

export const JournalEntrySchema = z.object({
  seq: z.number().int().min(1),
  ordinal: z.number().int().min(0),
  changeId: z.uuid(),
  command: z.string(),
  entityType: z.enum(JOURNAL_ENTITY_TYPES),
  entityId: z.uuid(),
  entityRev: z.number().int().min(1),
  op: z.enum(JOURNAL_OPS),
  /** New values of the changed fields (wire names, as in the entity DTO). */
  after: z.record(z.string(), z.unknown()),
  /** Previous values of the changed fields; null on create. */
  before: z.record(z.string(), z.unknown()).nullable(),
  actorId: z.uuid(),
  actId: z.uuid().nullable(),
  via: z.enum(JOURNAL_VIA),
  occurredAt: z.string(),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

/** `GET …/changes?after=<seq>&limit=`. `head` is the datastore's clock when the page was read. */
export type ChangesPage = {
  entries: JournalEntry[];
  /** Pass as `after` for the next page. Equal to the input `after` when nothing is new. */
  nextAfter: number;
  head: number;
  /** True when `after` is older than journal retention; the caller must reload current state. */
  resetRequired: boolean;
};

export const ChangesQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

// ---------------------------------------------------------------------------------------------
// Sync (Replicache-style semantics; no dependency on the library)

export const ClientIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "a client ID is 8-64 URL-safe characters");

export const PushMutationSchema = z.object({
  /** Strictly increasing per client, starting at 1. */
  id: z.number().int().min(1),
  name: z.enum(COMMAND_NAMES as unknown as [CommandName, ...CommandName[]]),
  args: z.unknown(),
  /** Client clock time, for display only. */
  timestamp: z.number().optional(),
});
export type PushMutation = z.infer<typeof PushMutationSchema>;

export const PushRequestSchema = z.object({
  clientGroupId: ClientIdSchema,
  clientId: ClientIdSchema,
  mutations: z.array(PushMutationSchema).min(1).max(100),
});
export type PushRequest = z.infer<typeof PushRequestSchema>;

/**
 * Outcome of one pushed mutation. `applied` carries the seq it committed at; `pending` means it is
 * queued for approval (it still counts as processed); `rejected` and `conflict` are final and the
 * client drops the mutation and shows the message. `skipped` means the id was already processed.
 */
export type PushOutcome =
  | { id: number; status: "applied"; seq: number }
  | { id: number; status: "pending"; actionId: number }
  | { id: number; status: "rejected"; code: string; message: string }
  | { id: number; status: "conflict"; code: "revision_conflict" | "workflow_conflict"; message: string; currentRevision?: number }
  | { id: number; status: "skipped" };

export type PushResponse = { outcomes: PushOutcome[]; head: number };

export const PullRequestSchema = z.object({
  clientGroupId: ClientIdSchema,
  /** The last `cookie` this client group received; null for a first pull. */
  cookie: z.number().int().min(0).nullable(),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

/** Patch operations over entity keys `<entityType>/<entityId>`. */
export type PatchOp =
  | { op: "clear" }
  | { op: "put"; key: string; value: unknown }
  | { op: "del"; key: string };

export type PullResponse = {
  cookie: number;
  /** Highest processed mutation id per client in the group. */
  lastMutationIdChanges: Record<string, number>;
  patch: PatchOp[];
};

/** Entity key used in patches and in the client's store. */
export function entityKey(entityType: string, entityId: string): string {
  return `${entityType}/${entityId}`;
}

// ---------------------------------------------------------------------------------------------
// Poke

/** What the poke hub sends. Carries no data: the subscriber pulls. */
export type Poke = { datastoreId: string; head: number };
