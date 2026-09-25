# Legacy Projects compatibility adapter

> **Legacy implementation; not migrated.** This package still targets the earlier Projects runtime.
> The standards-based service is implemented separately in [records-service](../records-service/README.md)
> and is deployed at [records.surprisingly.ltd](https://records.surprisingly.ltd).
> See the [current direction](../../docs/plans/external_datastores/records-direction.md) and
> [homeserver deployment record](../records-service/deploy/homeserver.md).
> Routes, credentials, schemas, sync and operator steps below apply to this legacy implementation;
> they are not a deployment or migration runbook for the current service.

An optional adapter in the earlier Projects implementation. Its existing [compatibility evidence](COMPATIBILITY.md) applies to that runtime only; it is not evidence of compatibility with the new service. For the current product, vendor-shaped interfaces such as Jira or Linear are optional, independently implemented mappings to open profiles. This legacy adapter has not been migrated.

Existing source, tests and historical API contracts remain available here for maintenance and
migration analysis. No package rename, runtime replacement or data migration is implied by this notice.
