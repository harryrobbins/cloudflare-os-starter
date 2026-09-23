// Runs eval/corpus.jsonl through the real gate, live Jev included, and prints a confusion matrix.
// Costs about $0.00002 per Jev call. Needs OPENROUTER_API_KEY in the environment.
//
//   OPENROUTER_API_KEY=... pnpm --filter gatekeeper-websearch eval [repeats]
//
// A case passes only if every repeat gives the expected outcome: probabilities move by a few
// hundredths between identical calls, and a gate that flips is not a gate.

import { readFileSync } from "node:fs";
import { checkQuery, checkUrl, type GateDecision, type Outcome } from "../src/classifier/gate";

/**
 * A fake credential is stored as parts, joined here, so no secret scanner (gitleaks, GitHub push
 * protection) ever sees it whole in the repository.
 */
type Text = string | string[];
type Case = { query?: Text; url?: Text; recent?: string[]; expected: Outcome; note?: string };
const text = (t: Text | undefined) => Array.isArray(t) ? t.join("") : t;

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY.");
  process.exit(2);
}
const repeats = Number(process.argv[2] ?? 3);
// Bundled into .eval/, so resolve from the package root rather than this file.
const corpusPath = new URL("../eval/corpus.jsonl", import.meta.url);
const cases: Case[] = readFileSync(corpusPath, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const detectors = {
  blockedTerms: ["e1376e48400a20e631b61bbf16f555f1", "surprisingly-pages.cloudflareaccess.com"],
  privateDomains: ["surprisingly.ltd"],
  publicHosts: ["cfos.surprisingly.ltd"],
};

async function runOne(c: Case): Promise<{ decision: GateDecision; ms: number }> {
  let ctx = { apiKey: apiKey!, detectors, recentQueries: c.recent ?? [] };
  let t = performance.now();
  let decision = c.url ? await checkUrl(new URL(text(c.url)!), ctx) : await checkQuery(text(c.query)!, ctx);
  return { decision, ms: performance.now() - t };
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  let out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) { let i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const outcomes: Outcome[] = ["allow", "review", "block"];
const matrix = new Map<string, number>();
let cost = 0, jevCalls = 0, patternBlocks = 0, errors = 0;
const latencies: number[] = [];
const failures: string[] = [];
let passed = 0;

const runs = await pool(cases, 6, async c => {
  let results = [];
  for (let i = 0; i < repeats; i++) results.push(await runOne(c));
  return results;
});

cases.forEach((c, i) => {
  let got = runs[i].map(r => r.decision);
  for (let r of runs[i]) {
    let d = r.decision;
    matrix.set(`${c.expected}->${d.outcome}`, (matrix.get(`${c.expected}->${d.outcome}`) ?? 0) + 1);
    if (d.jev) { jevCalls++; cost += d.jev.cost ?? 0; latencies.push(r.ms); }
    else if (d.error) errors++;
    else if (d.outcome === "block") patternBlocks++;
  }
  if (got.every(d => d.outcome === c.expected)) {
    passed++;
    return;
  }
  let d = got.find(x => x.outcome !== c.expected)!;
  let scores = d.jev ? Object.entries(d.jev.scores).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ") : (d.error ?? "patterns");
  failures.push(
    `  expected ${c.expected.padEnd(6)} got [${got.map(x => x.outcome).join(",")}]  ${text(c.query ?? c.url)!.slice(0, 90)}` +
    `${c.note ? `  (${c.note})` : ""}\n      reasons: ${d.reasons.join(",") || "-"}  ${scores}`);
});

latencies.sort((a, b) => a - b);
console.log(`\n${passed}/${cases.length} cases passed on all ${repeats} repeats\n`);
console.log("expected \\ got   " + outcomes.map(o => o.padStart(8)).join(""));
for (let e of outcomes) {
  console.log(`${e.padEnd(16)} ` + outcomes.map(o => String(matrix.get(`${e}->${o}`) ?? 0).padStart(8)).join(""));
}
console.log(`\nJev calls ${jevCalls}, blocked by patterns before Jev ${patternBlocks}, errors ${errors}`);
console.log(`Jev cost $${cost.toFixed(5)}; latency p50 ${latencies[Math.floor(latencies.length / 2)]?.toFixed(0)}ms p95 ${latencies[Math.floor(latencies.length * 0.95)]?.toFixed(0)}ms`);
if (failures.length) console.log(`\nFailures:\n${failures.join("\n")}`);
