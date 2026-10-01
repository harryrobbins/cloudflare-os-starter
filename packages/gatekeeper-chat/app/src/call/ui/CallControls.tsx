// The call bar: mic, camera, screen share, raise hand, reactions, people, devices, Chat, Focus, the
// page/sidebar move, Leave.
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
  HandPalm,
  Microphone,
  Smiley,
  UserFocus,
  Users,
  Waveform,
  MicrophoneSlash,
  PhoneDisconnect,
  Monitor,
  PictureInPicture,
  SidebarSimple,
  SpeakerHigh,
  VideoCamera,
  VideoCameraSlash,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { CALL_REACTIONS } from "../../contract.js";
import type { EffectState } from "../engine/types.js";
import { Menu, MenuItem } from "../../components/primitives.js";
import { useChat, useStore } from "../../hooks/store.js";

import { DeviceSelects, useDeviceLists } from "./DeviceSelects.js";
import { canShareScreen, handQueue } from "./layout.js";
import { canPictureInPicture, closePictureInPicture, openPictureInPicture } from "./pip.js";

export function CallControls({ layout, pip = false }: { layout: "page" | "dock"; pip?: boolean }): ReactNode {
  const store = useStore();
  const phase = useChat((state) => state.call.phase);
  const audioEnabled = useChat((state) => state.call.audioEnabled);
  const videoEnabled = useChat((state) => state.call.videoEnabled);
  const screenEnabled = useChat((state) => state.call.screenEnabled);
  const pushToTalk = useChat((state) => state.callPushToTalk);
  const chatOpen = useChat((state) => state.callUi.chatOpen);
  const focus = useChat((state) => state.callFocus);
  const embedded = useChat((state) => state.embedded);
  const [menu, setMenu] = useState<"devices" | "more" | "react" | "people" | null>(null);
  const handUp = useChat((state) => {
    const local = state.call;
    if (local.channelId === null || local.participantId === null) return false;
    return state.calls[local.channelId]?.participants.some((entry) => entry.id === local.participantId && entry.hand !== undefined) ?? false;
  });
  const peopleCount = useChat((state) =>
    state.call.channelId === null ? 0 : (state.calls[state.call.channelId]?.participants.length ?? 0),
  );
  const live = phase === "connected" || phase === "reconnecting";
  const dock = layout === "dock";
  const screenShare = canShareScreen();
  const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "") ? "⌘" : "Ctrl+";
  // Inside the floating window the page/sidebar moves mean nothing; its way out is "Back to the tab".
  const canPresent = !pip && embedded && store.onPresent !== null;
  const canFloat = !pip && canPictureInPicture();
  const float = (): void => {
    setMenu(null);
    void openPictureInPicture().then((opened) => {
      if (opened) store.announce("The call is in a floating window");
    });
  };

  const mic = (
    <BarButton
      label={
        pushToTalk
          ? "Talking: release Space to mute"
          : audioEnabled
            ? `Mute microphone (${mod}D)`
            : `Unmute microphone (${mod}D), or hold Space to talk`
      }
      pressed={!audioEnabled}
      warn={!audioEnabled}
      disabled={!live}
      onClick={() => store.toggleCallAudio()}
    >
      {audioEnabled ? <Microphone size={18} weight="fill" /> : <MicrophoneSlash size={18} weight="fill" />}
    </BarButton>
  );
  const camera = (
    <BarButton
      label={videoEnabled ? `Turn camera off (${mod}E)` : `Turn camera on (${mod}E)`}
      pressed={!videoEnabled}
      warn={!videoEnabled}
      disabled={!live}
      onClick={() => void store.toggleCallVideo()}
    >
      {videoEnabled ? <VideoCamera size={18} weight="fill" /> : <VideoCameraSlash size={18} weight="fill" />}
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

  // Raise hand and screen share sit on the full bar and in the sidebar's overflow menu: described
  // once, drawn as whichever the layout needs.
  const handAction: CallAction = {
    label: handUp ? "Lower your hand" : "Raise your hand",
    icon: (size) => <HandPalm size={size} weight={handUp ? "fill" : "regular"} />,
    pressed: handUp,
    disabled: !live,
    run: () => store.toggleCallHand(),
  };
  const screenAction: CallAction | null = screenShare
    ? {
        label: screenEnabled ? "Stop sharing your screen" : "Share your screen",
        icon: (size) => <Monitor size={size} weight={screenEnabled ? "fill" : "regular"} />,
        pressed: screenEnabled,
        disabled: !live,
        run: () => void store.toggleCallScreen(),
      }
    : null;
  const asMenuItem = (action: CallAction): ReactNode => (
    <MenuItem
      icon={action.icon(15)}
      label={action.label}
      disabled={action.disabled}
      onClick={() => {
        setMenu(null);
        action.run();
      }}
    />
  );

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
      {!dock && screenAction !== null && <ActionButton action={screenAction} />}
      {!dock && <ActionButton action={handAction} />}
      {!dock && (
        <BarButton label="Send a reaction" pressed={menu === "react"} disabled={!live} onClick={() => setMenu(menu === "react" ? null : "react")}>
          <Smiley size={18} />
        </BarButton>
      )}
      {!dock && (
        <BarButton label={`People in the call (${peopleCount})`} pressed={menu === "people"} onClick={() => setMenu(menu === "people" ? null : "people")}>
          <Users size={18} />
          <span className="text-[12px] font-medium tabular-nums">{peopleCount}</span>
        </BarButton>
      )}
      {!dock && (
        <BarButton label="Camera, microphone and speakers" pressed={menu === "devices"} onClick={() => setMenu(menu === "devices" ? null : "devices")}>
          <GearSix size={18} />
        </BarButton>
      )}
      {!pip && chat}
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
      {!dock && canFloat && (
        <BarButton label="Float the call over other tabs" onClick={float}>
          <PictureInPicture size={18} />
        </BarButton>
      )}
      {pip && (
        <BarButton label="Back to the tab" onClick={closePictureInPicture}>
          <PictureInPicture size={18} weight="fill" />
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
              <ReactionRow disabled={!live} onDone={() => setMenu(null)} />
              {asMenuItem(handAction)}
              {screenAction !== null && asMenuItem(screenAction)}
              <AudioOnlyItem disabled={!live} onDone={() => setMenu(null)} />
              <EffectItems disabled={!live} />
              {canFloat && (
                <MenuItem icon={<PictureInPicture size={15} />} label="Float the call over other tabs" onClick={float} />
              )}
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
              <p className="px-3 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-kumo-inactive uppercase">
                People ({peopleCount})
              </p>
              <ParticipantList />
              <div className="my-1 h-px bg-kumo-line" />
              <p className="px-3 pt-1 pb-2 text-[11px] font-semibold tracking-wide text-kumo-inactive uppercase">Devices</p>
              <div className="px-3 pb-2">
                <InCallDevices compact />
              </div>
            </div>
          )}
          {menu === "react" && <ReactionRow disabled={!live} onDone={() => setMenu(null)} />}
          {menu === "people" && (
            <div className="w-64 py-1">
              <ParticipantList />
            </div>
          )}
          {menu === "devices" && (
            <div className="w-[min(36rem,80vw)] p-3">
              <InCallDevices />
              <div className="-mx-3 mt-3 -mb-3 border-t border-kumo-line py-1">
                <AudioOnlyItem disabled={!live} onDone={() => setMenu(null)} />
                <EffectItems disabled={!live} />
              </div>
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

/** The quick reactions, one button each; picking one sends it and closes the menu. */
function ReactionRow({ disabled, onDone }: { disabled: boolean; onDone: () => void }): ReactNode {
  const store = useStore();
  return (
    <div role="group" aria-label="Reactions" className="flex items-center justify-center gap-0.5 px-2 py-1.5">
      {CALL_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          role="menuitem"
          disabled={disabled}
          aria-label={`React ${emoji}`}
          title={`React ${emoji}`}
          onClick={() => {
            onDone();
            store.sendCallReaction(emoji);
          }}
          className="press inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-[20px] transition-colors hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-50"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

/** Who is in the call: raised hands first, in the order they went up, then everyone in join order. */
export function ParticipantList(): ReactNode {
  const participantId = useChat((state) => state.call.participantId);
  const room = useChat((state) => (state.call.channelId === null ? undefined : state.calls[state.call.channelId]));
  const users = useChat((state) => state.users);
  const hands = handQueue(room);
  const people = (room?.participants ?? []).toSorted(
    (a, b) => (hands.get(a.id) ?? Number.POSITIVE_INFINITY) - (hands.get(b.id) ?? Number.POSITIVE_INFINITY),
  );
  if (people.length === 0) return <p className="px-3 py-1.5 text-[12px] text-kumo-subtle">Nobody yet.</p>;
  return (
    <ul aria-label="People in the call" className="flex flex-col">
      {people.map((participant) => {
        const order = hands.get(participant.id);
        const name = users[participant.userId]?.name ?? "Someone";
        const you = participant.id === participantId;
        return (
          <li key={participant.id} data-testid="call-person" className="flex items-center gap-2 px-3 py-1 text-[13px] text-kumo-default">
            <span className="min-w-0 flex-1 truncate">
              {name}
              {you && <span className="text-kumo-subtle"> (you)</span>}
            </span>
            {order !== undefined && (
              <span role="img" aria-label={`Hand raised, ${order} in line`} title="Hand raised" className="text-[13px]">
                ✋<span aria-hidden="true" className="ml-0.5 text-[11px] text-kumo-subtle tabular-nums">{order}</span>
              </span>
            )}
            {!participant.audio && <MicrophoneSlash size={13} weight="bold" aria-label="Microphone off" className="text-kumo-danger" />}
          </li>
        );
      })}
    </ul>
  );
}

/** A switch in the call menus: a checkbox menu item, so screen readers read its state. */
function SwitchItem({
  icon,
  label,
  hint,
  on,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  on: boolean;
  disabled: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[13px] text-kumo-default transition-colors hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className={on ? "text-kumo-brand" : "text-kumo-subtle"}>{icon}</span>
      <span className="flex-1">
        {label}
        <span className="block text-[11px] text-kumo-inactive">{hint}</span>
      </span>
      <span
        aria-hidden="true"
        className={[
          "inline-flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition-colors",
          on ? "justify-end bg-kumo-brand" : "justify-start bg-kumo-line",
        ].join(" ")}
      >
        <span className="h-3 w-3 rounded-full bg-white" />
      </span>
    </button>
  );
}

/** "Audio only": everyone's video paused and the camera off, until chosen again. */
function AudioOnlyItem({ disabled, onDone }: { disabled: boolean; onDone: () => void }): ReactNode {
  const store = useStore();
  const on = useChat((state) => state.call.audioOnlyChosen);
  return (
    <SwitchItem
      icon={<SpeakerHigh size={15} weight={on ? "fill" : "regular"} />}
      label="Audio only"
      hint="Pause everyone's video and your camera"
      on={on}
      disabled={disabled}
      onClick={() => {
        onDone();
        void store.toggleCallAudioOnly();
      }}
    />
  );
}

const EFFECT_HINTS: Readonly<Record<EffectState, string | null>> = {
  unsupported: null,
  off: null,
  starting: "Starting…",
  on: null,
  cpu: "Turned off because your device was busy",
  failed: "Could not start in this browser",
};

/**
 * Noise suppression and background blur (quality phase 2), each only where this browser can run
 * it. The menu stays open: the switch shows "Starting…" while the model loads.
 */
function EffectItems({ disabled }: { disabled: boolean }): ReactNode {
  const store = useStore();
  const noise = useChat((state) => state.call.noiseSuppression);
  const blur = useChat((state) => state.call.backgroundBlur);
  const video = useChat((state) => state.call.videoEnabled);
  return (
    <>
      {noise !== "unsupported" && (
        <SwitchItem
          icon={<Waveform size={15} weight={noise === "on" ? "fill" : "regular"} />}
          label="Noise suppression"
          hint={EFFECT_HINTS[noise] ?? "Filter out keyboards, fans and background chatter"}
          on={noise === "on" || noise === "starting"}
          disabled={disabled || noise === "starting"}
          onClick={() => void store.toggleCallEffect("noiseSuppression")}
        />
      )}
      {blur !== "unsupported" && (
        <SwitchItem
          icon={<UserFocus size={15} weight={blur === "on" ? "fill" : "regular"} />}
          label="Blur background"
          hint={EFFECT_HINTS[blur] ?? (video ? "Keep you sharp and your room out of focus" : "Applies when your camera is on")}
          on={blur === "on" || blur === "starting"}
          disabled={disabled || blur === "starting"}
          onClick={() => void store.toggleCallEffect("backgroundBlur")}
        />
      )}
    </>
  );
}

/** A call control that can be a bar button or a menu item. */
interface CallAction {
  readonly label: string;
  readonly icon: (size: number) => ReactNode;
  readonly pressed: boolean;
  readonly disabled: boolean;
  readonly run: () => void;
}

function ActionButton({ action }: { action: CallAction }): ReactNode {
  return (
    <BarButton label={action.label} pressed={action.pressed} disabled={action.disabled} onClick={action.run}>
      {action.icon(18)}
    </BarButton>
  );
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
  // Opens upwards from the bar, so it gets the room above the bar and scrolls beyond that: in the
  // sidebar the call sits high and a full menu would otherwise run off the top of the frame.
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const bar = ref.current?.parentElement;
    if (bar) setMaxHeight(Math.max(160, bar.getBoundingClientRect().top - 16));
  }, []);
  useEffect(() => {
    // A menu with nothing to focus (the People list) takes focus itself, so Escape still reaches it.
    (ref.current?.querySelector<HTMLElement>("button, select") ?? ref.current)?.focus();
  }, []);
  return (
    <Menu
      onClose={onClose}
      menuRef={ref}
      backdrop="z-20"
      style={maxHeight === undefined ? undefined : { maxHeight }}
      className={[
        "absolute bottom-full z-30 mb-2 max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto rounded-xl border border-kumo-line bg-kumo-control shadow-xl",
        align === "right" ? "right-2 w-64" : "left-1/2 -translate-x-1/2",
      ].join(" ")}
    >
      {children}
    </Menu>
  );
}

