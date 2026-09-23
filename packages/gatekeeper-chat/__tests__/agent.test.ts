// `@agent`: the outbox, the prompt, the answer, and who may ask where.
//
// The Workshop is the mock in __tests__/aux/workshop-gateway.js, bound as WORKSHOP_GATEWAY with the
// same entrypoint and props deploy.ts gives the real one. It keeps the reply target it is handed, and
// `WORKSHOP_CONTROL.respond()` calls it back -- so an answer in these tests travels the production
// path: a `ChatAgentReply` stub minted by the object, through another Worker, into
// `ChatAgentReply.onGadgetResponse`, and back into the object.
//
// Dispatch runs from the object's alarm, which a question arms for "now" -- so under test it fires by
// itself, straight after the send. The suites therefore wait for a state rather than assume who got
// there first, and call `runAgentOutbox()` (the test seam, serialised with the alarm) only for the
// steps the alarm would otherwise take seconds or minutes to reach: a backoff, a timeout.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  AGENT_CONTEXT_BYTES,
  AGENT_CONTEXT_MESSAGES,
  AGENT_REPLY_TIMEOUT_MS,
  AGENT_USER_ID,
  GENERAL_CHANNEL_ID,
  RATE_LIMITS,
  type ChannelResponse,
  type ChatIdentity,
  type MeResponse,
  type Message,
  type MessagePageResponse,
  type MessageResponse,
  type SendMessageResponse,
  type ServerEvent,
} from "../src/shared/protocol.js";
import { apiPath } from "../src/shared/routes.js";
import { mentionsAgent } from "../src/shared/validate.js";
import {
  AGENT_GADGET_TITLE,
  MAX_AGENT_ATTEMPTS,
  formatAgentReply,
  recordAgentRequest,
  safeChatPath,
  truncateUtf8,
  type AgentRequestRow,
} from "../src/do/agent.js";
import type { Broadcaster, Ctx } from "../src/do/context.js";
import { loadMessage } from "../src/do/messages.js";
import type { ChannelRow } from "../src/do/rows.js";
import { loadUserRow } from "../src/do/users.js";
import { client, freshWorkspace, identity, type Client, type Workspace } from "./helpers.js";

/** A person whose Workshop account the mock answers in a given way (see workshop-gateway.js). */
function asker(id: string, account: string, name?: string): ChatIdentity {
  return { ...identity(id, name), workshopAccount: account };
}

let seq = 0;
function clientId(): string {
  return `c-${++seq}-${crypto.randomUUID().slice(0, 8)}`;
}

async function post(who: Client, channelId: string, body: string, rootId?: string): Promise<Message> {
  const response = await who.send<SendMessageResponse>("POST", apiPath("sendMessage", { channelId }), {
    body,
    clientId: clientId(),
    ...(rootId === undefined ? {} : { rootId }),
  });
  return response.message;
}

async function question(workspace: Workspace, messageId: string): Promise<AgentRequestRow | null> {
  return runInDurableObject(workspace, (_instance, state) =>
    state.storage.sql.exec<AgentRequestRow>(`SELECT * FROM agent_requests WHERE message_id = ?`, messageId).toArray()[0] ?? null,
  );
}

/** Waits for a question to reach a state, running the outbox meanwhile. */
async function settle(workspace: Workspace, messageId: string, state: string): Promise<AgentRequestRow> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const row = await question(workspace, messageId);
    if (row?.state === state) return row;
    if (Date.now() > deadline) throw new Error(`${messageId} is ${row?.state ?? "missing"}, not ${state}.`);
    await workspace.runAgentOutbox();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function sql(workspace: Workspace, query: string, ...params: unknown[]): Promise<void> {
  await runInDurableObject(workspace, (_instance, state) => {
    state.storage.sql.exec(query, ...params);
  });
}

async function page(who: Client, channelId: string, rootId?: string): Promise<MessagePageResponse> {
  const search = rootId === undefined ? "" : `?rootId=${encodeURIComponent(rootId)}`;
  return who.get<MessagePageResponse>(`${apiPath("listMessages", { channelId })}${search}`);
}

async function createChannel(who: Client, body: Record<string, unknown>): Promise<string> {
  return (await who.send<ChannelResponse>("POST", apiPath("createChannel"), body)).channel.id;
}

describe("mentionsAgent", () => {
  it("recognises the token and the bare name, and nothing that merely contains it", () => {
    expect(mentionsAgent("<@agent> what changed?")).toBe(true);
    expect(mentionsAgent("hey @agent, summarise")).toBe(true);
    expect(mentionsAgent("@Agent summarise")).toBe(true);
    expect(mentionsAgent("@agents are people too")).toBe(false);
    expect(mentionsAgent("mail ops@agent.example")).toBe(false);
    expect(mentionsAgent("<@alice> no agent here")).toBe(false);
  });
});

describe("asking in a public channel", () => {
  it("queues, dispatches as the verified asker, and posts the answer in the message's thread", async () => {
    const workspace = freshWorkspace("agent-public");
    const alice = client(workspace, asker("alice", "Alice@Example.Test", "Alice"));
    const bob = client(workspace, identity("bob", "Bob"));
    await post(bob, GENERAL_CHANNEL_ID, "Deploys are frozen until Friday.");
    const socket = await bob.socket();

    const asked = await post(alice, GENERAL_CHANNEL_ID, "<@agent> when can I deploy?");
    // The row exists before the Workshop is called, and the sender's own response says so.
    expect(asked.agentRequest).toMatchObject({ state: "pending", requesterId: "alice", replyId: null });

    await settle(workspace, asked.id, "accepted");
    const [call, ...again] = await env.WORKSHOP_CONTROL.calls(asked.id);
    expect(again).toEqual([]);
    expect(call).toMatchObject({
      source: "chat",
      // Verbatim from the identity the Worker verified, never lowercased.
      callerEmail: "Alice@Example.Test",
      gadgetKey: "user:alice",
      gadgetTitle: AGENT_GADGET_TITLE,
      chatKey: `channel:${GENERAL_CHANNEL_ID}:thread:${asked.id}`,
      messageKey: asked.id,
      hasTarget: true,
    });
    expect(String(call!["prompt"])).toContain("You are the Agent member of the team chat, replying to Alice in #general.");
    expect(String(call!["prompt"])).toContain("Deploys are frozen until Friday.");
    expect(String(call!["prompt"])).toMatch(/The message to answer, from Alice:\n@Agent when can I deploy\?$/u);

    const accepted = await question(workspace, asked.id);
    expect(accepted).toMatchObject({ state: "accepted", attempts: 1, chat_path: "/workspace/chat-user:alice?chat=1" });
    const acceptedEvent = await socket.next("agent");
    expect(acceptedEvent).toMatchObject({ channel: GENERAL_CHANNEL_ID, id: asked.id, rootId: null });

    await env.WORKSHOP_CONTROL.respond(asked.id, "After Friday's freeze lifts.");
    const replied = await question(workspace, asked.id);
    expect(replied?.state).toBe("replied");

    const thread = await page(bob, GENERAL_CHANNEL_ID, asked.id);
    const reply = thread.messages.find((message) => message.id === replied?.reply_id);
    expect(reply).toMatchObject({
      authorId: AGENT_USER_ID,
      kind: "agent",
      rootId: asked.id,
      body: "After Friday's freeze lifts.",
      agentReply: { requestId: asked.id, requesterId: "alice", chatPath: "/workspace/chat-user:alice?chat=1" },
    });
    const root = thread.messages.find((message) => message.id === asked.id);
    expect(root?.agentRequest).toMatchObject({ state: "replied", replyId: reply!.id });

    const events = socket.events.filter((event): event is Extract<ServerEvent, { t: "agent" }> => event.t === "agent");
    expect(events.map((event) => event.request.state)).toEqual(["accepted", "replied"]);
    // The reply is re-sent once it is linked to its question.
    expect(socket.all("edit").some((event) => event.message.agentReply?.requestId === asked.id)).toBe(true);
    // Answered is final: there is nothing to retry.
    expect(await alice.status("POST", apiPath("retryAgent", { messageId: asked.id }))).toBe(409);
    socket.close();
  });

  it("answers a mention inside a thread in that thread, keyed by its root", async () => {
    const workspace = freshWorkspace("agent-thread");
    const alice = client(workspace, asker("alice", "alice@example.test", "Alice"));
    const root = await post(alice, GENERAL_CHANNEL_ID, "Incident review");
    await post(alice, GENERAL_CHANNEL_ID, "It started at 10:02.", root.id);
    const asked = await post(alice, GENERAL_CHANNEL_ID, "@agent summarise this thread", root.id);

    await settle(workspace, asked.id, "accepted");
    const [call] = await env.WORKSHOP_CONTROL.calls(asked.id);
    expect(call).toMatchObject({ chatKey: `channel:${GENERAL_CHANNEL_ID}:thread:${root.id}` });
    // The thread is the context: its root and its replies, not the channel's other traffic.
    expect(String(call!["prompt"])).toContain("Incident review");
    expect(String(call!["prompt"])).toContain("It started at 10:02.");
    expect(String(call!["prompt"])).toContain("in #general, in a thread");

    await env.WORKSHOP_CONTROL.respond(asked.id, "It started at 10:02.");
    const reply = (await page(alice, GENERAL_CHANNEL_ID, root.id)).messages.find(
      (message) => message.authorId === AGENT_USER_ID,
    );
    expect(reply?.rootId).toBe(root.id);
  });

  it("dispatches from the real alarm, which the send arms", async () => {
    const workspace = freshWorkspace("agent-alarm");
    const alice = client(workspace, asker("alice", "alice@example.test"));
    const asked = await post(alice, GENERAL_CHANNEL_ID, "@agent ping");
    // Either the alarm has already fired on its own or it is still armed; never neither.
    const deadline = Date.now() + 3000;
    while ((await question(workspace, asked.id))?.state !== "accepted") {
      await runDurableObjectAlarm(workspace);
      if (Date.now() > deadline) throw new Error("The alarm never dispatched the question.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // With an accepted question outstanding the alarm stays armed, for its timeout.
    const alarm = await runInDurableObject(workspace, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + AGENT_REPLY_TIMEOUT_MS - 60_000);
  });

  it("does not ask for an ordinary message, or for the Agent's own", async () => {
    const workspace = freshWorkspace("agent-quiet");
    const alice = client(workspace, asker("alice", "alice@example.test"));
    const plain = await post(alice, GENERAL_CHANNEL_ID, "no agent here, @agents are fine");
    expect(plain.agentRequest).toBeUndefined();
    expect(await question(workspace, plain.id)).toBeNull();
  });
});

describe("where the Agent may answer", () => {
  it("refuses a private channel visibly, without building a prompt or calling the Workshop", async () => {
    const workspace = freshWorkspace("agent-private");
    const alice = client(workspace, asker("alice", "alice@example.test"));
    const secret = await createChannel(alice, { kind: "private", name: "secret" });
    const asked = await post(alice, secret, "@agent the password is hunter2");

    expect(asked.agentRequest).toMatchObject({ state: "failed", retryable: false });
    expect(asked.agentRequest?.error).toContain("only answers in public channels");
    expect((await question(workspace, asked.id))?.prompt).toBe("");
    await workspace.runAgentOutbox();
    expect(await env.WORKSHOP_CONTROL.calls(asked.id)).toEqual([]);
    expect(await alice.error("POST", apiPath("retryAgent", { messageId: asked.id }))).toEqual({
      status: 409,
      code: "conflict",
    });
  });

  it("refuses a group conversation and a DM between two people", async () => {
    const workspace = freshWorkspace("agent-group");
    const alice = client(workspace, asker("alice", "alice@example.test"));
    await client(workspace, identity("bob")).get("/gatekeeper/chat/api/me");
    await client(workspace, identity("carol")).get("/gatekeeper/chat/api/me");
    const group = await createChannel(alice, { kind: "group", memberIds: ["bob", "carol"] });
    const dm = await createChannel(alice, { kind: "dm", memberIds: ["bob"] });

    for (const channelId of [group, dm]) {
      const asked = await post(alice, channelId, "<@agent> read this");
      expect(asked.agentRequest).toMatchObject({ state: "failed", retryable: false });
    }
    // An unaddressed message in either is not a question at all.
    expect((await post(alice, group, "just us")).agentRequest).toBeUndefined();
  });

  it("answers every message of a DM with Agent, inline, in one workspace chat", async () => {
    const workspace = freshWorkspace("agent-dm");
    const alice = client(workspace, asker("alice", "alice@example.test", "Alice"));
    const dm = await createChannel(alice, { kind: "dm", memberIds: [AGENT_USER_ID] });
    // Deduplicated like any DM: asking twice finds the same conversation.
    expect(await createChannel(alice, { kind: "dm", memberIds: [AGENT_USER_ID] })).toBe(dm);

    const first = await post(alice, dm, "What is our deploy policy?");
    expect(first.agentRequest?.state).toBe("pending");
    await settle(workspace, first.id, "accepted");
    const [call] = await env.WORKSHOP_CONTROL.calls(first.id);
    expect(call).toMatchObject({ chatKey: `dm:${dm}` });
    expect(String(call!["prompt"])).toContain("replying to Alice in a direct message with you.");
    expect(String(call!["prompt"])).toContain("Only Alice can read it.");

    await env.WORKSHOP_CONTROL.respond(first.id, "Fridays are frozen.");
    const messages = (await page(alice, dm)).messages;
    const reply = messages.find((message) => message.authorId === AGENT_USER_ID);
    expect(reply).toMatchObject({ rootId: null, body: "Fridays are frozen." });

    const second = await post(alice, dm, "And Saturdays?");
    await settle(workspace, second.id, "accepted");
    expect((await env.WORKSHOP_CONTROL.calls(second.id))[0]).toMatchObject({ chatKey: `dm:${dm}` });
  });
});

describe("the outbox state machine", () => {
  it("retries a thrown call with backoff, under the same message key", async () => {
    const workspace = freshWorkspace("agent-flaky");
    const alice = client(workspace, asker("alice", "flaky-alice@example.test"));
    const asked = await post(alice, GENERAL_CHANNEL_ID, "@agent hello");

    const next = await workspace.runAgentOutbox();
    const waiting = await question(workspace, asked.id);
    expect(waiting).toMatchObject({ state: "pending", attempts: 1 });
    expect(waiting!.next_attempt_at).toBeGreaterThan(Date.now());
    expect(next).toBe(waiting!.next_attempt_at);
    const alarm = await runInDurableObject(workspace, (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBe(waiting!.next_attempt_at);

    // Not due yet: nothing happens.
    await workspace.runAgentOutbox();
    expect((await question(workspace, asked.id))?.attempts).toBe(1);

    await sql(workspace, `UPDATE agent_requests SET next_attempt_at = 0 WHERE message_id = ?`, asked.id);
    await workspace.runAgentOutbox();
    expect((await question(workspace, asked.id))?.state).toBe("accepted");
    expect((await env.WORKSHOP_CONTROL.calls(asked.id)).map((call) => call["messageKey"])).toEqual([asked.id, asked.id]);
  });

  it(`gives up after ${MAX_AGENT_ATTEMPTS} attempts with a retryable failure`, async () => {
    const workspace = freshWorkspace("agent-down");
    const alice = client(workspace, asker("alice", "throw-alice@example.test"));
    const asked = await post(alice, GENERAL_CHANNEL_ID, "@agent hello");
    for (let attempt = 0; attempt < MAX_AGENT_ATTEMPTS; attempt++) {
      await sql(workspace, `UPDATE agent_requests SET next_attempt_at = 0 WHERE message_id = ? AND state = 'pending'`, asked.id);
      await workspace.runAgentOutbox();
    }
    const failed = await question(workspace, asked.id);
    expect(failed).toMatchObject({ state: "failed", attempts: MAX_AGENT_ATTEMPTS, retryable: 1 });
    expect(failed?.error).toContain("could not be reached");
    expect(await workspace.runAgentOutbox()).toBeNull();
  });

  it("surfaces the Workshop's refusal, and lets only the asker retry it as a new question", async () => {
    const workspace = freshWorkspace("agent-nomodel");
    const alice = client(workspace, asker("alice", "nomodel-alice@example.test"));
    const bob = client(workspace, asker("bob", "bob@example.test"));
    const asked = await post(alice, GENERAL_CHANNEL_ID, "@agent hello");
    await settle(workspace, asked.id, "failed");

    const rows = (await page(bob, GENERAL_CHANNEL_ID)).messages;
    expect(rows.find((message) => message.id === asked.id)?.agentRequest).toMatchObject({
      state: "failed",
      retryable: true,
      error: "Your Cloudflare OS account needs an AI model configured before it can respond.",
    });

    expect(await bob.error("POST", apiPath("retryAgent", { messageId: asked.id }))).toEqual({
      status: 403,
      code: "forbidden",
    });
    const retried = await alice.send<MessageResponse>("POST", apiPath("retryAgent", { messageId: asked.id }));
    expect(retried.message.agentRequest).toMatchObject({ state: "pending", error: null });
    const again = await settle(workspace, asked.id, "failed");
    expect(again.generation).toBe(1);
    expect((await env.WORKSHOP_CONTROL.calls(asked.id)).map((call) => call["messageKey"])).toEqual([
      asked.id,
      `${asked.id}.1`,
    ]);
  });

  it("times out an accepted question, and still posts an answer that arrives late", async () => {
    const workspace = freshWorkspace("agent-timeout");
    const alice = client(workspace, asker("alice", "alice@example.test"));
    const asked = await post(alice, GENERAL_CHANNEL_ID, "@agent think hard");
    const accepted = await settle(workspace, asked.id, "accepted");
    expect(await workspace.runAgentOutbox()).toBe(accepted.accepted_at! + AGENT_REPLY_TIMEOUT_MS);

    await sql(
      workspace,
      `UPDATE agent_requests SET accepted_at = ? WHERE message_id = ?`,
      Date.now() - AGENT_REPLY_TIMEOUT_MS - 1,
      asked.id,
    );
    await workspace.runAgentOutbox();
    expect(await question(workspace, asked.id)).toMatchObject({ state: "failed", retryable: 1 });

    await env.WORKSHOP_CONTROL.respond(asked.id, "Here after all.");
    expect((await question(workspace, asked.id))?.state).toBe("replied");
  });

  it("posts one reply however many times, and however concurrently, the answer is delivered", async () => {
    const workspace = freshWorkspace("agent-dup");
    const alice = client(workspace, asker("alice", "alice@example.test"));
    const asked = await post(alice, GENERAL_CHANNEL_ID, "@agent once please");
    await settle(workspace, asked.id, "accepted");

    await Promise.all([
      env.WORKSHOP_CONTROL.respond(asked.id, "Once."),
      env.WORKSHOP_CONTROL.respond(asked.id, "Once."),
    ]);
    await env.WORKSHOP_CONTROL.respond(asked.id, "Once, again.");
    await expect(workspace.deliverAgentReply(asked.id, asked.id, "Direct.")).resolves.toBe("duplicate");

    const replies = (await page(alice, GENERAL_CHANNEL_ID, asked.id)).messages.filter(
      (message) => message.authorId === AGENT_USER_ID,
    );
    expect(replies.map((message) => message.body)).toEqual(["Once."]);
  });

  it("ignores an answer for a key that is not the question's, or for a deleted question", async () => {
    const workspace = freshWorkspace("agent-ignore");
    const alice = client(workspace, asker("alice", "alice@example.test"));
    const asked = await post(alice, GENERAL_CHANNEL_ID, "@agent one");
    await expect(workspace.deliverAgentReply(asked.id, "someone-else", "Nope.")).resolves.toBe("ignored");

    await settle(workspace, asked.id, "accepted");
    expect(await alice.status("DELETE", apiPath("deleteMessage", { messageId: asked.id }))).toBe(200);
    expect(await question(workspace, asked.id)).toBeNull();
    await env.WORKSHOP_CONTROL.respond(asked.id, "Too late.");
    const bodies = (await page(alice, GENERAL_CHANNEL_ID)).messages.map((message) => message.body);
    expect(bodies).not.toContain("Too late.");
  });

  it("holds a second question in the same conversation until the first is answered", async () => {
    const workspace = freshWorkspace("agent-serial");
    const alice = client(workspace, asker("alice", "alice@example.test"));
    const root = await post(alice, GENERAL_CHANNEL_ID, "@agent first");
    const second = await post(alice, GENERAL_CHANNEL_ID, "@agent second", root.id);
    const elsewhere = await post(alice, GENERAL_CHANNEL_ID, "@agent unrelated");

    await settle(workspace, root.id, "accepted");
    // A different thread does not wait; the same thread does.
    await settle(workspace, elsewhere.id, "accepted");
    await workspace.runAgentOutbox();
    expect((await question(workspace, second.id))?.state).toBe("pending");
    expect(await env.WORKSHOP_CONTROL.calls(second.id)).toEqual([]);

    await env.WORKSHOP_CONTROL.respond(root.id, "First answer.");
    await settle(workspace, second.id, "accepted");
  });

  it(`limits each person to ${RATE_LIMITS.agentRequestsPerHour} questions an hour, and still sends the message`, async () => {
    const workspace = freshWorkspace("agent-budget");
    const alice = client(workspace, asker("alice", "alice@example.test"));
    for (let i = 0; i < RATE_LIMITS.agentRequestsPerHour; i++) {
      expect((await post(alice, GENERAL_CHANNEL_ID, `@agent ${i}`)).agentRequest?.state).toBe("pending");
    }
    const over = await post(alice, GENERAL_CHANNEL_ID, "@agent one more");
    expect(over.agentRequest).toMatchObject({ state: "failed", retryable: true });
    expect(over.agentRequest?.error).toContain("Try again in");
    expect(await alice.error("POST", apiPath("retryAgent", { messageId: over.id }))).toEqual({
      status: 429,
      code: "rate_limited",
    });
    // Somebody else's budget is their own.
    const bob = client(workspace, asker("bob", "bob@example.test"));
    expect((await post(bob, GENERAL_CHANNEL_ID, "@agent mine")).agentRequest?.state).toBe("pending");
  });
});

describe("the prompt", () => {
  it(`carries at most ${AGENT_CONTEXT_MESSAGES} earlier messages and ${AGENT_CONTEXT_BYTES} bytes of them`, async () => {
    const workspace = freshWorkspace("agent-window");
    const alice = client(workspace, asker("alice", "alice@example.test", "Alice"));
    const bob = client(workspace, identity("bob", "Bob"));
    for (let i = 0; i < AGENT_CONTEXT_MESSAGES + 5; i++) await post(bob, GENERAL_CHANNEL_ID, `short ${i}`);
    const asked = await post(alice, GENERAL_CHANNEL_ID, "<@agent> what did <@bob> say?");
    const prompt = (await question(workspace, asked.id))!.prompt;
    expect(prompt).not.toContain("short 4\n");
    expect(prompt).toContain("short 5\n");
    expect(prompt).toContain(`short ${AGENT_CONTEXT_MESSAGES + 4}`);
    expect(prompt.match(/\] Bob: short/gu)?.length).toBe(AGENT_CONTEXT_MESSAGES);
    // Tokens read as names, the way people see them.
    expect(prompt).toContain("@Agent what did @Bob say?");

    const wide = freshWorkspace("agent-bytes");
    const carol = client(wide, asker("carol", "carol@example.test"));
    const big = "x".repeat(1_900);
    for (let i = 0; i < AGENT_CONTEXT_MESSAGES; i++) await post(carol, GENERAL_CHANNEL_ID, `${i} ${big}`);
    const bytes = await post(carol, GENERAL_CHANNEL_ID, "@agent summarise");
    const bounded = (await question(wide, bytes.id))!.prompt;
    const context = bounded.split("\n").filter((line) => line.startsWith("["));
    expect(context.length).toBeLessThan(AGENT_CONTEXT_MESSAGES);
    expect(new TextEncoder().encode(context.join("\n")).length).toBeLessThanOrEqual(AGENT_CONTEXT_BYTES);
    // The newest are the ones kept.
    expect(context.at(-1)).toContain(`${AGENT_CONTEXT_MESSAGES - 1} xxx`);
  });

  it("never includes another conversation, even one the asker belongs to", async () => {
    const workspace = freshWorkspace("agent-scope");
    const alice = client(workspace, asker("alice", "alice@example.test"));
    const secret = await createChannel(alice, { kind: "private", name: "secret" });
    await post(alice, secret, "private words");
    const dm = await createChannel(alice, { kind: "dm", memberIds: [AGENT_USER_ID] });
    await post(alice, dm, "dm words");
    await post(alice, GENERAL_CHANNEL_ID, "public words");
    const asked = await post(alice, GENERAL_CHANNEL_ID, "@agent what have I said?");
    const prompt = (await question(workspace, asked.id))!.prompt;
    expect(prompt).toContain("public words");
    expect(prompt).not.toContain("private words");
    expect(prompt).not.toContain("dm words");
  });

  it("bounds text by bytes on a code point boundary, and replies by the body cap", () => {
    expect(truncateUtf8("héllo", 2)).toBe("h");
    expect(truncateUtf8("héllo", 3)).toBe("hé");
    expect(truncateUtf8("😀😀", 5)).toBe("😀");
    expect(formatAgentReply("   ")).toContain("without saying anything");
    const long = formatAgentReply("y".repeat(20_000));
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(8 * 1024);
    expect(long).toContain("Reply shortened");
  });

  it("only keeps a chat path that stays on this origin", () => {
    expect(safeChatPath("/workspace/abc?chat=2")).toBe("/workspace/abc?chat=2");
    expect(safeChatPath("//evil.example/x")).toBeNull();
    expect(safeChatPath("https://evil.example/")).toBeNull();
    expect(safeChatPath("/\\evil.example")).toBeNull();
  });
});

describe("status and configuration", () => {
  it("reports replies as enabled in /api/me when the gateway is bound, and never echoes the account", async () => {
    const workspace = freshWorkspace("agent-me");
    const alice = client(workspace, asker("alice", "Secret.Account@example.test"));
    const response = await alice.request("GET", apiPath("me"));
    const text = await response.text();
    expect((JSON.parse(text) as MeResponse).agent).toEqual({ replies: "enabled" });
    expect(text).not.toContain("Secret.Account");
  });

  it("marks a question failed, not queued, when the deployment has no gateway", async () => {
    const workspace = freshWorkspace("agent-disabled");
    const alice = client(workspace, asker("alice", "alice@example.test"));
    const plain = await post(alice, GENERAL_CHANNEL_ID, "a question, in a moment");
    await runInDurableObject(workspace, (_instance, state) => {
      const ctx = testCtx(state, { agentGateway: null });
      const author = loadUserRow(ctx, "alice")!;
      const channel = ctx.sql.exec<ChannelRow>(`SELECT * FROM channels WHERE id = ?`, GENERAL_CHANNEL_ID).toArray()[0]!;
      const message = { ...loadMessage(ctx, plain.id)!, body: "@agent are you there?" };
      expect(recordAgentRequest(ctx, author, channel, message, "alice@example.test")).toBe(false);
      const row = ctx.sql.exec<AgentRequestRow>(`SELECT * FROM agent_requests WHERE message_id = ?`, plain.id).toArray()[0];
      expect(row).toMatchObject({ state: "failed", retryable: 0, prompt: "" });
      expect(row?.error).toContain("turned off");
    });
  });

  it("refuses to ask without a Workshop account on the identity", async () => {
    const workspace = freshWorkspace("agent-noaccount");
    const alice = client(workspace, identity("alice"));
    const asked = await post(alice, GENERAL_CHANNEL_ID, "@agent hi");
    expect(asked.agentRequest).toMatchObject({ state: "failed", retryable: false });
  });
});

/** A context over a live object's storage, with the parts a test wants to vary swapped out. */
function testCtx(state: DurableObjectState, overrides: Partial<Ctx>): Ctx {
  const bus: Broadcaster = {
    toUsers() {},
    toChannel() {},
    toAll() {},
    badges() {},
    online: () => [],
    isOnline: () => false,
  };
  return {
    sql: state.storage.sql,
    storage: state.storage,
    env: env as never,
    bus,
    now: () => Date.now(),
    armSweep: async () => {},
    wakeAt: async () => {},
    agentGateway: null,
    ...overrides,
  };
}
