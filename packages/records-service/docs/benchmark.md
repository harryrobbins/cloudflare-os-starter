# Local reference benchmark

Measured 2026-09-25T20:59:45.289Z.

- Duration: 600.03 seconds; target 60 requests/s; concurrency cap 16.
- Successful commands: 35840; achieved **59.73/s**.
- Errors: {}; capacity skips: 160.
- HTTP response-header latency p50/p95/p99: 28.835/37.185/48.704 ms.
- Request start to correlated after-commit LISTEN hint p50/p95/p99: 27.83/35.677/46.586 ms; missing hints 0.
- Ten-minute 50/s gate: **PASS**. Notification gate: **PASS**.
- Hardware: Intel(R) Core(TM) Ultra 7 155H, 11 logical CPUs, 22.5 GiB system RAM; cgroup CPU max 100000, memory max.
- Sampled pending locks maximum: 7; database deadlock delta: 0.

- Synthetic small work.create commands through HTTP gateway and ES256 PostgREST on one datastore; concurrency bounded.
- Notification latency correlates durable sequence to PostgreSQL LISTEN delivery, measured from request start; this upper-bounds commit-to-listener latency. It does not measure SSE browser delivery.
- Response-to-notification can be negative because LISTEN can arrive before HTTP headers.
- Database counters include other local work during measurement; pg_locks count samples are not per-command lock wait durations.
- Docker resources share the host. This is local reference evidence, not a production SLA.
- Each request creates one retained synthetic record in a dedicated benchmark datastore; demo fixtures remain untouched. No cleanup/delete capability is implied.

Reproduce locally: run this script through the operator tools profile in the private Compose network with a separate writable output mount, `--base=http://gateway:8788 --duration=600 --rate=60 --output=/benchmark-output`. It loads ignored fixture credentials without printing them. Sanitized machine evidence is written to `.eval/benchmark.json`.

This was a rate-limited warm-stack evaluation, not a maximum-capacity test. The earlier full load run had an output-mount failure and is not used as evidence. The measured run above persisted successfully; 160 scheduled requests were skipped by the concurrency cap, and every attempted command succeeded.
