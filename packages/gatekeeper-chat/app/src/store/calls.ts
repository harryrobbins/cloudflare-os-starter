// Calls, as the store sees them.
//
// Two different things live under "call" and they must not be confused. The *room* -- who is in which
// conversation's call, with which flags -- is `CallState`, pushed by the server in `call` events and
// carried on `hello` and the channel list; the store keeps one per conversation. The *media* -- this
// frame's own connection, its local tracks and what it pulls -- belongs to the `CallEngine`, which the
// store only subscribes to and forwards room updates into. Everything here is pure, so the rules
// (which call to ring for, what the header button says, which pane a conversation shows) are tested
// without a DOM or a WebRTC stack.

import {
  CHAT_PREFIX,
  MAX_CALL_PARTICIPANTS,
  type CallFeature,
  type CallState,
  type ChannelId,
  type Membership,
  type UserId,
} from "../contract.js";
import { NO_DEVICES, type CallPhase, type CallSnapshot, type ConnectionQuality, type DeviceChoice } from "../call/engine/types.js";
import { readSetting, writeSetting } from "./drafts.js";

export { IDLE_CALL, NO_DEVICES } from "../call/engine/types.js";

/** Until `/api/me` says otherwise, calls are off: an older server never sends the field. */
export const CALLS_DISABLED: CallFeature = { enabled: false, maxParticipants: MAX_CALL_PARTICIPANTS };

/** An incoming call's toast: a call started in a dm or group by somebody else. */
export interface CallRing {
  readonly callId: string;
  readonly channelId: ChannelId;
  readonly startedBy: UserId;
  readonly at: number;
}

/** Why a join did not happen, sorted into the handful of cases the call pane explains differently. */
export interface CallFailure {
  readonly kind: "full" | "permission" | "unavailable" | "error";
  readonly message: string;
}

/** The call pane's own state, which the engine has no opinion about. */
export interface CallUi {
  /** The conversation whose call pane is showing: pre-join, the call itself, or why it failed. */
  readonly channelId: ChannelId | null;
  readonly prejoin: boolean;
  /** "Chat" toggle: the message list is on screen instead of the grid, while staying in the call. */
  readonly chatOpen: boolean;
  readonly failure: CallFailure | null;
}

export const NO_CALL_UI: CallUi = { channelId: null, prejoin: false, chatOpen: false, failure: null };

/** Phases in which this frame holds (or is getting) a live participant. */
export function isLivePhase(phase: CallPhase): boolean {
  return phase === "joining" || phase === "connected" || phase === "reconnecting";
}

export function callsByChannel(calls: readonly CallState[]): Record<ChannelId, CallState> {
  const out: Record<ChannelId, CallState> = {};
  for (const call of calls) out[call.channelId] = call;
  return out;
}

/** One `call` event folded into the per-conversation map: the whole state, or null when it ended. */
export function applyCallEvent(
  calls: Readonly<Record<ChannelId, CallState>>,
  channelId: ChannelId,
  call: CallState | null,
): Readonly<Record<ChannelId, CallState>> {
  if (call === null) {
    if (calls[channelId] === undefined) return calls;
    const next = { ...calls };
    delete next[channelId];
    return next;
  }
  return { ...calls, [channelId]: call };
}

/**
 * Whether a `call` event should ring this person.
 *
 * The server sets `ring` only on the event that starts a call in a dm or group, and never sends it to
 * the starter -- but a person has several tabs, and "never ring for your own start" has to hold in the
 * tab that did not start it too, so the starter is checked here as well. Muting a conversation or
 * setting it to "nothing" silences its calls the way it silences its messages; a call this frame is
 * already in never rings.
 */
export function shouldRing(params: {
  readonly ring: boolean | undefined;
  readonly call: CallState | null;
  readonly meId: UserId | undefined;
  readonly membership: Membership | undefined;
  readonly localCallId: string | null;
}): boolean {
  const { call, membership } = params;
  if (params.ring !== true || call === null || params.meId === undefined) return false;
  if (call.startedBy === params.meId) return false;
  if (call.participants.some((participant) => participant.userId === params.meId)) return false;
  if (params.localCallId === call.id) return false;
  if (membership === undefined || membership.muted || membership.notify === "none") return false;
  return true;
}

/** Rings whose call is no longer running (ended, or replaced by a newer call) are dropped. */
export function pruneRings(
  rings: readonly CallRing[],
  calls: Readonly<Record<ChannelId, CallState>>,
): readonly CallRing[] {
  const next = rings.filter((ring) => calls[ring.channelId]?.id === ring.callId);
  return next.length === rings.length ? rings : next;
}

export type CallButtonState =
  | { readonly kind: "hidden" }
  | { readonly kind: "start" }
  | { readonly kind: "join"; readonly count: number; readonly userIds: readonly UserId[] }
  | { readonly kind: "in-call" }
  | { readonly kind: "full"; readonly max: number };

/**
 * What the conversation header's call button says.
 *
 * "Full" counts other people only: the caller already in the call from another tab is let through
 * (the server replaces their older participant), so "Move here" is never blocked by the cap.
 */
export function callButtonState(params: {
  readonly feature: CallFeature;
  readonly call: CallState | undefined;
  readonly local: CallSnapshot;
  readonly channelId: ChannelId;
  readonly meId: UserId | undefined;
  readonly member: boolean;
  readonly archived: boolean;
}): CallButtonState {
  const { call, local } = params;
  if (!params.feature.enabled || !params.member || params.archived) return { kind: "hidden" };
  if (local.channelId === params.channelId && isLivePhase(local.phase)) return { kind: "in-call" };
  if (call === undefined) return { kind: "start" };
  const others = call.participants.filter((participant) => participant.userId !== params.meId);
  const max = params.feature.maxParticipants;
  if (others.length >= max) return { kind: "full", max };
  return {
    kind: "join",
    count: call.participants.length,
    userIds: call.participants.map((participant) => participant.userId).slice(0, 3),
  };
}

export type CallPane = "none" | "prejoin" | Exclude<CallPhase, "idle">;

/** Which call pane, if any, a conversation shows in place of its message column. */
export function callPaneFor(channelId: ChannelId, local: CallSnapshot, ui: CallUi): CallPane {
  if (local.channelId === channelId && local.phase !== "idle") {
    // A terminal state stays up until it is dismissed; dismissing clears `ui.channelId`.
    if ((local.phase === "failed" || local.phase === "moved") && ui.channelId !== channelId) return "none";
    return local.phase;
  }
  if (ui.channelId !== channelId) return "none";
  if (ui.failure !== null) return "failed";
  if (ui.prejoin) return "prejoin";
  return "none";
}

/** The conversation's path under the app prefix, as `chat:call` and ring notifications carry it. */
export function callHref(channelId: ChannelId): string {
  return `${CHAT_PREFIX}/c/${encodeURIComponent(channelId)}`;
}

/**
 * Sorts a join failure into what the pane explains.
 *
 * `conflict` is the server's "call is full"; `unavailable` means the deployment has no SFU; a
 * `DOMException` from `getUserMedia` means the browser (or the frame's permissions policy) refused
 * the camera or microphone. Anything else is shown as the engine or server worded it.
 */
export function classifyCallFailure(
  cause: unknown,
  max: number = MAX_CALL_PARTICIPANTS,
): CallFailure {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? (cause as { code: unknown }).code : undefined;
  const name = typeof cause === "object" && cause !== null && "name" in cause ? (cause as { name: unknown }).name : undefined;
  const message = cause instanceof Error ? cause.message : "Something went wrong.";
  if (code === "conflict") return { kind: "full", message: `This call is full (${max}).` };
  if (code === "unavailable") return { kind: "unavailable", message: "Calls are not switched on for this workspace." };
  if (code === "forbidden") return { kind: "error", message: "You can't join this call. The conversation may have been archived." };
  if (code === "rate_limited") {
    const after = typeof cause === "object" && cause !== null && "retryAfter" in cause ? (cause as { retryAfter?: unknown }).retryAfter : undefined;
    return {
      kind: "error",
      message: `Too many attempts to join. Try again${typeof after === "number" ? ` in ${after} s` : " in a minute"}.`,
    };
  }
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return { kind: "permission", message };
  }
  return { kind: "error", message };
}

// --- call quality (chat-video.md, "Quality phase 1") -----------------------------------------------

/** The tile indicator's accessible label and tooltip, or null when there is nothing to show. */
export function connectionQualityLabel(quality: ConnectionQuality | undefined): string | null {
  if (quality === undefined || quality === "unknown") return null;
  return `Connection: ${quality}`;
}

export type CallBannerKind = "audio-only" | "unstable" | "cpu";

export interface CallBanner {
  readonly kind: CallBannerKind;
  readonly message: string;
}

const BANNER_MESSAGES: Readonly<Record<CallBannerKind, string>> = {
  "audio-only": "Your connection is unstable — video paused to keep audio clear",
  unstable: "Your connection is unstable",
  cpu: "Your computer is struggling — sending lower video quality",
};

/**
 * The one quality banner the call shows, if any: audio-only mode first, then a poor uplink, then a
 * CPU-limited encoder. Absent snapshot fields read as "nothing wrong".
 *
 * Dismissal is per call and per kind. Dismissing the audio-only banner also covers "unstable", which
 * would only repeat its first half; a CPU limit is a different problem and still gets its say.
 */
export function callBanner(
  local: Pick<CallSnapshot, "phase" | "audioOnly" | "localQuality" | "limitation">,
  dismissed: ReadonlySet<CallBannerKind> = new Set(),
): CallBanner | null {
  if (local.phase !== "connected") return null;
  const active: CallBannerKind[] = [];
  if (local.audioOnly) active.push("audio-only");
  if (local.localQuality === "poor") active.push("unstable");
  if (local.limitation === "cpu") active.push("cpu");
  for (const kind of active) {
    if (dismissed.has(kind)) continue;
    if (kind === "unstable" && dismissed.has("audio-only")) continue;
    return { kind, message: BANNER_MESSAGES[kind] };
  }
  return null;
}

const SPEAKER_LABEL = /speaker|built-in|internal/iu;
const HEADPHONE_LABEL = /headphone|headset|airpods|buds/iu;

/** Whether an output device's label reads as the computer's own speakers. A blank label is not evidence. */
export function looksLikeBuiltInSpeakers(label: string | null | undefined): boolean {
  if (label === null || label === undefined || label.trim() === "") return false;
  return SPEAKER_LABEL.test(label) && !HEADPHONE_LABEL.test(label);
}

/**
 * Whether to suggest headphones: a call with two or more other people, played through what looks
 * like built-in speakers. The chosen output is looked up by id; with no choice, the browser's
 * `default` entry is used (Chromium labels it "Default - MacBook Pro Speakers"). Without a label --
 * no permission yet, or a browser that does not list outputs -- nothing is known, so no hint.
 */
export function shouldHintHeadphones(params: {
  readonly others: number;
  readonly outputId: string | null;
  readonly outputs: readonly Pick<MediaDeviceInfo, "deviceId" | "label">[];
}): boolean {
  if (params.others < 2) return false;
  const id = params.outputId ?? "default";
  const device = params.outputs.find((output) => output.deviceId === id);
  return looksLikeBuiltInSpeakers(device?.label);
}

const HEADPHONES_HINT_KEY = "chat.call.headphonesHint";

/** The headphones tip is shown until it is dismissed once, per browser. */
export function headphonesHintDismissed(): boolean {
  return readSetting(HEADPHONES_HINT_KEY) === "dismissed";
}

export function dismissHeadphonesHint(): void {
  writeSetting(HEADPHONES_HINT_KEY, "dismissed");
}

// --- remembered choices ------------------------------------------------------------------------

const CALL_PREFS_KEY = "chat.call";

/** How the next join starts: microphone, camera and the Quality phase 2 effects. */
export interface CallStart {
  readonly audio: boolean;
  readonly video: boolean;
  readonly noiseSuppression: boolean;
  readonly backgroundBlur: boolean;
}

export const DEFAULT_CALL_START: CallStart = { audio: true, video: true, noiseSuppression: false, backgroundBlur: false };

export interface CallPrefs {
  readonly devices: DeviceChoice;
  readonly start: CallStart;
}

/** Pre-join choices, remembered per browser. Anything unreadable falls back to the defaults. */
export function loadCallPrefs(): CallPrefs {
  const fallback: CallPrefs = { devices: NO_DEVICES, start: DEFAULT_CALL_START };
  const raw = readSetting(CALL_PREFS_KEY);
  if (raw === null) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<{ devices: Partial<DeviceChoice>; start: Partial<CallPrefs["start"]> }>;
    const id = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
    return {
      devices: {
        audioInputId: id(parsed.devices?.audioInputId),
        videoInputId: id(parsed.devices?.videoInputId),
        audioOutputId: id(parsed.devices?.audioOutputId),
      },
      start: {
        audio: parsed.start?.audio !== false,
        video: parsed.start?.video !== false,
        // Quality phase 2 effects are opt-in: only an explicit true turns one on.
        noiseSuppression: parsed.start?.noiseSuppression === true,
        backgroundBlur: parsed.start?.backgroundBlur === true,
      },
    };
  } catch {
    return fallback;
  }
}

export function saveCallPrefs(prefs: CallPrefs): void {
  writeSetting(CALL_PREFS_KEY, JSON.stringify(prefs));
}
