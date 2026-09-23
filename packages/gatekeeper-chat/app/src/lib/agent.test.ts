import { describe, expect, it } from "vitest";

import { AGENT_USER_ID, type Channel, type Message } from "../contract.js";
import { AGENT_DISCLOSURE, agentHint, agentWorking, composerAgentNote, isAgent, isAgentDm } from "./agent.js";

const channel = (patch: Partial<Channel>): Pick<Channel, "kind" | "memberIds"> => ({ kind: "public", ...patch });

describe("isAgent", () => {
  it("knows the built-in Agent by kind or by its reserved id", () => {
    expect(isAgent({ id: AGENT_USER_ID })).toBe(true);
    expect(isAgent({ id: "anything", kind: "agent" })).toBe(true);
    expect(isAgent({ id: "alice", kind: "person" })).toBe(false);
    expect(isAgent(undefined)).toBe(false);
  });

  it("recognises only a one-to-one DM with the Agent", () => {
    expect(isAgentDm(channel({ kind: "dm", memberIds: ["me", AGENT_USER_ID] }))).toBe(true);
    expect(isAgentDm(channel({ kind: "group", memberIds: ["me", "alice", AGENT_USER_ID] }))).toBe(false);
    expect(isAgentDm(channel({ kind: "dm", memberIds: ["me", "alice"] }))).toBe(false);
  });
});

describe("composerAgentNote", () => {
  it("discloses what is sent when a draft asks, in a public channel or a DM with the Agent", () => {
    expect(composerAgentNote(channel({}), "@Agent what changed?", "enabled")).toEqual({
      tone: "info",
      text: AGENT_DISCLOSURE,
    });
    expect(AGENT_DISCLOSURE).toContain("20 earlier messages");
    const dm = channel({ kind: "dm", memberIds: ["me", AGENT_USER_ID] });
    expect(composerAgentNote(dm, "hello", "enabled")?.tone).toBe("info");
    // An empty draft in the DM says nothing; the header already explains the Agent.
    expect(composerAgentNote(dm, "", "enabled")).toBeNull();
  });

  it("warns ahead of time where the Agent will not answer, or is switched off", () => {
    expect(composerAgentNote(channel({ kind: "private" }), "@agent read this", "enabled")).toMatchObject({
      tone: "warn",
      text: expect.stringContaining("only answers in public channels"),
    });
    expect(composerAgentNote(channel({}), "@agent hi", "disabled")).toEqual({
      tone: "warn",
      text: agentHint("disabled"),
    });
  });

  it("says nothing for an ordinary draft", () => {
    expect(composerAgentNote(channel({}), "no agents here, ops@agent.example", "enabled")).toBeNull();
  });
});

describe("agentWorking", () => {
  const base = { id: "m", agentRequest: undefined } as unknown as Message;
  const withState = (state: "pending" | "accepted" | "replied" | "failed"): Message => ({
    ...base,
    agentRequest: { state, requesterId: "me", error: null, retryable: false, chatPath: null, replyId: null, updatedAt: 1 },
  });

  it("is true while a question is pending or accepted, and not after", () => {
    expect(agentWorking([base, withState("pending")])).toBe(true);
    expect(agentWorking([withState("accepted")])).toBe(true);
    expect(agentWorking([withState("replied"), withState("failed"), base])).toBe(false);
  });
});
