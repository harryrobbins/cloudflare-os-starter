// requestIds must be unguessable: request records are shared by the whole board and a client's id
// is broadcast in presence, so an id derived from it could be recorded first by a peer and the
// real request answered as a duplicate. Runs real stores against the real core (net.js).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Net } from "./net.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const tick = (/** @type {number} */ ms) => vi.advanceTimersByTimeAsync(ms);

it("requestIds are a per-store random secret plus a counter, never derived from the clientId", async () => {
  const net = new Net({ rng: () => 0.5, minLat: 0, maxLat: 50 });
  const a = await net.startStore("a");
  const b = await net.startStore("b");
  await tick(200);
  for (let i = 0; i < 3; i++) {
    a.createObjects([{ type: "sticky", x: i * 300, y: 0 }]);
    b.createObjects([{ type: "sticky", x: i * 300, y: 400 }]);
    await tick(300);
  }
  const ids = (name) => net.calls.filter((c) => c.name === name && c.method === "applyOperation").map((c) => c.args[0].requestId);
  const [idsA, idsB] = [ids("a"), ids("b")];
  expect(idsA.length).toBeGreaterThanOrEqual(3);
  expect(idsB.length).toBeGreaterThanOrEqual(3);
  const secret = (/** @type {string} */ id) => id.split(":")[0];
  for (const id of [...idsA, ...idsB]) {
    expect(id).toMatch(/^[0-9a-f]{24}:\d+$/);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).not.toContain("client-");
  }
  expect(new Set(idsA.map(secret)).size).toBe(1);
  expect(secret(idsA[0])).not.toBe(secret(idsB[0]));
  expect(new Set([...idsA, ...idsB]).size).toBe(idsA.length + idsB.length);
});

it("a peer pre-recording requestIds built from the victim's clientId cannot suppress its writes", async () => {
  const net = new Net({ rng: () => 0.5, minLat: 0, maxLat: 50 });
  const victim = await net.startStore("v", { clientId: "victim-client" });
  await tick(200);
  // The attacker knows the clientId (broadcast) and records the ids the old scheme would use, with
  // and without the victim's senderId.
  for (let seq = 1; seq <= 20; seq++) {
    await net.board.applyOperation({ requestId: `victim-client:${seq}` });
    await net.board.applyOperation({ requestId: `victim-client:${seq}`, senderId: "victim-client" });
  }
  const [id] = victim.createObjects([{ type: "sticky", text: "important" }]);
  await tick(1000);
  expect((await net.board.getBoard()).objects[id]).toMatchObject({ text: "important" });
  expect(victim.getState().pending).toBe(0);
});
