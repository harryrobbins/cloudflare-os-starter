import { describe, expect, it } from "vitest";
import { countInstantRunoff } from "../../src/shared/count.js";

/** @param {string} s e.g. "ABC" -> ["A","B","C"] */
const b = (s) => s.split("");

describe("countInstantRunoff", () => {
  it("elects a first-round majority without eliminating anyone", () => {
    const r = countInstantRunoff(b("ABC"), [b("ABC"), b("ACB"), b("BAC")]);
    expect(r.winner).toBe("A");
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0].counts).toEqual({ A: 2, B: 1, C: 0 });
  });

  it("transfers the eliminated option's ballots to their next choice", () => {
    // A 4, B 3, C 2 (C's go to B): B wins 5-4.
    const ballots = [...Array(4).fill(b("ABC")), ...Array(3).fill(b("BAC")), ...Array(2).fill(b("CBA"))];
    const r = countInstantRunoff(b("ABC"), ballots);
    expect(r.winner).toBe("B");
    expect(r.rounds[0].eliminated).toEqual(["C"]);
    expect(r.rounds[0].transfers).toEqual({ B: 2 });
    expect(r.rounds[1].counts).toEqual({ A: 4, B: 5 });
  });

  it("eliminates every zero-vote option together", () => {
    const r = countInstantRunoff(b("ABCDE"), [b("ABCDE"), b("BACDE"), b("ABCDE")]);
    expect(r.rounds[0].counts).toEqual({ A: 2, B: 1, C: 0, D: 0, E: 0 });
    expect(r.winner).toBe("A");
    const r2 = countInstantRunoff(b("ABCDE"), [b("ABCDE"), b("BACDE"), b("CABDE")]);
    expect(r2.rounds[0].eliminated).toEqual(["D", "E"]);
    expect(r2.rounds[0].transfers).toEqual({});
  });

  it("breaks a tie for last by an earlier round, then by lot", () => {
    // Round 1: A 3, B 2, C 2, D 1 -> D out, to C. Round 2: A 3, B 2, C 3: B out.
    const ballots = [...Array(3).fill(b("ABCD")), ...Array(2).fill(b("BACD")), ...Array(2).fill(b("CABD")), b("DCAB")];
    const r = countInstantRunoff(b("ABCD"), ballots);
    expect(r.rounds[0].eliminated).toEqual(["D"]);
    expect(r.rounds[1].eliminated).toEqual(["B"]);
    expect(r.winner).toBe("A");

    // Round 1: A 2, B 2, C 1 -> C out to nobody useful... then A vs B level in every round: lot.
    const tie = [b("AB"), b("AB"), b("BA"), b("BA")];
    const lot = countInstantRunoff(b("AB"), tie, { random: () => 0 });
    expect(lot.rounds[0].tieBreak).toBe("lot");
    expect(lot.rounds[0].eliminated).toEqual(["A"]);
    expect(lot.winner).toBe("B");
    const earlier = countInstantRunoff(b("ABC"), [b("ACB"), b("ACB"), b("BCA"), b("CBA"), b("BAC")], { random: () => 0.99 });
    // Round 1: A 2, B 2, C 1 -> C out, to B. Round 2: A 2, B 3: B wins.
    expect(earlier.winner).toBe("B");
  });

  it("uses the earlier round to separate options tied now", () => {
    // Round 1: A 4, B 3, C 3, D 2 (both D ballots go to C and B one each) -> Round 2: A 4, B 4, C 4.
    // Earlier round: B 3, C 3 vs A 4 -> B and C still tied -> lot among B and C only.
    const ballots = [
      ...Array(4).fill(b("ABCD")), ...Array(3).fill(b("BACD")), ...Array(3).fill(b("CABD")), b("DBAC"), b("DCAB"),
    ];
    const r = countInstantRunoff(b("ABCD"), ballots, { random: () => 0 });
    expect(r.rounds[1].counts).toEqual({ A: 4, B: 4, C: 4 });
    expect(r.rounds[1].tieBreak).toBe("lot");
    expect(r.rounds[1].eliminated).toEqual(["B"]);
  });

  it("handles one option, no ballots and stray ids", () => {
    expect(countInstantRunoff(["A"], []).winner).toBe("A");
    expect(countInstantRunoff([], [["A"]]).winner).toBe(null);
    const r = countInstantRunoff(b("AB"), [["A", "X", "A"], ["B"], ["B", "A"]]);
    expect(r.winner).toBe("B");
  });
});
