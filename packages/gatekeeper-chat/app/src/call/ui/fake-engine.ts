// A scriptable CallEngine for the store and component tests: it records what it was asked to do and
// lets a test set the snapshot directly, so nothing here depends on the real engine or on WebRTC.

import type { CallState, ParticipantId } from "../../contract.js";
import { IDLE_CALL } from "../../store/calls.js";
import type { CallEngine, CallSnapshot, DeviceChoice, JoinOptions, LeaveOptions, TileSize } from "../engine/types.js";

export interface FakeCallEngine extends CallEngine {
  readonly joins: JoinOptions[];
  readonly applied: (CallState | null)[];
  readonly moved: [string, ParticipantId][];
  readonly tileSizes: Readonly<Record<ParticipantId, TileSize>>[];
  readonly audio: boolean[];
  readonly video: boolean[];
  readonly audioOnly: boolean[];
  readonly pictureInPicture: boolean[];
  readonly effects: [string, boolean][];
  readonly devices: Partial<DeviceChoice>[];
  left: number;
  /** The options of every `leave`, in order. */
  readonly leaveOptions: (LeaveOptions | undefined)[];
  disposed: number;
  /** Replaces the snapshot and notifies, as the engine would after any change. */
  set(patch: Partial<CallSnapshot>): void;
  /** The next `join` rejects with this instead of connecting. */
  failNextJoin: unknown;
}

export function createFakeCallEngine(): FakeCallEngine {
  const listeners = new Set<() => void>();
  let snapshot: CallSnapshot = IDLE_CALL;
  const fake: FakeCallEngine = {
    joins: [],
    applied: [],
    moved: [],
    tileSizes: [],
    audio: [],
    video: [],
    audioOnly: [],
    pictureInPicture: [],
    effects: [],
    devices: [],
    left: 0,
    leaveOptions: [],
    disposed: 0,
    failNextJoin: undefined,
    set(patch) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async join(options) {
      fake.joins.push(options);
      fake.set({ phase: "joining", channelId: options.channelId });
      if (fake.failNextJoin !== undefined) {
        const cause = fake.failNextJoin;
        fake.failNextJoin = undefined;
        fake.set({ phase: "failed", error: cause instanceof Error ? cause.message : "failed" });
        throw cause;
      }
      fake.set({
        phase: "connected",
        callId: "call-1",
        participantId: "p-me",
        audioEnabled: options.audio,
        videoEnabled: options.video,
      });
    },
    async leave(options) {
      fake.left += 1;
      fake.leaveOptions.push(options);
      snapshot = IDLE_CALL;
      for (const listener of listeners) listener();
    },
    applyCallState(state) {
      fake.applied.push(state);
    },
    handleMoved(callId, participantId) {
      fake.moved.push([callId, participantId]);
    },
    setAudioEnabled(enabled) {
      fake.audio.push(enabled);
      fake.set({ audioEnabled: enabled });
    },
    async setVideoEnabled(enabled) {
      fake.video.push(enabled);
      fake.set({ videoEnabled: enabled });
    },
    async setNoiseSuppression(enabled) {
      fake.effects.push(["noise", enabled]);
      fake.set({ noiseSuppression: enabled ? "on" : "off" });
    },
    async setBackgroundBlur(enabled) {
      fake.effects.push(["blur", enabled]);
      fake.set({ backgroundBlur: enabled ? "on" : "off" });
    },
    setPictureInPicture(open) {
      fake.pictureInPicture.push(open);
    },
    async setAudioOnly(enabled) {
      fake.audioOnly.push(enabled);
      fake.set({ audioOnlyChosen: enabled, ...(enabled ? { videoEnabled: false } : {}) });
    },
    async setScreenEnabled(enabled) {
      fake.set({ screenEnabled: enabled });
      return true;
    },
    async setDevices(devices) {
      fake.devices.push(devices);
    },
    async listDevices() {
      return { audioInputs: [], videoInputs: [], audioOutputs: [] };
    },
    setTileSizes(sizes) {
      fake.tileSizes.push(sizes);
    },
    dispose() {
      fake.disposed += 1;
    },
  };
  return fake;
}
