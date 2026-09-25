# Legacy Records Node entry point

> **Legacy implementation; not migrated.** This package still targets the earlier Projects runtime.
> The standards-based service is implemented separately in [records-service](../records-service/README.md)
> and is deployed at [records.surprisingly.ltd](https://records.surprisingly.ltd).
> See the [current direction](../../docs/plans/external_datastores/records-direction.md) and
> [homeserver deployment record](../records-service/deploy/homeserver.md).
> Routes, credentials, schemas, sync and operator steps below apply to this legacy implementation;
> they are not a deployment or migration runbook for the current service.

The Node entry point for the earlier TypeScript runtime and its existing HTTP adapters. It is not the gateway process for the current Postgres/PostgREST service. Runtime portability does not make its routes, credentials or operator procedures compatible with the new service.

Existing source, tests and historical API contracts remain available here for maintenance and
migration analysis. No package rename, runtime replacement or data migration is implied by this notice.
