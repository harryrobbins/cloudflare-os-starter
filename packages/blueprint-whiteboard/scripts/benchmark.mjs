// Whiteboard performance benchmark (plan phase 0.2). One command, a JSON and a Markdown report,
// no board content (only sizes, counts, bytes and timings):
//
//   node scripts/benchmark.mjs [--sizes 500,2000,5000] [--viewers 1,10,50,200] [--out DIR]
//
// Writes DIR/benchmark.json and DIR/benchmark.md (default DIR: test/performance/results, which is
// not committed). The committed comparison baseline is test/performance/baseline.md.
//
// Everything runs in Node: fixtures go through the real core (src/core/whiteboard.js) over the
// in-memory repository (structured-clone semantics like Durable Object storage), the client canvas
// runs over a fake DOM (element counts are exact, DOM timings are not a browser's), and presence
// goes through the real hub with a simulated clock. Browser frame times come from the harness e2e
// (e2e/harness.test.mjs, test 7), not from here.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { measureSize, presenceMetrics } from "../test/performance/measure.js";
import { SIZES } from "../test/performance/fixtures.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (/** @type {string} */ name, /** @type {string} */ fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const sizes = arg("--sizes", SIZES.join(",")).split(",").map(Number).filter((n) => n > 0);
const viewers = arg("--viewers", "1,10,50,200").split(",").map(Number).filter((n) => n > 0);
const out = resolve(root, arg("--out", "test/performance/results"));

const started = Date.now();
/** @type {Record<string, any>} */
const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version, platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length,
    cpu: os.cpus()[0]?.model ?? "unknown",
  },
  sizes: {},
  presence: [],
};
for (const n of sizes) {
  process.stderr.write(`measuring ${n} objects...\n`);
  report.sizes[n] = await measureSize(n, { timings: true });
}
process.stderr.write(`simulating presence for ${viewers.join(", ")} viewers...\n`);
report.presence = await presenceMetrics(viewers);
report.durationMs = Date.now() - started;

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "benchmark.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(out, "benchmark.md"), markdown(report));
process.stderr.write(`wrote ${join(out, "benchmark.json")} and benchmark.md\n`);

/** @param {Record<string, any>} r */
function markdown(r) {
  const ms = (/** @type {{median: number, p95: number}} */ t) => `${fmt(t.median)} (p95 ${fmt(t.p95)})`;
  const kb = (/** @type {number} */ b) => `${(b / 1024).toFixed(0)} KiB`;
  const cols = Object.keys(r.sizes);
  const row = (/** @type {string} */ label, /** @type {(s: any) => string} */ f) => `| ${label} | ${cols.map((n) => f(r.sizes[n])).join(" | ")} |`;
  const lines = [
    "# Whiteboard benchmark",
    "",
    `Generated ${r.generatedAt} on Node ${r.environment.node}, ${r.environment.platform}, ${r.environment.cpus} x ${r.environment.cpu}.`,
    "Timings in milliseconds: median of repeated runs (p95). Fake-DOM timings are relative, not browser times.",
    "",
    "## Board sizes",
    "",
    `| Measure | ${cols.join(" | ")} |`,
    `| --- | ${cols.map(() => "---").join(" | ")} |`,
    row("Snapshot JSON", (s) => kb(s.snapshot.bytes)),
    row("Snapshot stringify ms", (s) => ms(s.snapshot.stringifyMs)),
    row("Snapshot parse ms", (s) => ms(s.snapshot.parseMs)),
    row("Snapshot structuredClone ms", (s) => ms(s.snapshot.structuredCloneMs)),
    row("Core cold load (DO wake proxy) ms", (s) => ms(s.load.coldMs)),
    row("Core warm getBoard ms", (s) => ms(s.load.warmMs)),
    row("Core update, 1 object ms", (s) => ms(s.ops.single)),
    row("Core update, 100 objects ms", (s) => ms(s.ops.hundred)),
    row("Client spatial index build ms", (s) => ms(s.model.indexBuildMs)),
    row("Client stacking sort ms", (s) => ms(s.model.sortMs)),
    row("Hit test, indexed µs", (s) => fmt(s.queries.hitIndexedUs)),
    row("Hit test, brute force µs", (s) => fmt(s.queries.hitBruteUs)),
    row("Hit test ids scanned (indexed / brute)", (s) => `${fmt(s.queries.hitScannedPerQuery)} / ${s.queries.bruteScannedPerQuery}`),
    row("Viewport query µs", (s) => fmt(s.queries.viewportQueryUs)),
    row("Viewport query ids scanned / found", (s) => `${fmt(s.queries.viewportScannedPerQuery)} / ${fmt(s.queries.viewportFoundPerQuery)}`),
    row("Canvas groups at 100%, culled / unculled", (s) => `${s.canvas.culled.zoom1.groups} / ${s.canvas.unculled.zoom1.groups}`),
    row("Canvas SVG elements at 100%, culled / unculled", (s) => `${s.canvas.culled.zoom1.elements} / ${s.canvas.unculled.zoom1.elements}`),
    row("Canvas SVG elements at fit", (s) => `${s.canvas.culled.atFit.elements}`),
    row("Canvas build ms, culled / unculled", (s) => `${fmt(s.canvas.culled.buildMs)} / ${fmt(s.canvas.unculled.buildMs)}`),
    row("Pan step ms (fake DOM), culled / unculled", (s) => `${fmt(s.canvas.culled.pan.msPerStep)} / ${fmt(s.canvas.unculled.pan.msPerStep)}`),
    row("Pan: max groups / elements created per step (culled)", (s) => `${s.canvas.culled.pan.maxGroups} / ${fmt(s.canvas.culled.pan.elementsCreatedPerStep)}`),
    row("Object renders for a remote 1-object update", (s) => `${s.canvas.culled.remoteUpdateRenders}`),
    "",
    "## Presence (hub simulation, per second after joining)",
    "",
    "| Viewers | Moving | Inbound calls | Deliveries | Events | Est. bytes | Bytes per viewer |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...r.presence.map((p) => `| ${p.viewers} | ${p.active} | ${fmt(p.inboundPerSecond)} | ${fmt(p.deliveriesPerSecond)} | ${fmt(p.eventsPerSecond)} | ${kb(p.bytesPerSecond)} | ${kb(p.perViewer.bytesPerSecond)} |`),
    "",
  ];
  return lines.join("\n");
}

/** @param {number|undefined} v */
function fmt(v) {
  if (v === undefined || v === null || Number.isNaN(v)) return "–";
  return v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
}
