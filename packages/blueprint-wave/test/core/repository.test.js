import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "../../src/core/repository.js";

const bid = (n) => "b_" + n.toString(16).padStart(12, "0");
const rid = (n) => "r_" + n.toString(16).padStart(12, "0");
const bytes = (...v) => Uint8Array.from(v);
const upd = (blipId, seq, extra = {}) => ({ blipId, seq, by: "Ann", at: 1000 + seq, update: bytes(seq & 255, 1, 2), ...extra });
const event = (seq, kind = "text") => ({ seq, at: 1000 + seq, by: "Ann", kind, blipId: bid(1) });
const meta = (seq) => ({ schemaVersion: 1, seq, title: "T", rootOrder: [], participants: [], earliestSeq: 1, retainedBytes: 0, lastModified: 0, template: null });

describe("InMemoryRepository", () => {
  it("starts empty", async () => {
    const repo = new InMemoryRepository();
    expect(await repo.getMeta()).toBeNull();
    expect(await repo.getBlips()).toEqual({});
    expect(await repo.getText(bid(1))).toBeNull();
    expect(await repo.getBase(bid(1))).toBeNull();
    expect(await repo.listUpdates(bid(1))).toEqual([]);
    expect(await repo.listEvents()).toEqual([]);
    expect(await repo.getRuns()).toEqual([]);
    expect(await repo.getRequests("s1")).toEqual([]);
    expect(await repo.listRequestSenders()).toEqual([]);
    expect(repo.commits).toBe(0);
  });

  it("stores every record family in one commit and reads them back", async () => {
    const repo = new InMemoryRepository();
    const blip = { id: bid(1), parentId: null, anchor: null, kind: "note", order: "a0", by: "Ann", createdAt: 1, updatedAt: 1, version: 1, seq: 1, textSeq: 0, textChars: 0, log: { count: 0, bytes: 0, sinceCompaction: 0, sinceCompactionBytes: 0 }, deleted: false, locked: false, preview: "" };
    await repo.commit({
      meta: meta(3),
      putBlips: [blip],
      putText: [{ id: bid(1), textSeq: 2, state: bytes(9, 9) }],
      putBase: [{ id: bid(1), seq: 0, state: bytes() }],
      putUpdates: [upd(bid(1), 2), upd(bid(1), 3)],
      putEvents: [event(1, "blip.create"), event(2), event(3)],
      putRuns: [{ id: rid(1), op: "summarise", state: "queued", generation: 1 }],
      putRequests: [{ senderId: "s1", records: [{ requestId: "a:1", seq: 3, at: 1, method: "pushText", outcome: { seq: 3, textSeq: 3 } }] }],
    });
    expect(repo.commits).toBe(1);
    expect(await repo.getMeta()).toEqual(meta(3));
    expect(await repo.getBlips()).toEqual({ [bid(1)]: blip });
    const text = await repo.getText(bid(1));
    expect(text.textSeq).toBe(2);
    expect(text.state).toBeInstanceOf(Uint8Array);
    expect(text.state).toEqual(bytes(9, 9));
    expect((await repo.getBase(bid(1))).state).toBeInstanceOf(Uint8Array);
    const updates = await repo.listUpdates(bid(1));
    expect(updates.map((u) => u.seq)).toEqual([2, 3]);
    expect(updates[0].update).toBeInstanceOf(Uint8Array);
    expect((await repo.listEvents()).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await repo.getRuns()).map((r) => r.id)).toEqual([rid(1)]);
    expect(await repo.getRequests("s1")).toHaveLength(1);
    expect(await repo.listRequestSenders()).toEqual(["s1"]);
  });

  it("copies values on the way in and out, typed arrays included", async () => {
    const repo = new InMemoryRepository();
    const rec = upd(bid(1), 5);
    const m = meta(5);
    await repo.commit({ meta: m, putUpdates: [rec] });
    rec.update[0] = 200;
    m.title = "changed";
    const [stored] = await repo.listUpdates(bid(1));
    expect(stored.update[0]).toBe(5);
    expect((await repo.getMeta()).title).toBe("T");
    stored.update[0] = 77;
    expect((await repo.listUpdates(bid(1)))[0].update[0]).toBe(5);
    const blips = await repo.getBlips();
    blips[bid(9)] = { id: bid(9) };
    expect(await repo.getBlips()).toEqual({});
  });

  it("lists updates by range and limit in sequence order", async () => {
    const repo = new InMemoryRepository();
    const seqs = [50, 3, 1000, 7, 120, 11];
    await repo.commit({ putUpdates: seqs.map((s) => upd(bid(1), s)).concat([upd(bid(2), 4)]) });
    expect((await repo.listUpdates(bid(1))).map((u) => u.seq)).toEqual([3, 7, 11, 50, 120, 1000]);
    expect((await repo.listUpdates(bid(1), { fromSeq: 7, toSeq: 120 })).map((u) => u.seq)).toEqual([7, 11, 50, 120]);
    expect((await repo.listUpdates(bid(1), { fromSeq: 8 })).map((u) => u.seq)).toEqual([11, 50, 120, 1000]);
    expect((await repo.listUpdates(bid(1), { toSeq: 10 })).map((u) => u.seq)).toEqual([3, 7]);
    expect((await repo.listUpdates(bid(1), { limit: 2 })).map((u) => u.seq)).toEqual([3, 7]);
    expect((await repo.listUpdates(bid(1), { fromSeq: 50, limit: 0 }))).toEqual([]);
    expect((await repo.listUpdates(bid(2))).map((u) => u.seq)).toEqual([4]);
    expect(await repo.listUpdates(bid(3))).toEqual([]);
  });

  it("lists events after a sequence with a limit", async () => {
    const repo = new InMemoryRepository();
    await repo.commit({ putEvents: [5, 1, 3, 2, 4].map((s) => event(s)) });
    expect((await repo.listEvents()).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((await repo.listEvents({ afterSeq: 2 })).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect((await repo.listEvents({ afterSeq: 2, limit: 2 })).map((e) => e.seq)).toEqual([3, 4]);
    expect(await repo.listEvents({ afterSeq: 5 })).toEqual([]);
  });

  it("deletes updates, events, runs and request lists, with deletes before puts", async () => {
    const repo = new InMemoryRepository();
    await repo.commit({
      putUpdates: [upd(bid(1), 1), upd(bid(1), 2), upd(bid(1), 3)],
      putEvents: [event(1), event(2), event(3)],
      putRuns: [{ id: rid(1), state: "done" }, { id: rid(2), state: "done" }],
      putRequests: [{ senderId: "s1", records: [] }, { senderId: "s2", records: [] }],
    });
    await repo.commit({
      deleteUpdates: [{ blipId: bid(1), seq: 1 }, { blipId: bid(1), seq: 2 }, { blipId: bid(9), seq: 1 }],
      putUpdates: [upd(bid(1), 2, { by: "Bob" })],
      deleteEvents: [1, 2, 99],
      deleteRuns: [rid(1), rid(9)],
      deleteRequests: ["s1", "nobody"],
    });
    const updates = await repo.listUpdates(bid(1));
    expect(updates.map((u) => [u.seq, u.by])).toEqual([[2, "Bob"], [3, "Ann"]]);
    expect((await repo.listEvents()).map((e) => e.seq)).toEqual([3]);
    expect((await repo.getRuns()).map((r) => r.id)).toEqual([rid(2)]);
    expect(await repo.listRequestSenders()).toEqual(["s2"]);
    expect(repo.commits).toBe(2);
  });

  it("replaces a sender's request list and a blip record wholesale", async () => {
    const repo = new InMemoryRepository();
    await repo.commit({ putRequests: [{ senderId: "s1", records: [{ requestId: "a" }, { requestId: "b" }] }], putBlips: [{ id: bid(1), version: 1, extra: true }] });
    await repo.commit({ putRequests: [{ senderId: "s1", records: [{ requestId: "c" }] }], putBlips: [{ id: bid(1), version: 2 }] });
    expect((await repo.getRequests("s1")).map((r) => r.requestId)).toEqual(["c"]);
    expect((await repo.getBlips())[bid(1)]).toEqual({ id: bid(1), version: 2 });
  });

  it("accepts an empty commit", async () => {
    const repo = new InMemoryRepository();
    await repo.commit({});
    expect(repo.commits).toBe(1);
    expect(await repo.getMeta()).toBeNull();
  });
});
