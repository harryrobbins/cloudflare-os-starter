// Channels, memberships and the directory: who can see what, and what membership costs to change.
import { describe, expect, it } from "vitest";

import {
  AGENT_USER_ID,
  GENERAL_CHANNEL_ID,
  type ChannelListResponse,
  type ChannelResponse,
  type MembershipResponse,
  type MessagePageResponse,
  type SendMessageResponse,
  type UserListResponse,
  type UserResponse,
} from "../src/shared/protocol.js";
import { apiPath } from "../src/shared/routes.js";
import { ADMIN_IDENTITY, client, freshWorkspace, identity } from "./helpers.js";

function setup(label: string) {
  const workspace = freshWorkspace(label);
  return {
    workspace,
    alice: client(workspace, identity("alice", "Alice")),
    bob: client(workspace, identity("bob")),
    admin: client(workspace, ADMIN_IDENTITY),
  };
}

const channels = apiPath("listChannels");

describe("the seeded workspace", () => {
  it("has #general, public, with the agent already in it", async () => {
    const { alice } = setup("seed");
    const rail = await alice.get<ChannelListResponse>(channels);
    const general = rail.channels.find((channel) => channel.id === GENERAL_CHANNEL_ID);
    expect(general).toMatchObject({ kind: "public", name: "general", archived: false });
    // Browsing is not membership: Alice has not posted, so she has no row yet.
    expect(rail.memberships).toHaveLength(0);
    expect(general!.memberCount).toBe(1);
  });

  it("reserves the agent as a real user with kind agent", async () => {
    const { alice } = setup("agent-row");
    const { user } = await alice.get<UserResponse>(apiPath("getUser", { userId: AGENT_USER_ID }));
    expect(user).toMatchObject({ id: AGENT_USER_ID, name: "Agent", kind: "agent" });
  });

  it("puts a person in the directory the first time they open chat, and nobody else", async () => {
    const { alice, bob } = setup("directory");
    await alice.get(apiPath("me"));
    const before = await alice.get<UserListResponse>(apiPath("listUsers"));
    expect(before.users.map((user) => user.id).toSorted()).toEqual(["agent", "alice"]);

    await bob.get(apiPath("me"));
    const after = await alice.get<UserListResponse>(apiPath("listUsers"));
    expect(after.users.map((user) => user.id).toSorted()).toEqual(["agent", "alice", "bob"]);

    // An address that has never opened chat is simply unknown; the answer says nothing about
    // whether Access would let it in.
    expect(await alice.error("GET", apiPath("getUser", { userId: "stranger" }))).toMatchObject({
      status: 404,
    });
  });
});

describe("creating channels", () => {
  it("adds the creator and the agent to a public channel", async () => {
    const { alice } = setup("create-public");
    const created = await alice.send<ChannelResponse>("POST", channels, {
      kind: "public",
      name: "design",
      topic: "pixels",
    });
    expect(created.channel).toMatchObject({ kind: "public", name: "design", topic: "pixels" });
    expect(created.membership).not.toBeNull();
    expect(created.channel.memberCount).toBe(2);
  });

  it("refuses a duplicate name", async () => {
    const { alice } = setup("create-clash");
    await alice.send("POST", channels, { kind: "public", name: "design" });
    expect(await alice.error("POST", channels, { kind: "public", name: "design" })).toMatchObject({
      status: 409,
      code: "conflict",
    });
    expect(await alice.error("POST", channels, { kind: "public", name: GENERAL_CHANNEL_ID })).toMatchObject({
      status: 409,
    });
  });

  it("keeps a private channel invisible to everybody but its members", async () => {
    const { alice, bob } = setup("private");
    await bob.get(apiPath("me"));
    const created = await alice.send<ChannelResponse>("POST", channels, {
      kind: "private",
      name: "secret",
      memberIds: [],
    });
    const id = created.channel.id;

    const bobsRail = await bob.get<ChannelListResponse>(channels);
    expect(bobsRail.channels.map((channel) => channel.id)).not.toContain(id);

    // 404, not 403: a refusal that distinguishes "exists" from "does not" is an enumeration oracle.
    for (const attempt of [
      ["GET", apiPath("listMessages", { channelId: id })],
      ["POST", apiPath("joinChannel", { channelId: id })],
      ["POST", apiPath("readChannel", { channelId: id })],
    ] as const) {
      expect(await bob.error(attempt[0], attempt[1], { seq: 0 })).toMatchObject({ status: 404 });
    }
    expect(
      await bob.error("POST", apiPath("sendMessage", { channelId: id }), {
        body: "let me in",
        clientId: "c1",
      }),
    ).toMatchObject({ status: 404 });
  });

  it("deduplicates a direct message by its member pair", async () => {
    const { alice, bob } = setup("dm");
    await bob.get(apiPath("me"));
    const first = await alice.send<ChannelResponse>("POST", channels, { kind: "dm", memberIds: ["bob"] });
    const second = await alice.send<ChannelResponse>("POST", channels, { kind: "dm", memberIds: ["bob"] });
    expect(second.channel.id).toBe(first.channel.id);

    // And from the other side: "message Alice" finds the same conversation.
    const fromBob = await bob.send<ChannelResponse>("POST", channels, { kind: "dm", memberIds: ["alice"] });
    expect(fromBob.channel.id).toBe(first.channel.id);
    expect(fromBob.channel.memberIds?.toSorted()).toEqual(["alice", "bob"]);
  });

  it("refuses a conversation with somebody who has never opened chat", async () => {
    const { alice } = setup("dm-stranger");
    expect(await alice.error("POST", channels, { kind: "dm", memberIds: ["stranger"] })).toMatchObject({
      status: 404,
    });
  });

  it("does not put the agent in a private channel", async () => {
    const { alice } = setup("private-no-agent");
    const created = await alice.send<ChannelResponse>("POST", channels, {
      kind: "private",
      name: "closed",
    });
    expect(created.channel.memberCount).toBe(1);
  });
});

describe("join, leave and archive", () => {
  it("joins a public channel and leaves it again", async () => {
    const { alice, bob } = setup("join-leave");
    const created = await alice.send<ChannelResponse>("POST", channels, { kind: "public", name: "random" });
    const id = created.channel.id;

    const joined = await bob.send<ChannelResponse>("POST", apiPath("joinChannel", { channelId: id }));
    expect(joined.membership).not.toBeNull();
    const left = await bob.send<ChannelResponse>("POST", apiPath("leaveChannel", { channelId: id }));
    expect(left.membership).toBeNull();
  });

  it("refuses to join a private channel", async () => {
    const { alice, bob } = setup("join-private");
    await bob.get(apiPath("me"));
    const created = await alice.send<ChannelResponse>("POST", channels, { kind: "private", name: "hush" });
    expect(
      await bob.error("POST", apiPath("joinChannel", { channelId: created.channel.id })),
    ).toMatchObject({ status: 404 });
  });

  it("will not let anybody leave #general", async () => {
    const { alice } = setup("leave-general");
    await alice.send("POST", apiPath("joinChannel", { channelId: GENERAL_CHANNEL_ID }));
    expect(
      await alice.error("POST", apiPath("leaveChannel", { channelId: GENERAL_CHANNEL_ID })),
    ).toMatchObject({ status: 403 });
  });

  it("archives with a system message and then refuses writes", async () => {
    const { alice } = setup("archive");
    const created = await alice.send<ChannelResponse>("POST", channels, { kind: "public", name: "old" });
    const id = created.channel.id;

    const archived = await alice.send<ChannelResponse>("POST", apiPath("archiveChannel", { channelId: id }));
    expect(archived.channel.archived).toBe(true);
    expect(archived.systemMessage).toMatchObject({ kind: "system", body: "Alice archived #old" });

    expect(
      await alice.error("POST", apiPath("sendMessage", { channelId: id }), {
        body: "still here?",
        clientId: "c1",
      }),
    ).toMatchObject({ status: 403, code: "forbidden" });

    // Reading an archive is still allowed.
    const page = await alice.get<MessagePageResponse>(apiPath("listMessages", { channelId: id }));
    expect(page.messages).toHaveLength(1);
  });

  it("lets an admin rename a channel they did not create, and nobody else", async () => {
    const { alice, bob, admin } = setup("rename");
    const created = await alice.send<ChannelResponse>("POST", channels, { kind: "public", name: "before" });
    const id = created.channel.id;

    expect(
      await bob.error("PATCH", apiPath("updateChannel", { channelId: id }), { name: "mine" }),
    ).toMatchObject({ status: 403 });

    const renamed = await admin.send<ChannelResponse>("PATCH", apiPath("updateChannel", { channelId: id }), {
      name: "after",
      topic: "renamed by an admin",
    });
    expect(renamed.channel).toMatchObject({ name: "after", topic: "renamed by an admin" });
    expect(renamed.systemMessage?.body).toBe("Admin renamed #before to #after");
  });

  it("refuses to archive #general", async () => {
    const { admin } = setup("archive-general");
    expect(
      await admin.error("POST", apiPath("archiveChannel", { channelId: GENERAL_CHANNEL_ID })),
    ).toMatchObject({ status: 403 });
  });
});

describe("writing to a public channel", () => {
  it("joins the author, so the read cursor has somewhere to live", async () => {
    const { alice } = setup("autojoin");
    const sent = await alice.send<SendMessageResponse>(
      "POST",
      apiPath("sendMessage", { channelId: GENERAL_CHANNEL_ID }),
      { body: "hello everyone", clientId: "c1" },
    );
    expect(sent.message.seq).toBe(1);
    const rail = await alice.get<ChannelListResponse>(channels);
    expect(rail.memberships.map((membership) => membership.channelId)).toContain(GENERAL_CHANNEL_ID);
    // Your own message is never unread to you.
    expect(rail.badges.unread[GENERAL_CHANNEL_ID]).toBeUndefined();
  });
});

describe("per-conversation preferences", () => {
  it("sets notify, mute and star independently and reports them on the rail", async () => {
    const { alice } = setup("membership-prefs");
    const created = await alice.send<ChannelResponse>("POST", channels, { kind: "public", name: "noisy" });
    const id = created.channel.id;
    const path = apiPath("updateMembership", { channelId: id });

    expect(created.membership).toMatchObject({ notify: "all", muted: false, starred: false });

    const muted = await alice.send<MembershipResponse>("PATCH", path, { muted: true });
    expect(muted.membership).toMatchObject({ muted: true, starred: false, notify: "all" });

    const rest = await alice.send<MembershipResponse>("PATCH", path, {
      notify: "mentions",
      starred: true,
    });
    expect(rest.membership).toMatchObject({ muted: true, starred: true, notify: "mentions" });

    // The rail carries the caller's own row, so the SPA needs no second request.
    const rail = await alice.get<ChannelListResponse>(channels);
    const mine = rail.memberships.find((membership) => membership.channelId === id);
    expect(mine).toMatchObject({ notify: "mentions", muted: true, starred: true });
  });

  it("stops a muted conversation badging, and starts it again when unmuted", async () => {
    const { alice, bob } = setup("membership-mute");
    const created = await alice.send<ChannelResponse>("POST", channels, { kind: "public", name: "chatty" });
    const id = created.channel.id;
    await bob.send("POST", apiPath("joinChannel", { channelId: id }));
    await alice.send("POST", apiPath("sendMessage", { channelId: id }), { body: "noise", clientId: "c1" });

    const path = apiPath("updateMembership", { channelId: id });
    expect((await bob.get<ChannelListResponse>(channels)).badges.unread[id]).toBe(1);

    const muted = await bob.send<MembershipResponse>("PATCH", path, { muted: true });
    expect(muted.badges.unread[id]).toBeUndefined();

    const unmuted = await bob.send<MembershipResponse>("PATCH", path, { muted: false });
    expect(unmuted.badges.unread[id]).toBe(1);
  });

  it("needs a membership, and hides a channel the caller cannot see", async () => {
    const { alice, bob } = setup("membership-auth");
    await bob.get(apiPath("me"));
    const secret = await alice.send<ChannelResponse>("POST", channels, { kind: "private", name: "secret" });
    const open = await alice.send<ChannelResponse>("POST", channels, { kind: "public", name: "open" });

    // Browsing a public channel is not membership, so there is no row to set preferences on.
    expect(
      await bob.error("PATCH", apiPath("updateMembership", { channelId: open.channel.id }), {
        muted: true,
      }),
    ).toMatchObject({ status: 403, code: "forbidden" });

    // A private channel answers "no such channel", never "you are not a member".
    expect(
      await bob.error("PATCH", apiPath("updateMembership", { channelId: secret.channel.id }), {
        muted: true,
      }),
    ).toMatchObject({ status: 404, code: "not_found" });
  });

  it("refuses a body that changes nothing or carries the wrong type", async () => {
    const { alice } = setup("membership-validation");
    const created = await alice.send<ChannelResponse>("POST", channels, { kind: "public", name: "valid" });
    const path = apiPath("updateMembership", { channelId: created.channel.id });
    for (const body of [{}, { muted: "yes" }, { notify: "hourly" }, { starred: 1 }]) {
      expect(await alice.error("PATCH", path, body), JSON.stringify(body)).toMatchObject({
        status: 400,
        code: "invalid_request",
      });
    }
  });
});

describe("preferences", () => {
  it("overrides the display name and clears it again", async () => {
    const { alice } = setup("prefs");
    const updated = await alice.send<UserResponse>("PATCH", apiPath("updateMe"), { displayName: "Al" });
    expect(updated.user.name).toBe("Al");
    expect(updated.prefs.displayName).toBe("Al");

    const cleared = await alice.send<UserResponse>("PATCH", apiPath("updateMe"), { displayName: null });
    // Back to the identity-derived fallback: the email local part.
    expect(cleared.user.name).toBe("alice");
  });
});
