# Legacy Records database schema

> **Legacy implementation; not migrated.** This package still targets the earlier Projects runtime.
> The standards-based service is implemented separately in [records-service](../records-service/README.md)
> and is deployed at [records.surprisingly.ltd](https://records.surprisingly.ltd).
> See the [current direction](../../docs/plans/external_datastores/records-direction.md) and
> [homeserver deployment record](../records-service/deploy/homeserver.md).
> Routes, credentials, schemas, sync and operator steps below apply to this legacy implementation;
> they are not a deployment or migration runbook for the current service.

Migrations, bootstrap tools and test helpers for the earlier runtime. Preserve applied migration checksums. These migrations are not the schema installer for the current service, and running them does not migrate legacy data into it.

Existing source, tests and historical API contracts remain available here for maintenance and
migration analysis. No package rename, runtime replacement or data migration is implied by this notice.
