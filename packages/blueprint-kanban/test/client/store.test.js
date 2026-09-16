import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESENCE_HEARTBEAT_MS, cardsInColumn } from "../../src/shared/protocol.js";
import { FakeServer, settle, startStore } from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Opens a board with two columns and one card, and connects `n` stores. */
async function setup({ n = 2, latency = 5, eventLatency = undefined, card = {} } = {}) {
  const server = new FakeServer({ latency, eventLatency });
  const todo = server.seedColumn("To do");
  const done = server.seedColumn("Done");
  const cardId = server.seedCard(todo, { title: "Seed", ...card });
  const clients = [];
  for (let i = 0; i < n; i++) clients.push(await startStore(server, "user" + i));
  await settle();
  return { server, todo, done, cardId, clients };
}

/** @param {any} store */
function titles(store, columnId) {
  return cardsInColumn(store.getState().board.cards, columnId).map((c) => c.title);
}

function opsFrom(server, clientId) {
  return server.callsOf("applyOperation").filter((c) => c.args[0].senderId === clientId);
}

describe("convergence", () => {
  it("two stores converge after concurrent creates, moves and edits", async () => {
    const { server, todo, done, cardId, clients: [a, b] } = await setup({ latency: 20 });
    a.store.createCard(todo, { title: "From A" });
    b.store.createCard(todo, { title: "From B" }, cardId);
    a.store.moveCard(cardId, done, null);
    b.store.updateCard(cardId, { description: "B's notes" });
    a.store.updateCard(cardId, { assignee: "Sam" });
    await settle(500);

    const expected = server.board().cards;
    expect(a.store.getState().board.cards).toEqual(expected);
    expect(b.store.getState().board.cards).toEqual(expected);
    expect(a.store.getState().pending).toBe(0);
    expect(b.store.getState().pending).toBe(0);
    expect(expected[cardId]).toMatchObject({ columnId: done, description: "B's notes", assignee: "Sam" });
    expect(titles(a.store, todo)).toEqual(titles(b.store, todo));
    expect(titles(a.store, todo)).toContain("From A");
    expect(a.store.getState().conflicts.size + b.store.getState().conflicts.size).toBe(0);
  });

  it("columns, labels and the title sync too", async () => {
    const { server, todo, clients: [a, b] } = await setup();
    const col = a.store.createColumn("Review", 1);
    const label = a.store.upsertLabel(null, "Bug", "#ff0000");
    b.store.setTitle("Renamed board");
    a.store.setColumnCollapsed(todo, true);
    await settle(200);
    for (const s of [a.store, b.store]) {
      const board = s.getState().board;
      expect(board.columnOrder).toEqual(server.board().columnOrder);
      expect(board.columnOrder[1]).toBe(col);
      expect(board.labels[label]).toMatchObject({ name: "Bug", color: "#ff0000" });
      expect(board.title).toBe("Renamed board");
      expect(board.columns[todo].collapsed).toBe(true);
    }
  });
});

describe("echo suppression", () => {
  for (const [label, eventLatency] of [["echo before ack", 1], ["echo after ack", 60]]) {
    it(`applies an own change once and never flickers (${label})`, async () => {
      const { server, cardId, clients: [a] } = await setup({ latency: 20, eventLatency });
      const seen = [];
      a.store.subscribe((state) => seen.push(state.board.cards[cardId].title));
      a.store.updateCard(cardId, { title: "One" });
      await settle(5);
      a.store.updateCard(cardId, { title: "Two" });
      await settle(500);
      expect(seen.length).toBeGreaterThan(0);
      const firstTwo = seen.indexOf("Two");
      expect(seen.slice(firstTwo).every((t) => t === "Two")).toBe(true);
      expect(seen.slice(0, firstTwo).every((t) => t === "One")).toBe(true);
      expect(a.store.getState().board.cards[cardId]).toEqual(server.board().cards[cardId]);
      const ids = a.store.getState().history.map((h) => h.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBe(2);
    });
  }

  it("emits no board change for its own echo", async () => {
    const { cardId, clients: [a] } = await setup({ latency: 10, eventLatency: 40 });
    a.store.updateCard(cardId, { title: "X" });
    await settle(25); // ack arrived, echo not yet
    const count = a.changes.filter((c) => c.change.kind === "operation").length;
    await settle(100);
    expect(a.changes.filter((c) => c.change.kind === "operation").length).toBe(count);
  });
});

describe("placement through the store", () => {
  it("creates before a card, at the end, and in an empty column", async () => {
    const { todo, done, cardId, clients: [a] } = await setup({ n: 1 });
    a.store.createCard(todo, { title: "End" });
    a.store.createCard(todo, { title: "Top" }, cardId);
    a.store.createCard(done, { title: "Only" });
    expect(titles(a.store, todo)).toEqual(["Top", "Seed", "End"]);
    expect(titles(a.store, done)).toEqual(["Only"]);
    await settle(200);
    expect(titles(a.store, todo)).toEqual(["Top", "Seed", "End"]);
  });

  it("re-keys a column with tied keys and sends the moves", async () => {
    const server = new FakeServer({ latency: 5 });
    const col = server.seedColumn("C");
    server.seedCard(col, { title: "1", order: "a0" });
    server.seedCard(col, { title: "2", order: "a0" });
    const a = await startStore(server, "a");
    const ids = cardsInColumn(server.board().cards, col).map((c) => c.id);
    a.store.createCard(col, { title: "new" }, ids[1]);
    await settle(200);
    const final = cardsInColumn(server.board().cards, col).map((c) => c.title);
    expect(final).toEqual([server.cards[ids[0]].title, "new", server.cards[ids[1]].title]);
    expect(new Set(Object.values(server.cards).map((c) => c.order)).size).toBe(3);
    const sent = opsFrom(server, a.clientId).flatMap((c) => c.args[0].cardOps);
    expect(sent.filter((o) => o.op === "move").length).toBeGreaterThan(0);
    expect(a.store.getState().board.cards).toEqual(server.board().cards);
  });
});

describe("conflicts", () => {
  it("retries a stale move once and lands it", async () => {
    const { server, done, cardId, clients: [a, b] } = await setup();
    server.holdEvents(a.clientId);
    b.store.updateCard(cardId, { title: "B edit" });
    await settle(100);
    a.store.moveCard(cardId, done, null);
    await settle(200);
    server.releaseEvents(a.clientId);
    await settle(100);
    expect(server.cards[cardId]).toMatchObject({ columnId: done, title: "B edit" });
    expect(a.store.getState().board.cards[cardId]).toEqual(server.cards[cardId]);
    expect(opsFrom(server, a.clientId)).toHaveLength(2);
    expect(a.store.getState().conflicts.size).toBe(0);
  });

  it("merges concurrent checklist toggles automatically", async () => {
    const checklist = [{ id: "i_00000001", text: "one", done: false }, { id: "i_00000002", text: "two", done: false }];
    const { server, cardId, clients: [a, b] } = await setup({ card: { checklist } });
    server.holdEvents(a.clientId);
    b.store.updateCard(cardId, { checklist: [{ ...checklist[0], done: true }, checklist[1]] });
    await settle(100);
    a.store.updateCard(cardId, { checklist: [checklist[0], { ...checklist[1], done: true }] });
    await settle(200);
    server.releaseEvents(a.clientId);
    await settle(100);
    expect(server.cards[cardId].checklist.map((i) => i.done)).toEqual([true, true]);
    expect(a.store.getState().board.cards[cardId].checklist.map((i) => i.done)).toEqual([true, true]);
    expect(b.store.getState().board.cards[cardId].checklist.map((i) => i.done)).toEqual([true, true]);
    expect(a.store.getState().conflicts.size).toBe(0);
  });

  it("rebases an edit to a different field without a conflict", async () => {
    const { server, cardId, clients: [a, b] } = await setup();
    server.holdEvents(a.clientId);
    b.store.updateCard(cardId, { description: "theirs" });
    await settle(100);
    a.store.updateCard(cardId, { title: "mine" });
    await settle(200);
    expect(server.cards[cardId]).toMatchObject({ title: "mine", description: "theirs" });
    expect(a.store.getState().board.cards[cardId]).toMatchObject({ title: "mine", description: "theirs" });
    expect(a.store.getState().conflicts.size).toBe(0);
  });

  /** Both edit the title; A's save is the stale one. */
  async function titleClash() {
    const ctx = await setup();
    const { server, cardId, clients: [a, b] } = ctx;
    server.holdEvents(a.clientId);
    b.store.updateCard(cardId, { title: "Theirs" });
    await settle(100);
    a.store.updateCard(cardId, { title: "Mine" });
    await settle(200);
    return ctx;
  }

  it("surfaces a content conflict, showing theirs, and overwrite re-sends mine", async () => {
    const { server, cardId, clients: [a, b] } = await titleClash();
    const state = a.store.getState();
    expect(state.conflicts.get(cardId)).toMatchObject({ cardId, mine: { title: "Mine" }, theirs: { title: "Theirs" } });
    expect(state.board.cards[cardId].title).toBe("Theirs");
    expect(a.changes.some((c) => c.change.kind === "conflict")).toBe(true);

    a.store.resolveConflict(cardId, "overwrite");
    await settle(200);
    server.releaseEvents(a.clientId);
    await settle(100);
    expect(server.cards[cardId].title).toBe("Mine");
    expect(a.store.getState().board.cards[cardId].title).toBe("Mine");
    expect(b.store.getState().board.cards[cardId].title).toBe("Mine");
    expect(a.store.getState().conflicts.size).toBe(0);
  });

  it("discard drops mine and keeps theirs", async () => {
    const { server, cardId, clients: [a] } = await titleClash();
    a.store.resolveConflict(cardId, "discard");
    server.releaseEvents(a.clientId);
    await settle(200);
    expect(server.cards[cardId].title).toBe("Theirs");
    expect(a.store.getState().board.cards[cardId].title).toBe("Theirs");
    expect(a.store.getState().conflicts.size).toBe(0);
    expect(a.store.getState().pending).toBe(0);
  });

  it("treats a conflict where theirs already equals mine as acknowledged", async () => {
    const { server, cardId, clients: [a, b] } = await setup();
    server.holdEvents(a.clientId);
    b.store.updateCard(cardId, { title: "Same" });
    await settle(100);
    a.store.updateCard(cardId, { title: "Same" });
    await settle(200);
    expect(opsFrom(server, a.clientId)).toHaveLength(1);
    expect(a.store.getState().conflicts.size).toBe(0);
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().lastError).toBeNull();
  });

  it("reports an edit to a card someone deleted as a conflict with theirs null", async () => {
    const { server, cardId, clients: [a, b] } = await setup();
    server.holdEvents(a.clientId);
    b.store.deleteCard(cardId);
    await settle(100);
    a.store.updateCard(cardId, { title: "Mine" });
    await settle(200);
    expect(a.store.getState().conflicts.get(cardId)).toEqual({ cardId, mine: { title: "Mine" }, theirs: null });
    expect(a.store.getState().board.cards[cardId]).toBeUndefined();
  });

  it("drops a move of a card someone deleted without a conflict", async () => {
    const { server, done, cardId, clients: [a, b] } = await setup();
    server.holdEvents(a.clientId);
    b.store.deleteCard(cardId);
    await settle(100);
    a.store.moveCard(cardId, done, null);
    await settle(200);
    expect(a.store.getState().conflicts.size).toBe(0);
    expect(a.store.getState().board.cards[cardId]).toBeUndefined();
    expect(a.store.getState().pending).toBe(0);
  });

  it("takes theirs silently on a column rename conflict", async () => {
    const { server, todo, clients: [a, b] } = await setup();
    server.holdEvents(a.clientId);
    b.store.renameColumn(todo, "Theirs");
    await settle(100);
    a.store.renameColumn(todo, "Mine");
    await settle(200);
    expect(server.columns[todo].name).toBe("Theirs");
    expect(a.store.getState().board.columns[todo].name).toBe("Theirs");
    expect(a.store.getState().lastError).toBeNull();
  });
});

describe("errors", () => {
  it("rolls back an op the server rejects and reports the error", async () => {
    const { server, clients: [a] } = await setup({ n: 1, latency: 20 });
    const id = a.store.createCard("k_0000dead", { title: "Nowhere" });
    expect(a.store.getState().board.cards[id]).toBeDefined();
    await settle(200);
    expect(a.store.getState().board.cards[id]).toBeUndefined();
    expect(a.store.getState().lastError).toMatch(/unknown_column/);
    expect(a.store.getState().pending).toBe(0);
    expect(a.changes.some((c) => c.change.kind === "error")).toBe(true);
    expect(server.cards[id]).toBeUndefined();
  });
});

describe("sending", () => {
  it("rolls back every op when the server rejects the whole request", async () => {
    const { server, todo, cardId, clients: [a] } = await setup({ n: 1, latency: 20 });
    server.maxOps = 1;
    a.store.updateCard(cardId, { description: "d" }); // in flight alone: accepted
    const id = a.store.createCard(todo, { title: "x" });
    a.store.updateCard(cardId, { title: "y" }); // these two share the next request: rejected
    await settle(300);
    expect(opsFrom(server, a.clientId)).toHaveLength(2);
    expect(server.cards[cardId].description).toBe("d");
    expect(a.store.getState().board.cards[id]).toBeUndefined();
    expect(a.store.getState().board.cards[cardId].title).toBe("Seed");
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().lastError).toBe("too many ops");
  });

  it("treats an edit that changes nothing as acknowledged", async () => {
    const { server, cardId, clients: [a] } = await setup({ n: 1 });
    a.store.updateCard(cardId, { title: "Seed" });
    await settle(100);
    expect(server.cards[cardId].version).toBe(1);
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().lastError).toBeNull();
  });

  it("sends one request at a time and coalesces queued patches to the same card", async () => {
    const { server, cardId, clients: [a] } = await setup({ n: 1, latency: 30 });
    a.store.updateCard(cardId, { title: "t1" });
    await settle(5);
    a.store.updateCard(cardId, { title: "t2" });
    a.store.updateCard(cardId, { description: "d" });
    a.store.updateCard(cardId, { title: "t3" });
    expect(a.store.getState().pending).toBe(2);
    expect(a.store.getState().board.cards[cardId]).toMatchObject({ title: "t3", description: "d" });
    await settle(500);
    const ops = opsFrom(server, a.clientId);
    expect(ops).toHaveLength(2);
    expect(ops[1].args[0].cardOps).toEqual([
      { op: "upsert", cardId, baseVersion: 2, card: { title: "t3", description: "d" } },
    ]);
    expect(server.maxConcurrentOps).toBe(1);
    expect(server.cards[cardId]).toMatchObject({ title: "t3", description: "d", version: 3 });
  });

  it("does not send a create and an edit of the same card in one request", async () => {
    const { server, todo, clients: [a] } = await setup({ n: 1, latency: 30 });
    const other = a.store.createCard(todo, { title: "x" });
    await settle(5);
    const id = a.store.createCard(todo, { title: "y" });
    a.store.updateCard(id, { title: "y2" });
    a.store.updateCard(other, { title: "x2" });
    await settle(500);
    expect(server.cards[id].title).toBe("y2");
    expect(server.cards[other].title).toBe("x2");
    const second = opsFrom(server, a.clientId)[1].args[0].cardOps;
    expect(second.map((o) => o.cardId).sort()).toEqual([id, other].sort());
    expect(second.find((o) => o.cardId === id)).toMatchObject({ baseVersion: 0, card: { title: "y2" } });
  });
});

describe("restart recovery", () => {
  it("replays an op whose response was lost exactly once, without a false conflict", async () => {
    const { server, cardId, clients: [a, b] } = await setup({ latency: 30 });
    a.store.updateCard(cardId, { title: "Mine" });
    await settle(45); // executed on the server, response still in transit
    expect(server.cards[cardId].title).toBe("Mine");
    server.restart();
    await settle(1000);
    expect(a.store.getState().connection).toBe("live");
    // Re-sent verbatim under the same requestId; the server answers duplicate and applies nothing.
    const sends = opsFrom(server, a.clientId);
    expect(sends).toHaveLength(2);
    expect(sends[1].args[0]).toEqual(sends[0].args[0]);
    expect(sends[0].args[0].requestId).toMatch(new RegExp("^" + a.clientId + ":\\d+$"));
    expect(server.history).toHaveLength(1);
    expect(a.store.getState().lastError).toBeNull();
    expect(a.store.getState().conflicts.size).toBe(0);
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().board.cards[cardId]).toEqual(server.cards[cardId]);
    expect(a.changes.map((c) => c.change.kind)).toContain("connection");
    expect(b).toBeTruthy();
  });

  it("replays an op that never reached the server exactly once", async () => {
    const { server, cardId, clients: [a] } = await setup({ n: 1, latency: 30 });
    a.store.updateCard(cardId, { title: "Mine" });
    await settle(10);
    server.restart();
    await settle(1000);
    expect(server.cards[cardId]).toMatchObject({ title: "Mine", version: 2 });
    expect(server.history).toHaveLength(1);
    expect(a.store.getState().pending).toBe(0);
  });

  it("drops an op whose request keeps failing, after a bounded number of replays", async () => {
    const { server, cardId, clients: [a] } = await setup({ n: 1 });
    for (let i = 0; i < 10; i++) server.failNext("applyOperation");
    a.store.updateCard(cardId, { title: "Doomed" });
    await settle(10000);
    expect(opsFrom(server, a.clientId)).toHaveLength(4);
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().board.cards[cardId].title).toBe("Seed");
    expect(a.store.getState().lastError).toMatch(/could not be saved/);
    expect(a.store.getState().connection).toBe("live");
  });

  it("re-subscribes when the heartbeat reports known:false and catches up", async () => {
    const { server, cardId, done, clients: [a, b] } = await setup();
    server.restart();
    // B was dropped too; drive its change straight at the server.
    server.connect().applyOperation({
      senderId: "agent", cardOps: [{ op: "move", cardId, baseVersion: 1, toColumnId: done }],
    });
    a.store.updateCard(cardId, { description: "queued" });
    await settle(100);
    expect(b.store.getState().board.cards[cardId].columnId).not.toBe(done); // B missed it
    await settle(PRESENCE_HEARTBEAT_MS);
    await settle(1000);
    for (const s of [a.store, b.store]) {
      expect(s.getState().connection).toBe("live");
      expect(s.getState().board.cards[cardId]).toEqual(server.cards[cardId]);
    }
    expect(server.cards[cardId]).toMatchObject({ columnId: done, description: "queued" });
    expect(server.subscribers.size).toBe(2);
    expect(server.history).toHaveLength(2);
  });

  it("resyncs when the heartbeat shows a revision gap", async () => {
    const { server, cardId, clients: [a, b] } = await setup();
    server.dropping.add(a.clientId);
    b.store.updateCard(cardId, { title: "Missed" });
    await settle(100);
    expect(a.store.getState().board.cards[cardId].title).toBe("Seed");
    server.dropping.delete(a.clientId);
    await settle(PRESENCE_HEARTBEAT_MS + 1500);
    expect(a.store.getState().board.cards[cardId].title).toBe("Missed");
    expect(server.callsOf("subscribe").filter((c) => c.args[0].clientId === a.clientId)).toHaveLength(2);
  });

  it("re-subscribes when the callback is disposed, backing off on failure", async () => {
    const { server, cardId, clients: [a, b] } = await setup();
    const subscribes = () => server.callsOf("subscribe").filter((c) => c.args[0].clientId === a.clientId).length;
    server.failNext("subscribe");
    server.disposeSubscriber(a.clientId);
    expect(a.store.getState().connection).toBe("reconnecting");
    await settle(100);
    expect(subscribes()).toBe(2); // first retry failed
    expect(a.store.getState().connection).toBe("reconnecting");
    b.store.updateCard(cardId, { title: "While away" });
    await settle(600);
    expect(subscribes()).toBe(3);
    expect(a.store.getState().connection).toBe("live");
    expect(a.store.getState().board.cards[cardId].title).toBe("While away");
    const kinds = a.changes.filter((c) => c.change.kind === "connection").map((c) => c.state.connection);
    expect(kinds).toContain("live");
  });

  it("buffers events that arrive before the snapshot and drops those it already covers", async () => {
    const { server, cardId, done, clients: [a, b] } = await setup({ latency: 30, eventLatency: 1 });
    server.replayLastEventOnSubscribe = true;
    b.store.updateCard(cardId, { title: "Before" });
    await settle(200);
    const seen = [];
    a.store.subscribe((state, change) => seen.push([change.kind, state.board.cards[cardId]?.title]));
    server.disposeSubscriber(a.clientId);
    await settle(35); // subscribed on the server; snapshot (revision 2) still in transit
    server.doApply({ senderId: "agent", cardOps: [{ op: "move", cardId, baseVersion: 2, toColumnId: done }] });
    await settle(10); // the revision 3 event has arrived; the snapshot has not
    expect(a.store.getState().connection).toBe("reconnecting");
    expect(a.store.getState().board.cards[cardId].columnId).not.toBe(done);
    await settle(300);
    expect(a.store.getState().board.cards[cardId]).toEqual(server.cards[cardId]);
    expect(a.store.getState().board.cards[cardId]).toMatchObject({ title: "Before", columnId: done });
    expect(seen.every(([, title]) => title === "Before")).toBe(true);
  });

  it("ignores events and dispose from a superseded subscription", async () => {
    const { server, clients: [a] } = await setup({ n: 1 });
    const old = server.subscribers.get(a.clientId).callback;
    server.disposeSubscriber(a.clientId);
    await settle(100);
    const subscribes = server.callsOf("subscribe").length;
    old[Symbol.dispose]();
    old.operation({ type: "snapshot", board: { ...server.board(), title: "bogus", cards: {} } });
    await settle(100);
    expect(server.callsOf("subscribe").length).toBe(subscribes);
    expect(a.store.getState().board.title).toBe("Board");
  });
});

describe("presence", () => {
  it("tracks join, update and leave, and throttles sends", async () => {
    const { server, cardId, clients: [a, b] } = await setup();
    expect([...a.store.getState().peers.keys()]).toEqual([b.clientId]);
    expect([...b.store.getState().peers.keys()]).toEqual([a.clientId]);
    const before = server.callsOf("updatePresence").length;
    b.store.setPresence({ openCardId: cardId });
    b.store.setPresence({ dragCardId: cardId });
    b.store.setPresence({ hoverColumnId: "k_00000001" });
    await settle(20);
    expect(server.callsOf("updatePresence").length - before).toBe(1);
    await settle(100);
    expect(server.callsOf("updatePresence").length - before).toBe(2);
    expect(a.store.getState().peers.get(b.clientId)).toMatchObject({
      name: "user1", openCardId: cardId, dragCardId: cardId, hoverColumnId: "k_00000001",
    });
    b.store.setViewer("Bea", "#abcdef");
    await settle(100);
    expect(a.store.getState().peers.get(b.clientId)).toMatchObject({ name: "Bea", color: "#abcdef" });
    b.store.dispose();
    await settle(100);
    expect(a.store.getState().peers.size).toBe(0);
  });

  it("expires peers not seen for the stale interval", async () => {
    const { server, clients: [a, b] } = await setup();
    const c = await startStore(server, "c");
    await settle();
    expect(a.store.getState().peers.size).toBe(2);
    c.store.dispose(); // stops its heartbeat...
    server.silentDrop(c.clientId); // ...and the server never announces a leave
    server.calls.length = 0;
    await settle(PRESENCE_HEARTBEAT_MS * 4 + 100);
    expect([...a.store.getState().peers.keys()]).toEqual([b.clientId]);
  });
});

describe("comments, history and undo", () => {
  it("adds and loads comments, ignoring its own echo", async () => {
    const { cardId, clients: [a, b] } = await setup();
    const comment = await Promise.all([a.store.addComment(cardId, "hello"), settle(100)]).then(([c]) => c);
    await settle(100);
    expect(comment).toMatchObject({ cardId, text: "hello", author: "user0" });
    expect(a.changes.filter((c) => c.change.kind === "comment")).toHaveLength(1);
    expect(b.changes.filter((c) => c.change.kind === "comment").map((c) => c.change.comment.id)).toEqual([comment.id]);
    const loaded = await Promise.all([b.store.loadComments(cardId), settle(100)]).then(([c]) => c);
    expect(loaded.map((c) => c.id)).toEqual([comment.id]);
  });

  it("loads history and undoes a move", async () => {
    const { server, todo, done, cardId, clients: [a, b] } = await setup();
    a.store.moveCard(cardId, done, null);
    await settle(100);
    const history = await Promise.all([b.store.loadHistory(10), settle(100)]).then(([h]) => h);
    expect(history).toHaveLength(1);
    await Promise.all([b.store.undo(history[0].id), settle(100)]);
    await settle(100);
    expect(server.cards[cardId].columnId).toBe(todo);
    expect(a.store.getState().board.cards[cardId].columnId).toBe(todo);
    expect(b.store.getState().board.cards[cardId].columnId).toBe(todo);
    expect(a.store.getState().history).toHaveLength(2);
  });
});

describe("dispose", () => {
  it("stops every timer and leaves presence", async () => {
    const { server, clients: [a] } = await setup({ n: 1 });
    a.store.setPresence({ openCardId: "c_00000001" });
    a.store.setPresence({ openCardId: null });
    a.store.dispose();
    await settle(100);
    expect(server.callsOf("leavePresence")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    const presence = server.callsOf("updatePresence").length;
    await settle(PRESENCE_HEARTBEAT_MS * 3);
    expect(server.callsOf("updatePresence").length).toBe(presence);
  });
});

/**
 * Makes another writer change `cardId` just before each of the first `times` requests from
 * `clientId` is applied, with `change(card)` returning the replacement fields.
 */
function interfere(server, clientId, cardId, times, change) {
  const original = server.applyOnce.bind(server);
  let left = times;
  server.applyOnce = (req) => {
    const card = server.cards[cardId];
    if (req.senderId === clientId && left > 0 && card) {
      left--;
      server.cards[cardId] = { ...card, ...change(card), version: card.version + 1 };
      server.revision++;
    }
    return original(req);
  };
}

describe("stale moves and deletes", () => {
  it("keeps retrying a move while others only edit the card's content", async () => {
    const { server, done, cardId, clients: [a] } = await setup({ n: 1 });
    let n = 0;
    interfere(server, a.clientId, cardId, 3, () => ({ description: "edit " + ++n }));
    a.store.moveCard(cardId, done, null);
    await settle(300);
    expect(opsFrom(server, a.clientId)).toHaveLength(4);
    expect(server.cards[cardId]).toMatchObject({ columnId: done, description: "edit 3" });
    expect(a.store.getState().board.cards[cardId]).toEqual(server.cards[cardId]);
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().lastError).toBeNull();
  });

  it("gives up on a move after bounded retries, with an error", async () => {
    const { server, todo, done, cardId, clients: [a] } = await setup({ n: 1 });
    interfere(server, a.clientId, cardId, 100, (c) => ({ description: c.description + "x" }));
    a.store.moveCard(cardId, done, null);
    await settle(500);
    expect(opsFrom(server, a.clientId)).toHaveLength(6); // first send + 5 retries
    expect(server.cards[cardId].columnId).toBe(todo);
    expect(a.store.getState().board.cards[cardId].columnId).toBe(todo);
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().lastError).toMatch(/move/);
    expect(a.changes.some((c) => c.change.kind === "error")).toBe(true);
  });

  it("does not retry a move when someone else moved the card, and says so", async () => {
    const { server, done, cardId, clients: [a] } = await setup({ n: 1 });
    interfere(server, a.clientId, cardId, 1, () => ({ order: "zz" }));
    a.store.moveCard(cardId, done, null);
    await settle(300);
    expect(opsFrom(server, a.clientId)).toHaveLength(1);
    expect(server.cards[cardId].order).toBe("zz");
    expect(a.store.getState().board.cards[cardId]).toEqual(server.cards[cardId]);
    expect(a.store.getState().lastError).toMatch(/someone else moved/);
  });

  it("keeps retrying a delete while the card exists", async () => {
    const { server, cardId, clients: [a] } = await setup({ n: 1 });
    interfere(server, a.clientId, cardId, 2, (c) => ({ title: c.title + "!" }));
    a.store.deleteCard(cardId);
    await settle(300);
    expect(opsFrom(server, a.clientId)).toHaveLength(3);
    expect(server.cards[cardId]).toBeUndefined();
    expect(a.store.getState().board.cards[cardId]).toBeUndefined();
    expect(a.store.getState().lastError).toBeNull();
  });

  it("gives up on a delete after bounded retries, with an error", async () => {
    const { server, cardId, clients: [a] } = await setup({ n: 1 });
    interfere(server, a.clientId, cardId, 100, (c) => ({ title: c.title + "!" }));
    a.store.deleteCard(cardId);
    await settle(500);
    expect(opsFrom(server, a.clientId)).toHaveLength(6);
    expect(server.cards[cardId]).toBeDefined();
    expect(a.store.getState().board.cards[cardId]).toEqual(server.cards[cardId]);
    expect(a.store.getState().lastError).toMatch(/deleted/);
  });
});

describe("requests and replays", () => {
  it("gives every request a monotonic requestId, including undo", async () => {
    const { server, cardId, clients: [a] } = await setup({ n: 1 });
    a.store.updateCard(cardId, { title: "one" });
    await settle(50);
    a.store.updateCard(cardId, { title: "two" });
    await settle(50);
    await Promise.all([a.store.undo(server.history[1].id), settle(50)]);
    const ids = server.requestIds;
    expect(ids).toHaveLength(3);
    expect(ids.map((id) => id.split(":")[0])).toEqual([a.clientId, a.clientId, a.clientId]);
    const seqs = ids.map((id) => Number(id.split(":")[1]));
    expect(seqs[0]).toBeLessThan(seqs[1]);
    expect(seqs[1]).toBeLessThan(seqs[2]);
    expect(server.callsOf("undo")[0].args[0].requestId).toBe(ids[2]);
  });

  it("keeps request ids to 64 characters the server accepts, whatever the clientId", async () => {
    const server = new FakeServer({ latency: 5 });
    const col = server.seedColumn("C");
    const a = await startStore(server, "long", { clientId: "x.y " + "x".repeat(64) });
    a.store.createCard(col, { title: "t" });
    await settle(100);
    expect(server.requestIds).toHaveLength(1);
    expect(server.requestIds[0].length).toBeLessThanOrEqual(64);
    expect(server.requestIds[0]).toMatch(/^x_y_x+:1$/);
  });

  it("replays a failed request against its original base, so a concurrent edit conflicts", async () => {
    const { server, cardId, clients: [a] } = await setup({ n: 1, latency: 20 });
    server.failNext("applyOperation");
    a.store.updateCard(cardId, { title: "Mine" });
    await settle(5);
    // Someone else saves the same field while A's request is failing.
    server.doApply({ senderId: "agent", cardOps: [{ op: "upsert", cardId, baseVersion: 1, card: { title: "Theirs" } }] });
    await settle(1000);
    const sends = opsFrom(server, a.clientId);
    expect(sends).toHaveLength(2);
    expect(sends[1].args[0]).toEqual(sends[0].args[0]);
    expect(sends[1].args[0].cardOps[0].baseVersion).toBe(1);
    expect(server.cards[cardId].title).toBe("Theirs");
    expect(a.store.getState().conflicts.get(cardId)).toMatchObject({ mine: { title: "Mine" }, theirs: { title: "Theirs" } });
  });

  it("sends nothing new until the replayed request has an outcome", async () => {
    const { server, cardId, todo, clients: [a] } = await setup({ n: 1, latency: 20 });
    server.failNext("applyOperation");
    a.store.updateCard(cardId, { title: "first" });
    await settle(5);
    a.store.updateCard(cardId, { description: "second" }); // must not merge into the failed send
    a.store.createCard(todo, { title: "third" });
    await settle(1000);
    const sends = opsFrom(server, a.clientId).map((c) => c.args[0]);
    expect(sends[1]).toEqual(sends[0]);
    expect(sends[0].cardOps).toHaveLength(1);
    expect(sends.slice(2).every((r) => r.requestId !== sends[0].requestId)).toBe(true);
    expect(server.cards[cardId]).toMatchObject({ title: "first", description: "second" });
    expect(a.store.getState().pending).toBe(0);
  });

  it("does not resurrect a created card deleted while its result was lost", async () => {
    const { server, todo, clients: [a] } = await setup({ n: 1, latency: 30 });
    const id = a.store.createCard(todo, { title: "Temp" });
    await settle(45); // created on the server, result in transit
    expect(server.cards[id]).toBeDefined();
    server.doApply({ senderId: "agent", cardOps: [{ op: "delete", cardId: id, baseVersion: 1 }] });
    server.restart();
    await settle(1000);
    expect(opsFrom(server, a.clientId)).toHaveLength(2);
    expect(server.cards[id]).toBeUndefined();
    expect(a.store.getState().board.cards[id]).toBeUndefined();
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().lastError).toBeNull();
    expect(a.store.getState().conflicts.size).toBe(0);
  });

  it("rolls back a change the server refuses with a limit error", async () => {
    const { server, todo, clients: [a] } = await setup({ n: 1 });
    const original = server.applyOnce.bind(server);
    server.applyOnce = (req) => (req.cardOps?.some((o) => o.op === "upsert" && o.baseVersion === 0)
      ? { status: "unchanged", revision: server.revision, upserts: [], deletes: [], moved: [], structure: null,
        labels: null, history: null, conflicts: [],
        errors: [{ kind: "card", index: 0, code: "limit", message: "The board is full." }] }
      : original(req));
    const id = a.store.createCard(todo, { title: "Too much" });
    await settle(100);
    expect(a.store.getState().board.cards[id]).toBeUndefined();
    expect(a.store.getState().pending).toBe(0);
    expect(a.store.getState().lastError).toBe("The board is full.");
  });
});

describe("sessions", () => {
  it("keeps its server-issued session across re-subscribes and presence calls", async () => {
    const { server, clients: [a] } = await setup({ n: 1 });
    const session = server.subscribers.get(a.clientId).session;
    server.restart();
    await settle(PRESENCE_HEARTBEAT_MS + 1000);
    const subs = server.callsOf("subscribe").filter((c) => c.args[0].clientId === a.clientId);
    expect(subs.length).toBe(2);
    expect(subs[0].args[0].session).toBeUndefined();
    expect(subs[1].args[0].session).toBe(session);
    expect(server.subscribers.get(a.clientId).session).toBe(session);
    expect(a.store.getState().board.session).toBeUndefined();
    const presence = server.callsOf("updatePresence").filter((c) => c.args[0].clientId === a.clientId);
    expect(presence.at(-1).args[0].session).toBe(session);
    a.store.dispose();
    await settle(100);
    expect(server.callsOf("leavePresence")[0].args).toEqual([a.clientId, session]);
    expect(server.subscribers.has(a.clientId)).toBe(false);
  });

  it("re-subscribes after a callback dispose with the same session (no 'clientId in use')", async () => {
    const { server, clients: [a] } = await setup({ n: 1 });
    // The old subscription is still registered on the server when the gap resync happens.
    const session = server.subscribers.get(a.clientId).session;
    server.subscribers.get(a.clientId).callback[Symbol.dispose]();
    await settle(200);
    expect(a.store.getState().connection).toBe("live");
    expect(a.store.getState().viewer.clientId).toBe(a.clientId);
    expect(server.subscribers.get(a.clientId).session).toBe(session);
  });

  it("takes a new clientId when its id is held by another session", async () => {
    const { server, clients: [a] } = await setup({ n: 1 });
    const b = await startStore(server, "dup", { clientId: a.clientId });
    await settle(100);
    const bId = b.store.getState().viewer.clientId;
    expect(bId).not.toBe(a.clientId);
    expect(b.store.getState().connection).toBe("live");
    expect(server.subscribers.has(bId)).toBe(true);
    expect(server.subscribers.has(a.clientId)).toBe(true);
    expect([...a.store.getState().peers.keys()]).toEqual([bId]);
    expect([...b.store.getState().peers.keys()]).toEqual([a.clientId]);
    b.store.updateCard(Object.keys(server.cards)[0], { title: "from b" });
    await settle(100);
    expect(server.requestIds.at(-1).startsWith(bId + ":")).toBe(true);
  });
});
