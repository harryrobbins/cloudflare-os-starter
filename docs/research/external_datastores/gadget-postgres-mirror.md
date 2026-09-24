# "Backed by Postgres" for gadgets: mirror options

Written 2026-09-24 against starter `main` `5f8c12c`. Records the analysis behind the question "can a
blueprint tick *backed by Postgres* and have its data synced there automatically, while keeping
Durable Object realtime?" Nothing was built. The conclusion feeds the
[canonical Postgres datastore](../../plans/external_datastores/canonical-postgres-datastore.md) plan.

## Findings about gadget storage

- Gadget code receives the raw facet `ctx.storage`. There is no wrapper, platform schema or migration
  concept (`cloudflare-os/packages/workshop-backend/src/overseer.ts:2402-2504`). `typed-storage` is used
  only by platform Durable Objects.
- No blueprint uses SQL. Kanban stores `card:<id>` and `comment:<card>:<ts>:<id>` JSON values,
  whiteboard `obj:<id>`, tessera a single state value (`packages/blueprint-*/src/server/do-repository.js`).
- Durable Objects have no change stream; point-in-time recovery restores but does not export.
- Gadgets have `globalOutbound: null`, so data can leave only through a connector binding.
- Deleting a gadget deletes its facet storage (`ctx.facets.delete`).
- Kanban, whiteboard and wave send every write through `Repository.commit()`, one atomic transaction,
  and cards carry a `version`. That is a clean seam for change capture or for swapping the store.

## Options considered

| Option | Source of truth | Verdict |
| --- | --- | --- |
| One-way mirror: the gadget writes an outbox row in the same transaction, a connector drains it into a `mirror.docs` JSONB table, typed views per blueprint | Durable Object | Workable for reporting and backup. Postgres is read-only and seconds behind. Not a source of truth |
| Capture at the platform (overseer injects a storage proxy) or with SQLite triggers | Durable Object | Catches every gadget but needs a fork change; `sql.exec` is opaque. Only after the per-blueprint seam proves useful |
| Records feed pushes row deltas instead of identifiers | Postgres | Removes the per-change refetch. Worth doing regardless |
| Sync engines (Electric, Zero, PowerSync) | Postgres | Each needs an always-on server outside Workers and, on Neon, logical replication (stops scale-to-zero, slots dropped when idle) |
| WAL consumer in a Container | Postgres | Always-on cost; Hyperdrive does not speak the replication protocol |
| Durable Object writes through to Postgres | Postgres | Loses the reason to have the Durable Object in front unless it also pushes changes |

Rule carried forward: never two writable copies. A dataset moves between gadget-owned and
Postgres-owned only through an explicit, one-time cut-over.

## Why the canonical plan does not use a mirror

The owner's requirement is a strongly consistent source of truth that anything can write to through an
API. A mirror makes the gadget authoritative and Postgres a copy, which is the reverse. For data that
must be organisational, the blueprint should use a Postgres datastore directly through its API, with the
snappy UI coming from optimistic local state rather than from the Durable Object owning the data.
