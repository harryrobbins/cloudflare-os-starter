// The browser media engine for chat calls: one RTCPeerConnection to the Cloudflare Realtime SFU per
// call, all SDP work serialised through one queue, signalling through the chat API. See
// docs/plans/chat-video.md ("Client") and docs/research/chat-video-sfu.md for the rules it follows:
//
// - one negotiation at a time per session; an SFU offer is answered via `renegotiate` inside the
//   same queued task, before anything else runs;
// - a published track is announced only after `outbound-rtp bytesSent > 0`;
// - senders are never stopped while in the call (the SFU garbage-collects a silent track after
//   30 s): mic mute is `track.enabled = false`, camera off is `replaceTrack(black 1 fps track)`;
// - a lost or failed exchange, or a dead connection, rebuilds with a new session (`reconnect`)
//   instead of retrying `tracks/new`.
//
// Never log SDP or ICE credentials: `log` gets event names and small scalar fields only.

import {
  CALL_HEARTBEAT_MS,
  MAX_CALL_STATS_PER_MINUTE,
  MAX_CALL_TRACKS_PER_REQUEST,
  type CallIceServer,
  type CallParticipant,
  type CallSimulcastRid,
  type CallState,
  type CallStatsReport,
  type CallTrack,
  type CallTrackKind,
  type ParticipantId,
  type SessionDescription,
  type UserId,
} from "../../contract.js";
import { splitDevices } from "./devices.js";
import { LayerScheduler } from "./layers.js";
import {
  AUDIO_ENCODINGS,
  CAMERA_SIMULCAST_ENCODINGS,
  CAMERA_SINGLE_ENCODING,
  DEGRADATION_PREFERENCE,
  DISPLAY_MEDIA_OPTIONS,
  LOWEST_RID,
  SCREEN_ENCODINGS,
  SCREEN_MAX_FRAMERATE,
  audioConstraints,
  detectSupportedConstraints,
  ridForTile,
  videoConstraints,
} from "./media.js";
import { waitForBytesSent, waitForConnected, waitForIceGathering } from "./peer.js";
import {
  DownlinkAdaptation,
  LossWindow,
  QUALITY_SAMPLE_MS,
  SendAdaptation,
  activeLayers,
  classifyReceive,
  classifyUplink,
  downlinkVerdict,
  expectedFramerate,
  stepSendEncodings,
  worstQuality,
  type DownlinkMode,
  type SendAction,
} from "./quality.js";
import { SerialQueue, Superseded } from "./queue.js";
import { ensureOpusParams, redFirst } from "./sdp.js";
import { SpeakerDetector } from "./speaker.js";
import {
  inboundAudioLevel,
  mediaSourceAudioLevel,
  readInbound,
  readOutbound,
  readTransport,
  type InboundSample,
  type OutboundSample,
} from "./stats.js";
import { CALL_STATS_INTERVAL_MS, CallTelemetry } from "./telemetry.js";
import type {
  CallEngine,
  CallEngineDeps,
  CallSnapshot,
  ConnectionQuality,
  CreateCallEngine,
  DeviceChoice,
  EffectState,
  JoinOptions,
  QualityLimitation,
  RemoteMedia,
  TileSize,
  TrackProcessor,
} from "./types.js";

/** Timings. Exported so tests and diagnostics can name them. */
export const ENGINE_TIMINGS = {
  iceGatheringCapMs: 1_500,
  connectCapMs: 10_000,
  bytesSentCapMs: 5_000,
  bytesSentPollMs: 100,
  pullTrackTimeoutMs: 5_000,
  layerDebounceMs: 1_000,
  speakerSampleMs: 250,
  disconnectedGraceMs: 7_000,
  reconnectBudgetMs: 30_000,
  reconnectFirstDelayMs: 1_000,
  reconnectMaxDelayMs: 8_000,
  /** A rebuild this soon after the last one continues its backoff and budget instead of starting fresh. */
  recoveryStableMs: 15_000,
  /** Quality phase 1: stats sampling for quality, CPU and downlink adaptation. */
  qualitySampleMs: QUALITY_SAMPLE_MS,
  /** A participant whose tile stays hidden (or the whole tab) this long has its video pull closed. */
  hiddenPauseMs: 5_000,
  statsIntervalMs: CALL_STATS_INTERVAL_MS,
} as const;

/** Level changes smaller than this do not produce a new snapshot. */
const LEVEL_EPSILON = 0.05;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Session {
  readonly callId: string;
  readonly participantId: ParticipantId;
  sessionId: string;
}

/** One of our own published transceivers. */
interface LocalPublication {
  readonly kind: CallTrackKind;
  readonly transceiver: RTCRtpTransceiver;
  readonly simulcast: boolean;
  name: string | null;
}

/** One remote track pulled onto our connection. Keyed by publisher session + track name. */
interface Pull {
  readonly key: string;
  readonly participantId: ParticipantId;
  readonly userId: UserId;
  readonly name: string;
  readonly kind: CallTrackKind;
  readonly simulcast: boolean;
  readonly mid: string;
  rid: CallSimulcastRid | null;
  track: MediaStreamTrack | null;
  transceiver: RTCRtpTransceiver | null;
  /** Cumulative inbound counters at the previous quality sample, and the loss window. */
  readonly counters: { lost: number; received: number; decoded: number; dropped: number; readonly window: LossWindow };
}

interface Arrival {
  readonly track: MediaStreamTrack;
  readonly transceiver: RTCRtpTransceiver;
}

interface PublishItem {
  readonly kind: CallTrackKind;
  readonly track: MediaStreamTrack;
}

type WantedTrack = { readonly participant: CallParticipant; readonly track: CallTrack };

const EMPTY_REMOTES: Readonly<Record<ParticipantId, RemoteMedia>> = Object.freeze({});

const IDLE_SNAPSHOT: CallSnapshot = Object.freeze({
  phase: "idle",
  channelId: null,
  callId: null,
  participantId: null,
  localVideo: null,
  localScreen: null,
  audioEnabled: false,
  videoEnabled: false,
  screenEnabled: false,
  localAudioLevel: 0,
  remotes: EMPTY_REMOTES,
  activeSpeaker: null,
  error: null,
  audioOutputId: null,
  localQuality: "unknown",
  limitation: "none",
  audioOnly: false,
  audioOnlyChosen: false,
  noiseSuppression: "unsupported",
  backgroundBlur: "unsupported",
});

const NO_DEVICES: DeviceChoice = { audioInputId: null, videoInputId: null, audioOutputId: null };

type CallTrackKindAv = "audio" | "video";

/** One effect: whether it is wanted, and the processor currently built (around `source`). */
interface EffectSlot {
  wanted: boolean;
  source: MediaStreamTrack | null;
  processor: TrackProcessor | null;
  /** The build in flight, so a second request waits for it instead of starting another. */
  starting: Promise<void> | null;
  /** Turned off by the CPU monitor rather than by the person. */
  shedForCpu: boolean;
}

export const createCallEngine: CreateCallEngine = (deps) => new Engine(deps);

class Engine implements CallEngine {
  private readonly api: CallEngineDeps["api"];
  private readonly env: CallEngineDeps["env"];
  private readonly sendEvent: CallEngineDeps["send"];
  private readonly logSink: CallEngineDeps["log"];

  private snap: CallSnapshot = IDLE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();

  /** Bumped on every teardown and rebuild; queued work from an older generation is dropped. */
  private gen = 0;
  private queue = new SerialQueue();
  private session: Session | null = null;
  private pc: RTCPeerConnection | null = null;
  private devices: DeviceChoice = NO_DEVICES;

  private mic: MediaStreamTrack | null = null;
  private camera: MediaStreamTrack | null = null;
  private screen: MediaStreamTrack | null = null;
  private black: MediaStreamTrack | null = null;
  private audioOn = false;
  private videoOn = false;
  private localVideoStream: MediaStream | null = null;

  private readonly pubs = new Map<CallTrackKind, LocalPublication>();
  private readonly pulls = new Map<string, Pull>();
  private readonly arrivals = new Map<string, Arrival>();
  private readonly waiters = new Map<string, { resolve: (arrival: Arrival | null) => void; timer: unknown }>();
  private readonly remoteStreams = new Map<string, { trackId: string; stream: MediaStream }>();

  private latest: CallState | null = null;
  private reconcileQueued = false;
  private tileSizes: Readonly<Record<ParticipantId, TileSize>> = {};
  private readonly layers: LayerScheduler;
  private readonly speaker = new SpeakerDetector();
  private readonly reportedLevels = new Map<ParticipantId, number>();

  private heartbeatTimer: unknown = null;
  private speakerTimer: unknown = null;
  private disconnectTimer: unknown = null;
  private iceRestartTried = false;
  /** The last successful rebuild, so a flapping connection keeps backing off. */
  private recovery: { recoveredAt: number; startedAt: number; delay: number } | null = null;
  private readonly sleeps = new Set<{ timer: unknown; resolve: () => void }>();
  private unsubscribeDevices: (() => void) | null = null;
  private unsubscribeVisibility: (() => void) | null = null;

  // Quality phase 1
  private qualityTimer: unknown = null;
  private lastQualityAt: number | null = null;
  private sendAdaptation = new SendAdaptation();
  /** Cumulative `qualityLimitationDurations` (s) of the current camera publication. */
  private limitedSeconds: { cpu: number; bandwidth: number } | null = null;
  private downlink = new DownlinkAdaptation();
  private readonly remoteQuality = new Map<ParticipantId, ConnectionQuality>();
  /** Participants whose tiles have been hidden for `hiddenPauseMs`: their camera is not pulled. */
  private readonly hiddenPaused = new Set<ParticipantId>();
  private readonly hiddenTimers = new Map<ParticipantId, { readonly since: number; readonly timer: unknown }>();
  /** `setAudioOnly(true)`: survives a rebuild, ends with the call. */
  private chosenAudioOnly = false;
  /** Whether to turn the camera back on when chosen audio-only ends. */
  private cameraBeforeAudioOnly = false;
  /** `setPictureInPicture(true)`: the call is on screen in its own window whatever this tab does. */
  private pictureInPicture = false;

  // Quality phase 2 effects: what the person asked for, and the processor built around which track.
  private readonly effects: Record<CallTrackKindAv, EffectSlot> = {
    audio: { wanted: false, source: null, processor: null, starting: null, shedForCpu: false },
    video: { wanted: false, source: null, processor: null, starting: null, shedForCpu: false },
  };
  private telemetry: CallTelemetry | null = null;
  private telemetryTimer: unknown = null;
  /** When stats reports went out, for the per-minute cap. Survives calls: the cap is the server's. */
  private statsSentAt: number[] = [];

  constructor(deps: CallEngineDeps) {
    this.api = deps.api;
    this.env = deps.env;
    this.sendEvent = deps.send;
    this.logSink = deps.log;
    this.layers = new LayerScheduler(
      this.env,
      ENGINE_TIMINGS.layerDebounceMs,
      (key) => this.pulls.get(key)?.rid ?? null,
      (key, rid) => void this.applyLayer(key, rid),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Public surface

  snapshot(): CallSnapshot {
    return this.snap;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async join(options: JoinOptions): Promise<void> {
    if (this.session || this.snap.phase === "joining") await this.leave();
    this.teardown();
    const gen = this.gen;
    this.devices = { ...options.devices };
    this.set({
      ...IDLE_SNAPSHOT,
      phase: "joining",
      channelId: options.channelId,
      audioOutputId: this.devices.audioOutputId,
    });
    this.log("join", { channelId: options.channelId, audio: options.audio, video: options.video });

    // Media first, while the Join click still counts as a user gesture.
    const warnings: string[] = [];
    const media = await this.acquireInitialMedia(options.video, warnings);
    if (gen !== this.gen) {
      media.audio?.stop();
      media.video?.stop();
      throw new Error("The join was cancelled.");
    }
    this.mic = media.audio;
    this.camera = media.video;
    this.audioOn = options.audio && this.mic !== null;
    if (this.mic) this.mic.enabled = this.audioOn;
    this.videoOn = this.camera !== null;
    this.set({
      audioEnabled: this.audioOn,
      videoEnabled: this.videoOn,
      localVideo: this.localVideo(),
      error: warnings.length > 0 ? warnings.join(" ") : null,
      noiseSuppression: this.effectSupported("audio") ? "off" : "unsupported",
      backgroundBlur: this.effectSupported("video") ? "off" : "unsupported",
    });
    // Effects chosen before joining are built now, so the first packets are already processed.
    this.effects.audio.wanted = options.noiseSuppression === true && this.effectSupported("audio");
    this.effects.video.wanted = options.backgroundBlur === true && this.effectSupported("video");
    await Promise.all([this.syncEffect("audio", gen), this.syncEffect("video", gen)]);
    if (gen !== this.gen) throw new Error("The join was cancelled.");

    let joined;
    try {
      joined = await this.api.joinCall(options.channelId);
    } catch (error) {
      if (gen === this.gen) this.fail(joinErrorMessage(error));
      throw error;
    }
    if (gen !== this.gen) {
      void this.api.leaveCall(joined.call.id, { participantId: joined.participantId }).catch(() => undefined);
      throw new Error("The join was cancelled.");
    }
    const session: Session = { callId: joined.call.id, participantId: joined.participantId, sessionId: joined.sessionId };
    this.session = session;
    this.latest = joined.call;
    this.set({ callId: session.callId, participantId: session.participantId });
    this.startHeartbeat();
    this.unsubscribeDevices = this.env.onDeviceChange(() => void this.recoverEndedInputs());
    this.unsubscribeVisibility = this.env.onVisibilityChange?.(() => this.refreshVisibility()) ?? null;

    try {
      this.pc = this.createPeerConnection(joined.iceServers, gen);
      await this.queue.run(async () => {
        await this.publishOp(gen, this.localPublishItems());
        this.assertCurrent(gen);
        this.set({ phase: "connected" });
      });
    } catch (error) {
      if (gen !== this.gen) throw error instanceof Superseded ? new Error("The join was cancelled.") : error;
      this.log("join-failed", { error: describeError(error) });
      this.fail("Could not connect the call.");
      void this.api.leaveCall(session.callId, { participantId: session.participantId }).catch(() => undefined);
      throw error;
    }
    this.log("connected", { callId: session.callId });
    this.telemetry = new CallTelemetry(this.env.now());
    this.startTelemetry();
    this.refreshVisibility();
    this.refreshRemotes();
    this.startSpeakerLoop(gen);
    this.startQualityLoop(gen);
    this.scheduleReconcile();
  }

  async leave(): Promise<void> {
    const session = this.session;
    const wasActive = this.snap.phase !== "idle";
    // Built before teardown (which drops the accumulated stats), sent before leaveCall.
    const finalReport = session ? this.takeStatsReport(true) : null;
    this.teardown();
    if (wasActive) this.set({ ...IDLE_SNAPSHOT, audioOutputId: this.devices.audioOutputId });
    if (session) {
      if (finalReport) await this.postStats(session.callId, finalReport);
      this.log("leave", { callId: session.callId });
      try {
        await this.api.leaveCall(session.callId, { participantId: session.participantId });
      } catch (error) {
        this.log("leave-failed", { error: describeError(error) });
      }
    }
  }

  dispose(): void {
    this.teardown();
    this.set({ ...IDLE_SNAPSHOT });
  }

  applyCallState(state: CallState | null): void {
    const session = this.session;
    if (!session) return;
    if (state && state.id !== session.callId) return;
    this.latest = state;
    this.refreshVisibility();
    this.refreshRemotes();
    this.scheduleReconcile();
  }

  handleMoved(callId: string, participantId: ParticipantId): void {
    const session = this.session;
    if (!session || session.callId !== callId || session.participantId !== participantId) return;
    this.log("moved", { callId });
    const channelId = this.snap.channelId;
    this.teardown();
    this.set({
      ...IDLE_SNAPSHOT,
      phase: "moved",
      channelId,
      callId,
      error: "This call continued in another window.",
    });
  }

  setAudioEnabled(enabled: boolean): void {
    if (!this.session) return;
    if (enabled && !this.mic) {
      void this.enableLateMicrophone();
      return;
    }
    if (!this.mic || this.audioOn === enabled) return;
    this.audioOn = enabled;
    // Never stop the sender: a muted track keeps Opus packets flowing, so the SFU keeps the track.
    this.mic.enabled = enabled;
    this.set({ audioEnabled: enabled });
    this.beat();
  }

  async setVideoEnabled(enabled: boolean): Promise<void> {
    if (!this.session) return;
    // Turning the camera on during chosen audio-only is a choice too: leaving it must not repeat it.
    if (enabled) this.cameraBeforeAudioOnly = false;
    const gen = this.gen;
    if (!enabled) {
      if (!this.videoOn) return;
      this.videoOn = false;
      const camera = this.camera;
      this.camera = null;
      this.set({ videoEnabled: false, localVideo: this.localVideo() });
      this.beat();
      const publication = this.pubs.get("video");
      if (publication) {
        // Keep the sender alive with 1 fps black; the camera itself stops so its light goes off.
        this.black ??= this.env.createBlackVideoTrack();
        await publication.transceiver.sender.replaceTrack(this.black).catch((error: unknown) => {
          this.log("replace-track-failed", { kind: "video", error: describeError(error) });
        });
      }
      camera?.stop();
      // A blur around the stopped camera has nothing to process; it is rebuilt when the camera is back.
      if (this.effects.video.processor !== null) await this.syncEffect("video", gen);
      return;
    }
    if (this.videoOn) return;
    let track: MediaStreamTrack;
    try {
      track = await this.acquireTrack("video", this.devices.videoInputId);
    } catch (error) {
      this.log("camera-unavailable", { error: errorName(error) });
      if (gen === this.gen) this.set({ error: mediaErrorMessage("camera", error) });
      return;
    }
    if (gen !== this.gen || this.videoOn) {
      track.stop();
      return;
    }
    this.camera = track;
    this.videoOn = true;
    this.set({ videoEnabled: true, localVideo: this.localVideo(), error: null });
    this.beat();
    const publication = this.pubs.get("video");
    if (this.effects.video.wanted) {
      await this.syncEffect("video", gen);
      if (gen !== this.gen) return;
    }
    const sent = this.sentTrack("video") ?? track;
    if (publication) {
      await publication.transceiver.sender.replaceTrack(sent).catch((error: unknown) => {
        this.log("replace-track-failed", { kind: "video", error: describeError(error) });
      });
    } else if (this.snap.phase === "connected") {
      // Joined with the camera off: publish it now. While reconnecting, the rebuild publishes it.
      const ok = await this.publishLate(gen, { kind: "video", track: sent });
      if (!ok && gen === this.gen && this.snap.phase === "connected") {
        this.set({ error: "Could not start your camera in the call." });
      }
    }
  }

  async setScreenEnabled(enabled: boolean): Promise<boolean> {
    if (!this.session) return false;
    const gen = this.gen;
    if (!enabled) {
      await this.stopScreen(gen);
      return true;
    }
    if (this.screen) return true;
    let stream: MediaStream;
    try {
      stream = await this.env.getDisplayMedia(DISPLAY_MEDIA_OPTIONS);
    } catch (error) {
      const name = errorName(error);
      this.log("screen-cancelled", { error: name });
      if (name !== "NotAllowedError" && name !== "AbortError" && gen === this.gen) {
        this.set({ error: "Could not share your screen." });
      }
      return false;
    }
    const track = stream.getVideoTracks()[0];
    for (const extra of stream.getTracks()) if (extra !== track) extra.stop();
    if (!track) return false;
    if (gen !== this.gen || this.screen) {
      track.stop();
      return gen === this.gen;
    }
    track.contentHint = "detail";
    // The browser's own "Stop sharing" button ends the track.
    track.addEventListener("ended", () => {
      if (this.screen === track) void this.stopScreen(this.gen);
    });
    this.screen = track;
    this.set({ screenEnabled: true, localScreen: new MediaStream([track]) });
    this.beat();
    if (this.snap.phase === "connected") {
      const ok = await this.publishLate(gen, { kind: "screen", track });
      if (!ok && gen === this.gen && this.screen === track && this.snap.phase === "connected") {
        await this.stopScreen(gen);
        this.set({ error: "Could not share your screen." });
        return false;
      }
    }
    return true;
  }

  async setDevices(devices: Partial<DeviceChoice>): Promise<void> {
    const previous = this.devices;
    this.devices = { ...previous, ...devices };
    if (devices.audioOutputId !== undefined) this.set({ audioOutputId: this.devices.audioOutputId });
    if (!this.session) return;
    const gen = this.gen;
    if (devices.audioInputId !== undefined && devices.audioInputId !== previous.audioInputId && this.mic) {
      await this.switchInput("audio", gen);
    }
    if (devices.videoInputId !== undefined && devices.videoInputId !== previous.videoInputId && this.camera) {
      await this.switchInput("video", gen);
    }
  }

  async listDevices(): Promise<{
    audioInputs: MediaDeviceInfo[];
    videoInputs: MediaDeviceInfo[];
    audioOutputs: MediaDeviceInfo[];
  }> {
    return splitDevices(await this.env.enumerateDevices());
  }

  setTileSizes(sizes: Readonly<Record<ParticipantId, TileSize>>): void {
    this.tileSizes = { ...sizes };
    this.requestLayers();
    this.refreshVisibility();
  }

  // ---------------------------------------------------------------------------------------------
  // Snapshot

  private set(patch: Partial<Mutable<CallSnapshot>>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof CallSnapshot)[]) {
      if (this.snap[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.snap = Object.freeze({ ...this.snap, ...patch });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.log("listener-failed", { error: errorName(error) });
      }
    }
  }

  /** The camera as sent: blurred when that effect is on, so the preview shows what others see. */
  private localVideo(): MediaStream | null {
    const track = this.sentTrack("video");
    if (!track) {
      this.localVideoStream = null;
      return null;
    }
    if (this.localVideoStream?.getVideoTracks()[0] !== track) this.localVideoStream = new MediaStream([track]);
    return this.localVideoStream;
  }

  /** Rebuilds `remotes` from the room state and the pulls, reusing unchanged entries. */
  private refreshRemotes(): void {
    const session = this.session;
    const previous = this.snap.remotes;
    const next: Record<ParticipantId, RemoteMedia> = {};
    let changed = false;
    const participants = session && this.latest ? this.latest.participants : [];
    for (const participant of participants) {
      if (participant.id === session?.participantId) continue;
      const entry: RemoteMedia = {
        participantId: participant.id,
        userId: participant.userId,
        audio: this.remoteStream(participant, "audio"),
        video: this.remoteStream(participant, "video"),
        screen: this.remoteStream(participant, "screen"),
        audioLevel: this.reportedLevels.get(participant.id) ?? 0,
        videoRid: this.pullFor(participant, "video")?.rid ?? null,
        quality: this.remoteQuality.get(participant.id) ?? "unknown",
        videoPaused: participant.tracks.some((track) => track.kind === "video") && this.isVideoPaused(participant.id),
      };
      const old = previous[participant.id];
      if (old && sameRemote(old, entry)) {
        next[participant.id] = old;
      } else {
        next[participant.id] = Object.freeze(entry);
        changed = true;
      }
    }
    if (Object.keys(previous).length !== Object.keys(next).length) changed = true;
    for (const key of [...this.remoteStreams.keys()]) {
      const participantId = key.slice(0, key.lastIndexOf("/"));
      if (!(participantId in next)) this.remoteStreams.delete(key);
    }
    if (changed) this.set({ remotes: Object.freeze(next) });
  }

  private pullFor(participant: CallParticipant, kind: CallTrackKind): Pull | null {
    for (const pull of this.pulls.values()) {
      if (pull.participantId === participant.id && pull.kind === kind && pull.key.startsWith(`${participant.sessionId}/`)) {
        return pull;
      }
    }
    return null;
  }

  private remoteStream(participant: CallParticipant, kind: CallTrackKind): MediaStream | null {
    const cacheKey = `${participant.id}/${kind}`;
    const track = this.pullFor(participant, kind)?.track ?? null;
    if (!track) {
      this.remoteStreams.delete(cacheKey);
      return null;
    }
    const cached = this.remoteStreams.get(cacheKey);
    if (cached && cached.trackId === track.id) return cached.stream;
    const stream = new MediaStream([track]);
    this.remoteStreams.set(cacheKey, { trackId: track.id, stream });
    return stream;
  }

  // ---------------------------------------------------------------------------------------------
  // Media acquisition

  private async acquireInitialMedia(
    wantVideo: boolean,
    warnings: string[],
  ): Promise<{ audio: MediaStreamTrack | null; video: MediaStreamTrack | null }> {
    if (wantVideo) {
      // One prompt for both where the browser allows it.
      try {
        const stream = await this.env.getUserMedia({
          audio: audioConstraints(this.devices.audioInputId, this.supportedConstraints()),
          video: videoConstraints(this.devices.videoInputId),
        });
        const audio = stream.getAudioTracks()[0] ?? null;
        const video = stream.getVideoTracks()[0] ?? null;
        if (audio && video) return { audio, video };
        for (const track of stream.getTracks()) track.stop();
      } catch (error) {
        this.log("media-combined-failed", { error: errorName(error) });
      }
    }
    let audio: MediaStreamTrack | null = null;
    let video: MediaStreamTrack | null = null;
    try {
      audio = await this.acquireTrack("audio", this.devices.audioInputId);
    } catch (error) {
      warnings.push(mediaErrorMessage("microphone", error));
    }
    if (wantVideo) {
      try {
        video = await this.acquireTrack("video", this.devices.videoInputId);
      } catch (error) {
        warnings.push(mediaErrorMessage("camera", error));
      }
    }
    return { audio, video };
  }

  private async acquireTrack(kind: "audio" | "video", deviceId: string | null): Promise<MediaStreamTrack> {
    const constraints: MediaStreamConstraints =
      kind === "audio" ? { audio: audioConstraints(deviceId, this.supportedConstraints()) } : { video: videoConstraints(deviceId) };
    const stream = await this.env.getUserMedia(constraints);
    const track = kind === "audio" ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
    for (const other of stream.getTracks()) if (other !== track) other.stop();
    if (!track) throw new Error(`No ${kind} track`);
    return track;
  }

  private async enableLateMicrophone(): Promise<void> {
    const gen = this.gen;
    let track: MediaStreamTrack;
    try {
      track = await this.acquireTrack("audio", this.devices.audioInputId);
    } catch (error) {
      if (gen === this.gen) this.set({ error: mediaErrorMessage("microphone", error) });
      return;
    }
    if (gen !== this.gen || this.mic) {
      track.stop();
      return;
    }
    this.mic = track;
    this.audioOn = true;
    this.set({ audioEnabled: true, error: null });
    this.beat();
    if (this.effects.audio.wanted) await this.syncEffect("audio", gen);
    if (gen === this.gen && this.snap.phase === "connected") {
      await this.publishLate(gen, { kind: "audio", track: this.sentTrack("audio") ?? track });
    }
  }

  private async switchInput(kind: "audio" | "video", gen: number): Promise<void> {
    let track: MediaStreamTrack;
    try {
      track = await this.acquireTrack(kind, kind === "audio" ? this.devices.audioInputId : this.devices.videoInputId);
    } catch (error) {
      if (gen === this.gen) this.set({ error: mediaErrorMessage(kind === "audio" ? "microphone" : "camera", error) });
      return;
    }
    const old = kind === "audio" ? this.mic : this.camera;
    if (gen !== this.gen || !old) {
      track.stop();
      return;
    }
    if (kind === "audio") {
      track.enabled = this.audioOn;
      this.mic = track;
    } else {
      this.camera = track;
    }
    const publication = this.pubs.get(kind);
    if (publication) {
      await publication.transceiver.sender.replaceTrack(track).catch((error: unknown) => {
        this.log("replace-track-failed", { kind, error: describeError(error) });
      });
    }
    old.stop();
    // An effect was built around the old device: rebuild it around the new one.
    if (this.effects[kind].wanted || this.effects[kind].processor !== null) await this.syncEffect(kind, gen);
    if (kind === "video") this.set({ localVideo: this.localVideo() });
  }

  /** A device was unplugged: fall back to the default one for inputs whose track ended. */
  private async recoverEndedInputs(): Promise<void> {
    const gen = this.gen;
    if (this.mic && this.mic.readyState === "ended") {
      this.devices = { ...this.devices, audioInputId: null };
      await this.switchInput("audio", gen);
    }
    if (gen === this.gen && this.camera && this.camera.readyState === "ended") {
      this.devices = { ...this.devices, videoInputId: null };
      await this.switchInput("video", gen);
    }
  }

  /** What this participant should be publishing right now (used by join and by every rebuild). */
  private localPublishItems(): PublishItem[] {
    const items: PublishItem[] = [];
    const mic = this.sentTrack("audio");
    const camera = this.sentTrack("video");
    if (mic) items.push({ kind: "audio", track: mic });
    if (camera) items.push({ kind: "video", track: camera });
    if (this.screen) items.push({ kind: "screen", track: this.screen });
    return items;
  }

  // ---------------------------------------------------------------------------------------------
  // Peer connection

  private createPeerConnection(iceServers: readonly CallIceServer[], gen: number): RTCPeerConnection {
    // The server already removed port-53 URLs; pass the rest through untouched.
    const pc = this.env.createPeerConnection({
      bundlePolicy: "max-bundle",
      iceServers: iceServers.map((server) => ({
        urls: [...server.urls],
        ...(server.username !== undefined ? { username: server.username } : {}),
        ...(server.credential !== undefined ? { credential: server.credential } : {}),
      })),
    });
    this.iceRestartTried = false;
    pc.addEventListener("track", (event) => this.onTrack(pc, gen, event as RTCTrackEvent));
    pc.addEventListener("connectionstatechange", () => this.onConnectionState(pc, gen));
    pc.addEventListener("iceconnectionstatechange", () => {
      if (pc === this.pc && gen === this.gen && pc.iceConnectionState === "failed") void this.rebuild("ice-failed");
    });
    return pc;
  }

  private onConnectionState(pc: RTCPeerConnection, gen: number): void {
    if (pc !== this.pc || gen !== this.gen) return;
    const state = pc.connectionState;
    this.log("connection-state", { state });
    if (state === "connected") {
      this.clearDisconnectTimer();
      return;
    }
    if (this.snap.phase !== "connected") return;
    if (state === "failed" || state === "closed") {
      void this.rebuild(`connection-${state}`);
    } else if (state === "disconnected") {
      if (!this.iceRestartTried) {
        this.iceRestartTried = true;
        try {
          pc.restartIce();
        } catch {
          // Unsupported: the timer below still covers it.
        }
      }
      if (this.disconnectTimer === null) {
        this.disconnectTimer = this.env.setTimeout(() => {
          this.disconnectTimer = null;
          if (pc === this.pc && gen === this.gen && pc.connectionState !== "connected") void this.rebuild("disconnected-timeout");
        }, ENGINE_TIMINGS.disconnectedGraceMs);
      }
    }
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer !== null) this.env.clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  private onTrack(pc: RTCPeerConnection, gen: number, event: RTCTrackEvent): void {
    if (pc !== this.pc || gen !== this.gen) return;
    const transceiver = event.transceiver;
    const mid = transceiver?.mid;
    if (!mid) return;
    const arrival: Arrival = { track: event.track, transceiver };
    const waiter = this.waiters.get(mid);
    if (waiter) {
      this.waiters.delete(mid);
      this.env.clearTimeout(waiter.timer);
      waiter.resolve(arrival);
    } else {
      this.arrivals.set(mid, arrival);
    }
  }

  /** The `track` event for `mid`, whether it already fired or fires within `timeoutMs`. */
  private awaitTrack(mid: string, timeoutMs: number): Promise<Arrival | null> {
    const arrived = this.arrivals.get(mid);
    if (arrived) {
      this.arrivals.delete(mid);
      return Promise.resolve(arrived);
    }
    return new Promise((resolve) => {
      const timer = this.env.setTimeout(() => {
        this.waiters.delete(mid);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(mid, { resolve, timer });
    });
  }

  private assertCurrent(gen: number): void {
    if (gen !== this.gen) throw new Superseded();
  }

  // ---------------------------------------------------------------------------------------------
  // Negotiation (every *Op runs inside a queued task)

  /**
   * Runs a mutation in the queue. Resolves false when it failed. A failure that leaves the session
   * in an unknown state (network, 5xx, WebRTC rejected the SDP, signalling not stable) rebuilds;
   * `tracks/new` is never retried blindly.
   */
  private negotiate(label: string, gen: number, task: () => Promise<void>): Promise<boolean> {
    return this.queue.run(async () => {
      if (gen !== this.gen) return false;
      try {
        await task();
        return true;
      } catch (error) {
        if (error instanceof Superseded || gen !== this.gen) return false;
        this.log(`${label}-failed`, { error: describeError(error) });
        const pc = this.pc;
        if (isSessionFatal(error) || (pc !== null && pc.signalingState !== "stable")) void this.rebuild(label);
        return false;
      }
    });
  }

  private addPublication(pc: RTCPeerConnection, item: PublishItem): LocalPublication {
    if (item.kind === "video") {
      try {
        const transceiver = pc.addTransceiver(item.track, {
          direction: "sendonly",
          sendEncodings: CAMERA_SIMULCAST_ENCODINGS.map((encoding) => ({ ...encoding })),
        });
        // Some browsers accept the init but keep fewer encodings; only a full a/b/c set is simulcast.
        const kept = transceiver.sender.getParameters().encodings?.length ?? CAMERA_SIMULCAST_ENCODINGS.length;
        return { kind: "video", transceiver, simulcast: kept >= CAMERA_SIMULCAST_ENCODINGS.length, name: null };
      } catch (error) {
        this.log("simulcast-rejected", { error: errorName(error) });
        const transceiver = pc.addTransceiver(item.track, {
          direction: "sendonly",
          sendEncodings: CAMERA_SINGLE_ENCODING.map((encoding) => ({ ...encoding })),
        });
        return { kind: "video", transceiver, simulcast: false, name: null };
      }
    }
    const encodings = item.kind === "audio" ? AUDIO_ENCODINGS : SCREEN_ENCODINGS;
    const transceiver = pc.addTransceiver(item.track, {
      direction: "sendonly",
      sendEncodings: encodings.map((encoding) => ({ ...encoding })),
    });
    if (item.kind === "audio") this.preferRed(transceiver);
    return { kind: item.kind, transceiver, simulcast: false, name: null };
  }

  /** New sendonly transceivers in ONE offer -> `publish` -> answer -> bytes flowing -> `announce`. */
  private async publishOp(gen: number, items: readonly PublishItem[]): Promise<void> {
    const pc = this.pc;
    const session = this.session;
    if (!pc || !session) return;
    const added = items.filter((item) => !this.pubs.has(item.kind)).map((item) => this.addPublication(pc, item));
    if (added.length === 0) return;
    for (const publication of added) this.pubs.set(publication.kind, publication);

    const offer = withOpusResilience(await pc.createOffer());
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc, this.env, ENGINE_TIMINGS.iceGatheringCapMs);
    this.assertCurrent(gen);
    const tracks = added.map((publication) => ({
      mid: requireMid(publication.transceiver),
      kind: publication.kind,
      simulcast: publication.simulcast,
    }));
    this.log("publish", { tracks: tracks.map((track) => `${track.kind}:${track.mid}`).join(",") });
    const response = await this.api.publishTracks(session.callId, {
      participantId: session.participantId,
      offer: toDescription(pc.localDescription ?? offer),
      tracks,
    });
    this.assertCurrent(gen);
    await pc.setRemoteDescription(withOpusResilience(response.answer));
    for (const published of response.tracks) {
      const publication = added.find((candidate) => candidate.transceiver.mid === published.mid);
      if (publication) publication.name = published.name;
    }
    for (const publication of added) await this.applySenderPreferences(publication);
    this.assertCurrent(gen);

    const connected = await waitForConnected(pc, this.env, ENGINE_TIMINGS.connectCapMs);
    this.assertCurrent(gen);
    if (!connected) throw new Error("The connection did not come up.");
    const named = added.filter((publication) => publication.name !== null);
    const confirmed = await waitForBytesSent(
      named.map((publication) => publication.transceiver.sender),
      this.env,
      ENGINE_TIMINGS.bytesSentCapMs,
      ENGINE_TIMINGS.bytesSentPollMs,
      () => gen === this.gen,
    );
    this.assertCurrent(gen);
    // After the cap, announce anyway: a puller that hits empty_track_error retries on the next state.
    if (confirmed.size < named.length) this.log("announce-without-bytes", { missing: named.length - confirmed.size });
    const names = named.map((publication) => publication.name as string);
    if (names.length === 0) return;
    const announced = await this.api.announceTracks(session.callId, { participantId: session.participantId, names });
    this.assertCurrent(gen);
    this.log("announced", { count: names.length });
    if (announced.call && announced.call.id === session.callId) {
      this.latest = announced.call;
      this.refreshRemotes();
      this.scheduleReconcile();
    }
  }

  private publishLate(gen: number, item: PublishItem): Promise<boolean> {
    return this.negotiate(`publish-${item.kind}`, gen, () => this.publishOp(gen, [item]));
  }

  private async stopScreen(gen: number): Promise<void> {
    const track = this.screen;
    if (!track) return;
    this.screen = null;
    this.set({ screenEnabled: false, localScreen: null });
    this.beat();
    const publication = this.pubs.get("screen");
    if (publication) {
      this.pubs.delete("screen");
      const mid = publication.transceiver.mid;
      if (mid !== null) await this.negotiate("close-screen", gen, () => this.closeOp(gen, [mid]));
    }
    track.stop();
  }

  /** Coalesces call-state changes: at most one reconcile waits in the queue, and it reads the latest state. */
  private scheduleReconcile(): void {
    if (this.reconcileQueued || !this.session || this.snap.phase !== "connected") return;
    this.reconcileQueued = true;
    const gen = this.gen;
    void this.negotiate("reconcile", gen, async () => {
      this.reconcileQueued = false;
      await this.reconcile(gen);
    });
  }

  private async reconcile(gen: number): Promise<void> {
    const session = this.session;
    if (!session || this.snap.phase !== "connected") return;
    const wanted = new Map<string, WantedTrack>();
    const state = this.latest;
    if (state && state.id === session.callId) {
      for (const participant of state.participants) {
        if (participant.id === session.participantId) continue;
        for (const track of participant.tracks) {
          // A paused camera (hidden tile, audio-only) is not wanted: its pull closes, audio stays.
          if (track.kind === "video" && this.isVideoPaused(participant.id)) continue;
          wanted.set(`${participant.sessionId}/${track.name}`, { participant, track });
        }
      }
    }

    const departed = [...this.pulls.values()].filter((pull) => !wanted.has(pull.key));
    if (departed.length > 0) {
      for (const pull of departed) this.dropPull(pull);
      this.refreshRemotes();
      this.log("close-pulled", { count: departed.length });
      await this.closeOp(gen, departed.map((pull) => pull.mid));
      this.assertCurrent(gen);
    }

    const fresh = [...wanted.entries()].filter(([key]) => !this.pulls.has(key));
    for (let start = 0; start < fresh.length; start += MAX_CALL_TRACKS_PER_REQUEST) {
      await this.pullOp(gen, fresh.slice(start, start + MAX_CALL_TRACKS_PER_REQUEST));
      this.assertCurrent(gen);
    }
  }

  private dropPull(pull: Pull): void {
    this.pulls.delete(pull.key);
    this.layers.forget(pull.key);
    if (pull.kind === "audio") this.reportedLevels.delete(pull.participantId);
    const waiter = this.waiters.get(pull.mid);
    if (waiter) {
      this.waiters.delete(pull.mid);
      this.env.clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.arrivals.delete(pull.mid);
  }

  private async pullOp(gen: number, batch: readonly (readonly [string, WantedTrack])[]): Promise<void> {
    const pc = this.pc;
    const session = this.session;
    if (!pc || !session || batch.length === 0) return;
    const byName = new Map(batch.map(([key, value]) => [`${value.participant.id}/${value.track.name}`, { key, ...value }]));
    const requested = batch.map(([, { participant, track }]) => ({
      participantId: participant.id,
      name: track.name,
      ...(track.kind === "video" && track.simulcast ? { rid: this.wantedRid(participant.id) } : {}),
    }));
    this.log("pull", { count: requested.length });
    const response = await this.api.pullTracks(session.callId, { participantId: session.participantId, tracks: requested });
    this.assertCurrent(gen);

    for (const item of response.tracks) {
      const match = byName.get(`${item.participantId}/${item.name}`);
      if (!match) continue;
      if (item.error || !item.mid) {
        this.log("pull-item-failed", { kind: match.track.kind, error: item.error ?? "no-mid" });
        continue;
      }
      const rid = requested.find((entry) => entry.participantId === item.participantId && entry.name === item.name)?.rid;
      const pull: Pull = {
        key: match.key,
        participantId: match.participant.id,
        userId: match.participant.userId,
        name: match.track.name,
        kind: match.track.kind,
        simulcast: match.track.kind === "video" && match.track.simulcast,
        mid: item.mid,
        rid: rid ?? null,
        track: null,
        transceiver: null,
        counters: { lost: 0, received: 0, decoded: 0, dropped: 0, window: new LossWindow() },
      };
      this.pulls.set(pull.key, pull);
      // Registered before the offer is applied: `track` fires during setRemoteDescription.
      void this.awaitTrack(pull.mid, ENGINE_TIMINGS.pullTrackTimeoutMs).then((arrival) => this.claimPull(gen, pull, arrival));
    }

    if (response.requiresImmediateRenegotiation && response.offer) {
      await pc.setRemoteDescription(withOpusResilience(response.offer));
      const answer = withOpusResilience(await pc.createAnswer());
      await pc.setLocalDescription(answer);
      this.assertCurrent(gen);
      await this.api.renegotiateCall(session.callId, {
        participantId: session.participantId,
        answer: toDescription(pc.localDescription ?? answer),
      });
      this.assertCurrent(gen);
    }
  }

  private claimPull(gen: number, pull: Pull, arrival: Arrival | null): void {
    if (gen !== this.gen || this.pulls.get(pull.key) !== pull) return;
    if (!arrival) {
      // No media for this mid: forget it (the next call state pulls it again) and release the mid.
      this.log("pull-timeout", { kind: pull.kind });
      this.dropPull(pull);
      void this.negotiate("close-timed-out", gen, () => this.closeOp(gen, [pull.mid]));
      return;
    }
    pull.track = arrival.track;
    pull.transceiver = arrival.transceiver;
    if (pull.simulcast) this.layers.want(pull.key, this.wantedRid(pull.participantId));
    this.refreshRemotes();
  }

  /** Negotiated close of our own transceivers (published or pulled). Skipped when not connected. */
  private async closeOp(gen: number, mids: readonly string[]): Promise<void> {
    const pc = this.pc;
    const session = this.session;
    if (!pc || !session || mids.length === 0) return;
    if (pc.connectionState !== "connected") {
      // A rebuild replaces the session, and the server force-closes what the old one held.
      this.log("close-skipped", { count: mids.length, state: pc.connectionState });
      return;
    }
    for (let start = 0; start < mids.length; start += MAX_CALL_TRACKS_PER_REQUEST) {
      const chunk = mids.slice(start, start + MAX_CALL_TRACKS_PER_REQUEST);
      const transceivers = pc.getTransceivers().filter((transceiver) => transceiver.mid !== null && chunk.includes(transceiver.mid));
      if (transceivers.length === 0) {
        await this.api.closeTracks(session.callId, { participantId: session.participantId, mids: chunk });
        this.assertCurrent(gen);
        continue;
      }
      for (const transceiver of transceivers) {
        try {
          transceiver.stop();
        } catch {
          // Already stopped.
        }
      }
      const offer = withOpusResilience(await pc.createOffer());
      await pc.setLocalDescription(offer);
      this.assertCurrent(gen);
      const response = await this.api.closeTracks(session.callId, {
        participantId: session.participantId,
        mids: chunk,
        offer: toDescription(pc.localDescription ?? offer),
      });
      this.assertCurrent(gen);
      if (response.answer) await pc.setRemoteDescription(withOpusResilience(response.answer));
    }
  }

  private async applyLayer(key: string, rid: CallSimulcastRid): Promise<void> {
    const session = this.session;
    if (!this.pulls.has(key) || !session || this.snap.phase !== "connected") return;
    const gen = this.gen;
    await this.negotiate("layer", gen, async () => {
      const pull = this.pulls.get(key);
      if (!pull || pull.rid === rid) return;
      await this.api.setLayer(session.callId, {
        participantId: session.participantId,
        mid: pull.mid,
        trackParticipantId: pull.participantId,
        name: pull.name,
        rid,
      });
      this.assertCurrent(gen);
      pull.rid = rid;
      this.log("layer", { rid });
      this.refreshRemotes();
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Recovery

  private async rebuild(reason: string): Promise<void> {
    const session = this.session;
    if (!session || this.snap.phase !== "connected") return;
    this.log("rebuild", { reason });
    this.telemetry?.countReconnect();
    this.resetConnection();
    const gen = this.gen;
    this.set({ phase: "reconnecting" });
    this.refreshRemotes();

    const now = this.env.now();
    const previous = this.recovery;
    const continuing = previous !== null && now - previous.recoveredAt < ENGINE_TIMINGS.recoveryStableMs;
    const started = continuing ? previous.startedAt : now;
    let delay = continuing ? nextDelay(previous.delay) : 0;
    for (;;) {
      if (delay > 0) {
        if (this.env.now() - started + delay > ENGINE_TIMINGS.reconnectBudgetMs) break;
        await this.sleep(delay);
        if (gen !== this.gen) return;
      }
      try {
        await this.reconnectOnce(gen, session);
        this.recovery = { recoveredAt: this.env.now(), startedAt: started, delay };
        this.log("reconnected", { callId: session.callId });
        this.startSpeakerLoop(gen);
        this.startQualityLoop(gen);
        this.scheduleReconcile();
        return;
      } catch (error) {
        if (error instanceof Superseded || gen !== this.gen) return;
        this.log("reconnect-failed", { error: describeError(error) });
        if (isGone(error)) break;
        this.closePeerConnection();
        this.pubs.clear();
        delay = nextDelay(delay);
      }
    }
    if (gen === this.gen) this.fail("Lost the connection to the call.");
  }

  private async reconnectOnce(gen: number, session: Session): Promise<void> {
    const response = await this.api.reconnectCall(session.callId, { participantId: session.participantId });
    this.assertCurrent(gen);
    session.sessionId = response.sessionId;
    this.latest = response.call;
    this.pc = this.createPeerConnection(response.iceServers, gen);
    await this.queue.run(async () => {
      await this.publishOp(gen, this.localPublishItems());
      this.assertCurrent(gen);
      this.set({ phase: "connected" });
    });
    this.refreshRemotes();
  }

  /** Drops the connection and everything negotiated on it; keeps local media and the session. */
  private resetConnection(): void {
    this.gen += 1;
    this.queue = new SerialQueue();
    this.reconcileQueued = false;
    this.clearDisconnectTimer();
    this.stopSpeakerLoop();
    this.stopQualityLoop();
    this.layers.clear();
    this.closePeerConnection();
    this.pubs.clear();
    for (const pull of [...this.pulls.values()]) this.dropPull(pull);
    for (const waiter of this.waiters.values()) {
      this.env.clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.waiters.clear();
    this.arrivals.clear();
    this.reportedLevels.clear();
    this.speaker.reset();
    this.remoteStreams.clear();
    for (const sleep of this.sleeps) {
      this.env.clearTimeout(sleep.timer);
      sleep.resolve();
    }
    this.sleeps.clear();
  }

  private closePeerConnection(): void {
    const pc = this.pc;
    this.pc = null;
    if (!pc) return;
    try {
      pc.close();
    } catch {
      // Already closed.
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const entry: { timer: unknown; resolve: () => void } = { resolve, timer: null };
      entry.timer = this.env.setTimeout(() => {
        this.sleeps.delete(entry);
        resolve();
      }, ms);
      this.sleeps.add(entry);
    });
  }

  /** Full local teardown: connection, media, timers. No server call. */
  private teardown(): void {
    this.resetConnection();
    this.stopHeartbeat();
    this.unsubscribeDevices?.();
    this.unsubscribeDevices = null;
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
    this.stopTelemetry();
    this.telemetry = null;
    for (const { timer } of this.hiddenTimers.values()) this.env.clearTimeout(timer);
    this.hiddenTimers.clear();
    this.hiddenPaused.clear();
    this.chosenAudioOnly = false;
    this.cameraBeforeAudioOnly = false;
    this.pictureInPicture = false;
    for (const slot of Object.values(this.effects)) {
      slot.processor?.close();
      Object.assign(slot, { wanted: false, source: null, processor: null, starting: null, shedForCpu: false });
    }
    this.remoteQuality.clear();
    this.downlink = new DownlinkAdaptation();
    this.sendAdaptation = new SendAdaptation();
    this.limitedSeconds = null;
    for (const track of [this.mic, this.camera, this.screen, this.black]) track?.stop();
    this.mic = null;
    this.camera = null;
    this.screen = null;
    this.black = null;
    this.audioOn = false;
    this.videoOn = false;
    this.localVideoStream = null;
    this.session = null;
    this.latest = null;
    this.recovery = null;
  }

  private fail(message: string): void {
    const channelId = this.snap.channelId;
    const callId = this.snap.callId;
    this.teardown();
    this.set({ ...IDLE_SNAPSHOT, phase: "failed", channelId, callId, error: message, audioOutputId: this.devices.audioOutputId });
  }

  // ---------------------------------------------------------------------------------------------
  // Heartbeat and speaker loop

  private beat(): void {
    const session = this.session;
    if (!session) return;
    try {
      this.sendEvent({
        t: "call-beat",
        call: session.callId,
        participant: session.participantId,
        audio: this.audioOn && this.mic !== null,
        video: this.videoOn,
        screen: this.screen !== null,
      });
    } catch (error) {
      this.log("beat-failed", { error: errorName(error) });
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const tick = (): void => {
      this.beat();
      this.heartbeatTimer = this.env.setTimeout(tick, CALL_HEARTBEAT_MS);
    };
    tick();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) this.env.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private startSpeakerLoop(gen: number): void {
    this.stopSpeakerLoop();
    const tick = async (): Promise<void> => {
      this.speakerTimer = null;
      try {
        await this.sampleLevels(gen);
      } catch (error) {
        this.log("levels-failed", { error: errorName(error) });
      }
      if (gen === this.gen && this.speakerTimer === null) {
        this.speakerTimer = this.env.setTimeout(() => void tick(), ENGINE_TIMINGS.speakerSampleMs);
      }
    };
    this.speakerTimer = this.env.setTimeout(() => void tick(), ENGINE_TIMINGS.speakerSampleMs);
  }

  private stopSpeakerLoop(): void {
    if (this.speakerTimer !== null) this.env.clearTimeout(this.speakerTimer);
    this.speakerTimer = null;
  }

  private async sampleLevels(gen: number): Promise<void> {
    const session = this.session;
    if (!session) return;
    const raw = new Map<string, number>();
    for (const pull of this.pulls.values()) {
      if (pull.kind !== "audio" || !pull.transceiver) continue;
      raw.set(pull.participantId, (await inboundAudioLevel(pull.transceiver.receiver).catch(() => null)) ?? 0);
    }
    const micPublication = this.pubs.get("audio");
    const localLevel = micPublication
      ? ((await mediaSourceAudioLevel(micPublication.transceiver.sender).catch(() => null)) ?? 0)
      : 0;
    if (gen !== this.gen) return;
    // A muted participant cannot be the active speaker, but still sees their own level.
    if (this.audioOn) raw.set(session.participantId, localLevel);
    const { levels, active } = this.speaker.update(this.env.now(), raw);

    let remotesChanged = false;
    for (const [participantId, level] of levels) {
      if (participantId === session.participantId) continue;
      if (levelMoved(this.reportedLevels.get(participantId) ?? 0, level)) {
        this.reportedLevels.set(participantId, quantise(level));
        remotesChanged = true;
      }
    }
    if (remotesChanged) this.refreshRemotes();
    const local = levels.get(session.participantId) ?? localLevel;
    this.set({
      activeSpeaker: active,
      ...(levelMoved(this.snap.localAudioLevel, local) ? { localAudioLevel: quantise(local) } : {}),
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Quality phase 1: capture, sender preferences, adaptation, pausing and telemetry

  private supportedConstraints(): MediaTrackSupportedConstraints {
    try {
      return this.env.supportedConstraints?.() ?? detectSupportedConstraints();
    } catch {
      return {};
    }
  }

  /** RED first, then Opus, on the mic transceiver before the offer. The SFU may still answer Opus only. */
  private preferRed(transceiver: RTCRtpTransceiver): void {
    let codecs: RTCRtpCodec[] | null = null;
    try {
      codecs = redFirst(this.env.senderCapabilities?.("audio")?.codecs ?? []);
    } catch {
      codecs = null;
    }
    if (!codecs || typeof transceiver.setCodecPreferences !== "function") return;
    try {
      transceiver.setCodecPreferences(codecs);
      this.log("audio-red-preferred");
    } catch (error) {
      this.log("codec-preferences-failed", { error: errorName(error) });
    }
  }

  /** Degradation preference (and the screen's frame cap) once the transceiver is negotiated. */
  private async applySenderPreferences(publication: LocalPublication): Promise<void> {
    if (publication.kind === "audio") return;
    const sender = publication.transceiver.sender;
    try {
      const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
      params.degradationPreference = DEGRADATION_PREFERENCE[publication.kind];
      if (publication.kind === "screen") for (const encoding of params.encodings ?? []) encoding.maxFramerate = SCREEN_MAX_FRAMERATE;
      await sender.setParameters(params);
    } catch (error) {
      // Older browsers reject degradationPreference; the defaults are acceptable.
      this.log("sender-preferences-failed", { kind: publication.kind, error: errorName(error) });
    }
    if (publication.kind === "video") {
      // A fresh camera publication sends every layer again.
      this.sendAdaptation = new SendAdaptation();
      this.limitedSeconds = null;
      this.set({ sendLayers: activeLayers(sender.getParameters().encodings ?? [], publication.simulcast) });
    }
  }

  /** The layer a remote camera should be pulled at: by tile size, or `c` while the downlink is poor. */
  private wantedRid(participantId: ParticipantId): CallSimulcastRid {
    return this.downlink.mode === "normal" ? ridForTile(this.tileSizes[participantId]) : LOWEST_RID;
  }

  private requestLayers(): void {
    for (const pull of this.pulls.values()) {
      if (pull.kind === "video" && pull.simulcast && pull.track) this.layers.want(pull.key, this.wantedRid(pull.participantId));
    }
  }

  private isVideoPaused(participantId: ParticipantId): boolean {
    return this.chosenAudioOnly || this.downlink.mode === "audio-only" || this.hiddenPaused.has(participantId);
  }

  // ---------------------------------------------------------------------------------------------
  // Quality phase 2 effects

  async setNoiseSuppression(enabled: boolean): Promise<void> {
    await this.setEffect("audio", enabled);
  }

  async setBackgroundBlur(enabled: boolean): Promise<void> {
    await this.setEffect("video", enabled);
  }

  private async setEffect(kind: CallTrackKindAv, enabled: boolean): Promise<void> {
    if (!this.session) return;
    const slot = this.effects[kind];
    if (enabled && !this.effectSupported(kind)) {
      this.setEffectState(kind, "unsupported");
      return;
    }
    slot.wanted = enabled;
    slot.shedForCpu = false;
    this.log("effect", { kind, enabled });
    await this.syncEffect(kind, this.gen);
  }

  private effectSupported(kind: CallTrackKindAv): boolean {
    try {
      return (kind === "audio" ? this.env.supportsNoiseSuppression?.() : this.env.supportsBackgroundBlur?.()) === true;
    } catch {
      return false;
    }
  }

  private setEffectState(kind: CallTrackKindAv, state: EffectState): void {
    this.set(kind === "audio" ? { noiseSuppression: state } : { backgroundBlur: state });
  }

  /** The raw capture an effect wraps now: the microphone, or the camera while it is on. */
  private rawTrack(kind: CallTrackKindAv): MediaStreamTrack | null {
    return kind === "audio" ? this.mic : this.videoOn ? this.camera : null;
  }

  /** What the sender for `kind` carries: the processed track when an effect is built for this raw one. */
  private sentTrack(kind: CallTrackKindAv): MediaStreamTrack | null {
    const slot = this.effects[kind];
    const raw = this.rawTrack(kind);
    return slot.processor !== null && raw !== null && slot.source === raw ? slot.processor.track : raw;
  }

  /** Makes the sender match what is wanted. One build per kind at a time; later calls wait their turn. */
  private async syncEffect(kind: CallTrackKindAv, gen: number): Promise<void> {
    const slot = this.effects[kind];
    while (slot.starting !== null) await slot.starting;
    const run = this.syncEffectNow(kind, gen);
    slot.starting = run;
    try {
      await run;
    } finally {
      if (slot.starting === run) slot.starting = null;
    }
  }

  private async syncEffectNow(kind: CallTrackKindAv, gen: number): Promise<void> {
    if (gen !== this.gen) return;
    const slot = this.effects[kind];
    const raw = this.rawTrack(kind);
    if (slot.processor !== null && (!slot.wanted || slot.source !== raw)) {
      const stale = slot.processor;
      slot.processor = null;
      slot.source = null;
      // The raw track goes back on the sender before the processed one stops: no gap in what is sent.
      if (raw !== null) await this.replaceSent(kind, raw);
      stale.close();
      if (kind === "video") this.set({ localVideo: this.localVideo() });
    }
    if (!slot.wanted) {
      this.setEffectState(kind, !this.effectSupported(kind) ? "unsupported" : slot.shedForCpu ? "cpu" : "off");
      return;
    }
    // Wanted, and either built already or with nothing to process yet (camera off): it is on.
    if (slot.processor !== null || raw === null) {
      this.setEffectState(kind, "on");
      return;
    }
    this.setEffectState(kind, "starting");
    let processor: TrackProcessor | null = null;
    try {
      processor =
        (await (kind === "audio" ? this.env.createNoiseSuppressor?.(raw) : this.env.createBackgroundBlur?.(raw))) ?? null;
    } catch (error) {
      this.log("effect-failed", { kind, error: errorName(error) });
    }
    // Superseded while it loaded (left, switched device, switched off): whoever changed it syncs again.
    if (gen !== this.gen || raw !== this.rawTrack(kind) || !slot.wanted) {
      processor?.close();
      return;
    }
    if (processor === null) {
      slot.wanted = false;
      this.setEffectState(kind, "failed");
      return;
    }
    slot.processor = processor;
    slot.source = raw;
    await this.replaceSent(kind, processor.track);
    this.setEffectState(kind, "on");
    if (kind === "video") this.set({ localVideo: this.localVideo() });
  }

  private async replaceSent(kind: CallTrackKindAv, track: MediaStreamTrack): Promise<void> {
    const publication = this.pubs.get(kind);
    if (!publication) return;
    await publication.transceiver.sender.replaceTrack(track).catch((error: unknown) => {
      this.log("replace-track-failed", { kind, error: describeError(error) });
    });
  }

  /** Sustained CPU strain: turns off the costliest effect that is on. True when there was one. */
  private shedEffect(): boolean {
    for (const kind of ["video", "audio"] as const) {
      const slot = this.effects[kind];
      if (!slot.wanted) continue;
      slot.wanted = false;
      slot.shedForCpu = true;
      this.log("effect-shed", { kind });
      void this.syncEffect(kind, this.gen);
      return true;
    }
    return false;
  }

  setPictureInPicture(open: boolean): void {
    if (this.pictureInPicture === open) return;
    this.pictureInPicture = open;
    this.log("picture-in-picture", { open });
    this.refreshVisibility();
  }

  async setAudioOnly(enabled: boolean): Promise<void> {
    if (!this.session || this.chosenAudioOnly === enabled) return;
    this.chosenAudioOnly = enabled;
    this.log("audio-only", { chosen: enabled });
    this.set({ audioOnlyChosen: enabled });
    // Entering closes every camera pull; leaving re-pulls them at the layers the tiles want.
    this.refreshRemotes();
    this.scheduleReconcile();
    if (enabled) {
      this.cameraBeforeAudioOnly = this.videoOn;
      if (this.videoOn) await this.setVideoEnabled(false);
      return;
    }
    this.requestLayers();
    const restore = this.cameraBeforeAudioOnly;
    this.cameraBeforeAudioOnly = false;
    if (restore && !this.videoOn) await this.setVideoEnabled(true);
  }

  /**
   * Starts the pause timer for every remote whose tile is `hidden` (or when the whole document is),
   * and resumes, at once, every paused remote that is visible again.
   */
  private refreshVisibility(): void {
    const session = this.session;
    if (!session) return;
    let documentHidden = false;
    try {
      documentHidden = !this.pictureInPicture && (this.env.isDocumentHidden?.() ?? false);
    } catch {
      documentHidden = false;
    }
    const present = new Set<ParticipantId>();
    let resumed = false;
    for (const participant of this.latest?.participants ?? []) {
      if (participant.id === session.participantId) continue;
      present.add(participant.id);
      const hidden = documentHidden || this.tileSizes[participant.id] === "hidden";
      if (hidden) {
        if (this.hiddenPaused.has(participant.id) || this.hiddenTimers.has(participant.id)) continue;
        const timer = this.env.setTimeout(() => this.pauseHidden(), ENGINE_TIMINGS.hiddenPauseMs);
        this.hiddenTimers.set(participant.id, { since: this.env.now(), timer });
      } else {
        this.clearHiddenTimer(participant.id);
        if (this.hiddenPaused.delete(participant.id)) resumed = true;
      }
    }
    for (const id of [...this.hiddenTimers.keys()]) if (!present.has(id)) this.clearHiddenTimer(id);
    for (const id of [...this.hiddenPaused]) if (!present.has(id)) this.hiddenPaused.delete(id);
    if (resumed) {
      this.log("video-resumed", { reason: "shown" });
      this.refreshRemotes();
      this.scheduleReconcile();
    }
  }

  /** Pauses every remote hidden for long enough, in one reconcile (a hidden tab pauses them all). */
  private pauseHidden(): void {
    if (!this.session) return;
    const now = this.env.now();
    let count = 0;
    for (const [id, { since }] of [...this.hiddenTimers]) {
      if (now - since < ENGINE_TIMINGS.hiddenPauseMs) continue;
      this.clearHiddenTimer(id);
      this.hiddenPaused.add(id);
      count += 1;
    }
    if (count === 0) return;
    this.log("video-paused", { reason: "hidden", count });
    this.refreshRemotes();
    this.scheduleReconcile();
  }

  private clearHiddenTimer(participantId: ParticipantId): void {
    const entry = this.hiddenTimers.get(participantId);
    if (entry === undefined) return;
    this.env.clearTimeout(entry.timer);
    this.hiddenTimers.delete(participantId);
  }

  private startQualityLoop(gen: number): void {
    this.stopQualityLoop();
    const tick = async (): Promise<void> => {
      this.qualityTimer = null;
      try {
        await this.sampleQuality(gen);
      } catch (error) {
        this.log("quality-failed", { error: errorName(error) });
      }
      if (gen === this.gen && this.qualityTimer === null) {
        this.qualityTimer = this.env.setTimeout(() => void tick(), ENGINE_TIMINGS.qualitySampleMs);
      }
    };
    this.qualityTimer = this.env.setTimeout(() => void tick(), ENGINE_TIMINGS.qualitySampleMs);
  }

  private stopQualityLoop(): void {
    if (this.qualityTimer !== null) this.env.clearTimeout(this.qualityTimer);
    this.qualityTimer = null;
    this.lastQualityAt = null;
  }

  /** One stats round: send-side CPU adaptation, per-remote quality, downlink mode, telemetry. */
  private async sampleQuality(gen: number): Promise<void> {
    const pc = this.pc;
    const session = this.session;
    if (!pc || !session || this.snap.phase !== "connected") return;
    const camera = this.pubs.get("video") ?? null;
    const mic = this.pubs.get("audio") ?? null;
    const cameraOut = camera ? await readStats(camera.transceiver.sender, readOutbound) : null;
    const micOut = mic ? await readStats(mic.transceiver.sender, readOutbound) : null;
    const inbound: { pull: Pull; sample: InboundSample }[] = [];
    for (const pull of [...this.pulls.values()]) {
      if (!pull.transceiver) continue;
      const sample = await readStats(pull.transceiver.receiver, readInbound);
      if (sample) inbound.push({ pull, sample });
    }
    const transport = await readStats(pc, readTransport);
    if (gen !== this.gen || pc !== this.pc) return;
    const now = this.env.now();
    const elapsed = this.lastQualityAt === null ? ENGINE_TIMINGS.qualitySampleMs : Math.max(0, now - this.lastQualityAt);
    this.lastQualityAt = now;

    // Send side: CPU sheds simulcast layers (or resolution), none restores them.
    let limitation: QualityLimitation = this.snap.limitation ?? "none";
    let sendLayers = this.snap.sendLayers;
    const reason = cameraOut?.limitation ?? null;
    if (camera && reason !== null) {
      const action = this.sendAdaptation.sample(now, reason);
      limitation = this.sendAdaptation.limitation;
      // Effects are the first thing to go: a blur costs more than any simulcast layer.
      if (action === "shed" && this.shedEffect()) {
        // This round's shed was the effect.
      } else if (action) {
        const layers = await this.stepSendLayers(camera, action);
        if (gen !== this.gen) return;
        if (layers !== null) sendLayers = layers;
      }
    }

    // Receive side: per-remote quality, and the aggregate downlink.
    const perParticipant = new Map<ParticipantId, ConnectionQuality[]>();
    let lost = 0;
    let received = 0;
    let decoded = 0;
    let dropped = 0;
    let jitter: number | null = null;
    let inboundAudioMime: string | null = null;
    let inboundVideoMime: string | null = null;
    for (const { pull, sample } of inbound) {
      const counters = pull.counters;
      lost += Math.max(0, sample.packetsLost - counters.lost);
      received += Math.max(0, sample.packetsReceived - counters.received);
      decoded += Math.max(0, sample.framesDecoded - counters.decoded);
      dropped += Math.max(0, sample.framesDropped - counters.dropped);
      counters.lost = sample.packetsLost;
      counters.received = sample.packetsReceived;
      counters.decoded = sample.framesDecoded;
      counters.dropped = sample.framesDropped;
      if (sample.jitterMs !== null) jitter = Math.max(jitter ?? 0, sample.jitterMs);
      if (pull.kind === "audio") inboundAudioMime ??= sample.mimeType;
      else inboundVideoMime ??= sample.mimeType;
      const quality = classifyReceive({
        lossPercent: counters.window.push(sample.packetsLost, sample.packetsReceived),
        jitterMs: sample.jitterMs,
        framesPerSecond: sample.framesPerSecond,
        // Frame rate only means something for a live camera (not the 1 fps placeholder, not a screen).
        expectedFps: pull.kind === "video" && this.cameraOn(pull.participantId) ? expectedFramerate(pull.rid) : null,
      });
      const list = perParticipant.get(pull.participantId) ?? [];
      list.push(quality);
      perParticipant.set(pull.participantId, list);
    }
    let remotesChanged = false;
    for (const participant of this.latest?.participants ?? []) {
      if (participant.id === session.participantId) continue;
      const quality = worstQuality(perParticipant.get(participant.id) ?? []);
      if ((this.remoteQuality.get(participant.id) ?? "unknown") !== quality) remotesChanged = true;
      this.remoteQuality.set(participant.id, quality);
    }
    const aggregateLoss = lost + received > 0 ? (lost * 100) / (lost + received) : null;
    const before = this.downlink.mode;
    const after = this.downlink.sample(now, downlinkVerdict(aggregateLoss, transport?.availableIncomingBitrate ?? null));
    if (after !== before) {
      this.onDownlinkMode(before, after, now);
      remotesChanged = true;
    }

    // Our uplink.
    const rttMs = cameraOut?.rttMs ?? micOut?.rttMs ?? transport?.rttMs ?? null;
    const sendLoss = maxOf(cameraOut?.lossPercent ?? null, micOut?.lossPercent ?? null);
    const localQuality = classifyUplink({ rttMs, lossPercent: sendLoss, limitation });

    this.telemetry?.record({
      rttMs,
      sendLossPercent: sendLoss,
      receivedPackets: received,
      lostPackets: lost,
      jitterMs: jitter,
      framesDecoded: decoded,
      framesDropped: dropped,
      limitedMs: this.limitedDelta(cameraOut, reason, elapsed),
      relayed: transport?.relayed ?? null,
      audioMimeType: micOut?.mimeType ?? inboundAudioMime,
      videoMimeType: cameraOut?.mimeType ?? inboundVideoMime,
    });

    if (remotesChanged) this.refreshRemotes();
    this.set({ localQuality, limitation, sendLayers, audioOnly: this.downlink.mode === "audio-only" });
  }

  private cameraOn(participantId: ParticipantId): boolean {
    return this.latest?.participants.find((participant) => participant.id === participantId)?.video === true;
  }

  /** Milliseconds the camera spent CPU/bandwidth-limited since the last sample. */
  private limitedDelta(
    out: OutboundSample | null,
    reason: QualityLimitation | null,
    elapsed: number,
  ): { cpu: number; bandwidth: number } {
    if (out?.limitedSeconds) {
      const previous = this.limitedSeconds ?? { cpu: 0, bandwidth: 0 };
      const current = out.limitedSeconds;
      this.limitedSeconds = { ...current };
      // Counters restart with a new publication: count the new value then.
      const delta = (now: number, then: number): number => (now >= then ? now - then : now) * 1000;
      return { cpu: delta(current.cpu, previous.cpu), bandwidth: delta(current.bandwidth, previous.bandwidth) };
    }
    return { cpu: reason === "cpu" ? elapsed : 0, bandwidth: reason === "bandwidth" ? elapsed : 0 };
  }

  /** One shed/restore step on the camera's encodings; the new layer count, or null if unchanged. */
  private async stepSendLayers(publication: LocalPublication, action: SendAction): Promise<number | null> {
    const sender = publication.transceiver.sender;
    try {
      const params = sender.getParameters();
      const encodings = params.encodings ?? [];
      if (!stepSendEncodings(encodings, publication.simulcast, action)) return null;
      await sender.setParameters(params);
      const layers = activeLayers(encodings, publication.simulcast);
      this.log("send-layers", {
        action,
        layers,
        ...(publication.simulcast ? {} : { scale: encodings[0]?.scaleResolutionDownBy ?? 1 }),
      });
      return layers;
    } catch (error) {
      this.log("send-layers-failed", { action, error: errorName(error) });
      return null;
    }
  }

  private onDownlinkMode(before: DownlinkMode, after: DownlinkMode, now: number): void {
    this.log("downlink", { mode: after });
    this.telemetry?.setAudioOnly(after === "audio-only", now);
    // Entering audio-only closes camera pulls; leaving it re-pulls them (at c: the mode steps to low).
    if ((before === "audio-only") !== (after === "audio-only")) this.scheduleReconcile();
    this.requestLayers();
  }

  private startTelemetry(): void {
    this.stopTelemetry();
    const tick = (): void => {
      this.telemetryTimer = this.env.setTimeout(tick, ENGINE_TIMINGS.statsIntervalMs);
      const session = this.session;
      const report = this.takeStatsReport(false);
      if (session && report) void this.postStats(session.callId, report);
    };
    this.telemetryTimer = this.env.setTimeout(tick, ENGINE_TIMINGS.statsIntervalMs);
  }

  private stopTelemetry(): void {
    if (this.telemetryTimer !== null) this.env.clearTimeout(this.telemetryTimer);
    this.telemetryTimer = null;
  }

  /** The report for the interval so far, or null when there is none or the per-minute cap is reached. */
  private takeStatsReport(final: boolean): CallStatsReport | null {
    const session = this.session;
    const telemetry = this.telemetry;
    if (!session || !telemetry) return null;
    const now = this.env.now();
    this.statsSentAt = this.statsSentAt.filter((at) => now - at < 60_000);
    if (this.statsSentAt.length >= MAX_CALL_STATS_PER_MINUTE) {
      this.log("stats-capped", { final });
      return null;
    }
    this.statsSentAt.push(now);
    return telemetry.report(session.participantId, now, final);
  }

  /** Best effort: a failed report is logged and forgotten. */
  private async postStats(callId: string, report: CallStatsReport): Promise<void> {
    try {
      await this.api.postCallStats(callId, report);
    } catch (error) {
      this.log("stats-failed", { error: describeError(error) });
    }
  }

  private log(event: string, fields?: Readonly<Record<string, unknown>>): void {
    try {
      this.logSink?.(`call.${event}`, fields);
    } catch {
      // Diagnostics never break the call.
    }
  }
}

// -----------------------------------------------------------------------------------------------
// Helpers

/** One `getStats()` read; null when the object is gone or the browser refuses. */
async function readStats<T>(source: { getStats(): Promise<RTCStatsReport> }, parse: (report: RTCStatsReport) => T): Promise<T | null> {
  try {
    return parse(await source.getStats());
  } catch {
    return null;
  }
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function nextDelay(delay: number): number {
  return delay === 0 ? ENGINE_TIMINGS.reconnectFirstDelayMs : Math.min(delay * 2, ENGINE_TIMINGS.reconnectMaxDelayMs);
}

/** Every description the engine sets gets Opus FEC + DTX (see sdp.ts for why remote ones too). */
function withOpusResilience<T extends RTCSessionDescriptionInit>(description: T): T {
  return description.sdp ? { ...description, sdp: ensureOpusParams(description.sdp) } : description;
}

function toDescription(description: RTCSessionDescriptionInit | RTCSessionDescription): SessionDescription {
  return { type: description.type === "answer" ? "answer" : "offer", sdp: description.sdp ?? "" };
}

function requireMid(transceiver: RTCRtpTransceiver): string {
  if (transceiver.mid === null) throw new Error("A transceiver has no mid after setLocalDescription.");
  return transceiver.mid;
}

function sameRemote(a: RemoteMedia, b: RemoteMedia): boolean {
  return (
    a.userId === b.userId &&
    a.audio === b.audio &&
    a.video === b.video &&
    a.screen === b.screen &&
    a.audioLevel === b.audioLevel &&
    a.videoRid === b.videoRid &&
    a.quality === b.quality &&
    a.videoPaused === b.videoPaused
  );
}

/** A level change worth a new snapshot: past the epsilon, or settling to silence. */
function levelMoved(previous: number, next: number): boolean {
  if (Math.abs(next - previous) > LEVEL_EPSILON) return true;
  return next < 0.01 && previous !== 0;
}

function quantise(level: number): number {
  return level < 0.01 ? 0 : Math.round(level * 100) / 100;
}

function apiStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function apiCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** Network errors, server errors and anything WebRTC itself threw leave the session unknown. */
function isSessionFatal(error: unknown): boolean {
  const status = apiStatus(error);
  return status === null || status === 0 || status >= 500;
}

/** The call or our participant no longer exists: reconnecting cannot help. */
function isGone(error: unknown): boolean {
  const code = apiCode(error);
  return apiStatus(error) !== null && (code === "not_found" || code === "forbidden" || code === "unauthenticated");
}

function errorName(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : "Error";
}

function describeError(error: unknown): string {
  const code = apiCode(error);
  const status = apiStatus(error);
  if (code !== null || status !== null) return `${code ?? "error"}${status !== null ? `/${status}` : ""}`;
  return errorName(error);
}

function joinErrorMessage(error: unknown): string {
  switch (apiCode(error)) {
    case "conflict":
      return "The call is full.";
    case "forbidden":
      return "You can't join this call.";
    case "not_found":
      return "This conversation no longer exists.";
    case "unavailable":
    case "not_implemented":
      return "Calls are not available right now.";
    default:
      return "Could not join the call.";
  }
}

function mediaErrorMessage(device: "camera" | "microphone", error: unknown): string {
  const name = errorName(error);
  const label = device === "camera" ? "Camera" : "Microphone";
  if (name === "NotAllowedError") return `${label} access is blocked.`;
  if (name === "NotFoundError" || name === "OverconstrainedError") return `No ${device} found.`;
  if (name === "NotReadableError") return `${label} is in use by another app.`;
  return `${label} is unavailable.`;
}
