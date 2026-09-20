// The WebSocket half: hello, fan-out to current members, the four commands, and presence.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { serveChat } from "../src/serve.js";

import {
  GENERAL_CHANNEL_ID,
  MAX_CLIENT_FRAME_BYTES,
  PROTOCOL_VERSION,
  type ChannelResponse,
  type SendMessageResponse,
} from "../src/shared/protocol.js";
import { apiPath, WS_PATH } from "../src/shared/routes.js";
import { client, freshWorkspace, identity, ORIGIN, tick, type Client } from "./helpers.js";

function post(who: Client, channelId: string, body: string, extra: Record<string, unknown> = {}) {
  return who.send<SendMessageResponse>("POST", apiPath("sendMessage", { channelId }), {
    body,
    clientId: `c-${crypto.randomUUID().slice(0, 8)}`,
    ...extra,
  });
}

function upgrade(origin: string): Request {
  return new Request(`${ORIGIN}${WS_PATH}`, { headers: { Upgrade: "websocket", Origin: origin } });
}

function setup(label: string) {
  const workspace = freshWorkspace(label);
  return {
    workspace,
    alice: client(workspace, identity("alice", "Alice")),
    bob: client(workspace, identity("bob", "Bob")),
  };
}

describe("the upgrade", () => {
  it("answers hello with the protocol version and per-channel high-water marks", async () => {
    const { alice } = setup("hello");
    await alice.send("POST", apiPath("joinChannel", { channelId: GENERAL_CHANNEL_ID }));
    await post(alice, GENERAL_CHANNEL_ID, "first");

    const socket = await alice.socket();
    const hello = await socket.next("hello");
    expect(hello.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(hello.user.id).toBe("alice");
    expect(hello.sessionId).toMatch(/^s_/u);
    expect(hello.lastSeq[GENERAL_CHANNEL_ID]).toBe(1);
    // The badge summary arrives without being asked for, so a fresh tab renders the rail at once.
    await socket.next("badge");
    socket.close();
  });

  it("survives the Worker's forwarding, Origin check included", async () => {
    // The upgrade goes through `serveChat`, which rewrites the headers to attach the identity. A
    // Request rebuilt the wrong way loses the upgrade, so this is the test that the rewrite is safe.
    const who = identity("alice", "Alice");
    const accepted = await serveChat(upgrade(ORIGIN), env, who);
    expect(accepted.status).toBe(101);
    expect(accepted.webSocket).not.toBeNull();
    accepted.webSocket!.accept();
    accepted.webSocket!.close(1000, "done");

    const rejected = await serveChat(upgrade("https://evil.example"), env, who);
    expect(rejected.status).toBe(403);
  });

  it("refuses the ws path without an upgrade header", async () => {
    const { alice } = setup("no-upgrade");
    expect(await alice.status("GET", "/gatekeeper/chat/ws")).toBe(400);
  });
});

describe("fan-out", () => {
  it("delivers a message in a public channel to a connected socket", async () => {
    const { alice, bob } = setup("fanout-public");
    const socket = await bob.socket();
    await socket.next("hello");

    await post(alice, GENERAL_CHANNEL_ID, "hello everyone");
    const event = await socket.next("msg");
    expect(event.message.body).toBe("hello everyone");
    expect(event.message.channelId).toBe(GENERAL_CHANNEL_ID);
    socket.close();
  });

  it("never delivers a private channel to a non-member", async () => {
    const { alice, bob } = setup("fanout-private");
    await bob.get(apiPath("me"));
    const created = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "private",
      name: "closed",
    });

    const outsider = await bob.socket();
    const member = await alice.socket();
    await outsider.next("hello");
    await member.next("hello");

    await post(alice, created.channel.id, "members only");
    await member.next("msg");
    await tick(30);
    expect(outsider.all("msg")).toHaveLength(0);
    outsider.close();
    member.close();
  });

  it("stops delivering to a socket whose membership was removed", async () => {
    // Recipients are derived from membership on every event, never from the subscription the socket
    // sent, so a removal takes effect without the client reconnecting.
    const { workspace, alice, bob } = setup("fanout-revoked");
    await bob.get(apiPath("me"));
    const created = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "private",
      name: "shared",
      memberIds: ["bob"],
    });
    const channelId = created.channel.id;

    const socket = await bob.socket();
    await socket.next("hello");
    await post(alice, channelId, "while a member");
    expect((await socket.next("msg")).message.body).toBe("while a member");

    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(`DELETE FROM memberships WHERE user_id = 'bob' AND channel_id = ?`, channelId);
    });
    await post(alice, channelId, "after removal");
    await tick(30);
    expect(socket.all("msg")).toHaveLength(1);
    socket.close();
  });

  it("filters by subscription once a socket has subscribed, and not before", async () => {
    const { alice, bob } = setup("subs-filter");
    const other = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "public",
      name: "elsewhere",
    });

    const socket = await bob.socket();
    await socket.next("hello");
    // No subscription yet: everything the socket is entitled to arrives.
    await post(alice, other.channel.id, "before subscribing");
    await socket.next("msg");

    socket.send({ t: "sub", channels: [GENERAL_CHANNEL_ID] });
    await tick(20);
    await post(alice, other.channel.id, "after subscribing");
    await post(alice, GENERAL_CHANNEL_ID, "subscribed channel");
    const next = await socket.next("msg");
    expect(next.message.body).toBe("subscribed channel");
    expect(socket.all("msg").map((event) => event.message.body)).not.toContain("after subscribing");
    socket.close();
  });

  it("broadcasts edits, deletes and reactions with their channel", async () => {
    const { alice, bob } = setup("fanout-mutations");
    const socket = await bob.socket();
    await socket.next("hello");
    const sent = await post(alice, GENERAL_CHANNEL_ID, "original");
    await socket.next("msg");

    await alice.send("PATCH", apiPath("editMessage", { messageId: sent.message.id }), { body: "revised" });
    expect((await socket.next("edit")).message.body).toBe("revised");

    await bob.send("PUT", apiPath("addReaction", { messageId: sent.message.id, emoji: "\u{1F44D}" }));
    expect((await socket.next("react")).channel).toBe(GENERAL_CHANNEL_ID);

    await alice.send("DELETE", apiPath("deleteMessage", { messageId: sent.message.id }));
    const deleted = await socket.next("del");
    expect(deleted).toMatchObject({ channel: GENERAL_CHANNEL_ID, id: sent.message.id, tombstone: null });
    socket.close();
  });
});

describe("commands", () => {
  it("drops channels from sub that the caller may not read, and says so", async () => {
    const { alice, bob } = setup("sub-denied");
    await bob.get(apiPath("me"));
    const secret = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "private",
      name: "secret",
    });

    const socket = await bob.socket();
    await socket.next("hello");
    socket.send({ t: "sub", channels: [GENERAL_CHANNEL_ID, secret.channel.id] });
    const error = await socket.next("error");
    expect(error.code).toBe("forbidden");

    // The permitted half took effect: general still arrives, the private channel never does.
    await post(alice, GENERAL_CHANNEL_ID, "public news");
    await socket.next("msg");
    await post(alice, secret.channel.id, "private news");
    await tick(30);
    expect(socket.all("msg")).toHaveLength(1);
    socket.close();
  });

  it("advances the read cursor and pushes a fresh badge", async () => {
    const { alice, bob } = setup("ws-read");
    await bob.send("POST", apiPath("joinChannel", { channelId: GENERAL_CHANNEL_ID }));
    await post(alice, GENERAL_CHANNEL_ID, "unread one");

    const socket = await bob.socket();
    const first = await socket.next("badge");
    expect(first.unread[GENERAL_CHANNEL_ID]).toBe(1);

    socket.send({ t: "read", channel: GENERAL_CHANNEL_ID, seq: 1 });
    const second = await socket.next("badge");
    expect(second.unread[GENERAL_CHANNEL_ID]).toBeUndefined();
    socket.close();
  });

  it("tells the other member of a dm that their message was read", async () => {
    const { alice, bob } = setup("ws-read-seen");
    await bob.get(apiPath("me"));
    const dm = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "dm",
      memberIds: ["bob"],
    });
    const channelId = dm.channel.id;
    await post(alice, channelId, "did you see this?");

    const hers = await alice.socket();
    await hers.next("hello");
    const his = await bob.socket();
    await his.next("hello");

    his.send({ t: "read", channel: channelId, seq: 1 });
    const seen = await hers.next("read");
    expect(seen).toMatchObject({ channel: channelId, seq: 1, userId: "bob" });
    // And the reader's own tabs hear about it, so their "New messages" line moves.
    expect((await his.next("read")).userId).toBe("bob");
    hers.close();
    his.close();
  });

  it("keeps a read in a public channel private to the reader", async () => {
    const { alice, bob } = setup("ws-read-not-shared");
    await bob.send("POST", apiPath("joinChannel", { channelId: GENERAL_CHANNEL_ID }));
    await post(alice, GENERAL_CHANNEL_ID, "for everybody");

    const hers = await alice.socket();
    await hers.next("hello");
    const his = await bob.socket();
    await his.next("hello");

    his.send({ t: "read", channel: GENERAL_CHANNEL_ID, seq: 1 });
    expect((await his.next("read")).userId).toBe("bob");
    await tick(30);
    // A public channel could hold the whole deployment, so nobody else is told.
    expect(hers.all("read")).toHaveLength(0);
    hers.close();
    his.close();
  });

  it("pushes a fresh badge when a conversation is muted", async () => {
    const { alice, bob } = setup("ws-mute-badge");
    await bob.send("POST", apiPath("joinChannel", { channelId: GENERAL_CHANNEL_ID }));
    await post(alice, GENERAL_CHANNEL_ID, "noise");

    const socket = await bob.socket();
    expect((await socket.next("badge")).unread[GENERAL_CHANNEL_ID]).toBe(1);

    await bob.send("PATCH", apiPath("updateMembership", { channelId: GENERAL_CHANNEL_ID }), {
      muted: true,
    });
    expect((await socket.next("badge")).unread[GENERAL_CHANNEL_ID]).toBeUndefined();
    socket.close();
  });

  it("refuses a read for a channel the caller is not in", async () => {
    const { alice, bob } = setup("ws-read-denied");
    await bob.get(apiPath("me"));
    const secret = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "private",
      name: "secret",
    });
    const socket = await bob.socket();
    await socket.next("hello");
    socket.send({ t: "read", channel: secret.channel.id, seq: 1 });
    expect((await socket.next("error")).code).toBe("not_found");
    socket.close();
  });

  it("broadcasts typing to the other members and never to the typist", async () => {
    const { alice, bob } = setup("typing");
    const hers = await alice.socket();
    const his = await bob.socket();
    await hers.next("hello");
    await his.next("hello");

    hers.send({ t: "typing", channel: GENERAL_CHANNEL_ID });
    const seen = await his.next("typing");
    expect(seen).toMatchObject({ channel: GENERAL_CHANNEL_ID, user: "alice" });
    await tick(20);
    expect(hers.all("typing")).toHaveLength(0);

    // Throttled: a second frame inside the window is dropped rather than relayed.
    hers.send({ t: "typing", channel: GENERAL_CHANNEL_ID });
    await tick(30);
    expect(his.all("typing")).toHaveLength(1);
    hers.close();
    his.close();
  });

  it("refuses typing in a conversation the caller is not in", async () => {
    const { alice, bob } = setup("typing-denied");
    await bob.get(apiPath("me"));
    const secret = await alice.send<ChannelResponse>("POST", apiPath("createChannel"), {
      kind: "private",
      name: "secret",
    });
    const socket = await bob.socket();
    await socket.next("hello");
    socket.send({ t: "typing", channel: secret.channel.id });
    expect((await socket.next("error")).code).toBe("forbidden");
    socket.close();
  });

  it("rejects an oversized frame and an unknown command without closing the socket", async () => {
    const { alice } = setup("bad-frames");
    const socket = await alice.socket();
    await socket.next("hello");

    socket.ws.send("x".repeat(MAX_CLIENT_FRAME_BYTES + 1));
    expect((await socket.next("error")).code).toBe("payload_too_large");

    socket.ws.send(JSON.stringify({ t: "teleport" }));
    expect((await socket.next("error")).code).toBe("invalid_request");

    // Still usable.
    socket.send({ t: "ping" });
    await post(alice, GENERAL_CHANNEL_ID, "still connected");
    expect((await socket.next("msg")).message.body).toBe("still connected");
    socket.close();
  });
});

describe("presence", () => {
  it("reports whoever has a live socket, and says so in the directory", async () => {
    const { alice, bob } = setup("presence");
    const hers = await alice.socket();
    await hers.next("hello");
    // Her own connect announced her; the next announcement is the one Bob's connect caused.
    await hers.next("presence");
    const his = await bob.socket();

    const announced = await hers.next("presence");
    expect([...announced.online].toSorted()).toEqual(["alice", "bob"]);

    const directory = await alice.get<{ users: readonly { id: string; online: boolean }[] }>(
      apiPath("listUsers"),
    );
    expect(directory.users.find((user) => user.id === "bob")?.online).toBe(true);
    expect(directory.users.find((user) => user.id === "agent")?.online).toBe(false);
    hers.close();
    his.close();
  });
});
