// A CallEngine with no SFU, for mock builds and screenshot runs.
//
// It speaks the same chat API as the real engine (`joinCall`, `leaveCall`, `call-beat` over the
// socket), so the mock transport keeps the room -- who is in the call, their flags, the system
// message -- and the store, the rail and the history behave exactly as they will against the Worker.
// Only the media is fake: every remote participant's camera is the local camera looped back, or a
// moving canvas test pattern when there is no camera (a headless browser, a denied prompt). The
// active speaker walks round whoever has their microphone on, so the ring has something to do.

import { CALL_HEARTBEAT_MS, type CallState, type ParticipantId } from "../contract.js";
import type {
  CallEngine,
  CallSignalling,
  CallSnapshot,
  DeviceChoice,
  JoinOptions,
  RemoteMedia,
  SendClientEvent,
  TileSize,
} from "./engine/types.js";

/** Where the fake gets real media from. Injected so the unit tests need no browser. */
export interface MockMedia {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  getDisplayMedia?(options: DisplayMediaStreamOptions): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  /** A moving test pattern for one participant, or null where canvas capture is unsupported. */
  testPattern(seed: string): MediaStream | null;
}

export interface MockEngineDeps {
  readonly api: Pick<CallSignalling, "joinCall" | "leaveCall">;
  readonly send: SendClientEvent;
  readonly media?: MockMedia;
  /** How often the fake active speaker moves. */
  readonly speakerIntervalMs?: number;
}

const IDLE: CallSnapshot = {
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
  remotes: {},
  activeSpeaker: null,
  error: null,
};

export function createMockCallEngine(deps: MockEngineDeps): CallEngine {
  const media = deps.media ?? browserMedia();
  const listeners = new Set<() => void>();
  let snapshot: CallSnapshot = IDLE;
  let devices: DeviceChoice = { audioInputId: null, videoInputId: null, audioOutputId: null };
  let camera: MediaStream | null = null;
  let microphone: MediaStream | null = null;
  let screen: MediaStream | null = null;
  /** Whether `camera` is a real device (looped back to the remotes) or a pattern. */
  let realCamera = false;
  const patterns = new Map<ParticipantId, MediaStream>();
  let beat: ReturnType<typeof setInterval> | null = null;
  let speaker: ReturnType<typeof setInterval> | null = null;
  let room: CallState | null = null;
  let sizes: Readonly<Record<ParticipantId, TileSize>> = {};

  function set(patch: Partial<CallSnapshot>): void {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }

  function sendBeat(): void {
    if (snapshot.callId === null || snapshot.participantId === null) return;
    deps.send({
      t: "call-beat",
      call: snapshot.callId,
      participant: snapshot.participantId,
      audio: snapshot.audioEnabled,
      video: snapshot.videoEnabled,
      screen: snapshot.screenEnabled,
    });
  }

  async function openCamera(): Promise<MediaStream | null> {
    try {
      const stream = await media.getUserMedia({
        video: devices.videoInputId === null ? true : { deviceId: { exact: devices.videoInputId } },
      });
      realCamera = true;
      return stream;
    } catch {
      realCamera = false;
      return media.testPattern("self");
    }
  }

  async function openMicrophone(): Promise<MediaStream | null> {
    try {
      return await media.getUserMedia({
        audio: devices.audioInputId === null ? true : { deviceId: { exact: devices.audioInputId } },
      });
    } catch {
      // No microphone in the fake is not an error: the tiles still work, just in silence.
      return null;
    }
  }

  function remoteVideoFor(participantId: ParticipantId, seed: string): MediaStream | null {
    if (realCamera && camera !== null) {
      const existing = patterns.get(participantId);
      if (existing !== undefined) return existing;
      const clone = new MediaStream(camera.getVideoTracks().map((track) => track.clone()));
      patterns.set(participantId, clone);
      return clone;
    }
    const existing = patterns.get(participantId);
    if (existing !== undefined) return existing;
    const pattern = media.testPattern(seed);
    if (pattern !== null) patterns.set(participantId, pattern);
    return pattern;
  }

  function ridFor(participantId: ParticipantId): RemoteMedia["videoRid"] {
    const size = sizes[participantId];
    return size === "large" ? "a" : size === "medium" || size === undefined ? "b" : "c";
  }

  function syncRemotes(): void {
    if (room === null) {
      set({ remotes: {}, activeSpeaker: null });
      return;
    }
    const remotes: Record<ParticipantId, RemoteMedia> = {};
    for (const participant of room.participants) {
      if (participant.id === snapshot.participantId) continue;
      const previous = snapshot.remotes[participant.id];
      remotes[participant.id] = {
        participantId: participant.id,
        userId: participant.userId,
        video: participant.video ? remoteVideoFor(participant.id, participant.userId) : null,
        // The screen share is the same pattern under another seed, so it is visibly a different feed.
        screen: participant.screen ? remoteVideoFor(`${participant.id}:screen`, `${participant.userId}:screen`) : null,
        audio: null,
        audioLevel: previous?.audioLevel ?? 0,
        videoRid: ridFor(participant.id),
      };
    }
    for (const [id, stream] of patterns) {
      const owner = id.split(":")[0]!;
      const remote = remotes[owner];
      const unused =
        remote === undefined || (id.endsWith(":screen") ? remote.screen === null : remote.video === null);
      if (unused) {
        for (const track of stream.getTracks()) track.stop();
        patterns.delete(id);
      }
    }
    const activeSpeaker =
      snapshot.activeSpeaker !== null && remotes[snapshot.activeSpeaker] !== undefined ? snapshot.activeSpeaker : null;
    set({ remotes, activeSpeaker });
  }

  function moveSpeaker(): void {
    const talkers = (room?.participants ?? []).filter(
      (participant) => participant.audio && participant.id !== snapshot.participantId,
    );
    if (talkers.length === 0) {
      if (snapshot.activeSpeaker !== null) set({ activeSpeaker: null });
      return;
    }
    const index = talkers.findIndex((participant) => participant.id === snapshot.activeSpeaker);
    const next = talkers[(index + 1) % talkers.length]!;
    const remotes: Record<ParticipantId, RemoteMedia> = {};
    for (const [id, remote] of Object.entries(snapshot.remotes)) {
      remotes[id] = { ...remote, audioLevel: id === next.id ? 0.7 : 0.05 };
    }
    set({ activeSpeaker: next.id, remotes });
  }

  function stopAll(): void {
    if (beat !== null) clearInterval(beat);
    if (speaker !== null) clearInterval(speaker);
    beat = null;
    speaker = null;
    for (const stream of [camera, microphone, screen, ...patterns.values()]) {
      for (const track of stream?.getTracks() ?? []) track.stop();
    }
    camera = null;
    microphone = null;
    screen = null;
    patterns.clear();
    room = null;
  }

  const engine: CallEngine = {
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async join(options: JoinOptions): Promise<void> {
      stopAll();
      devices = options.devices;
      set({ ...IDLE, phase: "joining", channelId: options.channelId });
      [camera, microphone] = await Promise.all([
        options.video ? openCamera() : Promise.resolve(null),
        options.audio ? openMicrophone() : Promise.resolve(null),
      ]);
      try {
        const joined = await deps.api.joinCall(options.channelId);
        room = joined.call;
        set({
          phase: "connected",
          callId: joined.call.id,
          participantId: joined.participantId,
          localVideo: camera,
          audioEnabled: microphone !== null,
          videoEnabled: camera !== null,
          error: null,
        });
        syncRemotes();
        sendBeat();
        beat = setInterval(sendBeat, CALL_HEARTBEAT_MS);
        speaker = setInterval(moveSpeaker, deps.speakerIntervalMs ?? 2600);
      } catch (cause) {
        stopAll();
        set({ ...IDLE, phase: "failed", channelId: options.channelId, error: cause instanceof Error ? cause.message : "Could not join." });
        throw cause;
      }
    },

    async leave(): Promise<void> {
      const { callId, participantId } = snapshot;
      stopAll();
      set(IDLE);
      if (callId !== null && participantId !== null) {
        try {
          await deps.api.leaveCall(callId, { participantId });
        } catch {
          // The server expires a participant that stops beating; leaving is best effort.
        }
      }
    },

    applyCallState(state: CallState | null): void {
      if (snapshot.phase !== "connected" && snapshot.phase !== "reconnecting") return;
      if (state === null || state.id !== snapshot.callId) {
        // The call ended under us (or a different one started): nothing left to show.
        stopAll();
        set(IDLE);
        return;
      }
      room = state;
      syncRemotes();
    },

    handleMoved(callId: string, participantId: ParticipantId): void {
      if (snapshot.callId !== callId || snapshot.participantId !== participantId) return;
      const channelId = snapshot.channelId;
      stopAll();
      set({ ...IDLE, phase: "moved", channelId, callId });
    },

    setAudioEnabled(enabled: boolean): void {
      if (enabled && microphone === null) {
        void openMicrophone().then((stream) => {
          microphone = stream;
          set({ audioEnabled: stream !== null });
          sendBeat();
        });
        return;
      }
      for (const track of microphone?.getAudioTracks() ?? []) track.enabled = enabled;
      set({ audioEnabled: enabled });
      sendBeat();
    },

    async setVideoEnabled(enabled: boolean): Promise<void> {
      if (enabled === snapshot.videoEnabled) return;
      if (enabled) {
        camera = await openCamera();
      } else {
        for (const track of camera?.getTracks() ?? []) track.stop();
        camera = null;
      }
      set({ videoEnabled: camera !== null, localVideo: camera });
      sendBeat();
    },

    async setScreenEnabled(enabled: boolean): Promise<boolean> {
      if (!enabled) {
        for (const track of screen?.getTracks() ?? []) track.stop();
        screen = null;
        set({ screenEnabled: false, localScreen: null });
        sendBeat();
        return true;
      }
      if (media.getDisplayMedia === undefined) return false;
      try {
        screen = await media.getDisplayMedia({ video: true, audio: false });
      } catch {
        return false;
      }
      for (const track of screen.getVideoTracks()) {
        track.addEventListener("ended", () => void engine.setScreenEnabled(false));
      }
      set({ screenEnabled: true, localScreen: screen });
      sendBeat();
      return true;
    },

    async setDevices(choice: Partial<DeviceChoice>): Promise<void> {
      const cameraChanged = choice.videoInputId !== undefined && choice.videoInputId !== devices.videoInputId;
      devices = { ...devices, ...choice };
      if (cameraChanged && snapshot.videoEnabled) {
        for (const track of camera?.getTracks() ?? []) track.stop();
        camera = await openCamera();
        set({ localVideo: camera });
      }
    },

    async listDevices() {
      let all: MediaDeviceInfo[] = [];
      try {
        all = await media.enumerateDevices();
      } catch {
        all = [];
      }
      return {
        audioInputs: all.filter((device) => device.kind === "audioinput"),
        videoInputs: all.filter((device) => device.kind === "videoinput"),
        audioOutputs: all.filter((device) => device.kind === "audiooutput"),
      };
    },

    setTileSizes(next) {
      sizes = next;
      if (room !== null) syncRemotes();
    },

    dispose(): void {
      stopAll();
      set(IDLE);
    },
  };
  return engine;
}

/** The fake's media from the real browser, where it has any. */
function browserMedia(): MockMedia {
  const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  return {
    getUserMedia: (constraints) =>
      devices?.getUserMedia === undefined
        ? Promise.reject(new DOMException("No media devices.", "NotFoundError"))
        : devices.getUserMedia(constraints),
    ...(devices?.getDisplayMedia === undefined
      ? {}
      : { getDisplayMedia: (options: DisplayMediaStreamOptions) => devices.getDisplayMedia(options) }),
    enumerateDevices: () => devices?.enumerateDevices?.() ?? Promise.resolve([]),
    testPattern,
  };
}

/**
 * A 640x360 moving test pattern: a gradient in a colour derived from the seed and a sweeping bar, so
 * a tile is visibly live (and each participant visibly different) in a screenshot.
 */
function testPattern(seed: string): MediaStream | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  if (typeof canvas.captureStream !== "function") return null;
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d");
  if (context === null) return null;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const screen = seed.endsWith(":screen");
  let frame = 0;
  const draw = (): void => {
    frame += 1;
    const gradient = context.createLinearGradient(0, 0, 640, 360);
    gradient.addColorStop(0, `hsl(${hue} 55% ${screen ? 90 : 45}%)`);
    gradient.addColorStop(1, `hsl(${(hue + 50) % 360} 60% ${screen ? 80 : 28}%)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, 640, 360);
    if (screen) {
      // A "document": a few grey lines, which is what a shared screen mostly is.
      context.fillStyle = "rgba(0,0,0,0.18)";
      for (let line = 0; line < 9; line++) context.fillRect(60, 50 + line * 30, 380 + ((line * 53) % 140), 12);
    } else {
      context.fillStyle = "rgba(255,255,255,0.18)";
      context.beginPath();
      context.arc(320 + Math.sin(frame / 20) * 160, 180 + Math.cos(frame / 27) * 60, 70, 0, Math.PI * 2);
      context.fill();
    }
    context.fillStyle = "rgba(255,255,255,0.35)";
    context.fillRect(((frame * 4) % 700) - 30, 0, 12, 360);
  };
  draw();
  const timer = setInterval(draw, 1000 / 15);
  const stream = canvas.captureStream(15);
  for (const track of stream.getTracks()) {
    const stop = track.stop.bind(track);
    track.stop = () => {
      clearInterval(timer);
      stop();
    };
  }
  return stream;
}
