// Text normalization that runs before every detector. The goal is to undo the cheap tricks that
// hide data from a pattern: look-alike characters, invisible characters, digits written as
// words, digits split by separators, and base64 or hex wrapping.

const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;

// Cyrillic and Greek letters that render like Latin ones. NFKC folds full-width and
// mathematical forms already; these survive it.
const HOMOGLYPHS: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c",
  "т": "t", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ɡ": "g", "ո": "n",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C",
  "Т": "T", "Х": "X", "І": "I", "Ј": "J", "Ѕ": "S",
  "α": "a", "ο": "o", "ρ": "p", "ν": "v", "τ": "t", "ι": "i", "κ": "k",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N",
  "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", oh: "0", nought: "0", nil: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

export type Normalized = {
  /** NFKC, invisibles stripped, homoglyphs folded, whitespace collapsed. Sent to search. */
  text: string;
  /** `text` with number words turned into digits and separators between digits removed. */
  digits: string;
  /** Plain text recovered from base64 or hex runs found in `text`. */
  decoded: string[];
  /** Runs that look like base64 or hex but did not decode to readable text. */
  opaqueBlobs: string[];
};

export function normalize(input: string): Normalized {
  let text = input.normalize("NFKC").replace(INVISIBLE, "");
  text = Array.from(text, ch => HOMOGLYPHS[ch] ?? ch).join("");
  text = text.replace(/\s+/g, " ").trim();

  return { text, digits: digitView(text), ...decodeBlobs(text) };
}

/**
 * Number words become digits ("one two three" -> "1 2 3"), then separators that sit between
 * digits are removed ("12 34-56" -> "123456"). "double"/"triple" repeat the next digit.
 */
export function digitView(text: string): string {
  let words = text.toLowerCase().split(/(\s+|[-,./_])/);
  let out: string[] = [];
  let repeat = 1;
  for (let word of words) {
    if (word === "double" || word === "triple") { repeat = word === "double" ? 2 : 3; continue; }
    // The separator after "double" belongs to it.
    if (repeat > 1 && !word.trim()) continue;
    let digit = NUMBER_WORDS[word] ?? (/^\d$/.test(word) ? word : undefined);
    out.push(digit !== undefined ? digit.repeat(repeat) : word);
    repeat = 1;
  }
  let joined = out.join("");
  // Collapse separators between digits, repeatedly, so "1 - 2" also joins.
  let prev: string;
  do {
    prev = joined;
    joined = joined.replace(/(\d)[\s\-./_,]+(?=\d)/g, "$1");
  } while (joined !== prev);
  return joined;
}

const BASE64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const HEX_RUN = /\b(?:[0-9a-fA-F]{2}){8,}\b/g;

function decodeBlobs(text: string): { decoded: string[]; opaqueBlobs: string[] } {
  let decoded: string[] = [];
  let opaqueBlobs: string[] = [];
  let seen = new Set<string>();

  for (let match of text.match(HEX_RUN) ?? []) {
    seen.add(match);
    let bytes = match.match(/../g)!.map(h => parseInt(h, 16));
    let s = bytesToReadable(bytes);
    if (s) decoded.push(s); else opaqueBlobs.push(match);
  }
  for (let match of text.match(BASE64_RUN) ?? []) {
    if (seen.has(match)) continue;
    // Ordinary long words and identifiers are not blobs: require a digit or mixed case run
    // typical of encodings, and no dictionary-looking lowercase-only word.
    if (!looksEncoded(match)) continue;
    let s = tryBase64(match);
    if (s) decoded.push(s); else opaqueBlobs.push(match);
  }
  return { decoded, opaqueBlobs };
}

/**
 * Ordinary words, kebab-case package names and path segments are not encodings. An encoded
 * run mixes letter case with digits, or is long and uninterrupted by separators.
 */
export function looksEncoded(run: string): boolean {
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(run)) return false;
  if (/^[a-z]+$/.test(run) || /^[A-Z]+$/.test(run)) return false;
  let hasLower = /[a-z]/.test(run), hasUpper = /[A-Z]/.test(run), hasDigit = /\d/.test(run);
  return (hasLower && hasUpper && (hasDigit || run.length >= 24)) || (hasDigit && run.length >= 24 && (hasLower || hasUpper));
}

function tryBase64(run: string): string | null {
  let b64 = run.replace(/-/g, "+").replace(/_/g, "/");
  b64 = b64.padEnd(b64.length + ((4 - b64.length % 4) % 4), "=");
  try {
    let bin = atob(b64);
    return bytesToReadable(Array.from(bin, c => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Returns the bytes as text if they are overwhelmingly printable UTF-8, else null. */
function bytesToReadable(bytes: number[]): string | null {
  if (bytes.length < 6) return null;
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
  let printable = Array.from(s).filter(c => /[\p{L}\p{N}\p{P}\p{Zs}]/u.test(c)).length;
  return printable / Array.from(s).length >= 0.9 ? s : null;
}
