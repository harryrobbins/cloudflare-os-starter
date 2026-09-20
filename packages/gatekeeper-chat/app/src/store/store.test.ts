/**
 * Store-level behaviour, against a hand-built transport rather than the mock workspace: these tests are
 * about the *sequencing* the store owns -- optimistic send then reconcile, `hello` then catch-up, the
 * three conditions that mark a conversation read -- so the transport has to be steerable, not realistic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Channel,
  ChannelListResponse,
  ClientEvent,
  MeResponse,
  Membership,
  Message,
  MessagePageResponse,
  ReadCursor,
  SendMessageResponse,
  ServerEvent,
  User,
} from "../contract.js";
import type { ChatApi, ChatSocket, SocketStatus, Transport } from "../api/types.js";
import { ApiError } from "../api/types.js";
import { conversationKey } from "./drafts.js";
import { ChatStore } from "./store.js";

const me: User = {
  id: "me",
  name: "Harry",
  email: "harry@example.test",
  avatarKey: null,
  firstSeenAt: 0,
  lastSeenAt: 0,
  tz: null,
  online: true,
};

const alice: User = { ...me, id: "alice", name: "Alice", email: "alice@example.test" };

const channel: Channel = {
  id: "c1",
  kind: "public",
  name: "general",
  topic: null,
  purpose: null,
  createdBy: "me",
  createdAt: 0,
  archived: false,
  memberCount: 2,
  lastSeq: 2,
};

const membership: Membership = {
  channelId: "c1",
  userId: "me",
  joinedAt: 0,
  lastReadSeq: 2,
  manualUnreadSeq: null,
  notify: "all",
  muted: false,
  starred: false,
};

function message(patch: Partial<Message> & { id: string; seq: number }): Message {
  return {
    channelId: "c1",
    rootId: null,
    authorId: "alice",
    body: "hello",
    kind: "user",
    createdAt: patch.seq * 1000,
    editedAt: null,
    deletedAt: null,
    replyCount: 0,
    lastReplyAt: null,
    reactions: [],
    attachments: [],
    mentions: [],
    ...patch,
  };
}

class FakeSocket implements ChatSocket {
  readonly sent: unknown[] = [];
  #listeners = new Set<(event: ServerEvent) => void>();
  #statusListeners = new Set<(status: SocketStatus) => void>();
  opened = false;

  open(): void {
    this.opened = true;
    for (const listener of this.#statusListeners) listener("open");
  }
  close(): void {
    this.opened = false;
  }
  send(event: unknown): void {
    this.sent.push(event);
  }
  status(): SocketStatus {
    return this.opened ? "open" : "idle";
  }
  retryInSeconds(): number | null {
    return null;
  }
  onEvent(listener: (event: ServerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  onStatus(listener: (status: SocketStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }
  emit(event: ServerEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

/**
 * One mutable object, returned as-is rather than spread: the API closures below read `state.history`
 * and `state.sendResult` on every call, so a test that reassigns them steers the transport. A copy
 * would silently keep the original behaviour.
 */
interface Harness {
  store: ChatStore;
  socket: FakeSocket;
  api: ChatApi;
  calls: { listMessages: Array<[string, unknown]> };
  sendResult: (request: { clientId: string; body: string }) => Promise<SendMessageResponse>;
  history: Message[];
  /** Set to make `listMessages` answer like a dm or group page. */
  readCursors?: ReadCursor[];
  membership: Membership;
}

function harness(): Harness {
  const socket = new FakeSocket();
  const calls = { listMessages: [] as Array<[string, unknown]> };
  const state: Harness = {
    store: undefined as unknown as ChatStore,
    socket,
    api: undefined as unknown as ChatApi,
    calls,
    history: [message({ id: "m1", seq: 1 }), message({ id: "m2", seq: 2 })],
    membership,
    sendResult: async (request) => ({
      message: message({ id: "srv", seq: 3, authorId: "me", body: request.body, clientId: request.clientId }),
      deduped: false,
      badges: { unread: {}, mentions: {}, threads: 0 },
    }),
  };

  const api: ChatApi = {
    me: async (): Promise<MeResponse> => ({
      user: me,
      prefs: { displayName: null, tz: null, notify: "all" },
      admin: false,
      badges: { unread: {}, mentions: {}, threads: 0 },
      limits: { maxBodyBytes: 8192, maxUploadBytes: 1024, maxAttachmentsPerMessage: 10 },
      protocolVersion: 1,
    }),
    updateMe: async () => ({ user: me, prefs: { displayName: null, tz: null, notify: "all" } }),
    listChannels: async (): Promise<ChannelListResponse> => ({
      channels: [channel],
      memberships: [membership],
      users: [me, alice],
      badges: { unread: {}, mentions: {}, threads: 0 },
    }),
    createChannel: async () => ({ channel, membership }),
    updateChannel: async () => ({ channel, membership }),
    joinChannel: async () => ({ channel, membership }),
    leaveChannel: async () => ({ channel, membership: null }),
    archiveChannel: async () => ({ channel, membership }),
    markRead: async (_channelId, request) => ({
      membership: {
        ...membership,
        lastReadSeq: request.seq ?? membership.lastReadSeq,
        manualUnreadSeq: request.manualUnreadSeq ?? null,
      },
      badges: { unread: {}, mentions: {}, threads: 0 },
    }),
    updateMembership: async (_channelId, patch) => {
      // Stateful, like the row it stands for: three separate PATCHes accumulate rather than each one
      // resetting the other two.
      state.membership = { ...state.membership, ...patch };
      return { membership: state.membership, badges: { unread: {}, mentions: {}, threads: 0 } };
    },
    listMessages: async (channelId, query = {}): Promise<MessagePageResponse> => {
      calls.listMessages.push([channelId, query]);
      const after = query.after;
      const messages =
        after === undefined ? state.history : state.history.filter((entry) => entry.seq > after);
      return {
        messages,
        hasMoreBefore: false,
        hasMoreAfter: false,
        users: [me, alice],
        channelLastSeq: state.history[state.history.length - 1]?.seq ?? 0,
        ...(state.readCursors === undefined ? {} : { readCursors: state.readCursors }),
      };
    },
    sendMessage: async (_channelId, request) => state.sendResult(request),
    editMessage: async (messageId, body) => ({ message: message({ id: messageId, seq: 9, body }) }),
    deleteMessage: async (messageId) => ({ id: messageId, channelId: "c1", tombstone: null }),
    addReaction: async (messageId) => ({
      messageId,
      channelId: "c1",
      reactions: [{ emoji: "👍", userIds: ["me"] }],
    }),
    removeReaction: async (messageId) => ({ messageId, channelId: "c1", reactions: [] }),
    listThreads: async () => ({ threads: [], users: [], cursor: null }),
    followThread: async () => {
      throw new ApiError("not_found", "no thread", 404);
    },
    unfollowThread: async () => {
      throw new ApiError("not_found", "no thread", 404);
    },
    search: async () => ({ query: { text: "" }, hits: [], channels: [], users: [], cursor: null }),
    upload: async () => {
      throw new ApiError("not_implemented", "no uploads", 501);
    },
    listUsers: async () => ({ users: [me, alice], cursor: null }),
    getUser: async () => ({ user: alice }),
  };

  state.api = api;
  state.store = new ChatStore({ transport: { api, socket } satisfies Transport, navigate: () => undefined });
  return state;
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("start", () => {
  it("loads identity and the rail, then opens the socket", async () => {
    const { store, socket } = harness();
    await store.start({ embedded: false });
    expect(store.state.phase).toBe("ready");
    expect(store.state.me?.id).toBe("me");
    expect(store.state.channels.c1?.name).toBe("general");
    expect(socket.opened).toBe(true);
    expect(socket.sent).toContainEqual({ t: "sub", channels: ["c1"] });
  });

  it("reports a fatal error rather than rendering an empty app", async () => {
    const h = harness();
    vi.spyOn(h.api, "me").mockRejectedValue(new ApiError("unauthenticated", "Signed out.", 401));
    await h.store.start({ embedded: false });
    expect(h.store.state.phase).toBe("error");
    expect(h.store.state.fatalError).toBe("Signed out.");
  });
});

describe("optimistic send", () => {
  it("shows the message immediately, then replaces it with the committed row", async () => {
    const { store } = harness();
    await store.start({ embedded: false });
    await store.openConversation("c1");

    store.setDraft(conversationKey("c1"), "hello there");
    const sending = store.send("c1");

    const pendingRows = store.state.conversations.c1!.messages.filter(
      (entry) => entry.local?.state === "pending",
    );
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]!.body).toBe("hello there");

    await sending;
    const messages = store.state.conversations.c1!.messages;
    expect(messages.some((entry) => entry.local !== undefined)).toBe(false);
    expect(messages[messages.length - 1]!.id).toBe("srv");
    expect(store.state.drafts[conversationKey("c1")]).toBeUndefined();
  });

  it("parses mentions into the optimistic row", async () => {
    const { store } = harness();
    await store.start({ embedded: false });
    await store.openConversation("c1");
    store.setDraft(conversationKey("c1"), "ping <@alice>");
    const sending = store.send("c1");
    const pending = store.state.conversations.c1!.messages.find((entry) => entry.local !== undefined);
    expect(pending?.mentions).toEqual([{ kind: "user", userId: "alice" }]);
    await sending;
  });

  it("converts the composer's display names into id tokens on the way out", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    await h.store.openConversation("c1");
    const sent: string[] = [];
    h.sendResult = async (request) => {
      sent.push(request.body);
      return {
        message: message({ id: "srv", seq: 3, authorId: "me", body: request.body, clientId: request.clientId }),
        deduped: false,
        badges: { unread: {}, mentions: {}, threads: 0 },
      };
    };

    h.store.setDraft(conversationKey("c1"), "morning @Alice, see #general");
    await h.store.send("c1");

    expect(sent).toEqual(["morning <@alice>, see <#c1>"]);
  });

  it("marks a failed send and keeps its body for the retry", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    await h.store.openConversation("c1");
    h.sendResult = () => Promise.reject(new ApiError("internal", "The network is unavailable.", 0));

    h.store.setDraft(conversationKey("c1"), "will fail");
    await h.store.send("c1");

    const failed = h.store.state.conversations.c1!.messages.find(
      (entry) => entry.local?.state === "failed",
    );
    expect(failed?.body).toBe("will fail");
    expect(h.store.state.toasts.some((toast) => toast.title === "Message not sent")).toBe(true);
  });

  it("retries with the original clientId so a duplicate commits once", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    await h.store.openConversation("c1");

    h.sendResult = () => Promise.reject(new ApiError("internal", "Nope.", 500));
    h.store.setDraft(conversationKey("c1"), "retry me");
    await h.store.send("c1");
    const failed = h.store.state.conversations.c1!.messages.find((entry) => entry.local !== undefined);
    const clientId = failed!.clientId!;

    const seen: string[] = [];
    h.sendResult = async (request) => {
      seen.push(request.clientId);
      return {
        message: message({ id: "srv", seq: 3, authorId: "me", body: request.body, clientId: request.clientId }),
        deduped: true,
        badges: { unread: {}, mentions: {}, threads: 0 },
      };
    };
    await h.store.retrySend("c1", conversationKey("c1"), clientId);

    expect(seen).toEqual([clientId]);
    const messages = h.store.state.conversations.c1!.messages;
    expect(messages.filter((entry) => entry.body === "retry me")).toHaveLength(1);
    expect(messages.some((entry) => entry.local !== undefined)).toBe(false);
  });

  it("puts a discarded send's text back in the composer", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    await h.store.openConversation("c1");
    h.sendResult = () => Promise.reject(new ApiError("internal", "Nope.", 500));
    h.store.setDraft(conversationKey("c1"), "give it back");
    await h.store.send("c1");
    const clientId = h.store.state.conversations.c1!.messages.find((e) => e.local !== undefined)!.clientId!;

    h.store.discardSend(conversationKey("c1"), clientId);
    expect(h.store.state.drafts[conversationKey("c1")]?.body).toBe("give it back");
    expect(h.store.state.conversations.c1!.messages.some((e) => e.local !== undefined)).toBe(false);
  });
});

describe("catch-up after hello", () => {
  it("pages only the conversations it already holds, from their own high-water mark", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    await h.store.openConversation("c1");
    h.calls.listMessages.length = 0;

    h.history = [...h.history, message({ id: "m3", seq: 3 }), message({ id: "m4", seq: 4 })];
    h.socket.emit({
      t: "hello",
      user: me,
      sessionId: "s1",
      serverTime: Date.now(),
      protocolVersion: 1,
      lastSeq: { c1: 4, c2: 99 },
    });
    await settle();

    const catchUps = h.calls.listMessages.filter(([, query]) => (query as { after?: number }).after !== undefined);
    expect(catchUps).toHaveLength(1);
    expect(catchUps[0]![1]).toMatchObject({ after: 2 });
    expect(h.store.state.conversations.c1!.messages.map((entry) => entry.id)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
  });

  it("asks for nothing when it is already level with the server", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    await h.store.openConversation("c1");
    h.calls.listMessages.length = 0;

    h.socket.emit({
      t: "hello",
      user: me,
      sessionId: "s1",
      serverTime: Date.now(),
      protocolVersion: 1,
      lastSeq: { c1: 2 },
    });
    await settle();

    expect(
      h.calls.listMessages.filter(([, query]) => (query as { after?: number }).after !== undefined),
    ).toHaveLength(0);
  });

  it("merges a socket message and a catch-up page without duplicating the row", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    await h.store.openConversation("c1");

    const arriving = message({ id: "m3", seq: 3 });
    h.history = [...h.history, arriving];
    h.socket.emit({ t: "msg", message: arriving });
    h.socket.emit({
      t: "hello",
      user: me,
      sessionId: "s1",
      serverTime: Date.now(),
      protocolVersion: 1,
      lastSeq: { c1: 3 },
    });
    await settle();

    expect(h.store.state.conversations.c1!.messages.filter((entry) => entry.id === "m3")).toHaveLength(1);
  });
});

describe("unread", () => {
  it("marks read only when visible, focused and at the bottom", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    await h.store.openConversation("c1");
    h.store.setActive("c1", null);
    h.socket.sent.length = 0;

    h.store.setAtBottom("c1", null, false);
    h.socket.emit({ t: "msg", message: message({ id: "m3", seq: 3 }) });
    await settle();
    expect(h.socket.sent.filter((event) => (event as { t: string }).t === "read")).toHaveLength(0);

    h.store.setAtBottom("c1", null, true);
    await settle();
    expect(h.socket.sent.filter((event) => (event as { t: string }).t === "read")).toHaveLength(1);
  });

  it("does not mark read while the window is blurred", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    await h.store.openConversation("c1");
    h.store.setActive("c1", null);
    h.store.setFocused(false);
    h.socket.sent.length = 0;

    h.socket.emit({ t: "msg", message: message({ id: "m3", seq: 3 }) });
    await settle();
    expect(h.socket.sent.filter((event) => (event as { t: string }).t === "read")).toHaveLength(0);
  });

  it("counts an incoming message towards the rail badge", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    h.store.setActive("c2", null); // Looking elsewhere.
    h.socket.emit({
      t: "msg",
      message: message({ id: "m3", seq: 3, mentions: [{ kind: "user", userId: "me" }] }),
    });
    await settle();
    expect(h.store.state.badges.unread.c1).toBe(1);
    expect(h.store.state.badges.mentions.c1).toBe(1);
  });

  it("keeps a manual unread marker separate from the read cursor", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    await h.store.markUnreadFrom("c1", 2);
    expect(h.store.state.memberships.c1!.manualUnreadSeq).toBe(2);
    expect(h.store.state.memberships.c1!.lastReadSeq).toBe(2);
  });
});

describe("socket events", () => {
  it("applies an edit to the open conversation", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    await h.store.openConversation("c1");
    h.socket.emit({ t: "edit", message: message({ id: "m1", seq: 1, body: "edited", editedAt: 5 }) });
    await settle();
    const edited = h.store.state.conversations.c1!.messages.find((entry) => entry.id === "m1");
    expect(edited?.body).toBe("edited");
    expect(edited?.editedAt).toBe(5);
  });

  it("removes a deleted message with no replies", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    await h.store.openConversation("c1");
    h.socket.emit({ t: "del", channel: "c1", id: "m1", tombstone: null });
    await settle();
    expect(h.store.state.conversations.c1!.messages.some((entry) => entry.id === "m1")).toBe(false);
  });

  it("keeps a tombstone when replies hold the message in place", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    await h.store.openConversation("c1");
    h.socket.emit({
      t: "del",
      channel: "c1",
      id: "m1",
      tombstone: message({ id: "m1", seq: 1, body: "", deletedAt: 7, replyCount: 2 }),
    });
    await settle();
    expect(h.store.state.conversations.c1!.messages.find((entry) => entry.id === "m1")?.deletedAt).toBe(7);
  });

  it("tracks presence", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    h.socket.emit({ t: "presence", online: ["alice"] });
    expect(h.store.state.online).toEqual(["alice"]);
  });

  it("ignores your own typing echo", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    h.socket.emit({ t: "typing", channel: "c1", user: "me" });
    expect(h.store.state.typing.c1).toBeUndefined();
    h.socket.emit({ t: "typing", channel: "c1", user: "alice" });
    expect(Object.keys(h.store.state.typing.c1 ?? {})).toEqual(["alice"]);
  });
});

describe("drafts", () => {
  it("keeps one draft per conversation and per thread", async () => {
    const { store } = harness();
    await store.start({ embedded: false });
    store.setDraft(conversationKey("c1"), "channel text");
    store.setDraft(conversationKey("c1", "root-1"), "thread text");
    expect(store.state.drafts["c1"]?.body).toBe("channel text");
    expect(store.state.drafts["c1:root-1"]?.body).toBe("thread text");
  });

  it("drops a draft that is emptied", async () => {
    const { store } = harness();
    await store.start({ embedded: false });
    store.setDraft(conversationKey("c1"), "text");
    store.setDraft(conversationKey("c1"), "   ");
    expect(store.state.drafts["c1"]).toBeUndefined();
  });
});

describe("conversation preferences", () => {
  it("persists notify, mute and star through PATCH channels/:id/membership", async () => {
    const h = harness();
    const patch = vi.spyOn(h.api, "updateMembership");
    await h.store.start({ embedded: false });

    await h.store.setNotify("c1", "mentions");
    await h.store.toggleMute("c1");
    await h.store.toggleStar("c1");

    expect(patch.mock.calls.map(([, body]) => body)).toEqual([
      { notify: "mentions" },
      { muted: true },
      { starred: true },
    ]);
    // The server's copy wins, so a value it refused to change never lingers in the UI.
    expect(h.store.state.memberships.c1).toMatchObject({
      notify: "mentions",
      muted: true,
      starred: true,
    });
  });

  it("rolls the optimistic change back when the server refuses", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    vi.spyOn(h.api, "updateMembership").mockRejectedValue(
      new ApiError("forbidden", "Join the channel first.", 403),
    );

    await h.store.toggleStar("c1");
    expect(h.store.state.memberships.c1?.starred).toBe(false);
    expect(h.store.state.toasts[0]?.title).toBe("Could not star this conversation");
  });
});

describe("read cursors", () => {
  it("takes the other members' cursors from a dm or group page", async () => {
    const h = harness();
    h.readCursors = [{ userId: "alice", lastReadSeq: 2 }];
    await h.store.start({ embedded: false });
    await h.store.openConversation("c1");
    expect(h.store.state.readCursors.c1).toEqual([{ userId: "alice", lastReadSeq: 2 }]);
  });

  it("moves somebody else's cursor on a read event, and never backwards", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    h.socket.emit({ t: "read", channel: "c1", seq: 5, userId: "alice" });
    h.socket.emit({ t: "read", channel: "c1", seq: 3, userId: "alice" });
    // `seenAt` is the moment this client watched the read happen; only the cursor is asserted.
    expect(h.store.state.readCursors.c1).toMatchObject([{ userId: "alice", lastReadSeq: 5 }]);
    expect(h.store.state.readCursors.c1?.[0]?.seenAt).toBeTypeOf("number");
    // Somebody else's read must not move my own membership.
    expect(h.store.state.memberships.c1?.lastReadSeq).toBe(membership.lastReadSeq);
  });

  it("still mirrors my own read from another tab", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    h.socket.emit({ t: "read", channel: "c1", seq: 7, userId: "me" });
    expect(h.store.state.memberships.c1?.lastReadSeq).toBe(7);
    expect(h.store.state.readCursors.c1).toBeUndefined();
  });
});

describe("channels the rail has never heard of", () => {
  it("refetches the rail when a badge names an unknown channel", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    const list = vi.spyOn(h.api, "listChannels");

    // A new DM: the server pushes badges to its members, but there is no "channel created" event and
    // this socket's `sub` could not have named a channel that did not exist yet.
    h.socket.emit({ t: "badge", unread: { "c-new": 1 }, mentions: {}, threads: 0 });
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("does not refetch for a channel it already has", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    const list = vi.spyOn(h.api, "listChannels");
    h.socket.emit({ t: "badge", unread: { c1: 3 }, mentions: {}, threads: 0 });
    await settle();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("subscriptions", () => {
  it("re-sends `sub` when a channel is created, so its events are not filtered out", async () => {
    const h = harness();
    await h.store.start({ embedded: false });
    const created: Channel = { ...channel, id: "c-dm", kind: "dm", name: null };
    vi.spyOn(h.api, "createChannel").mockResolvedValue({
      channel: created,
      membership: { ...membership, channelId: "c-dm" },
    });

    h.socket.sent.length = 0;
    await h.store.createChannel({ kind: "dm", memberIds: ["alice"] });
    const subs = (h.socket.sent as ClientEvent[]).filter((event) => event.t === "sub");
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ channels: expect.arrayContaining(["c1", "c-dm"]) });
  });
});
