// Sync pull (canonical plan §6; @records/sync-client README, "What the server must do", 6-8).
//
// One REPEATABLE READ, read-only transaction, so the cookie (the clock head), the patch and
// lastMutationIdChanges all come from one snapshot: a mutation counted in a lastMutationId is also
// in the patch, because push advances lastMutationId in the command's own transaction.
//
// Patch:
//   delta  cookie <= head and the journal still covers it: the entities journaled with
//          cookie < seq <= head, coalesced per key and re-read from the current tables under the
//          caller's RLS: `put` of the current DTO, or `del` when the entity is gone or no longer
//          visible to the caller.
//   full   cookie null, older than retention, newer than the head (a restore), or a delta that
//          touches more than SYNC_LIMITS.deltaMaxKeys entities: `clear`, then every visible
//          project, issue and comment.
//   Both carry `meta/workflow` (configuration, not journaled; small; the client compares values
//   structurally, so an unchanged workflow changes nothing).
//
// Bounds (full state): at most SYNC_LIMITS.projects projects, SYNC_LIMITS.issues issues and
// SYNC_LIMITS.comments comments, and at most SYNC_LIMITS.pullMaxBytes of serialised response. A
// datastore over any bound is refused with payload_too_large rather than truncated (a truncated
// state would never converge); such datastores need the paged native API or a later, paginated
// pull.
//
// lastMutationIdChanges: every client in the group (always correct, README point 7) owned by the
// principal whose client rows are visible, normally the caller. The gadget session reads data as
// its binding but reports the rows of the viewer who pushed, through the trusted `clientsOf`
// option, which switches records.principal_id for that one statement inside the same snapshot.

import {
  entityKey,
  JOURNAL_ENTITY_TYPES,
  parseInput,
  PullRequestSchema,
  RecordsError,
  type CallerContext,
  type JournalEntityType,
  type PatchOp,
  type PullResponse,
} from "@records/contracts";

import { contextOf, withContext, type Db, type Tx } from "../db/context.js";
import { authorize } from "../domain/authorize.js";
import { commentSelect, issueSelect, loadWorkflow, toComment, toIssue, toProject } from "../projects/rows.js";
import { readHead } from "./push.js";

export const SYNC_LIMITS = {
  projects: 200,
  issues: 5_000,
  comments: 20_000,
  /** A delta touching more entities than this is sent as full state instead. */
  deltaMaxKeys: 2_000,
  pullMaxBytes: 8 * 1024 * 1024,
} as const;

export const WORKFLOW_KEY = "meta/workflow";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PullOptions = {
  /**
   * Trusted adapters only: report the client rows of this principal instead of the caller's (the
   * gadget session: data is read as the binding, clients belong to the viewer who pushed); `null`
   * reports none (no one has pushed into this group through the adapter).
   */
  clientsOf?: string | null;
};

function tooLarge(what: string): never {
  throw new RecordsError("payload_too_large", `This datastore has more ${what} than sync supports; use the paged API.`);
}

export class SyncPuller {
  constructor(private readonly db: Db) {}

  async pull(caller: CallerContext, datastoreId: string, raw: unknown, opts: PullOptions = {}): Promise<PullResponse> {
    const req = parseInput(PullRequestSchema, raw);
    if (typeof opts.clientsOf === "string" && !UUID.test(opts.clientsOf)) throw new RecordsError("forbidden", "This identity is not active.");
    const response = await withContext(this.db, contextOf(caller, datastoreId), async (tx): Promise<PullResponse> => {
      await authorize(tx, caller, datastoreId, "listIssues");
      const head = await readHead(tx, datastoreId);
      const cookie = req.cookie;

      let full = cookie === null || cookie > head;
      if (!full && cookie! < head) {
        const [bounds] = await tx`SELECT min(seq) AS earliest FROM records.journal WHERE datastore_id = ${datastoreId}`;
        const earliest = bounds?.earliest == null ? null : Number(bounds.earliest);
        const purged = earliest === null ? head > 0 : earliest > 1;
        full = purged && cookie! < (earliest ?? head + 1) - 1;
      }

      const patch: PatchOp[] = [];
      if (!full && cookie! < head) {
        const touched = await tx`
          SELECT entity_type, entity_id FROM records.journal
           WHERE datastore_id = ${datastoreId} AND seq > ${cookie} AND seq <= ${head}
           GROUP BY entity_type, entity_id
           LIMIT ${SYNC_LIMITS.deltaMaxKeys + 1}`;
        if (touched.length > SYNC_LIMITS.deltaMaxKeys) full = true;
        else patch.push(...(await delta(tx, datastoreId, touched.map((t) => ({ type: t.entity_type as JournalEntityType, id: t.entity_id as string })))));
      }
      if (full) {
        patch.length = 0;
        patch.push({ op: "clear" }, ...(await fullState(tx, datastoreId)));
      }
      patch.splice(full ? 1 : 0, 0, { op: "put", key: WORKFLOW_KEY, value: await loadWorkflow(tx, datastoreId) });

      const lastMutationIdChanges: Record<string, number> = {};
      const owner = opts.clientsOf === undefined ? caller.principalId : opts.clientsOf;
      if (owner !== null) {
        const switched = owner !== caller.principalId;
        if (switched) await tx`SELECT set_config('records.principal_id', ${owner}, true)`;
        const clients = await tx`
          SELECT client_id, last_mutation_id FROM records.client_mutations
           WHERE datastore_id = ${datastoreId} AND client_group_id = ${req.clientGroupId}`;
        if (switched) await tx`SELECT set_config('records.principal_id', ${caller.principalId}, true)`;
        for (const c of clients) lastMutationIdChanges[c.client_id as string] = Number(c.last_mutation_id);
      }

      return { cookie: head, lastMutationIdChanges, patch };
    }, 3, { isolation: "repeatable read", readOnly: true });

    if (JSON.stringify(response).length > SYNC_LIMITS.pullMaxBytes) tooLarge("data");
    return response;
  }
}

async function delta(tx: Tx, datastoreId: string, touched: { type: JournalEntityType; id: string }[]): Promise<PatchOp[]> {
  const ids = (type: JournalEntityType) => touched.filter((t) => t.type === type).map((t) => t.id).toSorted();
  const current = new Map<string, unknown>();
  const projectIds = ids("project");
  const issueIds = ids("issue");
  const commentIds = ids("comment");
  if (projectIds.length) {
    for (const r of await tx`SELECT * FROM projects.projects WHERE datastore_id = ${datastoreId} AND id = ANY(${projectIds})`) {
      current.set(entityKey("project", r.id as string), toProject(r));
    }
  }
  if (issueIds.length) {
    for (const r of await tx`${issueSelect(tx, datastoreId)} AND i.id = ANY(${issueIds})`) current.set(entityKey("issue", r.id as string), toIssue(r));
  }
  if (commentIds.length) {
    for (const r of await tx`${commentSelect(tx, datastoreId)} AND c.id = ANY(${commentIds})`) current.set(entityKey("comment", r.id as string), toComment(r));
  }
  const patch: PatchOp[] = [];
  for (const type of JOURNAL_ENTITY_TYPES) {
    for (const id of ids(type)) {
      const key = entityKey(type, id);
      patch.push(current.has(key) ? { op: "put", key, value: current.get(key) } : { op: "del", key });
    }
  }
  return patch;
}

async function fullState(tx: Tx, datastoreId: string): Promise<PatchOp[]> {
  const projects = await tx`
    SELECT * FROM projects.projects WHERE datastore_id = ${datastoreId} ORDER BY id LIMIT ${SYNC_LIMITS.projects + 1}`;
  if (projects.length > SYNC_LIMITS.projects) tooLarge("projects");
  const issues = await tx`${issueSelect(tx, datastoreId)} ORDER BY i.id LIMIT ${SYNC_LIMITS.issues + 1}`;
  if (issues.length > SYNC_LIMITS.issues) tooLarge("issues");
  const comments = await tx`${commentSelect(tx, datastoreId)} ORDER BY c.id LIMIT ${SYNC_LIMITS.comments + 1}`;
  if (comments.length > SYNC_LIMITS.comments) tooLarge("comments");
  return [
    ...projects.map((r): PatchOp => ({ op: "put", key: entityKey("project", r.id as string), value: toProject(r) })),
    ...issues.map((r): PatchOp => ({ op: "put", key: entityKey("issue", r.id as string), value: toIssue(r) })),
    ...comments.map((r): PatchOp => ({ op: "put", key: entityKey("comment", r.id as string), value: toComment(r) })),
  ];
}
