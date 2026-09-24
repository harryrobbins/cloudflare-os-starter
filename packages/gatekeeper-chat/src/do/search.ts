// Search: the qualifier parser, the FTS5 query, and the membership filter that runs before ranking.
//
// Two rules from the plan drive the shape:
//
//   * Qualifiers become bound SQL parameters, and the free text becomes an escaped FTS5 MATCH string.
//     Neither is ever interpolated. Malformed input is a 400 with a message a person can act on, not
//     a 500 from SQLite's expression parser.
//   * Membership is a `WHERE` clause, so it is applied before `ORDER BY`. Filtering after ranking
//     would leak the existence of private messages through result counts and paging.
//
// `bm25()` is negative and lower is better (spikes/README.md), so the order is `score ASC`.
//
// Omni-search fusion (docs/plans/omni-search.md, decision 5). When the SEARCH binding exists and the
// query has free text, the search Worker's `denseRecall()` runs alongside the FTS5 query, over exactly
// the channels the lexical half may search (after `in:`), and the two rank lists are fused with
// reciprocal rank fusion (k = 60) at message level. Chat's ACL stays authoritative: a dense hit is
// kept only if its message row passes the same WHERE clause the lexical query uses -- visible channel,
// not deleted, and every qualifier. Anything but a timely "ok" from search, and a qualifier-only query,
// is lexical only, exactly as without the binding.

import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type Message,
  type SearchHasFilter,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
  type Timestamp,
  type UserId,
} from "../shared/protocol.js";
import { chatScope, messageIdOfDocument, SEARCH_LIMITS, withTimeout, type DenseRecallHit } from "../search-client.js";
import { visibleChannelIds } from "./access.js";
import { matchChannels } from "./channels.js";
import { allow, placeholders, refuse, type Ctx, type Outcome } from "./context.js";
import { consume } from "./limits.js";
import { hashId, logEvent } from "./logs.js";
import { hydrateMessages, loadMessage, parseOffset } from "./messages.js";
import type { MessageRow, UserRow } from "./rows.js";
import { escapeLike, loadUsers, matchUsers } from "./users.js";

const MAX_QUERY_LENGTH = 512;
const MAX_TERMS = 16;
const SNIPPET_TOKENS = 12;
const TOP_SECTION_LIMIT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a search waits for dense recall before answering lexical only. */
export const DENSE_TIMEOUT_MS = 1_500;
/** Lexical candidates fused with the dense list; results past them follow in lexical order. */
const FUSION_CANDIDATES = SEARCH_LIMITS.candidatesPerHalf;
/** Characters of a dense-only hit's plain snippet. */
const PLAIN_SNIPPET_CHARS = 160;

type SearchRow = MessageRow & { score: number; snip: string };

/**
 * Runs a search for one caller.
 *
 * Dates are resolved in UTC. TODO: resolve them in `users.tz` instead, which needs an offset lookup
 * per query; UTC is predictable and wrong by at most a day at the boundary, and the qualifiers the
 * server interpreted come back in {@link SearchResult.query} so the UI can say what it did.
 */
export async function search(
  ctx: Ctx,
  user: UserRow,
  raw: string,
  cursor: string | undefined,
  limitRaw: number | undefined,
): Promise<Outcome<SearchResult>> {
  const limited = consume(ctx, user.id, "search");
  if (!limited.ok) return limited;
  if (raw.length > MAX_QUERY_LENGTH) {
    return refuse("invalid_request", `A search is at most ${MAX_QUERY_LENGTH} characters.`);
  }
  const offset = parseOffset(cursor);
  if (offset === null) return refuse("invalid_request", "cursor is not a valid page marker.");
  const limit = Math.min(limitRaw ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);

  const visible = visibleChannelIds(ctx, user.id);
  const parsed = parseQuery(ctx, user, raw, visible);
  if (!parsed.ok) return parsed;
  const query = parsed.value;

  if (visible.length === 0) {
    return allow({ query, hits: [], channels: [], users: [], cursor: null });
  }

  const started = Date.now();
  const fused = await fusedQuery(ctx, query, visible, limit, offset);
  const dense = fused === null ? "off" : "ok";
  const rows = fused ?? runQuery(ctx, query, visible, limit + 1, offset);
  if (!rows.ok) return rows;
  const page = rows.value.slice(0, limit);

  const messages = hydrateMessages(ctx, page);
  const roots = new Map<string, Message>();
  for (const row of page) {
    if (row.root_id === null || roots.has(row.root_id)) continue;
    const rootRow = loadMessage(ctx, row.root_id);
    if (rootRow !== null) roots.set(row.root_id, hydrateMessages(ctx, [rootRow])[0]!);
  }

  const hits: SearchHit[] = page.map((row, index) => ({
    message: messages[index]!,
    channelId: row.channel_id,
    snippet: row.snip,
    score: row.score,
    root: row.root_id === null ? null : (roots.get(row.root_id) ?? null),
  }));

  // One user list: the directory matches for the top section plus every author on this page, so the
  // client never needs a second request to render a name.
  const directory = matchUsers(ctx, user, query.text, TOP_SECTION_LIMIT);
  const authorIds = new Set<UserId>(page.map((row) => row.author_id));
  for (const entry of directory) authorIds.delete(entry.id);

  logEvent("chat.search", {
    user: hashId(user.id),
    ms: Date.now() - started,
    hits: hits.length,
    qualifiers: countQualifiers(query),
    dense,
  });

  return allow({
    query,
    hits,
    channels: matchChannels(ctx, user.id, query.text, TOP_SECTION_LIMIT),
    users: [...directory, ...loadUsers(ctx, authorIds)],
    cursor: rows.value.length > limit ? String(offset + limit) : null,
  });
}

function countQualifiers(query: SearchQuery): number {
  return [query.in, query.from, query.to, query.has, query.isThread, query.before, query.after].filter(
    (value) => value !== undefined,
  ).length;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const QUALIFIER = /^(in|from|to|has|is|before|after|on):(.*)$/u;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const HAS_VALUES: readonly SearchHasFilter[] = ["image", "file", "link"];

/** Splits on whitespace, keeping a `"quoted phrase"` in one token. */
function tokenize(raw: string): readonly string[] {
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

function parseQuery(
  ctx: Ctx,
  user: UserRow,
  raw: string,
  visible: readonly string[],
): Outcome<SearchQuery> {
  const text: string[] = [];
  const channels = new Set<string>();
  const from = new Set<UserId>();
  const to = new Set<UserId>();
  const has = new Set<SearchHasFilter>();
  let isThread: boolean | undefined;
  let before: Timestamp | undefined;
  let after: Timestamp | undefined;

  for (const token of tokenize(raw)) {
    const match = QUALIFIER.exec(token);
    if (match === null) {
      text.push(token);
      continue;
    }
    const key = match[1]!;
    const value = match[2]!;
    if (value.length === 0) return refuse("invalid_request", `${key}: needs a value.`);

    switch (key) {
      case "in": {
        const name = value.replace(/^#/u, "").toLowerCase();
        const row = ctx.sql
          .exec<{ id: string }>(`SELECT id FROM channels WHERE lower(name) = ?`, name)
          .toArray()[0];
        // An invisible channel is reported as unknown, so `in:` cannot be used to probe for one.
        if (row === undefined || !visible.includes(row.id)) {
          return refuse("invalid_request", `No channel called #${name}.`);
        }
        channels.add(row.id);
        break;
      }
      case "from":
      case "to": {
        const resolved = resolveUser(ctx, user, value);
        if (resolved.length === 0) return refuse("invalid_request", `No such person: ${value}.`);
        for (const id of resolved) (key === "from" ? from : to).add(id);
        break;
      }
      case "has": {
        const wanted = value.toLowerCase();
        if (!HAS_VALUES.includes(wanted as SearchHasFilter)) {
          return refuse("invalid_request", `has: must be one of ${HAS_VALUES.join(", ")}.`);
        }
        has.add(wanted as SearchHasFilter);
        break;
      }
      case "is": {
        if (value.toLowerCase() !== "thread") return refuse("invalid_request", "is: only supports thread.");
        isThread = true;
        break;
      }
      default: {
        const day = parseDay(value);
        if (day === null) return refuse("invalid_request", `${key}: needs a date like 2026-09-01.`);
        if (key === "before") before = day - 1;
        else if (key === "after") after = day + DAY_MS;
        else {
          after = day;
          before = day + DAY_MS - 1;
        }
      }
    }
  }

  if (text.length > MAX_TERMS) return refuse("invalid_request", `At most ${MAX_TERMS} search terms.`);

  return allow({
    text: text.join(" "),
    ...(channels.size > 0 ? { in: [...channels] } : {}),
    ...(from.size > 0 ? { from: [...from] } : {}),
    ...(to.size > 0 ? { to: [...to] } : {}),
    ...(has.size > 0 ? { has: [...has] } : {}),
    ...(isThread === undefined ? {} : { isThread }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  });
}

/** `me`, a user id, or an exact display name or email local part. */
function resolveUser(ctx: Ctx, caller: UserRow, value: string): readonly UserId[] {
  const wanted = value.replace(/^@/u, "");
  if (wanted.toLowerCase() === "me") return [caller.id];
  const lowered = wanted.toLowerCase();
  return ctx.sql
    .exec<{ id: string }>(
      `SELECT id FROM users
        WHERE id = ?
           OR lower(name) = ?
           OR lower(email) = ?
           OR lower(email) LIKE ? ESCAPE '\\'`,
      wanted,
      lowered,
      lowered,
      `${escapeLike(lowered)}@%`,
    )
    .toArray()
    .map((row) => row.id);
}

/** Strict `YYYY-MM-DD` to the start of that day, UTC. */
function parseDay(value: string): number | null {
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

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

/**
 * A safe FTS5 MATCH string: every term is a quoted phrase, with `"` doubled, and a trailing `*` kept
 * as a prefix query. A term with no letter or digit is dropped rather than passed to the parser.
 */
function ftsMatchString(text: string): string {
  const parts: string[] = [];
  for (const token of tokenize(text)) {
    const prefix = token.endsWith("*");
    const core = (prefix ? token.slice(0, -1) : token).replaceAll('"', "");
    if (!/[\p{L}\p{N}]/u.test(core)) continue;
    parts.push(`"${core}"${prefix ? "*" : ""}`);
  }
  return parts.join(" ");
}

/** The channels a query may search: the visible ones, narrowed by `in:`. */
function searchableChannels(query: SearchQuery, visible: readonly string[]): readonly string[] {
  return query.in === undefined ? visible : query.in.filter((id) => visible.includes(id));
}

/**
 * The WHERE clause every hit must pass, lexical or dense: a searchable channel, not deleted, and
 * every qualifier. Bound parameters only.
 */
function filterFor(
  query: SearchQuery,
  channelIds: readonly string[],
): { readonly where: readonly string[]; readonly params: readonly (string | number)[] } {
  const where: string[] = [`m.deleted_at IS NULL`, `m.channel_id IN (${placeholders(channelIds.length)})`];
  const params: (string | number)[] = [...channelIds];

  if (query.from !== undefined && query.from.length > 0) {
    where.push(`m.author_id IN (${placeholders(query.from.length)})`);
    params.push(...query.from);
  }
  if (query.to !== undefined && query.to.length > 0) {
    where.push(
      `EXISTS (SELECT 1 FROM mentions x WHERE x.message_id = m.id
                AND x.user_id IN (${placeholders(query.to.length)}))`,
    );
    params.push(...query.to);
  }
  for (const flag of query.has ?? []) {
    where.push(flag === "image" ? `m.has_image = 1` : flag === "file" ? `m.has_file = 1` : `m.has_link = 1`);
  }
  if (query.isThread === true) where.push(`m.root_id IS NOT NULL`);
  if (query.after !== undefined) {
    where.push(`m.created_at >= ?`);
    params.push(query.after);
  }
  if (query.before !== undefined) {
    where.push(`m.created_at <= ?`);
    params.push(query.before);
  }
  return { where, params };
}

function runQuery(
  ctx: Ctx,
  query: SearchQuery,
  visible: readonly string[],
  limit: number,
  offset: number,
): Outcome<readonly SearchRow[]> {
  const channelIds = searchableChannels(query, visible);
  if (channelIds.length === 0) return allow([]);
  const { where, params } = filterFor(query, channelIds);

  // Two shapes: with text, FTS5 ranks and highlights; with qualifiers alone there is nothing to rank,
  // so the newest matching messages win and every hit scores zero.
  const match = ftsMatchString(query.text);
  const sql =
    match.length === 0
      ? `SELECT m.*, 0 AS score, '' AS snip FROM messages m
          WHERE ${where.join(" AND ")}
          ORDER BY m.created_at DESC, m.id
          LIMIT ? OFFSET ?`
      : `SELECT m.*,
                bm25(messages_fts) AS score,
                snippet(messages_fts, 0, '<mark>', '</mark>', '…', ${SNIPPET_TOKENS}) AS snip
           FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
          WHERE messages_fts MATCH ?
            AND ${where.join(" AND ")}
          ORDER BY score ASC, m.created_at DESC
          LIMIT ? OFFSET ?`;
  const bound = match.length === 0 ? params : [match, ...params];
  try {
    return allow(ctx.sql.exec<SearchRow>(sql, ...bound, limit, offset).toArray());
  } catch {
    // FTS5 rejects a handful of shapes the escaping above does not anticipate; a user-facing
    // validation error beats a 500.
    return refuse("invalid_request", "That search could not be run. Try simpler terms.");
  }
}

// ---------------------------------------------------------------------------
// Omni-search fusion
// ---------------------------------------------------------------------------

/** One list's reciprocal-rank-fusion contribution; 0 when the hit is not in that list. */
function rrf(rank: number | undefined): number {
  return rank === undefined ? 0 : 1 / (SEARCH_LIMITS.rrfK + rank);
}

/**
 * The dense half, or null when it cannot contribute: no binding, a failure, a timeout, or any status
 * but "ok". Never throws.
 */
async function denseCandidates(ctx: Ctx, text: string, channelIds: readonly string[]): Promise<DenseRecallHit[] | null> {
  const service = ctx.env.SEARCH;
  if (service === undefined) return null;
  try {
    const result = await withTimeout(
      service.denseRecall({
        text,
        scopes: channelIds.map(chatScope),
        limit: SEARCH_LIMITS.candidatesPerHalf,
      }),
      DENSE_TIMEOUT_MS,
      "dense recall",
    );
    if (result?.dense !== "ok" || !Array.isArray(result.hits)) return null;
    return result.hits;
  } catch (error) {
    logEvent("chat.search.dense_failed", {
      message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
    });
    return null;
  }
}

/**
 * Lexical and dense, fused. Returns the page (up to `limit + 1` rows, so the caller can tell whether
 * there is more), or null to mean "run the lexical query exactly as without search".
 *
 * Paging stays stable: the fused head is always the top {@link FUSION_CANDIDATES} lexical hits plus
 * the dense hits, ranked by RRF; everything after them follows in lexical order. Which page is asked
 * for never changes that order, so an offset cursor neither skips nor repeats a hit.
 */
async function fusedQuery(
  ctx: Ctx,
  query: SearchQuery,
  visible: readonly string[],
  limit: number,
  offset: number,
): Promise<Outcome<readonly SearchRow[]> | null> {
  if (ctx.env.SEARCH === undefined) return null;
  // A qualifier-only query has nothing to embed.
  if (ftsMatchString(query.text).length === 0) return null;
  const channelIds = searchableChannels(query, visible);
  if (channelIds.length === 0) return null;

  // Started before the (synchronous) lexical query so the two overlap.
  const densePromise = denseCandidates(ctx, query.text, channelIds);
  const lexical = runQuery(ctx, query, visible, Math.max(FUSION_CANDIDATES, offset + limit + 1), 0);
  const denseHits = await densePromise;
  if (!lexical.ok) return lexical;
  if (denseHits === null) return null;

  const head = lexical.value.slice(0, FUSION_CANDIDATES);
  const tail = lexical.value.slice(FUSION_CANDIDATES);
  const lexicalRank = new Map<string, number>(head.map((row, index) => [row.id, index + 1]));

  // Dense ids in their rank order, deduplicated, restricted to chat's own documents.
  const denseRank = new Map<string, number>();
  for (const hit of denseHits.toSorted((a, b) => a.rank - b.rank)) {
    const id = messageIdOfDocument(String(hit.documentId));
    if (id === null || denseRank.has(id) || !Number.isFinite(hit.rank) || hit.rank < 1) continue;
    denseRank.set(id, hit.rank);
  }

  // Chat's ACL and qualifiers, applied to every dense id the lexical head does not already vouch for.
  const unvouched = [...denseRank.keys()].filter((id) => !lexicalRank.has(id));
  const denseOnly = new Map<string, SearchRow>();
  if (unvouched.length > 0) {
    const { where, params } = filterFor(query, channelIds);
    for (const row of ctx.sql
      .exec<MessageRow>(
        `SELECT m.* FROM messages m
          WHERE m.id IN (${placeholders(unvouched.length)}) AND ${where.join(" AND ")}`,
        ...unvouched,
        ...params,
      )
      .toArray()) {
      denseOnly.set(row.id, { ...row, score: 0, snip: plainSnippet(row.body) });
    }
  }

  const fused: { row: SearchRow; fused: number; lexical: number }[] = [];
  for (const row of head) {
    const lex = lexicalRank.get(row.id)!;
    fused.push({ row, fused: rrf(lex) + rrf(denseRank.get(row.id)), lexical: lex });
  }
  for (const row of denseOnly.values()) {
    fused.push({ row, fused: rrf(denseRank.get(row.id)), lexical: Number.POSITIVE_INFINITY });
  }
  fused.sort(
    (a, b) =>
      b.fused - a.fused ||
      a.lexical - b.lexical ||
      b.row.created_at - a.row.created_at ||
      (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
  );

  // Lower is better, like bm25(): the fused score negated. The tail keeps its lexical-only RRF.
  const ordered: SearchRow[] = [
    ...fused.map((entry) => ({ ...entry.row, score: -entry.fused })),
    ...tail.map((row, index) => ({ ...row, score: -rrf(FUSION_CANDIDATES + index + 1) })),
  ];
  return allow(ordered.slice(offset, offset + limit + 1));
}

/**
 * A dense-only hit's snippet: the opening of the message, whitespace collapsed. Same contract as
 * `snippet()`'s output -- raw text the client escapes -- so any literal `<mark>` in the body is
 * removed rather than becoming a highlight.
 */
export function plainSnippet(body: string): string {
  const flat = body.replace(/<\/?mark>/giu, "").replace(/\s+/gu, " ").trim();
  if (flat.length <= PLAIN_SNIPPET_CHARS) return flat;
  const cut = flat.slice(0, PLAIN_SNIPPET_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > PLAIN_SNIPPET_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
