// How the Agent is presented: an app, not a colleague.
//
// The built-in Agent has no presence of its own -- it never opens a socket -- so it never gets the
// green or grey dot a person does. What it has instead is a state: available when this deployment
// routes `@agent` to the Workshop, switched off when it does not. Every place that lists people asks
// here rather than deciding for itself, so the Agent reads the same in People, the rail, the switcher
// and a DM header.

import {
  AGENT_CONTEXT_MESSAGES,
  AGENT_USER_ID,
  mentionsAgent,
  type Channel,
  type Message,
  type User,
  type UserId,
} from "../contract.js";

export function isAgent(user: Pick<User, "id" | "kind"> | undefined | null): boolean {
  return user !== undefined && user !== null && (user.kind === "agent" || user.id === AGENT_USER_ID);
}

export function isAgentId(userId: UserId | undefined | null): boolean {
  return userId === AGENT_USER_ID;
}

/** The one line under the Agent's name wherever it is listed. */
export function agentHint(replies: "enabled" | "disabled"): string {
  return replies === "enabled"
    ? "Mention @agent in a public channel, or message it here."
    : "Agent replies are turned off for this deployment.";
}

/** A one-to-one DM between the viewer and the Agent. */
export function isAgentDm(channel: Pick<Channel, "kind" | "memberIds"> | undefined): boolean {
  return (
    channel?.kind === "dm" &&
    channel.memberIds !== undefined &&
    channel.memberIds.length === 2 &&
    channel.memberIds.includes(AGENT_USER_ID)
  );
}

/** What asking the Agent sends, said where the asking happens. */
export const AGENT_DISCLOSURE =
  `Asking the Agent sends this message and up to ${AGENT_CONTEXT_MESSAGES} earlier messages of this ` +
  "conversation to the AI model in your own workspace. The answer is posted here for everyone who can read it.";

/**
 * What the composer should say about a draft, if anything: the disclosure when the draft asks, a
 * refusal ahead of time where the Agent will not answer, nothing otherwise.
 */
export function composerAgentNote(
  channel: Pick<Channel, "kind" | "memberIds"> | undefined,
  draft: string,
  replies: "enabled" | "disabled",
): { readonly tone: "info" | "warn"; readonly text: string } | null {
  const dm = isAgentDm(channel);
  if (!dm && !mentionsAgent(draft)) return null;
  if (replies === "disabled") return { tone: "warn", text: agentHint("disabled") };
  if (dm || channel?.kind === "public") {
    return dm && draft.trim().length === 0 ? null : { tone: "info", text: AGENT_DISCLOSURE };
  }
  return {
    tone: "warn",
    text: "The Agent only answers in public channels and in a direct message with it. Nothing here is sent to it.",
  };
}

/**
 * True while a question in this list is waiting for the Agent: the conversation's "Agent is working"
 * line. Derived from the messages rather than from a typing event, so it survives a reload and ends
 * exactly when the answer (or the failure) lands.
 */
export function agentWorking(messages: readonly Message[]): boolean {
  return messages.some(
    (message) => message.agentRequest?.state === "pending" || message.agentRequest?.state === "accepted",
  );
}
