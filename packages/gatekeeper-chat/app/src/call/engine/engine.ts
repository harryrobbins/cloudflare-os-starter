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
  MAX_CALL_TRACKS_PER_REQUEST,
  type CallIceServer,
  type CallParticipant,
  type CallSimulcastRid,
  type CallState,
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
  DISPLAY_MEDIA_OPTIONS,
  SCREEN_ENCODINGS,
  audioConstraints,
  ridForTile,
  videoConstraints,
} from "./media.js";
import { waitForBytesSent, waitForConnected, waitForIceGathering } from "./peer.js";
import { SerialQueue, Superseded } from "./queue.js";
import { SpeakerDetector } from "./speaker.js";
import { inboundAudioLevel, mediaSourceAudioLevel } from "./stats.js";
import type {
  CallEngine,
  CallEngineDeps,
  CallSnapshot,
  CreateCallEngine,
  DeviceChoice,
  JoinOptions,
  RemoteMedia,
  TileSize,
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
});

const NO_DEVICES: DeviceChoice = { audioInputId: null, videoInputId: null, audioOutputId: null };

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
    });

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
    this.refreshRemotes();
    this.startSpeakerLoop(gen);
    this.scheduleReconcile();
  }

  async leave(): Promise<void> {
    const session = this.session;
    const wasActive = this.snap.phase !== "idle";
    this.teardown();
    if (wasActive) this.set({ ...IDLE_SNAPSHOT, audioOutputId: this.devices.audioOutputId });
    if (session) {
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
    if (publication) {
      await publication.transceiver.sender.replaceTrack(track).catch((error: unknown) => {
        this.log("replace-track-failed", { kind: "video", error: describeError(error) });
      });
    } else if (this.snap.phase === "connected") {
      // Joined with the camera off: publish it now. While reconnecting, the rebuild publishes it.
      const ok = await this.publishLate(gen, { kind: "video", track });
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
    for (const pull of this.pulls.values()) {
      if (pull.kind === "video" && pull.simulcast && pull.track) {
        this.layers.want(pull.key, ridForTile(this.tileSizes[pull.participantId]));
      }
    }
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

  private localVideo(): MediaStream | null {
    if (!this.camera || !this.videoOn) {
      this.localVideoStream = null;
      return null;
    }
    if (this.localVideoStream?.getVideoTracks()[0] !== this.camera) this.localVideoStream = new MediaStream([this.camera]);
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
          audio: audioConstraints(this.devices.audioInputId),
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
      kind === "audio" ? { audio: audioConstraints(deviceId) } : { video: videoConstraints(deviceId) };
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
    if (this.snap.phase === "connected") await this.publishLate(gen, { kind: "audio", track });
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
    if (this.mic) items.push({ kind: "audio", track: this.mic });
    if (this.camera && this.videoOn) items.push({ kind: "video", track: this.camera });
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

    const offer = await pc.createOffer();
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
    await pc.setRemoteDescription(response.answer);
    for (const published of response.tracks) {
      const publication = added.find((candidate) => candidate.transceiver.mid === published.mid);
      if (publication) publication.name = published.name;
    }

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
        for (const track of participant.tracks) wanted.set(`${participant.sessionId}/${track.name}`, { participant, track });
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
      ...(track.kind === "video" && track.simulcast ? { rid: ridForTile(this.tileSizes[participant.id]) } : {}),
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
      };
      this.pulls.set(pull.key, pull);
      // Registered before the offer is applied: `track` fires during setRemoteDescription.
      void this.awaitTrack(pull.mid, ENGINE_TIMINGS.pullTrackTimeoutMs).then((arrival) => this.claimPull(gen, pull, arrival));
    }

    if (response.requiresImmediateRenegotiation && response.offer) {
      await pc.setRemoteDescription(response.offer);
      const answer = await pc.createAnswer();
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
    if (pull.simulcast) this.layers.want(pull.key, ridForTile(this.tileSizes[pull.participantId]));
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
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.assertCurrent(gen);
      const response = await this.api.closeTracks(session.callId, {
        participantId: session.participantId,
        mids: chunk,
        offer: toDescription(pc.localDescription ?? offer),
      });
      this.assertCurrent(gen);
      if (response.answer) await pc.setRemoteDescription(response.answer);
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

function nextDelay(delay: number): number {
  return delay === 0 ? ENGINE_TIMINGS.reconnectFirstDelayMs : Math.min(delay * 2, ENGINE_TIMINGS.reconnectMaxDelayMs);
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
    a.videoRid === b.videoRid
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
