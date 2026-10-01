// The pre-join checks (chat-video.md, "Quality phase 1"): the microphone level meter with a "we can't
// hear you" warning after five silent seconds, and a speaker test tone on the chosen output.
//
// Both are presentational over plain inputs -- a 0..1 level, an output device id -- so they are
// tested without a microphone; `CallPrejoin` feeds them from its preview stream.

import { Microphone, SpeakerHigh, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "../../components/primitives.js";

/** Below this the meter reads as silence: room noise on a working microphone sits well above it. */
export const SILENT_LEVEL = 0.02;
/** How long the level must stay silent before the warning. */
export const SILENT_AFTER_MS = 5000;

/**
 * True once `level` has stayed at or below {@link SILENT_LEVEL} for {@link SILENT_AFTER_MS} while
 * `active`; any sound clears it and restarts the wait.
 */
export function useSilence(level: number, active: boolean, afterMs: number = SILENT_AFTER_MS): boolean {
  const [silent, setSilent] = useState(false);
  const quiet = level <= SILENT_LEVEL;
  useEffect(() => {
    if (!active || !quiet) {
      setSilent(false);
      return;
    }
    const timer = setTimeout(() => setSilent(true), afterMs);
    return () => clearTimeout(timer);
  }, [active, quiet, afterMs]);
  return silent;
}

/** The level meter, and the warning when the microphone is on but nothing arrives from it. */
export function MicCheck({ level, active }: { level: number; active: boolean }): ReactNode {
  const silent = useSilence(level, active);
  const percent = Math.round(level * 100);
  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center gap-2 text-[11px] text-kumo-subtle">
        <Microphone size={12} aria-hidden="true" />
        <div
          role="meter"
          aria-label="Microphone level"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-kumo-fill"
        >
          <div className="h-full rounded-full bg-kumo-success transition-[width] duration-100" style={{ width: `${percent}%` }} />
        </div>
      </div>
      {/* Always mounted so the polite live region exists before the text arrives. */}
      <p role="status" className="text-[11px] leading-4 text-kumo-warning">
        {silent && (
          <span data-testid="mic-silent" className="inline-flex items-center gap-1">
            <WarningCircle size={12} aria-hidden="true" />
            We can't hear you — check your microphone
          </span>
        )}
      </p>
    </div>
  );
}

/** Length of the test tone. */
export const TONE_MS = 800;

/**
 * Plays a short two-note chime through `outputId` where the browser can route audio (`setSinkId`
 * on an `<audio>` fed by a `MediaStreamAudioDestinationNode`), else through the default output.
 * Resolves when it has finished; rejects when the browser has no Web Audio.
 */
export async function playTestTone(outputId: string | null): Promise<void> {
  const Context = typeof window === "undefined" ? undefined : window.AudioContext;
  if (Context === undefined) throw new Error("This browser cannot play a test tone.");
  const context = new Context();
  let element: (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null = null;
  try {
    const gain = context.createGain();
    const start = context.currentTime + 0.02;
    const end = start + TONE_MS / 1000;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.03);
    gain.gain.setValueAtTime(0.25, end - 0.12);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    let routed = false;
    if (outputId !== null && typeof context.createMediaStreamDestination === "function" && typeof Audio !== "undefined") {
      const destination = context.createMediaStreamDestination();
      const audio = new Audio() as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (typeof audio.setSinkId === "function") {
        try {
          await audio.setSinkId(outputId);
          audio.srcObject = destination.stream;
          gain.connect(destination);
          await audio.play();
          element = audio;
          routed = true;
        } catch {
          gain.disconnect();
          routed = false;
        }
      }
    }
    if (!routed) gain.connect(context.destination);

    // A rising pair (E5 then A5): recognisably a test, not a notification.
    const notes: readonly [number, number][] = [
      [659.25, start],
      [880, start + (TONE_MS / 1000) * 0.45],
    ];
    for (const [frequency, at] of notes) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, at);
      oscillator.connect(gain);
      oscillator.start(at);
      oscillator.stop(end);
    }
    await new Promise((resolve) => setTimeout(resolve, TONE_MS + 80));
  } finally {
    if (element !== null) {
      element.pause();
      element.srcObject = null;
    }
    await context.close().catch(() => undefined);
  }
}

/** "Test speakers": plays the tone once per click, and says so while it plays. */
export function SpeakerTest({
  outputId,
  play = playTestTone,
}: {
  outputId: string | null;
  play?: (outputId: string | null) => Promise<void>;
}): ReactNode {
  const [state, setState] = useState<"idle" | "playing" | "failed">("idle");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={state === "playing"}
        onClick={() => {
          setState("playing");
          play(outputId).then(
            () => mounted.current && setState("idle"),
            () => mounted.current && setState("failed"),
          );
        }}
      >
        <SpeakerHigh size={13} aria-hidden="true" />
        {state === "playing" ? "Playing…" : "Test speakers"}
      </Button>
      <span role="status" className="text-[11px] text-kumo-subtle">
        {state === "failed" ? "Could not play a sound in this browser." : ""}
      </span>
    </div>
  );
}
