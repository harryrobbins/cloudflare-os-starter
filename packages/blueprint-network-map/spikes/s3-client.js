// Spike S3/S5 client: sigma v3 + graphology render of a generated graph inside the gadget CSP frame,
// plus ForceAtlas2 in a data: worker. Results go to window.parent via postMessage.
import Graph from "graphology";
import Sigma from "sigma";
import EdgeCurveProgram from "@sigma/edge-curve";

const report = (data) => window.parent.postMessage({ type: "spike", ...data }, "*");
const N = SPIKE_N, M = SPIKE_M;

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
let stage = "init";
async function main() {
  document.body.style.margin = "0";
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;inset:0";
  document.body.append(el);
  stage = "build";
  const r = rng(42);
  const g = new Graph({ multi: true, type: "mixed" });
  const t0 = performance.now();
  for (let i = 0; i < N; i++) g.addNode("n" + i, { x: r() * 1000, y: r() * 1000, size: 2 + r() * 4, label: "Element " + i, color: ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2"][i % 4] });
  // preferential-ish attachment: hubs + parallel edges + a self-loop
  for (let j = 0; j < M; j++) {
    const a = Math.floor(r() * N), b = Math.floor(Math.pow(r(), 2) * N);
    if (j % 3 === 0) g.addDirectedEdge("n" + a, "n" + b, { size: 1, color: "#bbb" });
    else g.addUndirectedEdge("n" + a, "n" + b, { size: 1, color: "#ccc", type: j % 7 === 0 ? "curved" : "line" });
  }
  const tBuild = performance.now() - t0;
  stage = "mount"; report({ phase: "progress", stage: "built", tBuild: performance.now() - t0 });
  let renderer;
  try {
    renderer = new Sigma(g, el, { edgeProgramClasses: { curved: EdgeCurveProgram }, renderEdgeLabels: false, labelRenderedSizeThreshold: 8 });
  } catch (e) {
    return report({ phase: "error", error: String(e?.stack || e).replace(/data:text\/javascript[^\s)]*/g, "<client>") });
  }
  const tMount = performance.now() - t0 - tBuild;
  // frame timing while panning the camera
  stage = "pan"; report({ phase: "progress", stage: "mounted", t: performance.now() - t0 });
  const cam = renderer.getCamera();
  const frames = [];
  let last = performance.now();
  await new Promise((resolve) => {
    let k = 0;
    const step = () => {
      const now = performance.now();
      frames.push(now - last); last = now;
      cam.setState({ x: 0.5 + Math.sin(k / 10) * 0.2, y: 0.5, ratio: 1 - (k % 30) / 100 });
      renderer.refresh();
      if (++k < (N > 5000 ? 20 : 120)) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
  frames.sort((a, b) => a - b);
  const p50 = frames[Math.floor(frames.length * 0.5)], p95 = frames[Math.floor(frames.length * 0.95)];
  // picking
  stage = "pick";
  const pick = renderer.getNodeDisplayData("n0") ? "ok" : "missing";
  // FA2 in data: worker
  stage = "layout"; report({ phase: "progress", stage: "panned", p50: frames[Math.floor(frames.length/2)], t: performance.now() - t0 });
  const ids = g.nodes(), index = new Map(ids.map((id, i) => [id, i]));
  const x = new Float64Array(ids.length), y = new Float64Array(ids.length);
  ids.forEach((id, i) => { x[i] = g.getNodeAttribute(id, "x"); y[i] = g.getNodeAttribute(id, "y"); });
  const from = new Uint32Array(g.size), to = new Uint32Array(g.size);
  let k = 0; g.forEachEdge((e, a, s, t) => { from[k] = index.get(s); to[k++] = index.get(t); });
  let worker = "not-run", workerMs = null;
  try {
    const w = new Worker(FA2_WORKER_URL, { type: "module" });
    const res = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), 90000);
      w.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
      w.onerror = (e) => { clearTimeout(t); reject(new Error("worker onerror: " + (e.message || "?"))); };
      w.postMessage({ x, y, from, to, ticks: 30 }, [x.buffer, y.buffer]);
    });
    worker = "ok"; workerMs = res.ms;
    const tApply = performance.now();
    ids.forEach((id, i) => g.mergeNodeAttributes(id, { x: res.x[i], y: res.y[i] }));
    renderer.refresh();
    var applyMs = performance.now() - tApply;
    w.terminate();
  } catch (e) { worker = "failed: " + e.message; }
  const inThreadMs = null, settings = null;
  const canvasKinds = [...el.querySelectorAll("canvas")].length;
  const glInfo = (() => { const c = document.createElement("canvas"); const gl = c.getContext("webgl2") || c.getContext("webgl"); if (!gl) return "none"; const d = gl.getExtension("WEBGL_debug_renderer_info"); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "webgl"; })();
  const gpu = typeof navigator.gpu !== "undefined" ? "present" : "absent";
  let gpuAdapter = null;
  if (navigator.gpu) { try { gpuAdapter = (await navigator.gpu.requestAdapter()) ? "adapter" : "no-adapter"; } catch (e) { gpuAdapter = "error " + e.message; } }
  report({ phase: "done", N, M, tBuild, tMount, p50, p95, pick, worker, workerMs, layoutWorkerMsPerTick: workerMs && workerMs / 30, applyMs, canvasKinds, glInfo, gpu, gpuAdapter, isSecureContext: self.isSecureContext, heap: performance.memory ? performance.memory.usedJSHeapSize : null });
}
main().catch((e) => report({ phase: "error", stage, message: String(e?.message), error: String(e?.stack || e).replace(/data:text\/javascript[^\s)]*/g, "<client>") }));
