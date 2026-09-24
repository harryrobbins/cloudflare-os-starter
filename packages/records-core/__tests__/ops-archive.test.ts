// Journal retention (canonical plan §8, "Retention"): old monthly partitions are exported as NDJSON
// and detached, oldest first, only ever removing a prefix of each datastore's history. Readers then
// treat the smallest retained seq as the start: older cursors and cookies get a reset.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { archiveJournalPartitions, listJournalPartitions } from "../src/ops/index.js";
import { createWorld, key, type World } from "./world.js";

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => w?.close());

function monthStart(monthsAgo: number): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsAgo, 1));
}
const partName = (d: Date) => `journal_${d.getUTCFullYear()}m${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** Create an old monthly partition and move one datastore's entries up to `uptoSeq` into it. */
async function backdate(monthsAgo: number, ds: string, fromSeq: number, uptoSeq: number): Promise<string> {
  const lo = monthStart(monthsAgo);
  const hi = monthStart(monthsAgo - 1);
  const name = partName(lo);
  await w.owner.begin(async (tx) => {
    if (!(await tx`SELECT to_regclass(${`records.${name}`}) AS r`)[0]!.r) {
      await tx.unsafe(`CREATE TABLE records.${name} PARTITION OF records.journal FOR VALUES FROM ('${lo.toISOString()}') TO ('${hi.toISOString()}')`);
      await tx.unsafe(`ALTER TABLE records.${name} ENABLE ROW LEVEL SECURITY`);
    }
    const at = new Date(lo.getTime() + 86_400_000);
    await tx`
      INSERT INTO records.journal
      SELECT org_id, datastore_id, seq, ordinal, change_id, command, command_id, entity_type, entity_id, entity_rev, op, after, before,
             actor_id, act_id, via, ${at}::timestamptz
        FROM records.journal WHERE datastore_id = ${ds} AND seq BETWEEN ${fromSeq} AND ${uptoSeq} AND occurred_at >= ${monthStart(0)}`;
    await tx`DELETE FROM records.journal WHERE datastore_id = ${ds} AND seq BETWEEN ${fromSeq} AND ${uptoSeq} AND occurred_at >= ${monthStart(0)}`;
  });
  return name;
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const l of lines) out.push(l);
  return out;
}

describe("archiveJournalPartitions", () => {
  it("exports and detaches old partitions, refuses one that would leave a gap, and readers reset", async () => {
    for (const t of ["One", "Two"]) await w.service.projects.createIssue(w.ed.caller, w.ds2, { projectId: w.ops, title: t }, key());
    await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Stays" }, key());
    const pulled = await w.service.sync.pull(w.ed.caller, w.ds2, { clientGroupId: "archive-group", cookie: null });

    const older = await backdate(5, w.ds2, 1, 2); // ds2's first two seqs: a clean prefix
    const straddling = await backdate(4, w.ds1, 2, 2); // ds1 seq 2 without seq 1: would leave a gap
    const before = await w.owner`SELECT count(*) AS n FROM records.journal`;

    // Dry run: the plan only.
    const plan = await archiveJournalPartitions({ db: w.owner, olderThanMonths: 3, exportTo: async () => { throw new Error("not called"); }, dryRun: true });
    expect(plan.partitions.map((p) => [p.name, p.status, p.rows])).toEqual([[older, "eligible", 2], [straddling, "refused", 1]]);
    expect(plan.partitions[0]!.seqRanges).toEqual({ [w.ds2]: [1, 2] });
    expect(plan.partitions[1]!.reason).toMatch(/keeps seq 1 outside this partition/);

    // A failed export detaches nothing.
    await expect(archiveJournalPartitions({ db: w.owner, olderThanMonths: 3, exportTo: async () => { throw new Error("R2 down"); } })).rejects.toThrow(/R2 down/);
    expect((await listJournalPartitions(w.owner)).map((p) => p.name)).toContain(older);
    expect(await w.owner`SELECT count(*) AS n FROM records.journal`).toEqual(before);

    // The real run.
    const exported = new Map<string, string[]>();
    const result = await archiveJournalPartitions({
      db: w.owner, olderThanMonths: 3,
      exportTo: async (name, lines) => {
        exported.set(name, await collect(lines));
        return { location: `r2://backups/journal/${name}.gz`, sha256: "0".repeat(64) };
      },
    });
    expect(result.partitions.map((p) => [p.name, p.status])).toEqual([[older, "archived"], [straddling, "refused"]]);
    const lines = exported.get(`${older}.ndjson`)!.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.datastore_id, l.seq])).toEqual([[w.ds2, 1], [w.ds2, 2]]);
    expect(lines[0]).toMatchObject({ op: "create", entity_type: "project", entity_id: w.ops, after: { key: "OPS" } });

    const names = (await listJournalPartitions(w.owner)).map((p) => p.name);
    expect(names).not.toContain(older);
    expect(names).toContain(straddling);
    expect((await w.owner`SELECT to_regclass(${`records.${older}`}) AS r`)[0]!.r).toBeNull(); // dropped
    expect(await w.owner`SELECT partition, row_count, seq_ranges, location, dropped FROM records_ops.journal_archives`).toEqual([
      { partition: older, row_count: "2", seq_ranges: { [w.ds2]: [1, 2] }, location: `r2://backups/journal/${older}.ndjson.gz`, dropped: true },
    ]);
    expect(Number((await w.owner`SELECT min(seq) AS m FROM records.journal WHERE datastore_id = ${w.ds2}`)[0]!.m)).toBe(3);

    // Readers: before the retained start means reset; at or after it, an ordinary delta.
    expect((await w.service.journal.changes(w.ed.caller, w.ds2, { after: 0 })).resetRequired).toBe(true);
    expect((await w.service.journal.changes(w.ed.caller, w.ds2, { after: 1 })).resetRequired).toBe(true);
    expect((await w.service.journal.changes(w.ed.caller, w.ds2, { after: 2 })).resetRequired).toBe(false);
    expect((await w.service.sync.pull(w.ed.caller, w.ds2, { clientGroupId: "archive-group", cookie: 0 })).patch[0]).toEqual({ op: "clear" });
    expect((await w.service.sync.pull(w.ed.caller, w.ds2, { clientGroupId: "archive-group", cookie: 1 })).patch[0]).toEqual({ op: "clear" });
    const fresh = await w.service.sync.pull(w.ed.caller, w.ds2, { clientGroupId: "archive-group", cookie: 2 });
    expect(fresh.patch[0]).not.toEqual({ op: "clear" });
    expect(pulled.cookie).toBeGreaterThanOrEqual(3);
    const current = await w.service.sync.pull(w.ed.caller, w.ds2, { clientGroupId: "archive-group", cookie: pulled.cookie });
    expect(current.patch).toEqual([{ op: "put", key: "meta/workflow", value: expect.any(Object) }]);

    // Writes carry on; nothing else moved.
    await w.service.projects.createIssue(w.ed.caller, w.ds2, { projectId: w.ops, title: "After archival" }, key());
    expect(Number((await w.owner`SELECT count(*) AS n FROM records.journal WHERE datastore_id = ${w.ds1}`)[0]!.n)).toBeGreaterThanOrEqual(2);
  });

  it("validates the window and archives nothing newer than it", async () => {
    await expect(archiveJournalPartitions({ db: w.owner, olderThanMonths: 0, exportTo: async () => {} })).rejects.toThrow(/1 to 120/);
    const none = await archiveJournalPartitions({ db: w.owner, olderThanMonths: 12, exportTo: async () => {}, dryRun: true });
    expect(none.partitions).toEqual([]);
    expect(none.cutoff.getTime()).toBe(monthStart(12).getTime());
  });
});
