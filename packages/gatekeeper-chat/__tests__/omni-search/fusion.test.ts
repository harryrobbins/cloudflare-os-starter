// Omni-search fusion: dense recall merged into chat's own search, with chat's ACL still in charge.
//
// Runs in the `omni-search` project. Dense recall is scripted per query text on the mock
// SearchService (__tests__/aux/search-service.js), so every test uses a query word of its own.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { DenseRecallHit } from "../../src/search-client.js";
import {
  GENERAL_CHANNEL_ID,
  type ChannelResponse,
  type SearchResult,
  type SendMessageResponse,
} from "../../src/shared/protocol.js";
import { apiPath } from "../../src/shared/routes.js";
import { client, freshWorkspace, identity, type Client } from "../helpers.js";

const control = env.SEARCH_CONTROL;

function word(label: string): string {
  return `${label}${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function searchPath(q: string, extra = ""): string {
  return `${apiPath("search")}?q=${encodeURIComponent(q)}${extra}`;
}

function post(who: Client, channelId: string, body: string, extra: Record<string, unknown> = {}) {
  return who.send<SendMessageResponse>("POST", apiPath("sendMessage", { channelId }), {
    body,
    clientId: `c-${crypto.randomUUID().slice(0, 8)}`,
    ...extra,
  });
}

function hits(...messageIds: string[]): DenseRecallHit[] {
  return messageIds.map((id, index) => ({ documentId: `chat:${id}`, rank: index + 1, score: 0.9 - index / 100 }));
}

async function corpus(label: string) {
  const workspace = freshWorkspace(label);
  const alice = client(workspace, identity("alice", "Alice"));
  const bob = client(workspace, identity("bob", "Bob"));
  await bob.send("POST", apiPath("joinChannel", { channelId: GENERAL_CHANNEL_ID }));
  const design = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), { kind: "public", name: "design" });
  const secret = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), { kind: "private", name: "secret" });
  return { workspace, alice, bob, design: design.channel.id, secret: secret.channel.id };
}

describe("fusion", () => {
  it("adds a dense-only hit the caller can see and ranks by reciprocal rank fusion", async () => {
    const { alice, bob, design, secret } = await corpus("fuse-add");
    const q = word("roadmap");
    const lexical = await post(alice, design, `the ${q} for widgets`);
    const meaning = await post(bob, design, "where we plan the next quarter's gadgets <mark>not a mark</mark>");
    const hidden = await post(alice, secret, "private plans for the quarter");
    await control.script(q, { hits: hits(meaning.message.id, hidden.message.id, lexical.message.id) });

    const result = await bob.get<SearchResult>(searchPath(q));
    const ids = result.hits.map((hit) => hit.message.id);
    // The lexical hit is in both lists, so it outranks the dense-only one; the private message is
    // dropped because Bob cannot see #secret.
    expect(ids).toEqual([lexical.message.id, meaning.message.id]);
    expect(result.hits[0]!.snippet).toContain(`<mark>${q}</mark>`);
    expect(result.hits[1]!.snippet).toBe("where we plan the next quarter's gadgets not a mark");
    expect(result.hits[1]!.channelId).toBe(design);
    // Lower is still better: the negated fused score.
    expect(result.hits[0]!.score).toBeCloseTo(-(1 / 61 + 1 / 63), 10);
    expect(result.hits[1]!.score).toBeCloseTo(-(1 / 61), 10);
    expect(result.hits[0]!.score).toBeLessThan(result.hits[1]!.score);

    // Only Bob's searchable channels were offered to search.
    const request = (await control.recalls(q)).at(-1)!;
    expect(request.source).toBe("chat");
    expect(request.limit).toBe(100);
    expect(request.scopes).toContain(`chat:${design}`);
    expect(request.scopes).toContain(`chat:${GENERAL_CHANNEL_ID}`);
    expect(request.scopes).not.toContain(`chat:${secret}`);

    // Alice is a member, so the same dense hit is hers to see.
    const mine = await alice.get<SearchResult>(searchPath(q));
    expect(mine.hits.map((hit) => hit.message.id)).toContain(hidden.message.id);
  });

  it("drops a dense hit that is deleted, unknown, from another source, or fails a qualifier", async () => {
    const { alice, bob, design } = await corpus("fuse-filter");
    const q = word("gizmo");
    const byBob = await post(bob, design, "a thought about gadgets");
    const byAlice = await post(alice, design, "another thought about gadgets");
    const doomed = await post(alice, design, "this one will be deleted");
    await alice.send("DELETE", apiPath("deleteMessage", { messageId: doomed.message.id }));
    await control.script(q, {
      hits: [
        ...hits(doomed.message.id, byBob.message.id, byAlice.message.id, "m_does_not_exist"),
        { documentId: `context:${byBob.message.id}`, rank: 5, score: 0.1 },
      ],
    });

    const all = await alice.get<SearchResult>(searchPath(q));
    expect(all.hits.map((hit) => hit.message.id)).toEqual([byBob.message.id, byAlice.message.id]);

    const fromAlice = await alice.get<SearchResult>(searchPath(`${q} from:alice`));
    expect(fromAlice.hits.map((hit) => hit.message.id)).toEqual([byAlice.message.id]);

    const inGeneral = await alice.get<SearchResult>(searchPath(`${q} in:#general`));
    expect(inGeneral.hits).toEqual([]);
    const narrowed = (await control.recalls(q)).at(-1)!;
    expect(narrowed.scopes).toEqual([`chat:${GENERAL_CHANNEL_ID}`]);

    const threads = await alice.get<SearchResult>(searchPath(`${q} is:thread`));
    expect(threads.hits).toEqual([]);
  });

  it("falls back to lexical results, exactly, when dense recall fails, is off or times out", async () => {
    const { alice, design } = await corpus("fuse-fallback");
    const failing = word("pelican");
    const off = word("heron");
    const slow = word("egret");
    const other = await post(alice, design, "not lexically related");
    for (const q of [failing, off, slow]) {
      await post(alice, design, `${q} ${q} twice`);
      await post(alice, design, `${q} once`);
    }
    await control.script(failing, { error: "Vectorize is down" });
    await control.script(off, { dense: "unavailable", hits: hits(other.message.id) });
    await control.script(slow, { hangMs: 3000, hits: hits(other.message.id) });

    for (const q of [failing, off, slow]) {
      const started = Date.now();
      const result = await alice.get<SearchResult>(searchPath(q));
      expect(Date.now() - started).toBeLessThan(2900);
      expect(result.hits).toHaveLength(2);
      expect(result.hits[0]!.message.body).toBe(`${q} ${q} twice`);
      // bm25 values, not fused ones: exactly the lexical-only answer.
      expect(result.hits[0]!.score).toBeLessThan(result.hits[1]!.score);
      expect(result.hits[0]!.score).toBeLessThan(-1e-6);
      expect(result.hits.map((hit) => hit.message.id)).not.toContain(other.message.id);
    }
  });

  it("skips dense recall for a qualifier-only search", async () => {
    const { alice, design } = await corpus("fuse-qualifiers");
    await post(alice, design, "anything at all");
    const before = (await control.recalls("")).length;
    const result = await alice.get<SearchResult>(searchPath("from:alice"));
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits.every((hit) => hit.score === 0)).toBe(true);
    expect((await control.recalls("")).length).toBe(before);
  });

  it("pages over the fused list without skipping or repeating a hit", async () => {
    const { alice, design } = await corpus("fuse-paging");
    const q = word("otter");
    const lexical: string[] = [];
    for (let i = 0; i < 5; i++) lexical.push((await post(alice, design, `${q} note ${i}`)).message.id);
    const dense: string[] = [];
    for (let i = 0; i < 3; i++) dense.push((await post(alice, design, `semantic neighbour ${i}`)).message.id);
    await control.script(q, { hits: hits(dense[0]!, lexical[4]!, dense[1]!, dense[2]!) });

    const whole = await alice.get<SearchResult>(searchPath(q, "&limit=50"));
    expect(whole.hits).toHaveLength(8);
    expect(whole.cursor).toBeNull();

    const paged: string[] = [];
    let cursor: string | null = "";
    for (let page = 0; page < 10 && cursor !== null; page++) {
      const result: SearchResult = await alice.get<SearchResult>(
        searchPath(q, `&limit=3${cursor === "" ? "" : `&cursor=${cursor}`}`),
      );
      paged.push(...result.hits.map((hit) => hit.message.id));
      cursor = result.cursor;
    }
    expect(paged).toEqual(whole.hits.map((hit) => hit.message.id));
    expect(new Set(paged).size).toBe(8);
  });
});
