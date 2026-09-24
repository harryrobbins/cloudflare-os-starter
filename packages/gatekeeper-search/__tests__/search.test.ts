// Hybrid retrieval: ACL for each caller kind, qualifiers, escaping, fusion, fallbacks, snippets, paging.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { INPUT_ERROR_PREFIX, SEARCH_LIMITS, type Facet, type OmniSearchResult, type SearchCaller } from "../src/shared/contract.js";
import { MAX_FILTER_BYTES, scopeFilters } from "../src/dense.js";
import { fuse } from "../src/do/retrieve.js";
import { RATE_LIMIT_PREFIX, SEARCH_BUDGET } from "../src/do/limits.js";
import { parseQuery, ftsMatchString } from "../src/shared/query.js";
import { denseOff } from "./support/fake-dense.js";
import {
  alice,
  bob,
  carol,
  chatDoc,
  daysAfter,
  embedPending,
  failure,
  freshIndex,
  T0,
  type Fixture,
} from "./helpers.js";

function ids(result: OmniSearchResult): string[] {
  return result.hits.map((hit) => hit.documentId);
}

function facet(result: OmniSearchResult, field: Facet["field"]): Record<string, number> {
  const found = result.facets.find((entry) => entry.field === field);
  return Object.fromEntries((found?.values ?? []).map((value) => [value.value, value.count]));
}

/**
 * #general (public), #secret (alice only), a context collection (public), and one gadget document in
 * agent account acct-1's private partition.
 */
async function corpus(label: string): Promise<Fixture> {
  const fixture = freshIndex(label);
  await fixture.index.ingest("chat", {
    scopes: [
      { scope: "chat:general", label: "#general", vis: "all" },
      { scope: "chat:secret", label: "#secret", vis: "scoped" },
    ],
    principals: [{ scope: "chat:secret", replace: ["u-alice"] }],
    upserts: [
      chatDoc("g1", "The kubernetes cluster upgrade is scheduled", { updatedAt: daysAfter(1) }),
      chatDoc("g2", "Lunch menu for friday", { author: "Bob", authorId: "u-bob", updatedAt: daysAfter(2) }),
      chatDoc("s1", "Secret kubernetes budget numbers", {
        scope: "chat:secret",
        vis: "scoped",
        updatedAt: daysAfter(3),
      }),
    ],
  });
  await fixture.index.ingest("context", {
    upserts: [
      {
        id: "context:doc1",
        kind: "doc",
        title: "Kubernetes handbook",
        url: "https://docs.example.test/k8s",
        scope: "context:lib",
        vis: "all",
        body: "How we run the cluster.",
        workspace: "ws-1",
        author: "Carol",
        authorId: "u-carol",
        createdAt: T0,
        updatedAt: daysAfter(40),
      },
    ],
  });
  await fixture.index.ingest("gadget", {
    upserts: [
      {
        id: "gadget:acct-1:n1",
        kind: "note",
        title: "Agent note",
        url: null,
        scope: "account:acct-1",
        vis: "scoped",
        body: "kubernetes scratchpad for the agent",
        createdAt: T0,
        updatedAt: T0,
      },
    ],
  });
  await embedPending(fixture);
  return fixture;
}

describe("ACL", () => {
  it("a person sees vis:all plus their scopes, in hits and in facet counts", async () => {
    const { index } = await corpus("acl-person");
    const asAlice = await index.search(alice, { q: "kubernetes" });
    expect(ids(asAlice).sort()).toEqual(["chat:g1", "chat:s1", "context:doc1"]);
    expect(facet(asAlice, "scope")).toMatchObject({ "chat:secret": 1, "chat:general": 1 });

    const asBob = await index.search(bob, { q: "kubernetes" });
    expect(ids(asBob).sort()).toEqual(["chat:g1", "context:doc1"]);
    // The private document must not leak through any count.
    expect(facet(asBob, "scope")["chat:secret"]).toBeUndefined();
    expect(facet(asBob, "source")).toEqual({ chat: 1, context: 1 });
    expect(facet(asBob, "author")).toEqual({ Alice: 1, Carol: 1 });
    // The dense half ran and still only returned what bob may see.
    expect(asBob.dense).toBe("ok");
    expect(asBob.hits.every((hit) => hit.scope !== "chat:secret" && hit.scope !== "account:acct-1")).toBe(true);
  });

  it("a delegated caller sees exactly its scopes, restricted to its own source, never vis:all", async () => {
    const { index } = await corpus("acl-delegated");
    const caller: SearchCaller = { kind: "delegated", source: "chat", scopes: ["chat:secret", "context:lib"] };
    const result = await index.search(caller, { q: "kubernetes" });
    expect(ids(result)).toEqual(["chat:s1"]);
    expect(facet(result, "source")).toEqual({ chat: 1 });
  });

  it("an agent sees vis:all plus its own account partition only", async () => {
    const { index } = await corpus("acl-agent");
    const mine = await index.search({ kind: "agent", accountId: "acct-1" }, { q: "kubernetes" });
    expect(ids(mine).sort()).toEqual(["chat:g1", "context:doc1", "gadget:acct-1:n1"]);
    const other = await index.search({ kind: "agent", accountId: "acct-2" }, { q: "kubernetes" });
    expect(ids(other).sort()).toEqual(["chat:g1", "context:doc1"]);
    expect(facet(other, "source")["gadget"]).toBeUndefined();
  });

  it("open() and sources() apply the same ACL", async () => {
    const { index } = await corpus("acl-open");
    expect((await index.open(alice, "chat:s1"))?.text).toContain("budget");
    expect(await index.open(bob, "chat:s1")).toBeNull();
    expect(await index.open(bob, "chat:nope")).toBeNull();
    const sources = await index.sources(bob);
    expect(sources.find((s) => s.source === "chat")?.documents).toBe(2);
    expect(sources.find((s) => s.source === "gadget")?.documents).toBe(0);
    expect(sources.find((s) => s.source === "context")?.label).toBe("Context Library");
  });

  it("dense queries: {vis:all} plus an $in for a person, only the $in for a delegated caller", async () => {
    const { index, dense } = await corpus("acl-filters");
    dense.filters.length = 0;
    await index.search(alice, { q: "kubernetes" });
    expect(dense.filters).toEqual([{ vis: "all" }, { scope: { $in: ["chat:secret"] } }]);

    dense.filters.length = 0;
    await index.search({ kind: "delegated", source: "chat", scopes: ["chat:secret", "chat:general"] }, { q: "cluster" });
    expect(dense.filters).toEqual([{ scope: { $in: ["chat:secret", "chat:general"] } }]);
  });

  it("fans a long scope list out so every filter stays under 2048 bytes", () => {
    const scopes = Array.from({ length: 300 }, (_, i) => `chat:channel-${String(i).padStart(4, "0")}`);
    const filters = scopeFilters({ source: "chat" }, scopes);
    expect(filters.length).toBeGreaterThan(1);
    const covered = filters.flatMap((filter) => (filter.scope as { $in: string[] }).$in);
    expect(covered).toEqual(scopes);
    for (const filter of filters) {
      expect(new TextEncoder().encode(JSON.stringify(filter)).length).toBeLessThan(MAX_FILTER_BYTES);
      expect(filter.source).toBe("chat");
    }
  });

  it("a person with hundreds of private scopes still searches (fan-out end to end)", async () => {
    const fixture = freshIndex("fanout");
    const scopes = Array.from({ length: 250 }, (_, i) => `chat:room-${i}`);
    await fixture.index.ingest("chat", {
      principals: scopes.map((scope) => ({ scope, add: ["u-alice"] })),
      upserts: [chatDoc("r249", "needle in room", { scope: "chat:room-249", vis: "scoped" })],
    });
    await embedPending(fixture);
    const result = await fixture.index.search(alice, { q: "needles" });
    expect(ids(result)).toEqual(["chat:r249"]);
    expect(fixture.dense.filters.length).toBeGreaterThan(2);
  });
});

describe("qualifiers", () => {
  it("parses the grammar, strips quotes from values and resolves dates like chat", () => {
    const parsed = parseQuery('deploy in:#general from:"Jane Okafor" source:Chat kind:doc workspace:"x y" before:2026-09-10 after:2026-09-01');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      terms: ["deploy"],
      in: ["#general"],
      from: ["Jane Okafor"],
      source: ["chat"],
      kind: ["doc"],
      workspace: ["x y"],
      before: Date.UTC(2026, 8, 10) - 1,
      after: Date.UTC(2026, 8, 2),
    });
    const on = parseQuery("on:2026-09-05");
    expect(on.ok && on.value).toMatchObject({ after: Date.UTC(2026, 8, 5), before: Date.UTC(2026, 8, 6) - 1 });
    expect(parseQuery("before:2026-02-31").ok).toBe(false);
    expect(parseQuery("from:").ok).toBe(false);
  });

  it("in: by label and by raw scope id; an invisible scope is reported as unknown", async () => {
    const { index } = await corpus("q-in");
    expect(ids(await index.search(alice, { q: "kubernetes in:#secret" }))).toEqual(["chat:s1"]);
    expect(ids(await index.search(alice, { q: "kubernetes in:chat:general" }))).toEqual(["chat:g1"]);
    expect(await failure(index.search(bob, { q: "kubernetes in:#secret" }))).toContain("No scope called #secret");
    expect(await failure(index.search(bob, { q: "in:#nope" }))).toContain("No scope called #nope");
    expect(await failure(index.search(bob, { q: "in:chat:secret" }))).toContain(INPUT_ERROR_PREFIX);
  });

  it("from:, source:, kind:, workspace: and dates filter both halves", async () => {
    const { index } = await corpus("q-filters");
    expect(ids(await index.search(bob, { q: "from:bob" }))).toEqual(["chat:g2"]);
    expect(ids(await index.search(bob, { q: 'from:"Carol" kubernetes' }))).toEqual(["context:doc1"]);
    expect(ids(await index.search(bob, { q: "from:me" }))).toEqual(["chat:g2"]);
    expect(ids(await index.search(bob, { q: "kubernetes source:context" }))).toEqual(["context:doc1"]);
    expect(ids(await index.search(bob, { q: "kubernetes kind:doc" }))).toEqual(["context:doc1"]);
    expect(ids(await index.search(bob, { q: "workspace:ws-1" }))).toEqual(["context:doc1"]);
    const onDay2 = new Date(daysAfter(2)).toISOString().slice(0, 10);
    expect(ids(await index.search(bob, { q: `on:${onDay2}` }))).toEqual(["chat:g2"]);
    const day3 = new Date(daysAfter(3)).toISOString().slice(0, 10);
    expect(ids(await index.search(bob, { q: `kubernetes after:${day3}` }))).toEqual(["context:doc1"]);
    // A qualifier the dense half cannot express (workspace) is still enforced on dense hits.
    expect(ids(await index.search(bob, { q: "clusters workspace:ws-9" }))).toEqual([]);
    const echoed = await index.search(bob, { q: "kubernetes source:chat kind:message" });
    expect(echoed.query).toMatchObject({ text: "kubernetes", source: ["chat"], kind: ["message"] });
  });

  it("from:me needs a person", async () => {
    const { index } = await corpus("q-me");
    expect(await failure(index.search({ kind: "agent", accountId: "a" }, { q: "from:me" }))).toContain("from:me");
  });

  it("qualifiers alone list the newest visible documents", async () => {
    const { index } = await corpus("q-only");
    const result = await index.search(bob, { q: "source:chat" });
    expect(ids(result)).toEqual(["chat:g2", "chat:g1"]);
    const everything = await index.search(bob, { q: "" });
    expect(ids(everything)).toEqual(["context:doc1", "chat:g2", "chat:g1"]);
    expect(facet(everything, "month")).toEqual({ "2026-09": 2, "2026-10": 1 });
    const month = everything.facets.find((entry) => entry.field === "month")!;
    expect(month.values.find((value) => value.value === "2026-10")?.label).toBe("Oct 2026");
  });
});

describe("hostile input", () => {
  it("never hands FTS5 syntax through", () => {
    expect(ftsMatchString(['"', "***", "AND", "NEAR(a", "-x", "col:val", "^start"])).toBe(
      '"AND" "NEAR(a" "-x" "col:val" "^start"',
    );
    expect(ftsMatchString(["deploy*"])).toBe('"deploy"*');
  });

  it("answers operator soup with results or a 400, never a crash", async () => {
    const { index } = await corpus("hostile");
    for (const q of ['" OR 1=1 --', "NEAR(kubernetes cluster)", "kubernetes AND OR NOT", "*", "' ; DROP TABLE documents; --", "{kubernetes}", "cluster^2"]) {
      const result = await index.search(alice, { q });
      expect(Array.isArray(result.hits)).toBe(true);
    }
    expect((await index.stats()).documents).toBe(5);
    expect(await failure(index.search(alice, { q: "x".repeat(SEARCH_LIMITS.maxQueryChars + 1) }))).toContain(INPUT_ERROR_PREFIX);
    expect(await failure(index.search(alice, { q: Array.from({ length: 17 }, (_, i) => `t${i}`).join(" ") }))).toContain("terms");
    expect(await failure(index.search(alice, { q: "x", cursor: "abc" }))).toContain("cursor");
  });
});

describe("fusion", () => {
  it("RRF sums reciprocal ranks, so a document found by both halves beats one found by one", () => {
    const fused = fuse(
      [
        { doc: "a", chunk: "ca", snip: "" },
        { doc: "b", chunk: "cb", snip: "" },
      ],
      [
        { doc: "c", chunk: "cc", score: 0.9 },
        { doc: "b", chunk: "cb", score: 0.8 },
      ],
    );
    expect(fused.map((c) => c.doc)).toEqual(["b", "a", "c"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 62 + 1 / 62);
  });

  it("end to end: both-halves hit first, then lexical-only and dense-only", async () => {
    const fixture = freshIndex("rrf");
    await fixture.index.ingest("chat", {
      upserts: [
        // Lexical ("deployment" is a word here) and dense.
        chatDoc("both", "deployment rollback guide"),
        // Dense only: FTS5 does not stem "deployments" to "deployment"... but the fake does.
        chatDoc("dense", "notes on deployments"),
      ],
    });
    await embedPending(fixture);
    const result = await fixture.index.search(alice, { q: "deployment" });
    expect(ids(result)).toEqual(["chat:both", "chat:dense"]);
    // Both score 1.0 in the fake, so their dense ranks are 1 and 2 in some order; fusion still puts
    // the document both halves found first.
    expect(result.hits[0]).toMatchObject({ lexicalRank: 1, denseRank: expect.any(Number) });
    expect(result.hits[1]).toMatchObject({ lexicalRank: null, denseRank: expect.any(Number) });
    expect(result.hits[0]!.score).toBeGreaterThan(result.hits[1]!.score);
    // The dense-only hit's snippet is the escaped opening of its chunk.
    expect(result.hits[1]!.snippet).toBe("notes on deployments");
  });

  it("falls back to lexical when the dense half fails, and says so", async () => {
    const fixture = await corpus("dense-down");
    fixture.dense.failing = true;
    const result = await fixture.index.search(bob, { q: "kubernetes" });
    expect(result.dense).toBe("unavailable");
    expect(ids(result).sort()).toEqual(["chat:g1", "context:doc1"]);
    expect(result.hits.every((hit) => hit.denseRank === null)).toBe(true);
  });

  it("reports dense off without AI/VECTORS bindings", async () => {
    const fixture = freshIndex("dense-off");
    denseOff(fixture.instance);
    await fixture.index.ingest("chat", { upserts: [chatDoc("m1", "offline search")] });
    const result = await fixture.index.search(alice, { q: "offline" });
    expect(result.dense).toBe("off");
    expect(ids(result)).toEqual(["chat:m1"]);
    expect(await fixture.index.denseRecall({ kind: "delegated", source: "chat", scopes: ["chat:general"] }, { text: "x", scopes: [] })).toEqual({
      hits: [],
      dense: "off",
    });
  });

  it("reranks the fused top when RERANK is on", async () => {
    const fixture = freshIndex("rerank");
    await fixture.index.ingest("chat", {
      upserts: [chatDoc("a", "apple apple apple pie"), chatDoc("b", "apple crumble")],
    });
    await embedPending(fixture);
    const before = await fixture.index.search(alice, { q: "apple" });
    expect(ids(before)[0]).toBe("chat:a");
    fixture.dense.rerankScores = (_query, texts) => texts.map((text) => (text.includes("crumble") ? 10 : 1));
    await runInDurableObject(fixture.index, async (instance) => {
      const ctxEnv = (instance as unknown as { env: { RERANK: string } }).env;
      ctxEnv.RERANK = "1";
    });
    const after = await fixture.index.search(alice, { q: "apple" });
    expect(ids(after)[0]).toBe("chat:b");
    void env;
  });
});

describe("snippets and paging", () => {
  it("escapes the body and keeps only the <mark> markup", async () => {
    const fixture = freshIndex("escape");
    await fixture.index.ingest("chat", {
      upserts: [chatDoc("x", 'Beware <script>alert("pwned")</script> & the payload < here')],
    });
    const result = await fixture.index.search(alice, { q: "payload" });
    const snippet = result.hits[0]!.snippet;
    expect(snippet).toContain("<mark>payload</mark>");
    expect(snippet).toContain("&lt;script&gt;");
    expect(snippet).not.toContain("<script>");
    expect(snippet.replaceAll("<mark>", "").replaceAll("</mark>", "")).not.toMatch(/<|>/);
  });

  it("strips the snippet sentinels from bodies so they cannot forge marks", async () => {
    const fixture = freshIndex("sentinel");
    await fixture.index.ingest("chat", { upserts: [chatDoc("x", "fake \u0001mark\u0002 around keyword")] });
    const result = await fixture.index.search(alice, { q: "keyword" });
    expect(result.hits[0]!.snippet).toBe("fake mark around <mark>keyword</mark>");
  });

  it("pages the fused list with an opaque cursor", async () => {
    const fixture = freshIndex("paging");
    await fixture.index.ingest("chat", {
      upserts: Array.from({ length: 7 }, (_, i) => chatDoc(`p${i}`, `paging item ${i}`, { updatedAt: daysAfter(i) })),
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page: OmniSearchResult = await fixture.index.search(alice, { q: "paging", limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...ids(page));
      cursor = page.cursor ?? undefined;
      pages++;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    // Facets can be skipped.
    expect((await fixture.index.search(alice, { q: "paging", facets: false })).facets).toEqual([]);
  });
});

describe("denseRecall (chat's phase-1 fusion)", () => {
  it("returns ranked documents within the given scopes and source only", async () => {
    const { index } = await corpus("recall");
    const result = await index.denseRecall(
      { kind: "delegated", source: "chat", scopes: ["chat:general", "context:lib"] },
      { text: "kubernetes clusters", scopes: ["chat:general", "context:lib"] },
    );
    expect(result.dense).toBe("ok");
    expect(result.hits.map((hit) => hit.documentId)).toEqual(["chat:g1"]);
    expect(result.hits[0]).toMatchObject({ rank: 1 });
    expect(result.hits[0]!.score).toBeGreaterThan(0.5);
  });

  it("reports unavailable when the dense half fails", async () => {
    const fixture = await corpus("recall-down");
    fixture.dense.failing = true;
    const result = await fixture.index.denseRecall(
      { kind: "delegated", source: "chat", scopes: ["chat:general"] },
      { text: "kubernetes", scopes: ["chat:general"] },
    );
    expect(result).toEqual({ hits: [], dense: "unavailable" });
  });
});

describe("rate limit", () => {
  it("limits a person's searches per window", async () => {
    const fixture = freshIndex("rate");
    for (let i = 0; i < SEARCH_BUDGET.limit; i++) await fixture.index.search(carol, { q: "", facets: false });
    expect(await failure(fixture.index.search(carol, { q: "" }))).toContain(RATE_LIMIT_PREFIX);
    // Other people and non-person callers are unaffected.
    await fixture.index.search(bob, { q: "" });
    await fixture.index.search({ kind: "agent", accountId: "a" }, { q: "" });
  });
});
