// Journal reads for operator tools: fold a datastore's journal into entity state, knowing nothing
// but the journal (the rebuild invariant of canonical plan §3). Operator tools connect as the
// migration owner, so these reads bypass row-level security and take no trusted context.
//
// Worker-safe (no Node APIs), like the rest of @records/core, although only the Node CLI calls it.

import type { Sql } from "postgres";

export type OpsEntityType = "project" | "issue" | "comment";

/** The content fields a restore compares and writes, per entity type (wire names). */
export const CONTENT_FIELDS: Record<OpsEntityType, readonly string[]> = {
  project: ["name", "description"],
  issue: ["title", "description", "state", "priority", "assigneeId", "customFields"],
  comment: ["body"],
};

export type JournalRow = {
  seq: number;
  ordinal: number;
  changeId: string;
  command: string;
  entityType: OpsEntityType;
  entityId: string;
  entityRev: number;
  op: "create" | "update" | "archive" | "restore" | "redact";
  after: Record<string, unknown>;
  before: Record<string, unknown> | null;
  actorId: string;
  actId: string | null;
  via: string;
  occurredAt: string;
};

export type EntityState = {
  type: OpsEntityType;
  id: string;
  /** Every field ever journaled for the entity, latest value wins (wire names). */
  fields: Record<string, unknown>;
  /** The seq that last set each field. */
  fieldSeq: Record<string, number>;
  rev: number;
  createdBy: string;
  lastSeq: number;
  archived: boolean;
};

export function toJournalRow(r: Record<string, unknown>): JournalRow {
  return {
    seq: Number(r.seq),
    ordinal: Number(r.ordinal),
    changeId: r.change_id as string,
    command: r.command as string,
    entityType: r.entity_type as OpsEntityType,
    entityId: r.entity_id as string,
    entityRev: Number(r.entity_rev),
    op: r.op as JournalRow["op"],
    after: r.after as Record<string, unknown>,
    before: (r.before as Record<string, unknown> | null) ?? null,
    actorId: r.actor_id as string,
    actId: (r.act_id as string | null) ?? null,
    via: r.via as string,
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
  };
}

/** Folds journal entries, in (seq, ordinal) order, into entity state. */
export class JournalFold {
  readonly state = new Map<string, EntityState>();

  apply(e: JournalRow): void {
    const cur = this.state.get(e.entityId);
    const seqs = Object.fromEntries(Object.keys(e.after).map((k) => [k, e.seq]));
    // `restore` re-materialises an entity whose row was lost (per-datastore restore): a create when
    // the fold has no such entity, otherwise an update.
    if (e.op === "create" || (e.op === "restore" && !cur)) {
      if (cur) throw new Error(`Journal replay: ${e.entityType} ${e.entityId} created twice (seq ${e.seq}).`);
      this.state.set(e.entityId, {
        type: e.entityType, id: e.entityId, fields: { ...e.after }, fieldSeq: seqs, rev: e.entityRev, createdBy: e.actorId, lastSeq: e.seq, archived: false,
      });
      return;
    }
    if (!cur) throw new Error(`Journal replay: ${e.op} of ${e.entityType} ${e.entityId} before its create (seq ${e.seq}).`);
    cur.fields = { ...cur.fields, ...e.after };
    cur.fieldSeq = { ...cur.fieldSeq, ...seqs };
    cur.rev = e.entityRev;
    cur.lastSeq = e.seq;
    if (e.op === "archive") cur.archived = true;
    if (e.op === "restore") cur.archived = false;
  }
}

/** The clock head and journal bounds of one datastore. */
export async function journalBounds(sql: Sql, datastoreId: string): Promise<{ orgId: string; head: number; earliest: number | null; latest: number | null }> {
  const [row] = await sql`
    SELECT d.org_id, c.seq AS head,
           (SELECT min(seq) FROM records.journal WHERE datastore_id = d.id) AS earliest,
           (SELECT max(seq) FROM records.journal WHERE datastore_id = d.id) AS latest
      FROM records.datastores d JOIN records.datastore_clock c ON c.datastore_id = d.id
     WHERE d.id = ${datastoreId}`;
  if (!row) throw new Error(`Unknown datastore ${datastoreId}.`);
  return {
    orgId: row.org_id as string,
    head: Number(row.head),
    earliest: row.earliest == null ? null : Number(row.earliest),
    latest: row.latest == null ? null : Number(row.latest),
  };
}

/**
 * The last seq whose whole prefix began at or before `at`: one less than the first seq with a
 * later occurred_at. occurred_at is the transaction's start, so a transaction that began before
 * `at` but committed after a later-starting one is excluded, never half-included.
 */
export async function seqAtTime(sql: Sql, datastoreId: string, at: Date): Promise<number> {
  const [row] = await sql`
    SELECT (SELECT min(seq) FROM records.journal WHERE datastore_id = ${datastoreId} AND occurred_at > ${at}) AS first_after,
           (SELECT max(seq) FROM records.journal WHERE datastore_id = ${datastoreId}) AS latest`;
  if (row!.first_after != null) return Number(row!.first_after) - 1;
  return row!.latest == null ? 0 : Number(row!.latest);
}

/** Fold a datastore's journal from seq 1 to `uptoSeq`. Refuses an incomplete journal. */
export async function rebuildAt(sql: Sql, datastoreId: string, uptoSeq: number): Promise<JournalFold> {
  const fold = new JournalFold();
  if (uptoSeq === 0) return fold;
  const [shape] = await sql`
    SELECT min(seq) AS lo, count(DISTINCT seq) AS n FROM records.journal WHERE datastore_id = ${datastoreId} AND seq <= ${uptoSeq}`;
  if (Number(shape!.lo ?? 0) !== 1 || Number(shape!.n) !== uptoSeq) {
    throw new Error(
      `The journal of ${datastoreId} does not cover seq 1..${uptoSeq} (it starts at ${String(shape!.lo ?? "none")} with ${String(shape!.n)} seqs). ` +
        "Archived partitions cannot be replayed by this tool.",
    );
  }
  const cursor = sql`
    SELECT seq, ordinal, change_id, command, entity_type, entity_id, entity_rev, op, after, before, actor_id, act_id, via, occurred_at
      FROM records.journal WHERE datastore_id = ${datastoreId} AND seq <= ${uptoSeq}
     ORDER BY seq, ordinal`.cursor(1000);
  for await (const rows of cursor) for (const r of rows) fold.apply(toJournalRow(r));
  return fold;
}

/** Deterministic JSON with sorted keys, for comparing values such as custom fields. */
export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).toSorted().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}
