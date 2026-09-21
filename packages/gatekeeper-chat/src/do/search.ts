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

type SearchRow = MessageRow & { score: number; snip: string };

/**
 * Runs a search for one caller.
 *
 * Dates are resolved in UTC. TODO: resolve them in `users.tz` instead, which needs an offset lookup
 * per query; UTC is predictable and wrong by at most a day at the boundary, and the qualifiers the
 * server interpreted come back in {@link SearchResult.query} so the UI can say what it did.
 */
export function search(
  ctx: Ctx,
  user: UserRow,
  raw: string,
  cursor: string | undefined,
  limitRaw: number | undefined,
): Outcome<SearchResult> {
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
  const rows = runQuery(ctx, query, visible, limit + 1, offset);
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
  const directory = matchUsers(ctx, query.text, TOP_SECTION_LIMIT);
  const authorIds = new Set<UserId>(page.map((row) => row.author_id));
  for (const entry of directory) authorIds.delete(entry.id);

  logEvent("chat.search", {
    user: hashId(user.id),
    ms: Date.now() - started,
    hits: hits.length,
    qualifiers: countQualifiers(query),
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

function runQuery(
  ctx: Ctx,
  query: SearchQuery,
  visible: readonly string[],
  limit: number,
  offset: number,
): Outcome<readonly SearchRow[]> {
  const channelIds = query.in === undefined ? visible : query.in.filter((id) => visible.includes(id));
  if (channelIds.length === 0) return allow([]);

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
