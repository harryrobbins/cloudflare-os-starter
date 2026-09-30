# Records: plans

Records is a standards-based app datastore for cloudflare-os and external apps. Open models are the
reference point; physical schemas and independently authored SDKs map to them. The plan supplies a
complete pinned Schema.org vocabulary catalogue, extensible application profiles, and a blank-model
option. Modules define data
models; explicit bindings let multiple apps share organisation-owned datastores. Compatibility with
other products is optional and module-owned. Neon is not required.

## Current direction

Read [current status](records-status.md) and [Records: shared application data](records-direction.md) first. The architecture is ordinary
Postgres + PostgREST, SQL commands, a small TypeScript gateway and a change relay. The new alpha runs on the homeserver at https://records.surprisingly.ltd alongside the untouched
legacy runtime; follow the
[checked delivery plan](records-delivery.md) for implemented features, evidence and open gates.

- [Records as an immutable fact store](records-immutable-facts.md): proposed storage, sync and performance architecture based on Perry's *The Art of Immutable Architecture*. It supersedes the roadmap in [records-performance-ideas.md](../../research/records-performance-ideas.md) and keeps that document's measurement protocol
- [Blueprint adaptation plan: Jira/Linear work example](records-blueprint-adaptation.md)
- [Records Explorer blueprint plan](records-explorer-blueprint.md)
- [Launch checklist](records-launch.md) and [deployment record](../../../packages/records-service/deploy/homeserver.md)
- [New website and local preview instructions](../../../sites/records/README.md)
- [New product page](../../../sites/records/public/index.html)
- [Side-by-side comparison with the preserved earlier site](../../../sites/records/public/compare.html)
- [Research archive](../../research/external_datastores/README.md)

## Historical plans

All Records recommendations below are superseded by `records-direction.md`. “Built” and “deployed”
refer only to the earlier implementation. The gadget HTTP API is a separate feature; its historical
proposal does not define the new datastore architecture. Historical runbooks must be checked against
actual environments before use.

| Plan | Status | What it is |
| --- | --- | --- |
| [app-datastore-service.md](app-datastore-service.md) | **Superseded**; historical reframing | The reframing: a generic, schema-driven app datastore for cloudflare-os apps, with modules, publishing and optional compatibility adapters. Compares a TypeScript command core with a Postgres-native core (PostgREST) |
| [canonical-postgres-datastore.md](canonical-postgres-datastore.md) | **Built** (2026-09-25); **framing superseded** | The canonical shape: journal and clock, command bus, RLS by principal, delegated tokens, optimistic sync, per-module data models and APIs (Projects follows Jira), portability. Builds on Records |
| [organisation-datastores.md](organisation-datastores.md) | **Implemented and deployed** (2026-09-24), signed-in checks pending; **framing superseded** | Records: the Postgres-backed service on Neon, with registry, memberships, approvals, viewer assertions, outbox delivery, the Data management page and the project board and report blueprints. Includes the deployment record |
| [records-operations.md](records-operations.md) | Historical runbook | Backups, restore rehearsal, per-datastore restore, redaction, retention, analytics |
| [gadget-http-api.md](gadget-http-api.md) | Planned, not built | Give one gadget a REST endpoint through a gatekeeper and hook. For gadget automation, not organisational records |
| [immutable-datastores.md](immutable-datastores.md) | **Not pursued** | Event-sourced Durable Object shards exporting to an R2 lakehouse. Rejected because the source of truth must be strongly consistent; its ordering and journal ideas moved into the canonical plan. Immutability is revisited inside Postgres by [records-immutable-facts.md](records-immutable-facts.md) |
| [external-records-service.md](external-records-service.md) | **Superseded** | An earlier Postgres records-service sketch using PostgREST and the Neon Data API. Its PostgREST idea is reconsidered in the reframing |


## Scope

Gadget-local state remains local. No mirror or lake is the shared data authority. The homeserver is deployed. Business-data inventory, recovery objectives, operational qualification
and migration approval remain outstanding.
