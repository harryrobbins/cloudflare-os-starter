// The conversation header's call button.
//
// Four faces, from `callButtonState` in the store: "Start call" with nothing running, a green
// "Join · 3" pill with the first faces while a call runs, "In call" while this frame is in it (a
// click brings the grid back from the Chat toggle), and a disabled button once the call is full.
// Hidden entirely when the deployment has no calls. Start and Join both open the pre-join pane
// rather than joining outright: the camera prompt deserves a preview first.

import { VideoCamera } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { useCallPlace, useChat, useStore } from "../../hooks/store.js";
import { callButtonState, type CallButtonState } from "../../store/calls.js";
import { Avatar } from "../../components/primitives.js";

export function CallButton({ channelId }: { channelId: string }): ReactNode {
  const store = useStore();
  const feature = useChat((state) => state.callFeature);
  const call = useChat((state) => state.calls[channelId]);
  const local = useCallPlace();
  const meId = useChat((state) => state.me?.id);
  const member = useChat((state) => state.memberships[channelId] !== undefined);
  const archived = useChat((state) => state.channels[channelId]?.archived === true);
  const users = useChat((state) => state.users);
  const buttonState = callButtonState({ feature, call, local, channelId, meId, member, archived });

  return (
    <CallButtonView
      state={buttonState}
      nameOf={(id) => users[id]?.name}
      onStart={() => store.openCallPrejoin(channelId)}
      onShowCall={() => store.setCallChatOpen(false)}
    />
  );
}

export function CallButtonView({
  state,
  nameOf,
  onStart,
  onShowCall,
}: {
  state: CallButtonState;
  nameOf: (userId: string) => string | undefined;
  onStart: () => void;
  onShowCall: () => void;
}): ReactNode {
  switch (state.kind) {
    case "hidden":
      return null;
    case "start":
      return (
        <button
          type="button"
          onClick={onStart}
          aria-label="Start call"
          title="Start a video call"
          className="press inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-kumo-line px-2 text-[12px] text-kumo-subtle transition-colors hover:border-kumo-ring hover:text-kumo-default"
        >
          <VideoCamera size={14} />
          <span className="hidden sm:inline">Start call</span>
        </button>
      );
    case "join": {
      const names = state.userIds.map((id) => nameOf(id) ?? "Someone");
      return (
        <button
          type="button"
          onClick={onStart}
          aria-label={`Join call, ${state.count} in the call`}
          title={`Join the call with ${names.join(", ")}${state.count > names.length ? " and others" : ""}`}
          data-testid="call-join"
          className="press inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full bg-kumo-success pr-2.5 pl-1 text-[12px] font-semibold text-white transition-[filter] hover:brightness-110"
        >
          <span className="flex -space-x-1.5" aria-hidden="true">
            {state.userIds.map((id) => (
              <span key={id} className="rounded-[30%] ring-2 ring-kumo-success">
                <Avatar name={nameOf(id) ?? "?"} id={id} size={20} />
              </span>
            ))}
          </span>
          <VideoCamera size={13} weight="fill" aria-hidden="true" />
          Join · {state.count}
        </button>
      );
    }
    case "in-call":
      return (
        <button
          type="button"
          onClick={onShowCall}
          aria-label="In call, show the call"
          className="press inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-kumo-success/40 bg-kumo-success-tint px-2.5 text-[12px] font-semibold text-kumo-success"
        >
          <span className="chat-live-dot h-1.5 w-1.5 rounded-full bg-kumo-success" aria-hidden="true" />
          In call
        </button>
      );
    case "full":
      // The tooltip sits on a wrapper: a disabled button receives no pointer events to show one.
      return (
        <span title={`This call is full (${state.max})`} className="inline-flex">
          <button
            type="button"
            disabled
            aria-label={`This call is full (${state.max})`}
            className="inline-flex h-7 cursor-not-allowed items-center gap-1.5 rounded-full border border-kumo-line px-2.5 text-[12px] text-kumo-inactive"
          >
            <VideoCamera size={13} />
            Full
          </button>
        </span>
      );
  }
}
