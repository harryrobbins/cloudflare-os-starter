// A page for `e2e/effects-check.mjs`: the call's effects on their own, against Chromium's fake
// camera and microphone, with no call, no Worker and no SFU. Exposes two probes on `window`.
import { createBackgroundBlur } from "../../app/src/call/effects/blur.js";
import { createNoiseSuppressor } from "../../app/src/call/effects/noise.js";
import { supportsBackgroundBlur, supportsNoiseSuppression } from "../../app/src/call/effects/support.js";

declare global {
  interface Window {
    probeNoise(): Promise<Record<string, unknown>>;
    probeBlur(): Promise<Record<string, unknown>>;
  }
}

/** Peak level of an audio track over `ms`, through an AnalyserNode. */
async function peakLevel(track: MediaStreamTrack, ms: number): Promise<number> {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  context.createMediaStreamSource(new MediaStream([track])).connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let peak = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    analyser.getFloatTimeDomainData(data);
    for (const sample of data) peak = Math.max(peak, Math.abs(sample));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await context.close();
  return peak;
}

window.probeNoise = async () => {
  const supported = supportsNoiseSuppression();
  const mic = (await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks()[0]!;
  const started = performance.now();
  const processor = await createNoiseSuppressor(mic);
  const startMs = Math.round(performance.now() - started);
  const rawPeak = await peakLevel(mic, 1500);
  const processedPeak = processor === null ? null : await peakLevel(processor.track, 1500);
  const state = processor?.track.readyState;
  processor?.close();
  mic.stop();
  return { supported, built: processor !== null, startMs, rawPeak, processedPeak, state };
};

/**
 * The largest step between horizontally adjacent pixels in any colour channel. The fake camera draws
 * hard-edged shapes (a step of ~180 in green); blurred, no neighbour differs by more than a few tens.
 */
async function edgeEnergy(track: MediaStreamTrack): Promise<{ edges: number; width: number; height: number; image: string }> {
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = new MediaStream([track]);
  await video.play();
  // Let a few frames through so the element holds a real picture, not the first black one.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d")!;
  context.drawImage(video, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let edges = 0;
  for (let i = 4; i < pixels.length; i += 1) {
    if (i % 4 !== 3 && (i / 4) % canvas.width !== 0) edges = Math.max(edges, Math.abs(pixels[i]! - pixels[i - 4]!));
  }
  video.srcObject = null;
  return { edges, width: canvas.width, height: canvas.height, image: canvas.toDataURL("image/png") };
}

window.probeBlur = async () => {
  const supported = supportsBackgroundBlur();
  const camera = (await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 } })).getVideoTracks()[0]!;
  const raw = await edgeEnergy(camera);
  const started = performance.now();
  const processor = await createBackgroundBlur(camera);
  const startMs = Math.round(performance.now() - started);
  if (processor === null) return { supported, built: false };
  const video = document.getElementById("out") as HTMLVideoElement;
  video.srcObject = new MediaStream([processor.track]);
  await video.play();
  let frames = 0;
  await new Promise<void>((resolve) => {
    const end = performance.now() + 3000;
    const tick = (): void => {
      frames += 1;
      if (performance.now() < end) video.requestVideoFrameCallback(tick);
      else resolve();
    };
    video.requestVideoFrameCallback(tick);
  });
  const processed = await edgeEnergy(processor.track);
  const result = {
    supported,
    built: true,
    startMs,
    fps: Math.round(frames / 3),
    width: processed.width,
    height: processed.height,
    rawMaxStep: raw.edges,
    processedMaxStep: processed.edges,
    rawImage: raw.image,
    processedImage: processed.image,
  };
  processor.close();
  camera.stop();
  return result;
};
