// @ts-check
// Structural equality and cloning for plain JSON-shaped data (cards, columns, labels).

/**
 * Deep equality for JSON-shaped values. Object key order is ignored.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ra = /** @type {Record<string, unknown>} */ (a);
  const rb = /** @type {Record<string, unknown>} */ (b);
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  for (const k of ka) {
    if (!Object.hasOwn(rb, k) || !deepEqual(ra[k], rb[k])) return false;
  }
  return true;
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function clone(value) {
  return value === undefined ? value : structuredClone(value);
}
