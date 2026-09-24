// @ts-check
// User-perceived characters ("grapheme clusters"), simplified for what a whiteboard holds: a
// character plus anything that attaches to it. Emoji are the reason this exists: a family, a
// flag, a skin-toned hand or a keycap is several code points (joined by U+200D ZERO WIDTH JOINER,
// followed by variation selectors, skin tone modifiers, tag characters or combining marks) that
// must never be split by truncation or line wrapping, or the reader sees broken pieces.
//
// The rules are a deterministic subset of Unicode's (UAX #29): a code point joins the cluster
// before it when it is an extender (below), when it follows a ZERO WIDTH JOINER, or when it is the
// second regional indicator of a flag. Server and client use the same code, so the stored text and
// every layout agree. Intl.Segmenter is not used because its answers depend on the runtime's ICU.

/** @param {number} code */
export function isRegionalIndicator(code) {
  return code >= 0x1f1e6 && code <= 0x1f1ff;
}

/**
 * Code points that never start a cluster: joiners, variation selectors, skin tone modifiers, tag
 * characters (subdivision flags) and combining marks (including U+20E3 COMBINING ENCLOSING KEYCAP).
 * @param {number} code
 */
export function isExtender(code) {
  return code === 0x200d || code === 0x200c ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0x1f3fb && code <= 0x1f3ff) ||
    (code >= 0xe0020 && code <= 0xe007f) ||
    (code >= 0xe0100 && code <= 0xe01ef) ||
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f);
}

/**
 * The clusters of `text`, in order; joined they give `text` back.
 * @param {string} text
 * @returns {Generator<string>}
 */
export function* graphemes(text) {
  const s = String(text);
  let start = 0;
  let prev = -1;
  let flags = 0; // regional indicators in the current cluster
  for (let i = 0; i < s.length;) {
    const code = /** @type {number} */ (s.codePointAt(i));
    const ri = isRegionalIndicator(code);
    const joins = i > 0 && (isExtender(code) || prev === 0x200d || (ri && flags === 1 && isRegionalIndicator(prev)));
    if (!joins) {
      if (i > start) yield s.slice(start, i);
      start = i;
      flags = 0;
    }
    if (ri) flags++;
    prev = code;
    i += code > 0xffff ? 2 : 1;
  }
  if (start < s.length) yield s.slice(start);
}

/** How many clusters `text` has (what a person would call its length in characters). @param {string} text */
export function graphemeCount(text) {
  let n = 0;
  for (const _ of graphemes(text)) n++;
  return n;
}

/**
 * `text` cut to at most `max` UTF-16 code units (the unit every text limit counts, as a browser's
 * `maxlength` does) without splitting a cluster: a family emoji is either kept whole or dropped.
 * A single cluster longer than `max` is cut at a code point boundary instead, never between the
 * halves of a surrogate pair.
 * @param {string} text @param {number} max
 */
export function truncateText(text, max) {
  const s = String(text);
  if (s.length <= max) return s;
  if (max <= 0) return "";
  // Clusters longer than 64 units do not occur in real text; look no further than that.
  const head = s.slice(0, max + 64);
  let end = 0;
  for (const g of graphemes(head)) {
    if (end + g.length > max) break;
    end += g.length;
  }
  if (end > 0) return s.slice(0, end);
  const code = s.charCodeAt(max - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}
