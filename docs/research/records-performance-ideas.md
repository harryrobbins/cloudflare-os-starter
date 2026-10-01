# Records performance and scalability plan

> **Roadmap superseded — 2026-09-26.** The target storage and sync architecture is now [Records as an immutable fact store](../plans/external_datastores/records-immutable-facts.md). Its phases replace the optimisation order in §7 below. The measurement environments, harness, dataset tiers, diagnosis, experiment protocol, correctness suite and reporting in §2–6 and §8–9 still apply, and the new plan runs every change through them.

Status: proposed measurement and implementation programme, 2026-09-26. This replaces the initial immutable-data discussion with a plan grounded in the current Records service. No experiments or improvements below are complete unless linked evidence says so.

The goal is to establish a reproducible capacity envelope, identify the limiting resource for each workload, and improve it in small verified steps. Preserve transactional history, permissions, revision conflicts, idempotency, and reliable synchronization throughout. Optimize the current service before considering a different storage architecture.

## 1. Scope and existing evidence

The target is [`packages/records-service`](../../packages/records-service/README.md): gateway → private PostgREST → PostgreSQL 17. The older `records-core` and `records-schema` packages are legacy; their partitioning, benchmarks, and operational features must not be attributed to this service.

| Current behavior | Benefit | Performance or scalability question |
| --- | --- | --- |
| Typed mutable module tables plus immutable JSONB journal snapshots | Fast current reads; durable change history | Cost of duplicating full payloads and maintaining mutable rows |
| Datastore row locked before handler execution | Commit-ordered datastore sequence and safe change cursors | Maximum sustainable rate for one hot datastore |
| Datastore sequence also serves as record revision | One ordering mechanism | Entity revisions have gaps; removing the counter needs a new sync protocol |
| Generic `records_private.records` projection still written, no longer read by current API | Historical implementation compatibility | Can the redundant write be removed safely? |
| Journal, outbox marker, and full idempotency result per command | Atomic evidence, retry safety, notification recovery | WAL and retained bytes per mutation; lifecycle policy |
| Forced RLS, restricted handlers, security-barrier presentation/history views | Tenant, row, field, and history controls | Authorization/planning, per-row policy calls, JSON shaping |
| Current PK `(datastore_id,id)`; journal PK `(datastore_id,seq,ordinal)` | Keyset reads and ordered change pulls | Additional access paths for entity history and domain filters |
| Unpartitioned current service tables | Simple constraints and maintenance | When table/index size and maintenance justify partitioning |
| Single-record commands; atomic snapshot capped at 5,000 visible records | Simple whole-command sync and bounded responses | Large-datastore bootstrap; future multi-record pagination |
| No tombstone protocol or implemented history retention workflow | Smaller alpha surface | Growth, deletion, archive, and old-client recovery semantics |

Implementation references: [SQL boundary](../../packages/records-service/sql/README.md), [command dispatcher](../../packages/records-service/sql/007-actor-attribution.sql), [presentation/read implementation](../../packages/records-service/sql/008-presentation-schema.sql), and [delivery checklist](../plans/external_datastores/records-delivery.md).

Existing evidence is a reference, not a capacity promise:

- [HTTP benchmark](../../packages/records-service/docs/benchmark.md): 59.73 successful commands/s at a requested 60/s for ten minutes; p95 response-header latency 37.185 ms; 160 schedule skips. One datastore, small creates, local stack. Rate-limited, not maximum capacity.
- [Presentation benchmark](../../packages/records-service/docs/benchmark-views.md): 100-record page p95 8.5 ms versus 4.6 ms for the earlier prebuilt projection; 5,000-record snapshot p95 116.2 ms versus 45.9 ms. Embedded PostgreSQL with 5,000 work records. Most additional work was JSON shaping; rule-heavy modules were not separately benchmarked.
- [SSE probe](../../packages/records-service/docs/benchmark-sse.md): 30 serial creates, p95 request-start-to-hint 38.353 ms. This does not establish subscriber fan-out capacity.

Do not compare these numbers directly with new remote results without accounting for hardware, network, response-body timing, dataset, and offered load.

## 2. Progressive test environments

Single-machine testing is appropriate for the initial phases. Do not make a second machine a prerequisite for harness development, correctness checks, profiling, or early A/B experiments. Progress through these environments as the questions require:

| Stage | Placement | Evidence it can support |
| --- | --- | --- |
| Initial | Containers, collector, and harness on one workstation | Correctness, instrumentation, query plans, relative optimization effects under a fixed shared resource budget |
| Separated load | Service containers on workstation; harness on laptop or similar | End-to-end network behavior and reduced competition from load generation |
| Large isolated database | Approximately 500 GB database on a dedicated otherwise idle host; harness on a separate machine | Large-working-set, storage, maintenance, recovery, and sustained capacity qualification |

Record the stage in every report. On one machine, collect harness and service resource use separately and keep their limits fixed across A/B runs. Shared CPU, memory, and I/O can distort absolute capacity; requalify accepted changes in the later environments. The logical split between provisioning, load generation, and collection is useful even when all components initially run on the same host.

### Workstation: system under test

Run PostgreSQL, PostgREST, gateway/relay, and a lightweight metrics collector in a dedicated benchmark Compose project on the workstation. Keep application-to-database traffic local to that machine. Use a persistent database volume on a documented SSD/NVMe device, outside a shared source-code mount.

Use the existing pinned deployment images as the initial reference, with a benchmark-specific Compose override. Record image digests, repository commit and dirty diff, migration checksums, PostgreSQL settings, PostgREST settings, connection pools, container limits, and volume layout. Record CPU, RAM, storage model/filesystem, OS, Docker version, and Docker VM allocation where applicable. Host RAM is not necessarily container-available RAM.

Keep `fsync`, durable commit settings, and other durability settings unchanged between comparisons. Disabling durability is not an acceptable production optimization. Reserve a fixed resource budget and stop unrelated builds, backups, and heavy applications during controlled comparisons. Monitor thermal throttling and power policy for long runs.

### Laptop or second machine: load generator

For separated-load and large-database qualification, run only the external HTTP/SSE harness on the laptop or another machine. During initial phases it may run alongside the containers. It receives a benchmark manifest and scoped synthetic-datastore credentials, not migration credentials or a copy of the workstation's complete environment files. It must not provision the database or require direct PostgreSQL access.

Prefer wired Ethernet for capacity tests; record link speed, idle and loaded RTT, packet loss, and throughput. Wi-Fi and internet/tunnel tests are useful separate user-experience profiles, not interchangeable baselines. Keep the laptop on power with sleep disabled and measure its CPU, memory, event-loop lag, sockets, and network utilization.

The existing gateway is bound to loopback in the deployment Compose file. Implement an explicit benchmark override exposing only the gateway on the workstation's private interface, restricted to the load-generator host. Use TLS or an encrypted private tunnel for bearer credentials. Keep PostgreSQL and PostgREST private. Record whether the path includes a tunnel, reverse proxy, TLS termination, or Cloudflare Access; use the same path for each A/B comparison. Do not use the deployed public service as a load-test target.

### Workstation-side provisioning and collection

A local operator prepares deterministic synthetic fixtures, creates scoped benchmark credentials, starts collectors, and exports sanitized measurements keyed by run ID. Migration credentials stay on the workstation. A narrowly privileged collector reads statistics; do not expose a generic privileged SQL endpoint to the harness.

Capture both machines' clocks and synchronization status. Client request durations and request-to-SSE durations use one machine's monotonic clock. Cross-machine timestamps are for correlation unless clock error is quantified; never subtract unsynchronized clocks to claim sub-millisecond latency.

**Exit gates:** initially, the local harness can authenticate, read, write, receive SSE, and save a complete result bundle with server telemetry. Before remote qualification, repeat those checks from the laptop while database ports remain private.

### Large isolated qualification: approximately 500 GB

Make this an explicit later milestone, not a prerequisite for useful early work. Use an otherwise idle host for the service stack and collector, with the load generator elsewhere. PostgreSQL, PostgREST, and gateway are expected service work; unrelated builds, desktop applications, scheduled scans, and backup jobs should be absent during controlled capacity runs. Test backup and maintenance interference separately as named scenarios.

Define the initial size target as approximately **500 GB decimal (500 × 10^9 bytes) of PostgreSQL database storage**, measured with `pg_database_size`, including table heaps, indexes, TOAST, and database overhead. Record those components separately. This is not 500 GB of JSON payloads, and it excludes WAL and external backup files. Also report GiB to avoid unit ambiguity. Record actual populated size at run start/end; a nominal seed count is not evidence of the target size.

Use representative versions, payloads, tenant skew, idempotency, and outbox state to reach the target; do not inflate it with one unqueried filler table. Use the smaller-tier bytes-per-record and bytes-per-mutation measurements to choose counts. Prepare both a history-heavy profile with modest current state and, if resources permit, a larger-current-state profile at similar total size. Report the active working set relative to PostgreSQL buffers and host/VM RAM: a 500 GB database with only a tiny hot subset does not establish performance on broad random access.

Before provisioning, budget separately for the database, indexes under construction, peak WAL, temporary files, retained fixture copies, backup/restore copies, and migration overlap. Two TB of usable SSD/NVMe is a planning starting point, not a guarantee; calculate actual requirements from pilot measurements. Avoid keeping multiple full clones if capacity is insufficient. Declare a free-space stop threshold before each run, initially at least 20% of the volume or the estimated worst-case transient requirement, whichever is larger.

Build the dataset incrementally, saving seed, elapsed time, physical sizes, and invariant checks at checkpoints. Bulk load and index-build time are separate results. Analyze tables, establish the intended cache state, and allow normal maintenance to settle before measuring steady behavior. Include an aged/update-heavy state; pristine bulk-loaded tables alone are insufficient.

At this milestone run point/page reads, deep change catch-up, sparse permission visibility, hot-datastore versus balanced writes, large bootstrap once available, and 1–4 hour mixed soaks spanning checkpoints and autovacuum. Include both normal hot-set access and wide randomized access exceeding effective cache. Measure backup and restore/reconstruction duration, and rehearse any proposed index/partition migration on a recoverable copy or reseedable fixture. Publish time and space budgets as well as request performance.

**Qualification gate:** a manifest proves the measured database is near the 500 GB target, the host is otherwise idle, the generator is external and unsaturated, correctness checks pass, and repeated workload results include disk/WAL/maintenance evidence. If the target is not reached, label the result with its actual size and keep this milestone open.

## 3. Harness work required before meaningful testing

[`scripts/benchmark.ts`](../../packages/records-service/scripts/benchmark.ts) currently allows only local hostnames, reads local fixtures and migration configuration, provisions through the database, and uses a private LISTEN connection. Its reported latency ends at response headers. It also has fixed upper limits on rate and concurrency. It cannot simply be pointed at the workstation.

Split these responsibilities into proposed components; these are deliverables, not existing commands:

| Component | Runs on | Responsibility |
| --- | --- | --- |
| Fixture/provision tool | Workstation | Seed/reset dedicated benchmark datasets; issue scoped credentials and manifest |
| HTTP/SSE runner | Laptop | Scheduled arrivals, actor credentials, command/read workloads, full-response validation |
| Metrics collector | Workstation | PostgreSQL, process/container, disk, network, pool and wait telemetry |
| Verifier | Workstation plus HTTP checks | Check persisted results, history, retries, permissions, and client convergence |
| Report builder | Either | Join run artifacts, compare repetitions, produce charts and decisions |

Extend or reuse the existing scripts where useful. Preserve their local smoke-test mode. Remote targets must be explicit in the benchmark configuration, with an expected datastore set and bounded duration/rate; do not just remove the hostname check and inherit privileged behavior.

The runner needs:

- Deterministic seeds, workload mix, dataset manifest, actor mix, and run IDs. Precompute payloads where possible so generation does not become the bottleneck.
- Both open-loop scheduled arrival tests and closed-loop fixed-concurrency tests. Use open-loop results for saturation/SLO claims. Closed-loop tests help diagnose concurrency but reduce offered work when the service slows.
- Separate counts for scheduled, started, completed, succeeded, timed out, rejected, and unsent/dropped arrivals. Do not catch up missed schedules with an unlabelled burst.
- Scheduled-arrival-to-completion latency as well as request-start-to-headers and request-start-to-validated-body latency. Report generator queue delay explicitly to avoid hiding overload through coordinated omission.
- Histograms by operation, payload tier, actor/permission class, and datastore class. Include p50/p95/p99/max, sample counts, and time-window plots. Preserve timeouts and drops separately; percentiles of successes alone are insufficient.
- Explicit request deadlines, maximum outstanding work, bounded result buffers, streaming histograms, and graceful drain. Distinguish measurement-window throughput from post-window completion/drain time.
- Retries disabled in base capacity runs. Dedicated retry runs report logical operations separately from HTTP attempts and use stable idempotency keys.
- Full response validation, sequence/revision capture, and sampled result hashes without logging credentials or private payloads. Store workload outcomes in bounded files rather than unbounded in-memory arrays.
- SSE subscribers with observed sequence, reconnect count, convergence time, and slow-consumer behavior. Hints may coalesce; verify eventual change-pull convergence, not one frame per write.
- Calibration against a cheap response target and a second generator when needed. A run that saturates the laptop or its link measures the harness/network, not Records capacity.

## 4. Dataset and workload matrix

Track current records and retained versions independently. One million current records with one version is a different workload from ten thousand records with a hundred versions each. Include journal, idempotency, outbox, indexes, TOAST, and WAL in space accounting.

Use staged datasets rather than the full cross-product:

| Tier | Current records | Journal entries | Purpose |
| --- | ---: | ---: | --- |
| Smoke | 1,000 | 10,000 | Harness and correctness |
| Reference | 5,000 | 50,000 | Compare with existing read evidence |
| Working set | 100,000 | 1 million | Realistic lists, updates, sync and skew |
| Large | 1 million | 10 million | Cache pressure, maintenance and storage growth |
| Capacity-driven | Sized to exceed effective cache | Measured on available disk | I/O-bound behavior and partition candidates |
| Isolated large qualification | Derived from measured physical sizes | Representative mix totaling ~500 GB database storage | Dedicated-host capacity, maintenance, bootstrap and recovery |

These are experimental targets, not promised capacity or partition thresholds. Estimate storage from smaller fixtures first; stop or downsize before disk headroom becomes unsafe. Larger tiers may require another machine or storage budget.

Vary independently:

- Datastores: 1, 10, 100, then 1,000 where practical. Use balanced traffic and a skewed case where 80% goes to one datastore. Within it, compare disjoint records with 80% of writes targeting 1% of records.
- Versions per record: roughly 1, 10, 100, plus long-lived hot records. Include large immutable history with a small current working set.
- Payloads: measured small, medium, and near-current-request-limit JSON sizes, for example 0.5 KiB, 4 KiB, and 32 KiB subject to each module's validation. Use realistic high- and low-compressibility text; repeated filler alone understates storage costs.
- Permissions: ordinary work module; people module with owner/non-owner/admin actors, field masks, and history filtering. Include sparse visibility, such as 1% of candidate history rows visible.
- Cache: warmed normal operations; fresh PostgreSQL process with OS cache state documented; genuinely cold storage only on an isolated environment. A container restart does not clear host filesystem cache.
- Data age: fresh load versus sustained updates, checkpoint cycles, autovacuum, and larger retained history.

Bulk seeding may use privileged fixture tooling for speed, but must create internally consistent typed rows, journal snapshots, counters, attribution, and intended idempotency/outbox state. Validate it against a sample created through real commands. Record seeding time separately; run ANALYZE and establish the declared warm-up/cache state before measurement. A fixture with only typed rows is not representative of the full write model.

| Scenario | Operations | Primary question |
| --- | --- | --- |
| Point/page reads | ID reads; 100/500-record keyset pages; first and deep pages | Fixed planning cost, shaping, bounded access |
| Current bootstrap | 1,000/5,000 visible records; >5,000 negative case | Atomicity and explicit current limit |
| Creates | Small and large creates | Base write/WAL cost |
| Updates | Independent rows; hot rows; valid revisions | Datastore versus entity contention |
| Mixed collaboration | Initial proposal: 70% reads, 20% updates, 10% creates | Sustainable interactive service |
| Retry/conflict | Duplicate keys; changed digest; stale revisions; lost-response retry | Correct semantics under contention |
| Change pull | At head, 1,000/100,000 behind, sparse visible history | Catch-up cost and cursor correctness |
| Fan-out | 1/10/100/1,000 subscribers as resources permit | Relay, connection and network limits |
| Revocation | Binding/membership/actor-role changes during reads and writes | Authorization ordering and cache reset |
| Recovery | Disconnect/reconnect; listener/gateway restart; isolated DB restart | Durability and catch-up after interruption |
| Soak | Sustained mixed writes plus readers | Vacuum, WAL, disk growth, memory leaks |

Maintain distinct uncontended and deliberately conflicting update scenarios. Uncontended clients track returned revisions per record; unexpected stale-revision failures there indicate a harness or service problem. Expected PT412/PT409 outcomes in contention tests are reported separately from failures.

Historical lookup, domain-filtered queries, tombstones, multi-record commands, and streaming bootstrap are not all current APIs. Mark their benchmarks blocked until the feature exists, or label database-only prototypes explicitly; never report them as shipped end-to-end capabilities.

## 5. Measurements and diagnosis

Collect client evidence alongside server evidence; throughput alone cannot identify the next change.

| Layer | Measurements |
| --- | --- |
| Client | Offered/achieved rate, latency histograms, schedule lag, drops, errors, body bytes, event-loop lag |
| Gateway/PostgREST | CPU, RSS, event-loop lag, active connections, pool wait, request stages, signing/authentication cost |
| PostgreSQL | Query time/calls, buffers, WAL, I/O, checkpoints, temporary files, active/waiting backends, dead tuples, vacuum/analyze |
| Locks | Wait events and blockers; datastore versus domain/authorization waits; sampled transaction duration |
| Storage | Per-relation heap/index/TOAST size, WAL bytes per mutation, disk latency/utilization, free space |
| Sync | Request-start-to-hint, hint-to-visible-state, backlog clearance, reconnect/reconciliation delay |
| Correctness | Successful logical commands, persisted snapshots, final revisions, retry results, forbidden data exposure |

Enable `pg_stat_statements` in the benchmark image/configuration and record the extension settings. Use nested-statement tracking for diagnostic runs where RPC wrapper totals obscure internal SQL; measure the instrumentation overhead. Planning statistics and detailed traces should be separate diagnostic profiles if expensive. See [PostgreSQL 17 pg_stat_statements](https://www.postgresql.org/docs/17/pgstatstatements.html).

Collect before/after statistics plus periodic samples from the PostgreSQL 17 views appropriate to the installation, including `pg_stat_activity`, table/index statistics, `pg_stat_io`, `pg_stat_wal`, and `pg_stat_checkpointer`. Use short collector transactions and account for statistics refresh/reset behavior. A count of waiting locks is not a lock-duration measurement. See [PostgreSQL 17 monitoring](https://www.postgresql.org/docs/17/monitoring-stats.html).

Capture representative `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT JSON)` plans where supported, with realistic claims and restricted roles. A plan of the outer RPC alone may conceal inner dynamic SQL; inspect representative underlying statements in diagnostic runs. Write EXPLAINs execute writes, so use isolated fixtures and explicit rollback where appropriate. Do not run expensive plan capture during capacity measurements.

Attribute latency with measured stages where possible: network, gateway authorization/signing, PostgREST/pool, database lock wait/execution, JSON serialization, response transfer. Do not infer exact components by subtracting unrelated percentile values.

## 6. Repeatable experiment protocol and gates

For each experiment:

1. Write the hypothesis, one intended change, target workload, primary metric, expected tradeoff, and rollback before implementation.
2. Pin the baseline commit/configuration and prepare two equivalent fixture states. Snapshot/restore them with writers stopped, or reseed deterministically. An ever-growing baseline compared against a fresh candidate is invalid.
3. Run correctness checks and a smoke workload. Confirm server and generator telemetry are complete.
4. Warm up for at least two minutes, extending until the intended state is stable. Exclude warm-up from measurements.
5. Explore offered rates from low load, increasing approximately 1.5–2× until latency/backlog/drop gates fail. Refine near that knee. Vary concurrency limits separately so a harness cap cannot masquerade as service capacity.
6. Run baseline and candidate at the same offered rates, plus find each one's sustainable capacity. Alternate A/B order and repeat at least three times; five near a decision boundary. Restore comparable data each time.
7. Use at least ten minutes for qualifying steady runs; ensure enough samples for reported tails. Follow promising candidates with a 1–4 hour soak covering maintenance cycles.
8. Drain outstanding requests, reconcile ambiguous outcomes, verify history/current state and client convergence, and collect final storage/statistics.
9. Publish each repetition, median effect, spread, and limitations. Retain, revise, or reject the change; then establish the accepted candidate as the next baseline.

Provisional lab gates below make initial decisions reproducible. They are not product SLAs; revise them explicitly once product targets and first remote baselines are available.

| Gate | Initial rule |
| --- | --- |
| Correctness/security | Zero invariant violations, forbidden fields/rows, missing acknowledged changes, or duplicate committed mutations |
| Interactive LAN requests | Full-body p95 ≤100 ms and p99 ≤250 ms for small point/page reads and small commands, per operation |
| Delivery | p95 request-start-to-visible-client-state ≤1 second while meeting write target; eventual exact convergence |
| Unexpected failures | ≤0.1% for exploratory capacity classification; zero unexplained failures in a qualifying run |
| Offered-load delivery | No unsent arrivals in a qualifying run and no sustained growth in in-flight work or backlog |
| Improvement decision | Initially seek ≥10% improvement in the chosen metric, larger than repeat-to-repeat noise |
| Regression budget | No >5% regression in protected latency/throughput metrics unless explicitly justified by the intended tradeoff |
| Sustained operation | No runaway memory/backlog, disk-exhaustion trajectory, or failure to recover after overload |

Bulk snapshots/catch-up have separate completion-time and bytes/s goals; do not apply small-request latency gates to them. Do not accept a p99 claim from a tiny sample. Expected conflict responses still consume capacity and get separate latency/error classifications.

Define maximum sustainable throughput as the highest tested offered rate passing the applicable gates repeatedly for that exact workload and dataset. Publish the tested passing and failing rates, not an interpolated universal maximum. Recommend normal operating load with initial 30% headroom below the measured passing rate, then validate burst recovery. A client-bound result is a lower bound on service capacity.

## 7. Implementation phases and decision points

### Phase A — Establish the baseline, initially on one machine

Deliver the logically split harness, metrics collector, fixture manifests, artifact format, and correctness verifier. Start with smoke/reference tiers on one machine, then one-datastore and many-datastore working-set tests. Introduce private workstation ingress and the external laptop harness before remote qualification. Measure generator capacity in each topology and network behavior when moving off-host. Phases B and C may begin against a valid single-machine baseline; requalify their gains after separating the generator.

Gate: another operator can reproduce a run from its manifest and distinguish service, generator, and network limitations. No schema optimization begins without this evidence.

### Phase B — Remove avoidable work

First hypothesis: the unused generic current projection adds write/WAL/storage cost without serving current reads. Audit repository references, operator tools, attribution/backfills, and migration dependencies before removing its write. Compare stopping writes first with eventual table retirement; do not drop data as part of the initial experiment. New migrations must preserve historical migration checksums.

Measure creates and updates at all payload sizes, WAL bytes/command, table growth, datastore lock hold time, and read correctness. A rollback must restore projection consistency before any consumer is allowed to rely on it; merely re-enabling writes does not backfill the gap.

Next, profile repeated authorization, dynamic planning, and JSON construction. Preserve fresh authorization for idempotency retries and revocation ordering. Benchmark any statement-local reuse of actor/role checks with owner/admin/reader cases. Never cache permissions across requests without proven invalidation semantics.

Compare pool sizes and gateway process counts only after locating pool waits or CPU limits. Record total database connections across all processes. More connections do not remove the datastore lock and may worsen queuing.

### Phase C — Improve measured read paths

Preserve presentation views and forced RLS. Confirm limits remain before JSON shaping and that sparse visibility does not require unbounded work for normal page sizes. Compare permissions-heavy modules separately from work records.

When entity-history reads are introduced, evaluate `(datastore_id, entity, record_id, seq DESC)` on the journal. For new domain filters, design the API, query, and index together: examples include `(datastore_id,status,id)` or channel-specific ordering. Keep added indexes only if read benefit justifies write/WAL/storage cost.

Consider compact covering indexes only for frequent narrow reads; do not put large payloads in indexes. Evaluate BRIN for genuinely correlated broad time scans, not entity lookup. Measure actual plans and buffers rather than assuming an index is used through security views.

Gate: improvements hold at larger history sizes, under the real runtime/presenter roles, and do not change row/field/history visibility.

### Phase D — Remove the bootstrap size barrier

The current >5,000-record rejection is a product scalability limit, independent of database capacity. Design stable streaming/paged bootstrap with a defined data snapshot, sequence watermark, and permission epoch. Options to prototype include a materialized export or a managed consistent database snapshot; ordinary UUID pagination over changing rows is not sufficient.

Evaluate snapshot lifetime, vacuum retention, export storage, resume/expiry behavior, and changes accumulated during bootstrap. Invalidate or restart when permission semantics require it. Verify a client receiving bootstrap plus subsequent changes reaches exactly the authorized current state while concurrent writes continue.

Gate: bootstrap of at least the working-set tier with bounded memory, reproducible results, explicit cancellation/expiry, and no skipped changes. Keep old bounded endpoint compatibility.

### Phase E — Control storage and maintenance cost

Measure long update soaks before tuning table fillfactor or autovacuum. Typed current rows and counters need different maintenance from append-heavy journal/idempotency/outbox tables. Lower fillfactor can improve HOT opportunities but increases footprint; retain only measured wins.

Quantify bytes per successful logical mutation by payload and version depth. Model daily growth, WAL/backup volume, retention horizon, and restore time. Test restore and replay/reconstruction on isolated copies, recording downtime and resulting content hashes.

Define idempotency retry lifetime before pruning results; an expired key must have documented behavior. Define outbox lifecycle against its actual role: it is currently durable evidence, not an implemented webhook queue. Define history retention, tombstones, old cursor handling, and archive access together. History removal must not silently strand clients or invalidate rebuild claims.

Add a payload/schema-version strategy before relying on long-term historical interpretation across module migrations. Prefer full snapshots initially. Compare delta chains, periodic snapshots, or independently versioned large components only when measured duplication dominates; include reconstruction latency, migration complexity, and garbage collection in the comparison.

### Phase F — Qualify at approximately 500 GB, then partition only with demonstrated benefit

Move to the isolated large-database environment described above. Establish an unpartitioned baseline at the actual target size before evaluating physical redesigns. Treat reaching and measuring this scale as a deliverable even if partitioning proves unnecessary.

Use relation bytes, effective cache, maintenance time, retention needs, and query plans as triggers. Roughly 10 million, 100 million, and billion-entry datasets are investigation milestones, not automatic partition boundaries.

| Candidate | When to test | Tradeoff to prove |
| --- | --- | --- |
| No partitions | Baseline at every feasible tier | May remain fastest and simplest |
| Hash by datastore, initially 8/16/32 partitions | Tenant-scoped feed/history and large indexes | Preserves journal PK shape; one hot datastore still shares one partition/lock |
| Time-range journal partitions | Time-bounded access or retention dominates | Feed queries without time bounds fan out; primary-key redesign required |
| Time plus hash | Both benefits demonstrated independently | More planning, DDL, security, and operational complexity |
| Dedicated placement for unusually large datastores | Skew dominates shared resources | Routing, migration, and balancing complexity |

PostgreSQL partitioned unique constraints must include partition keys. Adding time to `(datastore_id,seq,ordinal)` changes what uniqueness the database enforces; it does not preserve sequence identity automatically. See [PostgreSQL 17 partitioning](https://www.postgresql.org/docs/17/ddl-partitioning.html).

Test parent access, direct-child denial, publisher validation, index propagation, partition creation, missing-partition behavior, and backup/restore. Capture planning time and pruning with the real RLS/claims path. Keep partition count bounded.

Each proposal needs a migration rehearsal covering copy/backfill time, dual-write or write-pause behavior, validation, cutover locks, disk headroom, and rollback. Partitioning is not multi-server scaling and cannot fix datastore serialization.

### Phase G — Redesign concurrency only if the lock is the limiter

First compare one hot datastore with balanced traffic across many datastores. If aggregate throughput scales but the hot datastore does not, quantify datastore-lock wait and hold time. Reduce work inside the transaction before replacing its ordering model.

Potential experiments: safe batching with whole-commit pagination, moving sequence allocation later with a consistent lock order, or independent entity writes with a separate commit-ordered publication stage. Each changes protocol or locking semantics and needs a design review backed by baseline evidence. A shorter critical section may help; it does not eliminate the serialized commit point.

Never replace the transactional counter with `nextval()` and keep `seq > cursor` unchanged: allocation order is not commit order, so a client can skip a late commit. CDC or asynchronous publication introduces a second visibility watermark and lag that must be specified and tested.

Gate: delayed-writer, rollback, retry, concurrent ownership/revocation, and reconnect tests prove no omitted committed changes; measured throughput gains justify additional failure modes. For multi-record commands, paginate whole commits or introduce a cursor that safely includes ordinal position.

### Phase H — Scale beyond one database only on evidence

Investigate read replicas when read load dominates and acceptable staleness, read-after-write, permission revocation, and sequence/epoch consistency are specified. Investigate datastore-based sharding when one machine's resource or maintenance limits are reached. Do not assume replicas are safe targets for current authorization reads without a revocation-lag policy.

Compare added operational cost, cross-datastore query limitations, backups, migration, rebalance, and failover against the measured gain. Publish separate limits for one datastore, many datastores, total retained data, and subscriber count.

## 8. Correctness suite required for every accepted change

Reuse the service's database, permission, publication, gateway, and integration tests; add targeted checks for changed invariants. Run real restricted roles and end-to-end tokens, not only owner SQL.

- Every acknowledged unique command has the expected typed state transition and journal snapshot; rollback leaves no partial counter/projection/journal/outbox/idempotency change.
- Same-key retries return the original result with no additional mutation; changed input, actor, or expected revision follows the existing digest/conflict contract. Fresh authorization still applies.
- Concurrent valid/stale updates have expected winners and conflicts. Slow transactions cannot create a feed hole.
- Cross-datastore, reader, owner, admin, masked-field, and history rules hold in reads, commands, sync, and snapshots. RLS/role/publication protections remain in force.
- Test binding/membership and actor-role revocation independently; they have different implementation paths. Specify in-flight behavior rather than assuming identical lock semantics.
- Disconnect after sending a command but before receiving its response; retry and reconcile exactly one logical result. Treat transport timeout as an unknown outcome until reconciled.
- Check journal content against the typed final state and reconstruction expectations. The trusted handler returning one record is not generic proof that it changed only that record.
- Verify client cache purge/reload on epoch change, filtered history cursor progress, missed/coalesced hints, reconnect, and durable recovery after isolated service interruption.

Destructive/restart tests use disposable benchmark fixtures and run separately from latency qualification. A faster result with a failed invariant is rejected.

## 9. Evidence, reporting, and iteration backlog

Store raw artifacts outside Git in a run directory, and commit sanitized compact reports under a proposed `packages/records-service/docs/performance/` directory. Do not overwrite the existing historical benchmark reports.

Each run bundle contains:

- `manifest.json`: run ID, hypothesis, commit/diff, image/config hashes, both machines, network path, resource budgets, fixture seed/counts/bytes, claims classes without secrets, workload and timing settings.
- `client.json` and histogram/time-series files: arrivals, results, per-operation tails, schedule lag, timeouts, payload sizes, retry/conflict classifications, subscriber convergence.
- `server/`: before/after statistics, sampled waits/resources, relation sizes, sanitized plans, instrumentation settings and collector failures.
- `verification.json`: invariants tested, counts/hashes, unknown outcomes resolved, security failures, recovery result.
- `report.md`: baseline/candidate repetitions, effect/spread, bottleneck evidence, tradeoffs, pass/fail/invalid classification, decision, rollback and next experiment.

Plot offered versus achieved throughput, p95/p99 versus offered rate, latency over time, queue/lock waits, WAL and retained bytes per command, per-datastore fairness, and catch-up time versus backlog. Keep unlike operations in separate series. Preserve failed and inconclusive runs to avoid selecting only favorable evidence.

Initial work queue, in dependency order:

- [ ] Capture exact baseline commit, migrations, configuration and hardware/network manifest.
- [ ] Implement provisioning/telemetry and an HTTP/SSE runner usable locally and from a laptop.
- [ ] Calibrate generator/network and validate artifact completeness.
- [ ] Run baseline correctness, reference, working-set, skew and permission scenarios.
- [ ] Remove unused projection writes experimentally; compare and decide.
- [ ] Profile/read-optimize presentation and permission-heavy paths.
- [ ] Design and qualify stable large-datastore bootstrap.
- [ ] Requalify early gains with a separate laptop/second-machine generator.
- [ ] Run growth/maintenance soaks and define retention/version lifecycle.
- [ ] Prepare and measure an approximately 500 GB database on an otherwise idle dedicated host with an external generator.
- [ ] Evaluate indexes and partitioning only against demonstrated problems.
- [ ] Evaluate concurrency redesign or multi-machine service scaling only after simpler changes.

The output of each iteration is a measured decision and an updated operating envelope, including remaining limits. Completing a benchmark is not the same as passing it, and a successful workstation result is not a production SLA.
