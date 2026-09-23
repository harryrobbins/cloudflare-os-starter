// The Agent's side of a message: where a question stands, and where an answer came from.
//
// One quiet line under the message, in the same register as "Not sent": the question and the answer
// are the conversation, this is only the plumbing showing through. Everyone sees the state; only the
// person who asked gets Retry and the workspace link, because the workspace is theirs alone.

import { ArrowSquareOut, Robot, WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import type { Message } from "../contract.js";
import { AGENT_DISCLOSURE } from "../lib/agent.js";

/**
 * A same-origin shell path, opened in the top window: the app may be in the shell's dock or `/chat`
 * frame, and the workspace belongs in the shell, not inside the chat pane.
 */
function WorkspaceLink({ path }: { readonly path: string }): ReactNode {
  return (
    <a
      href={path}
      target="_top"
      className="inline-flex items-center gap-1 font-medium text-kumo-link underline-offset-2 hover:underline"
    >
      Open in workspace
      <ArrowSquareOut size={11} aria-hidden="true" />
    </a>
  );
}

export function AgentRequestStatus({
  message,
  meId,
  onRetry,
}: {
  readonly message: Message;
  readonly meId: string | undefined;
  readonly onRetry: () => void;
}): ReactNode {
  const request = message.agentRequest;
  if (request === undefined) return null;
  const asker = request.requesterId === meId;

  if (request.state === "pending" || request.state === "accepted") {
    return (
      <p
        className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-kumo-subtle"
        title={AGENT_DISCLOSURE}
        data-agent-state={request.state}
      >
        <Robot size={12} aria-hidden="true" />
        <span>{request.state === "pending" ? "Asking the Agent…" : "The Agent is working on it…"}</span>
        {asker && request.chatPath !== null && (
          <>
            <span aria-hidden="true" className="text-kumo-inactive">·</span>
            <WorkspaceLink path={request.chatPath} />
          </>
        )}
      </p>
    );
  }

  if (request.state === "failed") {
    return (
      <p
        className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-kumo-danger"
        data-agent-state="failed"
      >
        <WarningCircle size={12} weight="fill" aria-hidden="true" />
        <span className="font-medium">The Agent could not answer:</span>
        <span className="text-kumo-default">{request.error ?? "Something went wrong."}</span>
        {asker && request.retryable && (
          <>
            <span aria-hidden="true" className="text-kumo-inactive">·</span>
            <button
              type="button"
              onClick={onRetry}
              className="cursor-pointer font-semibold underline underline-offset-2 hover:no-underline"
            >
              Retry
            </button>
          </>
        )}
      </p>
    );
  }

  // Answered: the answer itself is the status. Nothing to add.
  return null;
}

export function AgentReplyFooter({
  message,
  meId,
}: {
  readonly message: Message;
  readonly meId: string | undefined;
}): ReactNode {
  const reply = message.agentReply;
  if (reply === undefined || reply.requesterId !== meId || reply.chatPath === null) return null;
  return (
    <p className="mt-1 text-[11px] text-kumo-subtle">
      <WorkspaceLink path={reply.chatPath} />
    </p>
  );
}
