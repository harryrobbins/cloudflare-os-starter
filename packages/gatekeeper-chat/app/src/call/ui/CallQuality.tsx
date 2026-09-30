// Call quality in the UI (chat-video.md, "Quality phase 1"): the signal-bars glyph on each tile, the
// one quality banner a call shows at a time, and the one-time headphones tip.
//
// The engine decides what the network is doing (`RemoteMedia.quality`, `localQuality`, `limitation`,
// `audioOnly`); the rules for what to say about it are pure functions in `store/calls.ts`. This file
// only draws them. Banners are non-blocking strips, dismissible per call and announced once through
// the app's live region -- the strip itself carries no live role, so it is not re-announced every
// time the panel remounts (the Chat toggle, the page/sidebar move).

import { Headphones, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { useChat, useStore } from "../../hooks/store.js";
import {
  callBanner,
  connectionQualityLabel,
  dismissHeadphonesHint,
  headphonesHintDismissed,
  shouldHintHeadphones,
  type CallBanner,
  type CallBannerKind,
} from "../../store/calls.js";
import type { ConnectionQuality } from "../engine/types.js";
import { useDeviceLists } from "./DeviceSelects.js";

const FILLED: Readonly<Record<Exclude<ConnectionQuality, "unknown">, number>> = { good: 3, fair: 2, poor: 1 };
const TONE: Readonly<Record<Exclude<ConnectionQuality, "unknown">, string>> = {
  good: "text-emerald-300",
  fair: "text-amber-300",
  poor: "text-red-300",
};

/** Three rising bars, filled by quality; nothing at all while the quality is unknown. */
export function QualityBars({ quality, size = 12 }: { quality: ConnectionQuality | undefined; size?: number }): ReactNode {
  const label = connectionQualityLabel(quality);
  if (label === null || quality === undefined || quality === "unknown") return null;
  const filled = FILLED[quality];
  return (
    <span role="img" aria-label={label} title={label} data-quality={quality} className={`inline-flex shrink-0 ${TONE[quality]}`}>
      <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true">
        {[0, 1, 2].map((bar) => (
          <rect
            key={bar}
            x={1 + bar * 4}
            y={8 - bar * 3}
            width={2.6}
            height={3 + bar * 3}
            rx={0.8}
            fill="currentColor"
            opacity={bar < filled ? 1 : 0.3}
          />
        ))}
      </svg>
    </span>
  );
}

/** A slim strip above the call: the message and a dismiss button. */
export function CallBannerView({
  tone,
  icon,
  children,
  dismissLabel,
  onDismiss,
  testId,
}: {
  tone: "warning" | "info";
  icon?: ReactNode;
  children: ReactNode;
  dismissLabel: string;
  onDismiss: () => void;
  testId: string;
}): ReactNode {
  return (
    <div
      data-testid={testId}
      className={[
        "flex shrink-0 items-center gap-2 px-3 py-1.5 text-[12px] leading-5",
        tone === "warning" ? "bg-kumo-warning-tint text-kumo-warning" : "bg-kumo-info-tint text-kumo-info",
      ].join(" ")}
    >
      {icon}
      <p className="min-w-0 flex-1">{children}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={dismissLabel}
        title={dismissLabel}
        className="press inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-black/10"
      >
        <X size={12} weight="bold" />
      </button>
    </div>
  );
}

// Per call, for the life of the page: the panel unmounts on the Chat toggle and the page/sidebar move,
// and a dismissed banner must not come back, nor an announced one be announced again, because of it.
const dismissedByCall = new Map<string, Set<CallBannerKind>>();
const announcedByCall = new Map<string, Set<CallBannerKind>>();

/** Forgets every dismissal and announcement (tests). */
export function resetCallQualityNotices(): void {
  dismissedByCall.clear();
  announcedByCall.clear();
}

function forCall(map: Map<string, Set<CallBannerKind>>, callId: string): Set<CallBannerKind> {
  let set = map.get(callId);
  if (set === undefined) {
    // Only the current call matters; older calls' sets would only grow.
    map.clear();
    set = new Set();
    map.set(callId, set);
  }
  return set;
}

/** The banner and tip strip for the live call: at most one of the two at a time, banner first. */
export function CallQualityNotices(): ReactNode {
  const store = useStore();
  const local = useChat((state) => state.call);
  const room = useChat((state) => (state.call.channelId === null ? undefined : state.calls[state.call.channelId]));
  const outputId = useChat((state) => state.call.audioOutputId ?? state.callDevices.audioOutputId);
  const callId = local.callId ?? "";
  const [, setVersion] = useState(0);
  const [tipDismissed, setTipDismissed] = useState(headphonesHintDismissed);
  const lists = useDeviceLists(store.callEngine, callId);

  const dismissed = forCall(dismissedByCall, callId);
  const banner: CallBanner | null = callBanner(local, dismissed);

  useEffect(() => {
    if (banner === null) return;
    const announced = forCall(announcedByCall, callId);
    if (announced.has(banner.kind)) return;
    announced.add(banner.kind);
    store.announce(banner.message);
  }, [banner?.kind, banner?.message, callId, store]);

  const others = useMemo(
    () => (room?.participants ?? []).filter((participant) => participant.id !== local.participantId).length,
    [room, local.participantId],
  );
  const tip = !tipDismissed && local.phase === "connected" && shouldHintHeadphones({ others, outputId, outputs: lists.audioOutputs });

  if (banner !== null) {
    return (
      <CallBannerView
        testId="call-banner"
        tone="warning"
        dismissLabel="Dismiss"
        onDismiss={() => {
          dismissed.add(banner.kind);
          setVersion((value) => value + 1);
        }}
      >
        {banner.message}
      </CallBannerView>
    );
  }
  if (tip) {
    return (
      <CallBannerView
        testId="call-headphones-tip"
        tone="info"
        icon={<Headphones size={14} aria-hidden="true" className="shrink-0" />}
        dismissLabel="Dismiss tip"
        onDismiss={() => {
          dismissHeadphonesHint();
          setTipDismissed(true);
        }}
      >
        Using headphones prevents echo
      </CallBannerView>
    );
  }
  return null;
}
