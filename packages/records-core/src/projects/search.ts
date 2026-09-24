// Issue search: compiles an IssueQuery (@records/contracts, issue-query.ts) to one parameterised
// SQL statement, with keyset pagination over the query's own ordering.
//
// Guarantees:
// - Nothing from the query reaches SQL except as a bound parameter. Fields, operators and sort keys
//   come from a closed set and select fixed SQL fragments; values are bound (arrays included).
// - The results agree with the reference semantics, `evaluateIssueQuery` and `compareIssues`:
//   * every predicate compiles to a two-valued expression (never NULL), so NOT behaves as in JS;
//   * an empty `in []` is FALSE and `not_in []` is TRUE (no empty `IN ()`);
//   * instants compare and sort at millisecond precision in UTC, the precision of the DTOs, so two
//     issues created within one millisecond tie and fall to the ID tiebreaker as they do in memory;
//   * project keys sort bytewise (COLLATE "C"), as JS compares strings; the ID tiebreaker is always
//     ascending.
//   Text containment (`~`) lower-cases the needle's words in JS and matches each with ILIKE, so it
//   agrees with the reference for ASCII text; case folding of other scripts follows the database's
//   ctype rather than JS's toLowerCase.
// - Pages are bounded (1..LIMITS.pageSizeMax) and cursors are opaque, bound to the exact query
//   (a digest of its canonical JSON), and refused on any other.
// - The read runs in the caller's trusted context (RLS by principal) after authorize('listIssues').

import type { PendingQuery, Row as PgRow } from "postgres";

import {
  canonicalJson,
  IssueQuerySchema,
  LIMITS,
  PageSizeSchema,
  parseInput,
  RecordsError,
  type CallerContext,
  type Issue,
  type IssueOrder,
  type IssuePredicate,
  type IssueQuery,
  type IssueQueryNode,
  type Page,
  type Priority,
} from "@records/contracts";

import { contextOf, withContext, type Db, type Tx } from "../db/context.js";
import { authorize } from "../domain/authorize.js";
import { likePattern } from "../domain/cursor.js";
import { issueSelect, toJiraIssue } from "./rows.js";

type Fragment = PendingQuery<PgRow[]>;

/** An issue with its numeric Jira id (canonical plan §7), for the Jira surface. */
export type SearchedIssue = Issue & { jiraId: number };

export type IssueSearchPage = {
  /** 1..LIMITS.pageSizeMax; default LIMITS.pageSizeDefault. */
  limit?: number;
  /** `nextCursor` from the previous page of the same query. */
  cursor?: string | null;
};

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const PRIORITY_RANK: Record<Priority, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 };

/** The reference's word split (issue-query.ts `words`). */
function words(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Instants as the DTOs carry them: milliseconds, UTC. The expression is indexed (migration 0006). */
const createdExpr = (tx: Tx): Fragment => tx`date_trunc('milliseconds', i.created_at AT TIME ZONE 'UTC')`;
const updatedExpr = (tx: Tx): Fragment => tx`date_trunc('milliseconds', i.updated_at AT TIME ZONE 'UTC')`;
const instant = (tx: Tx, iso: string): Fragment => tx`(${new Date(Date.parse(iso))}::timestamptz AT TIME ZONE 'UTC')`;

function join(tx: Tx, parts: Fragment[], conj: "AND" | "OR"): Fragment {
  if (parts.length === 0) return conj === "AND" ? tx`TRUE` : tx`FALSE`;
  const body = parts.slice(1).reduce((acc, p) => (conj === "AND" ? tx`${acc} AND ${p}` : tx`${acc} OR ${p}`), parts[0]!);
  return tx`(${body})`;
}

const andAll = (tx: Tx, parts: Fragment[]) => join(tx, parts, "AND");
const orAll = (tx: Tx, parts: Fragment[]) => join(tx, parts, "OR");
const not = (tx: Tx, f: Fragment): Fragment => tx`(NOT ${f})`;

const positive = (op: string) => op === "=" || op === "in";

function compare(tx: Tx, left: Fragment, op: "=" | "!=" | "<" | "<=" | ">" | ">=", right: Fragment): Fragment {
  switch (op) {
    case "=": return tx`(${left} = ${right})`;
    case "!=": return tx`(${left} <> ${right})`;
    case "<": return tx`(${left} < ${right})`;
    case "<=": return tx`(${left} <= ${right})`;
    case ">": return tx`(${left} > ${right})`;
    case ">=": return tx`(${left} >= ${right})`;
  }
}

function predicate(tx: Tx, p: IssuePredicate): Fragment {
  switch (p.field) {
    case "project": {
      // The reference matches a value against the issue's project ID (a lower-case UUID string)
      // or its project key; anything else can never match.
      const ids = p.values.filter((v) => LOWER_UUID.test(v));
      const keys = p.values.filter((v) => PROJECT_KEY.test(v));
      const parts: Fragment[] = [];
      if (ids.length) parts.push(tx`i.project_id = ANY(${ids}::uuid[])`);
      if (keys.length) parts.push(tx`p.key = ANY(${keys}::text[])`);
      const matches = orAll(tx, parts);
      return positive(p.op) ? matches : not(tx, matches);
    }
    case "key": {
      const matches = p.values.length ? tx`((p.key || '-' || i.number::text) = ANY(${[...p.values]}::text[]))` : tx`FALSE`;
      return positive(p.op) ? matches : not(tx, matches);
    }
    case "status": {
      const matches = p.values.length ? tx`(i.state = ANY(${[...p.values]}::text[]))` : tx`FALSE`;
      return positive(p.op) ? matches : not(tx, matches);
    }
    case "statusCategory": {
      const matches = p.values.length
        ? tx`EXISTS (SELECT 1 FROM projects.workflow_states ws
                      WHERE ws.datastore_id = i.datastore_id AND ws.key = i.state AND ws.category = ANY(${[...p.values]}::text[]))`
        : tx`FALSE`;
      return positive(p.op) ? matches : not(tx, matches);
    }
    case "assignee": {
      if (p.op === "is_empty") return tx`(i.assignee_id IS NULL)`;
      if (p.op === "is_not_empty") return tx`(i.assignee_id IS NOT NULL)`;
      // Principal IDs are lower-case; an upper-case value never equals one in the reference.
      const ids = p.values.filter((v) => LOWER_UUID.test(v));
      const anyOf = ids.length ? tx`(i.assignee_id = ANY(${ids}::uuid[]))` : tx`FALSE`;
      // Jira semantics: unassigned issues match neither `=` nor `!=`.
      return tx`(i.assignee_id IS NOT NULL AND ${positive(p.op) ? anyOf : not(tx, anyOf)})`;
    }
    case "priority": {
      if (p.op === "is_empty") return tx`(i.priority = 'none')`;
      if (p.op === "is_not_empty") return tx`(i.priority <> 'none')`;
      const anyOf = p.values.length ? tx`(i.priority = ANY(${[...p.values]}::text[]))` : tx`FALSE`;
      if (positive(p.op)) return anyOf;
      // `!=`/`not_in` does not match the empty priority unless `none` is itself excluded.
      return p.values.includes("none") ? not(tx, anyOf) : tx`(i.priority <> 'none' AND ${not(tx, anyOf)})`;
    }
    case "created":
    case "updated":
      return compare(tx, p.field === "created" ? createdExpr(tx) : updatedExpr(tx), p.op, instant(tx, p.value));
    case "text": {
      const ws = words(p.value);
      const columns = p.in === "title" ? [tx`i.title`] : p.in === "description" ? [tx`i.description`] : [tx`i.title`, tx`i.description`];
      // Every word must occur (in any of the columns). No words: nothing is contained.
      const found = ws.length
        ? andAll(tx, ws.map((w) => orAll(tx, columns.map((c) => tx`(${c} ILIKE ${likePattern(w)})`))))
        : tx`FALSE`;
      return p.op === "~" ? found : not(tx, found);
    }
  }
}

function compile(tx: Tx, node: IssueQueryNode | null): Fragment {
  if (!node) return tx`TRUE`;
  switch (node.type) {
    case "pred":
      return predicate(tx, node);
    case "and":
      return andAll(tx, node.clauses.map((c) => compile(tx, c)));
    case "or":
      return orAll(tx, node.clauses.map((c) => compile(tx, c)));
    case "not":
      return not(tx, compile(tx, node.clause));
  }
}

// ---------------------------------------------------------------------------------------------
// Ordering and keyset pagination

type Kind = "ts" | "int" | "text" | "uuid";
type SortColumn = { expr: Fragment; asc: boolean; kind: Kind; value(issue: Issue): string | number };

function projectKeyOf(issue: Issue): string {
  return issue.key.slice(0, issue.key.lastIndexOf("-"));
}

function sortColumns(tx: Tx, orderBy: IssueOrder): SortColumn[] {
  const keys: IssueOrder = orderBy.length > 0 ? orderBy : [{ field: "created", direction: "desc" }];
  const cols: SortColumn[] = [];
  for (const { field, direction } of keys) {
    const asc = direction === "asc";
    switch (field) {
      case "created":
        cols.push({ expr: createdExpr(tx), asc, kind: "ts", value: (i) => i.createdAt });
        break;
      case "updated":
        cols.push({ expr: updatedExpr(tx), asc, kind: "ts", value: (i) => i.updatedAt });
        break;
      case "priority":
        cols.push({
          expr: tx`(CASE i.priority WHEN 'none' THEN 0 WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 ELSE 4 END)`,
          asc, kind: "int", value: (i) => PRIORITY_RANK[i.priority],
        });
        break;
      case "key":
        cols.push({ expr: tx`(p.key COLLATE "C")`, asc, kind: "text", value: projectKeyOf });
        cols.push({ expr: tx`i.number`, asc, kind: "int", value: (i) => i.number });
        break;
    }
  }
  cols.push({ expr: tx`i.id`, asc: true, kind: "uuid", value: (i) => i.id });
  return cols;
}

function bound(tx: Tx, kind: Kind, v: string | number): Fragment {
  switch (kind) {
    case "ts": return instant(tx, v as string);
    case "int": return tx`${v as number}::int`;
    case "text": return tx`(${v as string}::text COLLATE "C")`;
    case "uuid": return tx`${v as string}::uuid`;
  }
}

/** Rows strictly after `values` in the order of `cols`. */
function after(tx: Tx, cols: SortColumn[], values: (string | number)[]): Fragment {
  if (cols.every((c) => c.asc === cols[0]!.asc)) {
    // One direction throughout: a row comparison, which an index on the same columns can walk.
    const left = cols.slice(1).reduce((acc, c) => tx`${acc}, ${c.expr}`, tx`${cols[0]!.expr}`);
    const right = cols.slice(1).reduce((acc, c, i) => tx`${acc}, ${bound(tx, c.kind, values[i + 1]!)}`, bound(tx, cols[0]!.kind, values[0]!));
    return cols[0]!.asc ? tx`((${left}) > (${right}))` : tx`((${left}) < (${right}))`;
  }
  // Mixed directions: OR over j of (equal on every column before j, and past on column j).
  const branches = cols.map((c, j) => {
    const equal = cols.slice(0, j).map((e, i) => tx`(${e.expr} = ${bound(tx, e.kind, values[i]!)})`);
    const past = c.asc ? tx`(${c.expr} > ${bound(tx, c.kind, values[j]!)})` : tx`(${c.expr} < ${bound(tx, c.kind, values[j]!)})`;
    return andAll(tx, [...equal, past]);
  });
  return orAll(tx, branches);
}

function orderClause(tx: Tx, cols: SortColumn[]): Fragment {
  const item = (c: SortColumn) => (c.asc ? tx`${c.expr} ASC` : tx`${c.expr} DESC`);
  return cols.slice(1).reduce((acc, c) => tx`${acc}, ${item(c)}`, item(cols[0]!));
}

// Cursors: base64url JSON { v: 1, q: <query digest>, k: [sort values…] }.

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

async function queryDigest(query: IssueQuery): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(query)));
  return [...new Uint8Array(bytes)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function validValue(kind: Kind, v: unknown): boolean {
  switch (kind) {
    case "ts": return typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
    case "int": return typeof v === "number" && Number.isInteger(v) && Math.abs(v) < 2 ** 31;
    case "text": return typeof v === "string" && PROJECT_KEY.test(v);
    case "uuid": return typeof v === "string" && LOWER_UUID.test(v);
  }
}

function decodeSearchCursor(cursor: string, digest: string, cols: SortColumn[]): (string | number)[] {
  const invalid = () => new RecordsError("validation_failed", "The cursor is not valid for this query.");
  if (cursor.length > 1024) throw invalid();
  let parsed: { v?: unknown; q?: unknown; k?: unknown };
  try {
    parsed = JSON.parse(unb64url(cursor)) as typeof parsed;
  } catch {
    throw invalid();
  }
  if (parsed.v !== 1 || parsed.q !== digest || !Array.isArray(parsed.k) || parsed.k.length !== cols.length) throw invalid();
  const values = parsed.k as unknown[];
  if (!cols.every((c, i) => validValue(c.kind, values[i]))) throw invalid();
  return values as (string | number)[];
}

// ---------------------------------------------------------------------------------------------

/**
 * Search the datastore's issues. `rawQuery` is validated against IssueQuerySchema (bounds
 * included); needs the listIssues permission. Project predicates accept project IDs or keys.
 */
export async function searchIssues(
  db: Db,
  caller: CallerContext,
  datastoreId: string,
  rawQuery: unknown,
  page: IssueSearchPage = {},
): Promise<Page<SearchedIssue>> {
  const query = parseInput(IssueQuerySchema, rawQuery) as IssueQuery;
  const limit = parseInput(PageSizeSchema, page.limit ?? LIMITS.pageSizeDefault);
  const digest = await queryDigest(query);
  return withContext(db, contextOf(caller, datastoreId), async (tx) => {
    await authorize(tx, caller, datastoreId, "listIssues");
    const cols = sortColumns(tx, query.orderBy);
    const start = page.cursor ? after(tx, cols, decodeSearchCursor(page.cursor, digest, cols)) : tx`TRUE`;
    const rows = await tx`${issueSelect(tx, datastoreId)} AND ${compile(tx, query.where)} AND ${start}
      ORDER BY ${orderClause(tx, cols)} LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit).map(toJiraIssue);
    const last = items.at(-1);
    const nextCursor = rows.length > limit && last ? b64url(JSON.stringify({ v: 1, q: digest, k: cols.map((c) => c.value(last)) })) : null;
    return { items, nextCursor };
  });
}
