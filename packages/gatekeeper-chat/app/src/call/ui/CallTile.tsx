// One participant's tile, and the two media elements the call UI is built from.
//
// Video elements are always muted: sound comes from one hidden `<audio>` per remote participant
// (`RemoteAudio`), which keeps playing when the grid is swapped for the message list and is the
// element `setSinkId` switches to the chosen speakers. `srcObject` is a property, not an attribute,
// so both are set from an effect.

import { MicrophoneSlash, VideoCameraSlash, WifiSlash } from "@phosphor-icons/react";
import { memo, useEffect, useRef, type ReactNode } from "react";

import { Avatar } from "../../components/primitives.js";
import { applyAudioOutput } from "../engine/devices.js";
import type { ConnectionQuality, TileSize } from "../engine/types.js";
import { QualityBars } from "./CallQuality.js";
import { tileSizeFor } from "./layout.js";

export function VideoView({
  stream,
  mirrored = false,
  fit = "cover",
  label,
}: {
  stream: MediaStream;
  mirrored?: boolean;
  fit?: "cover" | "contain";
  label: string;
}): ReactNode {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (video === null) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    // Autoplay is allowed for muted video; `play()` covers the browsers that still want the call.
    try {
      void video.play?.()?.catch(() => undefined);
    } catch {
      // jsdom and a few embedded browsers do not implement play().
    }
  }, [stream]);
  return (
    <video
      ref={ref}
      aria-label={label}
      playsInline
      autoPlay
      muted
      className={[
        "h-full w-full bg-black",
        fit === "cover" ? "object-cover" : "object-contain",
        mirrored ? "-scale-x-100" : "",
      ].join(" ")}
    />
  );
}

/** Plays one remote participant's microphone, on the chosen output when the browser allows it. */
export function RemoteAudio({ stream, sinkId }: { stream: MediaStream; sinkId: string | null }): ReactNode {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = ref.current;
    if (audio === null) return;
    if (audio.srcObject !== stream) audio.srcObject = stream;
    try {
      void audio.play?.()?.catch(() => undefined);
    } catch {
      // As above.
    }
  }, [stream]);
  useEffect(() => {
    // Resolves false where the browser cannot choose an output (Safari): the default is used.
    if (ref.current !== null) void applyAudioOutput(ref.current, sinkId);
  }, [sinkId]);
  return <audio ref={ref} autoPlay className="hidden" />;
}

export interface TileModel {
  /** Participant id for remotes; "self" for the local view. */
  readonly key: string;
  readonly userId: string;
  readonly name: string;
  readonly stream: MediaStream | null;
  readonly audioOn: boolean;
  readonly videoOn: boolean;
  readonly speaking: boolean;
  readonly self?: boolean;
  /** A screen share, drawn whole rather than cropped. */
  readonly screen?: boolean;
  /** Their connection (remotes) or ours (self); absent or `unknown` draws no indicator. */
  readonly quality?: ConnectionQuality;
  /**
   * The camera is on but its video is paused (tile hidden, audio-only mode): the avatar and a hint
   * instead of a frozen last frame.
   */
  readonly paused?: boolean;
  /** Their hand is up; `handOrder` is its place in the queue (1 = first raised). */
  readonly hand?: boolean;
  readonly handOrder?: number;
  /** Reactions floating over this tile right now, oldest first. */
  readonly reactions?: readonly { readonly id: number; readonly emoji: string }[];
}

export const CallTile = memo(function CallTile({
  tile,
  compact = false,
  stage = false,
  onSize,
}: {
  tile: TileModel;
  compact?: boolean;
  /** The large screen-share stage: always "large" for layer choice. */
  stage?: boolean;
  /** Reported on every resize, for `engine.setTileSizes`. */
  onSize?: (key: string, size: TileSize) => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null || onSize === undefined) return;
    const report = (): void => onSize(tile.key, tileSizeFor(element.clientWidth, { stage }));
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onSize, tile.key, stage]);

  const paused = tile.paused === true && tile.screen !== true;
  const showVideo = !paused && tile.stream !== null && (tile.videoOn || tile.screen === true);
  return (
    <div
      ref={ref}
      data-testid="call-tile"
      data-speaking={tile.speaking ? "true" : "false"}
      className={[
        "relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-xl bg-kumo-recessed",
        tile.speaking ? "ring-2 ring-kumo-success ring-offset-2 ring-offset-kumo-base" : "ring-1 ring-kumo-line",
        "transition-shadow",
      ].join(" ")}
    >
      {showVideo ? (
        <VideoView
          stream={tile.stream!}
          mirrored={tile.self === true && tile.screen !== true}
          fit={tile.screen === true ? "contain" : "cover"}
          label={tile.screen === true ? `${tile.name}'s screen` : `${tile.name}'s camera`}
        />
      ) : (
        <div className="flex flex-col items-center gap-1.5">
          <Avatar name={tile.name} id={tile.userId} size={compact ? 44 : 72} />
          {/* A strip tile is too short for the hint under the avatar; it goes in the name pill. */}
          {paused && !compact && (
            <span
              data-testid="video-paused"
              className="inline-flex items-center gap-1 rounded-md bg-black/45 px-1.5 py-0.5 text-[11px] text-white/90"
            >
              <VideoCameraSlash size={12} aria-hidden="true" />
              Video paused
            </span>
          )}
        </div>
      )}
      {tile.hand === true && (
        <span
          data-testid="hand-raised"
          role="img"
          aria-label={`Hand raised${tile.handOrder === undefined ? "" : `, ${ordinal(tile.handOrder)}`}`}
          title="Hand raised"
          className={[
            "absolute top-2 left-2 inline-flex items-center gap-0.5 rounded-md bg-amber-400 px-1.5 py-0.5 font-semibold text-black shadow",
            compact ? "text-[11px]" : "text-[13px]",
          ].join(" ")}
        >
          <span aria-hidden="true">✋</span>
          {tile.handOrder !== undefined && <span aria-hidden="true">{tile.handOrder}</span>}
        </span>
      )}
      {(tile.reactions?.length ?? 0) > 0 && (
        <span aria-hidden="true" className="pointer-events-none absolute right-2 bottom-8 flex flex-col-reverse items-end gap-1">
          {tile.reactions!.map((reaction) => (
            <span key={reaction.id} data-testid="tile-reaction" className={`chat-reaction-float ${compact ? "text-xl" : "text-3xl"}`}>
              {reaction.emoji}
            </span>
          ))}
        </span>
      )}
      <span
        className={[
          "absolute bottom-2 left-2 inline-flex max-w-[calc(100%-1rem)] items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-white",
          compact ? "text-[11px]" : "text-[12px]",
        ].join(" ")}
      >
        {paused && compact && (
          <VideoCameraSlash data-testid="video-paused" size={12} weight="bold" aria-label="Video paused" className="shrink-0 text-white/80" />
        )}
        {!tile.audioOn && <MicrophoneSlash size={12} weight="bold" aria-label="Microphone off" className="shrink-0 text-red-300" />}
        <span className="truncate">{tile.self === true ? `${tile.name} (you)` : tile.name}</span>
        {tile.screen !== true && <QualityBars quality={tile.quality} size={compact ? 10 : 12} />}
      </span>
    </div>
  );
});

/** Across the whole panel while the engine rebuilds the connection. */
export function ReconnectingOverlay(): ReactNode {
  return (
    <div
      role="status"
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/45 text-[13px] font-medium text-white backdrop-blur-[1px]"
    >
      <span className="inline-flex items-center gap-2 rounded-lg bg-black/60 px-3 py-2">
        <WifiSlash size={15} /> Reconnecting…
      </span>
    </div>
  );
}

/** "first", "second", ... for the hand queue; beyond five (the call's size) plain numbers. */
function ordinal(n: number): string {
  return ["first", "second", "third", "fourth", "fifth"][n - 1] ?? `number ${n}`;
}
