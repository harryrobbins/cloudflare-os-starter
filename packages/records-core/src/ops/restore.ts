// Per-datastore restore by journal replay (canonical plan §8, acceptance §11.7).
//
// The source is a database holding the datastore's journal at least up to the chosen point: in
// production, a Neon branch restored to a time before the damage. The journal is append-only, so
// that branch's entries up to `uptoSeq` are the same entries production still holds. The desired
// state is the source journal folded up to `uptoSeq`. The target (production, owner connection) is
// brought to it by NEW journal entries, command `system.restoreDatastore`, via `system`: history is
// never rewritten, and the restore is itself recorded (journal, audit event, outbox events). Only
// the named datastore is touched; every other datastore's rows, journal and clock stay byte for byte.
//
// What it can do, per entity the model journals (projects, issues, comments):
//   * update a project's name and description, and an issue's title, description, state, priority,
//     assignee and custom fields, back to their values at `uptoSeq`;
//   * recreate, with its original ID, a project, issue or comment that existed at `uptoSeq` and is
//     missing from the target, journaled as op `restore` (the journal never recorded its loss, so
//     it is not a second `create`).
// What it cannot do, and reports instead:
//   * remove an entity created after `uptoSeq` (`cannotRemove`): the model has no delete or archive
//     yet, so nothing can journal a removal;
//   * change a comment's body, a project's key or an issue's project or number (`unresolved`): no
//     journaled command changes them;
//   * restore workflow states, transitions, custom field definitions, memberships or bindings: they
//     are configuration, not journaled; an issue whose old state no longer exists is `unresolved`;
//   * replay a journal whose early partitions were archived (rebuildAt refuses).
// Redactions recorded in the target (records_ops.redactions) are re-applied to the desired state,
// so restoring from a branch taken before a redaction never brings the text back.
//
// Locking: the target's rows of this datastore are read FOR UPDATE, then the clock is taken last,
// the same order as every command, so concurrent writers wait rather than interleave.

import type { Sql } from "postgres";

import { uuidv7 } from "../bus/uuidv7.js";
import { canonical, CONTENT_FIELDS, journalBounds, rebuildAt, seqAtTime, type EntityState, type OpsEntityType } from "./journal.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Journal entries per seq. ordinal is a smallint; one restore may span several seqs in one transaction. */
const CHUNK = 1000;

export type RestoreOptions = {
  /** Holds the journal up to the restore point: a restored branch (owner or any role that bypasses RLS). */
  source: Sql;
  /** Production, as the migration owner. */
  target: Sql;
  datastoreId: string;
  /** Exactly one of uptoSeq and uptoTime. */
  uptoSeq?: number;
  uptoTime?: Date | string;
  /** The operator's principal, in the datastore's organisation: the journal actor and audit actor. */
  actorId: string;
  reason?: string;
  /** Compute and return the plan; write nothing and lock nothing. */
  dryRun?: boolean;
};

/** `restore` recreates, with its original ID, an entity that existed at the restore point and is missing now. */
export type RestoreChange = { entityType: OpsEntityType; entityId: string; op: "restore" | "update"; fields: string[] };
export type RestoreProblem = { entityType: OpsEntityType; entityId: string; reason: string };

export type RestoreReport = {
  datastoreId: string;
  orgId: string;
  uptoSeq: number;
  sourceHead: number;
  targetHeadBefore: number;
  targetHeadAfter: number;
  applied: boolean;
  /** Seqs the restore journaled (empty on a dry run or when nothing differed). */
  seqs: number[];
  commandId: string | null;
  changes: RestoreChange[];
  cannotRemove: RestoreProblem[];
  unresolved: RestoreProblem[];
  redactionsReapplied: number;
};

type Row = Record<string, unknown>;
type Target = { type: OpsEntityType; id: string; fields: Record<string, unknown>; rev: number; row: Row };
type Planned = RestoreChange & {
  after: Record<string, unknown>;
  before: Record<string, unknown> | null;
  rev: number;
  source: EntityState;
};

function targetEntity(type: OpsEntityType, r: Row): Target {
  const id = r.id as string;
  if (type === "project") {
    return { type, id, rev: r.revision as number, row: r, fields: { key: r.key, name: r.name, description: r.description } };
  }
  if (type === "issue") {
    return {
      type, id, rev: r.revision as number, row: r,
      fields: {
        projectId: r.project_id, number: r.number, title: r.title, description: r.description, state: r.state,
        priority: r.priority, assigneeId: r.assignee_id ?? null, customFields: r.custom_fields,
      },
    };
  }
  return { type, id, rev: 1, row: r, fields: { issueId: r.issue_id, body: r.body, authorId: r.author_id } };
}

const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

export async function restoreDatastore(opts: RestoreOptions): Promise<RestoreReport> {
  const { source, target, datastoreId, actorId } = opts;
  if (!UUID.test(datastoreId) || !UUID.test(actorId)) throw new Error("datastoreId and actorId must be UUIDs.");
  if ((opts.uptoSeq === undefined) === (opts.uptoTime === undefined)) throw new Error("Give exactly one of uptoSeq and uptoTime.");

  const src = await journalBounds(source, datastoreId);
  let uptoSeq: number;
  if (opts.uptoSeq !== undefined) {
    uptoSeq = opts.uptoSeq;
  } else {
    const at = new Date(opts.uptoTime!);
    if (Number.isNaN(at.getTime())) throw new Error("uptoTime is not a valid time.");
    uptoSeq = await seqAtTime(source, datastoreId, at);
  }
  if (!Number.isSafeInteger(uptoSeq) || uptoSeq < 0) throw new Error("uptoSeq must be a non-negative integer.");
  if (uptoSeq > src.head) throw new Error(`The source's clock is at ${src.head}; it cannot restore to seq ${uptoSeq}.`);

  const tgt = await journalBounds(target, datastoreId);
  if (tgt.orgId !== src.orgId) throw new Error("The source and target disagree about the datastore's organisation.");
  if (uptoSeq > tgt.head) throw new Error(`The target's clock is at ${tgt.head}, behind seq ${uptoSeq}: that is not a restore.`);
  const [actor] = await target`SELECT 1 FROM records.principals WHERE id = ${actorId} AND org_id = ${tgt.orgId}`;
  if (!actor) throw new Error("The actor must be a principal of the datastore's organisation.");

  // The source must hold the same history as the target: compare change IDs over the seqs both hold.
  const lo = Math.max(1, tgt.earliest ?? 1);
  if (uptoSeq >= lo) {
    const digest = async (sql: Sql) =>
      (await sql`
        SELECT md5(string_agg(change_id::text, ',' ORDER BY seq, ordinal)) AS d
          FROM records.journal WHERE datastore_id = ${datastoreId} AND seq BETWEEN ${lo} AND ${uptoSeq}`)[0]!.d as string | null;
    if ((await digest(source)) !== (await digest(target))) {
      throw new Error(`The source's journal differs from the target's for seq ${lo}..${uptoSeq}: wrong branch or wrong database.`);
    }
  }

  const desired = (await rebuildAt(source, datastoreId, uptoSeq)).state;

  const run = async (tx: Sql): Promise<RestoreReport> => {
    const lock = opts.dryRun ? tx.unsafe("") : tx.unsafe("FOR UPDATE");
    const current = new Map<string, Target>();
    for (const r of await tx`SELECT * FROM projects.projects WHERE datastore_id = ${datastoreId} ORDER BY id ${lock}`) current.set(r.id as string, targetEntity("project", r));
    for (const r of await tx`SELECT * FROM projects.issues WHERE datastore_id = ${datastoreId} ORDER BY id ${lock}`) current.set(r.id as string, targetEntity("issue", r));
    for (const r of await tx`SELECT * FROM projects.comments WHERE datastore_id = ${datastoreId} ORDER BY id ${lock}`) current.set(r.id as string, targetEntity("comment", r));

    // Re-apply the target's redactions: a field whose value at the restore point was set at or
    // before a redaction's seq held redacted text, so it gets that redaction's marker.
    let redactionsReapplied = 0;
    for (const r of await tx`SELECT entity_id, fields, seq, marker FROM records_ops.redactions WHERE datastore_id = ${datastoreId} ORDER BY seq`) {
      const e = desired.get(r.entity_id as string);
      if (!e) continue;
      for (const f of r.fields as string[]) {
        if (!(f in e.fields) || e.fieldSeq[f]! > Number(r.seq) || e.fields[f] === r.marker) continue;
        e.fields[f] = r.marker;
        redactionsReapplied++;
      }
    }

    const states = new Set((await tx`SELECT key FROM projects.workflow_states WHERE datastore_id = ${datastoreId}`).map((r) => r.key as string));
    const principals = new Set((await tx`SELECT id FROM records.principals WHERE org_id = ${tgt.orgId}`).map((r) => r.id as string));
    const projectKeys = new Map<string, string>();
    const issueNumbers = new Set<string>();
    for (const t of current.values()) {
      if (t.type === "project") projectKeys.set(t.fields.key as string, t.id);
      if (t.type === "issue") issueNumbers.add(`${t.fields.projectId as string}/${String(t.fields.number)}`);
    }

    const missing = [...desired.keys()].filter((id) => !current.has(id));
    const lastRevs = new Map<string, number>();
    if (missing.length > 0) {
      for (const r of await tx`
        SELECT entity_id, max(entity_rev) AS rev FROM records.journal
         WHERE datastore_id = ${datastoreId} AND entity_id = ANY(${missing}::uuid[]) GROUP BY entity_id`) {
        lastRevs.set(r.entity_id as string, Number(r.rev));
      }
    }

    const planned: Planned[] = [];
    const cannotRemove: RestoreProblem[] = [];
    const unresolved: RestoreProblem[] = [];
    const willExist = new Set(current.keys());
    const problem = (e: { type: OpsEntityType; id: string }, reason: string) => unresolved.push({ entityType: e.type, entityId: e.id, reason });

    for (const type of ["project", "issue", "comment"] as const) {
      const wanted = [...desired.values()].filter((e) => e.type === type).toSorted((a, b) => a.lastSeq - b.lastSeq || a.id.localeCompare(b.id));
      for (const e of wanted) {
        const f = e.fields;
        const now = current.get(e.id);
        if (e.archived) {
          problem(e, "archived at the restore point; the model has no archive yet");
          continue;
        }
        if (!now) {
          // Recreate with its original ID.
          if (type === "project") {
            if (projectKeys.has(f.key as string)) { problem(e, `project key ${String(f.key)} is now used by ${projectKeys.get(f.key as string)}`); continue; }
            projectKeys.set(f.key as string, e.id);
          } else if (type === "issue") {
            if (!willExist.has(f.projectId as string)) { problem(e, "its project does not exist"); continue; }
            if (issueNumbers.has(`${f.projectId as string}/${String(f.number)}`)) { problem(e, `issue number ${String(f.number)} is taken`); continue; }
            if (!states.has(f.state as string)) { problem(e, `workflow state ${String(f.state)} no longer exists`); continue; }
            if (f.assigneeId && !principals.has(f.assigneeId as string)) { problem(e, "its assignee no longer exists"); continue; }
            issueNumbers.add(`${f.projectId as string}/${String(f.number)}`);
          } else {
            if (!willExist.has(f.issueId as string)) { problem(e, "its issue does not exist"); continue; }
            if (!principals.has(f.authorId as string)) { problem(e, "its author no longer exists"); continue; }
          }
          willExist.add(e.id);
          const after: Record<string, unknown> =
            type === "project" ? { key: f.key, name: f.name, description: f.description ?? "" }
            : type === "issue" ? {
                projectId: f.projectId, number: f.number, key: f.key, title: f.title, description: f.description ?? "", state: f.state,
                priority: f.priority ?? "none", assigneeId: f.assigneeId ?? null, customFields: f.customFields ?? {},
              }
            : { issueId: f.issueId, body: f.body, authorId: f.authorId };
          // The journal never recorded the loss, so this is not a second create: op `restore`, with the
          // revision after the highest the target's journal ever gave it.
          const rev = type === "comment" ? 1 : Math.max(e.rev, lastRevs.get(e.id) ?? 0) + 1;
          planned.push({ entityType: type, entityId: e.id, op: "restore", fields: Object.keys(after), after, before: null, rev, source: e });
          continue;
        }
        // Present: immutable fields must agree; content fields are restored.
        if (type === "project" && !same(now.fields.key, f.key)) problem(e, "its key changed; keys are immutable");
        if (type === "issue" && (!same(now.fields.projectId, f.projectId) || !same(now.fields.number, f.number))) {
          problem(e, "its project or number changed; they are immutable");
          continue;
        }
        const after: Record<string, unknown> = {};
        const before: Record<string, unknown> = {};
        for (const field of CONTENT_FIELDS[type]) {
          if (!(field in f)) continue;
          if (same(now.fields[field], f[field])) continue;
          after[field] = f[field] ?? null;
          before[field] = now.fields[field] ?? null;
        }
        if (Object.keys(after).length === 0) continue;
        if (type === "comment") { problem(e, "its body differs; comments are append-only"); continue; }
        if ("state" in after && !states.has(after.state as string)) { problem(e, `workflow state ${String(after.state)} no longer exists`); continue; }
        if (after.assigneeId && !principals.has(after.assigneeId as string)) { problem(e, "its assignee no longer exists"); continue; }
        planned.push({ entityType: type, entityId: e.id, op: "update", fields: Object.keys(after), after, before, rev: now.rev + 1, source: e });
      }
    }
    for (const t of current.values()) {
      if (!desired.has(t.id)) cannotRemove.push({ entityType: t.type, entityId: t.id, reason: "created after the restore point; the model cannot remove it" });
    }

    const report: RestoreReport = {
      datastoreId, orgId: tgt.orgId, uptoSeq, sourceHead: src.head, targetHeadBefore: tgt.head, targetHeadAfter: tgt.head,
      applied: false, seqs: [], commandId: null, redactionsReapplied,
      changes: planned.map(({ entityType, entityId, op, fields }) => ({ entityType, entityId, op, fields })),
      cannotRemove, unresolved,
    };
    if (opts.dryRun || planned.length === 0) return report;

    const commandId = uuidv7();
    await tx`
      INSERT INTO records.audit_events (org_id, id, datastore_id, operation, actor_principal_id, via, target_type, target_id, summary, detail)
      VALUES (${tgt.orgId}, ${crypto.randomUUID()}, ${datastoreId}, 'restoreDatastore', ${actorId}, 'system', 'datastore', ${datastoreId},
              ${`Restored to seq ${uptoSeq} by journal replay: ${planned.length} change(s)`},
              ${tx.json({
                uptoSeq, sourceHead: src.head, commandId, changes: planned.length, cannotRemove: cannotRemove.length,
                unresolved: unresolved.length, redactionsReapplied, reason: opts.reason ?? null,
              })})`;
    for (const p of planned) {
      const event =
        p.entityType === "issue" ? (p.op === "restore" ? "issue.created" : "issue.updated")
        : p.op === "restore" ? `${p.entityType}.created` : null; // there is no project.updated event
      if (!event) continue;
      await tx`
        INSERT INTO records.outbox (event_id, org_id, datastore_id, event_type, entity_type, entity_id, revision)
        VALUES (${crypto.randomUUID()}, ${tgt.orgId}, ${datastoreId}, ${event}, ${p.entityType}, ${p.entityId}, ${p.rev})`;
    }

    for (let i = 0; i < planned.length; i += CHUNK) {
      const chunk = planned.slice(i, i + CHUNK);
      const [clock] = await tx`UPDATE records.datastore_clock SET seq = seq + 1 WHERE datastore_id = ${datastoreId} RETURNING seq`;
      const seq = Number(clock!.seq);
      report.seqs.push(seq);
      for (const p of chunk) await writeRow(tx, tgt.orgId, datastoreId, actorId, seq, p);
      const rows = chunk.map((p, ordinal) => ({
        ordinal, change_id: uuidv7(), entity_type: p.entityType, entity_id: p.entityId, entity_rev: p.rev, op: p.op, after: p.after, before: p.before,
      }));
      await tx`
        INSERT INTO records.journal (org_id, datastore_id, seq, ordinal, change_id, command, command_id, entity_type, entity_id,
                                     entity_rev, op, after, before, actor_id, act_id, via)
        SELECT ${tgt.orgId}, ${datastoreId}, ${seq}, e.ordinal, e.change_id, 'system.restoreDatastore', ${commandId}, e.entity_type,
               e.entity_id, e.entity_rev, e.op, e.after, e.before, ${actorId}, NULL, 'system'
          FROM jsonb_to_recordset(${tx.json(rows as never)}) AS e(ordinal smallint, change_id uuid, entity_type text, entity_id uuid,
                                                                  entity_rev int, op text, after jsonb, before jsonb)`;
    }
    report.applied = true;
    report.commandId = commandId;
    report.targetHeadAfter = report.seqs.at(-1)!;
    return report;
  };

  if (opts.dryRun) return run(target);
  return (await target.begin((tx) => run(tx as unknown as Sql))) as RestoreReport;
}

async function writeRow(tx: Sql, orgId: string, datastoreId: string, actorId: string, seq: number, p: Planned): Promise<void> {
  const a = p.after;
  if (p.op === "update") {
    if (p.entityType === "project") {
      await tx`
        UPDATE projects.projects SET
          name = ${"name" in a ? (a.name as string) : tx`name`}, description = ${"description" in a ? (a.description as string) : tx`description`},
          revision = ${p.rev}, last_seq = ${seq}, updated_by = ${actorId}, updated_at = now()
         WHERE datastore_id = ${datastoreId} AND id = ${p.entityId}`;
    } else {
      const col = (field: string, column: string, cast = "") =>
        field in a ? (field === "customFields" ? tx`${tx.json(a[field] as never)}` : tx`${a[field] as string | null}${tx.unsafe(cast)}`) : tx.unsafe(column);
      await tx`
        UPDATE projects.issues SET
          title = ${col("title", "title")}, description = ${col("description", "description")}, state = ${col("state", "state")},
          priority = ${col("priority", "priority")}, assignee_id = ${col("assigneeId", "assignee_id", "::uuid")},
          custom_fields = ${col("customFields", "custom_fields")},
          revision = ${p.rev}, last_seq = ${seq}, updated_by = ${actorId}, updated_at = now()
         WHERE datastore_id = ${datastoreId} AND id = ${p.entityId}`;
    }
    return;
  }
  if (p.entityType === "project") {
    await tx`
      INSERT INTO projects.projects (org_id, datastore_id, id, key, name, description, revision, created_by, updated_by, last_seq)
      VALUES (${orgId}, ${datastoreId}, ${p.entityId}, ${a.key as string}, ${a.name as string}, ${a.description as string}, ${p.rev},
              ${p.source.createdBy}, ${actorId}, ${seq})`;
  } else if (p.entityType === "issue") {
    await tx`
      INSERT INTO projects.issues (org_id, datastore_id, id, project_id, number, title, description, state, priority,
                                   assignee_id, custom_fields, revision, created_by, updated_by, last_seq)
      VALUES (${orgId}, ${datastoreId}, ${p.entityId}, ${a.projectId as string}, ${a.number as number}, ${a.title as string},
              ${a.description as string}, ${a.state as string}, ${a.priority as string}, ${(a.assigneeId as string | null) ?? null},
              ${tx.json(a.customFields as never)}, ${p.rev}, ${p.source.createdBy}, ${actorId}, ${seq})`;
    // Bookkeeping (not journaled content): never hand the recreated number out again.
    await tx`
      UPDATE projects.projects SET next_issue_number = greatest(next_issue_number, ${(a.number as number) + 1})
       WHERE datastore_id = ${datastoreId} AND id = ${a.projectId as string}`;
  } else {
    await tx`
      INSERT INTO projects.comments (org_id, datastore_id, id, issue_id, body, author_id, last_seq)
      VALUES (${orgId}, ${datastoreId}, ${p.entityId}, ${a.issueId as string}, ${a.body as string}, ${a.authorId as string}, ${seq})`;
  }
}
