// The "Emoji & symbols" tab's pure logic: data coverage, search ranking, categories, skin tones
// (checked against every skin variant in the pinned dataset), recent picks, the picker's ARIA tab
// keys and grid navigation, and the Ctrl/⌘+. shortcut.
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CHAR_CATEGORIES, RECENT_CHARS_MAX, SKIN_TONES, UNICODE_DATA_SOURCE, allChars, applySkinTone, charAccessibleName,
  charLabel, isSequence, matchRank, pushRecentChar, resolveChar, searchChars,
} from "../../src/client/ui/unicode.js";
import { PICKER_TABS, charResults, gridMoveByPosition, tabKeyMove } from "../../src/client/ui/icon-picker.js";
import { COMMANDS, keyAction } from "../../src/client/ui/canvas/keymap.js";
import { helpRows } from "../../src/client/ui/help.js";
import { graphemes } from "../../src/shared/graphemes.js";

const fromHexcode = (hex) => String.fromCodePoint(...hex.split("-").map((x) => parseInt(x, 16)));

describe("emoji and symbol data", () => {
  it("covers the current emoji set and every required symbol", () => {
    expect(UNICODE_DATA_SOURCE).toMatchObject({ package: "emojibase-data", version: "17.0.0", emojiVersion: "17.0", locale: "en-gb" });
    const emoji = allChars().filter((e) => e.kind === "emoji");
    expect(emoji.length).toBeGreaterThan(1850);
    for (const text of ["\u{1F600}", "\u{1F44D}", "\u{1F1EC}\u{1F1E7}", "❤️", "\u{1FAE9}" /* Emoji 16 */]) {
      expect(resolveChar(text), text).not.toBeNull();
    }
    for (const ch of "→⇒↔⟶↻≈≠≤≥±×÷∑∞√∀∃∈∧∨¬✓✗☐☑☒★☆●○■□▲▼◆•─│┌€£¥αβγΩ²₂⌘⌥⇧⏎⌫") {
      expect(resolveChar(ch)?.kind, ch).toBe("symbol");
    }
    expect(resolveChar("→")?.name).toBe("rightwards arrow");
    expect(resolveChar("⌘")?.keywords).toContain("command");
    // Every entry is exactly one user-perceived character.
    for (const e of allChars()) expect([...graphemes(e.text)], e.name).toHaveLength(1);
  });

  it("lists the emoji groups first, then the symbol groups", () => {
    const ids = CHAR_CATEGORIES.map((c) => c.id);
    expect(ids.slice(0, 9)).toEqual([
      "emoji:smileys", "emoji:people", "emoji:nature", "emoji:food", "emoji:travel", "emoji:activities",
      "emoji:objects", "emoji:symbols", "emoji:flags",
    ]);
    expect(ids.slice(9)).toEqual(expect.arrayContaining([
      "symbol:arrows", "symbol:maths", "symbol:checks", "symbol:shapes", "symbol:bullets", "symbol:box",
      "symbol:currency", "symbol:greek", "symbol:scripts", "symbol:keyboard",
    ]));
    for (const c of CHAR_CATEGORIES) expect(searchChars("", { category: c.id }).length, c.id).toBeGreaterThan(0);
    expect(searchChars("", { category: "emoji:flags" }).every((e) => e.category === "emoji:flags")).toBe(true);
    expect(searchChars("", { category: "symbol" }).every((e) => e.kind === "symbol")).toBe(true);
  });
});

describe("search ranking", () => {
  const entry = (name, keywords = []) => ({ text: "?", name, key: name.toLowerCase(), keywords, kind: "emoji", category: "emoji:x", order: 0 });

  it("ranks exact name > name prefix > word prefix > keyword > substring", () => {
    expect(matchRank(entry("star"), "star")).toBe(0);
    expect(matchRank(entry("star-struck"), "star")).toBe(1);
    expect(matchRank(entry("glowing star"), "star")).toBe(2);
    expect(matchRank(entry("sparkles", ["star"]), "star")).toBe(3);
    expect(matchRank(entry("sparkles", ["starry"]), "star")).toBe(4);
    expect(matchRank(entry("mustard"), "star")).toBe(5);
    expect(matchRank(entry("x", ["upstart"]), "star")).toBe(6);
    expect(matchRank(entry("red heart", ["love"]), "heart lo")).toBe(7);
    expect(matchRank(entry("tree"), "star")).toBe(Infinity);
  });

  it("finds real emoji and symbols by name, keyword, character and multi-word query", () => {
    expect(searchChars("grinning face")[0].text).toBe("\u{1F600}");
    expect(searchChars("thumbs up")[0].text).toBe("\u{1F44D}");
    expect(searchChars("GRINNING")[0].name).toMatch(/^grinning/);
    expect(searchChars("→")[0].text).toBe("→");
    expect(searchChars("flag: united kingdom")[0].text).toBe("\u{1F1EC}\u{1F1E7}");
    expect(searchChars("aubergine").map((e) => e.text)).toContain("\u{1F346}"); // en-gb keyword
    expect(searchChars("candy").map((e) => e.text)).toContain("\u{1F36C}"); // en-US name kept as a keyword
    expect(searchChars("tick").some((e) => e.text === "✓")).toBe(true);
    expect(searchChars("infinity", { category: "symbol" })[0].text).toBe("∞");
    expect(searchChars("zzqqxx")).toEqual([]);
    // Exact name first, then prefix matches, before keyword-only matches.
    const heart = searchChars("red heart");
    expect(heart[0].name).toBe("red heart");
  });

  it("lists recent picks for the Recently used filter, filtered by the query", () => {
    const recent = ["\u{1F600}", "→", "not-a-char"];
    expect(charResults("", "recent", recent).map((e) => e.text)).toEqual(["\u{1F600}", "→"]);
    expect(charResults("arrow", "recent", recent).map((e) => e.text)).toEqual(["→"]);
    expect(charResults("", "symbol:arrows", []).length).toBeGreaterThan(20);
    let list = /** @type {string[]} */ ([]);
    for (let i = 0; i < RECENT_CHARS_MAX + 3; i++) list = pushRecentChar(list, String(i));
    expect(list).toHaveLength(RECENT_CHARS_MAX);
    expect(pushRecentChar(list, list[5])[0]).toBe(list[5]);
    expect(new Set(pushRecentChar(list, list[5])).size).toBe(RECENT_CHARS_MAX);
  });

  it("names results for screen readers", () => {
    expect(charLabel(/** @type {any} */ (resolveChar("\u{1F600}")))).toBe("Grinning face");
    expect(charAccessibleName(/** @type {any} */ (resolveChar("\u{1F600}")))).toBe("Grinning face emoji");
    expect(charAccessibleName(/** @type {any} */ (resolveChar("→")))).toBe("Rightwards arrow symbol");
  });
});

describe("skin tones", () => {
  it("offers none plus the five modifiers, none first", () => {
    expect(SKIN_TONES.map((t) => t.tone)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(SKIN_TONES[0].modifier).toBe("");
  });

  it("matches every uniform-tone variant of the pinned dataset, keeping ZWJ sequences intact", async () => {
    const data = JSON.parse(await readFile(new URL("../../node_modules/emojibase-data/en-gb/data.json", import.meta.url), "utf8"));
    let checked = 0;
    for (const e of data) {
      if (!e.skins || typeof e.group !== "number" || e.group === 2) continue;
      const entry = resolveChar(fromHexcode(e.hexcode) + (e.type === 0 && !e.hexcode.includes("-") ? "\uFE0F" : ""));
      expect(entry, e.label).not.toBeNull();
      expect(applySkinTone(/** @type {any} */ (entry), 0)).toBe(entry?.text);
      for (const s of e.skins) {
        const tones = Array.isArray(s.tone) ? s.tone : [s.tone];
        if (!tones.every((t) => t === tones[0])) continue;
        expect(applySkinTone(/** @type {any} */ (entry), tones[0]), s.label).toBe(fromHexcode(s.hexcode));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1500);
    const hands = /** @type {any} */ (resolveChar("\u{1F9D1}‍\u{1F91D}‍\u{1F9D1}"));
    expect(applySkinTone(hands, 3)).toBe("\u{1F9D1}\u{1F3FD}‍\u{1F91D}‍\u{1F9D1}\u{1F3FD}");
    // Emoji without skin tones and symbols are unchanged.
    expect(applySkinTone(/** @type {any} */ (resolveChar("\u{1F600}")), 5)).toBe("\u{1F600}");
    expect(applySkinTone(/** @type {any} */ (resolveChar("→")), 5)).toBe("→");
  });

  it("recognises sequences whose rendering is checked", () => {
    expect(isSequence("\u{1F468}‍\u{1F469}‍\u{1F467}")).toBe(true);
    expect(isSequence("\u{1F1EC}\u{1F1E7}")).toBe(true);
    expect(isSequence("#️⃣")).toBe(true);
    expect(isSequence("\u{1F600}")).toBe(false);
    expect(isSequence("→")).toBe(false);
  });
});

describe("picker tabs and grid keys", () => {
  it("has two tabs, icons first", () => {
    expect(PICKER_TABS.map((t) => t.label)).toEqual(["Icons & shapes", "Emoji & symbols"]);
  });

  it("moves between tabs with the ARIA tab keys, wrapping", () => {
    expect(tabKeyMove(0, "ArrowRight", 2)).toBe(1);
    expect(tabKeyMove(1, "ArrowRight", 2)).toBe(0);
    expect(tabKeyMove(0, "ArrowLeft", 2)).toBe(1);
    expect(tabKeyMove(1, "Home", 2)).toBe(0);
    expect(tabKeyMove(0, "End", 2)).toBe(1);
    expect(tabKeyMove(0, "ArrowDown", 2)).toBeNull();
    expect(tabKeyMove(0, "Enter", 2)).toBeNull();
  });

  it("moves through a grid whose rows differ in length (sections with headings)", () => {
    // Row A: 3 cells at y 0; heading; row B: 1 cell at y 80; row C: 2 cells at y 130.
    const cells = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 80 }, { x: 0, y: 130 }, { x: 50, y: 130 }];
    expect(gridMoveByPosition(2, "ArrowDown", cells)).toBe(3); // nearest in x on the next row
    expect(gridMoveByPosition(3, "ArrowDown", cells)).toBe(4);
    expect(gridMoveByPosition(5, "ArrowUp", cells)).toBe(3);
    expect(gridMoveByPosition(1, "ArrowUp", cells)).toBe(1); // no row above: stay
    expect(gridMoveByPosition(5, "ArrowDown", cells)).toBe(5);
    expect(gridMoveByPosition(1, "ArrowRight", cells)).toBe(2);
    expect(gridMoveByPosition(3, "ArrowLeft", cells)).toBe(2);
    expect(gridMoveByPosition(0, "PageDown", cells)).toBe(4);
    expect(gridMoveByPosition(0, "End", cells)).toBe(5);
    expect(gridMoveByPosition(4, "Home", cells)).toBe(0);
    expect(gridMoveByPosition(0, "x", cells)).toBeNull();
    expect(gridMoveByPosition(0, "ArrowDown", [])).toBeNull();
  });

  it("opens Emoji & symbols with Ctrl/⌘+. on the canvas and while typing, without taking plain .", () => {
    expect(keyAction({ key: ".", ctrlKey: true })).toEqual({ type: "command", command: "emoji" });
    expect(keyAction({ key: ".", metaKey: true })).toEqual({ type: "command", command: "emoji" });
    expect(keyAction({ key: ".", ctrlKey: true }, "text")).toEqual({ type: "command", command: "emoji" });
    expect(keyAction({ key: "." })).toEqual({ type: "rotate", deg: 15 });
    expect(keyAction({ key: "." }, "text")).toBeNull();
    expect(keyAction({ key: "a" }, "text")).toBeNull();
    expect(COMMANDS.filter((c) => c.scope === "text").every((c) => c.action && typeof c.action === "object" && c.action.type === "command")).toBe(true);
    const tools = helpRows(false).find((g) => g.group === "Tools");
    expect(tools?.rows.find((r) => r.keys.includes("Ctrl+."))?.label).toMatch(/Emoji and symbols/);
  });
});
