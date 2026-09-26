import { describe, expect, it } from "vitest";
import { createReplica, diffData, sameValue } from "../../src/shared/replica.js";

const A = "cloudflare-os:ada@example.com", B = "cloudflare-os:bob@example.com";
const rec = (id, revision, data, extra = {}) => ({ id, entity: "work_item", revision, data, ...extra });
const ch = (seq, id, data, actor = A, extra = {}) => ({ seq, ordinal: 0, entity: "work_item", record_id: id, revision: seq, actor, data, ...extra });

/** A tiny journal-backed source. */
function source(journal, { epoch = 1, head } = {}) {
  const calls = [];
  const s = {
    calls, epoch, journal,
    async snapshot(limit) {
      calls.push(["snapshot", limit]);
      const rows = new Map();
      for (const c of journal) rows.set(c.record_id, rec(c.record_id, c.revision, c.data, { created_by: rows.get(c.record_id)?.created_by ?? c.actor, updated_by: c.actor }));
      return { records: [...rows.values()], seq: head ?? journal.at(-1)?.seq ?? 0, permission_epoch: s.epoch };
    },
    async changes(after = 0, ep) {
      calls.push(["changes", after, ep]);
      if (ep !== undefined && ep !== s.epoch) throw new Error("reset_required: epoch changed");
      const page = journal.filter((c) => c.seq > after).slice(0, 100);
      const top = journal.at(-1)?.seq ?? 0;
      return { changes: page, cursor: page.length === 100 ? page.at(-1).seq : top, permission_epoch: s.epoch };
    },
  };
  return s;
}

describe("sameValue / diffData", () => {
  it.each([[1, 1, true], ["a", "b", false], [null, null, true], [[1], [1], true], [{ a: 1 }, { a: 2 }, false], [null, {}, false]])("sameValue(%j,%j)", (a, b, r) => expect(sameValue(a, b)).toBe(r));
  it("diffs added, removed and changed fields", () => {
    expect(diffData({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 })).toEqual({ b: [2, 3], c: [null, 4] });
    expect(diffData({ x: [1] }, {})).toEqual({ x: [[1], null] });
    expect(diffData({}, {})).toEqual({});
  });
});

describe("replica", () => {
  it("loads a snapshot", () => {
    const r = createReplica();
    expect(r.loaded).toBe(false);
    r.loadSnapshot({ records: [rec("a", 2, { title: "A" })], seq: 5, permission_epoch: 3 });
    expect(r.loaded).toBe(true);
    expect(r.cursor).toBe(5);
    expect(r.epoch).toBe(3);
    expect(r.records.get("a").data.title).toBe("A");
    expect(r.backfill.done).toBe(false);
  });

  it("an empty snapshot needs no backfill", () => {
    const r = createReplica();
    r.loadSnapshot({ records: [], seq: 0, permission_epoch: 1 });
    expect(r.backfill.done).toBe(true);
  });

  it("applies pages idempotently and ignores replays", () => {
    const r = createReplica();
    r.loadSnapshot({ records: [rec("a", 2, { title: "A" }, { created_by: A, updated_by: A })], seq: 2, permission_epoch: 1 });
    const v = r.version;
    expect(r.applyPage({ changes: [ch(1, "a", { title: "old" })], cursor: 2, permission_epoch: 1 })).toBe(false);
    expect(r.version).toBe(v);
    expect(r.applyPage({ changes: [ch(3, "a", { title: "A2" }, B)], cursor: 3, permission_epoch: 1 })).toBe(true);
    expect(r.applyPage({ changes: [ch(3, "a", { title: "A2" }, B)], cursor: 3, permission_epoch: 1 })).toBe(false);
    const a = r.records.get("a");
    expect(a).toMatchObject({ revision: 3, created_by: A, updated_by: B, data: { title: "A2" } });
    expect(r.history.get("a")).toHaveLength(1);
    expect(r.cursor).toBe(3);
  });

  it("new records take their creator from the first change", () => {
    const r = createReplica();
    r.loadSnapshot({ records: [], seq: 0, permission_epoch: 1 });
    r.applyPage({ changes: [ch(1, "n", { title: "N" }, B), ch(2, "n", { title: "N2" }, A)], cursor: 2, permission_epoch: 1 });
    expect(r.records.get("n")).toMatchObject({ created_by: B, updated_by: A, revision: 2 });
    const h = r.history.get("n");
    expect(h[0]).toMatchObject({ created: true, actor: B });
    expect(h[1]).toMatchObject({ created: false, actor: A, diff: { title: ["N", "N2"] } });
  });

  it("stamps live receipt time only when the journal has none", () => {
    let t = 1000;
    const r = createReplica({ now: () => t });
    r.loadSnapshot({ records: [], seq: 0, permission_epoch: 1 });
    r.applyPage({ changes: [ch(1, "x", { title: "X" })], cursor: 1, permission_epoch: 1 }, { live: true });
    expect(r.history.get("x")[0].at).toBe(1000);
    expect(r.times.get("x")).toEqual({ created: 1000, updated: 1000 });
    t = 2000;
    r.applyPage({ changes: [ch(2, "x", { title: "Y" }, A, { created_at: "2026-01-01T00:00:00Z" })], cursor: 2, permission_epoch: 1 }, { live: true });
    expect(r.history.get("x")[1].at).toBe(Date.parse("2026-01-01T00:00:00Z"));
    r.applyPage({ changes: [ch(3, "x", { title: "Z" })], cursor: 3, permission_epoch: 1 });
    expect(r.history.get("x")[2].at).toBeNull();
  });

  it("history bumps historyVersion; records bump version", () => {
    const r = createReplica();
    r.loadSnapshot({ records: [], seq: 0, permission_epoch: 1 });
    const v = r.version, hv = r.historyVersion;
    r.applyPage({ changes: [ch(1, "x", {})], cursor: 1, permission_epoch: 1 });
    expect(r.version).toBe(v + 1);
    expect(r.historyVersion).toBe(hv + 1);
  });

  it("caps history per record at 200", () => {
    const r = createReplica();
    r.loadSnapshot({ records: [], seq: 0, permission_epoch: 1 });
    const changes = Array.from({ length: 250 }, (_, i) => ch(i + 1, "x", { n: i }));
    r.applyPage({ changes, cursor: 250, permission_epoch: 1 });
    expect(r.history.get("x")).toHaveLength(200);
    expect(r.history.get("x")[0].seq).toBe(51);
  });

  it("reset forgets everything", () => {
    const r = createReplica();
    r.loadSnapshot({ records: [rec("a", 1, {})], seq: 1, permission_epoch: 1 });
    r.reset();
    expect(r.records.size).toBe(0);
    expect(r.loaded).toBe(false);
    expect(r.cursor).toBe(0);
  });

  it("pull loops over full pages until caught up", async () => {
    const journal = Array.from({ length: 250 }, (_, i) => ch(i + 1, `r${i % 30}`, { n: i }));
    const s = source(journal.slice(0, 10));
    const r = createReplica();
    await r.load(s);
    s.journal.push(...journal.slice(10));
    const out = await r.pull(s);
    expect(out).toEqual({ changed: true, reset: false });
    expect(r.cursor).toBe(250);
    expect(s.calls.filter((c) => c[0] === "changes")).toHaveLength(3);
    expect(r.records.get("r9").data.n).toBe(249);
  });

  it("pull with nothing new reports no change", async () => {
    const s = source([ch(1, "a", {})]);
    const r = createReplica();
    await r.load(s);
    expect(await r.pull(s)).toEqual({ changed: false, reset: false });
  });

  it("pull passes the epoch and re-snapshots on reset_required", async () => {
    const s = source([ch(1, "a", { t: 1 })]);
    const r = createReplica();
    await r.load(s);
    s.epoch = 2;
    s.journal.push(ch(2, "b", { t: 2 }));
    const out = await r.pull(s);
    expect(out).toEqual({ changed: true, reset: true });
    expect(r.epoch).toBe(2);
    expect(r.records.has("b")).toBe(true);
    expect(s.calls.filter((c) => c[0] === "snapshot")).toHaveLength(2);
  });

  it("pull propagates other errors", async () => {
    const r = createReplica();
    r.loadSnapshot({ records: [], seq: 0, permission_epoch: 1 });
    await expect(r.pull({ snapshot: async () => ({}), changes: async () => { throw new Error("unavailable: down"); } })).rejects.toThrow(/unavailable/);
  });

  it("backfills history from seq 0 across pages up to the snapshot watermark", async () => {
    const journal = [];
    for (let i = 1; i <= 230; i++) journal.push(ch(i, `r${i % 5}`, { n: i }, i % 2 ? A : B));
    const s = source(journal, { head: 230 });
    const r = createReplica();
    await r.load(s);
    expect(r.history.size).toBe(0);
    // A change after the snapshot arrives live first.
    s.journal.push(ch(231, "r1", { n: 231 }));
    await r.pull(s);
    const v = r.version;
    let done = await r.backfillHistory(s, 1);
    expect(done).toBe(false);
    expect(r.backfill.cursor).toBe(100);
    expect(r.version).toBe(v); // records untouched until complete
    done = await r.backfillHistory(s, 5);
    expect(done).toBe(true);
    expect(r.version).toBe(v + 1);
    const h = r.history.get("r1");
    expect(h[0]).toMatchObject({ seq: 1, created: true, actor: A });
    expect(h[1].diff).toEqual({ n: [1, 6] });
    expect(h.at(-1).seq).toBe(231);
    // No entry past the watermark was double-counted.
    expect(new Set(h.map((e) => e.seq)).size).toBe(h.length);
    expect(await r.backfillHistory(s)).toBe(true);
  });

  it("backfill stops if the epoch changes mid-way", async () => {
    const journal = Array.from({ length: 150 }, (_, i) => ch(i + 1, "a", { n: i }));
    const s = source(journal);
    const r = createReplica();
    await r.load(s);
    s.changes = async () => { r.loadSnapshot({ records: [], seq: 150, permission_epoch: 9 }); return { changes: [], cursor: 150, permission_epoch: 9 }; };
    expect(await r.backfillHistory(s, 3)).toBe(false);
    expect(r.backfill.running).toBe(false);
  });
});
