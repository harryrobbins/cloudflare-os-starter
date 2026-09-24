// Hybrid retrieval (plan: "Hybrid retrieval").
//
//   qualifier parse -> ACL for this caller
//     dense:   embed(query) -> Vectorize {vis:"all"} + {scope:{$in:[...]}} (fanned out under 2048 bytes)
//     lexical: FTS5 MATCH + WHERE acl + qualifiers, ORDER BY bm25() ASC, LIMIT 100 documents
//   -> RRF (k=60) at document level, best chunk per document
//   -> post-filter every candidate against SQL (live, not tombstoned, still allowed, qualifiers)
//   -> optional rerank of the top 30 -> hydrate from SQL
//
// The ACL is a WHERE clause on both halves, applied before ranking, so private content cannot leak
// through counts or paging. The one await that talks to the dense index happens *before* the
// synchronous SQL that filters, fuses and hydrates, so a membership revoked mid-query still applies.

import {
  SEARCH_LIMITS,
  SOURCE_LABELS,
  type DenseRecallHit,
  type DenseRecallRequest,
  type DenseRecallResult,
  type DenseStatus,
  type Facet,
  type FacetField,
  type OmniHit,
  type OmniSearchResult,
  type SearchCaller,
  type SearchRequest,
  type Visibility,
} from "../shared/contract.js";
import { DENSE_MIN_SCORE, DENSE_TOP_K, scopeFilters, type DenseFilter, type DenseIndex } from "../dense.js";
import { resolveAcl, type Acl } from "./acl.js";
import type { Ctx } from "./context.js";
import { consume } from "./limits.js";
import { resolveQuery, type ResolvedQuery } from "./query.js";
import { IN_LIST, MARK_CLOSE, MARK_OPEN, inputError, jsonList, markedSnippet, openingSnippet } from "./util.js";
import { logEvent } from "./log.js";

const SNIPPET_TOKENS = 16;
/** Chunk rows read from FTS5 to find the best 100 documents; several chunks can share a document. */
const LEXICAL_CHUNK_ROWS = 400;
const FACET_VALUES = 20;
const MAX_OFFSET = 10_000;
const DENSE_RECALL_DEFAULT = 50;
const DENSE_RECALL_MAX = 100;

interface Filter {
  readonly where: string;
  readonly params: readonly (string | number)[];
}

interface Candidate {
  doc: string;
  lexicalRank: number | null;
  denseRank: number | null;
  score: number;
  lexicalChunk: string | null;
  snippet: string | null;
  denseChunk: string | null;
}

interface DenseMatchRow {
  chunk: string;
  score: number;
}

type HydrateRow = {
  id: string;
  source: string;
  kind: string;
  title: string;
  url: string | null;
  scope: string;
  scope_label: string | null;
  vis: Visibility;
  workspace: string | null;
  channel: string | null;
  author: string | null;
  mime: string | null;
  created_at: number;
  updated_at: number;
  body: string;
};

export function parseCursor(cursor: unknown): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (typeof cursor !== "string" || !/^\d{1,6}$/u.test(cursor) || Number(cursor) > MAX_OFFSET) {
    throw inputError("cursor is not a valid page marker.");
  }
  return Number(cursor);
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw inputError("limit must be a positive integer.");
  }
  return Math.min(value, max);
}

function baseFilter(acl: Acl, query: ResolvedQuery): Filter {
  return {
    where: ["d.deleted_at IS NULL", acl.clause, ...query.where].join(" AND "),
    params: [...acl.params, ...query.params],
  };
}

export async function search(ctx: Ctx, caller: SearchCaller, request: SearchRequest): Promise<OmniSearchResult> {
  const started = Date.now();
  if (request === null || typeof request !== "object") throw inputError("the request must be an object.");
  const limit = parseLimit(request.limit, SEARCH_LIMITS.defaultLimit, SEARCH_LIMITS.maxLimit);
  const offset = parseCursor(request.cursor);
  const wantFacets = request.facets !== false;
  const acl = resolveAcl(ctx.sql, caller);
  if (caller.kind === "person") consume(ctx, caller.principal, "search");

  const query = resolveQuery(ctx.sql, acl, request.q ?? "");
  const dense = ctx.dense();

  // Qualifiers only: nothing to rank, so the newest matching documents win, paged in SQL.
  if (query.match.length === 0) {
    const filter = baseFilter(acl, query);
    const rows = ctx.sql
      .exec<{ id: string }>(
        `SELECT d.id FROM documents d WHERE ${filter.where} ORDER BY d.updated_at DESC, d.id LIMIT ? OFFSET ?`,
        ...filter.params,
        limit + 1,
        offset,
      )
      .toArray();
    const candidates = rows.slice(0, limit).map<Candidate>((row, i) => ({
      doc: row.id,
      lexicalRank: offset + i + 1,
      denseRank: null,
      score: 1 / (SEARCH_LIMITS.rrfK + offset + i + 1),
      lexicalChunk: null,
      snippet: null,
      denseChunk: null,
    }));
    return {
      query: query.echo,
      hits: hydrate(ctx.sql, candidates, filter),
      facets: wantFacets ? facets(ctx.sql, "", filter) : [],
      cursor: rows.length > limit ? String(offset + limit) : null,
      dense: dense === null ? "off" : "ok",
      tookMs: Date.now() - started,
    };
  }

  // The dense half first: it is the only step that awaits, so every SQL step after it is fresh.
  const denseOutcome = await denseMatches(dense, acl, query);

  const filter = baseFilter(acl, query);
  const lexical = lexicalCandidates(ctx.sql, query.match, filter);
  const denseDocs = denseCandidates(ctx.sql, denseOutcome.matches, filter);
  let fused = fuse(lexical, denseDocs);

  if (ctx.env.RERANK === "1" && dense?.rerank !== undefined && fused.length > 1) {
    fused = await rerank(ctx.sql, dense, query.text, fused);
  }

  const page = fused.slice(offset, offset + limit);
  // Hydration re-applies the whole filter: after a rerank await, a revoked scope still drops out.
  const hits = hydrate(ctx.sql, page, filter);
  const result: OmniSearchResult = {
    query: query.echo,
    hits,
    facets: wantFacets ? facets(ctx.sql, query.match, filter) : [],
    cursor: fused.length > offset + limit ? String(offset + limit) : null,
    dense: denseOutcome.status,
    tookMs: Date.now() - started,
  };
  logEvent("search.query", {
    caller: caller.kind,
    ms: result.tookMs,
    lexical: lexical.length,
    dense: denseDocs.length,
    denseStatus: denseOutcome.status,
    hits: hits.length,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Lexical
// ---------------------------------------------------------------------------

interface LexicalDoc {
  doc: string;
  chunk: string;
  snip: string;
}

function lexicalCandidates(sql: SqlStorage, match: string, filter: Filter): LexicalDoc[] {
  let rows: { chunk: string; doc: string; snip: string }[];
  try {
    rows = sql
      .exec<{ chunk: string; doc: string; score: number; snip: string }>(
        `SELECT c.id AS chunk, c.document_id AS doc, bm25(chunks_fts) AS score,
                snippet(chunks_fts, 0, ?, ?, '…', ${SNIPPET_TOKENS}) AS snip
           FROM chunks_fts
           JOIN chunks c ON c.rowid = chunks_fts.rowid
           JOIN documents d ON d.id = c.document_id
          WHERE chunks_fts MATCH ? AND ${filter.where}
          ORDER BY score ASC, d.updated_at DESC
          LIMIT ${LEXICAL_CHUNK_ROWS}`,
        MARK_OPEN,
        MARK_CLOSE,
        match,
        ...filter.params,
      )
      .toArray();
  } catch {
    // FTS5 rejects a few shapes the escaping does not anticipate; a 400 beats a 500.
    throw inputError("That search could not be run. Try simpler terms.");
  }
  const seen = new Set<string>();
  const out: LexicalDoc[] = [];
  for (const row of rows) {
    if (seen.has(row.doc)) continue;
    seen.add(row.doc);
    out.push({ doc: row.doc, chunk: row.chunk, snip: row.snip });
    if (out.length >= SEARCH_LIMITS.candidatesPerHalf) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dense
// ---------------------------------------------------------------------------

function denseFilters(acl: Acl, query: ResolvedQuery): DenseFilter[] {
  if (query.inScopes !== null) return scopeFilters(query.denseBase, query.inScopes);
  const filters: DenseFilter[] = [];
  if (acl.includeAll) filters.push({ ...query.denseBase, vis: "all" });
  if (acl.restricted.length > 0) filters.push(...scopeFilters(query.denseBase, acl.restricted));
  return filters;
}

async function denseMatches(
  dense: DenseIndex | null,
  acl: Acl,
  query: ResolvedQuery,
): Promise<{ status: DenseStatus; matches: DenseMatchRow[] }> {
  if (dense === null) return { status: "off", matches: [] };
  const filters = denseFilters(acl, query);
  if (filters.length === 0 || query.text.length === 0) return { status: "ok", matches: [] };
  try {
    return { status: "ok", matches: await queryAll(dense, query.text, filters) };
  } catch (error) {
    logEvent("search.dense_unavailable", { message: errorMessage(error) });
    return { status: "unavailable", matches: [] };
  }
}

/** Embeds once, queries every filter, merges by best score, drops unrelated neighbours. */
async function queryAll(dense: DenseIndex, text: string, filters: DenseFilter[]): Promise<DenseMatchRow[]> {
  const [vector] = await dense.embed([text]);
  if (vector === undefined) throw new Error("embedding returned no vector");
  const results = await Promise.all(filters.map((filter) => dense.query(vector, { topK: DENSE_TOP_K, filter })));
  const best = new Map<string, number>();
  for (const matches of results) {
    for (const match of matches) {
      if (match.score < DENSE_MIN_SCORE) continue;
      best.set(match.id, Math.max(best.get(match.id) ?? Number.NEGATIVE_INFINITY, match.score));
    }
  }
  return [...best]
    .map(([chunk, score]) => ({ chunk, score }))
    .sort((a, b) => b.score - a.score || a.chunk.localeCompare(b.chunk));
}

interface DenseDoc {
  doc: string;
  chunk: string;
  score: number;
}

/**
 * The post-filter for the dense half: a vector counts only if its chunk still exists, is not
 * tombstoned, and its document passes the caller's ACL and qualifiers *now*. Vectorize is eventually
 * consistent, so its own pre-filter is an optimisation, never the authority.
 */
function denseCandidates(sql: SqlStorage, matches: DenseMatchRow[], filter: Filter): DenseDoc[] {
  if (matches.length === 0) return [];
  const allowed = new Map(
    sql
      .exec<{ chunk: string; doc: string }>(
        `SELECT c.id AS chunk, c.document_id AS doc
           FROM chunks c JOIN documents d ON d.id = c.document_id
          WHERE c.id IN ${IN_LIST}
            AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.chunk_id = c.id)
            AND ${filter.where}`,
        jsonList(matches.map((match) => match.chunk)),
        ...filter.params,
      )
      .toArray()
      .map((row) => [row.chunk, row.doc]),
  );
  const seen = new Set<string>();
  const out: DenseDoc[] = [];
  for (const match of matches) {
    const doc = allowed.get(match.chunk);
    if (doc === undefined || seen.has(doc)) continue;
    seen.add(doc);
    out.push({ doc, chunk: match.chunk, score: match.score });
    if (out.length >= SEARCH_LIMITS.candidatesPerHalf) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fusion, rerank, hydration
// ---------------------------------------------------------------------------

/** Reciprocal rank fusion at document level: sum of 1 / (k + rank) over the lists a doc is in. */
export function fuse(lexical: readonly LexicalDoc[], dense: readonly DenseDoc[]): Candidate[] {
  const k = SEARCH_LIMITS.rrfK;
  const byDoc = new Map<string, Candidate>();
  lexical.forEach((hit, i) => {
    byDoc.set(hit.doc, {
      doc: hit.doc,
      lexicalRank: i + 1,
      denseRank: null,
      score: 1 / (k + i + 1),
      lexicalChunk: hit.chunk,
      snippet: hit.snip,
      denseChunk: null,
    });
  });
  dense.forEach((hit, i) => {
    const existing = byDoc.get(hit.doc);
    if (existing !== undefined) {
      existing.denseRank = i + 1;
      existing.denseChunk = hit.chunk;
      existing.score += 1 / (k + i + 1);
      return;
    }
    byDoc.set(hit.doc, {
      doc: hit.doc,
      lexicalRank: null,
      denseRank: i + 1,
      score: 1 / (k + i + 1),
      lexicalChunk: null,
      snippet: null,
      denseChunk: hit.chunk,
    });
  });
  return [...byDoc.values()].sort(
    (a, b) =>
      b.score - a.score ||
      (a.lexicalRank ?? Number.MAX_SAFE_INTEGER) - (b.lexicalRank ?? Number.MAX_SAFE_INTEGER) ||
      a.doc.localeCompare(b.doc),
  );
}

async function rerank(sql: SqlStorage, dense: DenseIndex, text: string, fused: Candidate[]): Promise<Candidate[]> {
  const top = fused.slice(0, SEARCH_LIMITS.rerankTop);
  const texts = top.map((candidate) => chunkText(sql, candidate.lexicalChunk ?? candidate.denseChunk));
  try {
    const scores = await dense.rerank!(text, texts);
    const order = top
      .map((candidate, i) => ({ candidate, score: scores[i] ?? Number.NEGATIVE_INFINITY, i }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((entry) => entry.candidate);
    return [...order, ...fused.slice(SEARCH_LIMITS.rerankTop)];
  } catch (error) {
    logEvent("search.rerank_failed", { message: errorMessage(error) });
    return fused;
  }
}

function chunkText(sql: SqlStorage, chunk: string | null): string {
  if (chunk === null) return "";
  return sql.exec<{ text: string }>(`SELECT text FROM chunks WHERE id = ?`, chunk).toArray()[0]?.text ?? "";
}

function hydrate(sql: SqlStorage, page: readonly Candidate[], filter: Filter): OmniHit[] {
  if (page.length === 0) return [];
  const rows = new Map(
    sql
      .exec<HydrateRow>(
        `SELECT d.id, d.source, d.kind, d.title, d.url, d.scope, s.label AS scope_label, d.vis, d.workspace,
                d.channel, d.author, d.mime, d.created_at, d.updated_at, substr(d.body, 1, 400) AS body
           FROM documents d LEFT JOIN scopes s ON s.scope = d.scope
          WHERE d.id IN ${IN_LIST} AND ${filter.where}`,
        jsonList(page.map((candidate) => candidate.doc)),
        ...filter.params,
      )
      .toArray()
      .map((row) => [row.id, row]),
  );
  const hits: OmniHit[] = [];
  for (const candidate of page) {
    const row = rows.get(candidate.doc);
    if (row === undefined) continue;
    let snippet: string;
    if (candidate.snippet !== null) snippet = markedSnippet(candidate.snippet);
    else if (candidate.denseChunk !== null) snippet = openingSnippet(chunkText(sql, candidate.denseChunk));
    else snippet = openingSnippet(row.body);
    hits.push({
      documentId: row.id,
      source: row.source,
      kind: row.kind,
      title: row.title,
      url: row.url,
      snippet,
      score: candidate.score,
      lexicalRank: candidate.lexicalRank,
      denseRank: candidate.denseRank,
      scope: row.scope,
      scopeLabel: row.scope_label,
      vis: row.vis,
      workspace: row.workspace,
      channel: row.channel,
      author: row.author,
      mime: row.mime,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

const FACET_EXPRESSIONS: Readonly<Record<FacetField, string>> = {
  source: "d.source",
  kind: "d.kind",
  scope: "d.scope",
  author: "d.author",
  workspace: "d.workspace",
  month: "strftime('%Y-%m', d.updated_at / 1000, 'unixepoch')",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Facet counts over the caller's lexical/qualifier match set (every matching document, not just the
 * top page), under the same ACL clause as the hits: a private document never contributes to a count
 * its reader could not see.
 */
function facets(sql: SqlStorage, match: string, filter: Filter): Facet[] {
  const matchClause =
    match.length > 0
      ? ` AND d.id IN (SELECT c.document_id FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
                         WHERE chunks_fts MATCH ?)`
      : "";
  const params = match.length > 0 ? [...filter.params, match] : [...filter.params];
  return (Object.keys(FACET_EXPRESSIONS) as FacetField[]).map((field) => {
    const expr = FACET_EXPRESSIONS[field];
    const rows = sql
      .exec<{ value: string; label: string | null; count: number }>(
        `SELECT ${expr} AS value, ${field === "scope" ? "MAX(s.label)" : "NULL"} AS label, COUNT(*) AS count
           FROM documents d ${field === "scope" ? "LEFT JOIN scopes s ON s.scope = d.scope" : ""}
          WHERE ${filter.where}${matchClause} AND ${expr} IS NOT NULL
          GROUP BY value
          ORDER BY count DESC, value
          LIMIT ${FACET_VALUES}`,
        ...params,
      )
      .toArray();
    return {
      field,
      values: rows.map((row) => ({ value: row.value, label: facetLabel(field, row.value, row.label), count: row.count })),
    };
  });
}

function facetLabel(field: FacetField, value: string, label: string | null): string {
  if (field === "source") return SOURCE_LABELS[value] ?? value;
  if (field === "scope") return label ?? value;
  if (field === "month") {
    const [year, month] = value.split("-");
    const name = MONTHS[Number(month) - 1];
    return name === undefined ? value : `${name} ${year}`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Chat's phase-1 fusion
// ---------------------------------------------------------------------------

export async function denseRecall(
  ctx: Ctx,
  caller: SearchCaller & { kind: "delegated" },
  request: DenseRecallRequest,
): Promise<DenseRecallResult> {
  if (caller?.kind !== "delegated") throw inputError("denseRecall needs a delegated caller.");
  if (request === null || typeof request !== "object") throw inputError("the request must be an object.");
  if (typeof request.text !== "string" || request.text.length > SEARCH_LIMITS.maxQueryChars) {
    throw inputError(`text must be a string of at most ${SEARCH_LIMITS.maxQueryChars} characters.`);
  }
  const limit = parseLimit(request.limit, DENSE_RECALL_DEFAULT, DENSE_RECALL_MAX);
  // The caller's scopes are the authority; SearchService builds them from the request's.
  const acl = resolveAcl(ctx.sql, caller);
  const dense = ctx.dense();
  if (dense === null) return { hits: [], dense: "off" };
  const text = request.text.trim();
  if (text.length === 0 || acl.restricted.length === 0) return { hits: [], dense: "ok" };

  let matches: DenseMatchRow[];
  try {
    matches = await queryAll(dense, text, scopeFilters({}, acl.restricted));
  } catch (error) {
    logEvent("search.dense_unavailable", { message: errorMessage(error) });
    return { hits: [], dense: "unavailable" };
  }
  const docs = denseCandidates(ctx.sql, matches, { where: `d.deleted_at IS NULL AND ${acl.clause}`, params: acl.params });
  const hits: DenseRecallHit[] = docs.slice(0, limit).map((doc, i) => ({ documentId: doc.doc, rank: i + 1, score: doc.score }));
  return { hits, dense: "ok" };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
