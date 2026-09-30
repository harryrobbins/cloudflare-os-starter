// The call bar: mic, camera, screen share, devices, Chat, Focus, the page/sidebar move, Leave.
//
// In the sidebar (and on a phone) the bar keeps the three things you reach for without looking --
// mic, camera, leave -- plus Chat, and folds the rest into an overflow menu. "Pop out to sidebar" and
// "Expand to full page" only exist when a shell is listening: standalone there is nowhere to move to.
// The keyboard shortcuts live in `CallDock`, which is mounted whatever conversation is on screen.

import {
  ArrowsOut,
  ChatCircleText,
  CornersIn,
  CornersOut,
  DotsThree,
  GearSix,
  Microphone,
  MicrophoneSlash,
  PhoneDisconnect,
  Monitor,
  SidebarSimple,
  VideoCamera,
  VideoCameraSlash,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useChat, useStore } from "../../hooks/store.js";
import { DeviceSelects, useDeviceLists } from "./DeviceSelects.js";
import { canShareScreen } from "./layout.js";

export function CallControls({ layout }: { layout: "page" | "dock" }): ReactNode {
  const store = useStore();
  const call = useChat((state) => state.call);
  const pushToTalk = useChat((state) => state.callPushToTalk);
  const chatOpen = useChat((state) => state.callUi.chatOpen);
  const focus = useChat((state) => state.callFocus);
  const embedded = useChat((state) => state.embedded);
  const [menu, setMenu] = useState<"devices" | "more" | null>(null);
  const live = call.phase === "connected" || call.phase === "reconnecting";
  const dock = layout === "dock";
  const screenShare = canShareScreen();
  const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "") ? "⌘" : "Ctrl+";
  const canPresent = embedded && store.onPresent !== null;

  const mic = (
    <BarButton
      label={
        pushToTalk
          ? "Talking: release Space to mute"
          : call.audioEnabled
            ? `Mute microphone (${mod}D)`
            : `Unmute microphone (${mod}D), or hold Space to talk`
      }
      pressed={!call.audioEnabled}
      warn={!call.audioEnabled}
      disabled={!live}
      onClick={() => store.toggleCallAudio()}
    >
      {call.audioEnabled ? <Microphone size={18} weight="fill" /> : <MicrophoneSlash size={18} weight="fill" />}
    </BarButton>
  );
  const camera = (
    <BarButton
      label={call.videoEnabled ? `Turn camera off (${mod}E)` : `Turn camera on (${mod}E)`}
      pressed={!call.videoEnabled}
      warn={!call.videoEnabled}
      disabled={!live}
      onClick={() => void store.toggleCallVideo()}
    >
      {call.videoEnabled ? <VideoCamera size={18} weight="fill" /> : <VideoCameraSlash size={18} weight="fill" />}
    </BarButton>
  );
  const chat = (
    <BarButton
      label={chatOpen ? "Hide the conversation" : "Show the conversation"}
      pressed={chatOpen}
      onClick={() => store.setCallChatOpen(!chatOpen)}
    >
      <ChatCircleText size={18} weight={chatOpen ? "fill" : "regular"} />
      {!dock && <span className="text-[12px] font-medium">Chat</span>}
    </BarButton>
  );
  const leave = (
    <button
      type="button"
      onClick={() => void store.leaveCall()}
      aria-label="Leave the call"
      title="Leave the call"
      className="press inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-full bg-kumo-danger px-4 text-[13px] font-semibold text-white hover:brightness-110"
    >
      <PhoneDisconnect size={18} weight="fill" />
      {!dock && "Leave"}
    </button>
  );

  const screenItem = screenShare ? (
    <MenuItem
      icon={<Monitor size={15} />}
      label={call.screenEnabled ? "Stop sharing" : "Share screen"}
      disabled={!live}
      onClick={() => {
        setMenu(null);
        void store.toggleCallScreen();
      }}
    />
  ) : null;

  return (
    <div
      role="toolbar"
      aria-label="Call controls"
      className={[
        "relative flex shrink-0 items-center justify-center gap-2 border-t border-kumo-line bg-kumo-elevated",
        dock ? "px-2 py-2" : "px-4 py-2.5",
      ].join(" ")}
    >
      {mic}
      {camera}
      {!dock && screenShare && (
        <BarButton
          label={call.screenEnabled ? "Stop sharing your screen" : "Share your screen"}
          pressed={call.screenEnabled}
          disabled={!live}
          onClick={() => void store.toggleCallScreen()}
        >
          <Monitor size={18} weight={call.screenEnabled ? "fill" : "regular"} />
        </BarButton>
      )}
      {!dock && (
        <BarButton label="Camera, microphone and speakers" pressed={menu === "devices"} onClick={() => setMenu(menu === "devices" ? null : "devices")}>
          <GearSix size={18} />
        </BarButton>
      )}
      {chat}
      {!dock && (
        <BarButton
          label={focus ? "Show the conversation list" : "Focus: hide the conversation list"}
          pressed={focus}
          onClick={() => store.setCallFocus(!focus)}
        >
          {focus ? <CornersIn size={18} /> : <CornersOut size={18} />}
        </BarButton>
      )}
      {!dock && canPresent && (
        <BarButton label="Pop out to sidebar" onClick={() => store.presentCall("dock")}>
          <SidebarSimple size={18} />
        </BarButton>
      )}
      {dock && (
        <BarButton label="More call options" pressed={menu === "more"} onClick={() => setMenu(menu === "more" ? null : "more")}>
          <DotsThree size={18} weight="bold" />
        </BarButton>
      )}
      {leave}

      {menu !== null && (
        <Popover onClose={() => setMenu(null)} align={dock ? "right" : "center"}>
          {menu === "more" && (
            <div className="flex flex-col py-1">
              {screenItem}
              {canPresent && (
                <MenuItem
                  icon={<ArrowsOut size={15} />}
                  label="Expand to full page"
                  onClick={() => {
                    setMenu(null);
                    store.presentCall("page");
                  }}
                />
              )}
              <div className="my-1 h-px bg-kumo-line" />
              <p className="px-3 pt-1 pb-2 text-[11px] font-semibold tracking-wide text-kumo-inactive uppercase">Devices</p>
              <div className="px-3 pb-2">
                <InCallDevices compact />
              </div>
            </div>
          )}
          {menu === "devices" && (
            <div className="w-[min(36rem,80vw)] p-3">
              <InCallDevices />
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}

function InCallDevices({ compact = false }: { compact?: boolean }): ReactNode {
  const store = useStore();
  const choice = useChat((state) => state.callDevices);
  const lists = useDeviceLists(store.callEngine, null);
  return <DeviceSelects lists={lists} choice={choice} onChange={(patch) => void store.setCallDevices(patch)} compact={compact} />;
}

function BarButton({
  label,
  pressed,
  warn = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  warn?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={[
        "press inline-flex h-10 min-w-10 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        warn
          ? "bg-kumo-danger-tint text-kumo-danger hover:brightness-95"
          : pressed === true
            ? "bg-kumo-fill text-kumo-brand"
            : "bg-kumo-control text-kumo-default ring-1 ring-kumo-line hover:bg-kumo-tint",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[13px] text-kumo-default transition-colors hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="text-kumo-subtle">{icon}</span>
      {label}
    </button>
  );
}

/** Opens above the bar; Escape or a click outside closes it and focus returns to the bar. */
function Popover({
  onClose,
  align,
  children,
}: {
  onClose: () => void;
  align: "center" | "right";
  children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button, select")?.focus();
  }, []);
  return (
    <>
      <div className="fixed inset-0 z-20" aria-hidden="true" onClick={onClose} />
      <div
        ref={ref}
        role="menu"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
        className={[
          "absolute bottom-full z-30 mb-2 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-kumo-line bg-kumo-control shadow-xl",
          align === "right" ? "right-2 w-64" : "left-1/2 -translate-x-1/2",
        ].join(" ")}
      >
        {children}
      </div>
    </>
  );
}

