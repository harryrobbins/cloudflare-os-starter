// The per-datastore clock (canonical plan §3): gapless seqs in commit order under concurrency,
// no contention between datastores, and no reader can see seq n+1 before n commits.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWorld, key, type World } from "./world.js";

/** A gate the bus hook can wait on, per datastore. */
class Gates {
  private readonly held = new Map<string, { reached: () => void; release: Promise<void>; seq?: number }>();
  hold(datastoreId: string): { reached: Promise<number>; release: () => void } {
    let release!: () => void;
    let reached!: (seq: number) => void;
    const reachedP = new Promise<number>((r) => (reached = r));
    const releaseP = new Promise<void>((r) => (release = r));
    this.held.set(datastoreId, { reached: () => {}, release: releaseP });
    const entry = this.held.get(datastoreId)!;
    entry.reached = () => reached(entry.seq!);
    return { reached: reachedP, release };
  }
  private readonly failing = new Set<string>();
  fail(datastoreId: string): void {
    this.failing.add(datastoreId);
  }
  async afterClock(datastoreId: string, seq: number): Promise<void> {
    if (this.failing.delete(datastoreId)) throw new Error("injected failure after the clock");
    const gate = this.held.get(datastoreId);
    if (!gate) return;
    this.held.delete(datastoreId); // only the first transaction to take the clock waits
    gate.seq = seq;
    gate.reached();
    await gate.release;
  }
}

const gates = new Gates();
let w: World;
beforeAll(async () => {
  w = await createWorld({ hooks: { afterClock: (ds, seq) => gates.afterClock(ds, seq) }, max: 40 });
});
afterAll(async () => w?.close());

const head = async (ds: string) => (await w.service.journal.changes(w.olive.caller, ds, {})).head;

describe("per-datastore clock", () => {
  it("N parallel writers on one datastore get gapless seqs, and seq order is commit order", async () => {
    const start = await head(w.ds1);
    const N = 30;
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      w.service.projects.createIssue(i % 2 ? w.ed.caller : w.olive.caller, w.ds1, { projectId: w.eng, title: `Parallel ${i}` }, key())));
    const seqs = results.map((r) => r.seq!).toSorted((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => start + 1 + i));
    expect(await head(w.ds1)).toBe(start + N);

    // Commit timestamps (track_commit_timestamp=on in tests) never decrease as seq increases.
    const rows = await w.owner`
      SELECT seq, pg_xact_commit_timestamp(xmin) AS committed FROM records.journal
       WHERE datastore_id = ${w.ds1} AND seq > ${start} ORDER BY seq`;
    const times = rows.map((r) => (r.committed as Date).getTime());
    expect(times).toEqual(times.toSorted((a, b) => a - b));
    // Issue numbers were allocated under the project lock, before the clock: all distinct.
    expect(new Set(results.map((r) => r.record.number)).size).toBe(N);
  });

  it("two datastores do not block each other", async () => {
    const gate = gates.hold(w.ds1);
    const blocked = w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Holding ds1's clock" }, key());
    await gate.reached;
    // ds1's clock row is locked by an open transaction; ds2 commits regardless.
    const other = await w.service.projects.createIssue(w.ed.caller, w.ds2, { projectId: w.ops, title: "ds2 is free" }, key());
    expect(other.seq).toBeGreaterThan(0);
    gate.release();
    await blocked;
  });

  it("a late commit: while seq n is held, no reader sees n+1, and the next writer waits", async () => {
    const before = await head(w.ds1);
    const gate = gates.hold(w.ds1);
    const first = w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Slow" }, key());
    const n = await gate.reached;
    expect(n).toBe(before + 1);

    let secondDone = false;
    const second = w.service.projects.createIssue(w.olive.caller, w.ds1, { projectId: w.eng, title: "Fast" }, key())
      .then((r) => { secondDone = true; return r; });
    await new Promise((r) => setTimeout(r, 150));
    expect(secondDone).toBe(false); // blocked on the clock row, behind the slow transaction

    const during = await w.service.journal.changes(w.rae.caller, w.ds1, { after: before });
    expect(during).toMatchObject({ entries: [], head: before, nextAfter: before });

    gate.release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.seq, b.seq]).toEqual([n, n + 1]);
    const after = await w.service.journal.changes(w.rae.caller, w.ds1, { after: before });
    expect(after.entries.map((e) => e.seq)).toEqual([n, n + 1]);
    expect(after.head).toBe(n + 1);
  });

  it("a transaction that fails after taking the clock gives its seq back", async () => {
    const before = await head(w.ds1);
    gates.fail(w.ds1);
    await expect(w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "Doomed" }, key())).rejects.toThrow(/injected/);
    const next = await w.service.projects.createIssue(w.ed.caller, w.ds1, { projectId: w.eng, title: "No gap" }, key());
    expect(next.seq).toBe(before + 1);
  });
});
