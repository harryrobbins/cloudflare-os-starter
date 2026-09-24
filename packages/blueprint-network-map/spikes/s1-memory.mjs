// Spike S1 (memory): heap of the core with a full map loaded, in Node (the same V8 as workerd).
// Run: node --expose-gc spikes/s1-memory.mjs
import { createNetworkMap } from "../src/core/network-map.js";
import { InMemoryRepository } from "../src/core/repository.js";
const hex = (n) => n.toString(16).padStart(12, "0");
const repo = new InMemoryRepository();
const fill = createNetworkMap(repo, { seedDemo: false });
const N = 10_000, M = 30_000;
for (let s = 0; s < N; s += 2000) await fill.applyOperation({ senderId: "f", ops: Array.from({ length: Math.min(2000, N - s) }, (_, k) => ({ op: "create", object: { id: "e_" + hex(0x100000 + s + k), label: `Element ${s + k} with a realistic label`, tags: ["alpha"] } })) });
let seed = 42; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
for (let s = 0; s < M; s += 2000) await fill.applyOperation({ senderId: "f", ops: Array.from({ length: Math.min(2000, M - s) }, (_, k) => ({ op: "create", object: { id: "c_" + hex(0x200000 + s + k), from: "e_" + hex(0x100000 + Math.floor(rnd() * N)), to: "e_" + hex(0x100000 + Math.floor(rnd() ** 2 * N)), direction: "directed" } })) });
for (let s = 0; s < N; s += 2000) await fill.applyOperation({ senderId: "f", ops: [{ op: "move", layout: "shared", items: Array.from({ length: Math.min(2000, N - s) }, (_, k) => ({ id: "e_" + hex(0x100000 + s + k), x: k, y: s })) }] });
global.gc(); const before = process.memoryUsage().heapUsed;
const map = createNetworkMap(repo);
const t = performance.now();
const snap = await map.openSnapshot();
const loadMs = performance.now() - t;
global.gc(); const after = process.memoryUsage().heapUsed;
console.log(JSON.stringify({ spike: "S1-memory", elements: snap.counts.elements, connections: snap.counts.connections, coreHeapMB: +((after - before) / 1048576).toFixed(1), loadMs: Math.round(loadMs), storedJsonMB: +(repo.jsonBytes() / 1048576).toFixed(1) }));
