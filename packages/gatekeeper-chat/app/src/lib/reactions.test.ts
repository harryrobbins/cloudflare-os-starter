import { beforeEach, describe, expect, it } from "vitest";

import {
  countUse,
  describeReactors,
  EMOJI_FREQUENCY_KEY,
  quickReactions,
  rankQuickReactions,
  readEmojiFrequency,
  recordEmojiUse,
  resetEmojiFrequencyCache,
} from "./reactions.js";

const DEFAULTS = ["👍", "🎉", "👀", "✅", "❤️"] as const;

describe("rankQuickReactions", () => {
  it("is the defaults when nothing has been used", () => {
    expect(rankQuickReactions({}, DEFAULTS)).toEqual([...DEFAULTS]);
  });

  it("puts the most-used first and pads the rest with the defaults", () => {
    expect(rankQuickReactions({ "🚀": 9, "🐛": 4 }, DEFAULTS)).toEqual([
      "🚀",
      "🐛",
      "👍",
      "🎉",
      "👀",
    ]);
  });

  it("never repeats an emoji that is both used and a default", () => {
    const row = rankQuickReactions({ "✅": 12 }, DEFAULTS);
    expect(row[0]).toBe("✅");
    expect(new Set(row).size).toBe(row.length);
  });

  it("breaks a tie in the defaults' own order, so the row does not shuffle", () => {
    expect(rankQuickReactions({ "❤️": 3, "👍": 3 }, DEFAULTS).slice(0, 2)).toEqual(["👍", "❤️"]);
  });

  it("ignores a zero or negative count", () => {
    expect(rankQuickReactions({ "🚀": 0 }, DEFAULTS)).toEqual([...DEFAULTS]);
  });
});

describe("countUse", () => {
  it("starts a new emoji at one and increments an existing one", () => {
    expect(countUse({}, "🚀")["🚀"]).toBe(1);
    expect(countUse({ "🚀": 4 }, "🚀")["🚀"]).toBe(5);
  });

  it("keeps the table bounded", () => {
    let frequency = {};
    for (let index = 0; index < 40; index++) frequency = countUse(frequency, `e${index}`);
    expect(Object.keys(frequency).length).toBeLessThanOrEqual(24);
  });
});

describe("the stored frequency", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetEmojiFrequencyCache();
  });

  it("round-trips through localStorage", () => {
    recordEmojiUse("🐛");
    recordEmojiUse("🐛");
    resetEmojiFrequencyCache();
    expect(readEmojiFrequency()["🐛"]).toBe(2);
    expect(quickReactions()[0]).toBe("🐛");
  });

  it("returns the same array reference until something is recorded", () => {
    expect(quickReactions()).toBe(quickReactions());
    const before = quickReactions();
    recordEmojiUse("🎯");
    expect(quickReactions()).not.toBe(before);
  });

  it("survives junk in the store", () => {
    window.localStorage.setItem(EMOJI_FREQUENCY_KEY, "not json");
    resetEmojiFrequencyCache();
    expect(readEmojiFrequency()).toEqual({});
  });
});

const nameOf = (id: string): string | undefined =>
  ({ "u-alice": "Alice Chen", "u-bob": "Bob Okafor" })[id];

describe("describeReactors", () => {
  it("names one person", () => {
    expect(describeReactors("👍", ["u-alice"], "me", nameOf)).toBe("Alice Chen reacted with 👍");
  });

  it("names two", () => {
    expect(describeReactors("👍", ["u-alice", "u-bob"], "me", nameOf)).toBe(
      "Alice Chen and Bob Okafor reacted with 👍",
    );
  });

  it("puts You first", () => {
    expect(describeReactors("👍", ["u-alice", "me"], "me", nameOf)).toBe(
      "You and Alice Chen reacted with 👍",
    );
  });

  it("collapses a long list", () => {
    const ids = ["me", "u-alice", "u-bob", "x", "y", "z"];
    expect(describeReactors("🎉", ids, "me", nameOf)).toBe(
      "You, Alice Chen, Bob Okafor and 3 others reacted with 🎉",
    );
  });

  it("falls back for somebody the directory has not seen", () => {
    expect(describeReactors("👀", ["u-ghost"], "me", nameOf)).toBe("Someone reacted with 👀");
  });
});
