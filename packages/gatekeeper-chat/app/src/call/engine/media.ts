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

/** Audio goes first when the uplink is tight. */
export const AUDIO_ENCODINGS: readonly RTCRtpEncodingParameters[] = [{ networkPriority: "high", priority: "high" }];

export function audioConstraints(deviceId: string | null): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

export function videoConstraints(deviceId: string | null): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
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
