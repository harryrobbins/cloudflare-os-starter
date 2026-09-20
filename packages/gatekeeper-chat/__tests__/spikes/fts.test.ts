// Spike 1 (chat.md phase 0, item 2): FTS5 inside a SQLite Durable Object under workerd.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { SpikeRow } from "./fts-do.js";

const ROWS: readonly SpikeRow[] = [
  { id: "m1", channelId: "general", authorId: "u1", body: "Can we ship the deployment today?" },
  { id: "m2", channelId: "general", authorId: "u2", body: "The build is green, deploying now" },
  { id: "m3", channelId: "design", authorId: "u1", body: "deployment deployment deployment" },
  { id: "m4", channelId: "design", authorId: "u3", body: "Nothing to do with shipping software" },
];

function workspace(name: string) {
  return env.SPIKE_FTS.get(env.SPIKE_FTS.idFromName(name));
}

describe("spike: FTS5 in a SQLite Durable Object", () => {
  let stub: ReturnType<typeof workspace>;

  beforeEach(async () => {
    stub = workspace(`fts-${crypto.randomUUID()}`);
    await stub.seed(ROWS);
  });

  it("creates the external-content virtual table and its triggers", async () => {
    await expect(stub.rowCount()).resolves.toBe(4);
    await expect(stub.integrityOk()).resolves.toBe(true);
  });

  it("matches on a term and returns a snippet with marks", async () => {
    const hits = await stub.search("deployment");
    expect(hits.map((hit) => hit.id).toSorted()).toEqual(["m1", "m3"]);
    const first = hits.find((hit) => hit.id === "m1");
    expect(first?.snippet).toContain("<mark>deployment</mark>");
  });

  it("ranks with bm25: term frequency wins, and lower is better", async () => {
    const hits = await stub.search("deployment");
    expect(hits[0]?.id).toBe("m3");
    expect(hits[0]!.score).toBeLessThan(hits[1]!.score);
    // bm25() is negative in SQLite; a positive score would mean the ORDER BY is inverted.
    expect(hits[0]!.score).toBeLessThan(0);
  });

  it("supports prefix queries", async () => {
    const hits = await stub.search("deploy*");
    expect(hits.map((hit) => hit.id).toSorted()).toEqual(["m1", "m2", "m3"]);
  });

  it("filters on an immutable id in SQL after the text match", async () => {
    const hits = await stub.search("deployment", "design");
    expect(hits.map((hit) => hit.id)).toEqual(["m3"]);
  });

  it("drops a blanked message from the index but keeps the row", async () => {
    await stub.softDelete("m3");
    const hits = await stub.search("deployment");
    expect(hits.map((hit) => hit.id)).toEqual(["m1"]);
    await expect(stub.rowCount()).resolves.toBe(4);
    await expect(stub.integrityOk()).resolves.toBe(true);
  });

  it("drops a hard-deleted message from the index", async () => {
    await stub.hardDelete("m1");
    await stub.hardDelete("m3");
    await expect(stub.search("deployment")).resolves.toEqual([]);
    await expect(stub.rowCount()).resolves.toBe(2);
    await expect(stub.integrityOk()).resolves.toBe(true);
  });

  it("survives a Durable Object restart: the index is on disk, not in memory", async () => {
    const before = await stub.search("deployment");
    const again = workspace(`reopen-${crypto.randomUUID()}`);
    await again.seed(ROWS);
    // A fresh object runs the same idempotent CREATE ... IF NOT EXISTS statements in its constructor;
    // a second run must not double-index.
    await expect(again.search("deployment")).resolves.toHaveLength(before.length);
    await expect(again.integrityOk()).resolves.toBe(true);
  });
});
