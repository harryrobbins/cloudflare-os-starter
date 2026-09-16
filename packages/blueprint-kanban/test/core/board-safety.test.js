// Size budget, cascade bounds, same-request delete+recreate and request idempotency.
import { describe, expect, it } from "vitest";
import { DEFAULT_LABELS, LIMITS } from "../../src/shared/protocol.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { createBoard, storedBytes } from "../../src/core/board.js";
import { cid, create, ready } from "./helpers.js";

const apply = async (board, req) => (await board.applyOperation(req)).result;
const totalBytes = (snap) => Object.values(snap.cards).reduce((n, c) => n + storedBytes(c), 0);
const upsert = (columnId, card = {}, cardId = cid()) => ({ op: "upsert", cardId, columnId, baseVersion: 0, card });
const big = () => ({
  title: "big", description: "€".repeat(LIMITS.description),
  checklist: Array.from({ length: LIMITS.checklistItems }, () => ({ text: "€".repeat(LIMITS.checklistText) })),
});

/** Fills the board until even a minimal card no longer fits. */
async function fill(board, columnId) {
  for (;;) {
    const r = await apply(board, { cardOps: Array.from({ length: 20 }, () => upsert(columnId, big())) });
    if (r.errors.length) break;
  }
  for (let len = 32_000; len >= 1; len = Math.floor(len / 2)) {
    while (!(await apply(board, { cardOps: [upsert(columnId, { description: "x".repeat(len) })] })).errors.length);
  }
  const r = await apply(board, { cardOps: [upsert(columnId, {})] });
  expect(r.errors[0]).toMatchObject({ code: "limit", message: expect.stringMatching(/board is full/) });
}

describe("default labels", () => {
  it("Bug uses a darker red for contrast", () => {
    expect(DEFAULT_LABELS.find((l) => l.name === "Bug").color).toBe("#c93c3c");
  });
});

describe("board byte budget", () => {
  it("rejects creates and growing edits past boardBytes; shrinking edits, moves and deletes still work", async () => {
    const { board, col, repo } = await ready();
    const small = await create(board, col.Backlog, { title: "small" });
    await fill(board, col.Backlog);
    let snap = await board.getBoard();
    const used = totalBytes(snap);
    expect(used).toBeLessThanOrEqual(LIMITS.boardBytes);
    expect(used).toBeGreaterThan(LIMITS.boardBytes - 1024);

    // Growing edit refused, whole request otherwise applies.
    const grow = await apply(board, { cardOps: [
      { op: "upsert", cardId: small.cardId, baseVersion: 1, card: { description: "y".repeat(5000) } },
      { op: "move", cardId: small.cardId, baseVersion: 1, toColumnId: col.Done },
    ] });
    expect(grow.errors).toEqual([expect.objectContaining({ kind: "card", index: 0, code: "limit" })]);
    expect(grow.status).toBe("applied");
    expect(grow.upserts[0]).toMatchObject({ columnId: col.Done, description: "" });

    // Shrinking a big card is allowed and frees room for a create.
    const bigCard = Object.values(snap.cards).find((c) => c.title === "big");
    const shrink = await apply(board, { cardOps: [{ op: "upsert", cardId: bigCard.id, baseVersion: bigCard.version, card: { description: "", checklist: [] } }] });
    expect(shrink.errors).toEqual([]);
    expect((await apply(board, { cardOps: [upsert(col.Backlog, { description: "z".repeat(20_000) })] })).errors).toEqual([]);

    // A fresh board over the same storage computes the same total at load.
    snap = await board.getBoard();
    const again = createBoard(repo);
    const r = await again.applyOperation({ cardOps: [upsert(col.Backlog, big())] });
    expect(r.result.errors[0].code).toBe("limit");
    expect(totalBytes(await again.getBoard())).toBe(totalBytes(snap));
  }, 30000);

  it("undo restoring a deleted card is refused when the board has filled up since", async () => {
    const { board, col } = await ready();
    const s = await create(board, col.Backlog, { description: "s".repeat(3000) });
    await fill(board, col.Backlog);
    const del = await apply(board, { cardOps: [{ op: "delete", cardId: s.cardId, baseVersion: 1 }] });
    expect(del.history.inverse).not.toBeNull();
    // Someone else uses the freed space.
    expect((await apply(board, { cardOps: [upsert(col.Backlog, { description: "t".repeat(3000) })] })).errors).toEqual([]);
    const u = await board.undo({ historyId: del.history.id });
    expect(u.result.status).toBe("unchanged");
    expect(u.result.errors[0].code).toBe("limit");
    expect((await board.getBoard()).cards[s.cardId]).toBeUndefined();
  }, 30000);

  it("counts deletes, cascades and moves in the running total within one request", async () => {
    const { board, col } = await ready();
    const a = await create(board, col.Backlog, { description: "a".repeat(2000) });
    await fill(board, col.Backlog);
    // Delete then create in the same request: the freed bytes are available immediately.
    const r = await apply(board, { cardOps: [
      { op: "delete", cardId: a.cardId, baseVersion: 1 },
      upsert(col.Backlog, { description: "b".repeat(1500) }),
    ] });
    expect(r.errors).toEqual([]);
    expect(totalBytes(await board.getBoard())).toBeLessThanOrEqual(LIMITS.boardBytes);
  }, 30000);
});

describe("comment budget", () => {
  it("rejects comments past commentBytesPerCard", async () => {
    const { board, col, repo } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "t" });
    let n = 0;
    for (;;) {
      try {
        await board.addComment({ cardId, author: "A", text: "€".repeat(LIMITS.commentText) });
        n++;
      } catch (e) {
        expect(e.message).toMatch(/maximum comment size/);
        break;
      }
    }
    expect(n).toBeLessThan(LIMITS.commentsPerCard);
    const bytes = (await repo.getComments(cardId)).reduce((sum, c) => sum + storedBytes(c), 0);
    expect(bytes).toBeLessThanOrEqual(LIMITS.commentBytesPerCard);
    expect(bytes).toBeGreaterThan(LIMITS.commentBytesPerCard - 7000);
    // A short comment may still fit, and a board reloaded from storage counts the same bytes.
    const again = createBoard(repo);
    await expect(again.addComment({ cardId, author: "A", text: "€".repeat(LIMITS.commentText) })).rejects.toThrow(/maximum comment size/);
  });

  it("a failed comment commit drops the cached counts", async () => {
    const { board, col, repo } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "t" });
    await board.addComment({ cardId, author: "A", text: "one" });
    const real = repo.commit.bind(repo);
    repo.commit = async () => { throw new Error("disk full"); };
    await expect(board.addComment({ cardId, author: "A", text: "two" })).rejects.toThrow("disk full");
    repo.commit = real;
    await board.addComment({ cardId, author: "A", text: "three" });
    expect((await board.getComments(cardId)).map((c) => c.text)).toEqual(["one", "three"]);
  });
});

describe("cascade bounds", () => {
  /** Stores `count` comments for a card directly (as if added earlier). */
  const seedComments = (repo, cardId, count) => repo.commit({ putComments: Array.from({ length: count }, (_, i) => ({
    id: "m_" + (i + 1).toString(16).padStart(8, "0"), cardId, author: "a", text: "x", at: i,
  })) });

  it("refuses to delete a column holding more than columnDeleteCards cards", async () => {
    const { board, col, snap } = await ready();
    const columnOps = (id) => [{ op: "delete", columnId: id, baseVersion: snap.columns[id].version }];
    await apply(board, { cardOps: Array.from({ length: LIMITS.columnDeleteCards + 1 }, () => upsert(col.Backlog)) });
    const r = await apply(board, { columnOps: columnOps(col.Backlog) });
    expect(r.status).toBe("unchanged");
    expect(r.errors).toEqual([{ kind: "column", index: 0, code: "limit", message: expect.stringMatching(/201 cards.*Move or delete cards first/) }]);

    // Moving one card out in the same request brings it within the limit.
    const one = Object.values((await board.getBoard()).cards)[0];
    const ok = await apply(board, {
      cardOps: [{ op: "move", cardId: one.id, baseVersion: one.version, toColumnId: col.Done }],
      columnOps: columnOps(col.Backlog),
    });
    expect(ok.errors).toEqual([]);
    expect(ok.deletes).toHaveLength(LIMITS.columnDeleteCards);
    const after = await board.getBoard();
    expect(Object.keys(after.cards)).toEqual([one.id]);
    expect(after.columnOrder).not.toContain(col.Backlog);
  });

  it("refuses a column delete that would remove more than columnDeleteComments comments", async () => {
    const { board, col, snap, repo } = await ready();
    const per = LIMITS.commentsPerCard;
    const count = Math.floor(LIMITS.columnDeleteComments / per) + 1;
    const { upserts } = await apply(board, { cardOps: Array.from({ length: count }, () => upsert(col["To do"])) });
    for (const c of upserts) await seedComments(repo, c.id, per);
    const del = { op: "delete", columnId: col["To do"], baseVersion: snap.columns[col["To do"]].version };
    const r = await apply(board, { columnOps: [del] });
    expect(r.errors).toEqual([expect.objectContaining({ kind: "column", code: "limit", message: expect.stringMatching(/Move or delete cards first/) })]);
    expect(await repo.countComments(upserts[0].id)).toBe(per);

    // Deleting the same cards one request at a time works; all in one request stops at the budget.
    const bulk = await apply(board, { cardOps: upserts.map((c) => ({ op: "delete", cardId: c.id, baseVersion: 1 })) });
    expect(bulk.deletes).toHaveLength(count - 1);
    expect(bulk.errors).toEqual([expect.objectContaining({ kind: "card", index: count - 1, code: "limit" })]);
    expect(await repo.countComments(upserts[0].id)).toBe(0);
    expect(await repo.countComments(upserts.at(-1).id)).toBe(per);
    // Now the column holds one card with `per` comments: deleting it is fine.
    const done = await apply(board, { columnOps: [del] });
    expect(done.errors).toEqual([]);
    expect(await repo.countComments(upserts.at(-1).id)).toBe(0);
  });
});

describe("delete and recreate in one request", () => {
  it("rejects recreating a card id deleted earlier in the same request", async () => {
    const { board, col } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "Gone" });
    const r = await apply(board, { cardOps: [
      { op: "delete", cardId, baseVersion: 1 },
      { op: "upsert", cardId, columnId: col.Backlog, baseVersion: 0, card: { title: "Back" } },
    ] });
    expect(r.deletes).toEqual([{ cardId, columnId: col.Backlog }]);
    expect(r.upserts).toEqual([]);
    expect(r.errors).toEqual([expect.objectContaining({ index: 1, code: "exists" })]);
    expect((await board.getBoard()).cards[cardId]).toBeUndefined();
    // In a later request the id may be reused.
    expect((await create(board, col.Backlog, { title: "Back" }, { cardId })).result.errors).toEqual([]);
  });
});

describe("request idempotency", () => {
  it("a replayed create is not applied again and returns the recorded outcome", async () => {
    const { board, col, events } = await ready();
    const cardId = cid();
    const req = { requestId: "client-1:1", by: "A", cardOps: [upsert(col.Backlog, { title: "Once" }, cardId)] };
    const first = await apply(board, req);
    expect(first).toMatchObject({ status: "applied", revision: 1 });
    expect(first.duplicate).toBeUndefined();
    await create(board, col.Done, { title: "other" });
    const eventCount = events.length;

    const replay = await apply(board, req);
    expect(replay).toEqual({
      status: "applied", revision: 2, upserts: [], deletes: [], moved: [], structure: null, labels: null,
      history: null, conflicts: [], errors: [], duplicate: true,
    });
    expect(events).toHaveLength(eventCount);
    expect((await board.getBoard()).revision).toBe(2);
    expect((await board.getHistory()).length).toBe(2);
  });

  it("a replay cannot resurrect a card someone deleted", async () => {
    const { board, col } = await ready();
    const cardId = cid();
    const req = { requestId: "r-create", cardOps: [upsert(col.Backlog, { title: "T" }, cardId)] };
    await apply(board, req);
    await apply(board, { cardOps: [{ op: "delete", cardId, baseVersion: 1 }] });
    const replay = await apply(board, req);
    expect(replay.duplicate).toBe(true);
    expect((await board.getBoard()).cards[cardId]).toBeUndefined();
  });

  it("replays conflicts with the current value and errors; unchanged requests are recorded without a revision bump", async () => {
    const { board, col, repo } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "v1" });
    const req = { requestId: "r2", cardOps: [
      { op: "upsert", cardId, baseVersion: 9, card: { title: "stale" } },
      { op: "bogus", cardId },
    ] };
    const first = await apply(board, req);
    expect(first.status).toBe("conflict");
    expect(first.revision).toBe(1);
    expect((await repo.getMeta()).revision).toBe(1);
    expect((await repo.getRequests())).toEqual([{ requestId: "r2", revision: 1, status: "conflict", conflicts: [{ kind: "card", id: cardId }], errors: first.errors }]);

    await apply(board, { cardOps: [{ op: "upsert", cardId, baseVersion: 1, card: { title: "v2" } }] });
    const replay = await apply(board, req);
    expect(replay).toMatchObject({ status: "conflict", revision: 2, duplicate: true, errors: first.errors });
    expect(replay.conflicts).toEqual([{ kind: "card", id: cardId, current: expect.objectContaining({ title: "v2", version: 2 }) }]);

    // Column conflicts re-read too; a vanished item reads as null.
    const colReq = { requestId: "r3", columnOps: [{ op: "upsert", columnId: col.Done, baseVersion: 5, column: { name: "X" } }] };
    await apply(board, colReq);
    const colReplay = await apply(board, colReq);
    expect(colReplay.conflicts).toEqual([{ kind: "column", id: col.Done, current: expect.objectContaining({ name: "Done" }) }]);
    await apply(board, { cardOps: [{ op: "delete", cardId, baseVersion: 2 }] });
    expect((await apply(board, req)).conflicts[0].current).toBeNull();
  });

  it("ignores invalid requestIds", async () => {
    const { board, col, repo } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "t" });
    let v = 1;
    for (const requestId of ["", "has space", "x".repeat(65), 42, { a: 1 }, "semi;colon"]) {
      const r = await apply(board, { requestId, cardOps: [{ op: "upsert", cardId, baseVersion: v, card: { title: "t" + v } }] });
      expect(r.status).toBe("applied");
      expect(r.duplicate).toBeUndefined();
      v++;
    }
    expect(await repo.getRequests()).toEqual([]);
    const ok = await apply(board, { requestId: "A-z_0:9".padEnd(64, "x"), cardOps: [{ op: "upsert", cardId, baseVersion: v, card: { title: "last" } }] });
    expect(ok.status).toBe("applied");
    expect(await repo.getRequests()).toHaveLength(1);
  });

  it("records are written in the same commit as the changes", async () => {
    const { board, col, repo } = await ready();
    const commits = [];
    const real = repo.commit.bind(repo);
    repo.commit = async (c) => { commits.push(c); return real(c); };
    await create(board, col.Backlog, { title: "t" }, { requestId: "same-commit" });
    expect(commits).toHaveLength(1);
    expect(commits[0].meta.revision).toBe(1);
    expect(commits[0].requests.map((r) => r.requestId)).toEqual(["same-commit"]);

    // A failed commit records nothing, so a retry applies.
    repo.commit = async () => { throw new Error("disk full"); };
    const req = { requestId: "retry-me", cardOps: [upsert(col.Backlog, { title: "r" })] };
    await expect(apply(board, req)).rejects.toThrow("disk full");
    repo.commit = real;
    const retry = await apply(board, req);
    expect(retry.status).toBe("applied");
    expect(retry.duplicate).toBeUndefined();
    expect((await apply(board, req)).duplicate).toBe(true);
  });

  it("records survive a reload and are bounded by count and bytes", async () => {
    const { board, col, repo } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "t" });
    for (let i = 0; i < LIMITS.requestRecords + 10; i++) {
      await apply(board, { requestId: "n" + i, cardOps: [{ op: "move", cardId, baseVersion: 999, toColumnId: col.Done }] });
    }
    let records = await repo.getRequests();
    expect(records).toHaveLength(LIMITS.requestRecords);
    expect(records[0].requestId).toBe("n10");
    expect(storedBytes(records)).toBeLessThanOrEqual(LIMITS.requestRecordBytes);

    const again = createBoard(repo);
    expect((await again.applyOperation({ requestId: "n10", cardOps: [] })).result.duplicate).toBe(true);
    expect((await again.applyOperation({ requestId: "n9", cardOps: [] })).result.duplicate).toBeUndefined();

    // Requests with many errors: each record is shrunk and the list stays within bytes.
    const junk = Array.from({ length: LIMITS.opsPerRequest }, () => ({ op: "nope", cardId: "c_bad" }));
    for (let i = 0; i < 10; i++) {
      const r = await again.applyOperation({ requestId: "junk" + i, cardOps: junk });
      expect(r.result.errors).toHaveLength(LIMITS.opsPerRequest);
    }
    records = await repo.getRequests();
    expect(storedBytes(records)).toBeLessThanOrEqual(LIMITS.requestRecordBytes);
    expect(records.at(-1).requestId).toBe("junk9");
    const replay = (await again.applyOperation({ requestId: "junk9", cardOps: junk })).result;
    expect(replay.duplicate).toBe(true);
    expect(replay.errors.length).toBeGreaterThan(0);
    expect(replay.errors.length).toBeLessThan(LIMITS.opsPerRequest);

    // Over opsPerRequest: recorded too.
    const tooMany = Array.from({ length: LIMITS.opsPerRequest + 1 }, () => ({ op: "nope" }));
    await again.applyOperation({ requestId: "too-many", cardOps: tooMany });
    expect((await again.applyOperation({ requestId: "too-many" })).result).toMatchObject({ duplicate: true, errors: [expect.objectContaining({ code: "limit" })] });
  }, 30000);

  it("undo accepts a requestId with the same semantics", async () => {
    const { board, col, events } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "T" });
    const move = await apply(board, { cardOps: [{ op: "move", cardId, baseVersion: 1, toColumnId: col.Done }] });
    const first = await board.undo({ historyId: move.history.id, requestId: "undo-1" });
    expect(first.result.status).toBe("applied");
    await apply(board, { cardOps: [{ op: "move", cardId, baseVersion: 3, toColumnId: col.Done }] });
    const eventCount = events.length;
    const replay = await board.undo({ historyId: move.history.id, requestId: "undo-1" });
    expect(replay.result).toMatchObject({ status: "applied", duplicate: true, revision: 4, upserts: [] });
    expect(replay.event).toBeNull();
    expect(events).toHaveLength(eventCount);
    expect((await board.getBoard()).cards[cardId].columnId).toBe(col.Done);

    const missing = await board.undo({ historyId: "h_00000000", requestId: "undo-2" });
    expect(missing.result.errors[0].code).toBe("invalid_op");
    expect((await board.undo({ historyId: "h_00000000", requestId: "undo-2" })).result.duplicate).toBe(true);
  });

  it("a requestId shared between applyOperation and undo is one namespace", async () => {
    const repo = new InMemoryRepository();
    const board = createBoard(repo);
    const snap = await board.getBoard();
    await board.applyOperation({ requestId: "shared", structure: { title: "New" } });
    expect((await board.undo({ historyId: "h_00000000", requestId: "shared" })).result).toMatchObject({ duplicate: true, status: "applied", errors: [] });
    expect((await board.getBoard()).title).toBe("New");
    expect(snap.revision).toBe(0);
  });
});
