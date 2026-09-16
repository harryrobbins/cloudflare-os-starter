// Regressions for sync bugs found by review, against the REAL core over a simulated network
// (test/client/net.js). Every hop takes 25 ms and channels are FIFO.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Net } from "./net.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const tick = (/** @type {number} */ ms) => vi.advanceTimersByTimeAsync(ms);

async function setup() {
  const net = new Net({ rng: () => 0.5, minLat: 0, maxLat: 50 });
  const a = await net.startStore("a");
  const b = await net.startStore("b");
  await tick(200);
  const [todo, doing] = a.getState().board.columnOrder;
  const id = a.createCard(todo, { title: "Seed" });
  await tick(300);
  return { net, a, b, todo, doing, id };
}

it("T1: a move survives a collaborator saving the card twice in a row", async () => {
  const { net, a, b, doing, id } = await setup();
  b.updateCard(id, { description: "one" });        // lands at the server at t=25
  await tick(10);
  a.moveCard(id, doing, null);                       // stale base, lands t=35 -> conflict
  await tick(45);
  b.updateCard(id, { description: "one two" });     // lands before A's retry
  await tick(2000);
  const server = await net.board.getBoard();
  expect(a.getState().pending).toBe(0);
  expect(server.cards[id]).toMatchObject({ description: "one two", columnId: doing });
  expect(a.getState().board.cards[id]).toEqual(server.cards[id]);
  expect(b.getState().board.cards[id]).toEqual(server.cards[id]);
  expect(a.getState().lastError).toBeNull();
});

it("T3: a replayed patch after a lost request conflicts with a concurrent edit instead of overwriting it", async () => {
  const { net, a, b, id } = await setup();
  a.updateCard(id, { title: "From A" });    // would reach the server at t=25
  await tick(10);
  net.restart();                             // A's request is lost in the restart
  await tick(5);
  b.updateCard(id, { title: "From B" });    // same base version, lands first
  await tick(5000);
  const server = await net.board.getBoard();
  const sends = net.calls.filter((c) => c.method === "applyOperation" && c.name === "a").map((c) => c.args[0])
    .filter((r) => r.cardOps?.[0]?.card?.title === "From A");
  expect(sends).toHaveLength(2);
  expect(sends[1]).toEqual(sends[0]);
  expect(server.cards[id].title).toBe("From B");
  expect(a.getState().conflicts.get(id)).toMatchObject({ mine: { title: "From A" }, theirs: { title: "From B" } });
  expect(b.getState().conflicts.size).toBe(0);
});

it("T4: concurrent equal edits differing only by server cleaning do not conflict", async () => {
  const { net, a, b, id } = await setup();
  a.updateCard(id, { title: "Same" });
  b.updateCard(id, { title: "Same  " });
  await tick(2000);
  expect(a.getState().conflicts.size + b.getState().conflicts.size).toBe(0);
  expect((await net.board.getBoard()).cards[id].title).toBe("Same");
  expect(a.getState().pending + b.getState().pending).toBe(0);
});

it("T5: a create whose result was lost is not resurrected after someone deleted it", async () => {
  const { net, a, todo } = await setup();
  const x = a.createCard(todo, { title: "Temp" });  // applied at t=25, result due t=50
  await tick(30);
  await net.board.deleteCard({ cardId: x, by: "chat" });
  net.restart();                                    // A's result is lost
  await tick(5000);
  const server = await net.board.getBoard();
  expect(server.cards[x]).toBeUndefined();
  expect(a.getState().board.cards[x]).toBeUndefined();
  expect(a.getState().pending).toBe(0);
  expect(a.getState().lastError).toBeNull();
  const sends = net.calls.filter((c) => c.method === "applyOperation" && c.name === "a").map((c) => c.args[0]);
  expect(sends.at(-1)).toEqual(sends.at(-2)); // re-sent under the same requestId
});

it("T6: a delete survives a collaborator saving the card twice in a row", async () => {
  const { net, a, b, id } = await setup();
  b.updateCard(id, { description: "one" });
  await tick(10);
  a.deleteCard(id);
  await tick(45);
  b.updateCard(id, { description: "one two" });
  await tick(2000);
  const server = await net.board.getBoard();
  expect(server.cards[id]).toBeUndefined();
  expect(a.getState().board.cards[id]).toBeUndefined();
  expect(b.getState().board.cards[id]).toBeUndefined();
  expect(a.getState().lastError).toBeNull();
});

it("keeps its session across a restart and takes a new clientId when its id is taken", async () => {
  const { net, a, b } = await setup();
  const subscribes = (/** @type {string} */ name) =>
    net.calls.filter((c) => c.method === "subscribe" && c.name === name).map((c) => c.args[0]);
  const session = subscribes("a")[0] && net.hub.entries.get("client-a")?.session;
  expect(typeof session).toBe("string");
  net.restart();
  await tick(10000);
  expect(a.getState().connection).toBe("live");
  expect(subscribes("a").at(-1).session).toBe(session);
  expect(net.hub.entries.get("client-a")?.session).toBe(session);

  const c = await net.startStore("c", { clientId: "client-a" });
  await tick(500);
  const cId = c.getState().viewer.clientId;
  expect(cId).not.toBe("client-a");
  expect(net.hub.has(cId)).toBe(true);
  expect(a.getState().viewer.clientId).toBe("client-a");
  expect([...b.getState().peers.keys()].sort()).toEqual(["client-a", cId].sort());
  for (const s of [a, b, c]) s.dispose();
  await tick(1000);
});
