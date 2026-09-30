// Scripted play-throughs of the arcade starters: start from the title, play until game over, and
// check a score was submitted to the host.
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runHeadless } from "./headless.js";

const load = (id) => readFile(join(import.meta.dirname, "../../src/cartridges", `${id}.cart.js`), "utf8");
// Tap a key: held for 2 frames out of every `period`.
const tap = (key, period = 8) => (f) => (f % period < 2 ? [key] : []);

describe("arcade starters play through", () => {
  it("invaders: firing from the start scores, and game over submits it", async () => {
    const { scores, game } = await runHeadless(await load("invaders"), { frames: 20000, seed: 1, keys: tap("Space", 10) });
    expect(game.state.crashed).toBeNull();
    expect(scores.length).toBeGreaterThanOrEqual(1);
    expect(scores[0].score).toBeGreaterThan(0);
  }, 60_000);

  it("rocks: spinning and firing scores, and game over submits it", async () => {
    const keys = (f) => [...(f % 8 < 2 ? ["Space"] : []), "ArrowLeft"];
    const { scores, game } = await runHeadless(await load("rocks"), { frames: 30000, seed: 2, keys });
    expect(game.state.crashed).toBeNull();
    expect(scores.length).toBeGreaterThanOrEqual(1);
    expect(scores[0].score).toBeGreaterThan(0);
  }, 60_000);

  it("blocks: hard-dropping every piece tops out and submits drop points", async () => {
    const { scores, game } = await runHeadless(await load("blocks"), { frames: 3000, seed: 3, keys: (f) => (f < 2 ? ["Space"] : tap("ArrowUp", 6)(f)) });
    expect(game.state.crashed).toBeNull();
    expect(scores.length).toBeGreaterThanOrEqual(1);
    expect(scores[0].score).toBeGreaterThan(0);
  }, 60_000);

  it("blocks: the well clears a line", async () => {
    const mod = await import("data:text/javascript;charset=utf-8," + encodeURIComponent(await load("blocks")));
    const { startGame } = await import("../../src/engine/index.js");
    const g = startGame(mod, {});
    const w = g.a.well(10, 20);
    for (let x = 0; x < 10; x++) w.set(x, 19, "red");
    expect(w.clearLines()).toBe(1);
  });

  it("bricks: the served ball hits bricks, and losing every ball submits the score", async () => {
    const { scores, game } = await runHeadless(await load("bricks"), { frames: 20000, seed: 4, keys: tap("Space", 30) });
    expect(game.state.crashed).toBeNull();
    expect(scores.length).toBeGreaterThanOrEqual(1);
    expect(scores[0].score).toBeGreaterThan(0);
  }, 60_000);

  it("blank: fire scores and Return submits once", async () => {
    const keys = (f) => (f < 40 ? tap("Space", 4)(f) : f === 50 || f === 60 ? ["Enter"] : []);
    const { scores } = await runHeadless(await load("blank"), { frames: 80, keys });
    expect(scores).toHaveLength(1);
    expect(scores[0].score).toBe(100);
  });
});
