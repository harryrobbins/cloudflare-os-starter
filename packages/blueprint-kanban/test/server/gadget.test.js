// Server tests in workerd: the Gadget Durable Object over real DO storage, RPC callbacks,
// presence and the ExportHandler. Storage persists between tests, so each test uses its own DO.
import { env, exports, RpcTarget } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { DoStorageRepository } from "../../src/server/do-repository.js";
import { ExportHandler } from "../../src/server/index.js";

class Callbacks extends RpcTarget {
  ops = [];
  presences = [];
  operation(event) {
    this.ops.push(event);
  }
  presence(event) {
    this.presences.push(event);
  }
}

// A subscriber whose deliveries reject. (Exceptions thrown inside an RPC method are reported by
// the pool as unhandled errors, so the rejection comes from calling a method it lacks instead.)
class Dead extends RpcTarget {
  presence() {}
}

const idFor = (name) => env.GADGET.idFromName(name);
const fresh = () => {
  const name = crypto.randomUUID();
  return { name, stub: env.GADGET.get(idFor(name)), again: () => env.GADGET.get(idFor(name)) };
};
const cardId = () => "c_" + crypto.randomUUID().slice(0, 8);

async function boardWithCard(stub, card = { title: "Hello" }) {
  const board = await stub.getBoard();
  const columnId = board.columnOrder[0];
  const id = cardId();
  const result = await stub.applyOperation({
    senderId: "setup", by: "Tester",
    cardOps: [{ op: "upsert", cardId: id, columnId, baseVersion: 0, card }],
  });
  return { board, columnId, id, result };
}

describe("storage", () => {
  it("uses exactly the README key layout", async () => {
    const { stub } = fresh();
    const { id } = await boardWithCard(stub);
    const comment = await stub.addComment({ cardId: id, author: "Ann", text: "hi" });
    const keys = await runInDurableObject(stub, async (_instance, state) => [...(await state.storage.list()).keys()]);
    expect(keys.sort()).toEqual([
      `card:${id}`,
      `comment:${id}:${String(comment.at).padStart(13, "0")}:${comment.id}`,
      "history",
      "labels",
      "meta",
    ].sort());
    const raw = await runInDurableObject(stub, async (_i, state) => ({
      meta: await state.storage.get("meta"),
      card: await state.storage.get(`card:${id}`),
      history: await state.storage.get("history"),
    }));
    expect(Object.keys(raw.meta).sort()).toEqual(["columnOrder", "columns", "lastModified", "revision", "schemaVersion", "title"]);
    expect(raw.meta.revision).toBe(1);
    expect(raw.card).toMatchObject({ id, title: "Hello", version: 1 });
    expect(raw.history).toHaveLength(1);
  });

  it("commit is atomic: a failing write rolls back earlier writes in the same commit", async () => {
    const { stub } = fresh();
    await runInDurableObject(stub, async (_instance, state) => {
      const repo = new DoStorageRepository(state.storage);
      const card = { id: "c_00000001", title: "keep" };
      await repo.commit({ putCards: [card], meta: { revision: 1 } });
      await expect(repo.commit({
        deleteCards: ["c_00000001"],           // runs first
        meta: { revision: 2 },
        putCards: [{ id: "c_00000002", notCloneable: () => 1 }], // then the put throws
      })).rejects.toThrow();
      expect(await state.storage.get("card:c_00000001")).toEqual(card);
      expect(await state.storage.get("meta")).toEqual({ revision: 1 });
      expect(await state.storage.get("card:c_00000002")).toBeUndefined();
    });
  });

  it("deleting a card removes all its comment keys, beyond one 128-key batch", async () => {
    const { stub } = fresh();
    await runInDurableObject(stub, async (_instance, state) => {
      const repo = new DoStorageRepository(state.storage);
      const comments = Array.from({ length: 300 }, (_, i) => ({ id: "m_" + i.toString(16).padStart(8, "0"), cardId: "c_00000001", author: "a", text: "t", at: 1000 + i }));
      await repo.commit({ putCards: [{ id: "c_00000001" }], putComments: comments });
      expect(await repo.countComments("c_00000001")).toBe(300);
      expect((await repo.getComments("c_00000001")).map((c) => c.at)).toEqual(comments.map((c) => c.at));
      await repo.commit({ deleteCards: ["c_00000001"], deleteCommentsFor: ["c_00000001"] });
      expect((await state.storage.list()).size).toBe(0);
    });
  });

  it("board survives a restart", async () => {
    const { stub, again } = fresh();
    const { id } = await boardWithCard(stub, { title: "Durable" });
    await stub.addComment({ cardId: id, author: "A", text: "persisted" });
    await abortAllDurableObjects();
    const board = await again().getBoard();
    expect(board.revision).toBe(1);
    expect(board.cards[id].title).toBe("Durable");
    expect((await again().getComments(id)).map((c) => c.text)).toEqual(["persisted"]);
    expect(await again().getHistory()).toHaveLength(1);
  });
});

describe("RPC surface", () => {
  it("applyOperation, undo, history and comments return plain results", async () => {
    const { stub } = fresh();
    const { id, columnId, result } = await boardWithCard(stub);
    expect(result).toMatchObject({ status: "applied", revision: 1, conflicts: [], errors: [] });
    expect(result).not.toHaveProperty("event");
    const conflict = await stub.applyOperation({ cardOps: [{ op: "upsert", cardId: id, baseVersion: 7, card: { title: "x" } }] });
    expect(conflict.conflicts[0].current.title).toBe("Hello");
    const board = await stub.getBoard();
    const done = board.columnOrder.at(-1);
    const moved = await stub.applyOperation({ cardOps: [{ op: "move", cardId: id, baseVersion: 1, toColumnId: done }] });
    const undone = await stub.undo({ historyId: moved.history.id, by: "U" });
    expect(undone.upserts[0].columnId).toBe(columnId);
    expect((await stub.getHistory(2)).map((h) => h.by)).toEqual(["Anonymous", "U"]);
  });

  it("convenience methods work by name", async () => {
    const { stub } = fresh();
    const added = await stub.addCards({ by: "Assistant", cards: [
      { column: "backlog", title: "Set up laptop", labels: ["Chore"], checklist: ["Order", "Image"] },
      { column: "Nope", title: "x" },
    ] });
    expect(Object.keys(added).sort()).toEqual(["created", "errors"]);
    expect(added.created).toHaveLength(1);
    expect(added.errors[0]).toMatchObject({ index: 1, code: "unknown_column" });
    const id = added.created[0].id;
    expect((await stub.updateCard({ cardId: id, fields: { title: "Laptop" } })).upserts[0].title).toBe("Laptop");
    expect((await stub.moveCard({ cardId: id, toColumn: "Done", position: "top" })).moved).toHaveLength(1);
    expect((await stub.findCards({ column: "done", label: "chore" })).map((c) => c.title)).toEqual(["Laptop"]);
    const col = await stub.addColumn({ name: "Review", index: 1 });
    expect(Object.keys(col).sort()).toEqual(["column", "errors"]);
    expect(col.column.name).toBe("Review");
    expect((await stub.deleteCard({ cardId: id })).deletes).toEqual([{ cardId: id, columnId: expect.stringMatching(/^k_/) }]);
  });
});

describe("live updates", () => {
  it("subscribers receive operation diffs carrying senderId, and comment events", async () => {
    const { stub, again } = fresh();
    const a = new Callbacks();
    const b = new Callbacks();
    const snapA = await stub.subscribe(a, { clientId: "A", name: "Ann", color: "#112233" });
    await again().subscribe(b, { clientId: "B", name: "Bob", color: "#445566" });
    expect(snapA.revision).toBe(0);

    const { id } = await boardWithCard(again());
    await stub.addComment({ senderId: "A", cardId: id, author: "Ann", text: "hello" });
    await vi.waitFor(() => {
      expect(a.ops).toHaveLength(2);
      expect(b.ops).toHaveLength(2);
    });
    for (const cb of [a, b]) {
      expect(cb.ops[0]).toMatchObject({ type: "operation", senderId: "setup", revision: 1, deletes: [], moved: [] });
      expect(cb.ops[0].upserts[0].id).toBe(id);
      expect(cb.ops[1]).toMatchObject({ type: "comment", senderId: "A", comment: { cardId: id, text: "hello" } });
    }
  });

  it("delivers events in revision order", async () => {
    const { stub } = fresh();
    const cb = new Callbacks();
    const board = await stub.subscribe(cb, { clientId: "A" });
    const columnId = board.columnOrder[0];
    await Promise.all(Array.from({ length: 20 }, () => stub.applyOperation({
      cardOps: [{ op: "upsert", cardId: cardId(), columnId, baseVersion: 0, card: { title: "t" } }],
    })));
    await vi.waitFor(() => expect(cb.ops).toHaveLength(20));
    expect(cb.ops.map((e) => e.revision)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("a failing subscriber is removed and others see it leave", async () => {
    const { stub } = fresh();
    const good = new Callbacks();
    await stub.subscribe(good, { clientId: "G", name: "Good" });
    await stub.subscribe(new Dead(), { clientId: "T", name: "Bad" });
    await boardWithCard(stub);
    await vi.waitFor(() => expect(good.presences.some((p) => p.type === "leave" && p.clientId === "T")).toBe(true));
    expect(good.ops).toHaveLength(1);
    expect(await stub.updatePresence({ clientId: "T" })).toMatchObject({ known: false });
    expect(await stub.updatePresence({ clientId: "G" })).toMatchObject({ known: true });
  });

  it("presence join (with replay), update and leave", async () => {
    const { stub } = fresh();
    const a = new Callbacks();
    const b = new Callbacks();
    await stub.subscribe(a, { clientId: "A", name: "Ann", color: "#112233" });
    await stub.subscribe(b, { clientId: "B", name: "Bob", color: "not a colour" });
    await vi.waitFor(() => expect(b.presences).toHaveLength(2));
    expect(b.presences.map((p) => [p.type, p.clientId])).toEqual([["join", "A"], ["join", "B"]]);
    expect(b.presences[0]).toMatchObject({ name: "Ann", color: "#112233", openCardId: null, at: expect.any(Number) });
    await vi.waitFor(() => expect(a.presences.map((p) => p.clientId)).toEqual(["A", "B"]));

    const { id } = await boardWithCard(stub);
    const r = await stub.updatePresence({ clientId: "A", name: "Ann", color: "#112233", openCardId: id, dragCardId: "<script>", hoverColumnId: null });
    expect(r).toEqual({ known: true, revision: 1 });
    await vi.waitFor(() => expect(b.presences.at(-1)).toMatchObject({ type: "update", clientId: "A", openCardId: id, dragCardId: null }));

    await stub.leavePresence("A");
    await vi.waitFor(() => expect(b.presences.at(-1)).toMatchObject({ type: "leave", clientId: "A" }));
    expect(await stub.updatePresence({ clientId: "A" })).toEqual({ known: false, revision: 1 });
    expect(await stub.updatePresence({ clientId: "nobody" })).toEqual({ known: false, revision: 1 });
  });

  it("updatePresence reports known: false after a restart", async () => {
    const { stub, again } = fresh();
    await stub.subscribe(new Callbacks(), { clientId: "A" });
    expect((await stub.updatePresence({ clientId: "A" })).known).toBe(true);
    await abortAllDurableObjects();
    expect(await again().updatePresence({ clientId: "A" })).toEqual({ known: false, revision: 0 });
  });
});

describe("ExportHandler", () => {
  it("lists CSV (server) and HTML/PDF (browser) formats", async () => {
    const { stub } = fresh();
    const formats = await exports.ExportHandler.getExportFormats(stub);
    expect(formats).toEqual([
      { id: "csv", label: "CSV (all cards)", mode: "server", contentType: "text/csv", fileExtension: ".csv" },
      { id: "html", label: "HTML", mode: "browser", contentType: "text/html", fileExtension: ".html" },
      { id: "pdf", label: "PDF", mode: "browser", contentType: "application/pdf", fileExtension: ".pdf" },
    ]);
  });

  it("exports all cards as CSV with formula injection neutralised", async () => {
    const { stub } = fresh();
    const { id } = await boardWithCard(stub, { title: "=HYPERLINK(\"http://evil\")", description: "line1\nline2, with comma", labels: [] });
    const board = await stub.getBoard();
    const bug = Object.values(board.labels).find((l) => l.name === "Bug").id;
    await stub.updateCard({ cardId: id, fields: { labels: [bug], assignee: "@sam", checklist: [{ text: "a", done: true }, "b"] } });
    await stub.addCards({ cards: [{ column: "Done", title: "Plain" }] });

    const text = await new Response(await exports.ExportHandler.export(stub, "csv")).text();
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("Column,Title,Description,Labels,Assignee,Due,Checklist done,Checklist total,Created,Updated,Created by,Card id");
    expect(text).toContain(`Backlog,"'=HYPERLINK(""http://evil"")","line1\nline2, with comma",Bug,'@sam,,1,2,`);
    expect(text).toMatch(/\r\nDone,Plain,,,,,0,0,/);
    expect(text.endsWith("\r\n")).toBe(true);
    // Called directly: an exception thrown across RPC is reported by the pool as unhandled.
    await expect(ExportHandler.prototype.export.call(null, stub, "html")).rejects.toThrow(/Unknown/);
  });
});
