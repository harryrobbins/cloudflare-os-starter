# Records: research archive

The current direction is [Records: a standards-based datastore](../../plans/external_datastores/records-direction.md).
The service is implemented in [records-service](../../../packages/records-service/README.md) and is
available at [records.surprisingly.ltd](https://records.surprisingly.ltd). The
[delivery checklist](../../plans/external_datastores/records-delivery.md) records verified capabilities
and remaining work; the [homeserver deployment record](../../../packages/records-service/deploy/homeserver.md)
records the deployed release and its operational limits. The product site source remains in
[sites/records](../../../sites/records/README.md).

All earlier Records architecture recommendations below are **superseded**. Their code traces and
measurements remain historical evidence. The earlier Projects packages, gatekeeper and project
blueprints have not been migrated to the new service. Their routes, token formats, database migrations
and runbooks are not interchangeable with the new PostgREST deployment; an earlier Node or SQL
component being portable does not establish that compatibility.

Gadget HTTP studies describe a separate feature, not the specification for the current service.
Use the current service and deployment documentation for operations. Archived deployment-state claims
must be checked against their own environment and date rather than treated as current facts.

## Documents

| Document | Supports | What it covers |
| --- | --- | --- |
| [canonical-postgres-datastore-research.md](canonical-postgres-datastore-research.md) | Historical canonical plan | Immutable history in OLTP Postgres (journal, PG18 temporal keys), commit-ordered cursors, Replicache/Zero status and protocol, realtime without replication, the Jira Cloud REST v3 surface and clients, RLS from JWTs, Cloudflare Access for SaaS, delegation, Hono and Workers placement |
| [organisation-datastores-decisions.md](organisation-datastores-decisions.md) | Historical organisation datastores plan | Decisions for the earlier Projects service: domain service, publication versus provisioning, registry, trusted caller and observers, RLS, outbox correction, Neon and Hyperdrive, Phase 0 evidence |
| [gadget-postgres-mirror.md](gadget-postgres-mirror.md) | Historical canonical plan (rejected option) | Whether blueprints could tick "backed by Postgres": how gadget storage works, where change capture could sit, mirror and sync-engine options |
| [immutable-datastores-lakehouse.md](immutable-datastores-lakehouse.md) | Immutable datastores plan (not pursued) | Durable Objects as event-sourced shards, Iceberg on R2 Data Catalog, DuckLake, Pipelines, DuckDB on Containers, erasure in an immutable lake |
| [gadget-http-api-options.md](gadget-http-api-options.md) | Gadget HTTP API plan | Ways to give one gadget a REST interface: `/api` Cap'n Web, a gatekeeper with hook delivery (recommended), rejected direct options |
| [gadget-http-api-recommendations.md](gadget-http-api-recommendations.md) | Gadget HTTP API plan | Review of that plan: P0 gates, a path-specific Access boundary, idempotency and deadline semantics, token lifecycle, route manifests and OpenAPI |
| [gadget-connectors-and-services.md](gadget-connectors-and-services.md) | Background | Inter-gadget connectivity, data connectors and service APIs; why services are gatekeepers, not gadgets |
| [external-api-plan-A.md](external-api-plan-A.md) | Historical | Superseded analysis of Postgres as the system of record with PostgREST |

## Not in this folder

- [gadget-viewer-identity.md](../gadget-viewer-identity.md): how gadgets learn the signed-in viewer,
  which led to viewer assertions.
- [upstream-gatekeeper-credentials.md](../upstream-gatekeeper-credentials.md): credential boundaries
  for every upstream gatekeeper.
- `packages/records-schema/migrations/0001_roles_and_registry.sql` still names the decisions record at
  its old path, `docs/research/organisation-datastores-decisions.md`. It is deliberately left alone:
  the migration runner verifies checksums of applied migrations.
