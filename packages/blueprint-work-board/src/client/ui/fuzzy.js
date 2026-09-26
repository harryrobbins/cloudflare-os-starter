// @ts-check
// Fuzzy matching for the command palette and pickers: every query character must appear in order;
// contiguous runs, word starts and prefixes score higher. Returns null for no match.

/** @param {string} query @param {string} text @returns {number|null} */
export function fuzzyScore(query, text) {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct !== -1) return 1000 - direct * 2 - (t.length - q.length) * 0.1 + (direct === 0 || /[\s\-_/]/.test(t[direct - 1] ?? "") ? 200 : 0);
  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, ti);
    if (at === -1) return null;
    run = at === ti ? run + 1 : 0;
    score += 10 + run * 5 + (at === 0 || /[\s\-_/]/.test(t[at - 1]) ? 15 : 0) - Math.min(9, at - ti);
    ti = at + 1;
  }
  return score;
}

/**
 * @template T @param {string} query @param {T[]} items @param {(item: T) => string} text @param {number} [limit]
 * @returns {T[]}
 */
export function fuzzyFilter(query, items, text, limit = 50) {
  if (!query.trim()) return items.slice(0, limit);
  /** @type {{ item: T, score: number, i: number }[]} */
  const scored = [];
  items.forEach((item, i) => { const score = fuzzyScore(query, text(item)); if (score !== null) scored.push({ item, score, i }); });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.item);
}
