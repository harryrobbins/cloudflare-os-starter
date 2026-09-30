# Call effects (quality phase 2)

Optional, off by default, and loaded only when somebody turns one on. Everything is served from the
chat Worker's own assets: nothing is fetched from a CDN at run time.

| Effect | Code | Third-party parts |
| --- | --- | --- |
| Noise suppression | `noise.ts` | [`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor) 0.4.1 (MIT): RNNoise Wasm (plain and SIMD) and its AudioWorklet |
| Background blur | `blur.ts`, `blur.worker.ts` | [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) 1.0.1 (Apache-2.0): the module-worker Wasm build (~11.8 MB, ~3.4 MB gzipped); `selfie_segmenter.tflite` below |

`selfie_segmenter.tflite` is MediaPipe's selfie segmenter (float16), Apache-2.0, downloaded on
2026-09-30 from
`https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite`
(249,537 bytes, sha256 `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b`). To update
it, download the new file, check it is a `TFL3` flatbuffer, and record the new size and hash here.

`support.ts` holds the feature detection, so asking whether an effect is available loads nothing.
The engine owns the lifecycle (`setEffect("noiseSuppression" | "backgroundBlur", on)`: build around the current
track, swap it onto the sender with `replaceTrack`, rebuild on a device switch, shed under CPU
strain). `e2e/effects-check.mjs` runs both in headless Chromium against its fake devices.
