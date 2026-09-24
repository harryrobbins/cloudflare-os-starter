// A deterministic stand-in for Workers AI + Vectorize.
//
// "Embeddings" are hashed bags of words over the contract's 768 dimensions, with a crude stemmer
// (a trailing "s" is dropped) and a few synonyms, so texts that share meaning-bearing words score
// alike even when FTS5 (which does not stem) misses: "deployments" finds "deployment". A query's
// score against a stored vector is the fraction of its words the stored text contains, which is 0
// for unrelated text -- below DENSE_MIN_SCORE, so unrelated documents are never dense hits.
//
// Query filters are evaluated the way Vectorize documents them (implicit AND, equality, `$eq`,
// `$in`), and a filter whose compact JSON is 2048 bytes or more is refused, as Vectorize refuses it.

import { EMBED_DIMENSIONS } from "../../src/shared/contract.js";
import { MAX_FILTER_BYTES, type DenseFilter, type DenseIndex, type DenseMatch, type DenseVector } from "../../src/dense.js";
import type { SearchEnv } from "../../src/env.js";

const SYNONYMS: Readonly<Record<string, string>> = {
  car: "automobile",
  vehicle: "automobile",
  auto: "automobile",
  rollout: "deployment",
  release: "deployment",
};

export function fakeTokens(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let word = raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw;
    word = SYNONYMS[word] ?? word;
    out.add(word);
  }
  return [...out];
}

function bucket(word: string): number {
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    hash ^= word.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % EMBED_DIMENSIONS;
}

export function fakeEmbed(text: string): number[] {
  const vector = new Array<number>(EMBED_DIMENSIONS).fill(0);
  for (const word of fakeTokens(text)) vector[bucket(word)] = 1;
  return vector;
}

function matchesFilter(metadata: Record<string, unknown>, filter: DenseFilter): boolean {
  return Object.entries(filter).every(([key, clause]) => {
    const value = metadata[key];
    if (typeof clause === "string") return value === clause;
    if ("$eq" in clause) return value === clause.$eq;
    return clause.$in.includes(value as string);
  });
}

export class FakeDenseIndex implements DenseIndex {
  readonly vectors = new Map<string, DenseVector>();
  /** Every filter queried, in order. */
  readonly filters: DenseFilter[] = [];
  readonly deleted: string[] = [];
  embedCalls = 0;
  failing = false;
  rerankScores: ((query: string, texts: string[]) => number[]) | null = null;

  async embed(texts: string[]): Promise<number[][]> {
    if (this.failing) throw new Error("fake Workers AI is down");
    if (texts.length > 100) throw new Error("more than 100 texts in one embedding call");
    this.embedCalls++;
    return texts.map(fakeEmbed);
  }

  async upsert(vectors: DenseVector[]): Promise<void> {
    if (this.failing) throw new Error("fake Vectorize is down");
    for (const vector of vectors) {
      if (new TextEncoder().encode(vector.id).length > 64) throw new Error("vector id longer than 64 bytes");
      this.vectors.set(vector.id, vector);
    }
  }

  async query(vector: number[], options: { topK: number; filter: DenseFilter }): Promise<DenseMatch[]> {
    if (this.failing) throw new Error("fake Vectorize is down");
    if (options.topK > 100) throw new Error("topK above 100 with returnMetadata indexed");
    if (new TextEncoder().encode(JSON.stringify(options.filter)).length >= MAX_FILTER_BYTES) {
      throw new Error("filter is 2048 bytes or more");
    }
    this.filters.push(options.filter);
    const size = vector.reduce((sum, value) => sum + value, 0) || 1;
    const matches: DenseMatch[] = [];
    for (const stored of this.vectors.values()) {
      if (!matchesFilter(stored.metadata as unknown as Record<string, unknown>, options.filter)) continue;
      let dot = 0;
      for (let i = 0; i < vector.length; i++) dot += vector[i]! * stored.values[i]!;
      matches.push({ id: stored.id, score: dot / size });
    }
    return matches.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, options.topK);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (this.failing) throw new Error("fake Vectorize is down");
    for (const id of ids) {
      this.vectors.delete(id);
      this.deleted.push(id);
    }
  }

  async rerank(query: string, texts: string[]): Promise<number[]> {
    if (this.rerankScores === null) throw new Error("no rerank scores configured");
    return this.rerankScores(query, texts);
  }
}

/** Per SearchIndex instance, so suites with their own objects never share vectors. */
const registry = new Map<string, FakeDenseIndex | null>();

export function fakeDenseFor(instance: string): FakeDenseIndex {
  let dense = registry.get(instance);
  if (dense === undefined || dense === null) {
    dense = new FakeDenseIndex();
    registry.set(instance, dense);
  }
  return dense;
}

/** Makes an instance behave like a deployment with no AI/VECTORS bindings. */
export function denseOff(instance: string): void {
  registry.set(instance, null);
}

export function testDenseFactory(_env: SearchEnv, instance: string): DenseIndex | null {
  const existing = registry.get(instance);
  if (existing === null) return null;
  return fakeDenseFor(instance);
}
