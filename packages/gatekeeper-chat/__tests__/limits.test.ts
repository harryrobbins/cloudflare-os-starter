// Rate limits and the agent account's authority. Both are "who may do how much", so they share a
// suite.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  AGENT_USER_ID,
  GENERAL_CHANNEL_ID,
  RATE_LIMITS,
  type ChannelListResponse,
  type ChannelResponse,
  type MessagePageResponse,
  type SearchResult,
  type SendMessageResponse,
} from "../src/shared/protocol.js";
import { apiPath } from "../src/shared/routes.js";
import { client, freshWorkspace, identity } from "./helpers.js";

const AGENT_IDENTITY = { id: AGENT_USER_ID, email: "agent@chat.local", name: "Agent" };

describe("rate limits", () => {
  it("stops a runaway sender at the per-minute budget", async () => {
    const workspace = freshWorkspace("limit-messages");
    const alice = client(workspace, identity("alice"));
    const path = apiPath("sendMessage", { channelId: GENERAL_CHANNEL_ID });

    for (let i = 0; i < RATE_LIMITS.messagesPerMinute; i++) {
      await alice.send("POST", path, { body: `message ${i}`, clientId: `c${i}` });
    }
    const response = await alice.request("POST", path, { body: "one too many", clientId: "cN" });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await response.json()) as { error: { code: string; retryAfter: number } };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.retryAfter).toBeGreaterThan(0);
  });

  it("charges each person their own budget", async () => {
    const workspace = freshWorkspace("limit-per-user");
    const alice = client(workspace, identity("alice"));
    const bob = client(workspace, identity("bob"));
    const path = apiPath("sendMessage", { channelId: GENERAL_CHANNEL_ID });
    for (let i = 0; i < RATE_LIMITS.messagesPerMinute; i++) {
      await alice.send("POST", path, { body: `message ${i}`, clientId: `c${i}` });
    }
    expect(await alice.status("POST", path, { body: "blocked", clientId: "cx" })).toBe(429);
    expect(await bob.status("POST", path, { body: "fine", clientId: "cy" })).toBe(200);
  });

  it("does not charge a replayed send", async () => {
    const workspace = freshWorkspace("limit-replay");
    const alice = client(workspace, identity("alice"));
    const path = apiPath("sendMessage", { channelId: GENERAL_CHANNEL_ID });
    await alice.send("POST", path, { body: "once", clientId: "same" });
    for (let i = 0; i < RATE_LIMITS.messagesPerMinute + 5; i++) {
      // Every one of these is a retry of the first, so none of them costs anything.
      const replay = await alice.send<SendMessageResponse>("POST", path, { body: "once", clientId: "same" });
      expect(replay.deduped).toBe(true);
    }
  });

  it("limits searches", async () => {
    const workspace = freshWorkspace("limit-search");
    const alice = client(workspace, identity("alice"));
    const path = `${apiPath("search")}?q=anything`;
    for (let i = 0; i < RATE_LIMITS.searchesPerMinute; i++) await alice.get(path);
    expect(await alice.status("GET", path)).toBe(429);
  });

  it("survives eviction, because the window lives in SQLite", async () => {
    const workspace = freshWorkspace("limit-persisted");
    const alice = client(workspace, identity("alice"));
    const path = apiPath("sendMessage", { channelId: GENERAL_CHANNEL_ID });
    await alice.send("POST", path, { body: "one", clientId: "c1" });
    const row = await runInDurableObject(workspace, (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          `SELECT count FROM rate_limits WHERE user_id = 'alice' AND bucket = 'messages'`,
        )
        .toArray()[0],
    );
    expect(row?.count).toBe(1);
  });
});

describe("the agent account", () => {
  it("is a member of every public channel, including ones created later", async () => {
    const workspace = freshWorkspace("agent-public");
    const alice = client(workspace, identity("alice"));
    const agent = client(workspace, AGENT_IDENTITY);
    const created = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "public",
      name: "later",
    });

    const rail = await agent.get<ChannelListResponse>(apiPath("listChannels"));
    const ids = rail.memberships.map((membership) => membership.channelId).toSorted();
    expect(ids).toEqual([GENERAL_CHANNEL_ID, created.channel.id].toSorted());
  });

  it("cannot see or reach a private conversation", async () => {
    const workspace = freshWorkspace("agent-private");
    const alice = client(workspace, identity("alice"));
    const bob = client(workspace, identity("bob"));
    const agent = client(workspace, AGENT_IDENTITY);
    await bob.get(apiPath("me"));

    const secret = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "private",
      name: "secret",
    });
    const dm = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "dm",
      memberIds: ["bob"],
    });
    await alice.send("POST", apiPath("sendMessage", { channelId: secret.channel.id }), {
      body: "private word quokka",
      clientId: "c1",
    });
    await alice.send("POST", apiPath("sendMessage", { channelId: dm.channel.id }), {
      body: "direct word quokka",
      clientId: "c2",
    });

    const rail = await agent.get<ChannelListResponse>(apiPath("listChannels"));
    expect(rail.channels.map((channel) => channel.id)).not.toContain(secret.channel.id);
    expect(rail.channels.map((channel) => channel.id)).not.toContain(dm.channel.id);

    for (const channelId of [secret.channel.id, dm.channel.id]) {
      expect(await agent.error("GET", apiPath("listMessages", { channelId }))).toMatchObject({
        status: 404,
      });
      expect(
        await agent.error("POST", apiPath("sendMessage", { channelId }), {
          body: "hello",
          clientId: `x-${channelId}`,
        }),
      ).toMatchObject({ status: 404 });
    }

    // And nothing private reaches it through search either.
    const hits = await agent.get<SearchResult>(`${apiPath("search")}?q=quokka`);
    expect(hits.hits).toHaveLength(0);
  });

  it("posts as kind agent and can delete its own message again", async () => {
    const workspace = freshWorkspace("agent-post");
    const agent = client(workspace, AGENT_IDENTITY);
    const sent = await agent.send<SendMessageResponse>(
      "POST",
      apiPath("sendMessage", { channelId: GENERAL_CHANNEL_ID }),
      { body: "I looked it up", clientId: "agent-1" },
    );
    expect(sent.message.kind).toBe("agent");

    // Reverting an approved post is a delete by its author.
    await agent.send("DELETE", apiPath("deleteMessage", { messageId: sent.message.id }));
    const page = await agent.get<MessagePageResponse>(
      apiPath("listMessages", { channelId: GENERAL_CHANNEL_ID }),
    );
    expect(page.messages).toHaveLength(0);
  });

  it("cannot delete somebody else's message", async () => {
    const workspace = freshWorkspace("agent-delete-other");
    const alice = client(workspace, identity("alice"));
    const agent = client(workspace, AGENT_IDENTITY);
    const sent = await alice.send<SendMessageResponse>(
      "POST",
      apiPath("sendMessage", { channelId: GENERAL_CHANNEL_ID }),
      { body: "mine", clientId: "c1" },
    );
    expect(
      await agent.error("DELETE", apiPath("deleteMessage", { messageId: sent.message.id })),
    ).toMatchObject({ status: 403 });
  });

  it("cannot leave a public channel", async () => {
    const workspace = freshWorkspace("agent-leave");
    const agent = client(workspace, AGENT_IDENTITY);
    expect(
      await agent.error("POST", apiPath("leaveChannel", { channelId: GENERAL_CHANNEL_ID })),
    ).toMatchObject({ status: 403 });
  });
});
