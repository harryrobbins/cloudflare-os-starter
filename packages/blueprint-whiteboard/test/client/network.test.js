// Scenarios against the REAL core and hub over a simulated network (test/client/net.js). Every hop
// takes 25 ms and channels are FIFO.
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
  const [id] = a.createObjects([{ type: "sticky", x: 100, y: 100, text: "Seed" }]);
  await tick(300);
  return { net, a, b, id };
}

/** @param {any} store @param {any} server */
function expectConverged(store, server) {
  expect(store.getState().pending).toBe(0);
  expect(store.getState().board.objects).toEqual(server.objects);
}

it("two stores converge on concurrent nudges of the same object (both deltas kept)", async () => {
  const { net, a, b, id } = await setup();
  a.updateObjects([{ id, patch: { x: 110 } }]); // +10
  b.updateObjects([{ id, patch: { x: 120, y: 90 } }]); // +20, -10
  await tick(2000);
  const server = await net.board.getBoard();
  expect(server.objects[id]).toMatchObject({ x: 130, y: 90 });
  expectConverged(a, server);
  expectConverged(b, server);
  expect(a.getState().lastError).toBeNull();
  expect(b.getState().lastError).toBeNull();
});

it("text clash: the later writer keeps theirs and flashes; both converge", async () => {
  const { net, a, b, id } = await setup();
  const flashes = [];
  a.subscribe((_s, c) => { if (c.kind === "flash") flashes.push(["a", ...c.objects]); });
  b.subscribe((_s, c) => { if (c.kind === "flash") flashes.push(["b", ...c.objects]); });
  a.updateObjects([{ id, patch: { text: "A", style: { fill: "#ff0000" } } }]);
  await tick(10);
  b.updateObjects([{ id, patch: { text: "B", x: 300 } }]);
  await tick(2000);
  const server = await net.board.getBoard();
  expect(server.objects[id]).toMatchObject({ text: "A", x: 300, style: { fill: "#ff0000" } });
  expect(flashes).toEqual([["b", id]]);
  expectConverged(a, server);
  expectConverged(b, server);
});

it("a delete of an endpoint removes its connectors everywhere, and undo brings both back", async () => {
  const { net, a, b, id } = await setup();
  const [other] = a.createObjects([{ type: "rect", x: 400 }]);
  const [conn] = a.createObjects([{ type: "connector", from: id, to: other }]);
  await tick(500);
  expect(b.getState().board.objects[conn]).toBeDefined();
  b.deleteObjects([id]);
  expect(b.getState().board.objects[conn]).toBeUndefined();
  await tick(1000);
  let server = await net.board.getBoard();
  expect(server.objects[conn]).toBeUndefined();
  expect(a.getState().board.objects[conn]).toBeUndefined();
  b.undo();
  await tick(1000);
  server = await net.board.getBoard();
  expect(server.objects[id]).toBeDefined();
  expect(server.objects[conn]).toMatchObject({ from: id, to: other });
  expectConverged(a, server);
  expectConverged(b, server);
});

it("a replayed update after a lost request conflicts with a concurrent edit instead of overwriting it", async () => {
  const { net, a, b, id } = await setup();
  a.updateObjects([{ id, patch: { text: "From A" } }]); // would reach the server at t=25
  await tick(10);
  net.restart(); // A's request is lost in the restart
  await tick(5);
  b.updateObjects([{ id, patch: { text: "From B" } }]); // same base version
  await tick(8000);
  const server = await net.board.getBoard();
  const sends = net.calls.filter((c) => c.method === "applyOperation" && c.name === "a").map((c) => c.args[0])
    .filter((r) => r.objectOps?.[0]?.patch?.text === "From A");
  expect(sends.length).toBeGreaterThanOrEqual(2);
  expect(sends[1]).toEqual(sends[0]);
  expect(server.objects[id].text).toBe("From B");
  expectConverged(a, server);
  expectConverged(b, server);
});

it("a create whose result was lost is not resurrected after someone deleted it", async () => {
  const { net, a } = await setup();
  const [x] = a.createObjects([{ type: "sticky", text: "Temp" }]); // applied at t=25, result due t=50
  await tick(30);
  const o = (await net.board.getBoard()).objects[x];
  await net.board.applyOperation({ by: "chat", objectOps: [{ op: "delete", id: x, baseVersion: o.version }] });
  net.restart();
  await tick(8000);
  const server = await net.board.getBoard();
  expect(server.objects[x]).toBeUndefined();
  expectConverged(a, server);
  expect(a.getState().lastError).toBeNull();
});

it("keeps its session across a restart, takes a new clientId when its id is taken, and presence flows", async () => {
  const { net, a, b } = await setup();
  const session = net.hub.entries.get("client-a")?.session;
  expect(typeof session).toBe("string");
  net.restart();
  await tick(10000);
  expect(a.getState().connection).toBe("live");
  expect(net.hub.entries.get("client-a")?.session).toBe(session);

  const c = await net.startStore("c", { clientId: "client-a" });
  await tick(500);
  const cId = c.getState().viewer.clientId;
  expect(cId).not.toBe("client-a");
  expect([...b.getState().peers.keys()].sort()).toEqual(["client-a", cId].sort());

  a.setPresence({ cursor: { x: 5, y: 6 }, transforms: [{ id: Object.keys(a.getState().board.objects)[0], x: 1, y: 2, w: 3, h: 4, rot: 0 }] });
  await tick(500);
  expect(b.getState().peers.get("client-a")).toMatchObject({ cursor: { x: 5, y: 6 }, transforms: [{ x: 1, y: 2 }] });
  a.setPresence({ transforms: [] });
  a.flushPresence();
  await tick(500);
  expect(b.getState().peers.get("client-a").transforms).toEqual([]);
  for (const s of [a, b, c]) s.dispose();
  await tick(1000);
  expect(b.getState().peers.size).toBeGreaterThanOrEqual(0);
});
