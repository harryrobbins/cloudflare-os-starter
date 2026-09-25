# Records: current implementation and deployment

Updated 2026-09-25. This is the current status summary; the [delivery ledger](records-delivery.md)
holds qualification evidence and the [deployment record](../../../packages/records-service/deploy/homeserver.md)
holds exact release/image identifiers. Historical plans describe the earlier runtime.

## Running today

`https://records.surprisingly.ltd/` serves the product website, docs, preserved comparison and
the new `/v1/` API. The owner-published Cloudflare Tunnel reaches the Node gateway on the homeserver
`ms`, under `~/containers/records`. Postgres (`db:5432`) and PostgREST (`postgrest:3000`) are private
Compose services. Data persists in `records-server_records-data`; application releases are
content-hashed and retained separately. No Neon or Hyperdrive is used by this deployment.
The optional edge Worker passed a dry-run but has not been deployed.

Website, docs, comparison, model metadata and browser interactions passed live checks.
Unauthenticated datastore requests return 401. Public metadata and website requests currently
succeed without an Access token; no claim is made that an Access service-token policy protects
the whole hostname. A tunnel connector token is separate from Access and Records credentials.

The last checked deployment contained six migrations and no provisioned datastores. That is a
dated observation, not a promise about future data. Existing legacy Records data was not migrated.

## Implemented versus planned

| Area | Current evidence | Still needed |
| --- | --- | --- |
| Vocabulary | Pinned Schema.org 30.1 catalogue, 3,026 terms | Stable published namespaces/licensing policy for custom profiles |
| Models | Work and messaging; inventory publication example tested locally | Rich project relationships, documents, visual model authoring |
| API | Scoped credentials, reads, commands, revisions, idempotency, JSON Schema, constrained JSON-LD, OpenAPI | Tenant/admin provisioning and discovery APIs, general query language |
| Sync | Atomic snapshot up to 5,000 records; sequence plus permission-epoch pull; SSE hints | Larger stable snapshots, deletions/tombstones, full process/network failure matrix |
| Writes | One record per command; transactional journal/counter/outbox markers | Multi-record commands, erasure/retention, webhook delivery |
| OS integration | Client, viewer-verifier/broker seams, tested ApprovalQueue bridge | Live vendor enrollment, credential broker, configurator, observer implementation, gadget rollout |
| Blueprints | Existing project board/report use legacy Projects contracts | Work blueprint adaptation and generic explorer; plans below |
| Operations | Pinned images, Compose, checksummed releases; local logical restore | Off-host backups, PITR/recovery objectives, rotation, monitoring, business-data qualification |

Local qualification measured 35,840 successful commands in ten minutes (59.73/s), zero request
errors and 160 load-generator capacity skips. HTTP-header p95 was 37.185 ms; a separate 30-command
SSE probe measured a 38.353 ms request-start-to-hint p95 upper bound. These describe the recorded
local machine/workload, not homeserver capacity or an enterprise SLA. See the
[benchmark](../../../packages/records-service/docs/benchmark.md) and
[SSE report](../../../packages/records-service/docs/benchmark-sse.md).

## Next delivery

1. [Adapt a project blueprint](records-blueprint-adaptation.md): canonical work data first, Jira
   as a worked mapping example and Linear as another optional adapter. Complete live OS integration
   before sending real user writes.
2. [Build the Records Explorer blueprint](records-explorer-blueprint.md): model and data inspection
   first, approved commands later, with no owner credential or arbitrary SQL interface.
3. Complete operational qualification before relying on the homeserver for business data.

The blueprint documents are new plans, not delivered features. Complete their shared connector
work once, with both clients proving the same authority boundary.
