// Turns the parsed grammar (src/shared/query.ts) into SQL conditions and a Vectorize base filter for
// one caller. Qualifiers are always bound parameters; free text is always the escaped MATCH string.

import type { OmniQuery, Scope } from "../shared/contract.js";
import { ftsMatchString, parseQuery, plainText } from "../shared/query.js";
import { valuesClause, type DenseFilter } from "../dense.js";
import { scopeVisible, type Acl } from "./acl.js";
import { IN_LIST, inputError, jsonList } from "./util.js";

/** Author ids a `from:` may expand to in the dense filter; more is left to the SQL post-filter. */
const MAX_DENSE_AUTHORS = 50;

export interface ResolvedQuery {
  /** Echoed back so the UI shows what the server actually searched for. */
  readonly echo: OmniQuery;
  /** The FTS5 MATCH string; empty for a qualifiers-only query. */
  readonly match: string;
  /** What the dense half embeds. */
  readonly text: string;
  /** Conditions over `documents d`, excluding the ACL. */
  readonly where: readonly string[];
  readonly params: readonly (string | number)[];
  /** `in:` restricted the scopes: the dense half queries exactly these, never `{vis: "all"}`. */
  readonly inScopes: readonly Scope[] | null;
  /** Qualifier clauses the dense half can express (source, kind, author). */
  readonly denseBase: DenseFilter;
}

export function resolveQuery(sql: SqlStorage, acl: Acl, raw: string): ResolvedQuery {
  if (typeof raw !== "string") throw inputError("q must be a string.");
  const parsed = parseQuery(raw);
  if (!parsed.ok) throw inputError(parsed.message);
  const query = parsed.value;

  const where: string[] = [];
  const params: (string | number)[] = [];
  const denseBase: DenseFilter = {};
  const echo: OmniQuery = { text: plainText(query.terms) };

  let inScopes: Scope[] | null = null;
  if (query.in.length > 0) {
    const resolved = new Set<Scope>();
    for (const value of query.in) {
      const candidates = value.includes(":") && !value.startsWith("#") ? [value] : scopesByLabel(sql, value);
      const visible = candidates.filter((scope) => scopeVisible(sql, acl, scope));
      // An invisible scope is reported exactly like an unknown one, so `in:` cannot probe for it.
      if (visible.length === 0) throw inputError(`No scope called ${value}.`);
      for (const scope of visible) resolved.add(scope);
    }
    inScopes = [...resolved];
    where.push(`d.scope IN ${IN_LIST}`);
    params.push(jsonList(inScopes));
    echo.in = inScopes;
  }

  if (query.from.length > 0) {
    const ids: string[] = [];
    const names: string[] = [];
    for (const value of query.from) {
      const wanted = value.replace(/^@/u, "");
      if (wanted.toLowerCase() === "me") {
        if (acl.caller.kind !== "person") throw inputError("from:me needs a signed-in person.");
        ids.push(acl.caller.principal);
      } else {
        ids.push(wanted);
        names.push(wanted.toLowerCase());
      }
    }
    where.push(`(d.author_id IN ${IN_LIST} OR lower(d.author) IN ${IN_LIST})`);
    params.push(jsonList(ids), jsonList(names));
    echo.from = query.from;

    const authorIds = sql
      .exec<{ author_id: string }>(
        `SELECT DISTINCT author_id FROM documents
          WHERE author_id IS NOT NULL AND (author_id IN ${IN_LIST} OR lower(author) IN ${IN_LIST})
          LIMIT ?`,
        jsonList(ids),
        jsonList(names),
        MAX_DENSE_AUTHORS + 1,
      )
      .toArray()
      .map((row) => row.author_id);
    if (authorIds.length > 0 && authorIds.length <= MAX_DENSE_AUTHORS) denseBase.author = valuesClause(authorIds);
  }

  for (const field of ["source", "kind", "workspace"] as const) {
    const values = query[field];
    if (values.length === 0) continue;
    where.push(`d.${field} IN ${IN_LIST}`);
    params.push(jsonList(values));
    echo[field] = values;
    // workspace is not a vector metadata index; the post-filter applies it.
    if (field !== "workspace") denseBase[field] = valuesClause(values);
  }

  if (query.after !== undefined) {
    where.push(`d.updated_at >= ?`);
    params.push(query.after);
    echo.after = query.after;
  }
  if (query.before !== undefined) {
    where.push(`d.updated_at <= ?`);
    params.push(query.before);
    echo.before = query.before;
  }

  return {
    echo,
    match: ftsMatchString(query.terms),
    text: echo.text.replaceAll('"', "").replaceAll("*", "").trim(),
    where,
    params,
    inScopes,
    denseBase,
  };
}

function scopesByLabel(sql: SqlStorage, value: string): Scope[] {
  const name = value.replace(/^#/u, "").toLowerCase();
  return sql
    .exec<{ scope: string }>(
      `SELECT scope FROM scopes WHERE lower(label) = ? OR lower(label) = ?`,
      name,
      `#${name}`,
    )
    .toArray()
    .map((row) => row.scope);
}
