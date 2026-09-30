// The real browser behind `CallEnvironment`: WebRTC, media devices, a black placeholder track and
// window timers. Everything the engine touches in the browser goes through here so tests can fake it.

import { supportsBackgroundBlur, supportsNoiseSuppression } from "../effects/support.js";
import { detectSupportedConstraints } from "./media.js";
import type { CallEnvironment } from "./types.js";

/** Small on purpose: the SFU forwards it at 1 fps while the camera is off. */
const BLACK_WIDTH = 320;
const BLACK_HEIGHT = 180;

function mediaDevices(): MediaDevices {
  const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  if (!devices) {
    // Insecure context (plain http) or a browser without media devices.
    throw new DOMException("Media devices are unavailable here.", "NotSupportedError");
  }
  return devices;
}

export function createBrowserCallEnvironment(): CallEnvironment {
  return {
    createPeerConnection: (config) => new RTCPeerConnection(config),
    getUserMedia: async (constraints) => mediaDevices().getUserMedia(constraints),
    getDisplayMedia: async (options) => mediaDevices().getDisplayMedia(options),
    enumerateDevices: async () => mediaDevices().enumerateDevices(),
    onDeviceChange(listener) {
      const devices = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
      if (!devices) return () => undefined;
      devices.addEventListener("devicechange", listener);
      return () => devices.removeEventListener("devicechange", listener);
    },
    createBlackVideoTrack: createBlackVideoTrack,
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    supportedConstraints: () => detectSupportedConstraints(),
    senderCapabilities(kind) {
      try {
        return typeof RTCRtpSender === "undefined" ? null : (RTCRtpSender.getCapabilities?.(kind) ?? null);
      } catch {
        return null;
      }
    },
    isDocumentHidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
    onVisibilityChange(listener) {
      if (typeof document === "undefined") return () => undefined;
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    // Quality phase 2: loaded on first use, so a call without effects never downloads them.
    supportsNoiseSuppression: () => supportsNoiseSuppression(),
    createNoiseSuppressor: async (microphone) => (await import("../effects/noise.js")).createNoiseSuppressor(microphone),
    supportsBackgroundBlur: () => supportsBackgroundBlur(),
    createBackgroundBlur: async (camera) => (await import("../effects/blur.js")).createBackgroundBlur(camera),
  };
}

/**
 * A 1 fps black canvas track. Chrome only emits canvas frames when the canvas is painted, so it is
 * repainted every second until the track is stopped.
 */
function createBlackVideoTrack(): MediaStreamTrack {
  const canvas = document.createElement("canvas");
  canvas.width = BLACK_WIDTH;
  canvas.height = BLACK_HEIGHT;
  const context = canvas.getContext("2d");
  const paint = (): void => {
    if (!context) return;
    context.fillStyle = "#000";
    context.fillRect(0, 0, BLACK_WIDTH, BLACK_HEIGHT);
  };
  paint();
  const track = canvas.captureStream(1).getVideoTracks()[0];
  if (!track) throw new DOMException("Canvas capture is unavailable.", "NotSupportedError");
  const interval = window.setInterval(paint, 1_000);
  const stop = track.stop.bind(track);
  track.stop = () => {
    window.clearInterval(interval);
    stop();
  };
  track.addEventListener("ended", () => window.clearInterval(interval));
  return track;
}
