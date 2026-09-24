// Adaptive presence (src/client/sync/presence.js): the send policy in isolation, then through real
// stores on the fake gadget (hidden tabs, idle tabs, a 50-viewer room).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESENCE_HEARTBEAT_MS } from "../../src/shared/protocol.js";
import {
  PRESENCE_BACKOFF_MAX_MS, PRESENCE_MOVE_MS, createPresenceSession, isBoundary, movementGap, presenceKey,
} from "../../src/client/sync/presence.js";
import { FakeServer, settle, startStore } from "./helpers.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/**
 * A session whose calls settle after `latency` ms.
 * @param {{latency?: number, opBusy?: () => boolean}} [o]
 */
function session({ latency = 5, opBusy } = {}) {
  /** @type {any[]} */
  const sent = [];
  const s = createPresenceSession({
    timers: { setTimeout, clearTimeout, now: () => Date.now() },
    call: (payload) => {
      sent.push(payload);
      return new Promise((resolve) => setTimeout(() => resolve({ known: true, revision: 0 }), latency));
    },
    identity: () => ({ clientId: "me", name: "Me", color: "#123456", session: "s" }),
    canSend: () => true,
    generation: () => 1,
    onResult: () => true,
    onDead: () => {},
    opBusy,
  });
  return { s, sent };
}

describe("policy helpers", () => {
  it("classifies boundaries", () => {
    const base = { cursor: { x: 1, y: 1 }, viewport: null, selection: [], transforms: [], stroke: null, editingId: null };
    expect(isBoundary(base, { ...base, cursor: { x: 9, y: 9 } })).toBe(false);
    expect(isBoundary(base, { ...base, viewport: { x: 0, y: 0, w: 1, h: 1 } })).toBe(false);
    expect(isBoundary(base, { ...base, cursor: null })).toBe(true); // pointer left
    expect(isBoundary({ ...base, cursor: null }, base)).toBe(true); // re-entry
    expect(isBoundary(base, { ...base, selection: ["a"] })).toBe(true);
    expect(isBoundary(base, { ...base, editingId: "a" })).toBe(true);
    const t = [{ id: "a", x: 0, y: 0, w: 1, h: 1, rot: 0 }];
    expect(isBoundary(base, { ...base, transforms: t })).toBe(true); // gesture start
    expect(isBoundary({ ...base, transforms: t }, { ...base, transforms: [{ ...t[0], x: 5 }] })).toBe(false);
    expect(isBoundary({ ...base, transforms: t }, base)).toBe(true); // gesture end
    expect(isBoundary(base, { ...base, stroke: { points: [], color: "#000000", width: 2 } })).toBe(true);
  });

  it("rounds keys to 0.1 and widens the gap for crowds, busy ops and slow round trips", () => {
    expect(presenceKey({ c: { x: 1.04 } })).toBe(presenceKey({ c: { x: 0.96 } }));
    expect(presenceKey({ c: { x: 1.1 } })).not.toBe(presenceKey({ c: { x: 1 } }));
    expect(movementGap({ peers: 0, opBusy: false, rttMs: 10 })).toBe(PRESENCE_MOVE_MS);
    expect(movementGap({ peers: 10, opBusy: false, rttMs: 10 })).toBe(PRESENCE_MOVE_MS * 2);
    expect(movementGap({ peers: 49, opBusy: false, rttMs: 10 })).toBe(PRESENCE_MOVE_MS * 4);
    expect(movementGap({ peers: 50, opBusy: true, rttMs: 10 })).toBe(PRESENCE_MOVE_MS * 16);
    expect(movementGap({ peers: 0, opBusy: false, rttMs: 300 })).toBe(600);
    expect(movementGap({ peers: 0, opBusy: false, rttMs: 60_000 })).toBe(PRESENCE_BACKOFF_MAX_MS);
  });
});

describe("presence session", () => {
  it("sends boundaries at once and caps movement at about 20 Hz", async () => {
    const { s, sent } = session();
    s.set({ cursor: { x: 0, y: 0 } }); // re-entry: immediate
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    // Move every 5 ms for one second.
    for (let i = 1; i <= 200; i++) {
      s.set({ cursor: { x: i, y: i } });
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(200);
    const moves = sent.length - 1;
    expect(moves).toBeGreaterThanOrEqual(15);
    expect(moves).toBeLessThanOrEqual(21);
    expect(sent.at(-1).cursor).toEqual({ x: 200, y: 200 }); // the latest value always lands
    // A selection change is not held back by the movement cap.
    s.set({ cursor: { x: 201, y: 201 } });
    s.set({ selection: ["o_1"] });
    await vi.advanceTimersByTimeAsync(11);
    expect(sent.at(-1)).toMatchObject({ selection: ["o_1"], cursor: { x: 201, y: 201 } });
    s.dispose();
  });

  it("skips states equal once rounded, and heartbeats only when nothing was sent recently", async () => {
    const { s, sent } = session();
    s.set({ cursor: { x: 10, y: 10 } });
    await vi.advanceTimersByTimeAsync(100);
    s.set({ cursor: { x: 10.01, y: 10.02 } });
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(1);
    s.heartbeat(); // a send 200 ms ago already proved liveness
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS);
    s.heartbeat();
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toHaveLength(2);
    expect(sent[1].cursor).toEqual({ x: 10.01, y: 10.02 });
    s.dispose();
  });

  it("a hidden tab clears its cursor and ghosts once, then sends nothing but heartbeats", async () => {
    const { s, sent } = session();
    s.set({ cursor: { x: 1, y: 1 }, transforms: [{ id: "o_1", x: 0, y: 0, w: 1, h: 1, rot: 0 }] });
    await vi.advanceTimersByTimeAsync(20);
    const before = sent.length;
    s.setVisible(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(sent.slice(before)).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ cursor: null, transforms: [], stroke: null });
    for (let i = 0; i < 100; i++) {
      s.set({ cursor: { x: i, y: i }, viewport: { x: i, y: 0, w: 100, h: 100 } });
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(sent.slice(before)).toHaveLength(1);
    for (let t = 0; t < 20_000; t += PRESENCE_HEARTBEAT_MS) {
      s.heartbeat();
      await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS);
    }
    const hidden = sent.slice(before + 1);
    expect(hidden.length).toBeLessThanOrEqual(5);
    for (const p of hidden) expect(p.cursor).toBeNull();
    s.setVisible(true); // shown again: republished at once
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.at(-1).cursor).toEqual({ x: 99, y: 99 });
    s.dispose();
  });

  it("backs off while an operation request is in flight and when round trips are slow", async () => {
    let busy = true;
    const { s, sent } = session({ latency: 5, opBusy: () => busy });
    s.set({ cursor: { x: 0, y: 0 } });
    for (let i = 1; i <= 100; i++) {
      s.set({ cursor: { x: i, y: 0 } });
      await vi.advanceTimersByTimeAsync(10);
    }
    const busyMoves = sent.length - 1;
    expect(busyMoves).toBeLessThanOrEqual(11); // 1 s at a 100 ms gap
    busy = false;
    const slow = session({ latency: 150 });
    slow.s.set({ cursor: { x: 0, y: 0 } });
    for (let i = 1; i <= 100; i++) {
      slow.s.set({ cursor: { x: i, y: 0 } });
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(1000);
    // Round trip 150 ms: a 300 ms gap instead of 50 ms (5 sends where 20 would go out).
    expect(slow.sent.length).toBeLessThanOrEqual(5);
    expect(slow.sent.at(-1).cursor).toEqual({ x: 100, y: 0 });
    s.dispose();
    slow.s.dispose();
  });
});

describe("through the store", () => {
  it("an idle visible tab and a hidden tab emit no gesture-frequency traffic", async () => {
    const server = new FakeServer({ latency: 5 });
    server.seed({ type: "sticky" });
    const a = await startStore(server, "a");
    const b = await startStore(server, "b");
    await settle(500);
    const sends = (id) => server.callsOf("updatePresence").filter((c) => c.args[0].clientId === id).length;
    const idleStart = sends(a.clientId);
    await settle(20_000);
    expect(sends(a.clientId) - idleStart).toBeLessThanOrEqual(Math.ceil(20_000 / PRESENCE_HEARTBEAT_MS) + 1);

    b.store.setPresence({ cursor: { x: 1, y: 1 } });
    await settle(50);
    b.store.setVisibility(false);
    await settle(50);
    expect(a.store.getState().peers.get(b.clientId)?.cursor).toBeNull();
    const hiddenStart = sends(b.clientId);
    for (let i = 0; i < 300; i++) {
      b.store.setPresence({ cursor: { x: i, y: i } });
      await settle(16);
    }
    await settle(15_000);
    expect(sends(b.clientId) - hiddenStart).toBeLessThanOrEqual(Math.ceil(20_000 / PRESENCE_HEARTBEAT_MS) + 1);
    expect(a.store.getState().peers.get(b.clientId)?.cursor).toBeNull();
    b.store.setVisibility(true);
    await settle(50);
    expect(a.store.getState().peers.get(b.clientId)?.cursor).toEqual({ x: 299, y: 299 });
    a.store.dispose();
    b.store.dispose();
  });

  it("a 50-viewer room with 5 people moving stays within the presence budget", async () => {
    const server = new FakeServer({ latency: 5 });
    server.seed({ type: "sticky" });
    const clients = [];
    for (let i = 0; i < 50; i++) clients.push(await startStore(server, "u" + i));
    await settle(2000);
    expect(clients[0].store.getState().peers.size).toBe(49);
    const start = server.callsOf("updatePresence").length;
    const movers = clients.slice(0, 5);
    const perMover = movers.map((c) => server.callsOf("updatePresence").filter((x) => x.args[0].clientId === c.clientId).length);
    for (let t = 0; t < 2000; t += 16) {
      for (const [i, c] of movers.entries()) c.store.setPresence({ cursor: { x: t + i, y: t } });
      await settle(16);
    }
    await settle(100);
    const total = server.callsOf("updatePresence").length - start;
    // 49 peers: movement gap 4 x 50 ms (5 Hz). Idle viewers only heartbeat.
    for (const [i, c] of movers.entries()) {
      const n = server.callsOf("updatePresence").filter((x) => x.args[0].clientId === c.clientId).length - perMover[i];
      expect(n).toBeLessThanOrEqual(12);
      expect(n).toBeGreaterThanOrEqual(5);
    }
    expect(total).toBeLessThanOrEqual(5 * 12 + 45 * 2);
    for (const c of clients) c.store.dispose();
  });
});
