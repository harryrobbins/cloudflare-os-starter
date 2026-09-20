// Search: qualifier parsing, the membership filter that runs before ranking, and FTS5's behaviour.
import { describe, expect, it } from "vitest";

import {
  GENERAL_CHANNEL_ID,
  type ChannelResponse,
  type SearchResult,
  type SendMessageResponse,
} from "../src/shared/protocol.js";
import { apiPath } from "../src/shared/routes.js";
import { mentionToken } from "../src/shared/validate.js";
import { client, freshWorkspace, identity, type Client } from "./helpers.js";

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

async function corpus(label: string) {
  const workspace = freshWorkspace(label);
  const alice = client(workspace, identity("alice", "Alice"));
  const bob = client(workspace, identity("bob", "Bob"));
  await bob.send("POST", apiPath("joinChannel", { channelId: GENERAL_CHANNEL_ID }));
  const design = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
    kind: "public",
    name: "design",
  });
  const secret = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
    kind: "private",
    name: "secret",
  });
  return { workspace, alice, bob, design: design.channel.id, secret: secret.channel.id };
}

describe("free text", () => {
  it("matches, highlights and ranks with bm25 ascending", async () => {
    const { alice, bob, design } = await corpus("rank");
    await post(alice, design, "deploy deploy deploy the release");
    await post(alice, design, "one mention of deploy here");
    await post(alice, GENERAL_CHANNEL_ID, "nothing relevant");

    const result = await bob.get<SearchResult>(searchPath("deploy"));
    expect(result.hits).toHaveLength(2);
    // Lower is better, so the message with three occurrences comes first.
    expect(result.hits[0]!.message.body).toContain("deploy deploy deploy");
    expect(result.hits[0]!.score).toBeLessThan(result.hits[1]!.score);
    expect(result.hits[0]!.snippet).toContain("<mark>deploy</mark>");
  });

  it("supports a prefix term and a quoted phrase", async () => {
    const { alice, design } = await corpus("prefix");
    await post(alice, design, "deployment pipeline is green");
    await post(alice, design, "pipeline deployment reversed");

    expect((await alice.get<SearchResult>(searchPath("deploy*"))).hits).toHaveLength(2);
    const phrase = await alice.get<SearchResult>(searchPath('"deployment pipeline"'));
    expect(phrase.hits).toHaveLength(1);
  });

  it("treats a term with no letters or digits as no term at all", async () => {
    const { alice, design } = await corpus("punctuation");
    await post(alice, design, "anything");
    // `"` and `*` would both be FTS5 syntax; the escaping drops them rather than passing them on.
    const result = await alice.get<SearchResult>(searchPath('" ***'));
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
  });

  it("drops an edited message's previous text from the index", async () => {
    const { alice, design } = await corpus("edit-index");
    const sent = await post(alice, design, "pelican");
    await alice.send("PATCH", apiPath("editMessage", { messageId: sent.message.id }), { body: "heron" });
    expect((await alice.get<SearchResult>(searchPath("pelican"))).hits).toHaveLength(0);
    expect((await alice.get<SearchResult>(searchPath("heron"))).hits).toHaveLength(1);
  });

  it("drops a deleted message's body from the index", async () => {
    const { alice, bob, design } = await corpus("delete-index");
    const root = await post(alice, design, "capybara");
    await post(bob, design, "reply", { rootId: root.message.id });
    await alice.send("DELETE", apiPath("deleteMessage", { messageId: root.message.id }));
    // The tombstone survives for its replies, but its text does not.
    expect((await alice.get<SearchResult>(searchPath("capybara"))).hits).toHaveLength(0);
  });
});

describe("membership", () => {
  it("never returns a hit from a channel the caller is not in", async () => {
    const { alice, bob, secret } = await corpus("membership");
    await post(alice, secret, "the passphrase is swordfish");

    expect((await bob.get<SearchResult>(searchPath("swordfish"))).hits).toHaveLength(0);
    // The member sees it.
    expect((await alice.get<SearchResult>(searchPath("swordfish"))).hits).toHaveLength(1);
  });

  it("refuses in: for a channel the caller cannot see, without confirming it exists", async () => {
    const { bob } = await corpus("in-private");
    expect(await bob.error("GET", searchPath("anything in:#secret"))).toMatchObject({
      status: 400,
      code: "invalid_request",
    });
    expect(await bob.error("GET", searchPath("anything in:#does-not-exist"))).toMatchObject({
      status: 400,
    });
  });
});

describe("qualifiers", () => {
  it("narrows by channel", async () => {
    const { alice, design } = await corpus("in");
    await post(alice, design, "shared word");
    await post(alice, GENERAL_CHANNEL_ID, "shared word");
    const result = await alice.get<SearchResult>(searchPath("shared in:#design"));
    expect(result.query.in).toEqual([design]);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.channelId).toBe(design);
  });

  it("narrows by author, by id and by name", async () => {
    const { alice, bob, design } = await corpus("from");
    await post(alice, design, "shared word");
    await post(bob, design, "shared word");

    const byId = await alice.get<SearchResult>(searchPath("shared from:@bob"));
    expect(byId.hits.map((hit) => hit.message.authorId)).toEqual(["bob"]);
    const byName = await alice.get<SearchResult>(searchPath("shared from:Bob"));
    expect(byName.hits.map((hit) => hit.message.authorId)).toEqual(["bob"]);
    const mine = await alice.get<SearchResult>(searchPath("shared from:me"));
    expect(mine.hits.map((hit) => hit.message.authorId)).toEqual(["alice"]);
  });

  it("narrows by mention with to:me", async () => {
    const { alice, bob, design } = await corpus("to");
    await post(alice, design, `question for ${mentionToken("bob")}`);
    await post(alice, design, "question for nobody");
    const result = await bob.get<SearchResult>(searchPath("question to:me"));
    expect(result.query.to).toEqual(["bob"]);
    expect(result.hits).toHaveLength(1);
  });

  it("narrows by has:link and is:thread", async () => {
    const { alice, bob, design } = await corpus("has");
    await post(alice, design, "see https://example.test/report for details");
    const root = await post(alice, design, "plain details");
    await post(bob, design, "reply with details", { rootId: root.message.id });

    expect((await alice.get<SearchResult>(searchPath("details has:link"))).hits).toHaveLength(1);
    const threaded = await alice.get<SearchResult>(searchPath("details is:thread"));
    expect(threaded.hits).toHaveLength(1);
    // A hit in a thread carries its root, so the result can show the context.
    expect(threaded.hits[0]!.root?.id).toBe(root.message.id);
  });

  it("narrows by date", async () => {
    const { alice, design } = await corpus("dates");
    await post(alice, design, "today's note");
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    expect((await alice.get<SearchResult>(searchPath(`note on:${today}`))).hits).toHaveLength(1);
    expect((await alice.get<SearchResult>(searchPath(`note before:${today}`))).hits).toHaveLength(0);
    expect((await alice.get<SearchResult>(searchPath(`note after:${tomorrow}`))).hits).toHaveLength(0);
  });

  it("runs a qualifier-only search with no text", async () => {
    const { alice, design } = await corpus("qualifier-only");
    await post(alice, design, "anything at all");
    const result = await alice.get<SearchResult>(searchPath("in:#design"));
    expect(result.query.text).toBe("");
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.score).toBe(0);
  });

  it("answers a malformed qualifier with a validation error", async () => {
    const { alice } = await corpus("malformed");
    for (const q of ["x has:video", "x is:starred", "x before:yesterday", "x on:2026-02-31", "x from:"]) {
      expect(await alice.error("GET", searchPath(q)), q).toMatchObject({
        status: 400,
        code: "invalid_request",
      });
    }
  });
});

describe("the top section and paging", () => {
  it("matches channel names and people as well as messages", async () => {
    const { alice } = await corpus("top");
    await post(alice, GENERAL_CHANNEL_ID, "design review notes");
    const result = await alice.get<SearchResult>(searchPath("design"));
    expect(result.channels.map((channel) => channel.name)).toContain("design");

    const people = await alice.get<SearchResult>(searchPath("alice"));
    expect(people.users.map((user) => user.id)).toContain("alice");
  });

  it("pages with a cursor", async () => {
    const { alice, design } = await corpus("cursor");
    for (let i = 0; i < 5; i++) await post(alice, design, `repeated term number ${i}`);

    const first = await alice.get<SearchResult>(searchPath("repeated", "&limit=2"));
    expect(first.hits).toHaveLength(2);
    expect(first.cursor).not.toBeNull();

    const second = await alice.get<SearchResult>(
      searchPath("repeated", `&limit=2&cursor=${first.cursor}`),
    );
    expect(second.hits).toHaveLength(2);
    const ids = new Set([...first.hits, ...second.hits].map((hit) => hit.message.id));
    expect(ids.size).toBe(4);

    expect(await alice.error("GET", searchPath("repeated", "&cursor=nonsense"))).toMatchObject({
      status: 400,
    });
  });
});
