/**
 * The store against the in-memory fake, end to end: the flows that only make sense with a server that
 * behaves like one -- a question to the Agent that is accepted and answered later over the socket.
 */
import { afterEach, describe, expect, it } from "vitest";

import { AGENT_USER_ID, GENERAL_CHANNEL_ID } from "../contract.js";
import { conversationKey } from "../store/drafts.js";
import { ChatStore } from "../store/store.js";
import { createMockTransport } from "./index.js";

async function until(check: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the mock.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let store: ChatStore | null = null;
afterEach(() => {
  store?.dispose();
  store = null;
  window.localStorage.clear();
});

async function started(): Promise<ChatStore> {
  store = new ChatStore({ transport: createMockTransport(), navigate: () => undefined });
  await store.start({ embedded: false });
  await until(() => store!.state.socketStatus === "open");
  return store;
}

describe("the mock Agent", () => {
  it("answers @agent in a public channel in the question's thread, and says so on the question", async () => {
    const chat = await started();
    expect(chat.state.users[AGENT_USER_ID]).toMatchObject({ kind: "agent" });
    await chat.openConversation(GENERAL_CHANNEL_ID);
    chat.setDraft(conversationKey(GENERAL_CHANNEL_ID), "@Agent when is the freeze over?");
    await chat.send(GENERAL_CHANNEL_ID);

    const question = () =>
      chat.state.conversations[conversationKey(GENERAL_CHANNEL_ID)]!.messages.find((message) =>
        message.body.includes("freeze over"),
      );
    expect(question()?.agentRequest?.state).toBe("pending");
    // The composer resolved the display name to the token the server recognises.
    expect(question()?.body).toContain(`<@${AGENT_USER_ID}>`);

    await until(() => question()?.agentRequest?.state === "accepted");
    expect(question()?.agentRequest?.chatPath).toMatch(/^\/workspace\//u);
    await until(() => question()?.agentRequest?.state === "replied");
    expect(question()?.replyCount).toBe(1);
  });

  it("refuses a private channel on the message itself, and retries a refused question", async () => {
    const chat = await started();
    await chat.openConversation("c-platform");
    chat.setDraft(conversationKey("c-platform"), "@agent read this");
    await chat.send("c-platform");
    const refused = chat.state.conversations[conversationKey("c-platform")]!.messages.at(-1)!;
    expect(refused.agentRequest).toMatchObject({ state: "failed", retryable: false });

    await chat.openConversation(GENERAL_CHANNEL_ID);
    chat.setDraft(conversationKey(GENERAL_CHANNEL_ID), "@agent please fail first");
    await chat.send(GENERAL_CHANNEL_ID);
    const question = () =>
      chat.state.conversations[conversationKey(GENERAL_CHANNEL_ID)]!.messages.find((message) =>
        message.body.includes("please fail first"),
      );
    await until(() => question()?.agentRequest?.state === "failed");
    expect(question()?.agentRequest).toMatchObject({
      retryable: true,
      error: expect.stringContaining("needs an AI model"),
    });
    await chat.retryAgent(question()!.id);
    expect(question()?.agentRequest?.state).toBe("pending");
    await until(() => question()?.agentRequest?.state === "replied");
  });
});
