# Local SSE notification probe

Measured 2026-09-25T21:00:08.751Z.

Thirty serial HTTP creates in an otherwise idle dedicated datastore, with one live authenticated SSE subscription; initial frame consumed before measuring. Each command waits for its next change hint. A run at least 15 seconds long or containing extra frames fails to avoid conflating periodic reconciliation hints with notifications. Measured request-start to SSE hint is an upper bound on postcommit relay latency, not an exact commit timestamp.

- Samples: 30; stream frames including initial frame: 31.
- Probe duration: 944.81 ms.
- Latency p50/p95/p99: 28.676/38.353/43.009 ms.
- Subsecond p95 gate: **PASS**.

This is a serial functional latency probe on the local reference stack, separate from the ten-minute sustained load test. It ran while the separate datastore throughput test was active on the same stack. It is not a production SLA or a sustained subscriber-load test.
