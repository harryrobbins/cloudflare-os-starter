// Randomised convergence test: three real stores against the REAL core over a simulated network
// with latency, FIFO channels, restarts, undo and conflict resolution (test/client/net.js). After
// quiescence every store must match the server exactly, with nothing pending, correct peers, no
// duplicate history and no resubscribe storm.
//
// Default budget is small so it runs with the suite. Widen it locally, e.g.:
//   SEEDS=1,2,3,4,5,6,7,8 STEPS=1000 MAXLAT=80 pnpm exec vitest run test/client/fuzz.test.js
// Other knobs: FIFO=0 (allow reordering), RESTARTS=0, UNDO=0, GAP (max ms between actions).
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Net, mulberry32 } from "./net.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const SEEDS = (process.env.SEEDS ?? "1,2,3").split(",").map(Number);
const STEPS = Number(process.env.STEPS ?? 200);
const FIFO = process.env.FIFO !== "0";
const RESTARTS = process.env.RESTARTS !== "0";
const UNDO = process.env.UNDO !== "0";
const MAXLAT = Number(process.env.MAXLAT ?? 50);
const GAP = Number(process.env.GAP ?? 30);

function pick(rng, arr) { return arr.length ? arr[Math.floor(rng() * arr.length)] : undefined; }

function randomTitle(rng) {
  const base = pick(rng, ["alpha", "beta", "gamma", "delta", "x"]) + Math.floor(rng() * 100);
  const r = rng();
  if (r < 0.1) return base + "  ";      // trailing spaces (cleaned by the server)
  if (r < 0.15) return "ab" + base; // control character (cleaned by the server)
  return base;
}

function act(rng, store, net, log) {
  const s = store.getState();
  const b = s.board;
  const cols = b.columnOrder;
  const cards = Object.values(b.cards);
  const labels = Object.keys(b.labels);
  const r = rng();
  const col = pick(rng, cols);
  const card = pick(rng, cards);
  if (r < 0.2 && col) {
    const before = rng() < 0.5 ? pick(rng, cards.filter((c) => c.columnId === col))?.id ?? null : null;
    log.push(["createCard", col, before]);
    store.createCard(col, { title: randomTitle(rng) }, before);
  } else if (r < 0.35 && card) {
    const f = pick(rng, ["title", "description", "assignee", "due", "labels"]);
    const v = f === "title" ? randomTitle(rng)
      : f === "description" ? "d" + Math.floor(rng() * 10) + (rng() < 0.1 ? "\r\n" : "")
      : f === "assignee" ? pick(rng, ["Sam", "Kim", " Lee ", ""])
      : f === "due" ? pick(rng, ["2026-01-02", "2026-02-30", null, "nope"])
      : labels.filter(() => rng() < 0.3);
    log.push(["updateCard", card.id, f, v]);
    store.updateCard(card.id, { [f]: v });
  } else if (r < 0.45 && card) {
    const cl = card.checklist ?? [];
    let next;
    if (cl.length && rng() < 0.6) {
      const i = Math.floor(rng() * cl.length);
      next = cl.map((it, j) => (j === i ? { ...it, done: !it.done } : it));
    } else {
      next = [...cl, rng() < 0.5 ? { text: "item" + Math.floor(rng() * 9), done: false }
        : { id: "i_" + Math.floor(rng() * 0xffffffff).toString(16).padStart(8, "0"), text: "it", done: false }];
    }
    log.push(["checklist", card.id, next]);
    store.updateCard(card.id, { checklist: next });
  } else if (r < 0.62 && card && col) {
    const before = rng() < 0.6 ? pick(rng, cards.filter((c) => c.columnId === col))?.id ?? null : null;
    log.push(["moveCard", card.id, col, before]);
    store.moveCard(card.id, col, before);
  } else if (r < 0.68 && card) {
    log.push(["deleteCard", card.id]);
    store.deleteCard(card.id);
  } else if (r < 0.72 && cols.length < 8) {
    log.push(["createColumn"]);
    store.createColumn("Col" + Math.floor(rng() * 9), rng() < 0.5 ? Math.floor(rng() * 5) : undefined);
  } else if (r < 0.76 && col) {
    log.push(["renameColumn", col]);
    store.renameColumn(col, randomTitle(rng));
  } else if (r < 0.79 && col) {
    log.push(["moveColumn", col]);
    store.moveColumn(col, Math.floor(rng() * cols.length));
  } else if (r < 0.81 && col) {
    log.push(["collapse", col]);
    store.setColumnCollapsed(col, rng() < 0.5);
  } else if (r < 0.83 && col && cols.length > 2) {
    log.push(["deleteColumn", col]);
    store.deleteColumn(col);
  } else if (r < 0.86) {
    log.push(["upsertLabel"]);
    store.upsertLabel(rng() < 0.5 ? pick(rng, labels) ?? null : null, randomTitle(rng), pick(rng, ["#ff0000", "#00FF00", "bad"]));
  } else if (r < 0.87 && labels.length) {
    log.push(["deleteLabel"]);
    store.deleteLabel(pick(rng, labels));
  } else if (r < 0.89) {
    log.push(["setTitle"]);
    store.setTitle(randomTitle(rng));
  } else if (r < 0.92 && UNDO && s.history.length) {
    const h = pick(rng, s.history);
    log.push(["undo", h.id]);
    store.undo(h.id).catch(() => {});
  } else if (r < 0.93 && RESTARTS) {
    log.push(["restart"]);
    net.restart();
  }
  for (const [id] of s.conflicts) {
    if (rng() < 0.3) {
      log.push(["resolve", id]);
      store.resolveConflict(id, rng() < 0.5 ? "overwrite" : "discard");
    }
  }
}

for (const seed of SEEDS) {
  it(`fuzz seed=${seed} steps=${STEPS} fifo=${FIFO} restarts=${RESTARTS}`, async () => {
    const rng = mulberry32(seed);
    const net = new Net({ rng: mulberry32(seed * 7919), minLat: 0, maxLat: MAXLAT, fifo: FIFO });
    const stores = [await net.startStore("a"), await net.startStore("b"), await net.startStore("c")];
    const log = [];
    for (let i = 0; i < STEPS; i++) {
      act(rng, pick(rng, stores), net, log);
      await vi.advanceTimersByTimeAsync(Math.floor(rng() * GAP));
    }
    // Quiescence: resolve conflicts, wait for queues to drain and connections to be live.
    for (let rounds = 0; rounds < 200; rounds++) {
      for (const st of stores) {
        for (const [id] of st.getState().conflicts) st.resolveConflict(id, rng() < 0.5 ? "overwrite" : "discard");
      }
      await vi.advanceTimersByTimeAsync(500);
      const quiet = stores.every((st) => st.getState().pending === 0 && st.getState().connection === "live" &&
        st.getState().conflicts.size === 0);
      if (quiet) break;
    }
    await vi.advanceTimersByTimeAsync(10000); // heartbeats, gap detection, trailing events
    const server = await net.board.getBoard();
    const context = () => JSON.stringify({ seed, tail: log.slice(-30) });
    // The run did real work: many applied changes and at least some re-subscribes.
    if (process.env.FUZZ_DEBUG) console.log(JSON.stringify({ seed, revision: server.revision, cards: Object.keys(server.cards).length, restarts: log.filter((l) => l[0] === "restart").length, subscribes: net.calls.filter((c) => c.method === "subscribe").length, errors: stores.map((st) => st.getState().lastError) }));
    expect(server.revision).toBeGreaterThan(STEPS / 4);
    for (const st of stores) {
      const s = st.getState();
      expect(s.pending, context()).toBe(0);
      expect(s.connection, context()).toBe("live");
      const diffs = [];
      for (const k of Object.keys(server)) {
        if (k !== "cards" && k !== "lastModified" && JSON.stringify(s.board[k]) !== JSON.stringify(server[k])) {
          diffs.push([k, s.board[k], server[k]]);
        }
      }
      for (const id of new Set([...Object.keys(server.cards), ...Object.keys(s.board.cards)])) {
        if (JSON.stringify(s.board.cards[id]) !== JSON.stringify(server.cards[id])) {
          diffs.push(["card", id, s.board.cards[id], server.cards[id]]);
        }
      }
      expect(diffs, s.viewer.name + " " + context()).toEqual([]);
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
