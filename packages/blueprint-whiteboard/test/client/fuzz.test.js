// Randomised convergence test: three real stores against the REAL core and hub over a simulated
// network with latency, FIFO channels and restarts (test/client/net.js). Stores create, update,
// move, restyle, delete, connect, frame, reorder, undo and redo. After quiescence every store must
// match the server exactly, with nothing pending, correct peers, no duplicate history and no
// resubscribe storm.
//
// Default budget is small so it runs with the suite. Widen it locally, e.g.:
//   SEEDS=1,2,3,4,5,6,7,8 STEPS=1000 MAXLAT=80 pnpm exec vitest run test/client/fuzz.test.js
// Other knobs: FIFO=0 (allow reordering), RESTARTS=0, UNDO=0, GAP (max ms between actions).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Net, mulberry32 } from "./net.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const SEEDS = (process.env.SEEDS ?? "1,2,3").split(",").map(Number);
const STEPS = Number(process.env.STEPS ?? 200);
const FIFO = process.env.FIFO !== "0";
const RESTARTS = process.env.RESTARTS !== "0";
const UNDO = process.env.UNDO !== "0";
const MAXLAT = Number(process.env.MAXLAT ?? 50);
const GAP = Number(process.env.GAP ?? 30);

function pick(rng, arr) { return arr.length ? arr[Math.floor(rng() * arr.length)] : undefined; }

const COLORS = ["#ff0000", "#00FF00", "#fff3a0", "none", "bad"];

function act(rng, store, net, log) {
  const s = store.getState();
  const all = Object.values(s.board.objects);
  const shapes = all.filter((o) => o.type !== "connector" && o.type !== "frame");
  const frames = all.filter((o) => o.type === "frame");
  const endpoints = all.filter((o) => o.type !== "connector");
  const r = rng();
  const obj = pick(rng, all);
  if (r < 0.14 && all.length < 60) {
    const type = pick(rng, ["sticky", "rect", "ellipse", "text", "pen"]);
    const o = { type, x: Math.floor(rng() * 1000), y: Math.floor(rng() * 1000), text: "t" + Math.floor(rng() * 10) };
    if (type === "pen") Object.assign(o, { points: [0, 0, 0.5, 0.25, 1, 1] });
    if (rng() < 0.2 && frames.length) o.frameId = pick(rng, frames).id;
    log.push(["create", type]);
    store.createObjects([o]);
  } else if (r < 0.17 && frames.length < 4) {
    log.push(["frame"]);
    store.createObjects([{ type: "frame", x: Math.floor(rng() * 500), y: 0, text: "F" + Math.floor(rng() * 9) }]);
  } else if (r < 0.24 && endpoints.length >= 2) {
    const from = pick(rng, endpoints).id;
    const to = pick(rng, endpoints.filter((o) => o.id !== from)).id;
    log.push(["connect", from, to]);
    store.createObjects([{ type: "connector", from, to, routing: rng() < 0.5 ? "elbow" : "straight" }]);
  } else if (r < 0.44 && shapes.length) {
    // A multi-object move (nudge), as a drag commit.
    const group = shapes.filter(() => rng() < 0.3).slice(0, 5);
    if (!group.length) group.push(pick(rng, shapes));
    const dx = Math.floor(rng() * 41) - 20;
    log.push(["move", group.map((o) => o.id), dx]);
    store.updateObjects(group.map((o) => ({ id: o.id, patch: { x: o.x + dx, y: o.y + 1 } })));
  } else if (r < 0.52 && shapes.length) {
    const o = pick(rng, shapes);
    log.push(["resize", o.id]);
    store.updateObjects([{ id: o.id, patch: { w: Math.max(1, o.w + Math.floor(rng() * 21) - 10), rot: o.type === "pen" ? 0 : (o.rot + 15) % 360 } }]);
  } else if (r < 0.60 && obj) {
    const f = pick(rng, ["text", "fill", "textColor", "frameId", "routing"]);
    const patch = f === "text" ? { text: "x" + Math.floor(rng() * 20) + (rng() < 0.1 ? "  \r\n" : "") }
      : f === "fill" ? { style: { fill: pick(rng, COLORS) } }
      : f === "textColor" ? { style: { textColor: pick(rng, COLORS) } }
      : f === "frameId" ? { frameId: rng() < 0.5 ? null : pick(rng, frames)?.id ?? null }
      : { routing: rng() < 0.5 ? "elbow" : "straight" };
    log.push(["update", obj.id, patch]);
    store.updateObjects([{ id: obj.id, patch }]);
  } else if (r < 0.66 && obj) {
    const ids = [obj.id, ...all.filter(() => rng() < 0.05).map((o) => o.id)];
    log.push(["delete", ids]);
    store.deleteObjects(ids);
  } else if (r < 0.72 && obj) {
    const ids = [obj.id, ...all.filter(() => rng() < 0.1).map((o) => o.id)];
    const where = rng() < 0.5 ? "front" : "back";
    log.push(["reorder", ids, where]);
    store.reorder(ids, where);
  } else if (r < 0.80 && UNDO) {
    log.push(["undo"]);
    store.undo();
  } else if (r < 0.85 && UNDO) {
    log.push(["redo"]);
    store.redo();
  } else if (r < 0.88) {
    log.push(["structure"]);
    store.setStructure(rng() < 0.5 ? { title: "T" + Math.floor(rng() * 9) } : { background: pick(rng, ["dots", "grid", "plain"]) });
  } else if (r < 0.95) {
    store.setPresence({ cursor: { x: Math.floor(rng() * 100), y: 0 }, selection: obj ? [obj.id] : [] });
  } else if (r < 0.96 && RESTARTS) {
    log.push(["restart"]);
    net.restart();
  }
}

for (const seed of SEEDS) {
  it(`fuzz seed=${seed} steps=${STEPS} fifo=${FIFO} restarts=${RESTARTS}`, async () => {
    const rng = mulberry32(seed);
    // Ids, client ids and request secrets from seeded generators too, so a seed replays exactly.
    const idRng = mulberry32(seed * 31 + 7);
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((arr) => {
      const bytes = /** @type {Uint8Array} */ (arr);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(idRng() * 256);
      return arr;
    });
    vi.spyOn(Math, "random").mockImplementation(mulberry32(seed * 97 + 3));
    const net = new Net({ rng: mulberry32(seed * 7919), minLat: 0, maxLat: MAXLAT, fifo: FIFO });
    const stores = [await net.startStore("a"), await net.startStore("b"), await net.startStore("c")];
    const log = [];
    for (let i = 0; i < STEPS; i++) {
      act(rng, pick(rng, stores), net, log);
      await vi.advanceTimersByTimeAsync(Math.floor(rng() * GAP));
    }
    // Quiescence: wait for queues to drain and connections to be live.
    for (let rounds = 0; rounds < 200; rounds++) {
      await vi.advanceTimersByTimeAsync(500);
      const quiet = stores.every((st) => st.getState().pending === 0 && st.getState().connection === "live");
      if (quiet) break;
    }
    await vi.advanceTimersByTimeAsync(10000); // heartbeats, gap detection, trailing events
    const server = await net.board.getBoard();
    const context = () => JSON.stringify({ seed, tail: log.slice(-30) });
    const restarts = log.filter((l) => l[0] === "restart").length;
    const requests = new Set(net.calls.filter((c) => c.method === "applyOperation").map((c) => c.args[0].requestId)).size;
    if (process.env.FUZZ_DEBUG) {
      process.stderr.write(JSON.stringify({
        seed, revision: server.revision, objects: Object.keys(server.objects).length,
        restarts, requests,
        subscribes: net.calls.filter((c) => c.method === "subscribe").length,
        errors: stores.map((st) => st.getState().lastError),
      }) + "\n");
    }
    // Sanity: the run did real work, and most distinct requests were applied. (Not a fraction of
    // STEPS: changes made while a request is in flight coalesce, so short gaps, high latency and
    // restarts legitimately mean far fewer requests than steps.)
    expect(requests).toBeGreaterThan(Math.min(20, STEPS / 50));
    expect(server.revision).toBeGreaterThan(requests / 2);
    for (const st of stores) {
      const s = st.getState();
      expect(s.pending, context()).toBe(0);
      expect(s.connection, context()).toBe("live");
      const diffs = [];
      for (const k of ["schemaVersion", "revision", "title", "background"]) {
        if (s.board[k] !== server[k]) diffs.push([k, s.board[k], server[k]]);
      }
      for (const id of new Set([...Object.keys(server.objects), ...Object.keys(s.board.objects)])) {
        if (JSON.stringify(s.board.objects[id]) !== JSON.stringify(server.objects[id])) {
          diffs.push(["object", id, s.board.objects[id], server.objects[id]]);
        }
      }
      expect(diffs, s.viewer.name + " " + context()).toEqual([]);
      // The server itself holds no connector with a missing endpoint.
      for (const o of Object.values(server.objects)) {
        if (o.type === "connector") {
          expect(server.objects[o.from]).toBeDefined();
          expect(server.objects[o.to]).toBeDefined();
        }
      }
    }
    for (const st of stores) {
      const s = st.getState();
      const expected = ["a", "b", "c"].filter((n) => n !== s.viewer.name).map((n) => "client-" + n);
      expect([...s.peers.keys()].sort(), s.viewer.name).toEqual(expected);
      const ids = s.history.map((h) => h.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    // No resubscribe storm in a further quiet minute.
    const subscribes = () => net.calls.filter((c) => c.method === "subscribe").length;
    const before = subscribes();
    await vi.advanceTimersByTimeAsync(60000);
    expect(subscribes()).toBe(before);
    for (const st of stores) st.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  }, 60000);
}
