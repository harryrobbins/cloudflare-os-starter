// Query-string manipulation for the omni box: turning the server's parsed `OmniQuery` into chips,
// removing a chip from the raw `q`, and adding a facet value as a qualifier.
//
// The server owns the grammar (src/shared/query.ts on the Worker side); this module only edits the
// raw string. Chips come from `result.query` — what the server actually searched — never from the
// client's own reading of `q`, so the UI cannot claim a filter the server ignored.

import type { FacetField, OmniQuery } from "../contract.js";

const DAY_MS = 86_400_000;

export type ChipKey = "in" | "from" | "source" | "kind" | "workspace" | "before" | "after" | "on";

export interface Chip {
  /** Stable React key. */
  id: string;
  key: ChipKey;
  /** What the chip shows after `key:`. */
  label: string;
  /** Raw-token values that this chip stands for, compared case-insensitively without quotes, `#`, `@`. */
  matches: string[];
}

/** Splits on whitespace, keeping a `"quoted phrase"` (or `key:"quoted value"`) in one token. */
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

const QUALIFIER = /^([a-z]+):(.+)$/iu;

/** `key:value` split, or null for a free-text token. Keys are lower-cased. */
export function splitQualifier(token: string): { key: string; value: string } | null {
  const match = QUALIFIER.exec(token);
  if (match === null) return null;
  return { key: match[1]!.toLowerCase(), value: match[2]! };
}

function normalise(value: string): string {
  return value.replace(/^"(.*)"$/su, "$1").replace(/^[#@]/u, "").trim().toLowerCase();
}

/** Formats epoch ms as a UTC `YYYY-MM-DD`. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Chips for a parsed query. `scopeLabels` maps scope ids to their labels (from the scope facet and
 * the hits), so `in:chat:C1` reads as `in: #general`.
 *
 * Date bounds follow chat's grammar, which the omni grammar copies: `before:D` is `D - 1ms`,
 * `after:D` is `D + 1 day` and `on:D` is `[D, D + 1 day - 1ms]`. The chips show the day the user
 * typed, not the raw bound.
 */
export function chipsFromQuery(query: OmniQuery, scopeLabels: ReadonlyMap<string, string> = new Map()): Chip[] {
  const chips: Chip[] = [];
  for (const scope of query.in ?? []) {
    const label = scopeLabels.get(scope);
    chips.push({
      id: `in:${scope}`,
      key: "in",
      label: label ?? scope,
      matches: [scope, ...(label === undefined ? [] : [label])],
    });
  }
  const simple: ["from" | "source" | "kind" | "workspace", string[] | undefined][] = [
    ["from", query.from],
    ["source", query.source],
    ["kind", query.kind],
    ["workspace", query.workspace],
  ];
  for (const [key, values] of simple) {
    for (const value of values ?? []) {
      chips.push({ id: `${key}:${value}`, key, label: value, matches: [value] });
    }
  }

  const { before, after } = query;
  if (before !== undefined && after !== undefined && before - after === DAY_MS - 1 && after % DAY_MS === 0) {
    const day = isoDay(after);
    chips.push({ id: `on:${day}`, key: "on", label: day, matches: [day] });
  } else {
    if (after !== undefined) {
      // `after:D` arrives as D + 1 day; anything that is not on a day boundary is shown as is.
      const day = after % DAY_MS === 0 ? isoDay(after - DAY_MS) : isoDay(after);
      chips.push({ id: `after:${day}`, key: "after", label: day, matches: [day] });
    }
    if (before !== undefined) {
      const day = (before + 1) % DAY_MS === 0 ? isoDay(before + 1) : isoDay(before);
      chips.push({ id: `before:${day}`, key: "before", label: day, matches: [day] });
    }
  }
  return chips;
}

/** Raw token keys a chip may have come from. `on:` sets both bounds, so it can back either chip. */
function tokenKeysFor(key: ChipKey): string[] {
  switch (key) {
    case "before":
      return ["before", "on"];
    case "after":
      return ["after", "on"];
    case "on":
      return ["on", "before", "after"];
    default:
      return [key];
  }
}

/**
 * Removes the tokens behind one chip from `q`.
 *
 * A token is removed when its key can produce the chip and its value matches one of the chip's
 * values. The server may have resolved what was typed (`in:#General` became `chat:C1`), so when no
 * token matches by value every token with the chip's own key goes instead: removing too much is
 * visible and easy to undo, while silently removing nothing looks broken.
 */
export function removeChip(q: string, chip: Chip): string {
  const tokens = tokenize(q);
  const keys = tokenKeysFor(chip.key);
  const wanted = new Set(chip.matches.map(normalise));
  const matches = (token: string): boolean => {
    const split = splitQualifier(token);
    return split !== null && keys.includes(split.key) && wanted.has(normalise(split.value));
  };
  let kept = tokens.filter((token) => !matches(token));
  if (kept.length === tokens.length) {
    kept = tokens.filter((token) => splitQualifier(token)?.key !== chip.key);
  }
  return kept.join(" ");
}

/** Quotes a qualifier value that contains whitespace or a quote. */
export function qualifierToken(key: string, value: string): string {
  if (/[\s"]/u.test(value)) return `${key}:"${value.replace(/"/gu, "")}"`;
  return `${key}:${value}`;
}

/** Appends `key:value` unless an equivalent token is already present. */
export function addQualifier(q: string, key: string, value: string): string {
  const tokens = tokenize(q);
  const target = normalise(value);
  const present = tokens.some((token) => {
    const split = splitQualifier(token);
    return split !== null && split.key === key && normalise(split.value) === target;
  });
  if (present) return tokens.join(" ");
  return [...tokens, qualifierToken(key, value)].join(" ");
}

/** Removes every `key:value` token equivalent to the given value. */
export function removeQualifier(q: string, key: string, value: string): string {
  const target = normalise(value);
  return tokenize(q)
    .filter((token) => {
      const split = splitQualifier(token);
      return !(split !== null && split.key === key && normalise(split.value) === target);
    })
    .join(" ");
}

/** The last day of a `YYYY-MM` month's predecessor and the first day of its successor. */
export function monthBounds(month: string): { after: string; before: string } | null {
  const match = /^(\d{4})-(\d{2})$/u.exec(month);
  if (match === null) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  if (index < 0 || index > 11) return null;
  return {
    after: isoDay(Date.UTC(year, index, 1) - DAY_MS),
    before: isoDay(Date.UTC(year, index + 1, 1)),
  };
}

/** The qualifier(s) a facet value stands for. `month` becomes an `after:`/`before:` pair. */
export function facetTokens(field: FacetField, value: string): { key: string; value: string }[] {
  switch (field) {
    case "source":
    case "kind":
    case "workspace":
      return [{ key: field, value }];
    case "scope":
      return [{ key: "in", value }];
    case "author":
      return [{ key: "from", value }];
    case "month": {
      const bounds = monthBounds(value);
      if (bounds === null) return [];
      return [
        { key: "after", value: bounds.after },
        { key: "before", value: bounds.before },
      ];
    }
  }
}

/** Is this facet value already a filter in the parsed query? */
export function facetActive(field: FacetField, value: string, query: OmniQuery | undefined): boolean {
  if (query === undefined) return false;
  const lower = value.toLowerCase();
  const has = (list: string[] | undefined): boolean => (list ?? []).some((item) => item.toLowerCase() === lower);
  switch (field) {
    case "source":
      return has(query.source);
    case "kind":
      return has(query.kind);
    case "workspace":
      return has(query.workspace);
    case "scope":
      return has(query.in);
    case "author":
      return has(query.from);
    case "month": {
      const bounds = monthBounds(value);
      if (bounds === null || query.after === undefined || query.before === undefined) return false;
      return (
        isoDay(query.after - DAY_MS) === bounds.after && isoDay(query.before + 1) === bounds.before
      );
    }
  }
}

/** Toggles a facet value in `q`: adds its qualifier(s), or removes them when already active. */
export function toggleFacet(q: string, field: FacetField, value: string, query: OmniQuery | undefined): string {
  const tokens = facetTokens(field, value);
  if (facetActive(field, value, query)) {
    let next = q;
    for (const token of tokens) next = removeQualifier(next, token.key, token.value);
    // The server may have resolved the typed value (a label for a scope id); fall back to the key.
    if (next === tokenize(q).join(" ") && tokens.length === 1) {
      next = tokenize(q)
        .filter((token) => splitQualifier(token)?.key !== tokens[0]!.key)
        .join(" ");
    }
    return next;
  }
  let next = q;
  if (field === "month") {
    // One month at a time: drop any existing date bounds first.
    next = tokenize(next)
      .filter((token) => !["before", "after", "on"].includes(splitQualifier(token)?.key ?? ""))
      .join(" ");
  }
  for (const token of tokens) next = addQualifier(next, token.key, token.value);
  return next;
}
