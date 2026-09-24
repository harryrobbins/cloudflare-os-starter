# Whiteboard performance baseline

The comparison baseline for plan phases 0.2 and 3 (`docs/plans/whiteboard-improvements.md`),
recorded 2026-09-24 on branch `wb/perf` after merging `feat/whiteboard-improvements` (archive
revision 5 plus the wave-1 streams, with viewport culling and virtualised panels). The raw report
is `baseline.json` next to this file.

Reproduce: `cd packages/blueprint-whiteboard && node scripts/benchmark.mjs` (writes
`test/performance/results/benchmark.{json,md}`, ~15 s). CI asserts only the algorithmic proxies
(`budgets.js`, `model.test.js`); timings are recorded here and are machine-dependent.

How it is measured (all in Node, no board content in the output):

- Fixtures (`fixtures.js`): deterministic 500/2,000/5,000-object boards with frames, stickies
  (some with long text), icons, shapes, long text objects, pen strokes (40-200 points) and ~15%
  connectors between nearby shapes, built through the real core over the in-memory repository.
- "Core cold load" is a fresh `createWhiteboard` over the stored board followed by `getBoard()`:
  the Durable Object wake proxy (load plus index rebuild), without workerd or storage latency.
- Canvas counts come from the real canvas controller over a fake DOM (`fake-dom.js`); element
  counts are exact, fake-DOM timings only compare culled with unculled.
- Presence runs N viewers through the real hub (`presence-sim.js`), each driving the real
  adaptive client presence session (`src/client/sync/presence.js`) with a 60 Hz pointer when
  moving and a 4 s heartbeat timer, over 8 simulated seconds.
- Browser frame times come from the harness e2e (test 7, 500 objects): pan p50 16.7 ms,
  p95 16.8 ms (60 Hz, no long frames); a remote 1-object update costs 1 object render.

Generated 2026-09-24T00:41:15.273Z on Node v24.21.0, linux x64, 11 x Intel(R) Core(TM) Ultra 7 155H.
Timings in milliseconds: median of repeated runs (p95). Fake-DOM timings are relative, not browser times.

### Board sizes

| Measure | 500 | 2000 | 5000 |
| --- | --- | --- | --- |
| Snapshot JSON | 290 KiB | 1181 KiB | 3000 KiB |
| Snapshot stringify ms | 1.50 (p95 1.89) | 7.79 (p95 7.80) | 17.1 (p95 18.5) |
| Snapshot parse ms | 1.08 (p95 2.12) | 5.13 (p95 11.8) | 13.0 (p95 14.9) |
| Snapshot structuredClone ms | 2.90 (p95 3.36) | 11.3 (p95 17.2) | 32.9 (p95 36.4) |
| Core cold load (DO wake proxy) ms | 11.3 (p95 12.2) | 43.8 (p95 47.5) | 109 (p95 112) |
| Core warm getBoard ms | 2.84 (p95 4.75) | 13.3 (p95 14.1) | 32.3 (p95 36.6) |
| Core update, 1 object ms | 0.16 (p95 0.28) | 0.50 (p95 5.12) | 1.18 (p95 1.61) |
| Core update, 100 objects ms | 5.07 (p95 7.97) | 4.81 (p95 6.16) | 4.85 (p95 8.67) |
| Client spatial index build ms | 1.33 (p95 2.83) | 2.67 (p95 9.38) | 8.69 (p95 9.39) |
| Client stacking sort ms | 0.03 (p95 0.06) | 0.40 (p95 1.23) | 1.59 (p95 7.32) |
| Hit test, indexed µs | 1.48 | 1.20 | 2.03 |
| Hit test, brute force µs | 91.1 | 337 | 841 |
| Hit test ids scanned (indexed / brute) | 3.15 / 500 | 3.57 / 2000 | 3.45 / 5000 |
| Viewport query µs | 4.04 | 9.89 | 9.86 |
| Viewport query ids scanned / found | 25.5 / 18.7 | 33.3 / 23.2 | 31.2 / 22.1 |
| Canvas groups at 100%, culled / unculled | 84 / 500 | 99 / 2000 | 96 / 5000 |
| Canvas SVG elements at 100%, culled / unculled | 714 / 3909 | 668 / 14798 | 734 / 36863 |
| Canvas SVG elements at fit | 3909 | 14798 | 36863 |
| Canvas build ms, culled / unculled | 15.7 / 32.4 | 19.3 / 88.4 | 47.5 / 219 |
| Pan step ms (fake DOM), culled / unculled | 0.06 / 0.02 | 0.21 / 0.07 | 0.41 / 0.08 |
| Pan: max groups / elements created per step (culled) | 88 / 6.12 | 119 / 23.3 | 153 / 46.6 |
| Object renders for a remote 1-object update | 1 | 1 | 1 |

### Presence (hub simulation, per second after joining)

| Viewers | Moving | Inbound calls | Deliveries | Events | Est. bytes | Bytes per viewer |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 0.30 | 0.00 | 0.00 | 0 KiB | 0 KiB |
| 1 | 1 | 20.1 | 0.00 | 0.00 | 0 KiB | 0 KiB |
| 10 | 0 | 2.30 | 7.50 | 16.9 | 11 KiB | 1 KiB |
| 10 | 2 | 41.9 | 200 | 375 | 234 KiB | 23 KiB |
| 50 | 0 | 11.0 | 193 | 533 | 333 KiB | 7 KiB |
| 50 | 10 | 58.9 | 424 | 2879 | 1799 KiB | 36 KiB |
| 200 | 0 | 43.8 | 2950 | 8657 | 5410 KiB | 27 KiB |
| 200 | 40 | 135 | 2674 | 26865 | 16791 KiB | 84 KiB |

## Findings

- Viewport culling keeps the DOM proportional to the view: at 100% zoom a 5,000-object board
  renders 96 object groups / 734 SVG elements instead of 5,000 / 36,863, and 5,000 extra
  off-screen objects add nothing (`model.test.js`, "culling acceptance"). At fit-to-content
  everything is visible, so everything is rendered; level of detail is out of scope.
- The spatial index answers hit tests after examining ~3.5 ids instead of all 5,000
  (~2 µs vs ~840 µs) and viewport queries after ~31.
- Presence (adaptive client, phase 3.5): with 20% of 50 viewers moving, the hub makes 424
  deliveries/s (~1.8 MiB/s estimated, 36 KiB/s per viewer); 50 idle viewers cost 193
  deliveries/s (333 KiB/s), all heartbeats, which the hub still fans out to everyone. For
  comparison, the same simulation driving the previous fixed-cadence client (30 Hz while moving,
  unconditional 4 s heartbeat; measured earlier on 2026-09-24 over 5 s) gave 1,510 deliveries/s
  and ~9.3 MiB/s for 50 viewers with 10 moving, 219 deliveries/s for 50 idle, and ~152 MiB/s for
  200 viewers with 40 moving (now ~16 MiB/s). The remaining idle cost is heartbeat fan-out; a hub
  that did not rebroadcast unchanged heartbeats would remove it (not done here: hub behaviour).

## 3.6 snapshot/delta decision gate: NO-GO (keep the single snapshot)

The plan leaves the product budget open; these interim budgets are used until one is agreed:
initial snapshot serialise + parse p95 ≤ 250 ms, Durable Object wake/load p95 ≤ 500 ms, and
snapshot transfer ≤ 2 s on a 20 Mbit/s link, at the largest supported board (LIMITS.objects =
5,000).

| Gate input at 5,000 objects | Measured | Interim budget |
| --- | --- | --- |
| Snapshot size (JSON) | 3.0 MiB (cap: LIMITS.boardBytes 8 MiB) | – |
| Stringify + parse p95 | 18.5 + 14.9 = 33 ms | ≤ 250 ms |
| structuredClone p95 (RPC serialisation proxy) | 36 ms | ≤ 250 ms |
| Core cold load p95 (wake + index rebuild) | 112 ms | ≤ 500 ms |
| Transfer at 20 Mbit/s (estimate) | ~1.2 s | ≤ 2 s |

Neither trigger fires: parse/serialise is ~7x under budget and the core rebuild ~4x under, so
rebuilding indexes does not dominate wake time. Decision: do not build `subscribeV2` (paged
snapshot plus delta journal) now. Revisit if a platform (workerd) measurement of the 5,000
fixture exceeds the budgets, if slow links (≤ 10 Mbit/s, ~2.5 s) become a supported target, or
if LIMITS.objects/boardBytes grow.
