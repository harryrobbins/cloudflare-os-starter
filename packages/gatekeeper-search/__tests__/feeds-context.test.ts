// The Context Library feed (src/feeds/context.ts) against fakes: a fake Library and a recording
// ingest. That the real cfos-context accepts a foreign Worker's `createAccount()`, and that the minted
// account lists the domain's public collections and never another account's private ones, was
// proved against the real Worker under `wrangler dev` (omni-search spike 5); this suite covers what
// the feed does with what it reads.

import { beforeEach, describe, expect, it } from "vitest";

import { INGEST_LIMITS, type IngestBatch, type IngestResult } from "../src/shared/contract.js";
import {
  CONTEXT_LIBRARY_URL,
  MemoryContextFeedStore,
  contextApiSource,
  contextDocumentId,
  openContextSource,
  syncContext,
  type ContextApiLike,
  type ContextFeedSource,
  type FeedCollection,
  type FeedDocument,
} from "../src/feeds/context.js";

class FakeLibrary implements ContextFeedSource {
  collections: FeedCollection[] = [];
  docs = new Map<string, Map<string, FeedDocument>>();
  reads: string[] = [];
  failList = new Set<string>();
  failRead = new Set<string>();

  addCollection(id: string, title: string, visibility: "public" | "private" = "public"): void {
    this.collections.push({ id, title, visibility });
    this.docs.set(id, new Map());
  }
  put(collectionId: string, path: string, body: string, extra: Partial<FeedDocument> = {}): void {
    const name = path.slice(path.lastIndexOf("/") + 1);
    this.docs.get(collectionId)!.set(path, {
      path, name, description: "", contentType: "text/markdown", body, lastUpdated: Date.now(), ...extra,
    });
  }
  touch(collectionId: string, path: string, at: number): void {
    this.docs.get(collectionId)!.get(path)!.lastUpdated = at;
  }

  async listCollections() {
    return this.collections.map((c) => ({ ...c }));
  }
  async listDocuments(collectionId: string) {
    if (this.failList.has(collectionId)) throw new Error("listing failed");
    const coll = this.collections.find((c) => c.id === collectionId);
    if (!coll || coll.visibility !== "public") throw new Error("Collection not found or you don't have access.");
    return [...this.docs.get(collectionId)!.values()].map(({ body: _b, ...summary }) => summary);
  }
  async getDocument(collectionId: string, path: string) {
    this.reads.push(`${collectionId}/${path}`);
    if (this.failRead.has(path)) throw new Error("read failed");
    const coll = this.collections.find((c) => c.id === collectionId);
    if (!coll || coll.visibility !== "public") throw new Error("private read");
    const doc = this.docs.get(collectionId)?.get(path);
    return doc ? { ...doc } : null;
  }
}

class RecordingIndex {
  batches: IngestBatch[] = [];
  failNext = 0;
  async ingest(batch: IngestBatch): Promise<IngestResult> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("index unavailable");
    }
    this.batches.push(structuredClone(batch));
    return { upserted: batch.upserts?.length ?? 0, unchanged: 0, deleted: batch.deletes?.length ?? 0, queued: 0 };
  }
  get upserts() { return this.batches.flatMap((b) => b.upserts ?? []); }
  get deletes() { return this.batches.flatMap((b) => b.deletes ?? []); }
  get scopes() { return this.batches.flatMap((b) => b.scopes ?? []); }
  get dropScopes() { return this.batches.flatMap((b) => b.dropScopes ?? []); }
  reset(): void { this.batches = []; }
}

let library: FakeLibrary;
let store: MemoryContextFeedStore;
let index: RecordingIndex;
const run = (options = {}) =>
  syncContext(library, store, (b) => index.ingest(b), { warn: () => {}, ...options });

beforeEach(() => {
  library = new FakeLibrary();
  store = new MemoryContextFeedStore();
  index = new RecordingIndex();
  library.addCollection("pub1", "Handbook");
  library.put("pub1", "expenses.md", "Submit expenses by the 5th.", { description: "Claims" });
  library.put("pub1", "onboarding/first-week.md", "Badge, laptop, Tessera.");
  library.addCollection("priv1", "Admin secrets", "private");
  library.put("priv1", "secret.md", "PRIVATE-DO-NOT-INDEX");
});

describe("first sync", () => {
  it("pushes every public document with the context scope, vis all and the Library URL", async () => {
    const report = await run();

    expect(report).toMatchObject({ collections: 1, documents: 2, read: 2, pushed: 2, deleted: 0, more: false });
    expect(index.scopes).toEqual([{ scope: "context:pub1", label: "Handbook", vis: "all" }]);
    const byId = Object.fromEntries(index.upserts.map((d) => [d.id, d]));
    expect(Object.keys(byId).sort()).toEqual(["context:pub1:expenses.md", "context:pub1:onboarding/first-week.md"]);
    expect(byId["context:pub1:expenses.md"]).toMatchObject({
      kind: "doc", title: "expenses.md", url: CONTEXT_LIBRARY_URL, scope: "context:pub1", vis: "all",
      channel: "pub1", mime: "text/markdown", body: "Claims\n\nSubmit expenses by the 5th.",
    });
  });

  it("never reads or indexes a private collection", async () => {
    await run();
    expect(library.reads.some((r) => r.startsWith("priv1/"))).toBe(false);
    expect(JSON.stringify(index.batches)).not.toContain("PRIVATE-DO-NOT-INDEX");
    expect(JSON.stringify(index.batches)).not.toContain("priv1");
  });

  it("indexes binary documents by name and description, never their base64 body", async () => {
    library.put("pub1", "diagrams/arch.png", "iVBORw0KGgoAAAANSUhEUg", { contentType: "image/png", description: "Architecture" });
    await run();
    const png = index.upserts.find((d) => d.id === "context:pub1:diagrams/arch.png")!;
    expect(png).toMatchObject({ kind: "file", mime: "image/png", body: "diagrams/arch.png\nArchitecture" });
  });

  it("marks agent skills as kind skill, titled by the skill name", async () => {
    library.put("pub1", "skills/deploy/SKILL.md", "---\nname: deploy\n---\nSteps", { skillName: "deploy" });
    await run();
    expect(index.upserts.find((d) => d.id.endsWith("SKILL.md"))).toMatchObject({ kind: "skill", title: "deploy" });
  });

  it("declares a public collection's scope even while it is empty", async () => {
    library.addCollection("pub2", "Empty");
    await run();
    expect(index.scopes.map((s) => s.scope).sort()).toEqual(["context:pub1", "context:pub2"]);
  });
});

describe("reruns", () => {
  it("fetches nothing and pushes nothing when the Library has not changed", async () => {
    await run();
    library.reads = [];
    index.reset();
    const report = await run();
    expect(library.reads).toEqual([]);
    expect(index.batches).toEqual([]);
    expect(report).toMatchObject({ read: 0, pushed: 0, deleted: 0 });
  });

  it("reads a touched document but does not push it when its content is identical", async () => {
    await run();
    index.reset();
    library.touch("pub1", "expenses.md", Date.now() + 5000);
    const report = await run();
    expect(report).toMatchObject({ read: 1, unchanged: 1, pushed: 0 });
    expect(index.batches).toEqual([]);
    // ...and remembers the new timestamp, so the run after that reads nothing.
    library.reads = [];
    await run();
    expect(library.reads).toEqual([]);
  });

  it("pushes an edited document once", async () => {
    await run();
    index.reset();
    library.put("pub1", "expenses.md", "Submit expenses by the 10th.", { lastUpdated: Date.now() + 5000 });
    await run();
    expect(index.upserts.map((d) => d.id)).toEqual(["context:pub1:expenses.md"]);
    expect(index.upserts[0]!.body).toContain("10th");
    index.reset();
    await run();
    expect(index.batches).toEqual([]);
  });

  it("deletes documents that disappeared", async () => {
    await run();
    index.reset();
    library.docs.get("pub1")!.delete("expenses.md");
    const report = await run();
    expect(index.deletes).toEqual(["context:pub1:expenses.md"]);
    expect(report.deleted).toBe(1);
    expect(store.listDocuments("pub1").map((d) => d.path)).toEqual(["onboarding/first-week.md"]);
  });

  it("drops the scope of a deleted collection", async () => {
    await run();
    index.reset();
    library.collections = library.collections.filter((c) => c.id !== "pub1");
    const report = await run();
    expect(index.dropScopes).toEqual(["context:pub1"]);
    expect(report.droppedCollections).toBe(1);
    expect(store.listCollections()).toEqual([]);
    expect(store.listDocuments("pub1")).toEqual([]);
  });

  it("drops the scope of a collection that is no longer public, without reading it", async () => {
    await run();
    index.reset();
    library.reads = [];
    library.collections.find((c) => c.id === "pub1")!.visibility = "private";
    await run();
    expect(index.dropScopes).toEqual(["context:pub1"]);
    expect(index.upserts).toEqual([]);
    expect(library.reads).toEqual([]);
  });

  it("redeclares only the scope label when a collection is renamed", async () => {
    await run();
    index.reset();
    library.collections.find((c) => c.id === "pub1")!.title = "Staff handbook";
    await run();
    expect(index.batches).toEqual([{ scopes: [{ scope: "context:pub1", label: "Staff handbook", vis: "all" }] }]);
  });
});

describe("failures", () => {
  it("keeps a collection's index rows when listing it fails", async () => {
    await run();
    index.reset();
    library.failList.add("pub1");
    const report = await run();
    expect(report.failedCollections).toEqual(["pub1"]);
    expect(index.deletes).toEqual([]);
    expect(index.dropScopes).toEqual([]);
    expect(store.listDocuments("pub1")).toHaveLength(2);
  });

  it("drops nothing when listing collections fails", async () => {
    await run();
    index.reset();
    library.listCollections = async () => { throw new Error("KV unavailable"); };
    await expect(run()).rejects.toThrow("KV unavailable");
    expect(index.batches).toEqual([]);
    expect(store.listCollections()).toHaveLength(1);
  });

  it("does not record a push the index refused, so the next run retries it", async () => {
    index.failNext = 1;
    await expect(run()).rejects.toThrow("index unavailable");
    expect(store.listDocuments("pub1")).toEqual([]);
    const report = await run();
    expect(report.pushed).toBe(2);
    expect(store.listDocuments("pub1")).toHaveLength(2);
  });

  it("skips a document whose read failed and retries it next run", async () => {
    library.failRead.add("expenses.md");
    const first = await run();
    expect(first.pushed).toBe(1);
    library.failRead.clear();
    index.reset();
    await run();
    expect(index.upserts.map((d) => d.id)).toEqual(["context:pub1:expenses.md"]);
  });

  it("deletes a document that vanished between listing and reading", async () => {
    await run();
    index.reset();
    library.touch("pub1", "expenses.md", Date.now() + 5000);
    const original = library.getDocument.bind(library);
    library.getDocument = async (c, p) => (p === "expenses.md" ? null : original(c, p));
    await run();
    expect(index.deletes).toEqual(["context:pub1:expenses.md"]);
  });
});

describe("volume", () => {
  it("never sends more than the ingest batch limit in one call", async () => {
    for (let i = 0; i < 250; i++) library.put("pub1", `bulk/${i}.md`, `document ${i}`);
    const report = await run();
    expect(report.pushed).toBe(252);
    for (const batch of index.batches) {
      expect((batch.upserts?.length ?? 0) + (batch.deletes?.length ?? 0)).toBeLessThanOrEqual(
        INGEST_LIMITS.maxDocumentsPerBatch);
    }
  });

  it("caps the bodies read per run and continues on the next run", async () => {
    for (let i = 0; i < 30; i++) library.put("pub1", `bulk/${i}.md`, `document ${i}`);
    const first = await run({ maxReadsPerRun: 20 });
    expect(first).toMatchObject({ read: 20, pushed: 20, more: true });
    const second = await run({ maxReadsPerRun: 20 });
    expect(second).toMatchObject({ read: 12, pushed: 12, more: false });
    const third = await run({ maxReadsPerRun: 20 });
    expect(third).toMatchObject({ read: 0, pushed: 0 });
  });

  it("keeps ids within the index limit and stable for very long paths", async () => {
    const path = `${"deep/".repeat(120)}file.md`;
    const id = await contextDocumentId("pub1", path);
    expect(new TextEncoder().encode(id).length).toBeLessThanOrEqual(INGEST_LIMITS.maxIdBytes);
    expect(id.startsWith("context:pub1:#")).toBe(true);
    expect(await contextDocumentId("pub1", path)).toBe(id);
  });
});

describe("the ContextApi adapter", () => {
  function fakeUi(): ContextApiLike & { disposed: boolean } {
    return {
      disposed: false,
      async listEnabledContextCollections() {
        return [
          { id: "a", title: "A", source: "public", lastUpdated: new Date(1000) },
          { id: "b", title: "B", source: "private", lastUpdated: new Date(2000) },
        ];
      },
      async listContextDocuments() {
        return [{ path: "x.md", name: "x.md", description: "", contentType: "text/markdown", lastUpdated: new Date(3000) }];
      },
      async getContextDocument(_c, path) {
        return { path, name: path, description: "", contentType: "text/markdown", body: "hi", lastUpdated: "1970-01-01T00:00:04.000Z" };
      },
      [Symbol.dispose]() { this.disposed = true; },
    } as ContextApiLike & { disposed: boolean };
  }

  it("maps visibility from the enabled set's source and dates to epoch ms", async () => {
    const source = contextApiSource(fakeUi());
    expect(await source.listCollections()).toEqual([
      { id: "a", title: "A", visibility: "public" },
      { id: "b", title: "B", visibility: "private" },
    ]);
    expect((await source.listDocuments("a"))[0]!.lastUpdated).toBe(3000);
    expect((await source.getDocument("a", "x.md"))!.lastUpdated).toBe(4000);
  });

  it("opens the management API without admin rights and disposes it", async () => {
    const ui = fakeUi();
    const calls: unknown[] = [];
    const account = { async startAppUi(context: { isAdmin: boolean }) { calls.push(context); return { iframeHtml: "", ui }; } };
    {
      using session = await openContextSource(account);
      await session.source.listCollections();
    }
    expect(calls).toEqual([{ isAdmin: false }]);
    expect(ui.disposed).toBe(true);
  });
});
