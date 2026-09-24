// The omni-search query grammar: tokenizer, qualifier parser and the safe FTS5 MATCH string.
//
// Copied from packages/gatekeeper-chat/src/do/search.ts, not shared (plan: "Query language"), and
// extended with `source:`, `kind:` and `workspace:`. Pure: no SQL, no `cloudflare:*`, so the SPA can
// use it to preview chips. Resolving `in:` labels and `from:` names against the index is the
// Durable Object's job (src/do/query.ts).

import { SEARCH_LIMITS } from "./contract.js";

export const QUALIFIER_KEYS = ["in", "from", "source", "kind", "workspace", "before", "after", "on"] as const;
export type QualifierKey = (typeof QUALIFIER_KEYS)[number];

/** The query as typed, before any lookup. Dates are already resolved to inclusive epoch-ms bounds. */
export interface ParsedQuery {
  /** Free-text tokens, quoted phrases kept whole (quotes included). */
  terms: string[];
  in: string[];
  from: string[];
  source: string[];
  kind: string[];
  workspace: string[];
  before?: number;
  after?: number;
}

export type ParseOutcome = { ok: true; value: ParsedQuery } | { ok: false; message: string };

const QUALIFIER = /^(in|from|source|kind|workspace|before|after|on):(.*)$/u;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Splits on whitespace, keeping a `"quoted phrase"` in one token. */
export function tokenize(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of raw) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (!quoted && /\s/u.test(char)) {
      if (current.length > 0) out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Strict `YYYY-MM-DD` to the start of that day, UTC. */
export function parseDay(value: string): number | null {
  const match = ISO_DAY.exec(value);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const at = Date.UTC(year, month - 1, day);
  const back = new Date(at);
  // Rejects 2026-02-31, which Date.UTC would roll forward into March.
  if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return at;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value.replaceAll('"', "");
}

/** Parses the grammar. Does not look anything up. */
export function parseQuery(raw: string): ParseOutcome {
  if (raw.length > SEARCH_LIMITS.maxQueryChars) {
    return { ok: false, message: `A search is at most ${SEARCH_LIMITS.maxQueryChars} characters.` };
  }
  const parsed: ParsedQuery = { terms: [], in: [], from: [], source: [], kind: [], workspace: [] };

  for (const token of tokenize(raw)) {
    const match = QUALIFIER.exec(token);
    if (match === null) {
      parsed.terms.push(token);
      continue;
    }
    const key = match[1] as QualifierKey;
    const value = unquote(match[2]!).trim();
    if (value.length === 0) return { ok: false, message: `${key}: needs a value.` };

    switch (key) {
      case "in":
      case "from":
      case "kind":
      case "workspace":
        pushUnique(parsed[key], value);
        break;
      case "source":
        pushUnique(parsed.source, value.toLowerCase());
        break;
      default: {
        const day = parseDay(value);
        if (day === null) return { ok: false, message: `${key}: needs a date like 2026-09-01.` };
        if (key === "before") parsed.before = min(parsed.before, day - 1);
        else if (key === "after") parsed.after = max(parsed.after, day + DAY_MS);
        else {
          parsed.after = max(parsed.after, day);
          parsed.before = min(parsed.before, day + DAY_MS - 1);
        }
      }
    }
  }

  if (parsed.terms.length > SEARCH_LIMITS.maxTerms) {
    return { ok: false, message: `At most ${SEARCH_LIMITS.maxTerms} search terms.` };
  }
  return { ok: true, value: parsed };
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function min(a: number | undefined, b: number): number {
  return a === undefined ? b : Math.min(a, b);
}

function max(a: number | undefined, b: number): number {
  return a === undefined ? b : Math.max(a, b);
}

/**
 * A safe FTS5 MATCH string: every term is a quoted phrase with its inner `"` removed, and a trailing
 * `*` is kept as a prefix query. A term with no letter or digit is dropped rather than handed to the
 * FTS5 expression parser, so `AND`, `NEAR(`, `-`, `^` and friends are only ever literal text.
 */
export function ftsMatchString(terms: readonly string[]): string {
  const parts: string[] = [];
  for (const token of terms) {
    const prefix = token.endsWith("*");
    const core = (prefix ? token.slice(0, -1) : token).replaceAll('"', "").replaceAll("*", "").trim();
    if (!/[\p{L}\p{N}]/u.test(core)) continue;
    parts.push(`"${core}"${prefix ? "*" : ""}`);
  }
  return parts.join(" ");
}

/** The free text a person would recognise: terms joined, used for embedding and the echoed query. */
export function plainText(terms: readonly string[]): string {
  return terms.join(" ").trim();
}
