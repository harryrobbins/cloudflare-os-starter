// The parts of a call that must survive whatever is on screen, mounted once in the app shell:
//
// - one hidden `<audio>` per remote participant, so the call stays audible while the grid is swapped
//   for the conversation, another conversation is open, or the shell has hidden the frame;
// - the in-call shortcuts (Ctrl/Cmd+D microphone, Ctrl/Cmd+E camera), which win over the browser's
//   bookmark and search-bar bindings only while a call is live, and push-to-talk: Space held while
//   muted, unless focus is on something Space operates (a field, a button; see `shortcuts.ts`);
// - a small "In a call" pill when the call's conversation is not the one on screen, to get back.
//   When the shell has hidden the frame it shows its own pill instead, so this one stays away;
// - the picture-in-picture window's call panel, portalled into that window (`pip.ts`), so it lives
//   as long as the call does whatever the page shows.

import { Microphone, MicrophoneSlash, PhoneDisconnect, VideoCamera } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useCallPlace, useChat, useStore } from "../../hooks/store.js";
import { channelLabel } from "../../lib/labels.js";
import { isLivePhase } from "../../store/calls.js";
import { RemoteAudio } from "./CallTile.js";
import { CallPanel } from "./CallPanel.js";
import { closePictureInPicture, syncPipTheme, usePipWindow } from "./pip.js";
import { callKeyHandlers } from "./shortcuts.js";

export function CallDock(): ReactNode {
  const store = useStore();
  const navigate = useNavigate();
  const { channelId: callChannelId, phase } = useCallPlace();
  const remotes = useChat((state) => state.call.remotes);
  const audioEnabled = useChat((state) => state.call.audioEnabled);
  // The engine reports the output it switched to; the remembered choice covers an engine that does not.
  const sinkId = useChat((state) => state.call.audioOutputId ?? state.callDevices.audioOutputId);
  const activeChannelId = useChat((state) => state.activeChannelId);
  const shellHidden = useChat((state) => state.shellLayout === "hidden");
  const channel = useChat((state) => (callChannelId === null ? undefined : state.channels[callChannelId]));
  const users = useChat((state) => state.users);
  const meId = useChat((state) => state.me?.id);
  const live = isLivePhase(phase);
  const pip = usePipWindow();
  const theme = useChat((state) => state.theme);

  // The engine keeps the window's video playing when this tab is hidden; the call ending closes it.
  useEffect(() => {
    store.callEngine?.setPictureInPicture(pip !== null && live);
    if (pip !== null && !live) closePictureInPicture();
  }, [pip, live, store]);
  useEffect(() => syncPipTheme(), [theme, pip]);

  useEffect(() => {
    if (!live) return;
    const keys = callKeyHandlers(store);
    function onVisibility(): void {
      if (document.visibilityState === "hidden") keys.release();
    }
    // The floating window has its own keyboard focus; the same shortcuts work there.
    const targets = pip === null ? [window] : [window, pip];
    for (const target of targets) {
      target.addEventListener("keydown", keys.onKeyDown);
      target.addEventListener("keyup", keys.onKeyUp);
      // A release the frame never sees (focus moved to the shell, another window) must still mute.
      target.addEventListener("blur", keys.release);
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      for (const target of targets) {
        target.removeEventListener("keydown", keys.onKeyDown);
        target.removeEventListener("keyup", keys.onKeyUp);
        target.removeEventListener("blur", keys.release);
      }
      document.removeEventListener("visibilitychange", onVisibility);
      keys.release();
    };
  }, [live, store, pip]);

  if (!live) return null;
  const label = channel === undefined ? "the call" : channelLabel(channel, users, meId);
  const away = callChannelId !== activeChannelId && !shellHidden;

  return (
    <>
      {pip !== null &&
        callChannelId !== null &&
        createPortal(
          <div className="flex h-dvh flex-col bg-kumo-base text-kumo-default">
            <CallPanel channelId={callChannelId} label={label} layout="dock" pip className="flex-1" />
          </div>,
          pip.document.body,
        )}
      <div className="hidden" aria-hidden="true">
        {Object.values(remotes).map((remote) =>
          remote.audio === null ? null : <RemoteAudio key={remote.participantId} stream={remote.audio} sinkId={sinkId} />,
        )}
      </div>
      {away && callChannelId !== null && (
        <div
          role="region"
          aria-label="Call in progress"
          className="chat-rise fixed bottom-4 left-4 z-[1300] flex items-center gap-1 rounded-full border border-kumo-success/40 bg-kumo-control py-1 pr-1 pl-3 shadow-xl"
        >
          <button
            type="button"
            onClick={() => {
              store.setCallChatOpen(false);
              void navigate({ to: "/c/$channelId", params: { channelId: callChannelId! } });
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
            aria-label={audioEnabled ? "Mute microphone" : "Unmute microphone"}
            title={audioEnabled ? "Mute microphone" : "Unmute microphone"}
            className="press ml-1 inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-kumo-subtle hover:bg-kumo-tint"
          >
            {audioEnabled ? <Microphone size={14} weight="fill" /> : <MicrophoneSlash size={14} weight="fill" className="text-kumo-danger" />}
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
