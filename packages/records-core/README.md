# Legacy Records TypeScript core

> **Legacy implementation; not migrated.** This package still targets the earlier Projects runtime.
> The standards-based service is implemented separately in [records-service](../records-service/README.md)
> and is deployed at [records.surprisingly.ltd](https://records.surprisingly.ltd).
> See the [current direction](../../docs/plans/external_datastores/records-direction.md) and
> [homeserver deployment record](../records-service/deploy/homeserver.md).
> Routes, credentials, schemas, sync and operator steps below apply to this legacy implementation;
> they are not a deployment or migration runbook for the current service.

Command handling, journal/counter logic and sync for the earlier Projects runtime. The current service uses the independent Postgres/PostgREST module boundary in `records-service`; this package has not been converted to that boundary.

Existing source, tests and historical API contracts remain available here for maintenance and
migration analysis. No package rename, runtime replacement or data migration is implied by this notice.
