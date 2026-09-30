// The CallEngine contract: what the call UI (Stream C) drives and what the media engine (Stream B)
// implements. Framework-free on purpose -- the engine is plain TypeScript over WebRTC and the chat
// API, the UI subscribes to snapshots. See docs/plans/chat-video.md ("Client").
//
// One engine instance owns at most one call at a time, one RTCPeerConnection to the Cloudflare
// Realtime SFU, and every local media track. The store keeps the *room* (`CallState` from `call`
// events); the engine keeps the *media* and reports it here.

import type {
  CallSimulcastRid,
  CallState,
  ChannelId,
  ClientEvent,
  ParticipantId,
  UserId,
} from "../../contract.js";
import type { ChatApi } from "../../api/types.js";

/** The subset of the chat API the engine signals through. The real one is `ChatApi`; tests fake it. */
export type CallSignalling = Pick<
  ChatApi,
  | "joinCall"
  | "publishTracks"
  | "announceTracks"
  | "pullTracks"
  | "renegotiateCall"
  | "closeTracks"
  | "setLayer"
  | "reconnectCall"
  | "leaveCall"
  | "postCallStats"
>;

/** Where `call-beat` frames go: the app's existing socket. */
export type SendClientEvent = (event: Extract<ClientEvent, { t: "call-beat" }>) => void;

/** Injected so tests can run without a browser's WebRTC and media devices. */
export interface CallEnvironment {
  createPeerConnection(config: RTCConfiguration): RTCPeerConnection;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  getDisplayMedia(options: DisplayMediaStreamOptions): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  /** `navigator.mediaDevices` `devicechange`; returns an unsubscribe. */
  onDeviceChange(listener: () => void): () => void;
  /** A 1 fps black video track, sent while the camera is off so the SFU keeps the track alive. */
  createBlackVideoTrack(): MediaStreamTrack;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /**
   * `navigator.mediaDevices.getSupportedConstraints()` (feature-detects `voiceIsolation`). Optional:
   * absent, the engine reads `navigator` itself. Quality phase 1.
   */
  supportedConstraints?(): MediaTrackSupportedConstraints;
  /** `RTCRtpSender.getCapabilities(kind)`, null where unsupported. Optional: absent, no codec preferences (no RED). */
  senderCapabilities?(kind: "audio" | "video"): RTCRtpCapabilities | null;
  /** `document.visibilityState === "hidden"`. Optional: absent reads as visible. */
  isDocumentHidden?(): boolean;
  /** `document` `visibilitychange`; returns an unsubscribe. Optional. */
  onVisibilityChange?(listener: () => void): () => void;
  /**
   * Quality phase 2 effects. Each wraps a raw capture track and returns the processed track to send,
   * or null when this browser cannot run it. Absent means unsupported. `supports*` answers without
   * loading anything, so the UI can hide a switch that would never work.
   */
  supportsNoiseSuppression?(): boolean;
  createNoiseSuppressor?(microphone: MediaStreamTrack): Promise<TrackProcessor | null>;
  supportsBackgroundBlur?(): boolean;
  createBackgroundBlur?(camera: MediaStreamTrack): Promise<TrackProcessor | null>;
}

/** A capture track run through an effect: `track` is what is sent; `close` stops the processing. */
export interface TrackProcessor {
  readonly track: MediaStreamTrack;
  close(): void;
}

/**
 * An optional effect's state for the UI. `cpu` means the engine turned it off because the device
 * could not keep up; `failed` that it could not start. Either can be switched on again.
 */
export type EffectState = "unsupported" | "off" | "starting" | "on" | "cpu" | "failed";

export type CallPhase =
  /** No call. */
  | "idle"
  /** `joinCall` in flight, or the first publish not answered yet. */
  | "joining"
  /** Connected; publishing and pulling. */
  | "connected"
  /** The connection failed and the engine is rebuilding it (`reconnectCall`). */
  | "reconnecting"
  /** This participant was replaced by another tab/frame, or expired. Terminal until the next join. */
  | "moved"
  /** Join or rebuild failed for good; `error` says why. Terminal until the next join. */
  | "failed";

/** A preview/pre-join choice, remembered per browser by the UI. Null means "system default". */
export interface DeviceChoice {
  readonly audioInputId: string | null;
  readonly videoInputId: string | null;
  readonly audioOutputId: string | null;
}

export interface JoinOptions {
  readonly channelId: ChannelId;
  /** Start with the microphone on. */
  readonly audio: boolean;
  /** Start with the camera on. */
  readonly video: boolean;
  readonly devices: DeviceChoice;
  /** Quality phase 2: start with these effects on, where supported. */
  readonly noiseSuppression: boolean;
  readonly backgroundBlur: boolean;
}

export interface LeaveOptions {
  readonly keepalive?: boolean;
}

/** One remote participant's media, keyed by participant id in {@link CallSnapshot.remotes}. */
export interface RemoteMedia {
  readonly participantId: ParticipantId;
  readonly userId: UserId;
  /** Camera (or its black placeholder). Null until pulled, or when they publish no video. */
  readonly video: MediaStream | null;
  /** Their screen share, when they share. */
  readonly screen: MediaStream | null;
  /** Their microphone. The UI plays it through an `<audio>` element (autoplay after the Join click). */
  readonly audio: MediaStream | null;
  /** The layer currently requested for their camera. */
  readonly videoRid: CallSimulcastRid | null;
  /** How well their media reaches us (loss, jitter, frame rate of what we receive). Quality phase 1. */
  readonly quality: ConnectionQuality;
  /** True while their video pull is paused: tile hidden, or audio-only (chosen or forced). */
  readonly videoPaused: boolean;
}

/** Coarse connection quality for tile indicators (chat-video.md, "Quality phase 1"). */
export type ConnectionQuality = "good" | "fair" | "poor" | "unknown";

/**
 * Why the local encoder is holding back, from `outbound-rtp.qualityLimitationReason`, sustained.
 * Sustained `cpu` makes the engine shed simulcast layers; `bandwidth` is reported only, because the
 * browser's own bandwidth estimation already drops layers.
 */
export type QualityLimitation = "none" | "cpu" | "bandwidth";

export interface CallSnapshot {
  readonly phase: CallPhase;
  readonly channelId: ChannelId | null;
  readonly callId: string | null;
  readonly participantId: ParticipantId | null;
  /** Local preview of the camera; null while the camera is off. */
  readonly localVideo: MediaStream | null;
  /** Local screen share; null when not sharing. */
  readonly localScreen: MediaStream | null;
  readonly audioEnabled: boolean;
  readonly videoEnabled: boolean;
  readonly screenEnabled: boolean;
  readonly remotes: Readonly<Record<ParticipantId, RemoteMedia>>;
  /** Participant id of the loudest speaker over the last second, with hysteresis; null in silence. */
  readonly activeSpeaker: ParticipantId | null;
  /** Human-readable reason for `failed`, or a transient warning (e.g. "Camera is in use"). */
  readonly error: string | null;
  /**
   * The chosen audio output (`DeviceChoice.audioOutputId`), for the UI to apply to its remote
   * `<audio>` elements with `setSinkId` (see `applyAudioOutput` in `engine/devices.ts`). Null means
   * the system default.
   */
  readonly audioOutputId: string | null;
  /** Our own uplink quality (RTT, remote-reported loss, qualityLimitation). Quality phase 1. */
  readonly localQuality: ConnectionQuality;
  /** Sustained encoder limitation, for the "your connection is unstable" / CPU banner. */
  readonly limitation: QualityLimitation;
  /**
   * True while the engine has paused every remote video because our downlink cannot carry it; audio
   * continues. The UI shows a banner; the engine restores video when it clears.
   */
  readonly audioOnly: boolean;
  /**
   * True while this person has chosen audio-only (`setAudioOnly`): every remote camera is paused and
   * their own camera is off. Separate from {@link audioOnly}, which the engine sets for a poor
   * downlink, so the UI does not blame the connection for a choice.
   */
  readonly audioOnlyChosen: boolean;
  /** How many simulcast layers we currently send for the camera (3 = all; fewer under CPU limits). */
  readonly sendLayers: number;
  /** ML noise suppression on the microphone (RNNoise). */
  readonly noiseSuppression: EffectState;
  /** Background blur on the camera (MediaPipe segmentation). */
  readonly backgroundBlur: EffectState;
}

/**
 * How big the UI draws each remote participant's camera, so the engine can pick a simulcast layer.
 * `hidden` (off-screen, chat pane shown instead) requests the smallest layer.
 */
export type TileSize = "large" | "medium" | "small" | "hidden";

/** The two effects, named as their {@link CallSnapshot} fields. */
export type CallEffect = "noiseSuppression" | "backgroundBlur";

/** The snapshot before anything has happened, and whenever no engine is attached. */
export const IDLE_CALL: CallSnapshot = Object.freeze({
  phase: "idle",
  channelId: null,
  callId: null,
  participantId: null,
  localVideo: null,
  localScreen: null,
  audioEnabled: false,
  videoEnabled: false,
  screenEnabled: false,
  remotes: Object.freeze({}),
  activeSpeaker: null,
  error: null,
  audioOutputId: null,
  localQuality: "unknown",
  limitation: "none",
  audioOnly: false,
  audioOnlyChosen: false,
  sendLayers: 3,
  noiseSuppression: "unsupported",
  backgroundBlur: "unsupported",
});

/** Every device the system default. */
export const NO_DEVICES: DeviceChoice = Object.freeze({ audioInputId: null, videoInputId: null, audioOutputId: null });

export interface CallEngine {
  /** Current state. Stable object identity between changes, so it works with useSyncExternalStore. */
  snapshot(): CallSnapshot;
  subscribe(listener: () => void): () => void;

  /**
   * Joins (starting the call if none runs). Resolves once connected and the initial tracks are
   * published; rejects (and moves to `failed`) if that is impossible, e.g. `conflict` = call full.
   * Must be called from a user gesture: it asks for media and it unlocks audio autoplay.
   */
  join(options: JoinOptions): Promise<void>;
  /**
   * Leaves and releases every device, sending the final stats report and the leave. Safe in any
   * phase. `keepalive` (page unload) sends both at once as requests that outlive the page.
   */
  leave(options?: LeaveOptions): Promise<void>;

  /**
   * Feed every `call` event and channel-list/hello call state for the joined channel here. The
   * engine diffs participants and announced tracks against what it pulls: new tracks are pulled in
   * one batch, departed ones closed.
   */
  applyCallState(state: CallState | null): void;
  /** Feed `call-moved` events here. */
  handleMoved(callId: string, participantId: ParticipantId): void;

  setAudioEnabled(enabled: boolean): void;
  setVideoEnabled(enabled: boolean): Promise<void>;
  /** Starts (asks the browser for a screen) or stops sharing. Resolves false if the user cancelled. */
  setScreenEnabled(enabled: boolean): Promise<boolean>;
  /** Switches an input device live (`replaceTrack`, no renegotiation) or the output sink. */
  setDevices(devices: Partial<DeviceChoice>): Promise<void>;
  listDevices(): Promise<{ audioInputs: MediaDeviceInfo[]; videoInputs: MediaDeviceInfo[]; audioOutputs: MediaDeviceInfo[] }>;

  /**
   * Chosen audio-only: pauses every remote camera pull (screen shares and audio keep flowing) and
   * turns the camera off, turning it back on when audio-only ends if it was on before. Resolves
   * once the camera change is done.
   */
  setAudioOnly(enabled: boolean): Promise<void>;

  /**
   * The call is shown in a Document Picture-in-Picture window, which stays visible when this
   * document's tab is hidden: while true, a hidden document does not pause remote video (the tiles in
   * the window report their own sizes).
   */
  setPictureInPicture(open: boolean): void;

  /**
   * Quality phase 2 effects, off by default. Turning one on builds the processor around the current
   * track and swaps it onto the sender (no renegotiation); a device switch rebuilds it; sustained CPU
   * strain turns it off (`cpu`) before any simulcast layer is shed. Resolves when the swap is done.
   */
  setEffect(effect: CallEffect, enabled: boolean): Promise<void>;

  /** The UI reports tile sizes whenever layout changes; the engine debounces layer switches. */
  setTileSizes(sizes: Readonly<Record<ParticipantId, TileSize>>): void;

  /** Tears down without calling the server. Page unload uses `leave({ keepalive: true })`. */
  dispose(): void;
}

export interface CallEngineDeps {
  readonly api: CallSignalling;
  readonly send: SendClientEvent;
  readonly env: CallEnvironment;
  /** Structured, redacted diagnostics. Never SDP or credentials. */
  readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export type CreateCallEngine = (deps: CallEngineDeps) => CallEngine;
