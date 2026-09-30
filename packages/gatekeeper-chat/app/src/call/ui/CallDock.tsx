// The parts of a call that must survive whatever is on screen, mounted once in the app shell:
//
// - one hidden `<audio>` per remote participant, so the call stays audible while the grid is swapped
//   for the conversation, another conversation is open, or the shell has hidden the frame;
// - the in-call shortcuts (Ctrl/Cmd+D microphone, Ctrl/Cmd+E camera), which win over the browser's
//   bookmark and search-bar bindings only while a call is live;
// - a small "In a call" pill when the call's conversation is not the one on screen, to get back.
//   When the shell has hidden the frame it shows its own pill instead, so this one stays away.

import { Microphone, MicrophoneSlash, PhoneDisconnect, VideoCamera } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import { useChat, useStore } from "../../hooks/store.js";
import { channelLabel } from "../../lib/labels.js";
import { isLivePhase } from "../../store/calls.js";
import { RemoteAudio } from "./CallTile.js";

export function CallDock(): ReactNode {
  const store = useStore();
  const navigate = useNavigate();
  const call = useChat((state) => state.call);
  // The engine reports the output it switched to; the remembered choice covers an engine that does not.
  const sinkId = useChat((state) => state.call.audioOutputId ?? state.callDevices.audioOutputId);
  const activeChannelId = useChat((state) => state.activeChannelId);
  const shellHidden = useChat((state) => state.shellLayout === "hidden");
  const channel = useChat((state) => (call.channelId === null ? undefined : state.channels[call.channelId]));
  const users = useChat((state) => state.users);
  const meId = useChat((state) => state.me?.id);
  const live = isLivePhase(call.phase);

  useEffect(() => {
    if (!live) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "d") {
        event.preventDefault();
        store.toggleCallAudio();
      } else if (key === "e") {
        event.preventDefault();
        void store.toggleCallVideo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [live, store]);

  if (!live) return null;
  const label = channel === undefined ? "the call" : channelLabel(channel, users, meId);
  const away = call.channelId !== activeChannelId && !shellHidden;

  return (
    <>
      <div className="hidden" aria-hidden="true">
        {Object.values(call.remotes).map((remote) =>
          remote.audio === null ? null : <RemoteAudio key={remote.participantId} stream={remote.audio} sinkId={sinkId} />,
        )}
      </div>
      {away && call.channelId !== null && (
        <div
          role="region"
          aria-label="Call in progress"
          className="chat-rise fixed bottom-4 left-4 z-[1300] flex items-center gap-1 rounded-full border border-kumo-success/40 bg-kumo-control py-1 pr-1 pl-3 shadow-xl"
        >
          <button
            type="button"
            onClick={() => {
              store.setCallChatOpen(false);
              void navigate({ to: "/c/$channelId", params: { channelId: call.channelId! } });
            }}
            className="flex min-w-0 cursor-pointer items-center gap-2 text-[12px] font-medium text-kumo-default"
          >
            <span className="chat-live-dot h-2 w-2 shrink-0 rounded-full bg-kumo-success" aria-hidden="true" />
            <VideoCamera size={14} weight="fill" className="shrink-0 text-kumo-success" aria-hidden="true" />
            <span className="max-w-40 truncate">In a call · {label}</span>
            <span className="text-kumo-brand">Return</span>
          </button>
          <button
            type="button"
            onClick={() => store.toggleCallAudio()}
            aria-label={call.audioEnabled ? "Mute microphone" : "Unmute microphone"}
            title={call.audioEnabled ? "Mute microphone" : "Unmute microphone"}
            className="press ml-1 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-kumo-subtle hover:bg-kumo-tint"
          >
            {call.audioEnabled ? <Microphone size={14} weight="fill" /> : <MicrophoneSlash size={14} weight="fill" className="text-kumo-danger" />}
          </button>
          <button
            type="button"
            onClick={() => void store.leaveCall()}
            aria-label="Leave the call"
            title="Leave the call"
            className="press inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-kumo-danger text-white hover:brightness-110"
          >
            <PhoneDisconnect size={14} weight="fill" />
          </button>
        </div>
      )}
    </>
  );
}
