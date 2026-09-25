# blueprint-project-report

> **Legacy implementation; not migrated.** This package still targets the earlier Projects runtime.
> The standards-based service is implemented separately in [records-service](../records-service/README.md)
> and is deployed at [records.surprisingly.ltd](https://records.surprisingly.ltd).
> See the [current direction](../../docs/plans/external_datastores/records-direction.md) and
> [homeserver deployment record](../records-service/deploy/homeserver.md).
> Routes, credentials, schemas, sync and operator steps below apply to this legacy implementation;
> they are not a deployment or migration runbook for the current service.

Source of the **Project Report** blueprint: a read-only report over an organisation Projects datastore. It shows counts by state, priority and assignee, recently updated issues, CSS bar charts with table views, and a CSV download of the current view. It is the second demonstration client in [organisation-datastores.md](../../docs/plans/external_datastores/organisation-datastores.md). The writable one is [`blueprint-project-board`](../blueprint-project-board).

It requests only `projects.read` and `issues.read` (`src/service-requirement.json`). The gadget server (`src/server/proxy.js`) has **no write methods** (no `syncPush` either), and never calls `$createViewerAssertion`. Tests assert both of these. The report reads by sync pull (`syncPull` from its cookie, canonical-postgres-datastore plan §6 and §9), so a poke costs one delta read rather than a full re-read.

The user guide that ships inside the gadget is [`src/README.md`](src/README.md).

## Layout

| Path | What |
| --- | --- |
| `src/client/report.js` | Pure filtering, aggregation, CSV with formula-injection guard; paged loading for the server-side CSV export |
| `src/client/app.js` | Plain-DOM UI and charts over a pull-only `SyncClient` (`@records/sync-client`, bundled by relative path) |
| `src/client/transport.js` | Read-only SyncClient transport: `syncPull` through the gadget server; push always refused locally |
| `src/client/pokes.js`, `src/server/pokes.js` | Same poke machinery as the board: the hook (`deliver: "pokes"`) records the latest head; tabs poll it every 3 s when live and pull by seq, or pull every 60 s until live |
| `src/server/index.js` | `Gadget` DO plus `ExportHandler` (server CSV of all issues, the fallback when the iframe blocks downloads) |

## Commands

```sh
pnpm --filter blueprint-project-report test:run
pnpm --filter blueprint-project-report build:gadget  # dist/{server.js,client.js,README.md,service-requirement.json}
pnpm --filter blueprint-project-report pack:gadget   # also dist/project-report.gadget + dist/project-report.json
```

## Packaging and import (coordinator)

Packaging works the same way as the board: `pack:gadget -- --formats ../../formats` (the directory is relative to the package) writes `formats/project-report.gadget`, `formats/project-report.json` and `gadget.lock.json`, and `--check ../../formats` verifies them. The archive declares `bindings.RECORDS`. Its `typeUrlPattern` placeholder is in `src/shared/records.js` and must match the Records vendor. The service requirement travels inside the archive as `service-requirement.json`, for the sidecar-key reason given in the board README. `blueprintId` is `format.project-report`.
