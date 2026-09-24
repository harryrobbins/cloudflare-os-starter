# External datastores: research

Evidence, code traces and rejected options behind the plans in
[`../../plans/external_datastores/`](../../plans/external_datastores/README.md). Each document records
its own date, source revision and confidence levels.

## Overview

The research went through four questions, in this order:

1. **Can a gadget be reached from outside, or share its data?** Only through a gatekeeper. Gadgets
   are sandboxed Durable Object facets with no network, no inbound HTTP and no gadget-to-gadget
   bindings.
2. **Where should shared business data live?** In Postgres behind a domain service, with the platform
   supplying identity, approvals and live delivery. That is the deployed Records service.
3. **Could gadget storage simply be mirrored into Postgres, or everything moved into an immutable
   lake?** Both work for reporting but make something other than Postgres the source of truth. Neither
   was chosen.
4. **What does the canonical version look like?** A per-datastore commit-ordered journal, row-level
   security by principal, delegated tokens from the platform, Replicache-style optimistic sync,
   and a REST API per module tailored to its data model. The Projects module's API follows Jira.

## Documents

| Document | Supports | What it covers |
| --- | --- | --- |
| [canonical-postgres-datastore-research.md](canonical-postgres-datastore-research.md) | Canonical plan | Immutable history in OLTP Postgres (journal, PG18 temporal keys), commit-ordered cursors, Replicache/Zero status and protocol, realtime without replication, the Jira Cloud REST v3 surface and clients, RLS from JWTs, Cloudflare Access for SaaS, delegation, Hono and Workers placement |
| [organisation-datastores-decisions.md](organisation-datastores-decisions.md) | Organisation datastores plan | Decisions for the deployed Records service: domain service, publication versus provisioning, registry, trusted caller and observers, RLS, outbox correction, Neon and Hyperdrive, Phase 0 evidence |
| [gadget-postgres-mirror.md](gadget-postgres-mirror.md) | Canonical plan (rejected option) | Whether blueprints could tick "backed by Postgres": how gadget storage works, where change capture could sit, mirror and sync-engine options |
| [immutable-datastores-lakehouse.md](immutable-datastores-lakehouse.md) | Immutable datastores plan (not pursued) | Durable Objects as event-sourced shards, Iceberg on R2 Data Catalog, DuckLake, Pipelines, DuckDB on Containers, erasure in an immutable lake |
| [gadget-http-api-options.md](gadget-http-api-options.md) | Gadget HTTP API plan | Ways to give one gadget a REST interface: `/api` Cap'n Web, a gatekeeper with hook delivery (recommended), rejected direct options |
| [gadget-http-api-recommendations.md](gadget-http-api-recommendations.md) | Gadget HTTP API plan | Review of that plan: P0 gates, a path-specific Access boundary, idempotency and deadline semantics, token lifecycle, route manifests and OpenAPI |
| [gadget-connectors-and-services.md](gadget-connectors-and-services.md) | All | Inter-gadget connectivity, data connectors and service APIs; why services are gatekeepers, not gadgets |
| [external-api-plan-A.md](external-api-plan-A.md) | Historical | Superseded analysis of Postgres as the system of record with PostgREST |

## Not in this folder

- [gadget-viewer-identity.md](../gadget-viewer-identity.md): how gadgets learn the signed-in viewer,
  which led to viewer assertions.
- [upstream-gatekeeper-credentials.md](../upstream-gatekeeper-credentials.md): credential boundaries
  for every upstream gatekeeper.
- `packages/records-schema/migrations/0001_roles_and_registry.sql` still names the decisions record at
  its old path, `docs/research/organisation-datastores-decisions.md`. It is deliberately left alone:
  the migration runner verifies checksums of applied migrations.
