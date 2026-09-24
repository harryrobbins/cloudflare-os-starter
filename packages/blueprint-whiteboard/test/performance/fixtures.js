// @ts-check
// Deterministic large-board fixtures for the performance tests (model.test.js) and the benchmark
// (scripts/benchmark.mjs). Same seed and size, same board, byte for byte: ids come from a counter,
// text from a fixed word list, geometry from a seeded PRNG, and the core runs with a fixed clock.
//
// A board of `n` objects (n <= LIMITS.objects) mixes, roughly:
//   frames      1 per 100 objects (at most LIMITS.frames), laid out on a grid, each holding the
//               objects placed inside it
//   stickies    55%, some with long text (hundreds of characters)
//   rect/ellipse 15%
//   text        5%, half of them long (up to ~1,500 characters)
//   pen strokes 10%, 40 to 200 points each
//   connectors  the rest (~15%), between shapes near each other, some labelled and elbow-routed
// Objects spread over a square area of roughly 260 world units per object side, so a 1000x800
// viewport at zoom 1 sees a few dozen of them.
//
// Nothing here is real content; the benchmark still never prints any of it.

import { InMemoryRepository } from "../../src/core/repository.js";
import { createWhiteboard } from "../../src/core/whiteboard.js";
import { LIMITS } from "../../src/shared/protocol.js";

/** Board sizes the plan asks for. */
export const SIZES = /** @type {const} */ ([500, 2000, 5000]);

const WORDS = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar " +
  "papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu plan review risk owner " +
  "budget launch metric goal idea question decision follow-up draft scope").split(" ");

/** Seeded PRNG (mulberry32). @param {number} seed */
export function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {() => number} rng @param {number} words */
function sentence(rng, words) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rng() * WORDS.length)]);
  return out.join(" ");
}

/** Deterministic object ids: o_ + 12 hex digits. @param {number} i */
export function fixtureId(i) {
  return "o_" + (0x0f0000000000 + i).toString(16).padStart(12, "0");
}

/**
 * The create operations of a fixture board, in dependency order (frames, shapes, connectors).
 * @param {number} n  total objects, connectors and frames included
 * @param {{seed?: number}} [opts]
 * @returns {{ops: any[], side: number, counts: Record<string, number>}}
 */
export function fixtureOps(n, { seed = 1 } = {}) {
  const total = Math.max(0, Math.min(LIMITS.objects, Math.floor(n)));
  const rng = prng(seed * 7919 + total);
  let next = 0;
  const side = Math.ceil(Math.sqrt(total)) * 260;
  /** @type {Record<string, number>} */
  const counts = { frame: 0, sticky: 0, rect: 0, ellipse: 0, text: 0, pen: 0, connector: 0 };
  /** @type {any[]} */
  const frames = [];
  /** @type {any[]} */
  const shapes = [];
  /** @type {any[]} */
  const connectors = [];

  const frameCount = Math.min(LIMITS.frames, Math.floor(total / 100));
  const frameCols = Math.max(1, Math.ceil(Math.sqrt(frameCount)));
  const cellW = side / frameCols;
  /** @type {{id: string, x: number, y: number, w: number, h: number}[]} */
  const frameBoxes = [];
  for (let f = 0; f < frameCount; f++) {
    const col = f % frameCols, row = Math.floor(f / frameCols);
    const box = { id: fixtureId(next++), x: Math.round(col * cellW + 40), y: Math.round(row * cellW + 60), w: 1200, h: 900 };
    frameBoxes.push(box);
    frames.push({ op: "create", object: { id: box.id, type: "frame", x: box.x, y: box.y, w: box.w, h: box.h, text: `Frame ${f + 1}` } });
    counts.frame++;
  }

  const connectorTarget = Math.round((total - frameCount) * 0.15);
  const shapeCount = total - frameCount - connectorTarget;
  for (let i = 0; i < shapeCount; i++) {
    const id = fixtureId(next++);
    const r = rng();
    const type = r < 0.647 ? "sticky" : r < 0.765 ? "rect" : r < 0.824 ? "ellipse" : r < 0.883 ? "text" : "pen";
    let x = Math.round(rng() * side), y = Math.round(rng() * side);
    /** @type {string|null} */
    let frameId = null;
    // A third of the shapes go into a frame.
    if (frameBoxes.length && rng() < 0.33) {
      const box = frameBoxes[Math.floor(rng() * frameBoxes.length)];
      x = Math.round(box.x + 20 + rng() * (box.w - 260));
      y = Math.round(box.y + 20 + rng() * (box.h - 240));
      frameId = box.id;
    }
    /** @type {any} */
    const object = { id, type, x, y };
    if (frameId) object.frameId = frameId;
    if (type === "sticky") object.text = rng() < 0.1 ? sentence(rng, 60) : sentence(rng, 3 + Math.floor(rng() * 8));
    else if (type === "rect" || type === "ellipse") object.text = rng() < 0.5 ? sentence(rng, 2) : "";
    else if (type === "text") {
      object.text = rng() < 0.5 ? sentence(rng, 150 + Math.floor(rng() * 100)) : sentence(rng, 6);
      object.w = 360;
      object.h = 200;
    } else {
      const count = 40 + Math.floor(rng() * 160);
      const points = [];
      let px = rng(), py = rng();
      for (let k = 0; k < count; k++) {
        px = Math.min(1, Math.max(0, px + (rng() - 0.5) * 0.1));
        py = Math.min(1, Math.max(0, py + (rng() - 0.5) * 0.1));
        points.push(Math.round(px * 10000) / 10000, Math.round(py * 10000) / 10000);
      }
      object.points = points;
      object.w = 120 + Math.round(rng() * 200);
      object.h = 80 + Math.round(rng() * 160);
    }
    counts[type]++;
    shapes.push({ op: "create", object });
  }

  // Connectors between shapes that are near each other on the board (not pens): endpoints in
  // reading order by 1,000-unit bands, then a neighbour a few places along.
  const band = (/** @type {any} */ o) => Math.floor(o.y / 1000) * 1e7 + (Math.floor(o.y / 1000) % 2 ? -o.x : o.x);
  const endpoints = shapes.filter((s) => s.object.type !== "pen").map((s) => s.object)
    .sort((a, b) => band(a) - band(b)).map((o) => o.id);
  for (let c = 0; c < connectorTarget && endpoints.length > 1; c++) {
    const a = Math.floor(rng() * endpoints.length);
    const b = (a + 1 + Math.floor(rng() * 5)) % endpoints.length;
    if (a === b) continue;
    /** @type {any} */
    const object = { id: fixtureId(next++), type: "connector", from: endpoints[a], to: endpoints[b] };
    if (rng() < 0.2) object.text = sentence(rng, 2);
    if (rng() < 0.3) object.routing = "elbow";
    connectors.push({ op: "create", object });
    counts.connector++;
  }
  return { ops: [...frames, ...shapes, ...connectors], side, counts };
}

/**
 * Builds a fixture board through the real core (validation, order keys, stored shapes) with a
 * fixed clock and ids, and returns its snapshot.
 * @param {number} n @param {{seed?: number}} [opts]
 * @returns {Promise<{snapshot: any, board: any, repo: InMemoryRepository, side: number, counts: Record<string, number>}>}
 */
export async function buildFixture(n, opts = {}) {
  const { ops, side, counts } = fixtureOps(n, opts);
  const repo = new InMemoryRepository();
  let t = 1_700_000_000_000;
  let h = 0;
  const board = createWhiteboard(repo, {
    now: () => (t += 1),
    newId: (/** @type {string} */ kind) => (kind === "history" ? "h_" : kind[0] + "_") + (++h).toString(16).padStart(12, "0"),
  });
  for (let i = 0; i < ops.length; i += 500) {
    const res = await board.applyOperation({ by: "Fixture", senderId: "fixture", objectOps: ops.slice(i, i + 500) });
    const errors = res?.result?.errors ?? res?.errors ?? [];
    if (errors.length) throw new Error(`fixture ${n}: ${errors.length} operation errors, first: ${errors[0].code ?? errors[0].message}`);
  }
  const snapshot = await board.getBoard();
  return { snapshot, board, repo, side, counts };
}

/**
 * `count` simple objects (stickies) as plain client objects, laid out on a grid starting at
 * (x0, y0) with `gap` spacing; no core round trip (for DOM/culling tests).
 * @param {number} count @param {{x0?: number, y0?: number, gap?: number, start?: number}} [opts]
 */
export function simpleObjects(count, { x0 = 0, y0 = 0, gap = 260, start = 0 } = {}) {
  /** @type {Record<string, any>} */
  const out = {};
  const cols = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    const id = fixtureId(0x100000 + start + i);
    out[id] = {
      id, type: "sticky", x: x0 + (i % cols) * gap, y: y0 + Math.floor(i / cols) * gap, w: 200, h: 200, rot: 0,
      z: "a" + (start + i).toString(36).padStart(4, "0"), frameId: null, text: "", version: 1, createdAt: 0, updatedAt: 0,
      createdBy: "t", style: { fill: "#fde68a", stroke: "none", strokeWidth: 0, textColor: "#1f2937", fontSize: 20, align: "center", arrowStart: "none", arrowEnd: "none" },
    };
  }
  return out;
}
