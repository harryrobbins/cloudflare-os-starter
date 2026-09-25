# Records delivery checklist

2026-09-25. **Direction accepted; implementation authorised by the owner.**
This is the live delivery ledger for [Records direction](records-direction.md). Checkboxes require
working code and recorded verification. Unchecked items are not implicitly delivered by the website.

## Locked product direction

Records is a standards-based datastore. Open semantic models are the reference point; database
schemas, apps and independently built SDKs map to them. Supply a complete pinned Schema.org catalogue,
tested application profiles, extension points and a blank-model option. The runtime is Postgres,
PostgREST, explicit transactional commands, a small gateway and a notification relay. Vendor-shaped
interfaces such as Jira or Linear for work, Slack or Matrix for messaging, and Notion or Confluence
for knowledge remain optional adapters. No vendor vocabulary controls the core.

Primary use cases: replace selected enterprise-suite workflows, start a bespoke business system,
and give AI-assisted/vibe-coded apps a reusable domain foundation. More opinionated than assembling
backend primitives; enterprise readiness and scaling claims require evidence, not comparison slogans.

## Delivery boundary

Implement alongside the existing runtime in new `records-model` and `records-service` packages. Keep
old deployment paths and applied migrations intact until compatibility and migration are proven.
Disposable local infrastructure is authorised. Production deployment, production migrations and
identity-boundary changes require their separate concrete operational review. The earlier website
archive remains unchanged for comparison.

Current deployment: [status](records-status.md), [homeserver record](../../../packages/records-service/deploy/homeserver.md).
Next client work: [blueprint adaptation](records-blueprint-adaptation.md), [Records Explorer](records-explorer-blueprint.md).
Both are plans; the existing OS blueprints still use legacy contracts.

## 0. Position and preserve

- [x] Lock the standards-based direction and supersede earlier architecture recommendations.
- [x] Preserve the earlier site; supply a comparison view.
- [x] Broaden new-site vendor examples across work, messaging and knowledge.
- [x] Add enterprise exit, bespoke startup and AI-assisted development use cases.
- [x] Recheck website after copy updates.
- [x] Refresh current status, deployment/legacy documentation and publish the next blueprint plans.
  Work Board/Report adaptation and Records Explorer remain planned; this checkbox denotes documentation only.

## 1. Models and vocabulary

- [x] Vendor a complete pinned Schema.org release with checksum, source and attribution.
- [x] Catalogue lookup retains hierarchy, expected types, status and HTTP/HTTPS aliases.
- [x] Validate profiles, constraints and custom namespaces.
- [x] Supply work, messaging and blank/custom profile examples.
- [x] Map alternate physical shapes to one model; JSON-LD round-trip tests.
- [x] Validate publication metadata and migration checksums.

## 2. Database authority

- [x] Independent migration/bootstrap path; restricted runtime and gateway roles.
- [x] Generic organisation, principal, membership, binding and datastore registry.
- [x] Authenticated PostgREST context with mandatory issuer/audience/expiry and current grants.
- [x] Work and messaging through one generic module dispatch boundary.
- [x] Revisions, idempotency, transactional counter, journal and outbox.
- [x] Runtime cannot write private tables or cross datastore boundaries.
- [x] Rollback, duplicate, conflict and concurrency tests on real Postgres.
- [x] Generic module publication and compatibility checks.

## 3. API and delivery

- [x] Portable HTTP gateway with scoped credentials and internal ES256 tokens.
- [x] Bounded reads, command routes, safe errors, header sanitisation and body limits.
- [x] Authenticated change pull and SSE notification/reconnect path.
- [x] Generic client and app-binding requirement checks.
- [x] Standalone Docker Compose reference stack with generated local credentials.
- [x] End-to-end gateway → PostgREST → Postgres tests, including rejection paths.
- [x] Runtime instructions and implementation-status documentation.

## 4. Qualification and cloudflare-os adoption

Launch preparation and operator inputs are tracked in [Records launch](records-launch.md).

- [x] Separate Cloudflare edge Worker with streaming proxy, narrow headers and fail-closed configuration.
- [x] Website and edge Wrangler dry-runs; optional Worker routes remain disabled. Website/API are live via the homeserver tunnel.
- [x] Pinned OpenTofu origin Tunnel/Access/DNS module with provider validation and mock security tests.
- [x] Gateway file-backed secrets with conflict and malformed-file checks.

- [x] Reusable bridge to the real ApprovalQueue contract: persistent pending commands, exact viewer
  assertions, execution only from applyAction, current-rights rechecks and observer-gated reads.
- [x] Local logical dump/restore rehearsal: 15 tables, 20 rows, content digests and ledgers match.
- [x] Actual PostgREST identity negatives: missing/wrong issuer/audience/expiry, unknown key ID,
  unauthenticated and cross-datastore requests denied.
- [x] Atomic bounded snapshot with sequence and permission epoch; oversized bootstrap rejected.
- [x] Gateway tests cover missed hints, bounded slow consumers, scope revocation and expiry.


- [ ] Actual cloudflare-os viewer-assertion/approval integration and observer checks.
- [ ] Multiple gadgets plus external client convergence under grant changes.
- [ ] Worker HTTP / optional Hyperdrive testing with identity isolation.
- [x] Ten-minute throughput and notification latency report on specified hardware.
- [x] Live lost-hint recovery, LISTEN reconnection, revocation, permission-epoch and expiry tests.
- [ ] Full gateway process restart and sustained slow-consumer/network fault qualification.
- [ ] Redaction/retention, backup restore and upgrade/rollback rehearsals.
- [ ] Production inventory, hosting/region/operator/recovery objectives decided.
- [ ] Existing-data migration rehearsal, staged cutover and production review.

## 5. Attribution and record-level permissions

Design: [Authority, attribution and record-level permissions](records-direction.md#authority-attribution-and-record-level-permissions).
The connector-held credential model was decided by the owner on 2026-09-25.

- [x] Connector holds each datastore credential; the gatekeeper controls reads and command requests
  (`gatekeeper-records-service`).
- [ ] Journal `actor`, server-set `created_by`/`updated_by`, per-binding "may attribute" grant,
  actor in the idempotency digest, attribution in reads and the change feed.
- [ ] Journal append-only trigger; privileged, journalled redaction as the only exception.
- [ ] Connector sends the verified viewer as actor; blueprints show created/changed by.
- [ ] Actor roles (`member`, `admin`, module-defined) held in Records and managed by operator tooling.
- [ ] Module-declared per-entity/per-command rules, server-set ownership and transfer command.
- [ ] Restricted fields and a separate `history.read` right; per-reader filtering of `changes`,
  snapshots and exports; epoch reset on role/ownership change.
- [ ] Connector reads as the actor, with `excludeObservers` for shared gadgets.
- [ ] Acceptance: owner-only edit, owner/admin-only history, no restricted-data leaks to other
  readers or shared-gadget observers, and external bindings obeying the same rules.

## Evidence log

Implementation begins with three delegated workstreams: catalogue/model semantics, SQL authority,
and HTTP gateway/relay. Root owns integration, deployment fixtures, the website and this ledger.
Record commands, outcomes and limitations below as each workstream lands. A working local service
does not establish production readiness or completion of the cloudflare-os cutover.

### Initial implementation evidence (2026-09-25)

- Browser checks pass on 12 website routes at 375, 768 and 1440 pixels: module interactions,
  historical comparison, no horizontal overflow and no JavaScript errors.
- `packages/records-model`: pinned 30.1 source SHA-256
  `07e7c663dbc12a0937581745e59a98ed12b8698f38e8e3b03650287d9df88ae5`;
  3,259 graph nodes / 3,026 Schema.org terms. Model validation, mappings, JSON-LD, catalogue lookup,
  malformed input and publication compatibility tests pass.
- `packages/records-service`: six additive new-service migrations and typed work/messaging modules.
  Real embedded-Postgres tests prove denied direct table access, concurrent duplicates/distinct
  writes, rollback counter reuse, delayed commit ordering, revisions, epochs and current revocation.
- Actual publisher installs independent `records-model/examples/inventory`, replays installation,
  accepts compatible upgrade and rolls back failed migration. No datastore is created by publication.
- `RECORDS_INTEGRATION=1 node --test packages/records-service/test/integration.test.ts` passes
  against the running Compose gateway/PostgREST/Postgres stack. Actual signature and mandatory-claim
  tests also pass inside the gateway container. Source TypeScript check passes.
- Local network probe found Docker's internal network did not publish the host port; the gateway
  now has a separate edge network. Only localhost:8788 is published. Gateway environment contains
  its own restricted database URLs, not the migration credential.
- Whole-stack testing found a PL/pgSQL ambiguous identifier in describe; migration 006 fixes it and
  the database regression now calls that path. JSONB ordering/serialization issues found by the
  publisher test were also fixed before marking publication complete.
- Four bridge lifecycle/security tests prove no execution before approval, immutable intent,
  viewer revalidation and observer exclusions. This is working integration code, not enrollment or
  registration of the live cloudflare-os vendor. That rollout stays unchecked above.
- Restore rehearsal used a uniquely named temporary database and compared content hashes, counts
  and migration ledgers; only that temporary database was removed. It proves local logical recovery,
  not PITR, failover, cross-cluster credentials or backup retention.

- [Authenticated SSE probe](../../../packages/records-service/docs/benchmark-sse.md): 30 serial
  commands on an isolated datastore produced 30 hints plus the initial frame, with no extra periodic
  frames. Request-start-to-SSE p50/p95/p99 were 28.676/38.353/43.009 ms. These are upper bounds on
  post-commit relay latency, not exact commit timestamps or a sustained subscriber-load test.

- [Ten-minute HTTP benchmark](../../../packages/records-service/docs/benchmark.md): 35,840
  successful commands over 600.029 seconds (**59.73/s**), zero request errors and zero missing
  correlated LISTEN hints. The 60/s scheduler skipped 160 requests at the concurrency cap of 16;
  those skips are retained in the report. HTTP response-header p50/p95/p99: 28.835/37.185/48.704 ms.
  Request-start-to-post-commit-LISTEN p95: 35.677 ms, an upper bound rather than exact commit latency.
  Host: Intel Core Ultra 7 155H, 11 logical CPUs visible, 22.5 GiB RAM, no container CPU/memory cap.
  This passes the provisional local 50/s gate; it is a warm, rate-limited test, not maximum capacity
  or a production SLA. Sanitized machine evidence is in ignored `.eval/benchmark.json`.

- Live operator-only relay integration passed against the running stack: disconnect a subscriber,
  create three records, recover all from the durable journal, terminate/reconnect the actual local
  LISTEN backend, receive the next notification, revoke read scope and close the existing stream,
  reject stale epochs after regrant, and reject expired credentials. Actual PostgREST identity
  negatives also passed again. This covers listener connection restart, not full process/network
  fault qualification; slow-consumer bounds have separate unit coverage.
- Gateway mount audit found that a read-only whole-package bind exposed the local migration secret
  file. Runtime mounts now contain only source, dependencies, package metadata and its signing key;
  the `operator` tools-profile service owns development fixtures and privileged operations. After
  recreating the gateway, direct checks confirmed `compose.env`, `client.json` and migration scripts
  are unavailable inside it, while health and the live tests pass.

### Known implementation scope

Current commands each change one record. Multi-record transactions, delete/tombstones,
redaction/retention, webhook dispatch, streaming large snapshots and full legacy migration remain
unfinished. The outbox checkbox denotes durable transactional markers, not webhook delivery.
The custom ontology is an executable third module, not a compatibility adapter for a vendor.
Enterprise scalability is a testable requirement, not an unqualified marketing claim.
