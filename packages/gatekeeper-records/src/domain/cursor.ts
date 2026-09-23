// Opaque keyset cursors. A cursor names the query shape it belongs to and is rejected elsewhere.

import { RecordsError } from "@records/contracts";

export function encodeCursor(shape: string, key: (string | number)[]): string {
  return btoa(JSON.stringify({ s: shape, k: key })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function decodeCursor(shape: string, cursor: string | undefined): (string | number)[] | null {
  if (!cursor) return null;
  try {
    const json = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
    const parsed = JSON.parse(json) as { s?: unknown; k?: unknown };
    if (parsed.s === shape && Array.isArray(parsed.k) && parsed.k.length <= 3 &&
        parsed.k.every((v) => typeof v === "string" || typeof v === "number")) {
      return parsed.k as (string | number)[];
    }
  } catch {
    // fall through
  }
  throw new RecordsError("validation_failed", "The cursor is not valid for this query.");
}

/** Escape LIKE metacharacters so a search term matches literally. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
