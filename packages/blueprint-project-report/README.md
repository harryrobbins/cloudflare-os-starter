# blueprint-project-report

Source of the **Project Report** blueprint: a read-only report over an organisation Projects datastore. It shows counts by state, priority and assignee, recently updated issues, CSS bar charts with table views, and a CSV download of the current view. It is the second demonstration client in [organisation-datastores.md](../../docs/plans/organisation-datastores.md). The writable one is [`blueprint-project-board`](../blueprint-project-board).

It requests only `projects.read` and `issues.read` (`src/service-requirement.json`). The gadget server (`src/server/proxy.js`) has **no write methods**, and never calls `$createViewerAssertion`. Tests assert both of these.

The user guide that ships inside the gadget is [`src/README.md`](src/README.md).

## Layout

| Path | What |
| --- | --- |
| `src/client/report.js` | Pure loading (paged, newest first, up to 2,000), filtering, aggregation, CSV with formula-injection guard |
| `src/client/app.js` | Plain-DOM UI and charts |
| `src/client/sync.js`, `src/server/feed.js` | Same live/polling machinery as the board, polling every 60 s |
| `src/server/index.js` | `Gadget` DO plus `ExportHandler` (server CSV of all issues, the fallback when the iframe blocks downloads) |

## Commands

```sh
pnpm --filter blueprint-project-report test:run
pnpm --filter blueprint-project-report build:gadget  # dist/{server.js,client.js,README.md,service-requirement.json}
pnpm --filter blueprint-project-report pack:gadget   # also dist/project-report.gadget + dist/project-report.json
```

## Packaging and import (coordinator)

Packaging works the same way as the board: `pack:gadget -- --formats ../../formats` (the directory is relative to the package) writes `formats/project-report.gadget`, `formats/project-report.json` and `gadget.lock.json`, and `--check ../../formats` verifies them. The archive declares `bindings.RECORDS`. Its `typeUrlPattern` placeholder is in `src/shared/records.js` and must match the Records vendor. The service requirement travels inside the archive as `service-requirement.json`, for the sidecar-key reason given in the board README. `blueprintId` is `format.project-report`.
