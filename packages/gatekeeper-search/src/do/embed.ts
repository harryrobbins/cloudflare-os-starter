// The queue consumer's side of the object, and the Vectorize delete path.
//
// The consumer (src/queue.ts) claims chunks, embeds them outside the object and marks them. A mark
// only lands for the revision that was embedded: if the chunk changed while its embedding was in
// flight, the mark is refused and the chunk is handed back to be queued again, so the vector that
// finally wins is always the current text's.

import { EMBED_REVISION, type VectorMetadata, type Visibility } from "../shared/contract.js";
import { vectorMetadata } from "../dense.js";
import { embedText } from "./chunk.js";
import type { Ctx } from "./context.js";
import { IN_LIST, inputError, jsonList } from "./util.js";
import { logEvent } from "./log.js";

/** A chunk the consumer should embed. */
export interface ClaimedChunk {
  id: string;
  /** Pass back to `markEmbedded` unchanged. */
  revision: number;
  /** What to embed: the chunk text, with the title for context. */
  text: string;
  metadata: VectorMetadata;
}

export interface EmbeddedChunk {
  id: string;
  revision: number;
}

export interface MarkResult {
  marked: number;
  /** Chunks whose revision moved on while they were embedded: queue them again. */
  stale: string[];
}

/** Chunk ids per queue message; the contract's "≤ ~50". */
export const CHUNKS_PER_MESSAGE = 50;
/** Chunk ids one claim may name. */
export const MAX_CLAIM = 500;
const PURGE_BATCH = 1000;
const PURGE_DELAY_MS = 5_000;
const PURGE_RETRY_MS = 60_000;
/** Purged tombstones are kept this long so a late vector from an in-flight embed is still filtered. */
const TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function checkIds(ids: unknown, max = MAX_CLAIM): string[] {
  if (!Array.isArray(ids) || ids.length > max || ids.some((id) => typeof id !== "string")) {
    throw inputError(`chunk ids must be a list of at most ${max} strings.`);
  }
  return ids as string[];
}

export function claimChunks(sql: SqlStorage, idsRaw: string[]): ClaimedChunk[] {
  const ids = checkIds(idsRaw);
  if (ids.length === 0) return [];
  return sql
    .exec<{
      id: string;
      ord: number;
      text: string;
      revision: number;
      title: string;
      scope: string;
      vis: Visibility;
      source: string;
      kind: string;
      author_id: string | null;
      updated_at: number;
    }>(
      `SELECT c.id, c.ord, c.text, c.revision, d.title, d.scope, d.vis, d.source, d.kind, d.author_id, d.updated_at
         FROM chunks c JOIN documents d ON d.id = c.document_id
        WHERE c.id IN ${IN_LIST}
          AND d.deleted_at IS NULL
          AND (c.embedded_at IS NULL OR c.embed_revision IS NOT ?)`,
      jsonList(ids),
      EMBED_REVISION,
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      revision: row.revision,
      text: embedText(row.title, row.ord, row.text),
      metadata: vectorMetadata(row),
    }));
}

export function markEmbedded(ctx: Ctx, itemsRaw: EmbeddedChunk[]): MarkResult {
  if (!Array.isArray(itemsRaw) || itemsRaw.length > MAX_CLAIM) {
    throw inputError(`at most ${MAX_CLAIM} chunks per mark.`);
  }
  const now = ctx.now();
  let marked = 0;
  const stale: string[] = [];
  ctx.storage.transactionSync(() => {
    for (const item of itemsRaw) {
      if (typeof item?.id !== "string" || !Number.isInteger(item.revision)) continue;
      const updated = ctx.sql.exec(
        `UPDATE chunks SET embedded_at = ?, embed_revision = ? WHERE id = ? AND revision = ?`,
        now,
        EMBED_REVISION,
        item.id,
        item.revision,
      );
      if (updated.rowsWritten > 0) {
        marked++;
        continue;
      }
      // A newer revision exists. Our (older) vector may have landed after the newer one, so the
      // current revision must be embedded again whatever its state says.
      const reset = ctx.sql.exec(
        `UPDATE chunks SET embedded_at = NULL, embed_revision = NULL WHERE id = ? AND revision > ?`,
        item.id,
        item.revision,
      );
      if (reset.rowsWritten > 0) stale.push(item.id);
    }
  });
  return { marked, stale };
}

export function pendingChunkIds(sql: SqlStorage): string[] {
  return sql
    .exec<{ id: string }>(
      `SELECT id FROM chunks WHERE embedded_at IS NULL OR embed_revision IS NOT ? ORDER BY rowid`,
      EMBED_REVISION,
    )
    .toArray()
    .map((row) => row.id);
}

/** Arms the purge alarm unless one is already due sooner. */
export async function armPurge(storage: DurableObjectStorage, now: number, delay = PURGE_DELAY_MS): Promise<void> {
  const current = await storage.getAlarm();
  if (current !== null && current <= now + delay) return;
  await storage.setAlarm(now + delay);
}

/**
 * The alarm: asks Vectorize to delete tombstoned vectors, in batches, and forgets tombstones that
 * were purged long ago. Re-arms itself while work remains, and backs off when the dense index fails.
 */
export async function purgeTombstones(ctx: Ctx): Promise<void> {
  const now = ctx.now();
  ctx.sql.exec(`DELETE FROM tombstones WHERE purged_at IS NOT NULL AND purged_at < ?`, now - TOMBSTONE_RETENTION_MS);
  const ids = ctx.sql
    .exec<{ chunk_id: string }>(
      `SELECT chunk_id FROM tombstones WHERE purged_at IS NULL ORDER BY deleted_at LIMIT ?`,
      PURGE_BATCH,
    )
    .toArray()
    .map((row) => row.chunk_id);
  if (ids.length === 0) return;

  const dense = ctx.dense();
  if (dense !== null) {
    try {
      await dense.deleteByIds(ids);
    } catch (error) {
      logEvent("search.purge_failed", {
        chunks: ids.length,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      });
      await ctx.storage.setAlarm(ctx.now() + PURGE_RETRY_MS);
      return;
    }
  }
  // Without a dense index there is nothing to delete; the ids are marked so they are not retried.
  ctx.sql.exec(
    `UPDATE tombstones SET purged_at = ? WHERE chunk_id IN ${IN_LIST} AND purged_at IS NULL`,
    ctx.now(),
    jsonList(ids),
  );
  const remaining = ctx.sql
    .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tombstones WHERE purged_at IS NULL`)
    .one().n;
  if (remaining > 0) await ctx.storage.setAlarm(ctx.now() + 1_000);
}
