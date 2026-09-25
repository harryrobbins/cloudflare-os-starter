# Immutable datastores on Durable Objects and R2: research

> **Records direction superseded — 2026-09-25.** The current recommendation and delivery plan is [Records: shared application data](../../plans/external_datastores/records-direction.md). This document is retained as historical research, implementation evidence or a separate gadget-HTTP proposal; it is not the specification for the new Records service. Existing deployment records remain historical facts, not instructions to deploy the new design.

Written 2026-09-24 against starter `main` `5f8c12c`. This is the evidence for the
[immutable datastores plan](../../plans/external_datastores/immutable-datastores.md), an alternative to the Postgres-backed
[organisation datastores](../../plans/external_datastores/organisation-datastores.md). Nothing here has been built or
measured. **The plan was not pursued** (see its status line); the Parquet, Iceberg and DuckDB findings
remain useful if analytics is later fed from Postgres. Confidence marks: **H** = primary documentation or changelog, **M** = secondary source or
inference from primary sources, **U** = not verified.

## 1. What the current Records code gives us

Code trace of `packages/gatekeeper-records`, `records-contracts` and `records-schema`.

| Part | Status without Postgres |
| --- | --- |
| `records-contracts` (DTOs, `CallerContext`, `intentDigest`, permissions algebra, `effectivePermissions`, `OPERATION_PERMISSION`, errors, `ServiceRequirementSchema`) | Storage-agnostic. `ModuleManifestSchema.schema` and `LIMITS.statementTimeoutMs` are Postgres leftovers. `ChangeEventSchema` carries identifiers only; a lake export needs a payload-bearing envelope. |
| Transports: `http/api.ts`, `http/access.ts`, `vendor/*`, `connect.ts`, `connect-guard.ts`, `feed/consumer.ts`, `feed/hook-controller.ts`, the management UI | Depend only on the `RecordsService` facade (`domain/service.ts:10-18`, `http/api.ts:27-35`). Reusable if the facade becomes an interface. |
| Domain rules: `authorize.ts`, `idempotency.ts`, `journal.ts`, `projects.ts` (383 lines), `registry.ts` (758 lines) | Rules are portable; the code is not. Domain functions write postgres.js tagged SQL directly inside `withContext`, with RLS context, `FOR SHARE`/`FOR UPDATE`, `ON CONFLICT`, `ILIKE`, `jsonb`, SQLSTATE mapping and two `SECURITY DEFINER` lookups. There is no repository port. |
| Postgres-only: `db/context.ts`, `runtime.ts`, `feed/publisher.ts`, `records-schema` migrations/RLS, the cron outbox drain | Removed. |
| Tests | `domain`, `feed`, `http` and the workerd session suite run against embedded Postgres, but are behavioural and can be retargeted at a DO-backed service. Contracts, connect-guard, resource and all UI tests are storage-free. |

The registry needs these queries across datastores: identity → organisation and credential ID →
datastore **before the organisation is known** (every HTTP request and every connect); and within
an organisation, `searchDatastores`, connection revocation across datastores, principal status on
every operation, and the principal directory. A per-organisation registry Durable Object can hold
all of these if the two global lookups are solved separately. Today's "a committed revocation
denies later operations" guarantee (`authorize.ts:5-8`) relied on `FOR SHARE` locks. Across
Durable Objects it needs an explicit protocol.

The HTTP adapter already requires `Idempotency-Key` on mutations, `If-Match` revisions, bounded
bodies and responses, a 15 s deadline, a path-specific Access audience and `rk1_` credentials stored
as SHA-256 digests (`http/api.ts`, `registry.ts:77-85, 606-699`). The gadget HTTP API
[review](gadget-http-api-recommendations.md) adds: a dedicated Access application per path, no
payloads in observations, unknown-outcome semantics for 504, no internal retry of an overloaded
Durable Object (503 with `Retry-After`), a route manifest that generates OpenAPI and clients, and
default token expiry.

The repository has no D1, Pipelines, Analytics Engine, Parquet, Iceberg or DuckDB usage. R2 is used
only for chat files and blueprint content.

## 2. Durable Objects as event-sourced shards

- **Limits (H).** 10 GB of SQLite per object; one thread; point-in-time recovery for 30 days via
  bookmarks; alarms run at least once with backoff (`retryAlarm: false` since 2026-08-25); new
  namespaces must use SQLite (2026-07-09).
  [limits](https://developers.cloudflare.com/durable-objects/platform/limits) ·
  [SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- **Commit order (H, by construction).** A single-writer object that allocates `seq` inside the
  write transaction produces sequence numbers in commit order. The Postgres design had to abandon
  `seq > cursor` polling because sequence allocation is not commit order
  ([decisions §7](organisation-datastores-decisions.md#7-outbox-correction-allocation-order-is-not-commit-order)).
  Per-shard `seq` cursors are safe here, which makes a resumable change feed straightforward.
- **Pattern (M).** Append events and apply projections in one synchronous transaction; treat the
  events table as the outbox with an `exported_through` watermark; export with deterministic object
  names so a retried upload overwrites rather than duplicates; advance the watermark only after a
  successful write; dedupe downstream on `(shard, seq)`; trim local events after export and snapshot,
  and rebuild from the lake. Point-in-time recovery is disaster recovery, not an audit history.
- **Deleted rows persist (H/U).** Rows deleted from SQLite remain recoverable through point-in-time
  recovery for about 30 days, and Cloudflare does not document when residual copies are gone
  ([cloudflare-docs#33631](https://github.com/cloudflare/cloudflare-docs/issues/33631)).

## 3. The lake formats

### Apache Iceberg on R2 Data Catalog

- **Status (M/H).** Public beta; billed since 2026-08-03: $9 per million catalog operations after
  1 M free per month; compaction $0.005/GB after 10 GB plus $2 per million objects; snapshot
  expiration free. [pricing](https://developers.cloudflare.com/r2-data-catalog/platform/pricing/)
- **Maintenance by Cloudflare (H).** Compaction to 64–512 MB Parquet files, manifest optimisation
  (2026-07-13), snapshot expiration (default 30 days, retain 5), read-only tokens (2026-07-13), a
  maintenance dashboard (2026-09-16). **Orphaned files are not removed.**
  [maintenance](https://developers.cloudflare.com/r2-data-catalog/table-maintenance/)
- **DuckDB reads and writes it (H).** Attach via the REST catalog with a token. INSERT and CREATE
  since 1.4.0, UPDATE/DELETE since 1.4.2, MERGE INTO, ALTER TABLE, partition transforms and Iceberg
  v3 since 1.5.3. Deletes are merge-on-read. The R2 guide says DELETE is unsupported on partitioned
  tables, which may predate 1.5.3 (M).
  [R2 + DuckDB](https://developers.cloudflare.com/r2/data-catalog/config-examples/duckdb/) ·
  [DuckDB Iceberg 1.5.3](https://duckdb.org/2026/05/29/new-iceberg-features)
- **R2 SQL (H).** Read-only, serverless; joins, subqueries, CTEs, set operations and window functions
  as of June 2026; $2.50/TB scanned, 10 MB minimum per query. Primary pages still say beta (U).
  [changelog](https://developers.cloudflare.com/changelog/product/r2-sql/)

### Pipelines

Open beta, billed since 2026-08-03. Roll interval of at least 60 s to the catalog sink, Parquet
only, append-only (M), 5 MB per request, 5 MB/s per stream, 20 streams per account, no documented
idempotency key on `send()`. A public report (2026-03,
[workers-sdk#12774](https://github.com/cloudflare/workers-sdk/issues/12774)) describes stalled
metadata commits followed by compaction deleting still-referenced manifests, leaving a table
permanently unreadable; it was closed without a public fix. **Not suitable as the only path for
authoritative history.** Reasonable for high-volume, loss-tolerant telemetry.

### DuckLake

- **Status (H).** v1.0 on 2026-04-13 (DuckDB ≥ 1.5.2), with a compatibility promise. Data inlining
  (small writes stay in the catalog until flushed), sorted tables, Iceberg-compatible bucket
  partitioning, VARIANT, experimental deletion vectors, per-file encryption keys held in the catalog.
  Readers exist for DataFusion, Spark and Trino.
  [1.0](https://ducklake.select/2026/04/13/ducklake-10/) ·
  [encryption](https://ducklake.select/docs/stable/duckdb/advanced_features/encryption)
- **Catalog (H).** DuckDB file (one client), SQLite (single writer), Postgres (recommended for many
  clients), MySQL (not recommended). Data files on R2 are supported.
  [choosing a catalog](https://ducklake.select/docs/stable/duckdb/usage/choosing_a_catalog_database)
- **Maintenance (H).** Nothing is removed until `ducklake_expire_snapshots` and file cleanup;
  compaction is `ducklake_merge_adjacent_files`/`ducklake_rewrite_data_files`, run by us.
- **Catalog in a Durable Object (H/U).** Not possible directly: DuckDB reaches catalogs through
  file or wire-protocol connections, which neither DO SQLite nor D1 offers. DuckDB's HTTP protocol
  **Quack** is experimental in 1.5.3 and due to be stable in DuckDB 2.0 (alpha, release projected for
  late October 2026). [tobilg/quacklake](https://github.com/tobilg/quacklake) serves a DuckLake
  catalog from a SQLite Durable Object over Quack but describes itself as alpha, without cross-session
  conflict detection. [Quack](https://duckdb.org/2026/05/12/quack-remote-protocol) ·
  [DuckDB 2.0 alpha](https://duckdb.org/2026/09/02/try-duckdb-20-alpha)
- **A single-writer variant (M, our inference).** If one compactor is the only writer, a SQLite
  catalog fits its concurrency model. Readers would need a copy of the catalog file, so this is an
  experiment, not a default.

"Duckhouse" is not an established product or term (U); this plan uses it for "DuckDB over an open
R2 lake".

## 4. Compute for writing Parquet and running DuckDB

- **Parquet from a Durable Object (M).** [hyparquet-writer](https://github.com/hyparam/hyparquet-writer)
  is pure JS with one dependency (one report: 20k rows to 271 KB in 34 ms under workerd).
  [parquet-wasm](https://github.com/kylebarron/parquet-wasm) is about 1.2 MB brotli-compressed.
- **DuckDB-Wasm in a Worker (H/M).** Possible but constrained by 128 MB per isolate.
  [ducklings](https://github.com/tobilg/ducklings) is about 9.7 MiB gzipped with parquet, httpfs,
  iceberg and DuckLake. Suitable for small scans only.
- **Containers (H).** GA 2026-04-13. Up to 4 vCPU / 12 GiB / 20 GB ephemeral disk (custom sizes
  since 2026-01); $0.0000025 per GiB-second and $0.00002 per active vCPU-second; 1–3 s cold starts.
  [changelog](https://developers.cloudflare.com/changelog/product/containers/). Community example:
  [tobilg/cloudflare-duckdb](https://github.com/tobilg/cloudflare-duckdb).
- **MotherDuck (H/M).** Hosts DuckLake 1.0 over your own R2 bucket; business tier about $250/month
  plus compute (secondary source). An external option for analysts, not a platform dependency.

## 5. External authentication

- Access service tokens (`CF-Access-Client-Id`/`Secret`) with the Worker validating the
  `Cf-Access-Jwt-Assertion` against a **path-specific** application audience (H).
- [workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider): OAuth 2.1 with PKCE
  and client ID metadata documents; suitable if third-party apps later act for users (H).
- The rate-limiting binding is approximate and per location: abuse control, not quotas (H).
  [docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- API Shield mTLS is available for partner systems (H).

## 6. Erasure in an immutable store

- Iceberg and DuckLake deletes are logical. Physical erasure needs delete, rewrite or compaction,
  snapshot expiry and file removal; R2 Data Catalog does not remove orphaned files, so a sweeper
  is required (H).
- Crypto-shredding (encrypt personal fields with a per-subject key held outside the lake; destroy
  the key) is widely described as acceptable erasure. We did not verify this against regulators'
  own texts (U). [example](https://www.dremio.com/blog/apache-iceberg-and-the-right-to-be-forgotten/)
- Free text (issue descriptions, comments) can contain personal data about anyone, so crypto-shredding
  structured fields is not sufficient on its own. A rewrite procedure is still required.

## 7. Rejected or deferred

| Option | Reason |
| --- | --- |
| Pipelines as the authoritative export | Beta, no idempotency key, append-only, one public corruption report |
| DuckLake catalog in a Durable Object (quacklake) | Alpha; revisit after DuckDB 2.0 stabilises Quack |
| DuckDB-Wasm as the query engine | 128 MB isolate limit |
| Accepting arbitrary client-authored events over the API | Bypasses domain rules; clients send commands, the shard writes events |
| Live cross-shard queries or transactions | Not offered by the live tier; use the lake (minutes stale) or sagas |
