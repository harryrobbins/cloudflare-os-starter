// The background-blur worker (see `blur.ts`): reads camera frames, asks MediaPipe's selfie segmenter
// where the person is, and writes a frame with the background blurred and the person sharp.
//
// Compositing is three OffscreenCanvases: the segmenter's confidence mask as an alpha image, the
// person (the frame cut out by that mask), and the output (the frame blurred, the person on top). The
// mask is small (the model's 256x256) and scaled up with smoothing, which softens the edge.

import { ImageSegmenter } from "@mediapipe/tasks-vision";

export interface BlurStart {
  readonly type: "start";
  readonly readable: ReadableStream<VideoFrame>;
  readonly writable: WritableStream<VideoFrame>;
  readonly wasmLoaderPath: string;
  readonly wasmBinaryPath: string;
  readonly modelAssetPath: string;
}

export type BlurWorkerMessage = BlurStart | { readonly type: "stop" } | { readonly type: "ready" } | { readonly type: "error"; readonly message: string };

/** Blur radius in CSS pixels at 720p; scaled with the frame so a smaller layer looks the same. */
const BLUR_PX_AT_720 = 16;

let stopped = false;

/** Monotonic milliseconds for `segmentForVideo`, which rejects a timestamp that goes backwards. */
let lastTimestamp = -1;
function nextTimestamp(frame: VideoFrame): number {
  const ms = Math.max(frame.timestamp / 1000, lastTimestamp + 1);
  lastTimestamp = ms;
  return ms;
}

async function createSegmenter(start: BlurStart): Promise<ImageSegmenter> {
  const fileset = { wasmLoaderPath: start.wasmLoaderPath, wasmBinaryPath: start.wasmBinaryPath };
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: start.modelAssetPath, delegate },
    runningMode: "VIDEO" as const,
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
  try {
    return await ImageSegmenter.createFromOptions(fileset, options("GPU"));
  } catch {
    // No WebGL2 in this worker (blocklisted GPU, software rendering): the CPU path still works.
    return await ImageSegmenter.createFromOptions(fileset, options("CPU"));
  }
}

class Compositor {
  #mask = new OffscreenCanvas(1, 1);
  #person = new OffscreenCanvas(1, 1);
  #out = new OffscreenCanvas(1, 1);
  #maskImage: ImageData | null = null;

  draw(frame: VideoFrame, mask: Float32Array, maskWidth: number, maskHeight: number): VideoFrame {
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    for (const canvas of [this.#person, this.#out]) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }
    if (this.#mask.width !== maskWidth || this.#mask.height !== maskHeight || this.#maskImage === null) {
      this.#mask.width = maskWidth;
      this.#mask.height = maskHeight;
      this.#maskImage = new ImageData(maskWidth, maskHeight);
    }
    const pixels = this.#maskImage.data;
    for (let i = 0; i < mask.length; i += 1) pixels[i * 4 + 3] = Math.round(mask[i]! * 255);
    this.#mask.getContext("2d")!.putImageData(this.#maskImage, 0, 0);

    const person = this.#person.getContext("2d")!;
    person.globalCompositeOperation = "copy";
    person.drawImage(frame, 0, 0, width, height);
    person.globalCompositeOperation = "destination-in";
    person.imageSmoothingEnabled = true;
    person.drawImage(this.#mask, 0, 0, width, height);

    const out = this.#out.getContext("2d")!;
    out.filter = `blur(${Math.max(4, Math.round((BLUR_PX_AT_720 * height) / 720))}px)`;
    out.drawImage(frame, 0, 0, width, height);
    out.filter = "none";
    out.drawImage(this.#person, 0, 0);
    return new VideoFrame(this.#out, { timestamp: frame.timestamp, ...(frame.duration === null ? {} : { duration: frame.duration }) });
  }
}

async function run(start: BlurStart): Promise<void> {
  const segmenter = await createSegmenter(start);
  postMessage({ type: "ready" } satisfies BlurWorkerMessage);
  const compositor = new Compositor();
  try {
    await start.readable
      .pipeThrough(
        new TransformStream<VideoFrame, VideoFrame>({
          transform(frame, controller) {
            if (stopped) {
              frame.close();
              controller.terminate();
              return;
            }
            try {
              const result = segmenter.segmentForVideo(frame, nextTimestamp(frame));
              const mask = result.confidenceMasks?.[0];
              if (mask === undefined) {
                // No mask this frame: pass it through untouched rather than drop it.
                controller.enqueue(frame);
                result.close();
                return;
              }
              const blurred = compositor.draw(frame, mask.getAsFloat32Array(), mask.width, mask.height);
              result.close();
              frame.close();
              controller.enqueue(blurred);
            } catch {
              controller.enqueue(frame);
            }
          },
        }),
      )
      .pipeTo(start.writable);
  } catch {
    // The camera stopped or the generator was stopped: the normal way this ends.
  } finally {
    segmenter.close();
  }
}

addEventListener("message", (event: MessageEvent<BlurWorkerMessage>) => {
  const message = event.data;
  if (message.type === "stop") {
    stopped = true;
    return;
  }
  if (message.type !== "start") return;
  run(message).catch((error: unknown) => {
    postMessage({ type: "error", message: error instanceof Error ? error.message : "Background blur failed." } satisfies BlurWorkerMessage);
  });
});
