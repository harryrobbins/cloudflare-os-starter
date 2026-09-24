// Omni-search sync: the durable outbox that pushes chat's messages, channels and memberships to the
// search Worker, and the backfill that pushes everything that existed before.
//
// The rules (docs/plans/omni-search.md, phase 1 and "A service binding, not a Queue"):
//
//   * Recorded in the same code path as the chat write, in this object's own SQLite, and only when the
//     SEARCH binding exists. With no binding nothing here writes a row, so chat is unchanged.
//   * Never blocks or fails a user's write. Queueing is one synchronous `INSERT`; the push happens later
//     from the object's one alarm, which the upload sweep and the agent outbox share.
//   * The outbox holds references, not snapshots. A flush reads the row as it is *now*: an edit is a
//     re-upsert of the current text, a deleted or tombstoned message is a delete, a channel that no
//     longer exists is a dropped scope. Queueing the same reference twice is one row, so a busy
//     message costs one push, and a crash between queueing and pushing loses nothing.
//   * Batches stay inside the contract's INGEST_LIMITS: at most 100 documents and 2000 principal
//     changes per `ingest()` call. A failed call backs off (5 s, 20 s, 1 min, 3 min, then every 10
//     min) and retries the same rows; a batch search refuses as invalid input is dropped and counted,
//     because a poison batch retried forever would starve everything behind it.
//   * The backfill queues references page by page from a cursor kept in `search_sync`, channels first
//     and then messages by rowid, and only while the outbox is short -- so a large corpus never floods
//     the table, and an eviction mid-backfill resumes where it stopped.
//
// ACL mapping: every message is one document in scope `chat:<channelId>`. A public channel is
// `vis: "all"` with no principals; anything else is `vis: "scoped"` and its principals are *replaced*
// with the current member ids whenever membership may have changed. Search only decides dense
// candidates from that -- chat's own SQL remains the authority (src/do/search.ts).

import {
  AGENT_USER_ID,
  type ChannelId,
  type MessageId,
  type SearchSyncStatus,
  type Timestamp,
} from "../shared/protocol.js";
import { permalink } from "../shared/routes.js";
import {
  chatDocumentId,
  chatScope,
  INGEST_LIMITS,
  INPUT_ERROR_PREFIX,
  type IngestBatch,
  type IngestDocument,
  type PrincipalChange,
  type ScopeDeclaration,
  type Visibility,
  withTimeout,
} from "../search-client.js";
import { placeholders, type Ctx } from "./context.js";
import { logEvent } from "./logs.js";
import type { ChannelRow, MessageRow } from "./rows.js";

type OutboxKind = "message" | "channel";

type OutboxRow = {
  kind: string;
  ref: string;
  generation: number;
  queued_at: number;
};

type SyncRow = {
  backfill_phase: string | null;
  backfill_cursor: string;
  backfill_queued: number;
  backfill_started_at: number | null;
  backfill_finished_at: number | null;
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  last_success_at: number | null;
  pushed_documents: number;
  dropped: number;
};

/** Channel references per batch. Each one is a scope declaration and at most one principal change. */
const MAX_CHANNELS_PER_BATCH = 50;
/** `ingest()` calls per alarm run. More work re-arms the alarm for immediately after. */
const MAX_BATCHES_PER_RUN = 20;
/** The backfill only queues more while the outbox is shorter than this. */
const BACKFILL_HIGH_WATER = 500;
const BACKFILL_CHANNEL_PAGE = 100;
const BACKFILL_MESSAGE_PAGE = 200;
/** A hung `ingest()` must not hold the alarm (and the upload sweep and agent outbox behind it). */
const INGEST_TIMEOUT_MS = 30_000;
const BACKOFF_MS: readonly number[] = [5_000, 20_000, 60_000, 180_000, 600_000];
/** Participant names in a DM or group title before "+N". */
const MAX_TITLE_PARTICIPANTS = 5;
const MAX_ERROR_CHARS = 200;

/** True when this deployment binds the search Worker. */
export function searchEnabled(ctx: Ctx): boolean {
  return ctx.env.SEARCH !== undefined;
}

// ---------------------------------------------------------------------------
// Queueing, from the write paths
// ---------------------------------------------------------------------------

function queue(ctx: Ctx, kind: OutboxKind, refs: Iterable<string>, now: number): number {
  let count = 0;
  for (const ref of refs) {
    ctx.sql.exec(
      `INSERT INTO search_outbox (kind, ref, queued_at) VALUES (?, ?, ?)
       ON CONFLICT (kind, ref) DO UPDATE SET generation = generation + 1`,
      kind,
      ref,
      now,
    );
    count++;
  }
  return count;
}

/** A message was created, edited or deleted. */
export function queueSearchMessage(ctx: Ctx, messageId: MessageId): void {
  if (!searchEnabled(ctx)) return;
  queue(ctx, "message", [messageId], ctx.now());
  ctx.searchChanged?.();
}

/**
 * A channel was created, renamed, re-topiced, archived or deleted, or its membership changed. The
 * flush re-declares its scope and, for a non-public channel, replaces its principals.
 */
export function queueSearchChannel(ctx: Ctx, channelId: ChannelId): void {
  if (!searchEnabled(ctx)) return;
  queue(ctx, "channel", [channelId], ctx.now());
  ctx.searchChanged?.();
}

/**
 * A channel's name changed, and every message's title carries it: re-push the lot. One statement,
 * and renames are rare.
 */
export function queueSearchChannelMessages(ctx: Ctx, channelId: ChannelId): void {
  if (!searchEnabled(ctx)) return;
  ctx.sql.exec(
    `INSERT INTO search_outbox (kind, ref, queued_at)
     SELECT 'message', id, ? FROM messages WHERE channel_id = ? AND deleted_at IS NULL
     ON CONFLICT (kind, ref) DO UPDATE SET generation = generation + 1`,
    ctx.now(),
    channelId,
  );
  ctx.searchChanged?.();
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

function loadSync(ctx: Ctx): SyncRow {
  const row = ctx.sql.exec<SyncRow>(`SELECT * FROM search_sync WHERE id = 1`).toArray()[0];
  if (row === undefined) throw new Error("search_sync has no row; migration 4 did not run.");
  return row;
}

/**
 * The first time this object runs with SEARCH bound, start a backfill of everything already here.
 * Returns true when it started one (the caller wakes the alarm).
 */
export function ensureSearchStarted(ctx: Ctx): boolean {
  if (!searchEnabled(ctx)) return false;
  if (loadSync(ctx).backfill_phase !== null) return false;
  resetBackfill(ctx);
  logEvent("chat.search.backfill", { reason: "first_run" });
  return true;
}

/** An admin's "reindex": restart the backfill from the beginning and retry now. */
export function restartSearchBackfill(ctx: Ctx): void {
  resetBackfill(ctx);
}

function resetBackfill(ctx: Ctx): void {
  ctx.sql.exec(
    `UPDATE search_sync
        SET backfill_phase = 'channels', backfill_cursor = '', backfill_queued = 0,
            backfill_started_at = ?, backfill_finished_at = NULL,
            attempts = 0, next_attempt_at = NULL
      WHERE id = 1`,
    ctx.now(),
  );
}

function outboxSize(ctx: Ctx): number {
  return ctx.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM search_outbox`).toArray()[0]?.n ?? 0;
}

/**
 * Queues the next page(s) of the corpus while the outbox is short. Channels first, so every scope is
 * declared before its messages arrive; then messages by rowid, the only key that is both stable and
 * ordered. The cursor is committed with the rows it queued, so an eviction resumes exactly here.
 */
function backfillStep(ctx: Ctx): void {
  for (let pages = 0; pages < 10; pages++) {
    const sync = loadSync(ctx);
    if (sync.backfill_phase !== "channels" && sync.backfill_phase !== "messages") return;
    if (outboxSize(ctx) >= BACKFILL_HIGH_WATER) return;
    const now = ctx.now();

    if (sync.backfill_phase === "channels") {
      const ids = ctx.sql
        .exec<{ id: string }>(
          `SELECT id FROM channels WHERE id > ? ORDER BY id LIMIT ?`,
          sync.backfill_cursor,
          BACKFILL_CHANNEL_PAGE,
        )
        .toArray()
        .map((row) => row.id);
      ctx.storage.transactionSync(() => {
        const queued = queue(ctx, "channel", ids, now);
        const done = ids.length < BACKFILL_CHANNEL_PAGE;
        ctx.sql.exec(
          `UPDATE search_sync SET backfill_phase = ?, backfill_cursor = ?,
                  backfill_queued = backfill_queued + ? WHERE id = 1`,
          done ? "messages" : "channels",
          done ? "0" : (ids.at(-1) ?? sync.backfill_cursor),
          queued,
        );
      });
      if (ids.length > 0) return;
      continue;
    }

    const rows = ctx.sql
      .exec<{ r: number; id: string; deleted_at: number | null }>(
        `SELECT rowid AS r, id, deleted_at FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?`,
        Number(sync.backfill_cursor) || 0,
        BACKFILL_MESSAGE_PAGE,
      )
      .toArray();
    const live = rows.filter((row) => row.deleted_at === null).map((row) => row.id);
    const done = rows.length < BACKFILL_MESSAGE_PAGE;
    ctx.storage.transactionSync(() => {
      const queued = queue(ctx, "message", live, now);
      ctx.sql.exec(
        `UPDATE search_sync SET backfill_phase = ?, backfill_cursor = ?,
                backfill_queued = backfill_queued + ?, backfill_finished_at = ? WHERE id = 1`,
        done ? "done" : "messages",
        String(rows.at(-1)?.r ?? sync.backfill_cursor),
        queued,
        done ? now : null,
      );
    });
    if (done) logEvent("chat.search.backfill_done", { queued: loadSync(ctx).backfill_queued });
    if (live.length > 0 || done) return;
  }
}

// ---------------------------------------------------------------------------
// Building a batch
// ---------------------------------------------------------------------------

interface Built {
  readonly batch: IngestBatch;
  readonly taken: readonly OutboxRow[];
  readonly documents: number;
}

interface ChannelInfo {
  readonly row: ChannelRow;
  readonly vis: Visibility;
  readonly label: string;
}

/** `#name`, or the participants' names for a DM or group. */
function channelInfo(ctx: Ctx, row: ChannelRow): ChannelInfo {
  const vis: Visibility = row.kind === "public" ? "all" : "scoped";
  if (row.kind === "dm" || row.kind === "group") {
    const names = ctx.sql
      .exec<{ name: string }>(
        `SELECT u.name AS name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.channel_id = ? ORDER BY lower(u.name), u.id`,
        row.id,
      )
      .toArray()
      .map((entry) => entry.name);
    const shown = names.slice(0, MAX_TITLE_PARTICIPANTS).join(", ");
    const extra = names.length - MAX_TITLE_PARTICIPANTS;
    return { row, vis, label: extra > 0 ? `${shown} +${extra}` : shown || "Direct message" };
  }
  return { row, vis, label: `#${row.name ?? row.id}` };
}

function memberIds(ctx: Ctx, channelId: ChannelId): string[] {
  return ctx.sql
    .exec<{ user_id: string }>(`SELECT user_id FROM memberships WHERE channel_id = ? ORDER BY user_id`, channelId)
    .toArray()
    .map((row) => row.user_id);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The next batch, or null when the outbox is empty. Channel references go first, so a scope is
 * declared no later than the messages in it.
 */
function buildBatch(ctx: Ctx): Built | null {
  const taken: OutboxRow[] = [];
  const scopes: ScopeDeclaration[] = [];
  const principals: PrincipalChange[] = [];
  const dropScopes: string[] = [];
  const upserts: IngestDocument[] = [];
  const deletes: string[] = [];
  const channels = new Map<ChannelId, ChannelInfo | null>();

  const lookupChannel = (id: ChannelId): ChannelInfo | null => {
    if (!channels.has(id)) {
      const row = ctx.sql.exec<ChannelRow>(`SELECT * FROM channels WHERE id = ?`, id).toArray()[0];
      channels.set(id, row === undefined ? null : channelInfo(ctx, row));
    }
    return channels.get(id) ?? null;
  };

  let principalBudget = INGEST_LIMITS.maxPrincipalChanges;
  const channelRows = ctx.sql
    .exec<OutboxRow>(
      `SELECT * FROM search_outbox WHERE kind = 'channel' ORDER BY queued_at, ref LIMIT ?`,
      MAX_CHANNELS_PER_BATCH,
    )
    .toArray();
  for (const outbox of channelRows) {
    const info = lookupChannel(outbox.ref);
    const scope = chatScope(outbox.ref);
    if (info === null) {
      dropScopes.push(scope);
      taken.push(outbox);
      continue;
    }
    const members = info.vis === "scoped" ? memberIds(ctx, outbox.ref) : null;
    // A channel bigger than the whole budget still goes, alone, rather than blocking the outbox.
    if (members !== null && members.length > principalBudget && taken.length > 0) break;
    scopes.push({ scope, label: truncate(info.label, INGEST_LIMITS.maxTitleChars), vis: info.vis });
    if (members !== null) {
      principals.push({ scope, replace: members });
      principalBudget -= members.length;
    }
    taken.push(outbox);
  }

  const messageRows = ctx.sql
    .exec<OutboxRow>(
      `SELECT * FROM search_outbox WHERE kind = 'message' ORDER BY queued_at, ref LIMIT ?`,
      INGEST_LIMITS.maxDocumentsPerBatch,
    )
    .toArray();
  if (messageRows.length > 0) {
    const ids = messageRows.map((row) => row.ref);
    const messages = new Map<string, MessageRow>();
    for (const row of ctx.sql
      .exec<MessageRow>(`SELECT * FROM messages WHERE id IN (${placeholders(ids.length)})`, ...ids)
      .toArray()) {
      messages.set(row.id, row);
    }
    const files = new Map<string, string[]>();
    for (const row of ctx.sql
      .exec<{ message_id: string; name: string }>(
        `SELECT message_id, name FROM attachments
          WHERE message_id IN (${placeholders(ids.length)}) ORDER BY created_at, id`,
        ...ids,
      )
      .toArray()) {
      const list = files.get(row.message_id) ?? [];
      list.push(row.name);
      files.set(row.message_id, list);
    }
    const authors = new Map<string, string>();
    const authorIds = [...new Set([...messages.values()].map((row) => row.author_id))];
    if (authorIds.length > 0) {
      for (const row of ctx.sql
        .exec<{ id: string; name: string }>(
          `SELECT id, name FROM users WHERE id IN (${placeholders(authorIds.length)})`,
          ...authorIds,
        )
        .toArray()) {
        authors.set(row.id, row.name);
      }
    }

    for (const outbox of messageRows) {
      taken.push(outbox);
      const id = chatDocumentId(outbox.ref);
      const row = messages.get(outbox.ref);
      const info = row === undefined ? null : lookupChannel(row.channel_id);
      const body =
        row === undefined ? "" : [row.body, ...(files.get(row.id) ?? [])].filter((part) => part.length > 0).join("\n");
      if (row === undefined || info === null || row.deleted_at !== null || body.trim().length === 0) {
        // Gone, tombstoned or blank: nothing left to find.
        deletes.push(id);
        continue;
      }
      const author = authors.get(row.author_id) ?? (row.author_id === AGENT_USER_ID ? "Agent" : row.author_id);
      upserts.push({
        id,
        kind: "message",
        title: truncate(`${info.label} · ${author}`, INGEST_LIMITS.maxTitleChars),
        url: permalink(row.channel_id, row.id),
        scope: chatScope(row.channel_id),
        vis: info.vis,
        body: body.slice(0, INGEST_LIMITS.maxBodyChars),
        channel: row.channel_id,
        authorId: row.author_id,
        author,
        createdAt: row.created_at,
        updatedAt: row.edited_at ?? row.created_at,
      });
    }
  }

  if (taken.length === 0) return null;
  const batch: IngestBatch = {
    ...(upserts.length > 0 ? { upserts } : {}),
    ...(deletes.length > 0 ? { deletes } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(principals.length > 0 ? { principals } : {}),
    ...(dropScopes.length > 0 ? { dropScopes } : {}),
  };
  return { batch, taken, documents: upserts.length + deletes.length };
}

/** Clears exactly the rows pushed: a reference queued again mid-flight has a newer generation. */
function clearTaken(ctx: Ctx, taken: readonly OutboxRow[]): void {
  ctx.storage.transactionSync(() => {
    for (const row of taken) {
      ctx.sql.exec(
        `DELETE FROM search_outbox WHERE kind = ? AND ref = ? AND generation = ?`,
        row.kind,
        row.ref,
        row.generation,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Flushing, from the alarm
// ---------------------------------------------------------------------------

export function searchBackoff(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1]!;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARS);
}

/**
 * Pushes queued work to search. Returns when the alarm is next needed: now when more is queued, the
 * backoff deadline after a failure, or null when there is nothing to do (or no binding).
 *
 * Never throws for a search failure: the alarm is shared with the upload sweep and the agent outbox,
 * and a search outage must not make the runtime retry those.
 */
export async function runSearchOutbox(ctx: Ctx): Promise<Timestamp | null> {
  const service = ctx.env.SEARCH;
  if (service === undefined) return null;
  ensureSearchStarted(ctx);

  const due = loadSync(ctx).next_attempt_at;
  if (due !== null && due > ctx.now()) return due;

  for (let run = 0; run < MAX_BATCHES_PER_RUN; run++) {
    backfillStep(ctx);
    const built = buildBatch(ctx);
    if (built === null) break;

    const started = Date.now();
    try {
      await withTimeout(service.ingest(built.batch), INGEST_TIMEOUT_MS, "search ingest");
    } catch (error) {
      const message = errorText(error);
      const now = ctx.now();
      if (message.startsWith(INPUT_ERROR_PREFIX)) {
        // Refused as malformed: retrying the same rows would fail the same way forever.
        clearTaken(ctx, built.taken);
        ctx.sql.exec(
          `UPDATE search_sync SET dropped = dropped + ?, last_error = ?, last_error_at = ? WHERE id = 1`,
          built.taken.length,
          message,
          now,
        );
        logEvent("chat.search.ingest_refused", { rows: built.taken.length });
        continue;
      }
      const sync = loadSync(ctx);
      const attempts = sync.attempts + 1;
      const next = now + searchBackoff(attempts);
      ctx.sql.exec(
        `UPDATE search_sync SET attempts = ?, next_attempt_at = ?, last_error = ?, last_error_at = ? WHERE id = 1`,
        attempts,
        next,
        message,
        now,
      );
      logEvent("chat.search.ingest_failed", { attempts, rows: built.taken.length });
      return next;
    }

    clearTaken(ctx, built.taken);
    ctx.sql.exec(
      `UPDATE search_sync SET attempts = 0, next_attempt_at = NULL, last_success_at = ?,
              pushed_documents = pushed_documents + ? WHERE id = 1`,
      ctx.now(),
      built.documents,
    );
    logEvent("chat.search.ingest", {
      documents: built.documents,
      scopes: built.batch.scopes?.length ?? 0,
      dropped: built.batch.dropScopes?.length ?? 0,
      ms: Date.now() - started,
    });
  }

  const sync = loadSync(ctx);
  const backfilling = sync.backfill_phase === "channels" || sync.backfill_phase === "messages";
  return outboxSize(ctx) > 0 || backfilling ? ctx.now() : null;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function searchSyncStatus(ctx: Ctx): SearchSyncStatus {
  const sync = loadSync(ctx);
  const counts = ctx.sql
    .exec<{ kind: string; n: number; oldest: number }>(
      `SELECT kind, COUNT(*) AS n, MIN(queued_at) AS oldest FROM search_outbox GROUP BY kind`,
    )
    .toArray();
  const oldest = counts.map((row) => row.oldest).filter((at) => at !== null);
  const phase = sync.backfill_phase;
  return {
    enabled: searchEnabled(ctx),
    outbox: {
      messages: counts.find((row) => row.kind === "message")?.n ?? 0,
      channels: counts.find((row) => row.kind === "channel")?.n ?? 0,
      oldestQueuedAt: oldest.length > 0 ? Math.min(...oldest) : null,
    },
    backfill: {
      phase: phase === "channels" || phase === "messages" || phase === "done" ? phase : null,
      cursor: sync.backfill_cursor,
      queued: sync.backfill_queued,
      startedAt: sync.backfill_started_at,
      finishedAt: sync.backfill_finished_at,
    },
    attempts: sync.attempts,
    nextAttemptAt: sync.next_attempt_at,
    lastError: sync.last_error,
    lastErrorAt: sync.last_error_at,
    lastSuccessAt: sync.last_success_at,
    pushedDocuments: sync.pushed_documents,
    dropped: sync.dropped,
  };
}
