// The EMBED queue consumer: claim -> embed -> upsert -> mark.
//
// Embedding happens here, in the Worker, not in the Durable Object, so the one index object never
// waits on Workers AI while it could be answering searches. Each message is handled on its own: a
// failure retries that message with backoff (and after `max_retries` it lands in the dead-letter
// queue configured in wrangler.jsonc), while its siblings are acknowledged.

import type { EmbedMessage } from "./shared/contract.js";
import type { DenseIndex } from "./dense.js";
import type { SearchEnv } from "./env.js";
import type { ClaimedChunk, EmbeddedChunk, MarkResult } from "./do/embed.js";
import { logEvent } from "./do/log.js";
import { enqueueChunks } from "./search-index.js";

/** What the consumer needs from the index; the SearchIndex stub satisfies it. */
export interface EmbedIndex {
  claimChunks(ids: string[]): Promise<ClaimedChunk[]>;
  markEmbedded(items: EmbeddedChunk[]): Promise<MarkResult>;
}

const MAX_RETRY_DELAY_SECONDS = 300;

export async function consumeEmbedBatch(
  batch: MessageBatch<EmbedMessage>,
  env: Pick<SearchEnv, "EMBED">,
  index: EmbedIndex,
  dense: DenseIndex | null,
): Promise<void> {
  for (const message of batch.messages) {
    const ids = message.body?.chunkIds;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      // Malformed: retrying cannot fix it.
      logEvent("search.embed_malformed", { id: message.id });
      message.ack();
      continue;
    }
    if (dense === null) {
      // Lexical-only deployment: the chunks stay pending in SQL for a later requeue.
      message.ack();
      continue;
    }
    try {
      const stale = await embedChunks(ids, index, dense);
      if (stale.length > 0) await enqueueChunks(env, stale);
      message.ack();
    } catch (error) {
      logEvent("search.embed_failed", {
        chunks: ids.length,
        attempts: message.attempts,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      });
      message.retry({ delaySeconds: Math.min(MAX_RETRY_DELAY_SECONDS, 2 ** Math.min(message.attempts, 8)) });
    }
  }
}

/** Embeds the chunks among `ids` that still need it. Returns ids to queue again. */
export async function embedChunks(ids: string[], index: EmbedIndex, dense: DenseIndex): Promise<string[]> {
  const claimed = await index.claimChunks(ids);
  if (claimed.length === 0) return [];
  const vectors = await dense.embed(claimed.map((chunk) => chunk.text));
  await dense.upsert(
    claimed.map((chunk, i) => ({ id: chunk.id, values: vectors[i]!, metadata: chunk.metadata })),
  );
  const result = await index.markEmbedded(claimed.map((chunk) => ({ id: chunk.id, revision: chunk.revision })));
  return result.stale;
}
