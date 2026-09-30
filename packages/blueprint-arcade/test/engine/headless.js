// Runs a cartridge's source headless in Node: imported as a data: URL module, exactly as the
// browser does, over the real engine with silent audio.
import { startGame } from "../../src/engine/index.js";

/** @param {string} source */
export async function importCartridge(source) {
  return import("data:text/javascript;charset=utf-8," + encodeURIComponent(source));
}

/**
 * @param {string} source
 * @param {{frames?: number, seed?: number, keys?: (frame: number) => string[], chars?: (frame: number) => string, tunes?: Record<string, any>}} [opts]
 */
export async function runHeadless(source, opts = {}) {
  const mod = await importCartridge(source);
  const scores = [];
  const logs = [];
  const game = startGame(mod, {
    player: { id: "tester@example.com", name: "Tester" },
    submitScore: (n, detail) => { scores.push({ name: "Tester", score: n, detail }); scores.sort((x, y) => y.score - x.score); },
    scores: () => scores,
    tune: (name) => opts.tunes?.[name] ?? { title: name, tempo: 120, channels: [{ mml: "c d e" }] },
    log: (...a) => logs.push(a.join(" ")),
  });
  if (opts.seed !== undefined) game.a.seed(opts.seed);
  // The player paints a frame before the first update; so do we.
  game.draw();
  let held = [];
  for (let f = 0; f < (opts.frames ?? 600); f++) {
    const next = opts.keys ? opts.keys(f) : [];
    for (const k of held) if (!next.includes(k)) game.input.keyup(k);
    for (const k of next) if (!held.includes(k)) game.input.keydown(k, k === "Enter" ? "Enter" : k === "Space" ? " " : undefined);
    held = next;
    for (const ch of opts.chars ? opts.chars(f) : "") {
      game.input.keydown("Char", ch === "\n" ? "Enter" : ch);
      game.input.keyup("Char");
    }
    game.step();
    game.draw();
  }
  return { game, scores, logs };
}

/** A key-mashing input script that holds each random choice for a few frames. @param {string[]} pool @param {number} seed */
export function monkey(pool, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let current = [];
  return (/** @type {number} */ f) => {
    if (f % 6 === 0) current = pool.filter(() => rnd() < 0.35);
    return current;
  };
}
