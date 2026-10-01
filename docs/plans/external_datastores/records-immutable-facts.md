# Records as an immutable fact store

2026-09-26 · **Proposed target architecture for Records storage, sync and performance.** Not yet
accepted by the owner and not implemented. It amends the storage, write, sync and history sections
of [Records: a standards-based datastore](records-direction.md). The product direction there is
unchanged: standards-based models, profiles, mappings, permissions and optional adapters. This
document supersedes the optimisation roadmap in
[records-performance-ideas.md](../../research/records-performance-ideas.md). It keeps that document's
measurement harness, environments and experiment protocol, and every phase below uses them. It also
takes up the immutable idea from the [immutable datastores plan](immutable-datastores.md), which was
not pursued, but keeps Postgres as the strongly consistent authority rather than moving truth to a
lake.

Source: Michael L. Perry, *The Art of Immutable Architecture* (Apress, 2020). Chapter numbers below
refer to that book. The current implementation is described in [current status](records-status.md),
[the SQL boundary](../../../packages/records-service/sql/README.md) and the
[delivery checklist](records-delivery.md).

## 1. Outcome

Every write to a Records datastore becomes one or more **immutable, content-addressed facts** with
explicit predecessors. The fact graph is the only source of truth. Current state, presentation
views, history, change feeds, outbox work and reports are **projections** derived from facts in the
same transaction. Truth tables accept `INSERT` only.

The following become properties of the data model rather than separate mechanisms:

- **Idempotency.** A retried write produces the same fact hash and stores nothing new.
- **Conflict detection.** Concurrent edits appear as several unsuperseded versions instead of lost
  updates.
- **Entity history.** History is the chain of successors of an entity fact.
- **Stable bootstrap and pagination.** Facts never change, so pages over them never shift.
- **Deletion and restore.** Both are recorded as facts (tombstones), not by removing rows.
- **Precise cache invalidation.** An inverted query tells each subscriber exactly what a new fact
  affected.
- **Offline-capable clients.** Clients can record facts locally and upload them later.

The server stays the **central authority** that Perry says a historical model needs for uniqueness,
availability and aggregation (chapter 2, "Limitations"). The owner decided Records must be a strongly
consistent source of truth, and that still holds. Clients propose facts; Records authorises,
validates, orders and publishes them.

```text
client / adapter ──facts (topologically ordered batch)──▶ gateway
                                                           │ verify hash, authorise on receipt
                                                           ▼
             records_facts.fact + edge  (INSERT only, per-datastore feed position)
                                                           │ same transaction
            ┌──────────────────┬───────────────┬───────────┴────────┬────────────────┐
            ▼                  ▼               ▼                    ▼                ▼
   current-state tables   presentation   decision facts      outbox queue      NOTIFY hint with
   (managed indexes)      views + RLS    (uniqueness etc.)   (managed index)   affected subscriptions
```

## 2. The ideas taken from Perry

| Idea (chapter) | Rule for Records |
| --- | --- |
| Historical facts (2, 3) | A fact records a decision. Its identity is its fields plus the identities of its predecessors. It is never updated or deleted. |
| Partial order (2, 4) | Predecessors express causality. Unrelated facts commute; only causally related facts need order. |
| Location-independent identity (4, 10) | A fact is identified by the hash of its canonical form, never by a database-allocated ID. Surrogate `bigint` keys never leave the database. |
| Idempotence and commutativity (4) | Storing a known fact is a no-op, and arrival order does not change the result. This gives strong eventual consistency without consensus. |
| Structural patterns (8) | Entity, Ownership, Delete/Restore, Membership, Mutable Property and Entity Reference replace CRUD rows. |
| Workflow patterns (8) | Transaction, Queue, Period and Outbox replace state flags and mutable status machines. |
| Query inverses (9) | For each new fact, compute which queries it affects and what to add or remove. Caches are sets. |
| SQL storage (10) | `INSERT … ON CONFLICT DO NOTHING`. Integer keys internally, hashes externally. Predecessor foreign keys are indexed. Queries start from a known fact and walk edges. `NOT EXISTS` waste is removed with managed indexes. |
| Application-agnostic store (10) | Generic `type`, `version`, `fact` and `edge` tables. Types are versioned by structural hash, not sequential number. |
| Communication (11) | Fact batches in topological order with the transitive closure of predecessors. Bookmarks are held by clients. Subsets are the cone of successors below a root. |
| Security (7) | Authorisation rules run when a fact is received, never retroactively. Confidential facts are kept out of distribution. Revocation is itself a fact and needs care. |
| Projections and interest (12) | Declarative projections compile into single pipelines, avoiding N+1 queries. A client's interest set determines what it receives, and tombstones stay in the interest set. |

Perry's limits also apply, and Records keeps a static, centrally locked model for them:

- **Uniqueness:** unique keys, slugs, one active assignment.
- **Availability and capacity:** for example, only one person may hold a lock.
- **Closed aggregates:** period totals and "sprint closed".

These use a **request fact** followed by a **decision fact** issued by the server. An online caller
gets the decision in the same HTTP response, so the user experience is the same as today.

## 3. Mapping the current service onto facts

| Current Records (from [the SQL boundary](../../../packages/records-service/sql/README.md)) | Perry equivalent | Change |
| --- | --- | --- |
| Datastore row `datastores(id, …)` | Root **Entity** fact that owns every other fact in the datastore (Ownership) | Tenancy becomes part of every hash. `datastore_id` stays as a denormalised column for RLS and partitioning. |
| Record `id uuid` (client-supplied or `gen_random_uuid()`) | **Entity** fact `{datastore, type, id}` | The client always supplies the UUID, so the entity hash is known before the network call. The server-generated fallback is removed from fact-native writes. |
| Typed mutable module tables (`records_work.items`, 010 entities) | Projections: Perry's "managed index" and "static model" (chapter 10, *Integration*) | These are kept for fast reads but become derived. They are written only by projectors, in the write transaction, and can be rebuilt from facts and checked against them. |
| Journal row with a full JSONB snapshot per command | **Mutable Property** facts, one per *property group*, each with a `prior` set | Stores changed groups rather than whole records. Identical values deduplicate by hash. History becomes graph traversal. |
| `revision` equal to the datastore `seq`, with gaps | Hashes of the current leaves (the `prior` set) | The precondition becomes "I saw these versions". The ETag is a digest of the leaf hashes. |
| `If-Match`, PT412 on a stale revision | A `prior` that is not the current leaf set | Per-property policy, see section 5: *guarded* rejects as PT412 does today; *fork-tolerant* accepts and exposes several leaves. |
| Idempotency table (key, digest, full result) | Content addressing: the same fact gives the same hash, and `ON CONFLICT DO NOTHING` | Retired for fact-native writes. It remains only for legacy and REST-adapter commands whose effects are not deterministic. |
| Datastore row lock plus `seq` counter | Server **feed position** used as a client bookmark (chapter 11) | The counter covers only publication order, not validation. See section 6. |
| Outbox marker `(datastore_id, seq)` | **Outbox** pattern: a queue query for facts with no `Delivery` successor, plus a journal keyed by fact hash | Pending work is held in a managed index (partial index or queue table), not an anti-join over all history. |
| No deletes; `archived` / `active:false` flags | **Delete** / **Restore** facts carrying a distinguishing `deletedAt` | Adds a tombstone protocol. Tombstones are never purged (chapter 12, "lingering objects"). |
| No multi-record commands | **Transaction** fact whose predecessors are the item facts; fact batches | A multi-record change arrives as one fact that commits atomically. |
| Snapshot capped at 5,000, PT413 beyond | Pages of immutable facts in feed order, or a projection snapshot with a watermark | Removes the bootstrap barrier, see section 7. |
| SSE `event: changes` hint with no payload | **Query inverses**: an affected-set hint per subscription, optionally with fact hashes | Clients fetch only what changed, or apply it directly. |
| Permission epoch reset | Authorisation on receipt for writes; distribution rules for reads | Epoch reset stays as the revocation mechanism for cached reads (section 8). |
| Generic `records_private.records` projection (written, unread) | Replaced by the generic `fact`/`edge` store | Retire it. It is the first removal in either plan. |
| Module `api_major`, semver profiles, `validateUpgrade` | **Structural version hash** per fact type (chapter 10, *Versioning*) | Old facts keep their shape. Extensions add successor types rather than using `ALTER`. API majors remain a presentation concern. |
| 010 backfill that wrote rows without journalling | Not possible: projections come only from facts | Future backfills are fact-producing *scanners* (chapter 10, *Legacy Application Integration*). |

### Schema.org profiles become fact types

The four-layer model in [records-direction.md](records-direction.md#standards-application-profiles-and-mappings)
fits this directly:

- A profile class (for example `schema:Action`, or a work item profiled from `schema:CreativeWork`)
  generates an **Entity** fact type holding only identifying fields.
- Datatype properties become **Mutable Property** fact types, grouped by the profile's
  *change-together* sets. An address is one group; `name` and `description` are separate groups.
- Object properties whose range is a `Thing` become **Entity Reference** facts. Many-valued
  properties become **Membership** facts.
- Deletion, status and workflow become **Delete**, **Queue** and **Transaction** facts, not properties.
- Storage mappings still describe the physical projection tables, JSON-LD export and SDK shapes.
  Facts are the canonical layer, and mappings are views over them.

The profile is then the only schema a module author writes. Fact types, structural version hashes,
projection DDL, presentation views and inverse-derived subscriptions are all generated from it. This
is Perry's "immutable runtime" (chapter 12) and the "generated behaviours" Records already aims for
with profiles and mappings.

## 4. Physical design in Postgres

Truth lives in an application-agnostic schema (chapter 10) and is shared by every module:

```sql
CREATE TABLE records_facts.fact_type (
  type_id     int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE              -- e.g. 'work.Item', 'work.Item.title'
);
CREATE TABLE records_facts.fact_version (
  version_id  int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type_id     int NOT NULL REFERENCES records_facts.fact_type,
  shape_hash  bytea NOT NULL UNIQUE             -- structural hash of fields + roles
);
CREATE TABLE records_facts.role (
  role_id     int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  declaring_type_id int NOT NULL REFERENCES records_facts.fact_type,
  target_type_id    int NOT NULL REFERENCES records_facts.fact_type,
  name        text NOT NULL,
  UNIQUE (declaring_type_id, name)
);
CREATE TABLE records_facts.fact (
  fact_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- never leaves the database
  datastore_id uuid   NOT NULL,                 -- denormalised root, for RLS and partitioning
  version_id   int    NOT NULL REFERENCES records_facts.fact_version,
  hash         bytea  NOT NULL,                 -- SHA-256 of canonical form, 32 bytes
  fields       jsonb  NOT NULL,
  feed_pos     bigint NOT NULL,                 -- per-datastore publication order (section 6)
  UNIQUE (datastore_id, hash)
);
CREATE TABLE records_facts.edge (
  successor_id   bigint NOT NULL,
  role_id        int    NOT NULL,
  predecessor_id bigint NOT NULL,
  PRIMARY KEY (successor_id, role_id, predecessor_id)
);
CREATE INDEX edge_down ON records_facts.edge (predecessor_id, role_id) INCLUDE (successor_id);
CREATE TABLE records_facts.receipt (              -- audit, outside identity
  fact_id bigint NOT NULL, actor text NOT NULL, principal_id uuid, binding_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(), request_id text
);
```

The design decisions and the reasons for them:

- **Canonical form and hash.** Use JSON Canonicalization Scheme (RFC 8785) over
  `{type, fields, predecessors: {role: [sorted hashes]}}`, hashed with SHA-256.
  - Perry's collision estimate (chapter 10) for 2^30 facts is about 1 in 2^197. SHA-256 halves
    the index width of Perry's SHA-512 example.
  - Hashes are stored as `bytea`, not base64 text, which saves a third in index size.
  - Clients compute the hash, and the server recomputes and verifies it before insert. One shared
    TypeScript implementation lives in `packages/records-model`, with golden vectors checked in
    SQL.
- **Surrogate keys inside, hashes outside.** Chapter 10's performance rule is followed:
  - Joins and indexes use `bigint`.
  - The primary key is append-ordered.
  - The unique hash index takes random inserts, so measure its WAL and page-split cost.
- **Audit outside identity.** Actor, time and request ID go in `receipt`, which may hold several
  rows per fact. Two users setting the same value produce one fact and two receipts, not a spurious
  conflict (chapter 8, *Mutable Property* consequences). Account attribution is preserved.
- **Identity includes a distinguishing field where repetition is meaningful.** Examples are
  comments, deletions, memberships and grants, which carry a client-generated UUID or `createdAt`.
  Plain property values do not.
- **INSERT only.** Runtime roles get `INSERT` and `SELECT` on truth tables. Triggers refuse
  `UPDATE`, `DELETE` and `TRUNCATE`, as the journal does today (`007:58-61`). Redaction is the
  privileged exception in section 8.
- **Projections are generated per module**, for example `records_work.items`. They keep today's
  typed columns, RLS and presentation views, with a `fact_id` or leaf hash for each property group.
  A projector function per fact type updates them in the write transaction.
  - This is Perry's managed index. It avoids a `WHERE NOT EXISTS` anti-join over every superseded
    version on each read.
  - Because projections are derived, `rebuild_projection(datastore)` plus a content hash of the
    result is a correctness test and a recovery tool.

## 5. Concurrency semantics

Perry's Mutable Property never rejects: concurrent edits create several leaves, and the result is
resolved on read, deterministically, or later by the user. Records has a central authority, so each
property group in a profile declares one of two policies:

| Policy | Server behaviour | Use for |
| --- | --- | --- |
| **guarded** (default at first, matching today's PT412) | Reject when the fact's `prior` is not the current leaf set | Fields whose invariants the server enforces; compatibility with current clients |
| **fork-tolerant** | Accept. The projection stores all leaves; presentation resolves them with a deterministic function, or the client shows candidates | Descriptive text, labels, offline edits, agent suggestions |

Rules taken from chapter 8:

- Never generate a fact automatically to resolve a fork. Only a user or agent decision creates one,
  which prevents resolution storms.
- Resolution functions depend only on the facts, never on arrival order.
- Check for a real change before emitting a property fact.
- Frequently changing state such as status, progress or assignee is not a Mutable Property. Model it
  as workflow (Queue, Transaction) so each step is a new fact type, or keep a projection column
  maintained by the projector. Chapter 10 shows that `NOT EXISTS` waste on fast-changing properties
  tends towards 100%.

Uniqueness and other global invariants use a **Request → Decision** pair. The decision is taken
under a lock on a static uniqueness table (for example `(datastore_id, key) UNIQUE`) and recorded as
a fact.

## 6. Ordering and the write path

The current write path locks the datastore row before any validation, so every write to one
datastore is serialised (records-performance-ideas §1). With facts:

1. The gateway receives a batch. It checks the hashes, sorts the batch topologically, and rejects
   dangling predecessors unless they already exist.
2. Each fact is authorised on receipt. The rules are the current binding, scope, actor and row
   policies expressed over the fact's predecessors. Guarded preconditions are checked.
3. `INSERT … ON CONFLICT DO NOTHING` into `fact`, then `edge`, `receipt` and the projectors. Facts
   that are already stored return their existing hash, so a retry is a no-op by construction.
4. The per-datastore **feed position** is allocated and the hint is emitted.

Only step 4 must be serialised. Facts about different entities commute, so steps 1–3 can run
concurrently for one datastore. Guarded properties need a row lock only on the entity projection
being changed, not on the datastore. Two candidate feed designs, both to be proved with the
delayed-writer tests in [performance Phase G](../../research/records-performance-ideas.md#phase-g--redesign-concurrency-only-if-the-lock-is-the-limiter):

- **Tail lock.** Keep the transactional per-datastore counter, but take the datastore row lock as
  the last statement before commit. The critical section shrinks to one `UPDATE` and the commit. It
  preserves the existing no-skip argument.
- **Transaction-ID watermark.** Record `pg_current_xact_id()` on each fact. A pull returns only
  rows whose transaction is older than `pg_snapshot_xmin(pg_current_snapshot())`, and the feed
  position is assigned when the fact is published. This removes the per-datastore lock but adds a
  visibility lag bounded by the oldest open write transaction.

Do not use `nextval()` on its own with `seq > cursor`. Perry points out (chapter 11) that
allocation order is not commit order, and the performance plan forbids it for the same reason.

Bookmarks follow chapter 11:

- They are opaque and bound to a datastore and a permission epoch. They are per database, so a
  failover causes a re-download with deduplication rather than silent loss.
- A client that has just uploaded facts sends their hashes with its next pull, so the server does
  not send them back.

## 7. Reads, bootstrap and live updates

- **Current reads** stay on projections and presentation views, so the read benchmarks in
  `benchmark-views.md` remain the baseline. The projection pipeline (chapter 12) compiles a
  list-plus-properties request into a single query, as the presentation views already do.
- **Entity history** is `edge_down` from the entity fact, joined through the property facts. It
  needs no extra journal index.
- **Bootstrap without a size cap.** Two options:
  - *Fact bootstrap*: page through the datastore's facts in feed order, or through a subset cone,
    and let the client build its projection. Pages over immutable rows are stable, and writes
    during the bootstrap simply appear later in the feed.
  - *Projection bootstrap*: page the projection by key under a recorded feed watermark, then
    replay facts after the watermark. Mid-bootstrap edits are safe because replaying a fact is
    idempotent.

  Either option replaces the PT413 rejection and the need for a long-lived database snapshot
  (performance Phase D).
- **Subsets** are the cone of successors below a root (chapter 11), with the transitive closure of
  predecessors, for example one project or one channel. Each subset has its own bookmark, which
  suits gadgets that show one board.
- **Live updates.** Each subscription registers its projection. On commit, the relay inverts the
  pipeline for each new fact type and sends only affected subscriptions a hint carrying the new fact
  hashes (chapter 9). Client caches store result sets and apply set union or difference, falling
  back to a pull. The hint still carries no private payload, and authorisation still happens on
  pull.
- **Caching.** A fact never changes, so `GET /v1/facts/{hash}` can be served with
  `Cache-Control: immutable` behind authorisation. Browser IndexedDB stores facts by hash. Read
  replicas are safe for fact reads, because a replica can only lack a fact, never hold a wrong one.
  Read replicas are still unsafe for authorisation decisions.
- **Reports and aggregates** use separate projections, which chapter 10 calls reporting databases.
  Bound queues and history with the **Period** pattern (chapter 8), for example cycles or
  months, so a query for open work does not scan all history.

## 8. Security, revocation and erasure

- **Authorisation on receipt** (chapter 7). A fact accepted under the rights in force is never
  invalidated when rights change later. Past work by a removed member remains valid. This matches
  the current requirement to re-authorise at application time.
- **Read distribution** remains in RLS and the presentation views. Fields masked for some readers
  are separate property-group fact types, so a masked group is never distributed at all. This is
  simpler than masking inside a whole-record snapshot, as the `people` history view does now.
- **Revocation.** Records is central, so a revocation fact and an epoch bump are consistent at the
  server. Perry's warning about revocation (chapter 7) applies only to offline clients. Those
  clients must treat locally created facts as pending until the server acknowledges them.
- **Erasure.** Immutability conflicts with the right to erasure, so personal data is kept apart from
  identity:
  - Facts that carry personal data include a random salt field, so the hash cannot be guessed from
    the content.
  - Their `fields` may move to an erasable `fact_payload` table, optionally encrypted with a key per
    data subject (crypto-shredding).
  - Erasure deletes the payload and records an `Erasure` fact, and the hash stays as an opaque
    identifier. This is the only privileged non-INSERT operation. It is audited, and it means
    erased facts can no longer be re-verified.
  - Do not claim tamper resistance against the database operator (records-direction). The hash DAG
    detects accidental or partial corruption and supports verified export, nothing more.

## 9. Performance: what this buys and costs

| Area | Expected effect | Evidence required |
| --- | --- | --- |
| Truth-table writes | Append-only heap, no dead tuples, no UPDATE WAL on history. Insert-triggered autovacuum only (PG13+) for visibility and freezing | WAL bytes and relation growth per logical write versus the current journal and snapshot |
| Journal size | Property groups replace whole-record snapshots. Duplicate values deduplicate | Bytes per mutation by payload tier and version depth |
| Idempotency table | Removed for fact writes. No stored result per command | Retry correctness suite; storage saved |
| Hot datastore | Validation runs concurrently. Only publication is serialised (section 6) | Hot-datastore versus balanced throughput; lock hold time |
| Hash cost | One SHA-256 per fact on client and server, plus a unique `bytea(32)` index | CPU per fact; index WAL and page splits |
| Projection upkeep | About the same as today's typed-row update. The generic `records` upsert is removed | Write latency A/B |
| Anti-join waste | Avoided by projections and managed indexes for current values, tombstones and queues | Plans under the real RLS roles |
| Bootstrap | Unbounded and stable pages; no long snapshot | Working-set tier bootstrap with concurrent writes |
| Fan-out | Hints only to affected subscriptions; direct apply avoids pulls | Pulls per write and convergence time at 10/100/1,000 subscribers |
| Growth | Facts are kept for good. Cold facts can be *copied* to R2 Parquet for analytics, never moved off the truth store | Daily growth model; 500 GB qualification |
| Partitioning | Hash-partition `fact` and `edge` by `datastore_id`. The root is in every identity, so no cross-partition uniqueness is needed | Only when the large-tier triggers in the performance plan fire |

All claims above are hypotheses. Each one runs through the environments, harness, dataset tiers,
correctness suite and A/B protocol in
[records-performance-ideas.md §2–6, §8–9](../../research/records-performance-ideas.md). A faster
result that fails an invariant is rejected.

## 10. Migration plan

Each phase keeps the current API working and follows the [delivery checklist](records-delivery.md)
gates. No legacy runtime cutover is implied.

1. **Specify.** Canonical form, hash, fact envelope, structural version hash and profile-to-fact-type
   generation go in `packages/records-model`, with golden vectors shared by TypeScript and SQL.
   The owner decides the open questions in section 11.
2. **Baseline.** Run performance Phase A on the current service. Remove the unread generic
   `records` projection write (performance Phase B).
3. **Shadow facts.** `execute_command` also writes facts, edges and receipts in the same
   transaction. A **scanner** converts the existing journal snapshots into Entity and property
   facts with `prior` chains (chapter 10). Unjournalled 010 backfill rows become scanner-produced
   facts attributed to the migration.
4. **Prove equivalence.** Rebuild projections from facts and compare content hashes with the live
   typed tables across the full correctness suite.
5. **Fact-native API.** Add `POST /v1/datastores/{id}/facts`, which takes batches in topological
   order, plus the fact and bookmark pull endpoints. The existing command RPCs become adapters that
   generate facts ("Emulating REST", chapter 11). The idempotency table stays only for adapter
   commands.
6. **Switch history and sync.** Move `pull_changes`, history views and SSE hints to facts,
   bookmarks and inverse-derived hints. Add tombstones and transactions.
7. **Retire.** The journal, outbox markers and the idempotency table for fact writes. Enforce
   INSERT-only on truth tables.
8. **Optimise on evidence.** Feed ordering (section 6), partitioning, a cold R2 copy, edge caching,
   and offline clients if they are in scope.

## 11. Decisions needed

- Accept facts as the canonical layer, with typed tables as derived projections.
- Choose the default concurrency policy per module: guarded for everything at first, or
  fork-tolerant for descriptive fields in `work` and `messaging`.
- Decide whether offline-first clients are in scope. The [canonical plan](canonical-postgres-datastore.md)
  ruled out offline merging, but this model makes it safe.
- Confirm SHA-256 and RFC 8785, and whether fact hashes appear in public URLs alongside entity UUIDs.
- Set the erasure policy for personal data: salted hashes plus an erasable payload, with or without
  encryption.
