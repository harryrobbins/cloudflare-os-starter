// Phase 1 benchmark (docs/plans/network-map-blueprint.md §12, performance protocol): load-to-
// interaction, edit-to-model latency, snapshot transfer and heap for 1k/3k and 10k/30k maps, in the
// real client inside the CSP frame. Headless Chromium renders WebGL in software (SwiftShader), so
// frame rates here are NOT GPU numbers; run with --headed on a real laptop for those.
//
//   node e2e/bench.mjs [--headed] [--sizes 1000x3000,10000x30000]
import { startHarness, reacquire } from "./helpers.mjs";

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; };
const sizes = arg("--sizes", "1000x3000,10000x30000").split(",").map((s) => s.split("x").map(Number));
const h = await startHarness({ port: 8805 });
const results = [];
try {
  for (const [N, M] of sizes) {
    const { page } = await h.open({ blank: true });
    // Fill through the facet directly (the parent page runs the core).
    await page.evaluate(async ([n, m]) => {
      const hex = (x) => x.toString(16).padStart(12, "0");
      const map = window.harness.map;
      for (let s = 0; s < n; s += 2000) {
        const ops = [];
        for (let i = s; i < Math.min(n, s + 2000); i++) ops.push({ op: "create", object: { id: "e_" + hex(0x100000 + i), label: `Element ${i} with a realistic label`, ...(i % 3 ? { tags: ["alpha"] } : {}) } });
        await map.applyOperation({ senderId: "bench", ops });
      }
      let seed = 42;
      const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
      for (let s = 0; s < m; s += 2000) {
        const ops = [];
        for (let j = s; j < Math.min(m, s + 2000); j++) ops.push({ op: "create", object: { id: "c_" + hex(0x200000 + j), from: "e_" + hex(0x100000 + Math.floor(rnd() * n)), to: "e_" + hex(0x100000 + Math.floor(rnd() ** 2 * n)), direction: j % 3 ? "directed" : "undirected" } });
        await map.applyOperation({ senderId: "bench", ops });
      }
      for (let s = 0; s < n; s += 2000) {
        const items = [];
        for (let i = s; i < Math.min(n, s + 2000); i++) items.push({ id: "e_" + hex(0x100000 + i), x: (i % 100) * 40 + rnd() * 10, y: Math.floor(i / 100) * 40 });
        await map.applyOperation({ senderId: "bench", ops: [{ op: "move", layout: "shared", items }] });
      }
    }, [N, M]);
    // Cold load of the pane: frame creation to a rendered model.
    const t0 = Date.now();
    await page.evaluate(() => window.harness.reloadPane(0));
    const frame = await reacquire(page, 0);
    const loadMs = Date.now() - t0;
    // Edit-to-model: one rename through the store, until the rebuilt model shows it.
    const editMs = await frame.evaluate(async () => {
      const { store, app } = globalThis.networkMap;
      const id = [...store.objects.keys()].find((k) => k[0] === "e");
      const start = performance.now();
      store.apply([{ op: "update", id, patch: { label: "Renamed for the benchmark" } }]);
      await new Promise((resolve) => { const check = () => (app.model.index.elements.get(id)?.label === "Renamed for the benchmark" ? resolve() : requestAnimationFrame(check)); check(); });
      return { total: performance.now() - start, stages: { ...app.perf } };
    });
    const stats = await frame.evaluate(async () => {
      const { app, store } = globalThis.networkMap;
      const frames = [];
      let last = performance.now();
      await new Promise((resolve) => {
        let k = 0;
        const step = () => {
          const now = performance.now(); frames.push(now - last); last = now;
          app.renderer.setCamera({ x: 0.5 + Math.sin(k / 5) * 0.1, y: 0.5, ratio: 1 - (k % 10) / 20 });
          if (++k < 20) requestAnimationFrame(step); else resolve();
        };
        requestAnimationFrame(step);
      });
      frames.sort((a, b) => a - b);
      return {
        nodes: app.model.nodes.size, edges: app.model.edges.size, heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
        panP50Ms: +frames[Math.floor(frames.length / 2)].toFixed(1), connection: store.status.connection,
      };
    });
    results.push({ elements: N, connections: M, coldLoadToModelMs: loadMs, editToModelMs: +editMs.total.toFixed(1), rebuildStagesMs: Object.fromEntries(Object.entries(editMs.stages).map(([k, v]) => [k, +v.toFixed(1)])), ...stats });
    await page.context().close();
  }
} finally {
  await h.close();
}
console.log(JSON.stringify({ bench: "phase1", renderer: "SwiftShader (software WebGL): pan times are not GPU numbers", results }, null, 1));
