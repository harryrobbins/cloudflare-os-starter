// Ingest: validation, source-prefix enforcement, no-op by hash, re-chunking, deletes, ACL changes.
import { describe, expect, it } from "vitest";

import { INGEST_LIMITS, INPUT_ERROR_PREFIX, type SearchCaller } from "../src/shared/contract.js";
import { OVERLAP_CHARS, TARGET_CHARS, chunkBody, documentChunks } from "../src/do/chunk.js";
import { chunkId } from "../src/do/util.js";
import { alice, bob, chatDoc, embedPending, failure, freshIndex, pendingIds, sql, T0 } from "./helpers.js";

async function hitIds(index: ReturnType<typeof freshIndex>["index"], caller: SearchCaller, q: string): Promise<string[]> {
  const result = await index.search(caller, { q });
  return result.hits.map((hit) => hit.documentId);
}

/** A body of `paragraphs` paragraphs of ~300 characters, each naming its index. */
function longBody(paragraphs: number, word = "alpha", filler = 16): string {
  return Array.from({ length: paragraphs }, (_, i) => `Paragraph p${i} ${word} ${"lorem ipsum dolor ".repeat(filler)}`).join(
    "\n\n",
  );
}

describe("validation and source prefixes", () => {
  it("rejects an id outside the caller's source prefix", async () => {
    const { index } = freshIndex("prefix-id");
    expect(await failure(index.ingest("chat", { upserts: [chatDoc("m1", "hello", { id: "context:m1" })] }))).toMatch(
      INPUT_ERROR_PREFIX,
    );
  });

  it("rejects a scope outside the caller's source prefix", async () => {
    const { index } = freshIndex("prefix-scope");
    expect(await failure(
      index.ingest("chat", { upserts: [chatDoc("m1", "hello", { scope: "context:c1" })] }),
    )).toMatch(/scope/);
  });

  it("allows account: scopes for the gadget source only, and never as vis all", async () => {
    const { index } = freshIndex("account-scope");
    const gadget = {
      id: "gadget:acct1:doc1",
      kind: "doc",
      title: "Notes",
      url: null,
      scope: "account:acct1",
      vis: "scoped" as const,
      body: "gadget body",
      createdAt: T0,
      updatedAt: T0,
    };
    expect(await index.ingest("gadget", { upserts: [gadget] })).toMatchObject({ upserted: 1 });
    expect(await failure(index.ingest("gadget", { upserts: [{ ...gadget, vis: "all" }] }))).toMatch(/vis "all"/);
    expect(await failure(
      index.ingest("chat", { upserts: [chatDoc("m1", "x", { scope: "account:acct1", vis: "scoped" })] }),
    )).toMatch(INPUT_ERROR_PREFIX);
  });

  it("cannot delete, drop or re-permission another source's documents", async () => {
    const { index } = freshIndex("cross-source");
    await index.ingest("chat", { upserts: [chatDoc("m1", "secret plans")] });
    expect(await failure(index.ingest("context", { deletes: ["chat:m1"] }))).toMatch(INPUT_ERROR_PREFIX);
    expect(await failure(index.ingest("context", { dropScopes: ["chat:general"] }))).toMatch(INPUT_ERROR_PREFIX);
    expect(await failure(
      index.ingest("context", { principals: [{ scope: "chat:general", add: ["u-eve"] }] }),
    )).toMatch(INPUT_ERROR_PREFIX);
    expect(await hitIds(index, alice, "plans")).toEqual(["chat:m1"]);
  });

  it("enforces INGEST_LIMITS and writes nothing from a bad batch", async () => {
    const { index } = freshIndex("limits");
    const tooMany = Array.from({ length: INGEST_LIMITS.maxDocumentsPerBatch + 1 }, (_, i) => chatDoc(`m${i}`, "x"));
    expect(await failure(index.ingest("chat", { upserts: tooMany }))).toMatch(/at most/);
    expect(await failure(
      index.ingest("chat", { upserts: [chatDoc("m1", "x", { title: "t".repeat(INGEST_LIMITS.maxTitleChars + 1) })] }),
    )).toMatch(/title/);
    expect(await failure(
      index.ingest("chat", { upserts: [chatDoc(`${"x".repeat(INGEST_LIMITS.maxIdBytes)}`, "x")] }),
    )).toMatch(/bytes/);
    expect(await failure(
      index.ingest("chat", {
        principals: [
          { scope: "chat:p", add: Array.from({ length: INGEST_LIMITS.maxPrincipalChanges }, (_, i) => `u${i}`) },
          { scope: "chat:q", add: ["one-too-many"] },
        ],
      }),
    )).toMatch(/principal/);
    // One good document and one bad one: the good one must not have been written.
    expect(await failure(
      index.ingest("chat", { upserts: [chatDoc("good", "fine"), chatDoc("bad", "x", { url: "javascript:alert(1)" })] }),
    )).toMatch(/url/);
    expect((await index.stats()).documents).toBe(0);
  });

  it("accepts one scope's whole member list beyond the per-batch principal limit", async () => {
    const { index } = freshIndex("big-scope");
    const members = Array.from({ length: INGEST_LIMITS.maxPrincipalChanges + 500 }, (_, i) => `u${i}`);
    await index.ingest("chat", {
      scopes: [{ scope: "chat:big", label: "#big", vis: "scoped" }],
      principals: [{ scope: "chat:big", replace: members }],
    });
    const rows = await sql<{ n: number }>(index, `SELECT COUNT(*) AS n FROM principals WHERE scope = 'chat:big'`);
    expect(rows[0]!.n).toBe(members.length);
  });

  it("truncates an over-long scope label rather than refusing the batch it arrives in", async () => {
    const { index } = freshIndex("long-label");
    await index.ingest("chat", {
      scopes: [{ scope: "chat:g", label: "N".repeat(INGEST_LIMITS.maxLabelChars + 300), vis: "scoped" }],
      principals: [{ scope: "chat:g", replace: ["u-alice"] }],
    });
    const rows = await sql<{ label: string }>(index, `SELECT label FROM scopes WHERE scope = 'chat:g'`);
    expect(rows[0]!.label.length).toBe(INGEST_LIMITS.maxLabelChars);
  });

  it("refuses urls a browser would read as protocol-relative", async () => {
    const { index } = freshIndex("url-hardening");
    for (const url of ["/\\evil.example/x", "/\t/evil.example/x", "/a b"]) {
      expect(await failure(index.ingest("chat", { upserts: [chatDoc("m1", "x", { url })] }))).toMatch(/url/);
    }
  });

  it("truncates an over-long body rather than refusing it", async () => {
    const { index } = freshIndex("truncate");
    const body = "word ".repeat(INGEST_LIMITS.maxBodyChars / 5 + 100);
    await index.ingest("chat", { upserts: [chatDoc("big", body)] });
    const doc = await index.open(alice, "chat:big");
    expect(doc).not.toBeNull();
    const stored = await sql<{ n: number }>(index, `SELECT length(body) AS n FROM documents WHERE id = 'chat:big'`);
    expect(stored[0]!.n).toBeLessThanOrEqual(INGEST_LIMITS.maxBodyChars);
  });
});

describe("chunking", () => {
  it("keeps a short document in one chunk and uses 22-char base64url ids", async () => {
    expect(chunkBody("short body")).toEqual(["short body"]);
    const id = await chunkId("chat:m1", 0);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await chunkId("chat:m1", 0)).toBe(id);
    expect(await chunkId("chat:m1", 1)).not.toBe(id);
  });

  it("chunks ~400 tokens on paragraph boundaries, overlapping by whole paragraphs", () => {
    // ~140-character paragraphs: small enough that the overlap is whole paragraphs.
    const chunks = chunkBody(longBody(40, "alpha", 7));
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TARGET_CHARS);
    // Each later chunk starts with the previous chunk's last paragraph (the overlap).
    for (let i = 1; i < chunks.length; i++) {
      const previousLast = chunks[i - 1]!.split("\n\n").at(-1)!;
      expect(previousLast.length).toBeLessThanOrEqual(OVERLAP_CHARS);
      expect(chunks[i]!.startsWith(previousLast)).toBe(true);
    }
  });

  it("overlaps by the tail of a paragraph too long to carry whole", () => {
    const chunks = chunkBody(longBody(12));
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 1; i < chunks.length; i++) {
      const head = chunks[i]!.split("\n\n")[0]!;
      expect(head.length).toBeLessThanOrEqual(OVERLAP_CHARS);
      expect(chunks[i - 1]!.endsWith(head)).toBe(true);
    }
  });

  it("splits one enormous paragraph into windows", () => {
    const chunks = chunkBody("word ".repeat(2000));
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TARGET_CHARS);
  });

  it("leads chunk 0 with the title", () => {
    expect(documentChunks("Quarterly plan", "body text")[0]).toBe("Quarterly plan\n\nbody text");
  });
});

describe("upserts", () => {
  it("is a no-op when body hash and metadata are unchanged", async () => {
    const fixture = freshIndex("noop");
    const doc = chatDoc("m1", "the same text");
    expect(await fixture.index.ingest("chat", { upserts: [doc] })).toMatchObject({ upserted: 1, unchanged: 0, queued: 1 });
    await embedPending(fixture);
    expect(await fixture.index.ingest("chat", { upserts: [doc] })).toMatchObject({ upserted: 0, unchanged: 1, queued: 0 });
    expect(await pendingIds(fixture.index)).toEqual([]);
    // A metadata-only change is not a no-op.
    const retitled = await fixture.index.ingest("chat", { upserts: [{ ...doc, title: "New title" }] });
    expect(retitled).toMatchObject({ upserted: 1, unchanged: 0 });
  });

  it("bumps the revision, re-chunks, re-embeds only changed chunks and drops the tail", async () => {
    const fixture = freshIndex("rechunk");
    const { index } = fixture;
    await index.ingest("context", {
      upserts: [
        {
          id: "context:doc1",
          kind: "doc",
          title: "",
          url: null,
          scope: "context:lib",
          vis: "all",
          body: longBody(12, "zebra"),
          createdAt: T0,
          updatedAt: T0,
        },
      ],
    });
    const before = await sql<{ id: string; ord: number }>(index, `SELECT id, ord FROM chunks ORDER BY ord`);
    expect(before.length).toBeGreaterThan(2);
    await embedPending(fixture);
    expect(fixture.dense.vectors.size).toBe(before.length);

    // Shrink to the first paragraph only: one chunk left, the rest tombstoned.
    const shrunk = await index.ingest("context", {
      upserts: [
        {
          id: "context:doc1",
          kind: "doc",
          title: "",
          url: null,
          scope: "context:lib",
          vis: "all",
          body: "Paragraph p0 zebra is all that is left, now about giraffes",
          createdAt: T0,
          updatedAt: T0,
        },
      ],
    });
    expect(shrunk).toMatchObject({ upserted: 1, queued: 1 });
    const after = await sql<{ id: string; revision: number }>(index, `SELECT id, revision FROM chunks`);
    expect(after).toHaveLength(1);
    expect(after[0]!.revision).toBe(2);
    const revision = await sql<{ revision: number }>(index, `SELECT revision FROM documents WHERE id = 'context:doc1'`);
    expect(revision[0]!.revision).toBe(2);
    const tombstones = await sql<{ chunk_id: string }>(index, `SELECT chunk_id FROM tombstones ORDER BY chunk_id`);
    expect(tombstones.map((row) => row.chunk_id).sort()).toEqual(before.slice(1).map((row) => row.id).sort());

    // The dropped text is gone from FTS at once; the kept text is findable.
    expect(await hitIds(index, alice, "p5")).toEqual([]);
    expect(await hitIds(index, alice, "giraffes")).toEqual(["context:doc1"]);
    expect((await index.stats()).tombstones).toBe(before.length - 1);
  });
});

describe("deletes", () => {
  it("makes a deleted document invisible at once, even to the dense half", async () => {
    const fixture = freshIndex("delete");
    const { index } = fixture;
    await index.ingest("chat", { upserts: [chatDoc("m1", "migration runbook"), chatDoc("m2", "migration checklist")] });
    await embedPending(fixture);
    expect((await hitIds(index, alice, "migration")).sort()).toEqual(["chat:m1", "chat:m2"]);

    expect(await index.ingest("chat", { deletes: ["chat:m1", "chat:unknown"] })).toMatchObject({ deleted: 1 });
    // The vector is still in the (fake) Vectorize until the purge alarm runs; it must not surface.
    expect(fixture.dense.vectors.size).toBe(2);
    const result = await index.search(alice, { q: "migrations" });
    expect(result.hits.map((hit) => hit.documentId)).toEqual(["chat:m2"]);
    expect(await index.open(alice, "chat:m1")).toBeNull();
    expect(await index.stats()).toMatchObject({ documents: 1, deletedDocuments: 1, tombstones: 1 });
  });

  it("resurrects a deleted document when it is pushed again", async () => {
    const fixture = freshIndex("resurrect");
    await fixture.index.ingest("chat", { upserts: [chatDoc("m1", "phoenix")] });
    await fixture.index.ingest("chat", { deletes: ["chat:m1"] });
    await fixture.index.ingest("chat", { upserts: [chatDoc("m1", "phoenix")] });
    expect(await hitIds(fixture.index, alice, "phoenix")).toEqual(["chat:m1"]);
    expect((await fixture.index.stats()).tombstones).toBe(0);
  });

  it("dropScopes deletes every document in the scope and forgets its principals", async () => {
    const { index } = freshIndex("drop");
    await index.ingest("chat", {
      scopes: [{ scope: "chat:secret", label: "#secret", vis: "scoped" }],
      principals: [{ scope: "chat:secret", replace: ["u-alice"] }],
      upserts: [
        chatDoc("s1", "hidden treasure", { scope: "chat:secret", vis: "scoped" }),
        chatDoc("s2", "hidden map", { scope: "chat:secret", vis: "scoped" }),
        chatDoc("g1", "hidden in plain sight"),
      ],
    });
    expect(await hitIds(index, alice, "hidden")).toHaveLength(3);
    expect(await index.ingest("chat", { dropScopes: ["chat:secret"] })).toMatchObject({ deleted: 2 });
    expect(await hitIds(index, alice, "hidden")).toEqual(["chat:g1"]);
    expect(await index.stats()).toMatchObject({ scopes: 0, principals: 0 });
  });
});

describe("principals", () => {
  async function privateCorpus() {
    const fixture = freshIndex("principals");
    await fixture.index.ingest("chat", {
      scopes: [{ scope: "chat:priv", label: "#priv", vis: "scoped" }],
      principals: [{ scope: "chat:priv", replace: ["u-alice"] }],
      upserts: [chatDoc("p1", "confidential roadmap", { scope: "chat:priv", vis: "scoped" })],
    });
    return fixture;
  }

  it("replace, add and remove change who can see a scope, immediately", async () => {
    const { index } = await privateCorpus();
    expect(await hitIds(index, alice, "roadmap")).toEqual(["chat:p1"]);
    expect(await hitIds(index, bob, "roadmap")).toEqual([]);

    await index.ingest("chat", { principals: [{ scope: "chat:priv", add: ["u-bob"] }] });
    expect(await hitIds(index, bob, "roadmap")).toEqual(["chat:p1"]);

    await index.ingest("chat", { principals: [{ scope: "chat:priv", remove: ["u-alice"] }] });
    expect(await hitIds(index, alice, "roadmap")).toEqual([]);
    expect(await index.open(alice, "chat:p1")).toBeNull();

    // replace wins over add/remove in the same change.
    await index.ingest("chat", { principals: [{ scope: "chat:priv", replace: ["u-alice"], add: ["u-bob"] }] });
    expect(await hitIds(index, alice, "roadmap")).toEqual(["chat:p1"]);
    expect(await hitIds(index, bob, "roadmap")).toEqual([]);
  });

  it("revokes the dense half too, although the vector still carries the old scope", async () => {
    const fixture = await privateCorpus();
    await fixture.index.ingest("chat", { principals: [{ scope: "chat:priv", add: ["u-bob"] }] });
    await embedPending(fixture);
    // "roadmaps" misses FTS (no stemming) so only the dense half can find it.
    const found = await fixture.index.search(bob, { q: "roadmaps" });
    expect(found.hits.map((hit) => hit.documentId)).toEqual(["chat:p1"]);
    expect(found.hits[0]!.lexicalRank).toBeNull();

    await fixture.index.ingest("chat", { principals: [{ scope: "chat:priv", remove: ["u-bob"] }] });
    expect((await fixture.index.search(bob, { q: "roadmaps" })).hits).toEqual([]);
  });

  it("a scope turned private re-labels its documents and re-queues their vectors", async () => {
    const fixture = freshIndex("vis-change");
    await fixture.index.ingest("chat", {
      scopes: [{ scope: "chat:c1", label: "#c1", vis: "all" }],
      upserts: [chatDoc("m1", "launch party", { scope: "chat:c1" })],
    });
    await embedPending(fixture);
    expect(await hitIds(fixture.index, bob, "party")).toEqual(["chat:m1"]);
    const result = await fixture.index.ingest("chat", { scopes: [{ scope: "chat:c1", label: "#c1", vis: "scoped" }] });
    expect(result.queued).toBe(1);
    expect(await hitIds(fixture.index, bob, "party")).toEqual([]);
    await embedPending(fixture);
    expect([...fixture.dense.vectors.values()][0]!.metadata.vis).toBe("scoped");
  });
});
