import { describe, expect, it } from "vitest";
import { cardsInColumn } from "../../src/shared/protocol.js";
import { isValidOrderKey } from "../../src/shared/order.js";
import { diffBoards } from "../../src/client/model/diff.js";
import { buildRequest, deriveBoard, dependsOn, mergeOps } from "../../src/client/model/ops.js";
import { placeCard } from "../../src/client/model/placement.js";
import { decidePatchConflict, mergeChecklist } from "../../src/client/model/rebase.js";
import { applyUpdate, createServerModel } from "../../src/client/model/server-model.js";

/** @param {Partial<import("../../src/shared/protocol.js").Card>} f */
function card(f) {
  return {
    id: "c_00000001", columnId: "k_00000001", order: "a0", title: "", description: "", labels: [],
    assignee: "", due: null, checklist: [], version: 1, createdAt: 0, updatedAt: 0, createdBy: "",
    ...f,
  };
}

function board(cards = {}) {
  return {
    schemaVersion: 1, revision: 5, title: "B", columnOrder: ["k_00000001", "k_00000002"],
    columns: {
      k_00000001: { id: "k_00000001", name: "A", version: 1, collapsed: false },
      k_00000002: { id: "k_00000002", name: "B", version: 1, collapsed: false },
    },
    cards, labels: {}, lastModified: 0,
  };
}

describe("placeCard", () => {
  const cards = {
    c_00000001: card({ id: "c_00000001", order: "a0" }),
    c_00000002: card({ id: "c_00000002", order: "a1" }),
  };

  it("uses a0 in an empty column", () => {
    expect(placeCard(cards, "k_00000002", null)).toEqual({ order: "a0", rekey: [] });
  });

  it("appends at the end when beforeCardId is null or unknown", () => {
    expect(placeCard(cards, "k_00000001", null).order).toBe("a2");
    expect(placeCard(cards, "k_00000001", "c_0000dead").order).toBe("a2");
  });

  it("places before the first card and between two cards", () => {
    const first = placeCard(cards, "k_00000001", "c_00000001").order;
    expect(first < "a0").toBe(true);
    const mid = placeCard(cards, "k_00000001", "c_00000002").order;
    expect(mid > "a0" && mid < "a1").toBe(true);
  });

  it("ignores the moving card itself", () => {
    // Moving card 1 to before card 2 in its own column: neighbours are (none, a1).
    const { order } = placeCard(cards, "k_00000001", "c_00000002", "c_00000001");
    expect(order < "a1").toBe(true);
  });

  it("re-keys the column when neighbour keys are equal or invalid", () => {
    const tied = {
      c_00000001: card({ id: "c_00000001", order: "a0" }),
      c_00000002: card({ id: "c_00000002", order: "a0" }),
      c_00000003: card({ id: "c_00000003", order: "!!" }),
    };
    const { order, rekey } = placeCard(tied, "k_00000001", "c_00000002");
    const next = { ...tied };
    for (const r of rekey) next[r.cardId] = { ...next[r.cardId], order: r.order };
    next.c_0000000f = card({ id: "c_0000000f", order });
    const ids = cardsInColumn(next, "k_00000001").map((c) => c.id);
    expect(ids).toEqual(["c_00000003", "c_00000001", "c_0000000f", "c_00000002"]);
    expect(Object.values(next).every((c) => isValidOrderKey(c.order))).toBe(true);
    expect(new Set(Object.values(next).map((c) => c.order)).size).toBe(4);
  });
});

describe("mergeChecklist and decidePatchConflict", () => {
  const base = [{ id: "i_00000001", text: "one", done: false }, { id: "i_00000002", text: "two", done: false }];

  it("re-applies my toggles by item id onto theirs", () => {
    const mine = [base[0], { ...base[1], done: true }];
    const theirs = [{ ...base[0], done: true }, base[1], { id: "i_00000003", text: "three", done: false }];
    expect(mergeChecklist(base, mine, theirs)).toEqual([
      { id: "i_00000001", text: "one", done: true },
      { id: "i_00000002", text: "two", done: true },
      { id: "i_00000003", text: "three", done: false },
    ]);
  });

  it("keeps additions and removals", () => {
    const mine = [base[1], { id: "i_00000009", text: "new", done: false }];
    expect(mergeChecklist(base, mine, base).map((i) => i.id)).toEqual(["i_00000002", "i_00000009"]);
  });

  it("acks when theirs already equals mine", () => {
    const d = decidePatchConflict({ title: "X" }, card({ title: "A" }), card({ title: "X", version: 2 }), 0);
    expect(d.action).toBe("ack");
  });

  it("retries when they changed other fields only", () => {
    const d = decidePatchConflict({ title: "X" }, card({ title: "A" }),
      card({ title: "A", description: "theirs", version: 2 }), 0);
    expect(d).toEqual({ action: "retry", patch: { title: "X" } });
  });

  it("conflicts when they changed the same field, or the card is gone", () => {
    expect(decidePatchConflict({ title: "X" }, card({ title: "A" }), card({ title: "Y", version: 2 }), 0).action)
      .toBe("conflict");
    expect(decidePatchConflict({ title: "X" }, card({ title: "A" }), null, 0).action).toBe("conflict");
  });
});

describe("server model", () => {
  it("ignores updates not newer than what it holds", () => {
    const m = createServerModel(board({ c_00000001: card({ title: "old" }) }));
    const newer = card({ title: "new", version: 2 });
    expect(applyUpdate(m, { upserts: [newer] }, 6).cards).toEqual(["c_00000001"]);
    expect(applyUpdate(m, { upserts: [newer] }, 6).cards).toEqual([]); // echo
    expect(applyUpdate(m, { upserts: [card({ title: "stale", version: 1 })] }, 7).cards).toEqual([]);
    expect(m.board.cards.c_00000001.title).toBe("new");
    applyUpdate(m, { deletes: [{ cardId: "c_00000001" }] }, 8);
    applyUpdate(m, { upserts: [newer] }, 7); // older than the delete
    expect(m.board.cards.c_00000001).toBeUndefined();
    expect(m.board.revision).toBe(8);
  });
});

describe("ops", () => {
  it("derives an optimistic board without mutating the server board", () => {
    const server = board({ c_00000001: card({}) });
    const b = deriveBoard(server, [
      { type: "card.move", cardId: "c_00000001", toColumnId: "k_00000002", order: "a5" },
      { type: "column.move", columnId: "k_00000002", index: 0 },
    ]);
    expect(b.cards.c_00000001.columnId).toBe("k_00000002");
    expect(b.columnOrder).toEqual(["k_00000002", "k_00000001"]);
    expect(server.cards.c_00000001.columnId).toBe("k_00000001");
    expect(diffBoards(server, b)).toEqual({ all: true, columns: ["k_00000002", "k_00000001"], cards: ["c_00000001"] });
  });

  it("merges patches and create+patch, and cancels create+delete", () => {
    expect(mergeOps({ type: "card.patch", cardId: "c_1", patch: { title: "a" } },
      { type: "card.patch", cardId: "c_1", patch: { description: "d" } }))
      .toEqual({ type: "card.patch", cardId: "c_1", patch: { title: "a", description: "d" } });
    const create = { type: "card.create", cardId: "c_1", columnId: "k_1", fields: { order: "a0" }, createdAt: 0, createdBy: "" };
    expect(mergeOps(create, { type: "card.patch", cardId: "c_1", patch: { title: "t" } }))
      .toMatchObject({ fields: { order: "a0", title: "t" } });
    expect(mergeOps(create, { type: "card.delete", cardId: "c_1" })).toBe("cancel");
    expect(mergeOps(create, { type: "card.patch", cardId: "c_2", patch: {} })).toBeNull();
  });

  it("keeps dependent ops out of the same request", () => {
    const colCreate = { type: "column.create", columnId: "k_9", name: "x" };
    expect(dependsOn(colCreate, { type: "card.create", cardId: "c_1", columnId: "k_9", fields: {} })).toBe(true);
    expect(dependsOn({ type: "card.move", cardId: "c_1", toColumnId: "k_1", order: "a0" },
      { type: "card.move", cardId: "c_2", toColumnId: "k_1", order: "a1" })).toBe(false);
    expect(dependsOn({ type: "label.upsert", labelId: "l_1", label: { name: "", color: "" } },
      { type: "card.patch", cardId: "c_1", patch: { labels: ["l_1"] } })).toBe(true);
  });

  it("builds a request with versions read at send time", () => {
    const ops = [
      { type: "card.patch", cardId: "c_1", patch: { title: "t" } },
      { type: "column.rename", columnId: "k_1", name: "n" },
      { type: "title", title: "T" },
    ];
    const { request, refs } = buildRequest(/** @type {any} */ (ops), {
      senderId: "me", by: "Me", cardVersion: () => 7, columnVersion: () => 3,
    });
    expect(request).toEqual({
      senderId: "me", by: "Me",
      cardOps: [{ op: "upsert", cardId: "c_1", baseVersion: 7, card: { title: "t" } }],
      columnOps: [{ op: "upsert", columnId: "k_1", baseVersion: 3, column: { name: "n" } }],
      structure: { title: "T" },
    });
    expect(refs.get(/** @type {any} */ (ops[2]))).toEqual({ array: "structure", index: -1 });
  });
});
