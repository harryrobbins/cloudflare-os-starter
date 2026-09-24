// @ts-check
// The "Emoji & symbols" data behind the icon picker's second tab: every current emoji (CLDR names,
// groups, keywords, skin tone templates) and a curated set of Unicode symbols for diagrams, from
// the generated, client-only src/client/generated/unicode-data.js. Pure functions: the search
// ranking, skin tones, categories and recent picks are tested without a DOM.
//
// Emoji are inserted as plain text and drawn by each viewer's system emoji font, so they look
// different on different systems; no emoji images are shipped.

import { EMOJI_GROUPS, SYMBOL_GROUPS, UNICODE_SOURCE } from "../generated/unicode-data.js";

/**
 * One pickable character or emoji sequence.
 * @typedef {object} CharEntry
 * @property {string} text        what is inserted with no skin tone
 * @property {string} name        CLDR name (emoji; British English, so "flag: United Kingdom") or
 *   Unicode name (symbols, lower case)
 * @property {string} key         the name in lower case, for search
 * @property {string[]} keywords
 * @property {"emoji"|"symbol"} kind
 * @property {string} category    "emoji:<group>" or "symbol:<group>"
 * @property {string} [subgroup]  emoji only: CLDR subgroup label ("smiling")
 * @property {string} [toned]     emoji only: skin tone template (see applySkinTone)
 * @property {number} order       position in the whole list
 */

/** Recent picks remembered (per viewer, in this browser). */
export const RECENT_CHARS_MAX = 24;
/** Where a skin tone template puts the tone: the light skin tone modifier. */
const PLACEHOLDER = "\u{1F3FB}";

/** Skin tones: 0 is none (the emoji's default yellow), 1 to 5 the Fitzpatrick-based modifiers. */
export const SKIN_TONES = Object.freeze([
  { tone: 0, label: "No skin tone", modifier: "" },
  { tone: 1, label: "Light skin tone", modifier: "\u{1F3FB}" },
  { tone: 2, label: "Medium-light skin tone", modifier: "\u{1F3FC}" },
  { tone: 3, label: "Medium skin tone", modifier: "\u{1F3FD}" },
  { tone: 4, label: "Medium-dark skin tone", modifier: "\u{1F3FE}" },
  { tone: 5, label: "Dark skin tone", modifier: "\u{1F3FF}" },
]);

/** Where the data came from (package, version, Emoji version), for the docs and tests. */
export const UNICODE_DATA_SOURCE = UNICODE_SOURCE;

/**
 * Categories for the filter, emoji first.
 * @type {readonly {id: string, label: string, kind: "emoji"|"symbol"}[]}
 */
export const CHAR_CATEGORIES = Object.freeze([
  ...EMOJI_GROUPS.map((g) => ({ id: "emoji:" + g.id, label: g.label, kind: /** @type {const} */ ("emoji") })),
  ...SYMBOL_GROUPS.map((g) => ({ id: "symbol:" + g.id, label: g.label, kind: /** @type {const} */ ("symbol") })),
]);

/** @type {{list: CharEntry[], byText: Map<string, CharEntry>}|null} */
let index = null;

/** Every entry in display order, built on first use. */
export function allChars() {
  return charIndex().list;
}

function charIndex() {
  if (index) return index;
  /** @type {CharEntry[]} */
  const list = [];
  for (const g of EMOJI_GROUPS) {
    for (const [, subLabel, emoji] of /** @type {[string, string, any[]][]} */ (g.subgroups)) {
      for (const [text, name, kw, toned] of emoji) {
        /** @type {CharEntry} */
        const e = { text, name, key: name.toLowerCase(), keywords: kw ? kw.split(",") : [], kind: "emoji", category: "emoji:" + g.id, subgroup: subLabel, order: list.length };
        if (toned) e.toned = toned;
        list.push(e);
      }
    }
  }
  for (const g of SYMBOL_GROUPS) {
    for (const [text, name, kw] of /** @type {[string, string, string][]} */ (g.symbols)) {
      list.push({ text, name, key: name.toLowerCase(), keywords: kw ? kw.split(",") : [], kind: "symbol", category: "symbol:" + g.id, order: list.length });
    }
  }
  index = { list, byText: new Map(list.map((e) => [e.text, e])) };
  return index;
}

/**
 * The entry for a character's plain (untoned) text, or null.
 * @param {string} text
 * @returns {CharEntry|null}
 */
export function resolveChar(text) {
  return charIndex().byText.get(text) ?? null;
}

/**
 * The text to insert for `entry` in skin tone `tone` (0 to 5). Emoji that take no tone, and tone
 * 0, give the plain text. Multi-person emoji take the tone on every person; joiners, variation
 * selectors and the rest of a sequence are kept exactly as they are.
 * @param {CharEntry} entry @param {number} tone
 */
export function applySkinTone(entry, tone) {
  const t = SKIN_TONES[tone];
  if (!entry.toned || !t || !t.modifier) return entry.text;
  return entry.toned.split(PLACEHOLDER).join(t.modifier);
}

/** "grinning face" -> "Grinning face"; "flag: United Kingdom" stays readable. @param {CharEntry} e */
export function charLabel(e) {
  return e.name.charAt(0).toUpperCase() + e.name.slice(1);
}

/** The accessible name of a result: its name and what kind of thing it is. @param {CharEntry} e */
export function charAccessibleName(e) {
  return e.kind === "emoji" ? `${charLabel(e)} emoji` : `${charLabel(e)} symbol`;
}

/** @param {string} s */
const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * How well `entry` matches `q` (normalised, non-empty): lower is better, Infinity for no match.
 *   0 the query is the character itself, or its exact name
 *   1 the name starts with the query
 *   2 a word of the name starts with the query
 *   3 a keyword is the query
 *   4 a keyword starts with the query
 *   5 the name contains the query
 *   6 a keyword or the subgroup contains the query
 *   7 every word of a multi-word query starts a word of the name or a keyword
 * @param {CharEntry} entry @param {string} q
 */
export function matchRank(entry, q) {
  if (entry.text === q || entry.key === q) return 0;
  if (entry.key.startsWith(q)) return 1;
  const nameWords = entry.key.split(/[\s:,()-]+/).filter(Boolean);
  if (nameWords.some((w) => w.startsWith(q))) return 2;
  if (entry.keywords.includes(q)) return 3;
  if (entry.keywords.some((k) => k.startsWith(q))) return 4;
  if (entry.key.includes(q)) return 5;
  if (entry.keywords.some((k) => k.includes(q)) || entry.subgroup?.includes(q)) return 6;
  const parts = q.split(" ");
  if (parts.length > 1) {
    const words = [...nameWords, ...entry.keywords.flatMap((k) => k.split(" "))];
    if (parts.every((p) => words.some((w) => w.startsWith(p)))) return 7;
  }
  return Infinity;
}

/**
 * Entries matching `query` (by name and keywords, best first, then in display order), limited to
 * a category ("all", "emoji", "symbol", or a CHAR_CATEGORIES id). An empty query lists the
 * category in display order.
 * @param {string} query
 * @param {{category?: string, limit?: number}} [opts]
 * @returns {CharEntry[]}
 */
export function searchChars(query, { category = "all", limit = Infinity } = {}) {
  const inCategory = (/** @type {CharEntry} */ e) =>
    category === "all" || e.category === category || e.kind === category;
  const list = allChars().filter(inCategory);
  const q = norm(String(query ?? ""));
  if (!q) return list.slice(0, limit);
  const ranked = [];
  for (const e of list) {
    const r = matchRank(e, q);
    if (r !== Infinity) ranked.push({ e, r });
  }
  ranked.sort((a, b) => a.r - b.r || a.e.order - b.e.order);
  return ranked.slice(0, limit).map((x) => x.e);
}

/**
 * `text` moved to the front of the recent list, without duplicates, at most `max` long.
 * @param {string[]} list @param {string} text @param {number} [max]
 */
export function pushRecentChar(list, text, max = RECENT_CHARS_MAX) {
  return [text, ...list.filter((k) => k !== text)].slice(0, max);
}

/**
 * Whether an emoji is a sequence a font may draw as several glyphs when it lacks a combined one
 * (joined sequences, flags, keycaps and tag sequences); only those are checked for rendering.
 * @param {string} text
 */
export function isSequence(text) {
  return /‍|[\u{1F1E6}-\u{1F1FF}]|⃣|[\u{E0020}-\u{E007F}]/u.test(text);
}
