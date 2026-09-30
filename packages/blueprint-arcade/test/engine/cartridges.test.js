// Every starter cartridge loads, runs 3000 frames of random input without throwing, and draws
// something other than a blank screen.
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CARTRIDGES } from "../../src/cartridges/registry.js";
import { runHeadless, monkey } from "./headless.js";

const dir = join(import.meta.dirname, "../../src/cartridges");
const KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "KeyZ", "KeyX", "Enter", "ShiftLeft"];

describe.each(CARTRIDGES.map((c) => [c.id, c]))("cartridge %s", (_id, cart) => {
  it("runs under random input and draws", async () => {
    const source = await readFile(join(dir, `${cart.id}.cart.js`), "utf8");
    const digits = "0123456789abcdefghijklmnopqrstuvwxyz \n";
    let s = 7;
    const chars = (/** @type {number} */ f) => (f % 9 === 0 ? digits[(s = (s * 31 + 11) % 997) % digits.length] : "");
    const { game } = await runHeadless(source, { frames: 3000, keys: monkey(KEYS, 3), chars, seed: 42 });
    expect(game.state.crashed).toBeNull();
    const used = new Set(game.screen.pixels);
    expect(used.size).toBeGreaterThan(1);
    expect(game.config.title).toBeTruthy();
    expect(Array.isArray(game.config.help)).toBe(true);
  }, 60_000);
});
