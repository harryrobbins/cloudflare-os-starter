// Feature detection for the call's optional effects, kept apart from the effects themselves so that
// asking "is this supported?" loads nothing: the engine asks on every join, the effects load only
// when somebody turns one on.

/** Noise suppression: AudioWorklet, a MediaStream source and destination, and Wasm. */
export function supportsNoiseSuppression(scope: typeof globalThis = globalThis): boolean {
  const candidate = scope as unknown as {
    AudioContext?: unknown;
    AudioWorkletNode?: unknown;
    MediaStreamAudioDestinationNode?: unknown;
    WebAssembly?: unknown;
  };
  return (
    typeof candidate.AudioContext === "function" &&
    typeof candidate.AudioWorkletNode === "function" &&
    typeof candidate.MediaStreamAudioDestinationNode === "function" &&
    typeof candidate.WebAssembly === "object"
  );
}

/** Background blur: Chrome's insertable streams for video, OffscreenCanvas, VideoFrame and workers. */
export function supportsBackgroundBlur(scope: typeof globalThis = globalThis): boolean {
  const candidate = scope as unknown as Record<string, unknown>;
  return (
    typeof candidate["MediaStreamTrackProcessor"] === "function" &&
    typeof candidate["MediaStreamTrackGenerator"] === "function" &&
    typeof candidate["OffscreenCanvas"] === "function" &&
    typeof candidate["VideoFrame"] === "function" &&
    typeof candidate["Worker"] === "function"
  );
}

