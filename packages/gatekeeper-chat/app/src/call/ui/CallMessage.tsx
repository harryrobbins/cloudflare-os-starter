// A call's system message in the history.
//
// While the call runs: "Eve Novak started a call" with a Join button. Once it ends the server edits
// the same message, and it reads "Call ended · 23 min · Harry, Alice, Bob". The Join button follows
// the *live* room rather than the message alone: a message still saying "active" whose call is gone
// from the store (the edit is on its way) shows no button, and a full call says so.

import { PhoneDisconnect, VideoCamera } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import type { CallSummary, Message } from "../../contract.js";
import { formatTime } from "../../lib/format.js";
import { useChat, useStore } from "../../hooks/store.js";
import { callButtonState, type CallButtonState } from "../../store/calls.js";
import { callEndedText } from "./layout.js";

export function CallMessage({ message, summary }: { message: Message; summary: CallSummary }): ReactNode {
  const store = useStore();
  const users = useChat((state) => state.users);
  const live = useChat((state) => state.calls[message.channelId]);
  const feature = useChat((state) => state.callFeature);
  const local = useChat((state) => state.call);
  const meId = useChat((state) => state.me?.id);
  const member = useChat((state) => state.memberships[message.channelId] !== undefined);
  const button =
    summary.state === "active" && live?.id === summary.id
      ? callButtonState({ feature, call: live, local, channelId: message.channelId, meId, member, archived: false })
      : ({ kind: "hidden" } as const);

  return (
    <CallMessageView
      message={message}
      summary={summary}
      nameOf={(id) => users[id]?.name}
      button={button}
      onJoin={() => store.openCallPrejoin(message.channelId)}
      onShowCall={() => store.setCallChatOpen(false)}
    />
  );
}

export function CallMessageView({
  message,
  summary,
  nameOf,
  button,
  onJoin,
  onShowCall,
}: {
  message: Message;
  summary: CallSummary;
  nameOf: (userId: string) => string | undefined;
  button: CallButtonState;
  onJoin: () => void;
  onShowCall: () => void;
}): ReactNode {
  const ended = summary.state === "ended";
  const text = ended
    ? callEndedText(summary, nameOf)
    : `${nameOf(message.authorId) ?? "Someone"} started a call`;

  return (
    <div role="listitem" data-call={summary.state} className="flex items-center gap-2 px-5 py-1.5 text-[12px] text-kumo-subtle">
      <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
      <span
        className={[
          "inline-flex min-w-0 shrink items-center gap-2 rounded-full border px-2.5 py-1",
          ended ? "border-kumo-line" : "border-kumo-success/40 bg-kumo-success-tint text-kumo-default",
        ].join(" ")}
      >
        {ended ? (
          <PhoneDisconnect size={13} className="shrink-0 text-kumo-inactive" aria-hidden="true" />
        ) : (
          <VideoCamera size={13} weight="fill" className="shrink-0 text-kumo-success" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate">{text}</span>
        <time dateTime={new Date(message.createdAt).toISOString()} className="shrink-0 text-kumo-inactive tabular-nums">
          {formatTime(message.createdAt)}
        </time>
        {button.kind === "join" || button.kind === "start" ? (
          <button
            type="button"
            onClick={onJoin}
            className="press shrink-0 cursor-pointer rounded-full bg-kumo-success px-2 py-0.5 text-[11px] font-semibold text-white hover:brightness-110"
          >
            Join
          </button>
        ) : button.kind === "in-call" ? (
          <button
            type="button"
            onClick={onShowCall}
            className="shrink-0 cursor-pointer text-[11px] font-semibold text-kumo-success hover:underline"
          >
            You're in this call
          </button>
        ) : button.kind === "full" ? (
          <span className="shrink-0 text-[11px] text-kumo-inactive">Full ({button.max})</span>
        ) : null}
      </span>
      <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
    </div>
  );
}
