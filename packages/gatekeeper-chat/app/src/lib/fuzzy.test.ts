import { describe, expect, it } from "vitest";

import { fuzzyMatch, highlightRuns, rankItems } from "./fuzzy.js";

describe("fuzzyMatch", () => {
  it("matches a subsequence and reports where", () => {
    const match = fuzzyMatch("dsgn", "design");
    expect(match).not.toBeNull();
    expect(match?.positions).toEqual([0, 2, 4, 5]);
  });

  it("returns null when a letter is missing or the needle is longer", () => {
    expect(fuzzyMatch("dz", "design")).toBeNull();
    expect(fuzzyMatch("designer", "design")).toBeNull();
  });

  it("ignores case", () => {
    expect(fuzzyMatch("AC", "Alice Chen")).not.toBeNull();
  });

  it("scores an empty needle as zero rather than rejecting it", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("prefers a prefix over a match in the middle", () => {
    const prefix = fuzzyMatch("de", "design")!.score;
    const middle = fuzzyMatch("de", "undelivered")!.score;
    expect(prefix).toBeGreaterThan(middle);
  });

  it("prefers word starts, which is what makes initials work", () => {
    const initials = fuzzyMatch("ac", "Alice Chen")!.score;
    const scattered = fuzzyMatch("ac", "abstract")!.score;
    expect(initials).toBeGreaterThan(scattered);
  });

  it("prefers the shorter of two haystacks", () => {
    expect(fuzzyMatch("design", "design")!.score).toBeGreaterThan(
      fuzzyMatch("design", "design-system-notes")!.score,
    );
  });
});

describe("rankItems", () => {
  const names = ["general", "design", "releases", "random", "design-system-notes"];

  it("orders by score and drops non-matches", () => {
    const ranked = rankItems(names, "des", (name) => name);
    expect(ranked.map((entry) => entry.item)).toEqual(["design", "design-system-notes"]);
  });

  it("keeps everything for an empty query, so the caller's order stands", () => {
    expect(rankItems(names, "", (name) => name)).toHaveLength(names.length);
  });

  it("puts a recently used item first when the scores are close", () => {
    const ranked = rankItems(
      ["design", "designs"],
      "design",
      (name) => name,
      (name) => (name === "designs" ? 100 : 0),
    );
    expect(ranked[0]?.item).toBe("designs");
  });
});

describe("highlightRuns", () => {
  it("splits into matched and unmatched runs", () => {
    expect(highlightRuns("design", [0, 2, 4, 5])).toEqual([
      { text: "d", hit: true },
      { text: "e", hit: false },
      { text: "s", hit: true },
      { text: "i", hit: false },
      { text: "gn", hit: true },
    ]);
  });

  it("is one unmatched run when nothing matched", () => {
    expect(highlightRuns("design", [])).toEqual([{ text: "design", hit: false }]);
  });
});
