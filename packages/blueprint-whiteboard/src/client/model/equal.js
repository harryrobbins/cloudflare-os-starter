// @ts-check
// Structural equality for JSON-like values (objects, arrays, strings, numbers, booleans, null).

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ra = /** @type {Record<string, unknown>} */ (a);
  const rb = /** @type {Record<string, unknown>} */ (b);
  let n = 0;
  for (const k in ra) {
    if (!Object.hasOwn(ra, k)) continue;
    if (ra[k] === undefined) continue;
    if (!Object.hasOwn(rb, k) || !deepEqual(ra[k], rb[k])) return false;
    n++;
  }
  let m = 0;
  for (const k in rb) if (Object.hasOwn(rb, k) && rb[k] !== undefined) m++;
  return n === m;
}
