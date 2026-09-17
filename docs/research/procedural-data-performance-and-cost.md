# How should procedural data queries stay bounded on Workers?

This note records the performance and cost risks behind the synthetic data plans. The small demo can proceed with conservative limits. Revisit this analysis before adding free-form SQL, larger profiles, public access, or high request volume.

Written 2026-09-17 against the pinned Cloudflare OS submodule at `c99aeb3642950c49a5a47e4b389d2a5ef3aed33d` and Cloudflare's platform documentation published in August and September 2026.

## Recommended demo posture

The demo stays predictable when every operation has bounded work. The Gatekeeper should support primary-key lookup, cursor pages, indexed foreign-key lookup, and a small set of exact aggregates.

Use these constraints for the first implementation:

- Cap result pages at 100 records
- Give each size profile exact collection counts
- Reject unsupported filters, joins, ordering, and groupings before generation
- Implement `count` without generating rows
- Implement `sum`, `min`, `max`, and `avg` only where a closed-form or block-summary reducer exists
- Cap grouped aggregates by supported dimension and returned group count
- Set an explicit per-invocation CPU limit after local and deployed benchmarks
- Keep seeds, predicates, and generated values out of logs

Do not expose general SQL in the first version. A later SQL adapter can translate a documented subset into the typed query contract.

## Expected complexity

The service should make cost depend on the requested page or aggregate shape, not the dataset's total row count.

| Operation | Required complexity | Main cost driver |
| --- | --- | --- |
| Primary-key lookup | O(1) | Generated fields |
| Cursor page | O(page size) | Page size and selected fields |
| Indexed child lookup | O(page size) | Page size and relationship derivation |
| Exact `count` | O(1) | Predicate validation |
| Exact scalar aggregate | O(deterministic blocks) | Number of block summaries |
| Supported `groupBy` | O(groups × blocks) | Group and block caps |
| Arbitrary scan or sort | Unsupported | Would scale with collection size |

The optimized aggregate implementation must equal a row-by-row reference implementation on small datasets. Property tests should cover multiple seeds, boundary identifiers, filters, and profile sizes.

## Worst-case failure mode

A naïve `SUM` over one million generated orders performs one million record generations. A join against several million order items increases that work further. Such a request can exhaust CPU before it returns a useful result.

Cloudflare currently documents these relevant limits:

- Workers Paid allows up to five minutes of CPU per HTTP invocation, with a 30-second default
- Workers Free allows 10 ms of CPU per invocation
- Each isolate has 128 MB of memory
- Exceeding CPU or memory limits returns error 1102
- Response bodies have no Workers-specific size limit, but buffering them still consumes isolate memory

Materializing a large result is therefore unsafe even when response streaming is available. The RPC contract should return bounded arrays, not unbounded streams of generated records.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

## Cost model

The synthetic Gatekeeper uses Worker CPU and a Durable Object capability, but it does not pay database row-read charges for generated data. Service bindings do not add another Worker request charge under Standard pricing, although CPU across the participating Workers remains billable.

Cloudflare's Standard Workers pricing currently includes:

| Meter | Monthly allowance | Overage |
| --- | ---: | ---: |
| Worker requests | 10 million | $0.30 per million |
| Worker CPU | 30 million CPU ms | $0.02 per million CPU ms |
| Durable Object requests | 1 million | $0.15 per million |
| Durable Object duration | 400,000 GB-s | $12.50 per million GB-s |

The account also has a $5 monthly Workers Paid minimum. Enterprise contracts may differ.

At the published CPU overage rate, one request that consumes 30 seconds of CPU contributes this amount after the allowance:

```text
30,000 ms × $0.02 / 1,000,000 ms = $0.0006
```

One million requests at that CPU level would contribute about $600 in CPU overages. Request and Durable Object charges would add to that figure. The more immediate problem is reliability: a request at the CPU ceiling may fail, block the interface, and trigger retries.

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), and [Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/).

## Risks that justify revisiting the design

Reopen this analysis when the product adds any of these capabilities:

- Free-form SQL or user-defined expressions
- Filters that require scanning an entire collection
- Joins without directly derivable relationships
- High-cardinality grouping
- Approximate analytics
- Profiles above the benchmarked maximum
- Public or anonymous connector access
- Automated agents that can issue queries repeatedly
- Cached or persisted aggregate blocks

The next design review should include deployed CPU percentiles, Durable Object duration, failure counts, concurrency behavior, and an estimated monthly request volume.

## Benchmark gates for a larger release

Before promoting the connector beyond a small demo, measure each supported operation on every profile. Record p50, p95, and p99 CPU time, wall time, response bytes, and peak memory where available.

Set release gates from those measurements:

1. No supported query approaches the configured CPU limit at p99
2. Aggregate cost grows with bounded blocks and groups, not total rows
3. Result construction stays below the 128 MB isolate limit with margin
4. Invalid queries fail before generation work begins
5. Concurrent requests do not create a retry loop or unbounded Durable Object duration
6. Monthly cost estimates use observed CPU and expected request volume

The small demo does not need to solve every future analytical workload. It needs a narrow contract whose worst case is measurable and inexpensive.
