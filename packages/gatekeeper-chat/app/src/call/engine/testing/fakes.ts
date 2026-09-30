// A fake WebRTC world for the engine's unit tests: tracks, streams, a recording RTCPeerConnection,
// a CallEnvironment on vitest's fake timers, and a scriptable fake of the chat call API that plays
// the SFU's part (answers publishes, offers pulled tracks, hands out mids).
//
// The fake SFU offer is JSON (`{"remote":[{"mid","kind"}]}`) so the fake connection knows which
// receiving transceivers to create and which `track` events to fire. Nothing here is real SDP.

import { vi } from "vitest";

import type {
  CallParticipant,
  CallState,
  CallTrack,
  CallTrackKind,
  JoinCallResponse,
  PullTracksRequest,
  PullTracksResponse,
  SessionDescription,
} from "../../../contract.js";
import { ApiError } from "../../../api/types.js";
import type { CallEnvironment, CallSignalling, TrackProcessor } from "../types.js";

let trackCounter = 0;

export class FakeTrack extends EventTarget {
  readonly id: string;
  enabled = true;
  readyState: MediaStreamTrackState = "live";
  contentHint = "";
  stopped = false;

  constructor(
    readonly kind: "audio" | "video",
    readonly label: string = kind,
  ) {
    super();
    trackCounter += 1;
    this.id = `track-${trackCounter}`;
  }

  stop(): void {
    this.stopped = true;
    this.readyState = "ended";
  }

  /** What the browser does when the user presses its own "Stop sharing" or unplugs a device. */
  end(): void {
    this.stop();
    this.dispatchEvent(new Event("ended"));
  }

  getSettings(): MediaTrackSettings {
    return {};
  }
}

export class FakeMediaStream {
  readonly id: string;
  private readonly tracks: FakeTrack[];

  constructor(tracks: readonly unknown[] = []) {
    trackCounter += 1;
    this.id = `stream-${trackCounter}`;
    this.tracks = [...(tracks as FakeTrack[])];
  }

  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((track) => track.kind === "video");
  }
}

/** Installs FakeMediaStream as the global `MediaStream` (jsdom has none). Call from a `beforeEach`. */
export function installFakeMediaStream(): void {
  vi.stubGlobal("MediaStream", FakeMediaStream);
}

function statsReport(entries: readonly Record<string, unknown>[]): RTCStatsReport {
  return new Map(entries.map((entry, index) => [String(entry.id ?? index), entry])) as unknown as RTCStatsReport;
}

/** What a fake sender's `getStats()` reports beyond bytesSent/audioLevel. Unset fields are omitted. */
export interface FakeOutboundStats {
  qualityLimitationReason?: "none" | "cpu" | "bandwidth" | "other";
  /** Seconds, cumulative. */
  qualityLimitationDurations?: { none?: number; cpu?: number; bandwidth?: number; other?: number };
  /** remote-inbound-rtp, seconds. */
  roundTripTime?: number;
  /** remote-inbound-rtp, 0..1. */
  fractionLost?: number;
  mimeType?: string;
}

export class FakeSender {
  readonly replaced: (FakeTrack | null)[] = [];
  readonly setParametersCalls: RTCRtpSendParameters[] = [];
  bytesSent = 0;
  audioLevel = 0;
  stats: FakeOutboundStats = {};
  degradationPreference: string | undefined;
  /** Make setParameters reject (older browsers, unsupported fields). */
  rejectSetParameters = false;

  constructor(
    public track: FakeTrack | null,
    readonly encodings: RTCRtpEncodingParameters[],
  ) {}

  async replaceTrack(track: FakeTrack | null): Promise<void> {
    this.replaced.push(track);
    this.track = track;
  }

  /** A copy, like the browser's: changes only apply through setParameters. */
  getParameters(): RTCRtpSendParameters {
    return {
      transactionId: "t",
      encodings: this.encodings.map((encoding) => ({ ...encoding })),
      ...(this.degradationPreference !== undefined ? { degradationPreference: this.degradationPreference } : {}),
    } as unknown as RTCRtpSendParameters;
  }

  async setParameters(params: RTCRtpSendParameters): Promise<void> {
    const copy = JSON.parse(JSON.stringify(params)) as RTCRtpSendParameters & { degradationPreference?: string };
    this.setParametersCalls.push(copy);
    if (this.rejectSetParameters) throw new DOMException("unsupported", "InvalidModificationError");
    this.encodings.splice(0, this.encodings.length, ...copy.encodings.map((encoding) => ({ ...encoding })));
    if (copy.degradationPreference !== undefined) this.degradationPreference = copy.degradationPreference;
  }

  /** Sender getStats() reads, so a test can assert the engine does not read per sender. */
  getStatsCalls = 0;

  async getStats(): Promise<RTCStatsReport> {
    this.getStatsCalls += 1;
    return statsReport(this.statsEntries("", null));
  }

  /**
   * The entries this sender contributes to a report: its own (ids unprefixed) or the connection's
   * (ids prefixed, tagged with the transceiver's `mid`, as a browser's `pc.getStats()` does).
   */
  statsEntries(prefix: string, mid: string | null): Record<string, unknown>[] {
    const entries: Record<string, unknown>[] = [];
    const count = Math.max(1, this.encodings.length);
    const stats = this.stats;
    const source = this.track ? { mediaSourceId: `${prefix}src` } : {};
    for (let index = 0; index < count; index += 1) {
      entries.push({
        id: `${prefix}out-${index}`,
        type: "outbound-rtp",
        kind: this.track?.kind ?? "video",
        bytesSent: index === 0 ? this.bytesSent : 0,
        ...(mid !== null ? { mid } : {}),
        ...source,
        ...(this.encodings[index]?.rid ? { rid: this.encodings[index]!.rid } : {}),
        ...(stats.qualityLimitationReason !== undefined ? { qualityLimitationReason: stats.qualityLimitationReason } : {}),
        ...(stats.qualityLimitationDurations !== undefined ? { qualityLimitationDurations: { ...stats.qualityLimitationDurations } } : {}),
        ...(stats.mimeType !== undefined ? { codecId: `${prefix}codec-out` } : {}),
      });
    }
    if (stats.mimeType !== undefined) entries.push({ id: `${prefix}codec-out`, type: "codec", mimeType: stats.mimeType, payloadType: 111 });
    if (stats.roundTripTime !== undefined || stats.fractionLost !== undefined) {
      entries.push({
        id: `${prefix}remote-in`,
        type: "remote-inbound-rtp",
        localId: `${prefix}out-0`,
        ...(stats.roundTripTime !== undefined ? { roundTripTime: stats.roundTripTime } : {}),
        ...(stats.fractionLost !== undefined ? { fractionLost: stats.fractionLost } : {}),
      });
    }
    if (this.track) {
      entries.push({
        id: `${prefix}src`,
        type: "media-source",
        kind: this.track.kind,
        trackIdentifier: this.track.id,
        ...(this.track.kind === "audio" ? { audioLevel: this.audioLevel } : {}),
      });
    }
    return entries;
  }
}

/** Cumulative inbound-rtp counters a fake receiver reports. Unset fields are omitted. */
export interface FakeInboundStats {
  packetsLost?: number;
  packetsReceived?: number;
  /** Seconds. */
  jitter?: number;
  framesPerSecond?: number;
  framesDecoded?: number;
  framesDropped?: number;
  mimeType?: string;
}

export class FakeReceiver {
  audioLevel = 0;
  stats: FakeInboundStats = {};
  constructor(readonly track: FakeTrack) {}

  /** Advances the cumulative counters: `packets` more arrived of which `lostPercent` were lost. */
  flow(packets: number, lostPercent = 0, extra: Partial<FakeInboundStats> = {}): void {
    const lost = Math.round((packets * lostPercent) / 100);
    this.stats = {
      ...this.stats,
      ...extra,
      packetsLost: (this.stats.packetsLost ?? 0) + lost,
      packetsReceived: (this.stats.packetsReceived ?? 0) + packets - lost,
    };
  }

  /** Receiver getStats() reads, so a test can assert the engine does not read per receiver. */
  getStatsCalls = 0;

  async getStats(): Promise<RTCStatsReport> {
    this.getStatsCalls += 1;
    return statsReport(this.statsEntries("", null));
  }

  /** As {@link FakeSender.statsEntries}: `inbound-rtp` (with `trackIdentifier`) and its codec. */
  statsEntries(prefix: string, mid: string | null): Record<string, unknown>[] {
    const { mimeType, ...counters } = this.stats;
    const entries: Record<string, unknown>[] = [
      {
        id: `${prefix}in`,
        type: "inbound-rtp",
        kind: this.track.kind,
        trackIdentifier: this.track.id,
        ...(mid !== null ? { mid } : {}),
        audioLevel: this.audioLevel,
        ...counters,
        ...(mimeType !== undefined ? { codecId: `${prefix}codec-in` } : {}),
      },
    ];
    if (mimeType !== undefined) entries.push({ id: `${prefix}codec-in`, type: "codec", mimeType });
    return entries;
  }

  /**
   * False models a peer without the `ssrc-audio-level` header extension (Cloudflare's SFU): the
   * synchronization sources carry no level, and only `inbound-rtp.audioLevel` has it.
   */
  ssrcLevels = true;

  /** The latest packet's level, as `RTCRtpReceiver.getSynchronizationSources()` reports it. */
  getSynchronizationSources(): RTCRtpSynchronizationSource[] {
    if (!this.ssrcLevels) return [{ source: 1, timestamp: 0, rtpTimestamp: 0 } as RTCRtpSynchronizationSource];
    return [{ source: 1, timestamp: 0, rtpTimestamp: 0, audioLevel: this.audioLevel }];
  }
}

export class FakeTransceiver {
  mid: string | null = null;
  stopped = false;
  currentDirection: RTCRtpTransceiverDirection | null = null;
  codecPreferences: RTCRtpCodec[] | null = null;

  constructor(
    public direction: RTCRtpTransceiverDirection,
    readonly sender: FakeSender,
    readonly receiver: FakeReceiver,
    readonly init: RTCRtpTransceiverInit | undefined,
  ) {}

  stop(): void {
    this.stopped = true;
    this.direction = "stopped";
  }

  setCodecPreferences(codecs: RTCRtpCodec[]): void {
    this.codecPreferences = [...codecs];
  }
}

export interface FakePeerOptions {
  /** Throw from addTransceiver when more than one sendEncoding is asked for. */
  rejectSimulcast?: boolean;
  /** Become `connected` right after the first answer is applied. Default true. */
  autoConnect?: boolean;
  /** bytesSent the senders report once connected. Default 1000. */
  bytesSentWhenConnected?: number;
  /** Fire `track` events for SFU-offered mids. Default true. */
  fireOntrack?: boolean;
  /** SDP createOffer returns instead of the `client-offer-N` placeholder. */
  offerSdp?: string;
  /** Every sender's setParameters rejects. */
  rejectSetParameters?: boolean;
}

export class FakePeerConnection extends EventTarget {
  readonly transceivers: FakeTransceiver[] = [];
  readonly descriptions: { side: "local" | "remote"; type: string; sdp: string }[] = [];
  readonly offersCreated: number[] = [];
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGathererState = "complete";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  restartIceCalls = 0;
  closed = false;
  /** The selected candidate pair `getStats()` reports. Null: no pair yet. */
  transport: { relayed: boolean; availableIncomingBitrate?: number; currentRoundTripTime?: number } | null = { relayed: false };
  private nextMid = 0;
  private offerCount = 0;

  constructor(
    readonly config: RTCConfiguration,
    readonly options: FakePeerOptions = {},
  ) {
    super();
  }

  addTransceiver(trackOrKind: FakeTrack | string, init?: RTCRtpTransceiverInit): FakeTransceiver {
    const encodings = init?.sendEncodings ?? [];
    if (this.options.rejectSimulcast && encodings.length > 1) {
      throw new DOMException("simulcast unsupported", "OperationError");
    }
    const track = typeof trackOrKind === "string" ? null : trackOrKind;
    const transceiver = new FakeTransceiver(
      init?.direction ?? "sendrecv",
      new FakeSender(track, encodings.map((encoding) => ({ ...encoding }))),
      new FakeReceiver(new FakeTrack(track?.kind ?? "audio", "receiver")),
      init,
    );
    transceiver.sender.rejectSetParameters = this.options.rejectSetParameters ?? false;
    this.transceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers(): FakeTransceiver[] {
    return [...this.transceivers];
  }

  senders(): FakeSender[] {
    return this.transceivers.filter((transceiver) => transceiver.direction === "sendonly").map((transceiver) => transceiver.sender);
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.offerCount += 1;
    this.offersCreated.push(this.transceivers.length);
    return { type: "offer", sdp: this.options.offerSdp ?? `client-offer-${this.offerCount}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "client-answer" };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.descriptions.push({ side: "local", type: description.type ?? "", sdp: description.sdp ?? "" });
    this.localDescription = description;
    if (description.type === "offer") {
      for (const transceiver of this.transceivers) if (transceiver.mid === null && !transceiver.stopped) transceiver.mid = String(this.nextMid++);
      this.signalingState = "have-local-offer";
    } else {
      this.signalingState = "stable";
    }
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.descriptions.push({ side: "remote", type: description.type ?? "", sdp: description.sdp ?? "" });
    if (description.type === "answer") {
      this.signalingState = "stable";
      if ((this.options.autoConnect ?? true) && this.connectionState === "new") {
        queueMicrotask(() => this.setConnectionState("connected"));
      } else if (this.connectionState === "connected") {
        this.primeSenders();
      }
      return;
    }
    this.signalingState = "have-remote-offer";
    const parsed = JSON.parse(description.sdp ?? "{}") as { remote?: { mid: string; kind: "audio" | "video" }[] };
    for (const remote of parsed.remote ?? []) {
      const track = new FakeTrack(remote.kind, `remote-${remote.mid}`);
      const transceiver = new FakeTransceiver("recvonly", new FakeSender(null, []), new FakeReceiver(track), undefined);
      transceiver.mid = remote.mid;
      this.transceivers.push(transceiver);
      if (this.options.fireOntrack ?? true) this.fireTrack(transceiver);
    }
  }

  fireTrack(transceiver: FakeTransceiver): void {
    const event = new Event("track");
    Object.assign(event, { track: transceiver.receiver.track, transceiver, streams: [] });
    this.dispatchEvent(event);
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    if (state === "connected") this.primeSenders();
    this.dispatchEvent(new Event("connectionstatechange"));
  }

  /** Media starts flowing on every sender once the transport is up. */
  primeSenders(): void {
    for (const sender of this.senders()) if (sender.bytesSent === 0) sender.bytesSent = this.options.bytesSentWhenConnected ?? 1000;
  }

  restartIce(): void {
    this.restartIceCalls += 1;
  }

  /**
   * Connection-wide stats, as a browser reports them: every sending transceiver's outbound entries,
   * every receiving one's inbound entries (each tagged with its mid), and the transport with the
   * selected pair and its local candidate.
   */
  async getStats(): Promise<RTCStatsReport> {
    const media = this.transceivers.flatMap((transceiver, index) => {
      if (transceiver.stopped || transceiver.mid === null) return [];
      const prefix = `t${index}-`;
      return transceiver.direction === "recvonly"
        ? transceiver.receiver.statsEntries(prefix, transceiver.mid)
        : transceiver.sender.statsEntries(prefix, transceiver.mid);
    });
    return statsReport([...media, ...this.transportEntries()]);
  }

  private transportEntries(): Record<string, unknown>[] {
    const transport = this.transport;
    if (!transport) return [];
    return [
      { id: "T01", type: "transport", selectedCandidatePairId: "CP1" },
      {
        id: "CP1",
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        localCandidateId: "L1",
        remoteCandidateId: "R1",
        ...(transport.availableIncomingBitrate !== undefined ? { availableIncomingBitrate: transport.availableIncomingBitrate } : {}),
        ...(transport.currentRoundTripTime !== undefined ? { currentRoundTripTime: transport.currentRoundTripTime } : {}),
      },
      { id: "L1", type: "local-candidate", candidateType: transport.relayed ? "relay" : "host", address: "192.0.2.10", port: 50000 },
      { id: "R1", type: "remote-candidate", candidateType: "host", address: "198.51.100.7", port: 3478 },
    ];
  }

  close(): void {
    this.closed = true;
    this.signalingState = "closed";
    this.connectionState = "closed";
  }
}

export interface FakeEnvOptions {
  noCamera?: boolean;
  noMicrophone?: boolean;
  /** getDisplayMedia rejects with this DOMException name. */
  displayError?: string;
  peer?: FakePeerOptions;
  /** What `getSupportedConstraints()` reports. Default: no voiceIsolation. */
  supported?: MediaTrackSupportedConstraints;
  /** What `RTCRtpSender.getCapabilities("audio")` reports. Default: null (unsupported). */
  audioCapabilities?: RTCRtpCapabilities | null;
  /** Quality phase 2: which effects the fake supports. Default: neither. */
  effects?: { noise?: boolean; blur?: boolean };
  /** An effect factory rejects with this instead of building. */
  effectError?: string;
}

/** A built effect: its processed track, the raw track it wraps, and whether it was closed. */
export interface FakeEffect {
  readonly kind: "noise" | "blur";
  readonly source: FakeTrack;
  readonly track: FakeTrack;
  closed: boolean;
}

export class FakeEnvironment implements CallEnvironment {
  readonly pcs: FakePeerConnection[] = [];
  readonly tracks: FakeTrack[] = [];
  readonly blackTracks: FakeTrack[] = [];
  readonly gumCalls: MediaStreamConstraints[] = [];
  readonly deviceListeners = new Set<() => void>();
  readonly visibilityListeners = new Set<() => void>();
  documentHidden = false;
  readonly effects: FakeEffect[] = [];

  constructor(public options: FakeEnvOptions = {}) {}

  supportsNoiseSuppression(): boolean {
    return this.options.effects?.noise === true;
  }

  supportsBackgroundBlur(): boolean {
    return this.options.effects?.blur === true;
  }

  async createNoiseSuppressor(microphone: MediaStreamTrack): Promise<TrackProcessor | null> {
    return this.buildEffect("noise", microphone);
  }

  async createBackgroundBlur(camera: MediaStreamTrack): Promise<TrackProcessor | null> {
    return this.buildEffect("blur", camera);
  }

  private async buildEffect(kind: "noise" | "blur", source: MediaStreamTrack): Promise<TrackProcessor | null> {
    await Promise.resolve();
    if (this.options.effectError !== undefined) throw new Error(this.options.effectError);
    const raw = source as unknown as FakeTrack;
    const effect: FakeEffect = { kind, source: raw, track: new FakeTrack(raw.kind, `${kind}(${raw.label})`), closed: false };
    this.effects.push(effect);
    return {
      track: effect.track as unknown as MediaStreamTrack,
      close() {
        effect.closed = true;
        effect.track.stop();
      },
    };
  }

  supportedConstraints(): MediaTrackSupportedConstraints {
    return this.options.supported ?? { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  }

  senderCapabilities(kind: "audio" | "video"): RTCRtpCapabilities | null {
    return kind === "audio" ? (this.options.audioCapabilities ?? null) : null;
  }

  isDocumentHidden(): boolean {
    return this.documentHidden;
  }

  onVisibilityChange(listener: () => void): () => void {
    this.visibilityListeners.add(listener);
    return () => this.visibilityListeners.delete(listener);
  }

  /** What the browser does on `visibilitychange`. */
  setDocumentHidden(hidden: boolean): void {
    this.documentHidden = hidden;
    for (const listener of [...this.visibilityListeners]) listener();
  }

  get pc(): FakePeerConnection {
    const pc = this.pcs.at(-1);
    if (!pc) throw new Error("no peer connection yet");
    return pc;
  }

  createPeerConnection(config: RTCConfiguration): RTCPeerConnection {
    const pc = new FakePeerConnection(config, this.options.peer);
    this.pcs.push(pc);
    return pc as unknown as RTCPeerConnection;
  }

  async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    this.gumCalls.push(constraints);
    const tracks: FakeTrack[] = [];
    if (constraints.audio) {
      if (this.options.noMicrophone) throw new DOMException("no mic", "NotFoundError");
      tracks.push(this.track("audio", "mic"));
    }
    if (constraints.video) {
      if (this.options.noCamera) {
        for (const track of tracks) track.stop();
        throw new DOMException("no camera", "NotFoundError");
      }
      tracks.push(this.track("video", "camera"));
    }
    return new FakeMediaStream(tracks) as unknown as MediaStream;
  }

  async getDisplayMedia(): Promise<MediaStream> {
    if (this.options.displayError) throw new DOMException("cancelled", this.options.displayError);
    return new FakeMediaStream([this.track("video", "screen")]) as unknown as MediaStream;
  }

  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return [
      { kind: "audioinput", deviceId: "mic-1", label: "Mic", groupId: "g" },
      { kind: "videoinput", deviceId: "cam-1", label: "Cam", groupId: "g" },
      { kind: "audiooutput", deviceId: "spk-1", label: "Speaker", groupId: "g" },
    ] as MediaDeviceInfo[];
  }

  onDeviceChange(listener: () => void): () => void {
    this.deviceListeners.add(listener);
    return () => this.deviceListeners.delete(listener);
  }

  createBlackVideoTrack(): MediaStreamTrack {
    const track = this.track("video", "black");
    this.blackTracks.push(track);
    return track as unknown as MediaStreamTrack;
  }

  now(): number {
    return Date.now();
  }
  setTimeout(fn: () => void, ms: number): unknown {
    return globalThis.setTimeout(fn, ms);
  }
  clearTimeout(handle: unknown): void {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  }

  private track(kind: "audio" | "video", label: string): FakeTrack {
    const track = new FakeTrack(kind, label);
    this.tracks.push(track);
    return track;
  }
}

// ---------------------------------------------------------------------------------------------
// Fake signalling

export const CALL_ID = "call-1";
export const CHANNEL_ID = "ch-1";
export const SELF = "p-self";

export function participant(id: string, kinds: readonly CallTrackKind[] = [], sessionId = `s-${id}`): CallParticipant {
  const tracks: CallTrack[] = kinds.map((kind) => ({ name: `${id}-${kind}`, kind, simulcast: kind === "video" }));
  return {
    id,
    userId: `u-${id}`,
    sessionId,
    joinedAt: 1,
    audio: kinds.includes("audio"),
    video: kinds.includes("video"),
    screen: kinds.includes("screen"),
    tracks,
  } as CallParticipant;
}

export function callState(participants: readonly CallParticipant[]): CallState {
  return {
    id: CALL_ID,
    channelId: CHANNEL_ID,
    startedBy: "u-self",
    startedAt: 1,
    messageId: "m-1",
    participants: [participant(SELF), ...participants],
  } as CallState;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function networkError(): ApiError {
  return new ApiError("internal", "network", 0);
}

type Method = keyof CallSignalling;

/**
 * Records every call in order (`log`) and answers like the chat Worker + SFU would. Any method can
 * be overridden per test with `override(name, impl)`; `gate(name)` makes the next call wait on a
 * deferred the test resolves.
 */
export class FakeSignalling {
  readonly log: { method: Method; request: unknown }[] = [];
  private nextPulledMid = 100;
  private session = 0;
  private readonly overrides = new Map<Method, (...args: unknown[]) => Promise<unknown>>();
  private readonly gates = new Map<Method, Deferred<void>[]>();
  state: CallState = callState([]);

  readonly api: CallSignalling;

  constructor() {
    const self = this;
    const handler = <M extends Method>(
      method: M,
      impl: (...args: Parameters<CallSignalling[M]>) => ReturnType<CallSignalling[M]>,
    ): CallSignalling[M] =>
      (async (...args: Parameters<CallSignalling[M]>) => {
        self.log.push({ method, request: args[1] ?? args[0] });
        const gate = self.gates.get(method)?.shift();
        if (gate) await gate.promise;
        const override = self.overrides.get(method);
        if (override) return override(...args);
        return impl(...args);
      }) as unknown as CallSignalling[M];
    this.api = {
      joinCall: handler("joinCall", async () => this.joinResponse()),
      reconnectCall: handler("reconnectCall", async () => this.joinResponse()),
      publishTracks: handler("publishTracks", async (_callId, request) => ({
        answer: { type: "answer", sdp: "sfu-answer" } as SessionDescription,
        tracks: request.tracks.map((track) => ({ mid: track.mid, name: `${SELF}-${track.kind}`, kind: track.kind })),
      })),
      announceTracks: handler("announceTracks", async () => ({ call: this.state })),
      pullTracks: handler("pullTracks", async (_callId, request) => this.pullResponse(request)),
      renegotiateCall: handler("renegotiateCall", async () => ({ ok: true }) as never),
      closeTracks: handler("closeTracks", async (_callId, request) =>
        request.offer ? { answer: { type: "answer", sdp: "sfu-close-answer" } as SessionDescription } : {},
      ),
      setLayer: handler("setLayer", async () => ({ ok: true }) as never),
      leaveCall: handler("leaveCall", async () => ({ ok: true }) as never),
      postCallStats: handler("postCallStats", async () => ({ ok: true }) as never),
    };
  }

  override<M extends Method>(method: M, impl: (...args: Parameters<CallSignalling[M]>) => ReturnType<CallSignalling[M]>): void {
    this.overrides.set(method, impl as unknown as (...args: unknown[]) => Promise<unknown>);
  }

  clearOverride(method: Method): void {
    this.overrides.delete(method);
  }

  gate(method: Method): Deferred<void> {
    const gate = deferred<void>();
    const list = this.gates.get(method) ?? [];
    list.push(gate);
    this.gates.set(method, list);
    return gate;
  }

  calls(method: Method): unknown[] {
    return this.log.filter((entry) => entry.method === method).map((entry) => entry.request);
  }

  methods(): Method[] {
    return this.log.map((entry) => entry.method);
  }

  pullResponse(request: PullTracksRequest): PullTracksResponse {
    const tracks = request.tracks.map((track) => ({
      participantId: track.participantId,
      name: track.name,
      mid: String(this.nextPulledMid++),
    }));
    const remote = tracks.map((track, index) => ({
      mid: track.mid,
      kind: request.tracks[index]!.name.endsWith("-audio") ? "audio" : "video",
    }));
    return {
      requiresImmediateRenegotiation: true,
      offer: { type: "offer", sdp: JSON.stringify({ remote }) },
      tracks,
    };
  }

  private joinResponse(): JoinCallResponse {
    this.session += 1;
    return {
      call: this.state,
      participantId: SELF,
      sessionId: `s-self-${this.session}`,
      iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }, { urls: ["turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" }],
    };
  }
}
