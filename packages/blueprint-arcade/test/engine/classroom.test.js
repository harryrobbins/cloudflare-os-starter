// Scripted play-throughs of the classroom cartridges: a player who knows the answers scores.
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startGame } from "../../src/engine/index.js";
import { importCartridge } from "./headless.js";

const dir = join(import.meta.dirname, "../../src/cartridges");

async function boot(id) {
  const mod = await importCartridge(await readFile(join(dir, `${id}.cart.js`), "utf8"));
  const scores = [];
  const game = startGame(mod, {
    player: { id: "t@example.com", name: "Tester" },
    submitScore: (n, detail) => { scores.push({ name: "Tester", score: n, detail }); },
    scores: () => scores,
    tune: (name) => ({ title: name, tempo: 120, channels: [{ mml: "c" }] }),
  });
  game.a.seed(5);
  const frame = (n = 1) => game.run(n);
  const type = (text) => {
    for (const ch of text) {
      if (ch === "\n") game.input.keydown("Enter", "Enter"); else game.input.keydown("Char", ch);
      frame();
      game.input.keyup(ch === "\n" ? "Enter" : "Char");
    }
  };
  const press = (code) => { game.input.keydown(code); frame(); game.input.keyup(code); frame(); };
  const debug = () => game.state.scene.debug();
  return { game, scores, frame, type, press, debug };
}

describe("classroom cartridges", () => {
  it("Teletext Tables: a perfect 7 times table round scores and submits", async () => {
    const t = await boot("tables");
    t.frame(5);
    t.type("7\n");
    expect(t.debug().mode).toBe("quiz");
    for (let i = 0; i < 12; i++) {
      const { q } = t.debug();
      expect(q.text).toMatch(/x 7$/);
      t.type(`${q.answer}\n`);
      expect(t.debug().mode).toBe("feedback");
      t.frame(50);
    }
    expect(t.debug().mode).toBe("end");
    expect(t.debug().correct).toBe(12);
    expect(t.scores).toHaveLength(1);
    expect(t.scores[0].score).toBeGreaterThan(12 * 10);
    t.type("\n");
    expect(t.debug().mode).toBe("title");
  });

  it("Teletext Tables: wrong answers and time-outs score nothing", async () => {
    const t = await boot("tables");
    t.press("ArrowDown");
    t.type("\n"); // 3 times table from the menu
    expect(t.debug().q.text).toMatch(/x 3$/);
    t.type("999\n");
    expect(t.debug().score).toBe(0);
    t.frame(110);
    t.frame(10 * 60 + 5); // let the clock run out
    expect(t.debug().score).toBe(0);
    expect(t.debug().qNumber).toBe(2);
  });

  it("Dark Room: guessing every word solves the passage with a score", async () => {
    const t = await boot("darkroom");
    t.frame(3);
    t.type("1\n");
    const { puzzle } = t.debug();
    expect(t.debug().mode).toBe("play");
    t.type("zzzz\n"); // a wrong word costs points
    expect(t.debug().score).toBe(990);
    t.type("e\n"); // buying a letter costs points
    expect(t.debug().score).toBe(965);
    const words = [...new Set(puzzle.words.filter((w) => w.word).map((w) => w.text.toLowerCase()))];
    for (const w of words) if (t.debug().mode === "play") t.type(`${w}\n`);
    expect(t.debug().mode).toBe("solved");
    expect(t.scores[0].score).toBe(965);
  });

  it("Number Gulper: gulping every matching number clears the level", async () => {
    const t = await boot("gulper");
    t.frame(3);
    t.press("Space");
    expect(t.debug().mode).toBe("play");
    const { cells, rule } = t.debug();
    let before = t.debug().score;
    for (let i = 0; i < cells.length && t.debug().mode === "play"; i++) {
      if (!rule.r.test(cells[i].n)) continue;
      const tx = i % 6, ty = Math.floor(i / 6);
      while (t.debug().gx < tx) t.press("ArrowRight");
      while (t.debug().gx > tx) t.press("ArrowLeft");
      while (t.debug().gy < ty) t.press("ArrowDown");
      while (t.debug().gy > ty) t.press("ArrowUp");
      if (t.debug().mode !== "play") break; // a Troggle got us; still fine for this test
      t.press("Space");
      expect(t.debug().score).toBeGreaterThan(before);
      before = t.debug().score;
    }
    expect(["clear", "dying", "play"]).toContain(t.debug().mode);
    t.frame(130);
    expect(t.debug().level).toBeGreaterThanOrEqual(1);
  });

  it("Number Gulper: a wrong gulp costs a life", async () => {
    const t = await boot("gulper");
    t.press("Space");
    const { cells, rule } = t.debug();
    const i = cells.findIndex((c) => !rule.r.test(c.n));
    const tx = i % 6, ty = Math.floor(i / 6);
    while (t.debug().gx < tx) t.press("ArrowRight");
    while (t.debug().gy < ty) t.press("ArrowDown");
    t.press("Space");
    expect(t.debug().lives).toBe(2);
  });
});
