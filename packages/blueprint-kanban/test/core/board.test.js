import { describe, expect, it } from "vitest";
import { DEFAULT_COLUMNS, DEFAULT_LABELS, DEFAULT_TITLE, LIMITS, SCHEMA_VERSION, cardsInColumn } from "../../src/shared/protocol.js";
import { isValidOrderKey } from "../../src/shared/order.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { createBoard, migrate, storedBytes } from "../../src/core/board.js";
import { cid, create, kid, lid, ready, setup } from "./helpers.js";

const apply = async (board, req) => (await board.applyOperation(req)).result;

describe("initialisation", () => {
  it("creates the default board on first access and persists it", async () => {
    const { board, repo } = setup();
    const snap = await board.getBoard();
    expect(snap.schemaVersion).toBe(SCHEMA_VERSION);
    expect(snap.revision).toBe(0);
    expect(snap.title).toBe(DEFAULT_TITLE);
    expect(snap.columnOrder.map((id) => snap.columns[id].name)).toEqual(DEFAULT_COLUMNS);
    expect(Object.values(snap.labels).map(({ name, color }) => ({ name, color }))).toEqual(DEFAULT_LABELS);
    expect(snap.cards).toEqual({});
    for (const id of snap.columnOrder) expect(snap.columns[id]).toMatchObject({ id, version: 1, collapsed: false });
    expect((await repo.getMeta()).columnOrder).toEqual(snap.columnOrder);
    // A second board over the same repo loads rather than re-initialises.
    const again = await createBoard(repo).getBoard();
    expect(again.columnOrder).toEqual(snap.columnOrder);
  });

  it("snapshots are copies", async () => {
    const { board } = setup();
    const snap = await board.getBoard();
    snap.title = "mutated";
    snap.columnOrder.pop();
    expect((await board.getBoard()).title).toBe(DEFAULT_TITLE);
  });

  it("migrate upgrades schemaVersion and repairs columnOrder", async () => {
    const meta = { revision: 3, title: "T", columnOrder: ["k_00000001", "k_00000001", "k_0000dead"],
      columns: { k_00000001: { id: "k_00000001", name: "A", version: 1, collapsed: false },
        k_00000002: { id: "k_00000002", name: "B", version: 1, collapsed: false } }, lastModified: 1 };
    const m = migrate(meta);
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
    expect(m.columnOrder).toEqual(["k_00000001", "k_00000002"]);
    const ok = { ...m };
    expect(migrate(ok)).toBe(ok);

    const repo = new InMemoryRepository();
    await repo.commit({ meta });
    const snap = await createBoard(repo).getBoard();
    expect(snap.schemaVersion).toBe(SCHEMA_VERSION);
    expect((await repo.getMeta()).schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe("card ops", () => {
  it("creates with defaults, appends in order, bumps revision and broadcasts one event", async () => {
    const { board, col, events } = await ready();
    const a = await create(board, col.Backlog, { title: "  First\n", description: "a\r\nb" });
    expect(a.result.status).toBe("applied");
    expect(a.result.revision).toBe(1);
    expect(a.card).toMatchObject({
      id: a.cardId, columnId: col.Backlog, title: "First", description: "a\nb", labels: [], assignee: "",
      due: null, checklist: [], version: 1, createdBy: "Tester",
    });
    expect(isValidOrderKey(a.card.order)).toBe(true);
    const b = await create(board, col.Backlog, { title: "Second" });
    expect(b.card.order > a.card.order).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "operation", senderId: "s1", revision: 2, deletes: [], moved: [], structure: null, labels: null });
    expect(events[1].upserts.map((c) => c.id)).toEqual([b.cardId]);
    expect(events[1].history.summary).toBe('Created "Second"');
  });

  it("uses a valid supplied order key and ignores an invalid one", async () => {
    const { board, col } = await ready();
    const a = await create(board, col.Backlog, { title: "A", order: "a5" });
    expect(a.card.order).toBe("a5");
    const b = await create(board, col.Backlog, { title: "B", order: "a0" + "0" }); // trailing zero: invalid
    expect(b.card.order > "a5").toBe(true);
    const c = await create(board, col.Backlog, { title: "C", order: "!!" });
    expect(isValidOrderKey(c.card.order)).toBe(true);
  });

  it("patches only listed fields and bumps version; strips unknown keys", async () => {
    const { board, col, label } = await ready();
    const { cardId, card } = await create(board, col.Backlog, { title: "T", assignee: "Sam" });
    const r = await apply(board, { cardOps: [{ op: "upsert", cardId, baseVersion: 1,
      card: { description: "D", labels: [label.Bug, "l_ffffffff", label.Bug], due: "2026-02-30", evil: 1, version: 99, columnId: "k_00000000", createdBy: "x" } }] });
    expect(r.status).toBe("applied");
    const next = r.upserts[0];
    expect(next).toMatchObject({ title: "T", assignee: "Sam", description: "D", labels: [label.Bug], due: null, version: 2, columnId: col.Backlog, createdBy: "Tester" });
    expect(next).not.toHaveProperty("evil");
    expect(next.createdAt).toBe(card.createdAt);
    expect(next.updatedAt).toBeGreaterThan(card.updatedAt);
  });

  it("an upsert that changes nothing is unchanged and keeps the version", async () => {
    const { board, col } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "T" });
    const r = await apply(board, { cardOps: [{ op: "upsert", cardId, baseVersion: 1, card: { title: "T" } }] });
    expect(r.status).toBe("unchanged");
    expect((await board.getBoard()).cards[cardId].version).toBe(1);
  });

  it("stale baseVersion conflicts with the authoritative card", async () => {
    const { board, col } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "T" });
    await apply(board, { cardOps: [{ op: "upsert", cardId, baseVersion: 1, card: { title: "Theirs" } }] });
    const r = await apply(board, { cardOps: [{ op: "upsert", cardId, baseVersion: 1, card: { title: "Mine" } }] });
    expect(r.status).toBe("conflict");
    expect(r.revision).toBe(2);
    expect(r.conflicts).toEqual([{ kind: "card", id: cardId, current: expect.objectContaining({ title: "Theirs", version: 2 }) }]);
    expect(r.history).toBeNull();
    for (const op of [{ op: "move", toColumnId: col.Done }, { op: "delete" }]) {
      const c = await apply(board, { cardOps: [{ ...op, cardId, baseVersion: 1 }] });
      expect(c.conflicts[0].current.title).toBe("Theirs");
    }
  });

  it("delete then edit conflicts with current null; delete removes comments", async () => {
    const { board, col, repo, events } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "T" });
    await board.addComment({ cardId, author: "A", text: "hi" });
    const d = await apply(board, { senderId: "x", cardOps: [{ op: "delete", cardId, baseVersion: 1 }] });
    expect(d.deletes).toEqual([{ cardId, columnId: col.Backlog }]);
    expect(d.history.summary).toBe('Deleted "T"');
    expect(await repo.getComments(cardId)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "operation", senderId: "x", deletes: [{ cardId, columnId: col.Backlog }] });
    const r = await apply(board, { cardOps: [{ op: "upsert", cardId, baseVersion: 1, card: { title: "late" } }] });
    expect(r.status).toBe("conflict");
    expect(r.conflicts).toEqual([{ kind: "card", id: cardId, current: null }]);
    expect((await board.getBoard()).cards[cardId]).toBeUndefined();
  });

  it("moves within and across columns", async () => {
    const { board, col } = await ready();
    const a = await create(board, col.Backlog, { title: "A" });
    const b = await create(board, col.Backlog, { title: "B" });
    const c = await create(board, col.Backlog, { title: "C" });
    // C to the top of Backlog.
    let r = await apply(board, { cardOps: [{ op: "move", cardId: c.cardId, baseVersion: 1, toColumnId: col.Backlog, order: "Zz" }] });
    expect(r.moved).toEqual([{ cardId: c.cardId, fromColumnId: col.Backlog, toColumnId: col.Backlog }]);
    expect(r.upserts[0].version).toBe(2);
    let snap = await board.getBoard();
    expect(cardsInColumn(snap.cards, col.Backlog).map((x) => x.title)).toEqual(["C", "A", "B"]);
    // A to Done, no order: appended.
    r = await apply(board, { cardOps: [{ op: "move", cardId: a.cardId, baseVersion: 1, toColumnId: col.Done }] });
    expect(r.moved).toEqual([{ cardId: a.cardId, fromColumnId: col.Backlog, toColumnId: col.Done }]);
    expect(r.history.summary).toBe('Moved "A" to Done');
    snap = await board.getBoard();
    expect(cardsInColumn(snap.cards, col.Done).map((x) => x.title)).toEqual(["A"]);
    expect(cardsInColumn(snap.cards, col.Backlog).map((x) => x.title)).toEqual(["C", "B"]);
    // Moving the last card to its own column's end is a no-op.
    r = await apply(board, { cardOps: [{ op: "move", cardId: b.cardId, baseVersion: 1, toColumnId: col.Backlog }] });
    expect(r.status).toBe("unchanged");
    // Invalid order key falls back to append.
    r = await apply(board, { cardOps: [{ op: "move", cardId: b.cardId, baseVersion: 1, toColumnId: col.Done, order: "a00" }] });
    expect(r.upserts[0].order > snap.cards[a.cardId].order).toBe(true);
  });

  it("ops within one request compose and bump the card version once", async () => {
    const { board, col, events } = await ready();
    const cardId = cid();
    const r = await apply(board, { cardOps: [
      { op: "upsert", cardId, columnId: col.Backlog, baseVersion: 0, card: { title: "New" } },
      { op: "upsert", cardId, baseVersion: 0, card: { description: "then edited" } },
      { op: "move", cardId, baseVersion: 1, toColumnId: col.Done },
    ] });
    expect(r.status).toBe("applied");
    expect(r.errors).toEqual([]);
    expect(r.revision).toBe(1);
    expect(r.upserts).toEqual([expect.objectContaining({ id: cardId, title: "New", description: "then edited", columnId: col.Done, version: 1 })]);
    expect(r.moved).toEqual([]); // created in this request
    expect(events).toHaveLength(1);

    const r2 = await apply(board, { cardOps: [
      { op: "upsert", cardId, baseVersion: 1, card: { title: "Edited" } },
      { op: "move", cardId, baseVersion: 1, toColumnId: col.Backlog },
    ] });
    expect(r2.status).toBe("applied");
    expect(r2.upserts[0]).toMatchObject({ version: 2, title: "Edited", columnId: col.Backlog });
    expect(r2.history.summary).toBe('Moved "Edited" to Backlog');

    const r3 = await apply(board, { cardOps: [
      { op: "upsert", cardId: cid(), columnId: col.Backlog, baseVersion: 0, card: { title: "x" } },
      { op: "delete", cardId, baseVersion: 2 },
    ] });
    expect(r3.history.summary).toBe("2 changes");
  });

  it("applies valid ops independently of invalid ones", async () => {
    const { board, col } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "T" });
    const r = await apply(board, { cardOps: [
      { op: "upsert", cardId: "bad", baseVersion: 0, columnId: col.Backlog },
      { op: "upsert", cardId, baseVersion: 1, card: { title: "ok" } },
      { op: "upsert", cardId, baseVersion: 1, card: { title: "stale" } },
    ] });
    // The third op names the version from before this request, which is accepted within it.
    expect(r.status).toBe("applied");
    expect(r.errors.map((e) => [e.index, e.code])).toEqual([[0, "invalid_id"]]);
    expect(r.upserts[0]).toMatchObject({ title: "stale", version: 2 });

    const r2 = await apply(board, { cardOps: [
      { op: "upsert", cardId, baseVersion: 1, card: { title: "stale" } },
      { op: "upsert", cardId: cid(), columnId: col.Done, baseVersion: 0, card: { title: "fresh" } },
      { op: "frobnicate", cardId },
    ] });
    expect(r2.status).toBe("conflict");
    expect(r2.upserts.map((c) => c.title)).toEqual(["fresh"]);
    expect(r2.errors).toEqual([{ kind: "card", index: 2, code: "invalid_op", message: expect.any(String) }]);
  });

  it("reports every error code", async () => {
    const { board, col } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "T" });
    const r = await apply(board, {
      cardOps: [
        { op: "upsert", cardId: "c_XYZ", baseVersion: 0, columnId: col.Backlog }, // invalid_id
        { op: "move", cardId: cid(), baseVersion: 0, toColumnId: col.Done },      // unknown_card
        { op: "upsert", cardId: cid(), baseVersion: 0, columnId: "k_00000bad" },  // unknown_column
        { op: "upsert", cardId, baseVersion: 0, columnId: col.Backlog },          // exists
        { op: "move", cardId, baseVersion: 1, toColumnId: kid() },                // unknown_column
        { op: "upsert", cardId, card: { title: "no base" } },                      // invalid_op
        { op: "upsert", cardId, baseVersion: -1, card: {} },                       // invalid_op
        { op: "move", cardId, baseVersion: 1 },                                    // invalid_op
      ],
      columnOps: [
        { op: "upsert", columnId: "nope", baseVersion: 0 },                        // invalid_id
        { op: "move", columnId: kid(), index: 0 },                                 // unknown_column
        { op: "upsert", columnId: col.Done, baseVersion: 0, column: { name: "X" } }, // exists
        { op: "move", columnId: col.Done, index: "1" },                            // invalid_op
      ],
      labelOps: [{ op: "upsert", labelId: "l_1" }, { op: "rename", labelId: lid() }],
      structure: { title: 42 },
    });
    const codes = r.errors.map((e) => `${e.kind}:${e.index}:${e.code}`);
    expect(codes).toEqual([
      "label:0:invalid_id", "label:1:invalid_op",
      "column:0:invalid_id", "column:1:unknown_column", "column:2:exists", "column:3:invalid_op",
      "card:0:invalid_id", "card:1:unknown_card", "card:2:unknown_column", "card:3:exists",
      "card:4:unknown_column", "card:5:invalid_op", "card:6:invalid_op", "card:7:invalid_op",
      "structure:-1:invalid_op",
    ]);
    expect(r.status).toBe("unchanged");
    expect(r.revision).toBe(1);
    for (const e of r.errors) expect(typeof e.message).toBe("string");
  });

  it("strips label ids of deleted labels on the card's next write", async () => {
    const { board, col, label } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "T", labels: [label.Bug, label.Chore] });
    await apply(board, { labelOps: [{ op: "delete", labelId: label.Bug }] });
    expect((await board.getBoard()).cards[cardId].labels).toEqual([label.Bug, label.Chore]);
    const r = await apply(board, { cardOps: [{ op: "move", cardId, baseVersion: 1, toColumnId: col.Done }] });
    expect(r.upserts[0].labels).toEqual([label.Chore]);
  });
});

describe("column, label and structure ops", () => {
  it("creates, renames (version-checked), collapses (LWW) and moves columns", async () => {
    const { board, col } = await ready();
    const id = kid();
    let r = await apply(board, { columnOps: [{ op: "upsert", columnId: id, baseVersion: 0, column: { name: "Review\n" }, index: 2 }] });
    expect(r.structure.columnOrder[2]).toBe(id);
    expect(r.structure.columns[id]).toEqual({ id, name: "Review", version: 1, collapsed: false });
    expect(r.history.summary).toBe('Added column "Review"');
    expect(r.history.inverse).toBeNull();

    r = await apply(board, { columnOps: [{ op: "upsert", columnId: id, baseVersion: 1, column: { name: "QA" } }] });
    expect(r.structure.columns[id]).toMatchObject({ name: "QA", version: 2 });
    r = await apply(board, { columnOps: [{ op: "upsert", columnId: id, baseVersion: 1, column: { name: "Stale" } }] });
    expect(r.status).toBe("conflict");
    expect(r.conflicts).toEqual([{ kind: "column", id, current: { id, name: "QA", version: 2, collapsed: false } }]);
    r = await apply(board, { columnOps: [{ op: "upsert", columnId: id, column: { collapsed: true } }] });
    expect(r.structure.columns[id]).toMatchObject({ collapsed: true, version: 2 });
    r = await apply(board, { columnOps: [{ op: "upsert", columnId: id, column: { name: "no base" } }] });
    expect(r.errors[0].code).toBe("invalid_op");

    r = await apply(board, { columnOps: [{ op: "move", columnId: id, index: 999 }] });
    expect(r.structure.columnOrder.at(-1)).toBe(id);
    r = await apply(board, { columnOps: [{ op: "move", columnId: id, index: -5 }] });
    expect(r.structure.columnOrder[0]).toBe(id);
    expect(r.history.summary).toBe("Reordered columns");
    r = await apply(board, { columnOps: [{ op: "move", columnId: id, index: 0 }] });
    expect(r.status).toBe("unchanged");
    expect(col.Backlog).toBeTruthy();
  });

  it("column delete is version-checked and cascades to cards and comments", async () => {
    const { board, col, repo } = await ready();
    const a = await create(board, col.Done, { title: "A" });
    const b = await create(board, col.Done, { title: "B" });
    const keep = await create(board, col.Backlog, { title: "Keep" });
    await board.addComment({ cardId: a.cardId, author: "x", text: "c" });
    let r = await apply(board, { columnOps: [{ op: "delete", columnId: col.Done, baseVersion: 7 }] });
    expect(r.status).toBe("conflict");
    expect(r.conflicts[0].current.name).toBe("Done");
    r = await apply(board, { columnOps: [{ op: "delete", columnId: col.Done, baseVersion: 1 }] });
    expect(r.status).toBe("applied");
    expect(r.deletes.map((d) => d.cardId).sort()).toEqual([a.cardId, b.cardId].sort());
    expect(r.structure.columnOrder).not.toContain(col.Done);
    expect(r.history.summary).toBe('Deleted column "Done"');
    expect(r.history.inverse).toBeNull();
    const snap = await board.getBoard();
    expect(Object.keys(snap.cards)).toEqual([keep.cardId]);
    expect(await repo.getComments(a.cardId)).toEqual([]);
    r = await apply(board, { columnOps: [{ op: "delete", columnId: col.Done, baseVersion: 1 }] });
    expect(r.conflicts).toEqual([{ kind: "column", id: col.Done, current: null }]);
  });

  it("a request can move cards out of a column and then delete it", async () => {
    const { board, col } = await ready();
    const a = await create(board, col.Done, { title: "A" });
    const r = await apply(board, {
      columnOps: [{ op: "delete", columnId: col.Done, baseVersion: 1 }],
      cardOps: [{ op: "move", cardId: a.cardId, baseVersion: 1, toColumnId: col.Backlog }],
    });
    expect(r.errors).toEqual([]);
    expect(r.deletes).toEqual([]);
    expect((await board.getBoard()).cards[a.cardId].columnId).toBe(col.Backlog);
  });

  it("a request can create a column and cards in it", async () => {
    const { board } = await ready();
    const k = kid();
    const r = await apply(board, {
      cardOps: [{ op: "upsert", cardId: cid(), columnId: k, baseVersion: 0, card: { title: "in new" } }],
      columnOps: [{ op: "upsert", columnId: k, baseVersion: 0, column: { name: "New" } }],
    });
    expect(r.errors).toEqual([]);
    expect(r.upserts[0].columnId).toBe(k);
  });

  it("labels are last-writer-wins with colour validation", async () => {
    const { board, label } = await ready();
    const id = lid();
    let r = await apply(board, { labelOps: [{ op: "upsert", labelId: id, label: { name: "Design", color: "#ABCDEF" } }] });
    expect(r.labels[id]).toEqual({ id, name: "Design", color: "#abcdef" });
    expect(r.history.summary).toBe("Updated labels");
    r = await apply(board, { labelOps: [{ op: "upsert", labelId: id, label: { color: "red" } }] });
    expect(r.status).toBe("unchanged");
    r = await apply(board, { labelOps: [{ op: "upsert", labelId: label.Bug, label: { name: "Defect" } }, { op: "delete", labelId: label.Chore }] });
    expect(r.labels[label.Bug].name).toBe("Defect");
    expect(r.labels[label.Chore]).toBeUndefined();
    r = await apply(board, { labelOps: [{ op: "delete", labelId: lid() }] });
    expect(r.status).toBe("unchanged");
  });

  it("structure title is LWW and cleaned", async () => {
    const { board } = await ready();
    let r = await apply(board, { structure: { title: "  Sprint\t42 " } });
    expect(r.structure.title).toBe("Sprint 42");
    expect(r.history.summary).toBe('Renamed board to "Sprint 42"');
    r = await apply(board, { structure: { title: "" } });
    expect(r.structure.title).toBe(DEFAULT_TITLE);
    r = await apply(board, { structure: { title: "x".repeat(1000) } });
    expect(r.structure.title).toHaveLength(LIMITS.boardTitle);
  });
});

describe("limits", () => {
  it("opsPerRequest rejects the whole request", async () => {
    const { board, col } = await ready();
    const cardOps = Array.from({ length: LIMITS.opsPerRequest + 1 }, () => ({ op: "upsert", cardId: cid(), columnId: col.Backlog, baseVersion: 0 }));
    const r = await apply(board, { cardOps });
    expect(r.status).toBe("unchanged");
    expect(r.errors).toEqual([expect.objectContaining({ kind: "structure", index: -1, code: "limit" })]);
    expect(Object.keys((await board.getBoard()).cards)).toHaveLength(0);
  });

  it("cards cap", async () => {
    const { board, col } = await ready();
    for (let i = 0; i < LIMITS.cards / LIMITS.opsPerRequest; i++) {
      const cardOps = Array.from({ length: LIMITS.opsPerRequest }, () => ({ op: "upsert", cardId: cid(), columnId: col.Backlog, baseVersion: 0, card: { title: "t" } }));
      expect((await apply(board, { cardOps })).errors).toEqual([]);
    }
    const r = await apply(board, { cardOps: [{ op: "upsert", cardId: cid(), columnId: col.Backlog, baseVersion: 0 }] });
    expect(r.errors[0].code).toBe("limit");
    expect(Object.keys((await board.getBoard()).cards)).toHaveLength(LIMITS.cards);
  }, 30000);

  it("columns cap", async () => {
    const { board } = await ready();
    const columnOps = Array.from({ length: LIMITS.columns }, () => ({ op: "upsert", columnId: kid(), baseVersion: 0, column: { name: "c" } }));
    const r = await apply(board, { columnOps });
    expect(r.errors.filter((e) => e.code === "limit")).toHaveLength(DEFAULT_COLUMNS.length);
    expect((await board.getBoard()).columnOrder).toHaveLength(LIMITS.columns);
  });

  it("labels cap", async () => {
    const { board } = await ready();
    const labelOps = Array.from({ length: LIMITS.labels }, () => ({ op: "upsert", labelId: lid(), label: { name: "x" } }));
    const r = await apply(board, { labelOps });
    expect(r.errors.filter((e) => e.code === "limit")).toHaveLength(DEFAULT_LABELS.length);
    expect(Object.keys((await board.getBoard()).labels)).toHaveLength(LIMITS.labels);
  });

  it("labelsPerCard, checklist and text lengths are clamped", async () => {
    const { board, col } = await ready();
    const labelOps = Array.from({ length: 30 }, () => ({ op: "upsert", labelId: lid(), label: { name: "x" } }));
    const { labels } = await apply(board, { labelOps });
    const { card } = await create(board, col.Backlog, {
      title: "t".repeat(LIMITS.cardTitle + 50),
      description: "d".repeat(LIMITS.description + 50),
      assignee: "a".repeat(200),
      labels: Object.keys(labels),
      checklist: Array.from({ length: LIMITS.checklistItems + 10 }, (_, i) => ({ text: "x".repeat(400), done: i % 2 === 0 })),
    });
    expect(card.title).toHaveLength(LIMITS.cardTitle);
    expect(card.description).toHaveLength(LIMITS.description);
    expect(card.assignee).toHaveLength(LIMITS.assignee);
    expect(card.labels).toHaveLength(LIMITS.labelsPerCard);
    expect(card.checklist).toHaveLength(LIMITS.checklistItems);
    expect(card.checklist[0].text).toHaveLength(LIMITS.checklistText);
    expect(card.checklist[0].id).toMatch(/^i_[0-9a-f]{8}$/);
  });

  it("comments cap and text clamp", async () => {
    const { board, col, repo } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "t" });
    const { comment } = await board.addComment({ cardId, author: "", text: "x".repeat(LIMITS.commentText + 5) });
    expect(comment.text).toHaveLength(LIMITS.commentText);
    expect(comment.author).toBe("Anonymous");
    for (let i = 1; i < LIMITS.commentsPerCard; i++) await repo.commit({ putComments: [{ ...comment, id: "m_" + i.toString(16).padStart(8, "0") }] });
    await expect(board.addComment({ cardId, author: "a", text: "one too many" })).rejects.toThrow(/maximum/);
    expect(await repo.countComments(cardId)).toBe(LIMITS.commentsPerCard);
  });
});

describe("hostile input", () => {
  const junk = [
    undefined, null, 42, "str", [], [1, 2], { cardOps: "nope" }, { cardOps: [null, 1, "x", []] },
    { columnOps: { length: 3 } }, { labelOps: [{ op: "upsert", labelId: "__proto__", label: { name: "p" } }] },
    { cardOps: [{ op: "upsert", cardId: "__proto__", baseVersion: 0 }] },
    { cardOps: [{ op: "upsert", cardId: "c_00000001", baseVersion: 0, columnId: "__proto__" }] },
    { cardOps: [{ op: "move", cardId: "c_00000001", baseVersion: Infinity, toColumnId: "constructor" }] },
    { cardOps: [{ op: "upsert", cardId: "c_00000001", baseVersion: "0", card: { title: "x" } }] },
    { structure: "title" }, { structure: { title: { toString: () => "x" } } },
    { senderId: { a: 1 }, by: ["x"], columnOps: [{ op: "upsert", columnId: "k_00000001", baseVersion: 0, column: { name: 7 } }] },
    { columnOps: [{ op: "move", columnId: "k_00000001", index: NaN }] },
    JSON.parse('{"cardOps":[{"op":"upsert","cardId":"c_0000abcd","baseVersion":0,"columnId":"k_00000000","card":{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}}]}'),
  ];

  it("never throws, never corrupts state", async () => {
    const { board, col } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "Keep" });
    const before = await board.getBoard();
    for (const req of junk) {
      const { result } = await board.applyOperation(req);
      expect(["unchanged", "conflict"]).toContain(result.status);
    }
    // Throwing getters are contained too.
    const trap = { op: "upsert", cardId, baseVersion: 1, get card() { throw new Error("gotcha"); } };
    const t = await apply(board, { cardOps: [trap] });
    expect(t.errors[0].code).toBe("invalid_op");
    expect(await board.getBoard()).toEqual(before);
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.x).toBeUndefined();
  });

  it("__proto__ card patch key cannot inject fields", async () => {
    const { board, col } = await ready();
    const req = JSON.parse(`{"cardOps":[{"op":"upsert","cardId":"c_0000abce","baseVersion":0,"columnId":"${col.Backlog}","card":{"title":"ok","__proto__":{"version":99,"columnId":"k_ffffffff"}}}]}`);
    const r = await apply(board, req);
    expect(r.upserts[0]).toMatchObject({ title: "ok", version: 1, columnId: col.Backlog });
  });

  it("huge strings are truncated", async () => {
    const { board, col } = await ready();
    const huge = "€".repeat(1_000_000);
    const { card } = await create(board, col.Backlog, { title: huge, description: huge }, { by: huge, senderId: huge });
    expect(card.title).toHaveLength(LIMITS.cardTitle);
    expect(card.createdBy).toHaveLength(LIMITS.displayName);
  });
});

describe("history and undo", () => {
  it("keeps at most historyEntries and trims to historyBytes", async () => {
    const { board, col, repo } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "T" });
    for (let v = 1; v <= LIMITS.historyEntries + 20; v++) {
      await apply(board, { cardOps: [{ op: "upsert", cardId, baseVersion: v, card: { title: "T" + v } }] });
    }
    const history = await repo.getHistory();
    expect(history).toHaveLength(LIMITS.historyEntries);
    expect(history.at(-1).summary).toBe(`Edited "T${LIMITS.historyEntries + 20}"`);
    expect((await board.getHistory()).length).toBe(50);
    expect((await board.getHistory(5)).map((h) => h.summary)).toEqual(history.slice(-5).map((h) => h.summary));
    expect(await board.getHistory("lots")).toHaveLength(50);

    // Large (but under inverseBytes) inverses: bytes bound kicks in before the entry bound.
    const big = await create(board, col.Backlog, { title: "big" });
    let v = 1;
    for (let i = 0; i < 60; i++) {
      await apply(board, { cardOps: [{ op: "upsert", cardId: big.cardId, baseVersion: v++, card: { description: String(i).repeat(1500) } }] });
    }
    const h2 = await repo.getHistory();
    expect(storedBytes(h2)).toBeLessThanOrEqual(LIMITS.historyBytes);
    expect(h2.length).toBeLessThan(LIMITS.historyEntries);
  });

  it("inverse is null when larger than inverseBytes", async () => {
    const { board, col } = await ready();
    const { cardId } = await create(board, col.Backlog, { description: "x".repeat(5000) });
    const r = await apply(board, { cardOps: [{ op: "upsert", cardId, baseVersion: 1, card: { description: "short" } }] });
    expect(r.history.inverse).toBeNull();
    const u = await board.undo({ historyId: r.history.id });
    expect(u.result.errors[0].code).toBe("invalid_op");
  });

  it("undoes create, edit, move and delete", async () => {
    const { board, col, events } = await ready();
    const { cardId, result: created } = await create(board, col.Backlog, { title: "T", checklist: [{ text: "a" }] });

    const edit = await apply(board, { cardOps: [{ op: "upsert", cardId, baseVersion: 1, card: { title: "T2", assignee: "Sam" } }] });
    const move = await apply(board, { cardOps: [{ op: "move", cardId, baseVersion: 2, toColumnId: col.Done }] });
    // Someone else edits after the move; undo still applies against current versions.
    await apply(board, { cardOps: [{ op: "upsert", cardId, baseVersion: 3, card: { description: "later" } }] });

    let u = await board.undo({ historyId: move.history.id, by: "Undoer", senderId: "u1" });
    expect(u.result.status).toBe("applied");
    expect(u.result.upserts[0]).toMatchObject({ columnId: col.Backlog, description: "later" });
    expect(u.result.history).toMatchObject({ by: "Undoer", summary: 'Undid: Moved "T2" to Backlog' });
    expect(events.at(-1)).toMatchObject({ type: "operation", senderId: "u1" });

    u = await board.undo({ historyId: edit.history.id });
    expect(u.result.upserts[0]).toMatchObject({ title: "T", assignee: "" });

    const snapBefore = (await board.getBoard()).cards[cardId];
    const del = await apply(board, { cardOps: [{ op: "delete", cardId, baseVersion: snapBefore.version }] });
    u = await board.undo({ historyId: del.history.id });
    const restored = u.result.upserts[0];
    expect(restored).toMatchObject({ ...snapBefore, version: snapBefore.version + 1, updatedAt: expect.any(Number) });
    expect(restored.createdAt).toBe(snapBefore.createdAt);

    // Undo of an undo re-applies.
    const redo = await board.undo({ historyId: u.result.history.id });
    expect(redo.result.deletes).toEqual([{ cardId, columnId: col.Backlog }]);
    const u2 = await board.undo({ historyId: redo.result.history.id });
    expect(u2.result.upserts[0].id).toBe(cardId);

    u = await board.undo({ historyId: created.history.id });
    expect(u.result.deletes).toEqual([{ cardId, columnId: col.Backlog }]);
    expect((await board.getBoard()).cards[cardId]).toBeUndefined();
    // Undoing the create again: the card is gone, so nothing changes.
    u = await board.undo({ historyId: created.history.id });
    expect(u.result.status).toBe("unchanged");
    expect(u.result.errors[0].code).toBe("unknown_card");
    expect((await board.undo({ historyId: "h_00000000" })).result.errors[0].code).toBe("invalid_op");
    expect((await board.undo(null)).result.status).toBe("unchanged");
  });

  it("undoes column rename, collapse and reorder", async () => {
    const { board, col, snap } = await ready();
    const r = await apply(board, { columnOps: [
      { op: "upsert", columnId: col.Done, baseVersion: 1, column: { name: "Shipped", collapsed: true } },
      { op: "move", columnId: col.Done, index: 0 },
    ] });
    expect(r.history.inverse.columnOps.length).toBeGreaterThan(0);
    const u = await board.undo({ historyId: r.history.id });
    expect(u.result.structure.columnOrder).toEqual(snap.columnOrder);
    expect(u.result.structure.columns[col.Done]).toMatchObject({ name: "Done", collapsed: false, version: 3 });
  });
});

describe("mutation queue", () => {
  it("survives a throwing repository commit and reloads state", async () => {
    const { board, col, repo } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "T" });
    const real = repo.commit.bind(repo);
    repo.commit = async () => { throw new Error("disk full"); };
    await expect(apply(board, { cardOps: [{ op: "upsert", cardId, baseVersion: 1, card: { title: "lost" } }] })).rejects.toThrow("disk full");
    repo.commit = real;
    const snap = await board.getBoard();
    expect(snap.cards[cardId].title).toBe("T");
    expect(snap.revision).toBe(1);
    const r = await apply(board, { cardOps: [{ op: "upsert", cardId, baseVersion: 1, card: { title: "ok" } }] });
    expect(r.status).toBe("applied");
  });

  it("a throwing onEvent does not fail the write", async () => {
    const { board, col } = await ready({ onEvent: () => { throw new Error("listener"); } });
    const { result } = await create(board, col.Backlog, { title: "T" });
    expect(result.status).toBe("applied");
  });

  it("serialises 50 concurrent moves", async () => {
    const { board, col, events } = await ready();
    const cards = [];
    for (let i = 0; i < 5; i++) cards.push((await create(board, col.Backlog, { title: "c" + i })).cardId);
    const startRevision = (await board.getBoard()).revision;
    const targets = [col.Backlog, col["To do"], col["In progress"], col.Done];
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      board.moveCard({ cardId: cards[i % 5], toColumn: targets[(i * 7) % 4], position: i % 3 === 0 ? "top" : i % 3 }).then((x) => x.result)));
    const applied = results.filter((r) => r.status === "applied").length;
    const snap = await board.getBoard();
    expect(snap.revision).toBe(startRevision + applied);
    expect(results.every((r) => r.status !== "conflict")).toBe(true);
    const opEvents = events.slice(-applied);
    expect(opEvents.map((e) => e.revision)).toEqual(Array.from({ length: applied }, (_, i) => startRevision + i + 1));
    // Every card still exists exactly once, in a known column, with a valid key.
    expect(Object.keys(snap.cards).sort()).toEqual([...cards].sort());
    for (const c of Object.values(snap.cards)) {
      expect(snap.columnOrder).toContain(c.columnId);
      expect(isValidOrderKey(c.order)).toBe(true);
    }
  });
});

describe("comments", () => {
  it("appends, lists oldest first and emits a comment event", async () => {
    const { board, col, events } = await ready();
    const { cardId } = await create(board, col.Backlog, { title: "T" });
    const revision = (await board.getBoard()).revision;
    const { comment, event } = await board.addComment({ senderId: "s9", cardId, author: "Ann", text: "one" });
    await board.addComment({ cardId, author: "Bob", text: "two\r\nlines" });
    expect(comment).toMatchObject({ cardId, author: "Ann", text: "one", id: expect.stringMatching(/^m_[0-9a-f]{8}$/) });
    expect(event).toEqual({ type: "comment", senderId: "s9", comment });
    expect(events.at(-2)).toEqual(event);
    expect((await board.getComments(cardId)).map((c) => c.text)).toEqual(["one", "two\nlines"]);
    expect((await board.getBoard()).revision).toBe(revision);
    expect(await board.getComments("nope")).toEqual([]);
  });

  it("rejects unknown cards and empty text with clear errors", async () => {
    const { board, col } = await ready();
    await expect(board.addComment({ cardId: "c_00000000", text: "x" })).rejects.toThrow(/no card c_00000000/);
    await expect(board.addComment({ cardId: "bad", text: "x" })).rejects.toThrow(/cardId/);
    const { cardId } = await create(board, col.Backlog, { title: "T" });
    await expect(board.addComment({ cardId, text: "   " })).rejects.toThrow(/empty/);
    await expect(board.addComment(null)).rejects.toThrow();
    expect((await board.addComment({ cardId, text: "still works" })).comment.text).toBe("still works");
  });
});

describe("convenience methods", () => {
  it("addCards resolves columns and labels by name and accepts checklist strings", async () => {
    const { board, label, col, events } = await ready();
    const { created, errors, event } = await board.addCards({ by: "Assistant", cards: [
      { column: "backlog", title: "Set up laptop", labels: ["chore", "Nope", label.Bug], checklist: ["Order", "Image"], due: "2026-10-01", assignee: "Sam" },
      { column: "Nowhere", title: "lost" },
      { column: col.Done, title: "done one" },
      "junk",
    ] });
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ columnId: col.Backlog, labels: [label.Chore, label.Bug], due: "2026-10-01", createdBy: "Assistant" });
    expect(created[0].checklist.map((i) => [i.text, i.done])).toEqual([["Order", false], ["Image", false]]);
    expect(errors.map((e) => [e.index, e.code])).toEqual([[1, "unknown_column"], [3, "invalid_op"]]);
    expect(event).toBe(events.at(-1));
    expect((await board.addCards({})).created).toEqual([]);
  });

  it("updateCard, moveCard, deleteCard never conflict", async () => {
    const { board, col } = await ready();
    const { created } = await board.addCards({ cards: [{ column: "To do", title: "A" }, { column: "To do", title: "B" }, { column: "To do", title: "C" }] });
    const [a, b, c] = created;
    await board.updateCard({ cardId: a.id, fields: { title: "A1" } });
    let { result } = await board.updateCard({ cardId: a.id, fields: { title: "A2", labels: "Bug", due: null } });
    expect(result.status).toBe("applied");
    expect(result.upserts[0]).toMatchObject({ title: "A2", version: 3, labels: [expect.stringMatching(/^l_/)] });

    ({ result } = await board.moveCard({ cardId: c.id, toColumn: "to do", position: "top" }));
    let snap = await board.getBoard();
    expect(cardsInColumn(snap.cards, col["To do"]).map((x) => x.title)).toEqual(["C", "A2", "B"]);
    ({ result } = await board.moveCard({ cardId: c.id, toColumn: "To do", position: 2 }));
    snap = await board.getBoard();
    expect(cardsInColumn(snap.cards, col["To do"]).map((x) => x.title)).toEqual(["A2", "B", "C"]);
    ({ result } = await board.moveCard({ cardId: b.id, toColumn: "To do", position: 0 }));
    snap = await board.getBoard();
    expect(cardsInColumn(snap.cards, col["To do"]).map((x) => x.title)).toEqual(["B", "A2", "C"]);
    ({ result } = await board.moveCard({ cardId: a.id, toColumn: "Done" }));
    expect(result.moved).toEqual([{ cardId: a.id, fromColumnId: col["To do"], toColumnId: col.Done }]);
    expect((await board.moveCard({ cardId: a.id, toColumn: "Mars" })).result.errors[0].code).toBe("unknown_column");
    expect((await board.moveCard({ cardId: a.id, toColumn: "Done", position: "middle" })).result.errors[0].code).toBe("invalid_op");

    ({ result } = await board.deleteCard({ cardId: b.id }));
    expect(result.deletes).toEqual([{ cardId: b.id, columnId: col["To do"] }]);
    expect((await board.deleteCard({ cardId: b.id })).result.errors[0].code).toBe("unknown_card");
    expect((await board.updateCard({ cardId: "x" })).result.errors[0].code).toBe("invalid_id");
  });

  it("addColumn returns the column", async () => {
    const { board } = await ready();
    const { column, errors, event } = await board.addColumn({ name: "Review", index: 1, by: "A" });
    expect(column).toMatchObject({ name: "Review", version: 1, collapsed: false });
    expect(errors).toEqual([]);
    expect(event.structure.columnOrder[1]).toBe(column.id);
  });

  it("findCards filters by column, label, assignee and text", async () => {
    const { board, col } = await ready();
    await board.addCards({ cards: [
      { column: "In progress", title: "Fix login", labels: ["Bug"], assignee: "Sam" },
      { column: "In progress", title: "Other", description: "LOGIN page", assignee: "sam " },
      { column: "Backlog", title: "Login redesign", labels: ["Feature"], assignee: "Kim" },
    ] });
    expect((await board.findCards()).map((c) => c.title)).toEqual(["Login redesign", "Fix login", "Other"]);
    expect((await board.findCards({ column: "In progress", label: "Bug", assignee: "Sam", text: "login" })).map((c) => c.title)).toEqual(["Fix login"]);
    expect((await board.findCards({ text: "login", assignee: "SAM" })).map((c) => c.title)).toEqual(["Fix login", "Other"]);
    expect((await board.findCards({ column: col.Backlog })).map((c) => c.title)).toEqual(["Login redesign"]);
    expect(await board.findCards({ column: "Nope" })).toEqual([]);
    expect(await board.findCards({ label: "Nope" })).toEqual([]);
  });
});
