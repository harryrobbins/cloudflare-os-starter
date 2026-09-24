// Journal retention (canonical plan §8, "Retention"): export monthly journal partitions older than
// the retention window as NDJSON, then detach them, oldest first. The caller supplies the sink
// (the CLI gzips to a file for upload to R2); this module stays free of Node APIs.
//
// Invariants:
//   * A partition is detached only after its export resolved and only if its row count is
//     unchanged since the export, in the transaction that detaches it.
//   * Only a prefix of each datastore's journal is ever removed. seq is in commit order but
//     occurred_at is the transaction's START, so a transaction that straddles a month boundary can
//     leave a higher seq in an older partition. A partition is refused if any of its datastores
//     still has a lower seq elsewhere; later partitions then wait too.
//   * Readers already treat the smallest retained seq as the start of history: the changes feed
//     answers resetRequired and sync pull sends full state for a cursor or cookie before it.
//
// DETACH (not CONCURRENTLY, which a default partition forbids) takes an ACCESS EXCLUSIVE lock on
// the journal for a moment: journal writes pause while it runs. Run it at a quiet time.

import type { Sql } from "postgres";

export type JournalPartition = { name: string; from: Date; to: Date };

export type ArchiveOptions = {
  /** Owner connection. */
  db: Sql;
  /** Archive partitions whose whole month ended at least this many months before the current month. */
  olderThanMonths: number;
  /** Receives the partition's rows as NDJSON lines; resolves once they are safely stored. */
  exportTo: (name: string, lines: AsyncIterable<string>) => Promise<{ location: string; sha256?: string } | void>;
  /** List what would be archived; export and detach nothing. */
  dryRun?: boolean;
  /** Drop the detached table (default). false leaves it detached in `records`, unreachable through the journal. */
  dropDetached?: boolean;
};

export type ArchivedPartition = JournalPartition & {
  rows: number;
  seqRanges: Record<string, [number, number]>;
  status: "archived" | "eligible" | "refused" | "skipped";
  reason?: string;
  location?: string;
  sha256?: string;
};

export type ArchiveResult = { cutoff: Date; partitions: ArchivedPartition[]; defaultRowsBeforeCutoff: number };

export async function listJournalPartitions(sql: Sql): Promise<JournalPartition[]> {
  const rows = await sql`
    SELECT c.relname AS name,
           (regexp_match(pg_get_expr(c.relpartbound, c.oid), $$FROM [(]'([^']+)'[)]$$))[1]::timestamptz AS range_from,
           (regexp_match(pg_get_expr(c.relpartbound, c.oid), $$TO [(]'([^']+)'[)]$$))[1]::timestamptz AS range_to
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'records.journal'::regclass AND c.relname <> 'journal_default'
     ORDER BY 2`;
  return rows.map((r) => ({ name: r.name as string, from: r.range_from as Date, to: r.range_to as Date }));
}

async function* ndjson(sql: Sql, name: string): AsyncIterable<string> {
  const cursor = sql`
    SELECT org_id, datastore_id, seq, ordinal, change_id, command, command_id, entity_type, entity_id, entity_rev, op,
           after, before, actor_id, act_id, via, occurred_at
      FROM ${sql("records")}.${sql(name)} ORDER BY datastore_id, seq, ordinal`.cursor(1000);
  for await (const rows of cursor) {
    for (const r of rows) {
      yield `${JSON.stringify({
        ...r, seq: Number(r.seq), occurred_at: (r.occurred_at as Date).toISOString(),
      })}\n`;
    }
  }
}

export async function archiveJournalPartitions(opts: ArchiveOptions): Promise<ArchiveResult> {
  const { db } = opts;
  if (!Number.isInteger(opts.olderThanMonths) || opts.olderThanMonths < 1 || opts.olderThanMonths > 120) {
    throw new Error("olderThanMonths must be an integer from 1 to 120.");
  }
  const [c] = await db`
    SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') - make_interval(months => ${opts.olderThanMonths}) AS cutoff`;
  const cutoff = c!.cutoff as Date;
  const [d] = await db`SELECT count(*) AS n FROM records.journal_default WHERE occurred_at < ${cutoff}`;
  const result: ArchiveResult = { cutoff, partitions: [], defaultRowsBeforeCutoff: Number(d!.n) };

  let blocked: string | null = null;
  for (const part of await listJournalPartitions(db)) {
    if (part.to.getTime() > cutoff.getTime()) continue;
    const ranges = await db`
      SELECT datastore_id, min(seq) AS lo, max(seq) AS hi, count(*) AS n FROM ${db("records")}.${db(part.name)} GROUP BY datastore_id`;
    const seqRanges = Object.fromEntries(ranges.map((r) => [r.datastore_id as string, [Number(r.lo), Number(r.hi)] as [number, number]]));
    const rows = ranges.reduce((sum, r) => sum + Number(r.n), 0);
    const entry: ArchivedPartition = { ...part, rows, seqRanges, status: "eligible" };
    result.partitions.push(entry);
    if (blocked) {
      entry.status = "skipped";
      entry.reason = `an older partition (${blocked}) was refused`;
      continue;
    }
    // Only a prefix of each datastore's history may go.
    const straddle = ranges.length === 0 ? [] : await db`
      SELECT j.datastore_id, min(j.seq) AS lo FROM records.journal j
       WHERE j.tableoid <> ${`records.${part.name}`}::regclass AND j.datastore_id = ANY(${ranges.map((r) => r.datastore_id as string)}::uuid[])
       GROUP BY j.datastore_id`;
    const bad = straddle.filter((s) => Number(s.lo) <= seqRanges[s.datastore_id as string]![1]);
    if (bad.length > 0) {
      entry.status = "refused";
      entry.reason = `datastore ${bad[0]!.datastore_id as string} keeps seq ${String(bad[0]!.lo)} outside this partition, below its highest seq here`;
      blocked = part.name;
      continue;
    }
    if (opts.dryRun) continue;

    const stored = await opts.exportTo(`${part.name}.ndjson`, ndjson(db, part.name));
    const location = stored?.location ?? `${part.name}.ndjson`;
    await db.begin(async (tx) => {
      const [now] = await tx`SELECT count(*) AS n FROM ${tx("records")}.${tx(part.name)}`;
      if (Number(now!.n) !== rows) throw new Error(`${part.name} changed during its export (${rows} → ${String(now!.n)} rows); nothing was detached.`);
      await tx`ALTER TABLE records.journal DETACH PARTITION ${tx("records")}.${tx(part.name)}`;
      const drop = opts.dropDetached ?? true;
      if (drop) await tx`DROP TABLE ${tx("records")}.${tx(part.name)}`;
      await tx`
        INSERT INTO records_ops.journal_archives (partition, range_from, range_to, row_count, seq_ranges, location, sha256, dropped)
        VALUES (${part.name}, ${part.from}, ${part.to}, ${rows}, ${tx.json(seqRanges)}, ${location}, ${stored?.sha256 ?? null}, ${drop})`;
    });
    entry.status = "archived";
    entry.location = location;
    if (stored?.sha256) entry.sha256 = stored.sha256;
  }
  return result;
}
