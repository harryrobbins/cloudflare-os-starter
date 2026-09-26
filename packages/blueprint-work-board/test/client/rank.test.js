import { describe, expect, it } from "vitest";
import { compareRank, rankAt, rankBetween, validRank } from "../../src/shared/rank.js";
import { mulberry32 } from "../../harness/seed.js";

describe("rankBetween", () => {
  it.each([
    ["", ""], ["", "1"], ["", "i"], ["1", ""], ["i", ""], ["a", "b"], ["a", "a1"], ["a0i", "a1"], ["0i", "1"],
    ["z", ""], ["zz", ""], ["", "01"], ["5", "6"], ["a", "a01"], ["y", "z"],
  ])("between %j and %j", (a, b) => {
    const r = rankBetween(a, b);
    expect(validRank(r)).toBe(true);
    if (a) expect(r > a).toBe(true);
    if (b) expect(r < b).toBe(true);
  });

  it("refuses bounds that are not ordered", () => {
    expect(() => rankBetween("b", "a")).toThrow();
    expect(() => rankBetween("a", "a")).toThrow();
  });

  it("never ends in 0", () => {
    for (const [a, b] of [["", "1"], ["0i", "1"], ["a", "a1"]]) expect(rankBetween(a, b).endsWith("0")).toBe(false);
  });

  it("keeps order over 1,000 random insertions with short keys", () => {
    const rng = mulberry32(7);
    /** @type {string[]} */
    const list = [];
    for (let i = 0; i < 1000; i++) {
      const at = Math.floor(rng() * (list.length + 1));
      const key = rankBetween(list[at - 1] ?? "", list[at] ?? "");
      list.splice(at, 0, key);
    }
    for (let i = 1; i < list.length; i++) expect(list[i - 1] < list[i]).toBe(true);
    expect(new Set(list).size).toBe(list.length);
    for (const k of list) expect(validRank(k)).toBe(true);
    expect(Math.max(...list.map((k) => k.length))).toBeLessThanOrEqual(64);
  });

  it("stays valid when always inserting at the top (worst case growth)", () => {
    let first = rankBetween("", "");
    for (let i = 0; i < 40; i++) {
      const next = rankBetween("", first);
      expect(next < first).toBe(true);
      first = next;
    }
    expect(first.length).toBeLessThanOrEqual(64);
  });

  it("appending at the end stays short", () => {
    let last = "";
    for (let i = 0; i < 200; i++) last = rankBetween(last, "");
    expect(last.length).toBeLessThan(64);
  });
});

describe("validRank / compareRank", () => {
  it.each([["a", true], ["0", false], ["", false], ["a0", false], ["A", false], ["a-b", false], ["z".repeat(64), true], ["z".repeat(65), false]])("validRank(%j) = %s", (k, ok) => {
    expect(validRank(k)).toBe(ok);
  });
  it("orders ranked before unranked", () => {
    const keys = ["", "b", "a", "0", "c"];
    expect([...keys].sort(compareRank)).toEqual(["a", "b", "c", "", "0"]);
    expect(compareRank("a", "a")).toBe(0);
    expect(compareRank("", "")).toBe(0);
  });
});

describe("rankAt", () => {
  const col = (/** @type {string[]} */ ranks) => ranks.map((rank) => ({ rank }));
  it("places between neighbours", () => {
    const r = rankAt(col(["a", "c"]), 1);
    expect(r > "a" && r < "c").toBe(true);
  });
  it("top and bottom", () => {
    expect(rankAt(col(["m", "n"]), 0) < "m").toBe(true);
    expect(rankAt(col(["m", "n"]), 2) > "n").toBe(true);
  });
  it("empty column", () => expect(validRank(rankAt([], 0))).toBe(true));
  it("dropping among unranked lands after the last ranked", () => {
    const r = rankAt(col(["a", "b", "", ""]), 3);
    expect(r > "b").toBe(true);
  });
  it("all unranked", () => expect(validRank(rankAt(col(["", ""]), 1))).toBe(true));
});
