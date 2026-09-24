// The EMBED queue consumer and the tombstone purge.
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { EMBED_REVISION, INDEX_NAME, type EmbedMessage } from "../src/shared/contract.js";
import { consumeEmbedBatch } from "../src/queue.js";
import worker from "../src/index.js";
import { alice, chatDoc, daysAfter, embedPending, freshIndex, pendingIds, sql } from "./helpers.js";
import { fakeDenseFor } from "./support/fake-dense.js";

function batchOf(bodies: unknown[]) {
  const acked: number[] = [];
  const retried: number[] = [];
  const messages = bodies.map((body, i) => ({
    id: `msg-${i}`,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: () => acked.push(i),
    retry: () => retried.push(i),
  }));
  const batch = {
    queue: "cfos-search-embed-test",
    messages,
    ackAll: () => undefined,
    retryAll: () => undefined,
  } as unknown as MessageBatch<EmbedMessage>;
  return { batch, acked, retried };
}

describe("queue consumer", () => {
  it("claims, embeds, upserts with the contract's metadata and marks embedded", async () => {
    const fixture = freshIndex("consume");
    const longScope = `chat:${"c".repeat(80)}`;
    const result = await fixture.index.ingest("chat", {
      upserts: [
        chatDoc("m1", "vector me", { updatedAt: daysAfter(45) }),
        chatDoc("m2", "and me", { scope: longScope, vis: "scoped", authorId: null }),
      ],
    });
    expect(result.queued).toBe(2);
    const ids = await pendingIds(fixture.index);
    const { batch, acked, retried } = batchOf([{ chunkIds: ids }]);
    await consumeEmbedBatch(batch, env, fixture.index, fixture.dense);
    expect(acked).toEqual([0]);
    expect(retried).toEqual([]);
    expect((await fixture.index.stats()).pendingEmbeds).toBe(0);
    const rows = await sql<{ embed_revision: number }>(fixture.index, `SELECT embed_revision FROM chunks`);
    expect(rows.every((row) => row.embed_revision === EMBED_REVISION)).toBe(true);

    const vectors = [...fixture.dense.vectors.values()];
    expect(vectors).toHaveLength(2);
    const first = vectors.find((vector) => vector.metadata.vis === "all")!;
    expect(first.metadata).toEqual({ scope: "chat:general", vis: "all", source: "chat", kind: "message", author: "u-alice", day: "2026-10" });
    const second = vectors.find((vector) => vector.metadata.vis === "scoped")!;
    expect(second.metadata.author).toBe("");
    expect(new TextEncoder().encode(second.metadata.scope).length).toBe(64);
    expect(longScope.startsWith(second.metadata.scope)).toBe(true);
  });

  it("does not mark a chunk whose revision moved on while it was embedded, and hands it back", async () => {
    const fixture = freshIndex("stale");
    await fixture.index.ingest("chat", { upserts: [chatDoc("m1", "first text")] });
    const claimed = await fixture.index.claimChunks(await pendingIds(fixture.index));
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.revision).toBe(1);

    await fixture.index.ingest("chat", { upserts: [chatDoc("m1", "second text")] });
    const mark = await fixture.index.markEmbedded([{ id: claimed[0]!.id, revision: claimed[0]!.revision }]);
    expect(mark).toEqual({ marked: 0, stale: [claimed[0]!.id] });
    expect(await pendingIds(fixture.index)).toEqual([claimed[0]!.id]);

    // The re-claim carries the new text and revision.
    const again = await fixture.index.claimChunks([claimed[0]!.id]);
    expect(again[0]).toMatchObject({ revision: 2, text: "second text" });
    await embedPending(fixture);
    expect(await fixture.index.claimChunks([claimed[0]!.id])).toEqual([]);
  });

  it("skips chunks that are already embedded or deleted", async () => {
    const fixture = freshIndex("claim-skip");
    await fixture.index.ingest("chat", { upserts: [chatDoc("m1", "one"), chatDoc("m2", "two")] });
    const ids = await pendingIds(fixture.index);
    await embedPending(fixture);
    await fixture.index.ingest("chat", { deletes: ["chat:m2"] });
    expect(await fixture.index.claimChunks(ids)).toEqual([]);
  });

  it("retries a message when embedding fails and leaves the chunks pending", async () => {
    const fixture = freshIndex("retry");
    await fixture.index.ingest("chat", { upserts: [chatDoc("m1", "flaky")] });
    fixture.dense.failing = true;
    const { batch, acked, retried } = batchOf([{ chunkIds: await pendingIds(fixture.index) }, { nonsense: true }]);
    await consumeEmbedBatch(batch, env, fixture.index, fixture.dense);
    expect(retried).toEqual([0]);
    // A malformed message cannot be fixed by retrying.
    expect(acked).toEqual([1]);
    expect((await fixture.index.stats()).pendingEmbeds).toBe(1);
  });

  it("acknowledges without embedding when the deployment has no dense index", async () => {
    const fixture = freshIndex("no-dense");
    await fixture.index.ingest("chat", { upserts: [chatDoc("m1", "lexical only")] });
    const { batch, acked } = batchOf([{ chunkIds: await pendingIds(fixture.index) }]);
    await consumeEmbedBatch(batch, env, fixture.index, null);
    expect(acked).toEqual([0]);
    expect((await fixture.index.stats()).pendingEmbeds).toBe(1);
    expect(await fixture.index.requeuePending()).toBe(1);
  });

  it("the Worker's queue() handler embeds into the one index", async () => {
    const index = env.SEARCH_INDEX.get(env.SEARCH_INDEX.idFromName(INDEX_NAME));
    const unique = `q${crypto.randomUUID().slice(0, 8)}`;
    await index.ingest("chat", { upserts: [chatDoc(unique, `handler embeds ${unique}`)] });
    const ids = await pendingIds(index as never);
    const { batch, acked } = batchOf([{ chunkIds: ids }]);
    await worker.queue!(batch, env as never, {} as ExecutionContext);
    expect(acked).toEqual([0]);
    const dense = fakeDenseFor(index.id.toString());
    for (const id of ids) expect(dense.vectors.has(id)).toBe(true);
  });
});

describe("tombstone purge", () => {
  it("the alarm deletes tombstoned vectors from the dense index", async () => {
    const fixture = freshIndex("purge");
    await fixture.index.ingest("chat", { upserts: [chatDoc("m1", "short lived"), chatDoc("m2", "stays")] });
    await embedPending(fixture);
    const [gone] = await sql<{ id: string }>(fixture.index, `SELECT id FROM chunks WHERE document_id = 'chat:m1'`);
    await fixture.index.ingest("chat", { deletes: ["chat:m1"] });
    expect(fixture.dense.vectors.has(gone!.id)).toBe(true);

    expect(await runDurableObjectAlarm(fixture.index)).toBe(true);
    expect(fixture.dense.deleted).toEqual([gone!.id]);
    expect(fixture.dense.vectors.size).toBe(1);
    const tombstones = await sql<{ purged_at: number | null }>(fixture.index, `SELECT purged_at FROM tombstones`);
    expect(tombstones[0]!.purged_at).not.toBeNull();
    expect((await fixture.index.search(alice, { q: "short" })).hits).toEqual([]);
  });

  it("backs off and keeps the tombstone when Vectorize fails", async () => {
    const fixture = freshIndex("purge-fail");
    await fixture.index.ingest("chat", { upserts: [chatDoc("m1", "doomed")] });
    await fixture.index.ingest("chat", { deletes: ["chat:m1"] });
    fixture.dense.failing = true;
    expect(await runDurableObjectAlarm(fixture.index)).toBe(true);
    const tombstones = await sql<{ purged_at: number | null }>(fixture.index, `SELECT purged_at FROM tombstones`);
    expect(tombstones[0]!.purged_at).toBeNull();
    fixture.dense.failing = false;
    expect(await runDurableObjectAlarm(fixture.index)).toBe(true);
    expect(fixture.dense.deleted).toHaveLength(1);
  });
});
