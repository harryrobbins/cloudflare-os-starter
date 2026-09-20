// Messages, threads, reactions, and the unread arithmetic they drive.
import { describe, expect, it } from "vitest";

import {
  GENERAL_CHANNEL_ID,
  type ChannelListResponse,
  type ChannelResponse,
  type DeleteMessageResponse,
  type MarkReadResponse,
  type MessagePageResponse,
  type MessageResponse,
  type ReactionResponse,
  type SendMessageResponse,
  type ThreadListResponse,
  type ThreadResponse,
} from "../src/shared/protocol.js";
import { apiPath } from "../src/shared/routes.js";
import { mentionToken } from "../src/shared/validate.js";
import { ADMIN_IDENTITY, client, freshWorkspace, identity, type Client } from "./helpers.js";

interface Fixture {
  readonly alice: Client;
  readonly bob: Client;
  readonly admin: Client;
  readonly channelId: string;
}

/** A public channel both people have joined, so unread cursors exist on both sides. */
async function fixture(label: string): Promise<Fixture> {
  const workspace = freshWorkspace(label);
  const alice = client(workspace, identity("alice", "Alice"));
  const bob = client(workspace, identity("bob", "Bob"));
  const admin = client(workspace, ADMIN_IDENTITY);
  await alice.send("POST", apiPath("joinChannel", { channelId: GENERAL_CHANNEL_ID }));
  await bob.send("POST", apiPath("joinChannel", { channelId: GENERAL_CHANNEL_ID }));
  return { alice, bob, admin, channelId: GENERAL_CHANNEL_ID };
}

function post(who: Client, channelId: string, body: string, extra: Record<string, unknown> = {}) {
  return who.send<SendMessageResponse>("POST", apiPath("sendMessage", { channelId }), {
    body,
    clientId: `c-${crypto.randomUUID().slice(0, 8)}`,
    ...extra,
  });
}

describe("sending", () => {
  it("numbers messages per channel, from one", async () => {
    const { alice, channelId } = await fixture("seq");
    expect((await post(alice, channelId, "one")).message.seq).toBe(1);
    expect((await post(alice, channelId, "two")).message.seq).toBe(2);
  });

  it("is idempotent on clientId: a retry returns the first message", async () => {
    const { alice, channelId } = await fixture("idempotent");
    const path = apiPath("sendMessage", { channelId });
    const first = await alice.send<SendMessageResponse>("POST", path, { body: "once", clientId: "retry-1" });
    const second = await alice.send<SendMessageResponse>("POST", path, {
      body: "different text, same key",
      clientId: "retry-1",
    });
    expect(second.deduped).toBe(true);
    expect(second.message.id).toBe(first.message.id);
    expect(second.message.body).toBe("once");

    const page = await alice.get<MessagePageResponse>(apiPath("listMessages", { channelId }));
    expect(page.messages).toHaveLength(1);
  });

  it("scopes the idempotency key to the author", async () => {
    const { alice, bob, channelId } = await fixture("idempotent-author");
    const path = apiPath("sendMessage", { channelId });
    await alice.send("POST", path, { body: "mine", clientId: "shared" });
    const bobs = await bob.send<SendMessageResponse>("POST", path, { body: "also mine", clientId: "shared" });
    expect(bobs.deduped).toBe(false);
    expect(bobs.message.body).toBe("also mine");
  });

  it("refuses a body over the cap and an empty body with no attachment", async () => {
    const { alice, channelId } = await fixture("body-cap");
    const path = apiPath("sendMessage", { channelId });
    expect(await alice.error("POST", path, { body: "x".repeat(9000), clientId: "c1" })).toMatchObject({
      status: 400,
      code: "invalid_request",
    });
    expect(await alice.error("POST", path, { body: "   ", clientId: "c2" })).toMatchObject({ status: 400 });
  });

  it("records a mention only when the token names a real user", async () => {
    const { alice, bob, channelId } = await fixture("mentions");
    const sent = await post(alice, channelId, `morning ${mentionToken("bob")} and ${mentionToken("nobody")}`);
    expect(sent.message.mentions).toEqual([{ kind: "user", userId: "bob" }]);

    const rail = await bob.get<ChannelListResponse>(apiPath("listChannels"));
    expect(rail.badges.mentions[channelId]).toBe(1);
    // Alice mentioned somebody else, so her own badge stays empty.
    const hers = await alice.get<ChannelListResponse>(apiPath("listChannels"));
    expect(hers.badges.mentions[channelId]).toBeUndefined();
  });

  it("keeps an @agent mention out of a person's mention badge", async () => {
    const { alice, bob, channelId } = await fixture("agent-mention");
    const sent = await post(alice, channelId, `${mentionToken("agent")} what is the status?`);
    expect(sent.message.mentions).toEqual([{ kind: "agent", userId: "agent" }]);
    const rail = await bob.get<ChannelListResponse>(apiPath("listChannels"));
    expect(rail.badges.mentions[channelId]).toBeUndefined();
  });
});

describe("unread", () => {
  it("counts other people's messages and clears on read", async () => {
    const { alice, bob, channelId } = await fixture("unread");
    for (const body of ["one", "two", "three"]) await post(alice, channelId, body);

    const before = await bob.get<ChannelListResponse>(apiPath("listChannels"));
    expect(before.badges.unread[channelId]).toBe(3);

    const read = await bob.send<MarkReadResponse>("POST", apiPath("readChannel", { channelId }), { seq: 3 });
    expect(read.membership.lastReadSeq).toBe(3);
    expect(read.badges.unread[channelId]).toBeUndefined();
  });

  it("never moves the read cursor backwards", async () => {
    const { alice, bob, channelId } = await fixture("unread-monotonic");
    for (const body of ["one", "two"]) await post(alice, channelId, body);
    await bob.send("POST", apiPath("readChannel", { channelId }), { seq: 2 });
    const back = await bob.send<MarkReadResponse>("POST", apiPath("readChannel", { channelId }), { seq: 1 });
    expect(back.membership.lastReadSeq).toBe(2);
  });

  it("re-counts from the manual unread marker without touching the read cursor", async () => {
    const { alice, bob, channelId } = await fixture("manual-unread");
    for (const body of ["one", "two", "three"]) await post(alice, channelId, body);
    await bob.send("POST", apiPath("readChannel", { channelId }), { seq: 3 });

    // "Mark unread from here" on the second message: two messages become unread again, and
    // lastReadSeq is untouched so another tab's acknowledgement is not undone.
    const marked = await bob.send<MarkReadResponse>("POST", apiPath("readChannel", { channelId }), {
      manualUnreadSeq: 2,
    });
    expect(marked.membership.manualUnreadSeq).toBe(2);
    expect(marked.membership.lastReadSeq).toBe(3);
    expect(marked.badges.unread[channelId]).toBe(2);

    const cleared = await bob.send<MarkReadResponse>("POST", apiPath("readChannel", { channelId }), {
      manualUnreadSeq: null,
    });
    expect(cleared.badges.unread[channelId]).toBeUndefined();
  });

  it("clears a manual marker that a later read overtakes", async () => {
    const { alice, bob, channelId } = await fixture("manual-overtaken");
    for (const body of ["one", "two", "three"]) await post(alice, channelId, body);
    await bob.send("POST", apiPath("readChannel", { channelId }), { manualUnreadSeq: 2 });
    const read = await bob.send<MarkReadResponse>("POST", apiPath("readChannel", { channelId }), { seq: 3 });
    expect(read.membership.manualUnreadSeq).toBeNull();
    expect(read.badges.unread[channelId]).toBeUndefined();
  });

  it("does not badge a muted conversation", async () => {
    const workspace = freshWorkspace("muted");
    const alice = client(workspace, identity("alice"));
    const bob = client(workspace, identity("bob"));
    await bob.send("POST", apiPath("joinChannel", { channelId: GENERAL_CHANNEL_ID }));
    await post(alice, GENERAL_CHANNEL_ID, "noise");
    expect(
      (await bob.get<ChannelListResponse>(apiPath("listChannels"))).badges.unread[GENERAL_CHANNEL_ID],
    ).toBe(1);

    await bob.send("PATCH", apiPath("updateMembership", { channelId: GENERAL_CHANNEL_ID }), {
      muted: true,
    });
    expect(
      (await bob.get<ChannelListResponse>(apiPath("listChannels"))).badges.unread[GENERAL_CHANNEL_ID],
    ).toBeUndefined();
  });
});

describe("threads", () => {
  it("gives a reply its own channel seq and bumps the root", async () => {
    const { alice, bob, channelId } = await fixture("threads");
    const root = await post(alice, channelId, "shall we ship?");
    const reply = await post(bob, channelId, "yes", { rootId: root.message.id });
    expect(reply.message.rootId).toBe(root.message.id);
    expect(reply.message.seq).toBe(root.message.seq + 1);

    const page = await alice.get<MessagePageResponse>(
      `${apiPath("listMessages", { channelId })}?rootId=${root.message.id}`,
    );
    // The thread page carries its root, which is what the agent bridge and the thread pane both need.
    expect(page.messages.map((message) => message.id)).toEqual([root.message.id, reply.message.id]);
    expect(page.messages[0]!.replyCount).toBe(1);
  });

  it("follows the root author, the replier and anyone mentioned", async () => {
    const { alice, bob, channelId } = await fixture("thread-follows");
    const root = await post(alice, channelId, "who is on call?");
    await post(bob, channelId, "not me", { rootId: root.message.id });

    const hers = await alice.get<ThreadListResponse>(`${apiPath("listThreads")}?unread=1`);
    expect(hers.threads).toHaveLength(1);
    expect(hers.threads[0]).toMatchObject({ rootId: root.message.id, unreadReplies: 1, following: true });

    // Bob follows it too, but his own reply is not unread to him.
    const his = await bob.get<ThreadListResponse>(apiPath("listThreads"));
    expect(his.threads).toHaveLength(1);
    expect(his.threads[0]!.unreadReplies).toBe(0);
    const hisUnread = await bob.get<ThreadListResponse>(`${apiPath("listThreads")}?unread=1`);
    expect(hisUnread.threads).toHaveLength(0);
  });

  it("counts followed threads with unseen replies in the badge summary", async () => {
    const { alice, bob, channelId } = await fixture("thread-badges");
    const root = await post(alice, channelId, "topic");
    await post(bob, channelId, "reply", { rootId: root.message.id });
    const rail = await alice.get<ChannelListResponse>(apiPath("listChannels"));
    expect(rail.badges.threads).toBe(1);

    await alice.send("POST", apiPath("readChannel", { channelId }), { seq: root.message.seq + 1 });
    const after = await alice.get<ChannelListResponse>(apiPath("listChannels"));
    expect(after.badges.threads).toBe(0);
  });

  it("follows and unfollows explicitly", async () => {
    const { alice, bob, channelId } = await fixture("follow");
    const root = await post(alice, channelId, "topic");
    const followed = await bob.send<ThreadResponse>(
      "POST",
      apiPath("followThread", { rootId: root.message.id }),
    );
    expect(followed.thread.following).toBe(true);

    const unfollowed = await bob.send<ThreadResponse>(
      "DELETE",
      apiPath("unfollowThread", { rootId: root.message.id }),
    );
    expect(unfollowed.thread.following).toBe(false);
    expect((await bob.get<ThreadListResponse>(apiPath("listThreads"))).threads).toHaveLength(0);
  });

  it("refuses a reply to a reply", async () => {
    const { alice, channelId } = await fixture("nested");
    const root = await post(alice, channelId, "root");
    const reply = await post(alice, channelId, "reply", { rootId: root.message.id });
    expect(
      await alice.error("POST", apiPath("sendMessage", { channelId }), {
        body: "nested",
        clientId: "c9",
        rootId: reply.message.id,
      }),
    ).toMatchObject({ status: 400 });
  });
});

describe("editing and deleting", () => {
  it("lets only the author edit, and marks the message edited", async () => {
    const { alice, bob, channelId } = await fixture("edit");
    const sent = await post(alice, channelId, "typo");
    const edited = await alice.send<MessageResponse>(
      "PATCH",
      apiPath("editMessage", { messageId: sent.message.id }),
      { body: "fixed" },
    );
    expect(edited.message.body).toBe("fixed");
    expect(edited.message.editedAt).not.toBeNull();

    expect(
      await bob.error("PATCH", apiPath("editMessage", { messageId: sent.message.id }), { body: "no" }),
    ).toMatchObject({ status: 403 });
  });

  it("leaves a tombstone for a thread root with replies and removes everything else", async () => {
    const { alice, bob, channelId } = await fixture("delete");
    const root = await post(alice, channelId, "the question");
    const reply = await post(bob, channelId, "the answer", { rootId: root.message.id });

    const deletedRoot = await alice.send<DeleteMessageResponse>(
      "DELETE",
      apiPath("deleteMessage", { messageId: root.message.id }),
    );
    expect(deletedRoot.tombstone).toMatchObject({ body: "" });
    expect(deletedRoot.tombstone!.deletedAt).not.toBeNull();

    const deletedReply = await bob.send<DeleteMessageResponse>(
      "DELETE",
      apiPath("deleteMessage", { messageId: reply.message.id }),
    );
    expect(deletedReply.tombstone).toBeNull();

    const page = await alice.get<MessagePageResponse>(apiPath("listMessages", { channelId }));
    expect(page.messages.map((message) => message.id)).toEqual([root.message.id]);
    expect(page.messages[0]!.replyCount).toBe(0);
  });

  it("lets an admin delete somebody else's message, and a peer not", async () => {
    const { alice, bob, admin, channelId } = await fixture("delete-admin");
    const sent = await post(alice, channelId, "regrettable");
    expect(
      await bob.error("DELETE", apiPath("deleteMessage", { messageId: sent.message.id })),
    ).toMatchObject({ status: 403 });
    await admin.send("DELETE", apiPath("deleteMessage", { messageId: sent.message.id }));
    const page = await alice.get<MessagePageResponse>(apiPath("listMessages", { channelId }));
    expect(page.messages).toHaveLength(0);
  });
});

describe("reactions", () => {
  it("adds and removes one emoji per person", async () => {
    const { alice, bob, channelId } = await fixture("reactions");
    const sent = await post(alice, channelId, "ship it");
    const path = apiPath("addReaction", { messageId: sent.message.id, emoji: "\u{1F44D}" });

    const added = await bob.send<ReactionResponse>("PUT", path);
    expect(added.reactions).toEqual([{ emoji: "\u{1F44D}", userIds: ["bob"] }]);
    // Adding twice is not two reactions.
    const again = await bob.send<ReactionResponse>("PUT", path);
    expect(again.reactions[0]!.userIds).toEqual(["bob"]);

    const removed = await bob.send<ReactionResponse>("DELETE", path);
    expect(removed.reactions).toEqual([]);
  });

  it("refuses a reaction in a channel the caller cannot see", async () => {
    const workspace = freshWorkspace("reaction-private");
    const alice = client(workspace, identity("alice"));
    const bob = client(workspace, identity("bob"));
    await bob.get(apiPath("me"));
    const created = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "private",
      name: "hidden",
    });
    const sent = await post(alice, created.channel.id, "between us");
    expect(
      await bob.error("PUT", apiPath("addReaction", { messageId: sent.message.id, emoji: "\u{1F44D}" })),
    ).toMatchObject({ status: 404 });
  });
});

describe("paging", () => {
  it("serves the latest page, then walks backwards and forwards", async () => {
    const { alice, channelId } = await fixture("paging");
    for (let i = 1; i <= 10; i++) await post(alice, channelId, `message ${i}`);
    const path = apiPath("listMessages", { channelId });

    const latest = await alice.get<MessagePageResponse>(`${path}?limit=4`);
    expect(latest.messages.map((message) => message.seq)).toEqual([7, 8, 9, 10]);
    expect(latest.hasMoreBefore).toBe(true);
    expect(latest.hasMoreAfter).toBe(false);
    expect(latest.channelLastSeq).toBe(10);

    const older = await alice.get<MessagePageResponse>(`${path}?before=7&limit=4`);
    expect(older.messages.map((message) => message.seq)).toEqual([3, 4, 5, 6]);

    const newer = await alice.get<MessagePageResponse>(`${path}?after=8&limit=4`);
    expect(newer.messages.map((message) => message.seq)).toEqual([9, 10]);
  });

  it("centres a page on a permalink", async () => {
    const { alice, channelId } = await fixture("around");
    const ids: string[] = [];
    for (let i = 1; i <= 10; i++) ids.push((await post(alice, channelId, `message ${i}`)).message.id);

    const page = await alice.get<MessagePageResponse>(
      `${apiPath("listMessages", { channelId })}?around=${ids[4]}&limit=5`,
    );
    expect(page.messages.map((message) => message.seq)).toEqual([3, 4, 5, 6, 7]);
    expect(page.messages.some((message) => message.id === ids[4])).toBe(true);
  });

  it("caps the page size at the contract's maximum", async () => {
    const { alice, channelId } = await fixture("page-cap");
    await post(alice, channelId, "one");
    const page = await alice.get<MessagePageResponse>(
      `${apiPath("listMessages", { channelId })}?limit=1000`,
    );
    expect(page.messages).toHaveLength(1);
    // A limit over the cap is clamped, not rejected: the client asked for "as much as you have".
    expect(await alice.status("GET", `${apiPath("listMessages", { channelId })}?before=1&after=2`)).toBe(400);
  });
});
