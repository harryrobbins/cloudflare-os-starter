// The pre-join pane: a camera preview, a microphone level meter, mic/camera toggles, device pickers,
// and Join / Cancel.
//
// The preview is the pane's own `getUserMedia`, stopped before Join hands over to the engine (which
// opens the devices itself): the engine contract has no preview, and one camera held by two owners is
// how a laptop's light stays on after a call. The choices are remembered per browser through the
// store. Nothing here is a `<form>` -- Join is an ordinary button, and Enter on it is a click.

import { Headphones, Microphone, MicrophoneSlash, VideoCamera, VideoCameraSlash } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useChat, useStore } from "../../hooks/store.js";
import { Avatar, Button, Spinner } from "../../components/primitives.js";
import { shouldHintHeadphones } from "../../store/calls.js";
import { audioConstraints, videoConstraints } from "../engine/media.js";
import { DeviceSelects, useDeviceLists } from "./DeviceSelects.js";
import { VideoView } from "./CallTile.js";
import { isFramed, mediaHelp, participantNames } from "./layout.js";
import { MicCheck, SpeakerTest } from "./PrejoinChecks.js";

export function CallPrejoin({ channelId, label }: { channelId: string; label: string }): ReactNode {
  const store = useStore();
  const start = useChat((state) => state.callStart);
  const devices = useChat((state) => state.callDevices);
  const me = useChat((state) => state.me);
  const room = useChat((state) => state.calls[channelId]);
  const users = useChat((state) => state.users);
  const compact = useChat((state) => state.compact);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const level = useMicLevel(start.audio ? preview : null);
  const lists = useDeviceLists(store.callEngine, preview);
  const sectionRef = useRef<HTMLElement>(null);

  // Focus lands on Join, so Enter (or Space) is the whole keyboard path from the header button.
  useEffect(() => sectionRef.current?.querySelector<HTMLButtonElement>("[data-call-join]")?.focus(), []);

  // One preview stream for whatever is switched on, reopened when a toggle or a device changes.
  useEffect(() => {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!start.audio && !start.video) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (media?.getUserMedia === undefined) {
      setPreviewError("This browser cannot use a camera or microphone here. Calls need a secure (https) page.");
      return;
    }
    let live = true;
    let opened: MediaStream | null = null;
    media
      .getUserMedia({
        // The engine's own constraints, so the preview sounds and looks like the call will.
        video: start.video ? videoConstraints(devices.videoInputId) : false,
        audio: start.audio ? audioConstraints(devices.audioInputId) : false,
      })
      .then((stream) => {
        if (!live) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        opened = stream;
        setPreview(stream);
        setPreviewError(null);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setPreview(null);
        const name = cause instanceof DOMException ? cause.name : "";
        setPreviewError(
          name === "NotAllowedError" || name === "SecurityError"
            ? `Camera and microphone are blocked. ${mediaHelp({ framed: isFramed() })}`
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "No camera or microphone was found. You can still join and listen."
              : name === "NotReadableError"
                ? "Your camera or microphone is in use by another app."
                : "Could not start the preview.",
        );
      });
    return () => {
      live = false;
      for (const track of opened?.getTracks() ?? []) track.stop();
    };
  }, [start.audio, start.video, devices.videoInputId, devices.audioInputId]);

  function join(): void {
    if (joining) return;
    setJoining(true);
    for (const track of preview?.getTracks() ?? []) track.stop();
    setPreview(null);
    void store.joinCall(channelId);
  }

  const inCall = room?.participants ?? [];
  const hasVideo = start.video && preview !== null && preview.getVideoTracks().length > 0;

  return (
    <section
      ref={sectionRef}
      aria-label={`Join the call in ${label}`}
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-4 py-6"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          store.closeCallPane();
        }
      }}
    >
      <div className="w-full max-w-xl">
        <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-kumo-recessed ring-1 ring-kumo-line">
          {hasVideo ? (
            <VideoView stream={preview!} mirrored label="Your camera preview" />
          ) : (
            <div className="flex h-full items-center justify-center">
              {me !== null && <Avatar name={me.name} id={me.id} size={compact ? 56 : 88} />}
            </div>
          )}
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-gradient-to-t from-black/50 to-transparent p-3">
            <ToggleButton
              on={start.audio}
              onLabel="Turn microphone off"
              offLabel="Turn microphone on"
              onToggle={() => store.setCallStart({ audio: !start.audio })}
              iconOn={<Microphone size={16} weight="fill" />}
              iconOff={<MicrophoneSlash size={16} weight="fill" />}
            />
            <ToggleButton
              on={start.video}
              onLabel="Turn camera off"
              offLabel="Turn camera on"
              onToggle={() => store.setCallStart({ video: !start.video })}
              iconOn={<VideoCamera size={16} weight="fill" />}
              iconOff={<VideoCameraSlash size={16} weight="fill" />}
            />
          </div>
        </div>

        {start.audio && preview !== null && preview.getAudioTracks().length > 0 && (
          // Where the level cannot be measured (no Web Audio) the meter stays and the warning does not.
          <MicCheck level={level ?? 0} active={level !== null} />
        )}

        {previewError !== null && (
          <p role="alert" className="mt-2 rounded-lg bg-kumo-warning-tint px-3 py-2 text-[12px] leading-5 text-kumo-warning">
            {previewError}
          </p>
        )}

        <div className="mt-3">
          <DeviceSelects
            lists={lists}
            choice={devices}
            onChange={(patch) => void store.setCallDevices(patch)}
            compact={compact}
          />
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <SpeakerTest outputId={devices.audioOutputId} />
          {shouldHintHeadphones({ others: inCall.filter((p) => p.userId !== me?.id).length, outputId: devices.audioOutputId, outputs: lists.audioOutputs }) && (
            <span className="inline-flex items-center gap-1 text-[11px] text-kumo-subtle">
              <Headphones size={12} aria-hidden="true" /> Using headphones prevents echo
            </span>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="min-w-0 text-[12px] text-kumo-subtle">
            {inCall.length === 0
              ? `Nobody is in the call yet. Joining starts it${label.startsWith("#") ? "" : " and rings the others"}.`
              : `${participantNames(
                  inCall.map((participant) => participant.userId),
                  (id) => users[id]?.name,
                  3,
                )} ${inCall.length === 1 ? "is" : "are"} in the call.`}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" onClick={() => store.closeCallPane()}>
              Cancel
            </Button>
            <Button data-call-join variant="primary" onClick={join} disabled={joining}>
              {joining ? <Spinner size={12} /> : <VideoCamera size={14} weight="fill" />}
              {inCall.length === 0 ? "Start call" : "Join"}
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ToggleButton({
  on,
  onLabel,
  offLabel,
  onToggle,
  iconOn,
  iconOff,
}: {
  on: boolean;
  onLabel: string;
  offLabel: string;
  onToggle: () => void;
  iconOn: ReactNode;
  iconOff: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={on ? onLabel : offLabel}
      aria-pressed={on}
      title={on ? onLabel : offLabel}
      className={[
        "press inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full transition-colors",
        on ? "bg-white/90 text-kumo-strong hover:bg-white" : "bg-kumo-danger text-white hover:brightness-110",
      ].join(" ")}
    >
      {on ? iconOn : iconOff}
    </button>
  );
}

/**
 * A 0..1 level from the preview's microphone, sampled about ten times a second; null where it cannot
 * be measured (no stream, no Web Audio), so silence is never inferred from a meter that is not there.
 */
function useMicLevel(stream: MediaStream | null): number | null {
  const [level, setLevel] = useState<number | null>(null);
  useEffect(() => {
    const Context = typeof window === "undefined" ? undefined : window.AudioContext;
    if (stream === null || Context === undefined || stream.getAudioTracks().length === 0) {
      setLevel(null);
      return;
    }
    let context: AudioContext;
    try {
      context = new Context();
    } catch {
      setLevel(null);
      return;
    }
    setLevel(0);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    // A context the autoplay policy left suspended reads as silence; it is not evidence of any.
    if (context.state === "suspended") void context.resume().catch(() => undefined);
    const timer = setInterval(() => {
      if (context.state !== "running") {
        setLevel(null);
        return;
      }
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      // RMS, stretched so ordinary speech reaches the middle of the bar.
      setLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
    }, 100);
    return () => {
      clearInterval(timer);
      void context.close().catch(() => undefined);
    };
  }, [stream]);
  return level;
}
