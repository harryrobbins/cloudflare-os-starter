// Encodings, constraints and the tile-size -> simulcast-layer rule. Pure data, no WebRTC calls.

import { CALL_SIMULCAST_RIDS, type CallSimulcastRid } from "../../contract.js";
import type { TileSize } from "./types.js";

const [RID_BEST, RID_MID, RID_LOW] = CALL_SIMULCAST_RIDS;

/**
 * Camera simulcast, best first. RIDs run a -> c so ASCII order is best to worst: the SFU's
 * `asciibetical` switching steps down through them under congestion.
 */
export const CAMERA_SIMULCAST_ENCODINGS: readonly RTCRtpEncodingParameters[] = [
  { rid: RID_BEST, scaleResolutionDownBy: 1, maxBitrate: 1_200_000, maxFramerate: 30 },
  { rid: RID_MID, scaleResolutionDownBy: 2, maxBitrate: 450_000, maxFramerate: 24 },
  { rid: RID_LOW, scaleResolutionDownBy: 4, maxBitrate: 150_000, maxFramerate: 15 },
];

/** Used when the browser refuses simulcast: one layer at the top layer's settings. */
export const CAMERA_SINGLE_ENCODING: readonly RTCRtpEncodingParameters[] = [
  { maxBitrate: 1_200_000, maxFramerate: 30 },
];

/** Screen share: one layer, sharp text over smooth motion (the track gets `contentHint = "detail"`). */
export const SCREEN_ENCODINGS: readonly RTCRtpEncodingParameters[] = [{ maxBitrate: 2_000_000, maxFramerate: 15 }];

/** Opus mono speech: ~32 kbps is transparent for voice and leaves room for FEC. */
export const AUDIO_MAX_BITRATE = 32_000;

/** Audio goes first when the uplink is tight. */
export const AUDIO_ENCODINGS: readonly RTCRtpEncodingParameters[] = [
  { networkPriority: "high", priority: "high", maxBitrate: AUDIO_MAX_BITRATE },
];

/** Screen share: text stays sharp and frames drop first (`maintain-resolution`), at most 15 fps. */
export const SCREEN_MAX_FRAMERATE = 15;

/** `RTCRtpSendParameters.degradationPreference` per published kind (not in every TS lib). */
export const DEGRADATION_PREFERENCE = { video: "maintain-framerate", screen: "maintain-resolution" } as const;

/** The smallest simulcast layer: hidden tiles and a poor downlink get this one. */
export const LOWEST_RID: CallSimulcastRid = RID_LOW;

/** Camera capture: 1280x720 at 30 fps ideal, never more. */
export const CAMERA_WIDTH = 1280;
export const CAMERA_HEIGHT = 720;
export const CAMERA_FRAMERATE = 30;

/**
 * `navigator.mediaDevices.getSupportedConstraints()`, or nothing where media devices are missing
 * (insecure context, tests).
 */
export function detectSupportedConstraints(): MediaTrackSupportedConstraints {
  try {
    const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    return devices?.getSupportedConstraints?.() ?? {};
  } catch {
    return {};
  }
}

/**
 * Microphone constraints. The browser's echo cancellation, noise suppression and gain control are
 * asked for explicitly; `voiceIsolation` (Chrome's ML voice isolation) only where supported.
 * Shared with the pre-join preview so what people test is what the call sends.
 */
export function audioConstraints(
  deviceId: string | null,
  supported: MediaTrackSupportedConstraints = detectSupportedConstraints(),
): MediaTrackConstraints {
  const voiceIsolation = (supported as { voiceIsolation?: boolean }).voiceIsolation === true;
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(voiceIsolation ? { voiceIsolation: true } : {}),
  } as MediaTrackConstraints;
}

/** Camera constraints (also for the pre-join preview). */
export function videoConstraints(deviceId: string | null): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: CAMERA_WIDTH, max: CAMERA_WIDTH },
    height: { ideal: CAMERA_HEIGHT, max: CAMERA_HEIGHT },
    frameRate: { ideal: CAMERA_FRAMERATE, max: CAMERA_FRAMERATE },
  };
}

export const DISPLAY_MEDIA_OPTIONS: DisplayMediaStreamOptions = {
  video: { frameRate: { ideal: 15, max: 30 } },
  audio: false,
};

/** Large (speaker, >= 640 px) -> best, grid -> middle, thumbnail or off-screen -> smallest. Unknown -> middle. */
export function ridForTile(size: TileSize | undefined): CallSimulcastRid {
  switch (size) {
    case "large":
      return RID_BEST;
    case "small":
    case "hidden":
      return RID_LOW;
    default:
      return RID_MID;
  }
}
