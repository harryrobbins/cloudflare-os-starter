// The emoji and symbol data build (scripts/unicode/build-unicode.mjs, run by
// scripts/build-icon-packs.mjs): pinned source, determinism, the checked-in module, --check, the
// size budget, the curated symbol table and the licence notices.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EMOJI_SOURCE, UNICODE_BUDGET_BYTES, UNICODE_OUTPUT, buildUnicode, cleanKeywords, compileUnicode, fromHexcode, renderUnicodeModule, skinTemplate,
} from "../../scripts/unicode/build-unicode.mjs";
import { SYMBOL_GROUPS } from "../../scripts/unicode/symbols.mjs";
import { OUTPUTS } from "../../scripts/build-icon-packs.mjs";

const pkgDir = fileURLToPath(new URL("../..", import.meta.url));

describe("unicode data build", () => {
  it("is deterministic, matches the checked-in module and stays within budget", async () => {
    const a = await buildUnicode();
    const b = await buildUnicode();
    expect(a.text).toBe(b.text);
    expect(await readFile(UNICODE_OUTPUT, "utf8")).toBe(a.text);
    expect(a.bytes).toBeLessThanOrEqual(UNICODE_BUDGET_BYTES);
    expect(renderUnicodeModule(await compileUnicode())).toBe(a.text);
    expect(OUTPUTS.unicode).toBe(UNICODE_OUTPUT);
    expect(UNICODE_OUTPUT).toMatch(/src\/client\/generated\/unicode-data\.js$/); // client-only
  });

  it("passes `node scripts/build-icon-packs.mjs --check` without writing", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ["scripts/build-icon-packs.mjs", "--check"], { cwd: pkgDir });
    expect(stdout).toMatch(/icon packs are current .* emoji and \d+ symbols/);
  }, 30000);

  it("pins the exact dataset version and records its hash", async () => {
    const { data } = await buildUnicode();
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.devDependencies[EMOJI_SOURCE.package]).toBe(EMOJI_SOURCE.version); // exact, never a range
    expect(data.source).toMatchObject({ package: "emojibase-data", version: "17.0.0", emojiVersion: "17.0" });
    expect(data.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.count).toBeGreaterThan(1850);
    expect(data.toned).toBeGreaterThan(300);
    expect(data.emoji.map((g) => g.id)).toEqual(["smileys", "people", "nature", "food", "travel", "activities", "objects", "symbols", "flags"]);
  });

  it("keeps a clean curated symbol table: unique characters with their Unicode names", () => {
    const seen = new Set();
    for (const g of SYMBOL_GROUPS) {
      for (const [ch, name] of g.symbols) {
        expect([...ch], name).toHaveLength(1);
        expect(seen.has(ch), ch).toBe(false);
        seen.add(ch);
        expect(name, ch).toMatch(/^[A-Z0-9 -]+$/);
      }
    }
    expect(SYMBOL_GROUPS.find((g) => g.id === "arrows")?.symbols[0]).toEqual(["→", "RIGHTWARDS ARROW", expect.any(String)]);
    expect(SYMBOL_GROUPS.find((g) => g.id === "keyboard")?.symbols.find(([c]) => c === "⌘")?.[1]).toBe("PLACE OF INTEREST SIGN");
  });

  it("derives skin tone templates and cleans keywords", () => {
    expect(fromHexcode("1F44D-1F3FB")).toBe("\u{1F44D}\u{1F3FB}");
    expect(skinTemplate({ skins: [{ tone: 2, hexcode: "1F44D-1F3FC" }, { tone: 1, hexcode: "1F44D-1F3FB" }] })).toBe("\u{1F44D}\u{1F3FB}");
    expect(skinTemplate({ skins: [{ tone: [1, 2], hexcode: "X" }, { tone: [1, 1], hexcode: "1F9D1-1F3FB" }] })).toBe("\u{1F9D1}\u{1F3FB}");
    expect(skinTemplate({})).toBeNull();
    expect(cleanKeywords("grinning face", ["Face", "happy", "happy", "a,b", " smile "])).toEqual(["happy", "smile"]);
  });

  it("writes the MIT and Unicode licence texts into THIRD_PARTY_NOTICES.md and the module", async () => {
    const notices = await readFile(OUTPUTS.notices, "utf8");
    expect(notices).toContain("emojibase-data@17.0.0");
    expect(notices).toContain("Emoji 17.0");
    expect(notices).toContain("Copyright (c) 2017-2019 Miles Johnson");
    expect(notices).toContain("UNICODE LICENSE V3");
    expect(notices).toContain("@tabler/icons@3.48.0"); // the icon packs' section is kept
    const mod = await readFile(UNICODE_OUTPUT, "utf8");
    expect(mod).toContain("UNICODE LICENSE V3");
    expect(mod).toContain("Permission is hereby granted, free of charge");
  });
});
