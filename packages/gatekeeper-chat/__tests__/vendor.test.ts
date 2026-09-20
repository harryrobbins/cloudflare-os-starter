// Stream D: the Gatekeeper vendor.
//
// The bridge is injected rather than real, for two reasons. Streams A and B are still filling the
// Durable Object's routes in, so most of them answer `501 not_implemented` today; and the properties
// worth pinning here -- that nothing is returned before `authorizeObservation()` resolves, that a
// post does not reach chat until it is approved, that private channels are unreachable -- are
// properties of this code, not of SQLite.

import { describe, expect, it } from "vitest";
import TYPES_DTS from "../src/vendor/types.d.ts?raw";

import {
  applyChatPost,
  boundedLimit,
  chatAgentCatalog,
  chatHomeUrl,
  describeChatAccount,
  describeChatResource,
  describeChatVendor,
  rejectChatPost,
  revertChatPost,
  ChatApiError,
  ChatSessionImpl,
  MAX_AGENT_LIMIT,
  type AppliedChatPost,
  type ChatActionStore,
  type ChatBridge,
  type PendingChatPost,
} from "../src/vendor/index.js";
import TYPES_CODE from "../src/vendor/types-code.js";
import type {
  ActionDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type {
  Channel,
  ChannelListResponse,
  DeleteMessageResponse,
  Message,
  MessagePageResponse,
  SearchResult,
  SendMessageRequest,
  SendMessageResponse,
  User,
} from "../src/shared/protocol.js";

// --- fixtures ---------------------------------------------------------------

function user(id: string, name: string): User {
  return {
    id,
    name,
    email: `${id}@example.test`,
    avatarKey: null,
    firstSeenAt: 0,
    lastSeenAt: 0,
    tz: null,
    online: false,
  };
}

function channel(id: string, overrides: Partial<Channel> = {}): Channel {
  return {
    id,
    kind: "public",
    name: id,
    topic: null,
    purpose: null,
    createdBy: "u1",
    createdAt: 0,
    archived: false,
    memberCount: 3,
    lastSeq: 10,
    ...overrides,
  };
}

function message(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    channelId: "general",
    seq: 1,
    rootId: null,
    authorId: "u1",
    body: "hello",
    kind: "user",
    createdAt: 1_700_000_000_000,
    editedAt: null,
    deletedAt: null,
    replyCount: 0,
    lastReplyAt: null,
    reactions: [],
    attachments: [],
    mentions: [],
    ...overrides,
  };
}

/** Records every call, and answers with whatever the test put in front of it. */
class FakeBridge implements ChatBridge {
  channels: Channel[] = [channel("general"), channel("random")];
  users: User[] = [user("u1", "Ada")];
  page: MessagePageResponse = {
    messages: [message("m1")],
    hasMoreBefore: false,
    hasMoreAfter: false,
    users: this.users,
    channelLastSeq: 10,
  };
  searchResult: SearchResult = {
    query: { text: "" },
    hits: [],
    channels: [],
    users: this.users,
    cursor: null,
  };
  sendResponse: SendMessageResponse = {
    message: message("posted"),
    deduped: false,
    badges: { unread: {}, mentions: {}, threads: 0 },
  };
  failWith: Error | null = null;

  readonly listMessagesCalls: { channelId: string; query: unknown }[] = [];
  readonly searchCalls: { query: string; options: unknown }[] = [];
  readonly sendCalls: { channelId: string; request: SendMessageRequest }[] = [];
  readonly deleteCalls: string[] = [];
  listChannelsCalls = 0;

  async listChannels(): Promise<ChannelListResponse> {
    this.listChannelsCalls += 1;
    if (this.failWith !== null) throw this.failWith;
    return { channels: this.channels, memberships: [], users: this.users, badges: { unread: {}, mentions: {}, threads: 0 } };
  }

  async listMessages(channelId: string, query: unknown): Promise<MessagePageResponse> {
    this.listMessagesCalls.push({ channelId, query });
    return this.page;
  }

  async search(query: string, options: unknown): Promise<SearchResult> {
    this.searchCalls.push({ query, options });
    return this.searchResult;
  }

  async sendMessage(channelId: string, request: SendMessageRequest): Promise<SendMessageResponse> {
    this.sendCalls.push({ channelId, request });
    if (this.failWith !== null) throw this.failWith;
    return this.sendResponse;
  }

  async deleteMessage(messageId: string): Promise<DeleteMessageResponse> {
    this.deleteCalls.push(messageId);
    if (this.failWith !== null) throw this.failWith;
    return { id: messageId, channelId: "general", tombstone: null };
  }
}

/** Records observations and actions, and can be told to refuse. */
class FakeQueue {
  readonly observations: ObservationDescription[] = [];
  readonly actions: { action: number; description: ActionDescription }[] = [];
  refuse: Error | null = null;
  disposed = false;

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description);
    if (this.refuse !== null) throw this.refuse;
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    this.actions.push({ action, description });
    if (this.refuse !== null) throw this.refuse;
  }

  [Symbol.dispose](): void {
    this.disposed = true;
  }
}

/** The facet's action storage, in a Map. */
function memoryStore(): ChatActionStore & { pending: Map<number, PendingChatPost> } {
  const pending = new Map<number, PendingChatPost>();
  const applied = new Map<number, AppliedChatPost>();
  let last = 0;
  return {
    pending,
    nextActionId: () => (last += 1),
    putPending: (action, post) => void pending.set(action, post),
    getPending: (action) => pending.get(action),
    deletePending: (action) => void pending.delete(action),
    putApplied: (action, record) => void applied.set(action, record),
    getApplied: (action) => applied.get(action),
    deleteApplied: (action) => void applied.delete(action),
  };
}

function newSession(bridge: FakeBridge, queue: FakeQueue, store = memoryStore()) {
  return new ChatSessionImpl({
    approvalQueue: queue,
    bridge,
    actions: store,
    now: () => 1_700_000_000_000,
    newClientId: () => "fixed-client-id",
  });
}

// --- descriptions -----------------------------------------------------------

describe("the team chat vendor", () => {
  it("auto-provisions a singleton account with no UI of its own", () => {
    expect(describeChatVendor("https://chat.example.test/gatekeeper/chat/")).toMatchObject({
      displayName: "Team chat",
      url: "https://chat.example.test/gatekeeper/chat/",
      autoProvisionsAccount: true,
      providesAuth: false,
    });
    expect(describeChatVendor("https://chat.example.test/").logo?.url).toMatch(/^data:image\/svg\+xml,/);

    const account = describeChatAccount();
    expect(account).toMatchObject({ displayName: "Team chat", singleton: { tsType: "ChatSession" } });
    expect(account.providesUi).toBeUndefined();

    expect(describeChatResource()).toMatchObject({
      url: "chat://main",
      title: "Team chat",
      suggestedBindingName: "CHAT",
      tsType: "ChatSession",
    });
  });

  it("links to this deployment's own chat app, and survives an unusable base URL", () => {
    expect(chatHomeUrl({ PUBLIC_BASE_URL: "https://cfos.example.test" })).toBe(
      "https://cfos.example.test/gatekeeper/chat/",
    );
    expect(chatHomeUrl({ PUBLIC_BASE_URL: "" })).toMatch(/^https:\/\//);
  });
});

describe("the published types", () => {
  it("are the file tsc checks, byte for byte", () => {
    expect(TYPES_CODE).toBe(TYPES_DTS);
  });

  it("declare the whole session surface and how to write a mention", () => {
    for (const member of [
      "interface ChatSession",
      "listChannels(): Promise<ChatChannelInfo[]>",
      "readMessages(channelId: string, options?: ChatReadOptions): Promise<ChatMessagePage>",
      "readThread(channelId: string, rootId: string, options?: ChatReadOptions)",
      "search(query: string, options?: ChatSearchOptions): Promise<ChatSearchResult>",
      "postMessage(channelId: string, text: string, options?: ChatPostOptions): Promise<void>",
      "<@U123>",
      "<@agent>",
    ]) {
      expect(TYPES_CODE).toContain(member);
    }
    // The agent has to be told that a post is not sent until somebody approves it, and who it
    // appears as -- the plan's "posting is an action with approval".
    expect(TYPES_CODE).toContain("approv");
    expect(TYPES_CODE).toContain('"Agent" member');
    // ... and that nothing private is reachable.
    expect(TYPES_CODE).toContain("Only public channels are reachable");
  });
});

// --- reads ------------------------------------------------------------------

describe("reading", () => {
  it("lists public, unarchived channels only, and authorizes the observation", async () => {
    const bridge = new FakeBridge();
    bridge.channels = [
      channel("general", { topic: "Everything" }),
      channel("secrets", { kind: "private" }),
      channel("dm-1", { kind: "dm", name: null }),
      channel("old", { archived: true }),
      channel("random"),
    ];
    const queue = new FakeQueue();

    const channels = await newSession(bridge, queue).listChannels();

    expect(channels.map((entry) => entry.id)).toEqual(["general", "random"]);
    expect(channels[0]).toEqual({
      id: "general",
      name: "general",
      topic: "Everything",
      purpose: null,
      memberCount: 3,
    });
    expect(queue.observations).toHaveLength(1);
    expect(queue.observations[0]?.title).toBe("List team chat channels");
  });

  it("returns nothing when the observation is refused", async () => {
    const bridge = new FakeBridge();
    const queue = new FakeQueue();
    queue.refuse = new Error("policy says no");

    await expect(newSession(bridge, queue).listChannels()).rejects.toThrow("policy says no");
    await expect(newSession(bridge, queue).readMessages("general")).rejects.toThrow("policy says no");
  });

  it("pages a channel with a bounded limit and an opaque cursor", async () => {
    const bridge = new FakeBridge();
    bridge.page = {
      messages: [
        message("m1", { seq: 7, authorId: "u1" }),
        message("m2", { seq: 8, authorId: "unknown", mentions: [{ kind: "user", userId: "u1" }] }),
      ],
      hasMoreBefore: true,
      hasMoreAfter: false,
      users: [user("u1", "Ada")],
      channelLastSeq: 8,
    };
    const queue = new FakeQueue();

    const page = await newSession(bridge, queue).readMessages("general", { limit: 5000 });

    expect(bridge.listMessagesCalls[0]).toEqual({ channelId: "general", query: { limit: MAX_AGENT_LIMIT } });
    expect(page.olderCursor).toBe("7");
    expect(page.messages[0]?.authorName).toBe("Ada");
    // An author missing from the directory falls back to the id rather than inventing a name.
    expect(page.messages[1]?.authorName).toBe("unknown");
    expect(page.messages[1]?.mentionedUserIds).toEqual(["u1"]);
    expect(queue.observations[0]?.title).toBe("Read messages in #general");

    // The cursor round-trips back into the query as the app's own paging parameter.
    await newSession(bridge, queue).readMessages("general", { before: page.olderCursor ?? undefined });
    expect(bridge.listMessagesCalls.at(-1)?.query).toEqual({ limit: 20, before: 7 });
  });

  it("refuses a cursor it did not hand out", async () => {
    const session = newSession(new FakeBridge(), new FakeQueue());
    await expect(session.readMessages("general", { before: "nonsense" })).rejects.toThrow(TypeError);
  });

  it("reads a thread by root id", async () => {
    const bridge = new FakeBridge();
    await newSession(bridge, new FakeQueue()).readThread("general", "m1");
    expect(bridge.listMessagesCalls[0]?.query).toEqual({ limit: 20, rootId: "m1" });
  });

  it("never reads a channel that is not public", async () => {
    const bridge = new FakeBridge();
    bridge.channels = [channel("general"), channel("secrets", { kind: "private" })];
    const session = newSession(bridge, new FakeQueue());

    await expect(session.readMessages("secrets")).rejects.toThrow(/no public channel/);
    await expect(session.readThread("secrets", "m1")).rejects.toThrow(/no public channel/);
    await expect(session.postMessage("secrets", "hello")).rejects.toThrow(/no public channel/);
    expect(bridge.listMessagesCalls).toEqual([]);
    expect(bridge.sendCalls).toEqual([]);
  });

  it("drops search hits that fall outside a public channel", async () => {
    const bridge = new FakeBridge();
    bridge.channels = [channel("general"), channel("secrets", { kind: "private" })];
    bridge.searchResult = {
      query: { text: "deploy" },
      hits: [
        { message: message("m1", { channelId: "general" }), channelId: "general", snippet: "<mark>deploy</mark>", score: -1, root: null },
        { message: message("m2", { channelId: "secrets" }), channelId: "secrets", snippet: "leak", score: -2, root: null },
      ],
      channels: [],
      users: [user("u1", "Ada")],
      cursor: "next",
    };
    const queue = new FakeQueue();

    const result = await newSession(bridge, queue).search("deploy", { limit: 10 });

    expect(result.hits.map((hit) => hit.message.id)).toEqual(["m1"]);
    expect(result.cursor).toBe("next");
    expect(bridge.searchCalls[0]).toEqual({ query: "deploy", options: { limit: 10 } });
    expect(queue.observations[0]?.title).toBe("Search team chat");
  });

  it("clamps every page size into the documented range", () => {
    expect(boundedLimit(undefined)).toBe(20);
    expect(boundedLimit(0)).toBe(1);
    expect(boundedLimit(7.6)).toBe(7);
    expect(boundedLimit(1000)).toBe(MAX_AGENT_LIMIT);
    expect(boundedLimit(Number.NaN)).toBe(20);
  });
});

// --- posting ----------------------------------------------------------------

describe("posting", () => {
  it("submits an action and posts nothing until it is approved", async () => {
    const bridge = new FakeBridge();
    const queue = new FakeQueue();
    const store = memoryStore();

    await newSession(bridge, queue, store).postMessage("general", "Deploy is green  ");

    expect(bridge.sendCalls).toEqual([]);
    expect(queue.actions).toHaveLength(1);
    const submitted = queue.actions[0]!;
    expect(submitted.description).toMatchObject({
      title: "Post a message to #general",
      actionKind: { tag: "chat.post", label: "Post a chat message" },
      implementsRevert: true,
      // Nothing is simulated, so the agent must wait for the decision rather than read back a
      // channel its own post is missing from.
      awaitDecision: true,
    });
    expect(submitted.description.autoApprovable).toBeUndefined();
    expect(submitted.description.description).toContain("> Deploy is green");
    expect(submitted.description.description).toContain("**Agent**");

    await applyChatPost(store, bridge, submitted.action);
    expect(bridge.sendCalls).toEqual([
      { channelId: "general", request: { body: "Deploy is green", clientId: "fixed-client-id" } },
    ]);
  });

  it("keeps a thread reply in its thread", async () => {
    const bridge = new FakeBridge();
    const queue = new FakeQueue();
    const store = memoryStore();

    await newSession(bridge, queue, store).postMessage("general", "on it", { rootId: "m1" });
    expect(queue.actions[0]?.description.title).toBe("Post a message to #general");
    await applyChatPost(store, bridge, queue.actions[0]!.action);
    expect(bridge.sendCalls[0]?.request).toEqual({
      body: "on it",
      clientId: "fixed-client-id",
      rootId: "m1",
    });
  });

  it("rejects an empty or oversized body before it reaches the queue", async () => {
    const queue = new FakeQueue();
    const session = newSession(new FakeBridge(), queue);
    await expect(session.postMessage("general", "   ")).rejects.toThrow(TypeError);
    await expect(session.postMessage("general", "x".repeat(9000))).rejects.toThrow(/at most/);
    expect(queue.actions).toEqual([]);
  });

  it("forgets a post the queue would not take", async () => {
    const queue = new FakeQueue();
    queue.refuse = new Error("queue is gone");
    const store = memoryStore();

    await expect(newSession(new FakeBridge(), queue, store).postMessage("general", "hi")).rejects.toThrow(
      "queue is gone",
    );
    expect(store.pending.size).toBe(0);
  });

  it("applies once, however often the overseer retries", async () => {
    const bridge = new FakeBridge();
    const store = memoryStore();
    await newSession(bridge, new FakeQueue(), store).postMessage("general", "hello");

    await applyChatPost(store, bridge, 1);
    await applyChatPost(store, bridge, 1);
    expect(bridge.sendCalls).toHaveLength(1);
  });

  it("re-uses the same idempotency key when a failed apply is retried", async () => {
    const bridge = new FakeBridge();
    const store = memoryStore();
    await newSession(bridge, new FakeQueue(), store).postMessage("general", "hello");

    bridge.failWith = new ChatApiError("internal", 500, "boom");
    await expect(applyChatPost(store, bridge, 1)).rejects.toThrow("boom");
    bridge.failWith = null;
    await applyChatPost(store, bridge, 1);

    expect(bridge.sendCalls.map((call) => call.request.clientId)).toEqual([
      "fixed-client-id",
      "fixed-client-id",
    ]);
  });

  it("sends nothing for an action the user rejected", async () => {
    const bridge = new FakeBridge();
    const store = memoryStore();
    await newSession(bridge, new FakeQueue(), store).postMessage("general", "hello");

    rejectChatPost(store, 1);
    await expect(applyChatPost(store, bridge, 1)).rejects.toThrow(/No queued team chat post/);
    expect(bridge.sendCalls).toEqual([]);
  });

  it("reverts by deleting the message it sent", async () => {
    const bridge = new FakeBridge();
    const store = memoryStore();
    await newSession(bridge, new FakeQueue(), store).postMessage("general", "hello");
    await applyChatPost(store, bridge, 1);

    await expect(revertChatPost(store, bridge, 1)).resolves.toBeUndefined();
    expect(bridge.deleteCalls).toEqual(["posted"]);
    await expect(revertChatPost(store, bridge, 1)).rejects.toThrow(/No sent team chat post/);
  });

  it("explains a revert it could not finish, and offers a retry", async () => {
    const bridge = new FakeBridge();
    const store = memoryStore();
    await newSession(bridge, new FakeQueue(), store).postMessage("general", "hello");
    await applyChatPost(store, bridge, 1);

    bridge.failWith = new ChatApiError("rate_limited", 429, "too many requests");
    expect(await revertChatPost(store, bridge, 1)).toMatchObject({ canRetry: true });

    // A message somebody already deleted counts as reverted.
    bridge.failWith = new ChatApiError("not_found", 404, "gone");
    expect(await revertChatPost(store, bridge, 1)).toBeUndefined();
  });
});

// --- catalog ----------------------------------------------------------------

describe("the agent catalog", () => {
  it("lists the public channels and authorizes the read", async () => {
    const bridge = new FakeBridge();
    bridge.channels = [
      channel("general", { topic: "Everything" }),
      channel("secrets", { kind: "private" }),
      channel("old", { archived: true }),
    ];
    const queue = new FakeQueue();

    const catalog = await chatAgentCatalog(bridge, queue);

    expect(catalog?.entries).toEqual([
      { id: "general", title: "#general", description: "Everything" },
    ]);
    expect(queue.observations).toHaveLength(1);
  });

  it("degrades to no catalog when chat cannot answer", async () => {
    const bridge = new FakeBridge();
    bridge.failWith = new ChatApiError("not_implemented", 501, "not yet");
    const queue = new FakeQueue();

    expect(await chatAgentCatalog(bridge, queue)).toBeNull();
    expect(queue.observations).toEqual([]);
  });
});
