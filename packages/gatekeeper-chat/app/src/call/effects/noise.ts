// ML noise suppression for the microphone (quality phase 2): RNNoise compiled to Wasm, run in an
// AudioWorklet (`@sapphi-red/web-noise-suppressor`). The microphone goes through a 48 kHz
// AudioContext into the worklet and out of a MediaStreamDestination, whose track is what the sender
// carries. About 10 ms of added latency and a few percent of one core.
//
// Everything is bundled and served from this origin (no CDN): the worklet and both Wasm builds are
// Vite `?url` assets, loaded only when somebody turns the effect on. The SIMD build is picked where
// the browser supports it. Muting still works as before: the engine disables the raw microphone
// track, and the worklet then processes silence.

import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

import type { TrackProcessor } from "../engine/types.js";
import { supportsNoiseSuppression } from "./support.js";

/** RNNoise works on 48 kHz frames; the context runs at that rate whatever the device's own. */
const SAMPLE_RATE = 48_000;

/** The Wasm binary, fetched once per page and kept for later calls. */
let wasm: Promise<ArrayBuffer> | null = null;

export async function createNoiseSuppressor(microphone: MediaStreamTrack): Promise<TrackProcessor | null> {
  if (!supportsNoiseSuppression()) return null;
  const { RnnoiseWorkletNode, loadRnnoise } = await import("@sapphi-red/web-noise-suppressor");
  wasm ??= loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch((error: unknown) => {
    wasm = null;
    throw error;
  });
  const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
  try {
    const [binary] = await Promise.all([wasm, context.audioWorklet.addModule(rnnoiseWorkletUrl)]);
    const source = context.createMediaStreamSource(new MediaStream([microphone]));
    const rnnoise = new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary: binary });
    const destination = context.createMediaStreamDestination();
    source.connect(rnnoise).connect(destination);
    // Turned on from a click, so resuming is allowed; a context that stays suspended sends silence.
    if (context.state === "suspended") await context.resume();
    const track = destination.stream.getAudioTracks()[0];
    if (track === undefined) throw new Error("No processed audio track.");
    return {
      track,
      close() {
        source.disconnect();
        rnnoise.disconnect();
        rnnoise.destroy();
        track.stop();
        void context.close().catch(() => undefined);
      },
    };
  } catch (error) {
    void context.close().catch(() => undefined);
    throw error;
  }
}
