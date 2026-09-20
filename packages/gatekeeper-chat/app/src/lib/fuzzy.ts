// The fuzzy matcher behind the quick switcher.
//
// Subsequence matching with a score, not a library: the corpus is a few hundred channel names and
// display names, the needle is a handful of characters, and the only property that matters is that
// typing `dsgn` finds `#design` before it finds `#ship-dashboard-notes`. Scoring is where a fuzzy
// list is won or lost, so the weights live here with the tests that pin them rather than inline in a
// component.

export interface FuzzyMatch {
  readonly score: number;
  /** Indices in the haystack that the needle matched, for highlighting. */
  readonly positions: readonly number[];
}

/** Characters after which the next one counts as the start of a word. */
const BOUNDARY = /[\s\-_./#@:]/;

/**
 * Greedy left-to-right match.
 *
 * Greedy rather than optimal (which is a dynamic program over needle x haystack) because the failure
 * mode of greedy -- taking an early letter when a later one would have scored better -- is invisible
 * at these lengths, and the three bonuses below do the work an optimal matcher would do anyway.
 */
export function fuzzyMatch(needle: string, haystack: string): FuzzyMatch | null {
  const lowerNeedle = needle.toLowerCase();
  const lowerHay = haystack.toLowerCase();
  if (lowerNeedle.length === 0) return { score: 0, positions: [] };
  if (lowerNeedle.length > lowerHay.length) return null;

  const positions: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;

  for (const character of lowerNeedle) {
    const index = lowerHay.indexOf(character, from);
    if (index === -1) return null;
    let bonus = 0;
    if (index === previous + 1) bonus += 8;
    if (index === 0) bonus += 14;
    else if (BOUNDARY.test(lowerHay[index - 1] ?? "")) bonus += 10;
    // A gap costs, but only up to a point: one long jump should not outweigh three good letters.
    score += 10 + bonus - Math.min(6, index - from);
    positions.push(index);
    previous = index;
    from = index + 1;
  }

  // Between two haystacks that both match, the shorter one is the better answer.
  return { score: score - Math.min(20, lowerHay.length - lowerNeedle.length) / 2, positions };
}

export interface Ranked<T> {
  readonly item: T;
  readonly score: number;
  readonly positions: readonly number[];
}

/**
 * Ranks `items` against `needle`.
 *
 * `bonusOf` is what makes an empty query useful: with nothing typed every item scores zero, so the
 * caller's own ordering (recency, in practice) is the whole ranking. With a query it is added, so a
 * conversation you were just in still wins a tie.
 */
export function rankItems<T>(
  items: readonly T[],
  needle: string,
  textOf: (item: T) => string,
  bonusOf: (item: T) => number = () => 0,
): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(needle, textOf(item));
    if (match === null) continue;
    out.push({ item, score: match.score + bonusOf(item), positions: match.positions });
  }
  return out.toSorted((a, b) => b.score - a.score);
}

/** Splits `text` into matched and unmatched runs, so a row can bold what the query hit. */
export function highlightRuns(
  text: string,
  positions: readonly number[],
): Array<{ readonly text: string; readonly hit: boolean }> {
  if (positions.length === 0) return [{ text, hit: false }];
  const hits = new Set(positions);
  const runs: Array<{ text: string; hit: boolean }> = [];
  for (let index = 0; index < text.length; index++) {
    const hit = hits.has(index);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.hit === hit) last.text += text[index];
    else runs.push({ text: text[index]!, hit });
  }
  return runs;
}
