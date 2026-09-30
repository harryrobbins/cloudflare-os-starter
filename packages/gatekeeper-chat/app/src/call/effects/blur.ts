// Background blur for the camera (quality phase 2): MediaPipe's selfie segmenter finds the person in
// each frame, and a worker composites them, sharp, over a blurred copy of the frame.
//
// The frames never touch the main thread: a MediaStreamTrackProcessor's readable and a
// MediaStreamTrackGenerator's writable are transferred to `blur.worker.ts`, which reads, segments,
// composites and writes; the generator is the track the sender carries. That needs Chrome or Edge
// (insertable streams for video on the main thread); elsewhere the switch is hidden. The model and
// the MediaPipe Wasm are bundled and served from this origin, loaded only when somebody turns blur on.

import wasmBinaryUrl from "@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url";
import wasmLoaderUrl from "@mediapipe/tasks-vision/vision_wasm_module_internal.js?url";

import type { TrackProcessor } from "../engine/types.js";
import { supportsBackgroundBlur } from "./support.js";
import modelUrl from "./selfie_segmenter.tflite?url";
import type { BlurStart, BlurWorkerMessage } from "./blur.worker.js";

/** Chrome's insertable streams for video, as far as this file uses them (not in TypeScript's DOM lib). */
interface TrackProcessorConstructor {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): { readonly readable: ReadableStream<VideoFrame> };
}
interface TrackGeneratorConstructor {
  new (init: { kind: "video" }): MediaStreamTrack & { readonly writable: WritableStream<VideoFrame> };
}

/** How long the model may take to load before blur counts as failed. */
const START_TIMEOUT_MS = 20_000;

/** The files the worker loads, as absolute URLs (the worker resolves against its own location). */
export function blurAssets(base: string): Omit<BlurStart, "type" | "readable" | "writable"> {
  return {
    wasmLoaderPath: new URL(wasmLoaderUrl, base).href,
    wasmBinaryPath: new URL(wasmBinaryUrl, base).href,
    modelAssetPath: new URL(modelUrl, base).href,
  };
}

export async function createBackgroundBlur(camera: MediaStreamTrack): Promise<TrackProcessor | null> {
  if (!supportsBackgroundBlur()) return null;
  const scope = globalThis as unknown as {
    MediaStreamTrackProcessor: TrackProcessorConstructor;
    MediaStreamTrackGenerator: TrackGeneratorConstructor;
  };
  // One frame of buffer: when the model falls behind, the oldest frame is dropped rather than queued.
  const input = new scope.MediaStreamTrackProcessor({ track: camera, maxBufferSize: 1 });
  const output = new scope.MediaStreamTrackGenerator({ kind: "video" });
  const worker = new Worker(new URL("./blur.worker.ts", import.meta.url), { type: "module", name: "call-blur" });
  const close = (): void => {
    worker.postMessage({ type: "stop" } satisfies BlurWorkerMessage, []);
    output.stop();
    // Give the worker a moment to release the segmenter's GPU context before it goes.
    setTimeout(() => worker.terminate(), 1_000);
  };
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Background blur took too long to start.")), START_TIMEOUT_MS);
    worker.addEventListener("message", (event: MessageEvent<BlurWorkerMessage>) => {
      if (event.data.type === "ready") {
        clearTimeout(timer);
        resolve();
      } else if (event.data.type === "error") {
        clearTimeout(timer);
        reject(new Error(event.data.message));
      }
    });
    worker.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(new Error(event.message || "The blur worker failed to load."));
    });
  });
  const start: BlurStart = { type: "start", readable: input.readable, writable: output.writable, ...blurAssets(location.href) };
  worker.postMessage(start, [input.readable as unknown as Transferable, output.writable as unknown as Transferable]);
  try {
    await ready;
  } catch (error) {
    close();
    throw error;
  }
  return { track: output, close };
}
