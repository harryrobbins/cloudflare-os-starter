// @ts-check
// Single-seat single transferable vote (instant-runoff). Pure: no storage, no clock.
//
// Each round, every ballot counts for its highest-ranked option still in the race. An option with
// more than half of the ballots still counting wins. Otherwise the option with the fewest votes is
// eliminated and its ballots move to their next choice.
//
// Options with no votes at all in a round are eliminated together. They carry no ballots, so this
// gives the same winner as removing them one at a time, with fewer rounds to read.
//
// Tie for last place: the tied option that had fewer votes in the most recent earlier round in
// which they differed goes out. If they were level in every round, lots are drawn with `random`,
// and the round records it.

/**
 * @typedef {object} Round
 * @property {Record<string, number>} counts   votes per option still in the race at the start of the round
 * @property {number} exhausted                 ballots with no option left in the race
 * @property {string[]} eliminated              options removed at the end of the round (empty in the final round)
 * @property {Record<string, number>} transfers where the eliminated options' ballots went next
 * @property {number} transferredToExhausted    of those, how many ballots ran out of options
 * @property {null|"earlier-round"|"lot"} tieBreak how a tie for last place was settled
 */

/**
 * @typedef {object} CountResult
 * @property {string|null} winner
 * @property {Round[]} rounds
 * @property {number} ballots
 */

/**
 * @param {string[]} optionIds  options in the race
 * @param {string[][]} ballots  each ballot's option ids, most preferred first
 * @param {{random?: () => number}} [opts]
 * @returns {CountResult}
 */
export function countInstantRunoff(optionIds, ballots, { random = Math.random } = {}) {
  const known = new Set(optionIds);
  const clean = ballots.map((b) => {
    const seen = new Set();
    return b.filter((id) => known.has(id) && !seen.has(id) && seen.add(id));
  });
  /** @type {Round[]} */
  const rounds = [];
  const continuing = new Set(optionIds);
  if (continuing.size === 0) return { winner: null, rounds, ballots: clean.length };

  /** @param {string[]} b */
  const top = (b) => b.find((id) => continuing.has(id)) ?? null;

  for (;;) {
    /** @type {Record<string, number>} */
    const counts = {};
    for (const id of optionIds) if (continuing.has(id)) counts[id] = 0;
    let exhausted = 0;
    for (const b of clean) {
      const t = top(b);
      if (t === null) exhausted++;
      else counts[t]++;
    }
    const active = clean.length - exhausted;
    /** @type {Round} */
    const round = { counts, exhausted, eliminated: [], transfers: {}, transferredToExhausted: 0, tieBreak: null };
    rounds.push(round);

    const ids = Object.keys(counts);
    const leader = ids.reduce((a, b) => (counts[b] > counts[a] ? b : a));
    if (ids.length === 1 || (active > 0 && counts[leader] * 2 > active)) {
      return { winner: ids.length === 1 ? ids[0] : leader, rounds, ballots: clean.length };
    }

    const zeros = ids.filter((id) => counts[id] === 0);
    if (zeros.length > 0 && zeros.length < ids.length) {
      round.eliminated = zeros;
    } else {
      const min = Math.min(...ids.map((id) => counts[id]));
      let tied = ids.filter((id) => counts[id] === min);
      if (tied.length > 1) {
        for (let r = rounds.length - 2; r >= 0 && tied.length > 1; r--) {
          const earlier = rounds[r].counts;
          const low = Math.min(...tied.map((id) => earlier[id]));
          const narrowed = tied.filter((id) => earlier[id] === low);
          if (narrowed.length < tied.length) { tied = narrowed; round.tieBreak = "earlier-round"; }
        }
        if (tied.length > 1) {
          tied = [tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))]];
          round.tieBreak = "lot";
        }
      }
      round.eliminated = tied;
    }

    const leaving = new Set(round.eliminated);
    const moving = clean.filter((b) => { const t = top(b); return t !== null && leaving.has(t); });
    for (const id of leaving) continuing.delete(id);
    for (const b of moving) {
      const next = top(b);
      if (next === null) round.transferredToExhausted++;
      else round.transfers[next] = (round.transfers[next] ?? 0) + 1;
    }
  }
}
