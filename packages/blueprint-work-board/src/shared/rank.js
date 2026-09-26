// @ts-check
// Fractional indexes for manual order within a column (`work_item.rank`, ≤ 64 chars). Keys are
// base-36 strings compared as plain strings; there is always a key between two distinct keys and
// before/after any key, and a generated key never ends in "0" (so something can always precede it).

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
export const RANK_MAX = 64;

/** @param {string} key */
export function validRank(key) {
  return typeof key === "string" && key.length > 0 && key.length <= RANK_MAX && /^[0-9a-z]*[1-9a-z]$/.test(key);
}

/**
 * A key strictly between `a` and `b` (either may be empty/null for "unbounded").
 * @param {string|null|undefined} a lower bound ("" or null: none)
 * @param {string|null|undefined} b upper bound ("" or null: none)
 */
export function rankBetween(a, b) {
  const lo = a || "";
  let hi = b || null;
  if (hi !== null && lo >= hi) throw new Error(`rankBetween: "${lo}" is not below "${hi}"`);
  let out = "";
  for (let i = 0; ; i++) {
    const da = i < lo.length ? DIGITS.indexOf(lo[i]) : 0;
    const db = hi !== null && i < hi.length ? DIGITS.indexOf(hi[i]) : BASE;
    if (da === db) { out += DIGITS[da]; continue; }
    const mid = Math.floor((da + db) / 2);
    if (mid > da) return out + DIGITS[mid];
    // Adjacent digits: keep the lower digit, then anything above the rest of `lo` works.
    out += DIGITS[da];
    hi = null;
  }
}

/**
 * The rank for an item dropped at `index` in `ordered` (the column as shown, without the moved
 * item). Ranked items sort before unranked ones, so dropping among unranked items lands just
 * after the last ranked item.
 * @param {{ rank: string }[]} ordered @param {number} index
 */
export function rankAt(ordered, index) {
  const ranked = ordered.filter((x) => validRank(x.rank));
  const firstUnranked = ordered.findIndex((x) => !validRank(x.rank));
  const at = firstUnranked === -1 ? index : Math.min(index, firstUnranked);
  const prev = at > 0 ? ordered[at - 1]?.rank : "";
  const next = at < ranked.length ? ordered[at]?.rank : "";
  return rankBetween(validRank(prev) ? prev : "", validRank(next) ? next : "");
}

/** Orders by rank with unranked last. @param {string} a @param {string} b */
export function compareRank(a, b) {
  const va = validRank(a), vb = validRank(b);
  if (va && vb) return a < b ? -1 : a > b ? 1 : 0;
  return va ? -1 : vb ? 1 : 0;
}
