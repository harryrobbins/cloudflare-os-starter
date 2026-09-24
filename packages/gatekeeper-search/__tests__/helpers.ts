// Shared fixtures. Every suite gets its own SearchIndex instance, addressed by a random name, and its
// own fake dense index keyed by that instance's id.

import { env, runInDurableObject } from "cloudflare:test";

import type { IngestDocument, SearchCaller } from "../src/shared/contract.js";
import { embedChunks } from "../src/queue.js";
import type { SearchIndex } from "../src/search-index.js";
import { fakeDenseFor, type FakeDenseIndex } from "./support/fake-dense.js";

export type Index = DurableObjectStub<SearchIndex>;

export interface Fixture {
  readonly index: Index;
  readonly dense: FakeDenseIndex;
  readonly instance: string;
}

export function freshIndex(label: string): Fixture {
  const index = env.SEARCH_INDEX.get(env.SEARCH_INDEX.idFromName(`${label}-${crypto.randomUUID()}`)) as Index;
  const instance = index.id.toString();
  return { index, dense: fakeDenseFor(instance), instance };
}

export const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

/** A chat message document in `chat:<channel>`. */
export function chatDoc(id: string, body: string, overrides: Partial<IngestDocument> = {}): IngestDocument {
  return {
    id: `chat:${id}`,
    kind: "message",
    title: "",
    url: `/gatekeeper/chat/m/${id}`,
    scope: "chat:general",
    vis: "all",
    body,
    authorId: "u-alice",
    author: "Alice",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function daysAfter(days: number): number {
  return T0 + days * DAY;
}

export const alice: SearchCaller = { kind: "person", principal: "u-alice" };
export const bob: SearchCaller = { kind: "person", principal: "u-bob" };
export const carol: SearchCaller = { kind: "person", principal: "u-carol" };

/** Chunk ids whose current revision is not embedded, read straight from SQL. */
export async function pendingIds(index: Index): Promise<string[]> {
  return runInDurableObject(index, (_instance, state) =>
    state.storage.sql
      .exec<{ id: string }>(`SELECT id FROM chunks WHERE embedded_at IS NULL ORDER BY rowid`)
      .toArray()
      .map((row) => row.id),
  );
}

/** Runs the queue consumer's work for every pending chunk, as the EMBED queue would. */
export async function embedPending(fixture: Fixture): Promise<number> {
  const ids = await pendingIds(fixture.index);
  for (let i = 0; i < ids.length; i += 50) await embedChunks(ids.slice(i, i + 50), fixture.index, fixture.dense);
  return ids.length;
}

export async function sql<T extends Record<string, SqlStorageValue>>(index: Index, query: string, ...params: SqlStorageValue[]): Promise<T[]> {
  return runInDurableObject(index, (_instance, state) => state.storage.sql.exec<T>(query, ...params).toArray());
}

/**
 * The message a call rejects with. A Durable Object stub's call returns an RpcPromise, which is a
 * callable proxy; `expect(rpcPromise).rejects` treats it as a function and calls it, leaving the real
 * rejection unhandled. Awaiting it here handles it.
 */
export async function failure(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to fail, and it succeeded");
}
