// @ts-check
// Fractional ordering keys, so moving a card is one write instead of renumbering a column.
// Adapted from David Greenspan's "Implementing Fractional Indexing" as implemented by
// rocicorp/fractional-indexing (CC0). Keys are base-62 strings that sort with plain `<`.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0];
const INTEGER_ZERO = "a" + ZERO;
const SMALLEST_INTEGER = "A" + ZERO.repeat(26);

/**
 * @param {string} a
 * @param {string|null} b
 * @returns {string}
 */
function midpoint(a, b) {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.slice(-1) === ZERO || (b && b.slice(-1) === ZERO)) throw new Error("trailing zero");
  if (b) {
    let n = 0;
    while ((a[n] || ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))];
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/** @param {string} head */
function integerLength(head) {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new Error("invalid order key head: " + head);
}

/** @param {string} key */
function integerPart(key) {
  const length = integerLength(key[0]);
  if (length > key.length) throw new Error("invalid order key: " + key);
  return key.slice(0, length);
}

/** @param {string} key */
function validate(key) {
  if (key === SMALLEST_INTEGER) throw new Error("invalid order key: " + key);
  for (const ch of key) if (!DIGITS.includes(ch)) throw new Error("invalid order key: " + key);
  const i = integerPart(key);
  if (key.slice(i.length).slice(-1) === ZERO) throw new Error("invalid order key: " + key);
}

/**
 * True when `key` is a well-formed ordering key that keyBetween accepts as a neighbour.
 * @param {unknown} key
 */
export function isValidOrderKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 128) return false;
  try {
    validate(key);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} x */
function incrementInteger(x) {
  const [head, ...digits] = x.split("");
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) + 1;
    if (d === DIGITS.length) digits[i] = ZERO;
    else { digits[i] = DIGITS[d]; carry = false; }
  }
  if (carry) {
    if (head === "Z") return "a" + ZERO;
    if (head === "z") return null;
    const h = String.fromCharCode(head.charCodeAt(0) + 1);
    if (h > "a") digits.push(ZERO);
    else digits.pop();
    return h + digits.join("");
  }
  return head + digits.join("");
}

/** @param {string} x */
function decrementInteger(x) {
  const [head, ...digits] = x.split("");
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) - 1;
    if (d === -1) digits[i] = DIGITS.slice(-1);
    else { digits[i] = DIGITS[d]; borrow = false; }
  }
  if (borrow) {
    if (head === "a") return "Z" + DIGITS.slice(-1);
    if (head === "A") return null;
    const h = String.fromCharCode(head.charCodeAt(0) - 1);
    if (h < "Z") digits.push(DIGITS.slice(-1));
    else digits.pop();
    return h + digits.join("");
  }
  return head + digits.join("");
}

/**
 * A key strictly between `a` and `b`. `null` means "no bound" on that side.
 * Throws if a >= b or either key is malformed; use isValidOrderKey on untrusted input first.
 * @param {string|null} a
 * @param {string|null} b
 * @returns {string}
 */
export function keyBetween(a, b) {
  if (a !== null) validate(a);
  if (b !== null) validate(b);
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a === null) {
    if (b === null) return INTEGER_ZERO;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint("", fb);
    if (ib < b) return ib;
    const res = decrementInteger(ib);
    if (res === null) throw new Error("cannot decrement any more");
    return res;
  }
  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia);
    return i === null ? ia + midpoint(fa, null) : i;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = incrementInteger(ia);
  if (i === null) throw new Error("cannot increment any more");
  if (i < b) return i;
  return ia + midpoint(fa, null);
}

/**
 * `n` sorted keys strictly between `a` and `b`, evenly spread.
 * @param {string|null} a
 * @param {string|null} b
 * @param {number} n
 * @returns {string[]}
 */
export function keysBetween(a, b, n) {
  if (n <= 0) return [];
  if (n === 1) return [keyBetween(a, b)];
  if (b === null) {
    let c = keyBetween(a, b);
    const out = [c];
    for (let i = 0; i < n - 1; i++) out.push(c = keyBetween(c, b));
    return out;
  }
  if (a === null) {
    let c = keyBetween(a, b);
    const out = [c];
    for (let i = 0; i < n - 1; i++) out.push(c = keyBetween(a, c));
    return out.reverse();
  }
  const mid = Math.floor(n / 2);
  const c = keyBetween(a, b);
  return [...keysBetween(a, c, mid), c, ...keysBetween(c, b, n - mid - 1)];
}
