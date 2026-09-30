// The call itself, as a view of two things: the room (`state.calls[channelId]`, who is in it and
// with which flags) and the engine's snapshot (which media this frame actually has). The panel owns
// neither -- the engine lives above the router, so switching between the full page and the sidebar,
// or navigating to another conversation, only unmounts this view and never the call.
//
// Two layouts:
//   page  the call is the content area: an even grid (1, 2 side by side, 2x2, 3+2), or a screen
//         share as the stage with the cameras as a filmstrip; the local view is a small mirrored
//         picture-in-picture.
//   dock  stacked for a narrow drawer: the active speaker (or a screen share) large, everyone else
//         as a strip underneath, the controls, and the conversation below the call.
//
// Tile sizes go to `engine.setTileSizes` so the SFU sends each camera at the layer it is drawn at;
// when the shell hides the frame, or this view unmounts, every tile is reported hidden.

import { ArrowClockwise, ArrowsClockwise, Prohibit, VideoCameraSlash, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";

import type { CallState, User } from "../../contract.js";
import { useChat, useStore } from "../../hooks/store.js";
import { Button, Spinner } from "../../components/primitives.js";
import type { CallPane, CallFailure } from "../../store/calls.js";
import type { CallSnapshot, TileSize } from "../engine/types.js";
import { CallControls } from "./CallControls.js";
import { CallQualityNotices } from "./CallQuality.js";
import { CallTile, ReconnectingOverlay, type TileModel } from "./CallTile.js";
import { gridRows, isFramed, mediaHelp } from "./layout.js";

/** The remote participants' tiles, in join order, merged from the room and the engine's media. */
export function remoteTiles(
  room: CallState | undefined,
  local: CallSnapshot,
  users: Readonly<Record<string, User>>,
): TileModel[] {
  if (room === undefined) return [];
  return room.participants
    .filter((participant) => participant.id !== local.participantId)
    .map((participant) => {
      const media = local.remotes[participant.id];
      return {
        key: participant.id,
        userId: participant.userId,
        name: users[participant.userId]?.name ?? "Someone",
        stream: media?.video ?? null,
        audioOn: participant.audio,
        videoOn: participant.video && media?.video != null,
        speaking: local.activeSpeaker === participant.id,
        quality: media?.quality,
        // Only a camera that is on can be paused; a camera that is off is just the avatar.
        paused: participant.video && (media?.videoPaused === true || local.audioOnly === true || local.audioOnlyChosen === true),
      };
    });
}

/** The first screen being shared, remote before local: what the stage shows. */
function screenTile(room: CallState | undefined, local: CallSnapshot, users: Readonly<Record<string, User>>, meName: string, meId: string): TileModel | null {
  for (const participant of room?.participants ?? []) {
    const screen = local.remotes[participant.id]?.screen;
    if (participant.id !== local.participantId && screen != null) {
      return {
        key: `${participant.id}:screen`,
        userId: participant.userId,
        name: users[participant.userId]?.name ?? "Someone",
        stream: screen,
        audioOn: true,
        videoOn: true,
        speaking: false,
        screen: true,
      };
    }
  }
  if (local.localScreen !== null) {
    return { key: "self:screen", userId: meId, name: meName, stream: local.localScreen, audioOn: true, videoOn: true, speaking: false, screen: true, self: true };
  }
  return null;
}

/** Collects every tile's size and hands the engine one debounced map. */
function useTileSizeReporting(hidden: boolean): (key: string, size: TileSize) => void {
  const store = useStore();
  const sizes = useRef(new Map<string, TileSize>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  const flush = useCallback(() => {
    timer.current = null;
    const out: Record<string, TileSize> = {};
    for (const [key, size] of sizes.current) {
      if (key.startsWith("self") || key.endsWith(":screen")) continue;
      out[key] = hiddenRef.current ? "hidden" : size;
    }
    store.callEngine?.setTileSizes(out);
  }, [store]);

  const report = useCallback(
    (key: string, size: TileSize) => {
      if (sizes.current.get(key) === size) return;
      sizes.current.set(key, size);
      if (timer.current === null) timer.current = setTimeout(flush, 120);
    },
    [flush],
  );

  useEffect(() => {
    flush();
  }, [hidden, flush]);

  // Unmounted (the Chat toggle, another conversation, the other layout): nothing is on screen.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      const out: Record<string, TileSize> = {};
      for (const key of sizes.current.keys()) {
        if (!key.startsWith("self") && !key.endsWith(":screen")) out[key] = "hidden";
      }
      store.callEngine?.setTileSizes(out);
    },
    [store],
  );
  return report;
}

export function CallPanel({
  channelId,
  label,
  layout,
  className = "",
}: {
  channelId: string;
  label: string;
  layout: "page" | "dock";
  className?: string;
}): ReactNode {
  const local = useChat((state) => state.call);
  const room = useChat((state) => state.calls[channelId]);
  const users = useChat((state) => state.users);
  const me = useChat((state) => state.me);
  const hidden = useChat((state) => state.shellLayout === "hidden" || !state.visible);
  const embedded = useChat((state) => state.embedded);
  const onSize = useTileSizeReporting(hidden);
  const dock = layout === "dock";

  const remotes = useMemo(() => remoteTiles(room, local, users), [room, local, users]);
  const stage = useMemo(
    () => screenTile(room, local, users, me?.name ?? "You", me?.id ?? "self"),
    [room, local, users, me],
  );
  const self: TileModel = {
    key: "self",
    userId: me?.id ?? "self",
    name: me?.name ?? "You",
    stream: local.localVideo,
    audioOn: local.audioEnabled,
    videoOn: local.videoEnabled && local.localVideo !== null,
    speaking: false,
    self: true,
    quality: local.localQuality,
  };

  let body: ReactNode;
  if (remotes.length === 0 && stage === null) {
    // Alone: your own camera, large, while the others arrive.
    body = (
      <div className="flex h-full flex-col gap-2">
        <CallTile tile={self} compact={dock} />
        <p className="shrink-0 text-center text-[12px] text-kumo-subtle" role="status">
          {local.phase === "joining" ? "Joining…" : "Waiting for others to join…"}
        </p>
      </div>
    );
  } else if (dock) {
    // Sidebar: one large tile (a screen, else the active speaker, else the first person), a strip.
    const main = stage ?? remotes.find((tile) => tile.speaking) ?? remotes[0]!;
    const strip = [...remotes.filter((tile) => tile.key !== main.key), self];
    body = (
      <div className="flex h-full flex-col gap-2">
        <div className="flex min-h-0 flex-1">
          <CallTile tile={main} stage onSize={onSize} />
        </div>
        <div className="flex h-20 shrink-0 gap-2 overflow-x-auto">
          {strip.map((tile) => (
            <div key={tile.key} className="flex w-28 shrink-0">
              <CallTile tile={tile} compact onSize={onSize} />
            </div>
          ))}
        </div>
      </div>
    );
  } else if (stage !== null) {
    body = (
      <div className="flex h-full flex-col gap-2">
        <div className="flex min-h-0 flex-1">
          <CallTile tile={stage} stage onSize={onSize} />
        </div>
        <div className="flex h-28 shrink-0 justify-center gap-2 overflow-x-auto">
          {[...remotes, self].map((tile) => (
            <div key={tile.key} className="flex w-48 shrink-0">
              <CallTile tile={tile} compact onSize={onSize} />
            </div>
          ))}
        </div>
      </div>
    );
  } else {
    const rows = gridRows(remotes.length, false);
    let next = 0;
    body = (
      <div className="relative flex h-full flex-col gap-2" data-testid="call-grid" data-rows={rows.join("+")}>
        {rows.map((count, row) => {
          const tiles = remotes.slice(next, next + count);
          next += count;
          return (
            <div key={row} className="flex min-h-0 flex-1 justify-center gap-2">
              {tiles.map((tile) => (
                <div key={tile.key} className="flex min-w-0" style={{ flexBasis: `${100 / Math.max(...rows)}%`, flexGrow: 0, flexShrink: 1 }}>
                  <CallTile tile={tile} onSize={onSize} />
                </div>
              ))}
            </div>
          );
        })}
        <div className="absolute right-3 bottom-3 z-[5] flex aspect-video w-[min(22%,200px)] min-w-28 shadow-lg">
          <CallTile tile={self} compact />
        </div>
      </div>
    );
  }

  return (
    <section
      aria-label={`Call in ${label}`}
      data-layout={layout}
      className={`relative flex min-h-0 min-w-0 flex-col bg-kumo-base ${className}`}
    >
      <CallQualityNotices />
      <div className={`relative min-h-0 flex-1 ${dock ? "p-2" : "p-3"}`}>
        {body}
        {local.phase === "reconnecting" && <ReconnectingOverlay />}
        {local.phase === "joining" && (
          <div role="status" className="absolute inset-0 z-10 flex items-center justify-center bg-kumo-base/60">
            <span className="inline-flex items-center gap-2 rounded-lg bg-kumo-control px-3 py-2 text-[13px] text-kumo-default shadow">
              <Spinner size={14} /> Joining the call…
            </span>
          </div>
        )}
      </div>
      {local.error !== null && local.phase === "connected" && (
        <p role="status" className="shrink-0 bg-kumo-warning-tint px-3 py-1 text-center text-[12px] text-kumo-warning">
          {local.error}
          {/* The engine joins without a refused device and says so here; how to allow it follows. */}
          {/blocked/iu.test(local.error) ? ` ${mediaHelp({ framed: embedded || isFramed() })}` : ""}
        </p>
      )}
      <CallControls layout={layout} />
    </section>
  );
}

/** What a conversation shows when a join failed, or this call moved to another window. */
export function CallNotice({
  pane,
  channelId,
  failure,
  engineError,
}: {
  pane: Extract<CallPane, "moved" | "failed">;
  channelId: string;
  failure: CallFailure | null;
  engineError: string | null;
}): ReactNode {
  const store = useStore();
  const embedded = useChat((state) => state.embedded);
  const retry = (): void => void store.joinCall(channelId);
  const close = (): void => store.closeCallPane();

  let icon: ReactNode = <WarningCircle size={22} />;
  let title: string;
  let body: string;
  let action: ReactNode = (
    <Button variant="primary" onClick={retry}>
      <ArrowClockwise size={14} /> Retry
    </Button>
  );
  if (pane === "moved") {
    icon = <ArrowsClockwise size={22} />;
    title = "You joined this call in another window";
    body = "Your camera and microphone are in use there. Move the call here to carry on in this window.";
    action = (
      <Button variant="primary" onClick={retry}>
        Move here
      </Button>
    );
  } else if (failure?.kind === "full") {
    icon = <Prohibit size={22} />;
    title = failure.message;
    body = "Calls hold five people at once. You can join when somebody leaves.";
  } else if (failure?.kind === "permission") {
    icon = <VideoCameraSlash size={22} />;
    title = "Camera and microphone are blocked";
    body = mediaHelp({ framed: embedded || isFramed() });
  } else if (failure?.kind === "unavailable") {
    title = "Calls are not available";
    body = failure.message;
    action = null;
  } else {
    title = "The call could not connect";
    body = failure?.message ?? engineError ?? "Something went wrong while connecting.";
  }

  return (
    <div role="alert" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 py-12 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-kumo-tint text-kumo-subtle">{icon}</span>
      <div className="space-y-1">
        <p className="text-[14px] font-semibold text-kumo-strong">{title}</p>
        <p className="max-w-sm text-[13px] leading-5 text-kumo-subtle">{body}</p>
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={close}>
          Close
        </Button>
        {action}
      </div>
    </div>
  );
}
