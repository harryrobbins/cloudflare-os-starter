// The call's optional effects in the browser (quality phase 2), wired against fakes: jsdom has no
// AudioWorklet, insertable streams or workers, so what is tested is the plumbing -- feature
// detection, the audio graph, the worker handshake and the clean-up. Whether RNNoise and MediaPipe
// actually sound and look right is a real-browser check (docs/plans/chat-video-implementation.md).
import { afterEach, describe, expect, it, vi } from "vitest";

import { supportsBackgroundBlur, supportsNoiseSuppression } from "./support.js";

const graph: string[] = [];

/** Stands in for a browser constructor that only has to exist. */
function noop(): void {}

vi.mock("@sapphi-red/web-noise-suppressor", () => ({
  loadRnnoise: vi.fn(async () => new ArrayBuffer(8)),
  RnnoiseWorkletNode: class {
    constructor(_context: unknown, options: { maxChannels: number; wasmBinary: ArrayBuffer }) {
      graph.push(`rnnoise(${options.maxChannels},${options.wasmBinary.byteLength})`);
    }
    connect(next: { name: string }) {
      graph.push(`rnnoise->${next.name}`);
      return next;
    }
    disconnect() {
      graph.push("rnnoise.disconnect");
    }
    destroy() {
      graph.push("rnnoise.destroy");
    }
  },
}));

afterEach(() => {
  graph.length = 0;
  vi.unstubAllGlobals();
});

describe("feature detection", () => {
  it("offers neither effect in a scope without the APIs", () => {
    expect(supportsNoiseSuppression({} as typeof globalThis)).toBe(false);
    expect(supportsBackgroundBlur({} as typeof globalThis)).toBe(false);
  });

  it("offers each where its APIs exist", () => {
    const fn = noop;
    expect(
      supportsNoiseSuppression({ AudioContext: fn, AudioWorkletNode: fn, MediaStreamAudioDestinationNode: fn, WebAssembly: {} } as never),
    ).toBe(true);
    expect(
      supportsBackgroundBlur({ MediaStreamTrackProcessor: fn, MediaStreamTrackGenerator: fn, OffscreenCanvas: fn, VideoFrame: fn, Worker: fn } as never),
    ).toBe(true);
    // Firefox and Safari have no main-thread MediaStreamTrackGenerator.
    expect(supportsBackgroundBlur({ MediaStreamTrackProcessor: fn, OffscreenCanvas: fn, VideoFrame: fn, Worker: fn } as never)).toBe(false);
  });
});

describe("createNoiseSuppressor", () => {
  function stubAudio(state: "running" | "suspended") {
    const processed = { kind: "audio", stop: vi.fn() };
    const contexts: { options: AudioContextOptions; resumed: boolean; closed: boolean; modules: string[] }[] = [];
    class FakeContext {
      state = state;
      readonly record: (typeof contexts)[number];
      readonly audioWorklet = { addModule: async (url: string) => void this.record.modules.push(url) };
      constructor(options: AudioContextOptions) {
        this.record = { options, resumed: false, closed: false, modules: [] };
        contexts.push(this.record);
      }
      createMediaStreamSource(stream: { tracks: unknown[] }) {
        graph.push(`source(${stream.tracks.length})`);
        return { connect: (next: { name?: string }) => (graph.push("source->rnnoise"), next), disconnect: () => graph.push("source.disconnect") };
      }
      createMediaStreamDestination() {
        return { name: "destination", stream: { getAudioTracks: () => [processed] } };
      }
      async resume() {
        this.record.resumed = true;
      }
      async close() {
        this.record.closed = true;
      }
    }
    const fn = noop;
    vi.stubGlobal("AudioContext", FakeContext);
    vi.stubGlobal("AudioWorkletNode", fn);
    vi.stubGlobal("MediaStreamAudioDestinationNode", fn);
    vi.stubGlobal(
      "MediaStream",
      class {
        constructor(readonly tracks: unknown[]) {}
      },
    );
    return { contexts, processed };
  }

  it("runs the microphone through RNNoise at 48 kHz and tears the graph down on close", async () => {
    const { contexts, processed } = stubAudio("suspended");
    const { createNoiseSuppressor } = await import("./noise.js");
    const result = await createNoiseSuppressor({ kind: "audio" } as MediaStreamTrack);
    expect(result?.track).toBe(processed);
    expect(contexts[0]!.options).toMatchObject({ sampleRate: 48_000 });
    expect(contexts[0]!.modules).toHaveLength(1);
    expect(contexts[0]!.resumed).toBe(true);
    expect(graph).toEqual(["source(1)", "rnnoise(1,8)", "source->rnnoise", "rnnoise->destination"]);

    result!.close();
    expect(graph).toContain("rnnoise.destroy");
    expect(processed.stop).toHaveBeenCalled();
    expect(contexts[0]!.closed).toBe(true);
  });

  it("answers null where the APIs are missing", async () => {
    const { createNoiseSuppressor } = await import("./noise.js");
    await expect(createNoiseSuppressor({ kind: "audio" } as MediaStreamTrack)).resolves.toBeNull();
  });
});

describe("createBackgroundBlur", () => {
  function stubVideo(reply: { type: "ready" } | { type: "error"; message: string }) {
    const workers: { url: string; posted: { message: { type: string }; transfer?: unknown[] }[]; terminated: boolean }[] = [];
    const generator = { kind: "video", writable: { name: "writable" }, stop: vi.fn() };
    class FakeWorker extends EventTarget {
      readonly record: (typeof workers)[number];
      constructor(url: URL) {
        super();
        this.record = { url: url.href, posted: [], terminated: false };
        workers.push(this.record);
      }
      postMessage(message: { type: string }, transfer?: unknown[]) {
        this.record.posted.push({ message, transfer });
        if (message.type === "start") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: reply })));
      }
      terminate() {
        this.record.terminated = true;
      }
    }
    const fn = noop;
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal(
      "MediaStreamTrackProcessor",
      class {
        readonly readable = { name: "readable" };
      },
    );
    // A constructor that returns the fake generator, as `new MediaStreamTrackGenerator()` would a track.
    vi.stubGlobal("MediaStreamTrackGenerator", function MediaStreamTrackGenerator() {
      return generator;
    });
    vi.stubGlobal("OffscreenCanvas", fn);
    vi.stubGlobal("VideoFrame", fn);
    return { workers, generator };
  }

  it("hands the streams and bundled assets to the worker and sends the generator", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { workers, generator } = stubVideo({ type: "ready" });
    const { createBackgroundBlur } = await import("./blur.js");
    const result = await createBackgroundBlur({ kind: "video" } as MediaStreamTrack);
    expect(result?.track).toBe(generator);
    const start = workers[0]!.posted[0]!;
    expect(start.message).toMatchObject({ type: "start", readable: { name: "readable" }, writable: { name: "writable" } });
    expect(start.transfer).toEqual([{ name: "readable" }, { name: "writable" }]);
    const assets = start.message as unknown as Record<string, string>;
    for (const key of ["wasmLoaderPath", "wasmBinaryPath", "modelAssetPath"]) {
      // Absolute and same-origin: nothing is fetched from a CDN.
      expect(new URL(assets[key]!).origin).toBe(location.origin);
    }
    expect(assets["modelAssetPath"]).toMatch(/selfie_segmenter.*\.tflite/);

    result!.close();
    expect(workers[0]!.posted.at(-1)!.message).toEqual({ type: "stop" });
    expect(generator.stop).toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(workers[0]!.terminated).toBe(true);
    vi.useRealTimers();
  });

  it("rejects and cleans up when the worker cannot start the model", async () => {
    const { workers, generator } = stubVideo({ type: "error", message: "no WebGL" });
    const { createBackgroundBlur } = await import("./blur.js");
    await expect(createBackgroundBlur({ kind: "video" } as MediaStreamTrack)).rejects.toThrow("no WebGL");
    expect(generator.stop).toHaveBeenCalled();
    expect(workers[0]!.posted.at(-1)!.message).toEqual({ type: "stop" });
  });
});
