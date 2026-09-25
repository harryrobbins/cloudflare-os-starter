# Presentation-view read benchmark (2026-09-26)

`node scripts/benchmark-views.ts 5000 100` on embedded Postgres 17, 5,000 work items, 100 timed
transactions each (after 10 warm-up), including `SET ROLE` and claims setup. "Before" is the
pre-presentation read: an owner-run query of the generic `records_private.records` projection,
which stored ready-made JSON. "After" is the shipped path: `records_runtime` calls an invoker
function that reads the security-barrier presentation view with forced RLS.

| Read | Before p50 / p95 | After p50 / p95 |
| --- | --- | --- |
| Page of 100 records | 3.3 / 4.6 ms | 6.8 / 8.5 ms |
| Snapshot of 5,000 records | 41.8 / 45.9 ms | 103.7 / 116.2 ms |

Where the time goes (5,000 rows, best of 15):

- RLS tenant filtering through the view: about 4 ms (index-only scan on the primary key). The
  permission checks themselves are cheap.
- Shaping rows into JSON from typed columns is most of the difference; the old projection returned
  JSON already built at write time.
- A security-barrier view keeps `ORDER BY … LIMIT` above it, so rows are limited in a subquery
  before they are shaped. Without that, a 100-record page cost 44 ms because every row was shaped.
- Page reads also pay a fixed ~3 ms for authorization and planning the dynamic statement.

Rule-bearing views add per-row `records.actor()` / `records.has_role()` calls for masked columns;
`people` rules are covered by the correctness tests but not separately benchmarked here. These are
local, single-machine measurements, not a homeserver capacity figure.
