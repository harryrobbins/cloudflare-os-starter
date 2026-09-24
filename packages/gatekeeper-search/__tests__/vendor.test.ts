// The agent-facing half: the session, `/find`, the catalog and the vendor descriptions. The index is
// a fake here; the real SearchIndex's handling of agent callers and gadget pushes is covered by the
// index suites, so this file tests the mapping, the observation/approval discipline and the
// partitioning rules the vendor adds on top.

import { describe, expect, it } from "vitest";

import type {
  IngestBatch,
  IngestResult,
  OmniHit,
  OmniSearchResult,
  SearchCaller,
  SearchIndexApi,
  SearchRequest,
  SourceSummary,
  DocumentText,
} from "../src/shared/contract.js";
import {
  SEARCH_INDEX_ACTION,
  SearchSessionImpl,
  absoluteUrl,
  batchFor,
  describeQuery,
  describeSearchResource,
  describeSearchVendor,
  expandFind,
  plainSnippet,
  prepareGadgetDocument,
  searchAgentCatalog,
  type PendingIndexChange,
} from "../src/vendor/index.js";
import TYPES_CODE from "../src/vendor/types-code.js";
import TYPES_DTS from "../src/vendor/types.d.ts?raw";

const BASE = "https://cfos.example.test";
const PARTITION = "11111111-2222-3333-4444-555555555555";

function hit(overrides: Partial<OmniHit> = {}): OmniHit {
  return {
    documentId: "chat:M1",
    source: "chat",
    kind: "message",
    title: "#general · Sam",
    url: "/gatekeeper/chat/c/C1/m/M1",
    snippet: "the <mark>onboarding</mark> doc &amp; checklist &lt;v2&gt;",
    score: 0.03,
    lexicalRank: 1,
    denseRank: 2,
    scope: "chat:C1",
    scopeLabel: "#general",
    vis: "all",
    workspace: null,
    channel: "C1",
    author: "Sam",
    mime: null,
    createdAt: 1,
    updatedAt: Date.UTC(2026, 8, 1),
    ...overrides,
  };
}

function result(hits: OmniHit[], overrides: Partial<OmniSearchResult> = {}): OmniSearchResult {
  return {
    query: { text: "onboarding", source: ["chat"] },
    hits,
    facets: [{ field: "source", values: [{ value: "chat", label: "Team chat", count: hits.length }] }],
    cursor: null,
    dense: "ok",
    tookMs: 3,
    ...overrides,
  };
}

class FakeIndex implements Pick<SearchIndexApi, "search" | "open" | "sources" | "ingest"> {
  readonly searches: { caller: SearchCaller; request: SearchRequest }[] = [];
  readonly ingests: { source: string; batch: IngestBatch }[] = [];
  answer: OmniSearchResult = result([hit()]);
  documents = new Map<string, DocumentText>();
  sourceList: SourceSummary[] = [];

  async search(caller: SearchCaller, request: SearchRequest): Promise<OmniSearchResult> {
    this.searches.push({ caller, request });
    return this.answer;
  }
  async open(_caller: SearchCaller, documentId: string): Promise<DocumentText | null> {
    return this.documents.get(documentId) ?? null;
  }
  async sources(_caller: SearchCaller): Promise<SourceSummary[]> {
    return this.sourceList;
  }
  async ingest(source: string, batch: IngestBatch): Promise<IngestResult> {
    this.ingests.push({ source, batch });
    return { upserted: batch.upserts?.length ?? 0, unchanged: 0, deleted: 0, queued: 0 };
  }
}

class FakeQueue {
  readonly observations: { title: string; description: string }[] = [];
  readonly actions: { action: number; description: Record<string, unknown> }[] = [];
  failSubmit = false;
  async authorizeObservation(description: { title: string; description: string }): Promise<void> {
    this.observations.push(description);
  }
  async submitAction(action: number, description: Record<string, unknown>): Promise<void> {
    if (this.failSubmit) throw new Error("queue closed");
    this.actions.push({ action, description });
  }
}

function session(index = new FakeIndex(), queue = new FakeQueue()) {
  const pending = new Map<number, PendingIndexChange>();
  let counter = 0;
  const impl = new SearchSessionImpl({
    approvalQueue: queue,
    index,
    partition: PARTITION,
    publicBaseUrl: BASE,
    now: () => 1_000,
    actions: {
      nextActionId: () => ++counter,
      putPending: (action, change) => void pending.set(action, change),
      deletePending: (action) => void pending.delete(action),
    },
  });
  return { impl, index, queue, pending };
}

describe("agent-facing types", () => {
  it("serves types.d.ts byte for byte", () => {
    expect(TYPES_CODE).toBe(TYPES_DTS);
  });

  it("describes an ambient SEARCH binding with slash commands", () => {
    expect(describeSearchResource()).toMatchObject({
      suggestedBindingName: "SEARCH",
      tsType: "SearchSession",
      hasSlashCommands: true,
    });
    const vendor = describeSearchVendor(`${BASE}/gatekeeper/search/`);
    expect(vendor.autoProvisionsAccount).toBe(true);
    expect(vendor.description).toMatch(/private channels, direct messages/u);
  });
});

describe("SearchSession.search", () => {
  it("searches as this workspace's agent partition and maps hits for the agent", async () => {
    const { impl, index, queue } = session();
    const answer = await impl.search("onboarding source:chat", { limit: 500 });

    expect(index.searches[0]).toEqual({
      caller: { kind: "agent", accountId: PARTITION },
      request: { q: "onboarding source:chat", limit: 25, facets: false },
    });
    expect(answer.hits[0]).toEqual({
      documentId: "chat:M1",
      source: "chat",
      kind: "message",
      title: "#general · Sam",
      url: `${BASE}/gatekeeper/chat/c/C1/m/M1`,
      excerpt: "the onboarding doc & checklist <v2>",
      container: "#general",
      author: "Sam",
      updatedAt: Date.UTC(2026, 8, 1),
      matchedBy: "both",
    });
    expect(answer.interpreted).toBe("onboarding source:chat");
    expect(answer.semantic).toBe(true);
    expect(queue.observations).toHaveLength(1);
    expect(queue.observations[0]!.description).toMatch(/1 result from Team chat/u);
  });

  it("observes before returning, so a refused observation returns nothing", async () => {
    const index = new FakeIndex();
    const queue = new FakeQueue();
    queue.authorizeObservation = async () => {
      throw new Error("lockdown");
    };
    const { impl } = session(index, queue);
    await expect(impl.search("x")).rejects.toThrow("lockdown");
  });

  it("reports word-only answers and which half found each hit", async () => {
    const index = new FakeIndex();
    index.answer = result([hit({ denseRank: null }), hit({ documentId: "chat:M2", lexicalRank: null })], {
      dense: "unavailable",
    });
    const { impl } = session(index);
    const answer = await impl.search("x");
    expect(answer.semantic).toBe(false);
    expect(answer.hits.map((entry) => entry.matchedBy)).toEqual(["words", "meaning"]);
  });

  it("passes the cursor through and defaults the limit", async () => {
    const { impl, index } = session();
    await impl.search("x", { cursor: "20" });
    expect(index.searches[0]!.request).toEqual({ q: "x", limit: 10, facets: false, cursor: "20" });
  });
});

describe("open, cite and facets", () => {
  const document: DocumentText = {
    documentId: "context:D1",
    source: "context",
    kind: "doc",
    title: "Onboarding",
    url: "/gatekeeper/context/doc/D1",
    scope: "context:K1",
    scopeLabel: "Handbook",
    author: null,
    updatedAt: 5,
    text: "Welcome aboard.",
    truncated: false,
  };

  it("opens a visible document after observing it", async () => {
    const { impl, index, queue } = session();
    index.documents.set(document.documentId, document);
    const opened = await impl.open("context:D1");
    expect(opened).toMatchObject({ text: "Welcome aboard.", url: `${BASE}/gatekeeper/context/doc/D1` });
    expect(queue.observations[0]!.title).toBe('Read "Onboarding"');
  });

  it("returns null without observing anything for an unknown document", async () => {
    const { impl, queue } = session();
    expect(await impl.open("chat:nope")).toBeNull();
    expect(queue.observations).toHaveLength(0);
  });

  it("cites with an absolute link and refuses an invisible document", async () => {
    const { impl, index } = session();
    index.documents.set(document.documentId, document);
    expect(await impl.cite("context:D1")).toEqual({
      title: "Onboarding",
      url: `${BASE}/gatekeeper/context/doc/D1`,
    });
    await expect(impl.cite("chat:private")).rejects.toThrow(/No document/u);
  });

  it("returns facets after observing", async () => {
    const { impl, queue } = session();
    const facets = await impl.facets("onboarding");
    expect(facets[0]!.field).toBe("source");
    expect(queue.observations).toHaveLength(1);
  });
});

describe("put and remove", () => {
  it("submits an auto-approvable index action scoped to this workspace", async () => {
    const { impl, queue, pending } = session();
    await impl.put({ externalId: "doc-1", kind: "doc", title: "Plan", body: "Ship it." });

    expect(queue.actions).toHaveLength(1);
    expect(queue.actions[0]!.description).toMatchObject({
      autoApprovable: true,
      implementsRevert: true,
      actionKind: SEARCH_INDEX_ACTION,
    });
    const change = pending.get(1)!;
    expect(change).toMatchObject({
      op: "put",
      document: {
        id: `gadget:${PARTITION}:doc-1`,
        scope: `account:${PARTITION}`,
        vis: "scoped",
        kind: "doc",
        updatedAt: 1_000,
      },
    });
    // Nothing reaches the index until the action is applied.
    expect(queue.observations).toHaveLength(0);
  });

  it("forgets a pending change when submission fails", async () => {
    const queue = new FakeQueue();
    queue.failSubmit = true;
    const { impl, pending } = session(new FakeIndex(), queue);
    await expect(impl.put({ externalId: "d", kind: "doc", title: "t", body: "b" })).rejects.toThrow();
    expect(pending.size).toBe(0);
  });

  it("validates the document", async () => {
    const { impl } = session();
    await expect(impl.put({ externalId: "", kind: "doc", title: "t", body: "b" })).rejects.toThrow();
    await expect(
      impl.put({ externalId: "x".repeat(201), kind: "doc", title: "t", body: "b" }),
    ).rejects.toThrow(/200/u);
    await expect(
      impl.put({ externalId: "a", kind: " ", title: "t", body: "b" }),
    ).rejects.toThrow(/kind/u);
  });

  it("maps a removal onto a delete of this workspace's own id", async () => {
    const { impl, pending } = session();
    await impl.remove("doc-1");
    expect(pending.get(1)).toMatchObject({ op: "remove", documentId: `gadget:${PARTITION}:doc-1` });
  });

  it("turns an approved change into an ingest batch declaring the partition scope", () => {
    const document = prepareGadgetDocument(
      { externalId: "d", kind: "doc", title: "", body: "b" },
      PARTITION,
      7,
    );
    expect(document.title).toBe("d");
    expect(batchFor({ op: "put", document, submittedAt: 7 }, PARTITION)).toEqual({
      scopes: [{ scope: `account:${PARTITION}`, label: "This workspace", vis: "scoped" }],
      upserts: [document],
    });
    expect(batchFor({ op: "remove", documentId: "gadget:p:d", submittedAt: 7 }, PARTITION)).toEqual({
      deletes: ["gadget:p:d"],
    });
  });
});

describe("/find", () => {
  it("expands to the top hits with links and ids, after observing them", async () => {
    const index = new FakeIndex();
    const queue = new FakeQueue();
    const expanded = await expandFind(index, PARTITION, BASE, "  onboarding  ", queue);
    expect(index.searches[0]!.request).toMatchObject({ q: "onboarding", limit: 8 });
    expect(queue.observations).toHaveLength(1);
    expect(expanded.message).toContain(`[#general · Sam](${BASE}/gatekeeper/chat/c/C1/m/M1)`);
    expect(expanded.message).toContain("documentId: `chat:M1`");
    expect(expanded.message).toContain("SEARCH.open(documentId)");
  });

  it("asks for words when given none, without searching", async () => {
    const index = new FakeIndex();
    const expanded = await expandFind(index, PARTITION, BASE, " ", new FakeQueue());
    expect(index.searches).toHaveLength(0);
    expect(expanded.message).toMatch(/needs something to look for/u);
  });

  it("says so when nothing matched", async () => {
    const index = new FakeIndex();
    index.answer = result([]);
    const expanded = await expandFind(index, PARTITION, BASE, "zebra", new FakeQueue());
    expect(expanded.message).toMatch(/found nothing/u);
  });
});

describe("agent catalog", () => {
  it("lists non-empty sources after observing", async () => {
    const index = new FakeIndex();
    index.sourceList = [
      { source: "chat", label: "Team chat", documents: 12, lastUpdatedAt: 1 },
      { source: "context", label: "Context Library", documents: 0, lastUpdatedAt: null },
    ];
    const queue = new FakeQueue();
    const catalog = await searchAgentCatalog(index, PARTITION, queue);
    expect(catalog?.entries).toEqual([
      expect.objectContaining({ id: "source:chat", title: "Team chat" }),
    ]);
    expect(queue.observations).toHaveLength(1);
  });

  it("degrades to no catalog when the index fails", async () => {
    const index = new FakeIndex();
    index.sources = async () => {
      throw new Error("down");
    };
    expect(await searchAgentCatalog(index, PARTITION, new FakeQueue())).toBeNull();
  });
});

describe("helpers", () => {
  it("unescapes snippets into plain text", () => {
    expect(plainSnippet("<mark>a</mark> &amp;&lt;b&gt; &quot;c&quot; &#39;d&#39;")).toBe(`a &<b> "c" 'd'`);
  });

  it("only produces http(s) links", () => {
    expect(absoluteUrl("/x", BASE)).toBe(`${BASE}/x`);
    expect(absoluteUrl("https://github.com/o/r", BASE)).toBe("https://github.com/o/r");
    expect(absoluteUrl("javascript:alert(1)", BASE)).toBeNull();
    expect(absoluteUrl(null, BASE)).toBeNull();
  });

  it("renders the parsed query back into qualifiers", () => {
    expect(
      describeQuery({
        text: "plan",
        in: ["chat:C1"],
        from: ["sam"],
        kind: ["doc"],
        after: Date.UTC(2026, 0, 2),
      }),
    ).toBe("plan in:chat:C1 from:sam kind:doc after:2026-01-02");
  });
});
