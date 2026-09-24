// `SearchIndex`: the one SQLite Durable Object holding the index (`idFromName(INDEX_NAME)`).
//
// Wiring only: migrations, the `Ctx` the modules under `src/do/` are handed, and the RPC surface.
// Every caller goes through here -- the HTTP handler, `SearchService`, the vendor session and the
// queue consumer -- and every method that returns a row resolves the caller's ACL first.

import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";

import {
  type DenseRecallRequest,
  type DenseRecallResult,
  type DocumentText,
  type EmbedMessage,
  type IndexStats,
  type IngestBatch,
  type IngestResult,
  type OmniSearchResult,
  type SearchCaller,
  type SearchIndexApi,
  type SearchRequest,
  type SourceSummary,
} from "./shared/contract.js";
import { denseIndexFor } from "./dense.js";
import type { SearchEnv } from "./env.js";
import { runMigrations } from "./migrations.js";
import type { Ctx } from "./do/context.js";
import { indexStats, openDocument, sourceSummaries } from "./do/documents.js";
import {
  CHUNKS_PER_MESSAGE,
  armPurge,
  claimChunks,
  markEmbedded,
  pendingChunkIds,
  purgeTombstones,
  type ClaimedChunk,
  type EmbeddedChunk,
  type MarkResult,
} from "./do/embed.js";
import { ingest } from "./do/ingest.js";
import { logEvent } from "./do/log.js";
import { denseRecall, search } from "./do/retrieve.js";

export type { ClaimedChunk, EmbeddedChunk, MarkResult } from "./do/embed.js";

/** `Queue.sendBatch` takes at most 100 messages. */
const SEND_BATCH = 100;

@validateRpc()
export class SearchIndex extends DurableObject<SearchEnv> implements SearchIndexApi {
  readonly #ctx: Ctx;

  constructor(ctx: DurableObjectState, env: SearchEnv) {
    super(ctx, env);
    // Synchronous, in the constructor: every handler may assume the schema exists.
    runMigrations(ctx.storage);
    const instance = ctx.id.toString();
    this.#ctx = {
      sql: ctx.storage.sql,
      storage: ctx.storage,
      env,
      now: () => Date.now(),
      dense: () => denseIndexFor(env, instance),
      enqueue: (ids) => enqueueChunks(env, ids),
      armPurge: () => armPurge(ctx.storage, Date.now()),
    };
  }

  async ingest(source: string, batch: IngestBatch): Promise<IngestResult> {
    return ingest(this.#ctx, source, batch);
  }

  async search(caller: SearchCaller, request: SearchRequest): Promise<OmniSearchResult> {
    return search(this.#ctx, caller, request);
  }

  async denseRecall(
    caller: SearchCaller & { kind: "delegated" },
    request: DenseRecallRequest,
  ): Promise<DenseRecallResult> {
    return denseRecall(this.#ctx, caller, request);
  }

  async open(caller: SearchCaller, documentId: string): Promise<DocumentText | null> {
    return openDocument(this.#ctx.sql, caller, documentId);
  }

  async sources(caller: SearchCaller): Promise<SourceSummary[]> {
    return sourceSummaries(this.#ctx.sql, caller);
  }

  async stats(): Promise<IndexStats> {
    return indexStats(this.#ctx.sql);
  }

  async requeuePending(): Promise<number> {
    return enqueueChunks(this.env, pendingChunkIds(this.#ctx.sql));
  }

  // --- Queue consumer (src/queue.ts). Not part of SearchIndexApi. ---

  /** The chunks among `ids` whose current revision still needs embedding, ready to embed. */
  async claimChunks(ids: string[]): Promise<ClaimedChunk[]> {
    return claimChunks(this.#ctx.sql, ids);
  }

  /** Marks embedded exactly the revisions that were embedded; returns the ones to queue again. */
  async markEmbedded(items: EmbeddedChunk[]): Promise<MarkResult> {
    return markEmbedded(this.#ctx, items);
  }

  /** The tombstone purge: Vectorize deletes for deleted and orphaned chunks. */
  override async alarm(): Promise<void> {
    await purgeTombstones(this.#ctx);
  }
}

/** Sends chunk ids to EMBED, 50 per message, 100 messages per send. Returns how many ids were sent. */
export async function enqueueChunks(env: Pick<SearchEnv, "EMBED">, ids: readonly string[]): Promise<number> {
  const queue = env.EMBED as Queue<EmbedMessage> | undefined;
  if (queue === undefined || ids.length === 0) return 0;
  const messages: MessageSendRequest<EmbedMessage>[] = [];
  for (let i = 0; i < ids.length; i += CHUNKS_PER_MESSAGE) {
    messages.push({ body: { chunkIds: ids.slice(i, i + CHUNKS_PER_MESSAGE) } });
  }
  let sent = 0;
  try {
    for (let i = 0; i < messages.length; i += SEND_BATCH) {
      const batch = messages.slice(i, i + SEND_BATCH);
      await queue.sendBatch(batch);
      sent += batch.reduce((sum, message) => sum + message.body.chunkIds.length, 0);
    }
  } catch (error) {
    // The chunks stay pending in SQL; `requeuePending()` (admin) sends them again.
    logEvent("search.enqueue_failed", {
      sent,
      total: ids.length,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
    });
  }
  return sent;
}
