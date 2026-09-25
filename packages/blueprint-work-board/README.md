# blueprint-work-board

Source of the **Work Board** blueprint (`format.work-board`): a board of `work_item` records in a Records service datastore, reached through the Records connector (`packages/gatekeeper-records-service`, Workshop vendor `recordservice`). Several boards and explorers can share one datastore. It replaces nothing: the legacy Project Board (`packages/blueprint-project-board`) is unchanged.

The gadget's own guide is [`src/README.md`](src/README.md); it ships inside the gadget.

| Path | What |
| --- | --- |
| `src/service-requirement.json` | `work` v1 with `work.read` and `work.write`; no features |
| `src/shared/records.js` | Binding name, archive `bindings` entry (`records-service://datastore/*`), error codes |
| `src/server/proxy.js` | Pass-through to the `RECORDS` session; `command` arguments are never copied or normalised |
| `src/client/intent.js` | Canonical JSON and SHA-256 intent digest (matches the connector's `recordsOsIntentDigest`) |
| `src/client/model.js` | Snapshot + journal state, columns, edit diffs |
| `src/client/ui/` | Plain-DOM UI: columns, item panel, new-item dialog, change status panel |

```sh
pnpm --filter blueprint-work-board test:run      # vitest (node + jsdom)
pnpm --filter blueprint-work-board pack:gadget   # dist/work-board.gadget
cd packages/blueprint-work-board && node scripts/build.mjs && node scripts/pack-gadget.mjs --formats ../../formats
```

The `--formats` form writes `formats/work-board.gadget` and `formats/work-board.json`, bumping the revision in `gadget.lock.json` when the code changes. Commit all three together; the package `test` task fails when they are stale. Never change `blueprintId` after a deployment has installed it.
