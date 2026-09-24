// The dense half behind one seam: `DenseIndex` (plan, phase 0 spike 3: "swap the dense half behind
// the DenseIndex interface rather than rewriting the plan").
//
// Production is Workers AI (`@cf/baai/bge-base-en-v1.5`, cls pooling) plus Vectorize. Tests replace
// it through `overrideDenseIndexFactory()`, which only `__tests__/worker.ts` calls: the fake lives in
// `__tests__/`, so it is not even part of the production bundle, and nothing under `src/` calls the
// override. There is no env var or binding that can select it.

import {
  EMBED_MODEL,
  EMBED_POOLING,
  RERANK_MODEL,
  SEARCH_LIMITS,
  type Scope,
  type VectorMetadata,
  type Visibility,
} from "./shared/contract.js";
import type { SearchEnv } from "./env.js";

/** Workers AI's schema cap on texts per embedding call. */
export const EMBED_BATCH = 100;
/** Vectorize's upsert / delete batch from a Worker. */
export const VECTOR_WRITE_BATCH = 1000;
/** topK with `returnMetadata: "indexed"` (and no values). */
export const MAX_TOP_K = 100;
/** Vectorize's filter cap: compact JSON must be *less than* this many bytes. */
export const MAX_FILTER_BYTES = 2048;
/** Vectorize indexes only the first 64 bytes of a metadata string. */
export const METADATA_STRING_BYTES = 64;
/**
 * Dense neighbours below this cosine similarity are dropped: a vector index always returns its topK
 * nearest, however unrelated, and an unrelated neighbour must not become a "hit". bge-base cls puts
 * unrelated English text around 0.3-0.5. Tune on the real corpus (plan phase 0).
 */
export const DENSE_MIN_SCORE = 0.5;

export interface DenseVector {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

export interface DenseMatch {
  id: string;
  score: number;
}

/** A Vectorize metadata filter, restricted to what this Worker uses: equality and `$in`. */
export type DenseFilter = Record<string, string | { $eq: string } | { $in: string[] }>;

export interface DenseQuery {
  topK: number;
  filter: DenseFilter;
}

export interface DenseIndex {
  /** One vector per text, in order. */
  embed(texts: string[]): Promise<number[][]>;
  upsert(vectors: DenseVector[]): Promise<void>;
  /** Best first. */
  query(vector: number[], options: DenseQuery): Promise<DenseMatch[]>;
  deleteByIds(ids: string[]): Promise<void>;
  /** Relevance scores for each text against the query, higher is better. Absent: no reranker. */
  rerank?(query: string, texts: string[]): Promise<number[]>;
}

/** `instance` names the SearchIndex the dense index serves; production has one and ignores it. */
export type DenseIndexFactory = (env: SearchEnv, instance: string) => DenseIndex | null;

let factory: DenseIndexFactory = productionDenseIndex;

/** The dense index for this environment, or null when the deployment has no AI/Vectorize binding. */
export function denseIndexFor(env: SearchEnv, instance: string): DenseIndex | null {
  return factory(env, instance);
}

/** Test seam. Called only from `__tests__/worker.ts`; see the header comment. */
export function overrideDenseIndexFactory(next: DenseIndexFactory): void {
  factory = next;
}

// ---------------------------------------------------------------------------
// Production: Workers AI + Vectorize
// ---------------------------------------------------------------------------

type EmbeddingOutput = { data?: number[][]; shape?: number[] };
type RerankOutput = { response?: { id?: number; score?: number }[] };
type LooseAi = { run(model: string, inputs: unknown, options?: unknown): Promise<unknown> };

export function productionDenseIndex(env: SearchEnv): DenseIndex | null {
  const ai = env.AI as unknown as LooseAi | undefined;
  const vectors = env.VECTORS as VectorizeIndex | undefined;
  if (ai === undefined || vectors === undefined) return null;
  const gateway = env.AI_GATEWAY ? { gateway: { id: env.AI_GATEWAY } } : undefined;

  return {
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH);
        const result = (await ai.run(EMBED_MODEL, { text: batch, pooling: EMBED_POOLING }, gateway)) as EmbeddingOutput;
        const data = result.data;
        if (!Array.isArray(data) || data.length !== batch.length) {
          throw new Error(`embedding returned ${Array.isArray(data) ? data.length : "no"} vectors for ${batch.length} texts`);
        }
        out.push(...data);
      }
      return out;
    },
    async upsert(items) {
      for (let i = 0; i < items.length; i += VECTOR_WRITE_BATCH) {
        const batch = items.slice(i, i + VECTOR_WRITE_BATCH);
        await vectors.upsert(
          batch.map((item) => ({
            id: item.id,
            values: item.values,
            metadata: item.metadata as unknown as Record<string, VectorizeVectorMetadata>,
          })),
        );
      }
    },
    async query(vector, options) {
      const result = await vectors.query(vector, {
        topK: Math.min(options.topK, MAX_TOP_K),
        filter: options.filter as unknown as VectorizeVectorMetadataFilter,
        returnMetadata: "indexed",
        returnValues: false,
      });
      return result.matches.map((match) => ({ id: match.id, score: match.score }));
    },
    async deleteByIds(ids) {
      for (let i = 0; i < ids.length; i += VECTOR_WRITE_BATCH) {
        await vectors.deleteByIds(ids.slice(i, i + VECTOR_WRITE_BATCH));
      }
    },
    async rerank(query, texts) {
      const result = (await ai.run(
        RERANK_MODEL,
        { query, contexts: texts.map((text) => ({ text })), top_k: texts.length },
        gateway,
      )) as RerankOutput;
      const scores = texts.map(() => Number.NEGATIVE_INFINITY);
      for (const entry of result.response ?? []) {
        if (typeof entry.id === "number" && typeof entry.score === "number" && entry.id < scores.length) {
          scores[entry.id] = entry.score;
        }
      }
      return scores;
    },
  };
}

// ---------------------------------------------------------------------------
// Metadata and filters
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** Truncates to at most `bytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(value: string, bytes = METADATA_STRING_BYTES): string {
  if (encoder.encode(value).length <= bytes) return value;
  let out = "";
  let used = 0;
  for (const char of value) {
    const size = encoder.encode(char).length;
    if (used + size > bytes) break;
    out += char;
    used += size;
  }
  return out;
}

export interface VectorMetadataSource {
  scope: Scope;
  vis: Visibility;
  source: string;
  kind: string;
  author_id: string | null;
  updated_at: number;
}

/** `YYYY-MM` of an epoch-ms instant, UTC. */
export function monthBucket(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

export function vectorMetadata(doc: VectorMetadataSource): VectorMetadata {
  return {
    scope: truncateUtf8(doc.scope),
    vis: doc.vis,
    source: truncateUtf8(doc.source),
    kind: truncateUtf8(doc.kind),
    author: truncateUtf8(doc.author_id ?? ""),
    day: monthBucket(doc.updated_at),
  };
}

function filterBytes(filter: DenseFilter): number {
  return encoder.encode(JSON.stringify(filter)).length;
}

/**
 * `{...base, scope: {$in: group}}` for groups of `scopes` packed so each filter's compact JSON stays
 * under Vectorize's 2048-byte cap: the plan's fan-out for a caller with many restricted scopes.
 * Candidates are truncated to 64 bytes exactly as stored metadata is, so a long scope still matches;
 * the SQL post-filter restores exactness.
 */
export function scopeFilters(base: DenseFilter, scopes: readonly string[]): DenseFilter[] {
  const unique = [...new Set(scopes.map((scope) => truncateUtf8(scope)))];
  const filters: DenseFilter[] = [];
  let group: string[] = [];
  for (const scope of unique) {
    const candidate = [...group, scope];
    if (group.length > 0 && filterBytes({ ...base, scope: { $in: candidate } }) >= MAX_FILTER_BYTES) {
      filters.push({ ...base, scope: { $in: group } });
      group = [scope];
    } else {
      group = candidate;
    }
  }
  if (group.length > 0) {
    if (filterBytes({ ...base, scope: { $in: group } }) >= MAX_FILTER_BYTES) {
      // A single scope with a base filter that is already near the cap: drop the base qualifiers
      // rather than the scope; the SQL post-filter still enforces them.
      filters.push({ scope: { $in: group } });
    } else {
      filters.push({ ...base, scope: { $in: group } });
    }
  }
  return filters;
}

/** A qualifier as a filter clause: equality for one value, `$in` for several. */
export function valuesClause(values: readonly string[]): string | { $in: string[] } {
  const truncated = [...new Set(values.map((value) => truncateUtf8(value)))];
  return truncated.length === 1 ? truncated[0]! : { $in: truncated };
}

/** Top-K per query, bounded by the contract's candidates-per-half and Vectorize's cap. */
export const DENSE_TOP_K = Math.min(SEARCH_LIMITS.candidatesPerHalf, MAX_TOP_K);
