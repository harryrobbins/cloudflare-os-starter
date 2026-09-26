# blueprint-work-board

Source of the **Work Board** blueprint (`format.work-board`): a keyboard-first project tracker over
the Records `work` module (API v1 plus the migration-010 planning model), reached through the
Records connector (`packages/gatekeeper-records-service`, Workshop vendor `recordservice`). Several
boards and explorers can share one datastore. The legacy Project Board
(`packages/blueprint-project-board`) is unchanged.

The gadget's own guide, for people and the in-Workshop agent, is [`src/README.md`](src/README.md);
it ships inside the gadget. Design: [`docs/plans/work-board/plan.md`](../../docs/plans/work-board/plan.md)
and [`brief-board.md`](../../docs/plans/work-board/brief-board.md).

| Path | What |
| --- | --- |
| `src/service-requirement.json` | `work` v1 with `work.read` and `work.write` |
| `src/shared/records.js` | Binding name, archive `bindings` entry (`records-service://datastore/*`), error codes |
| `src/shared/model/` | The normalised work model: fields, states and kinds, v1 fallback, `buildIndex`, groupable properties |
| `src/shared/wql/` | Work Query Language: parse, check, compile/run, format, describe, suggest, chips |
| `src/shared/replica.js` | Snapshot + journal replica with activity history and backfill (client and server) |
| `src/shared/rank.js` | Fractional ranks for manual order |
| `src/shared/datasets/` | Named datasets with a data dictionary (`items` today; Insights registers the journal-derived ones) |
| `src/server/` | Gadget server: Records pass-through (`proxy.js`, commands unchanged), documents (`documents.js`: views, prefs, settings), agent reads (`query.js`), RPC surface (`api.js`) |
| `src/client/store/` | Client store: sync with backoff and epoch reset, command pipeline, pending overlay, undo, bulk edit (`store.js`); input validation (`commands.js`) |
| `src/client/board/projection.js` | Columns × lanes projection with ghost cards for pending changes; move patches |
| `src/client/ui/` | Plain-DOM UI: keyed rendering (`dom.js`), board, list, detail, filter bar, pickers, palette, create, settings, status centre |
| `src/client/views/registry.js` | Layout registry (Board, List; Insights joins here) |
| `harness/` | Local stand-in for the Workshop: the built client in the platform frame (capnweb, CSP) over the real server and `test/fake-records.js`; see its README |
| `e2e/` | Playwright harness suite (`harness.test.mjs`), helpers, `shots.mjs` screenshot helper |

```sh
pnpm --filter blueprint-work-board test:run      # vitest: unit + jsdom UI (with axe)
pnpm --filter blueprint-work-board typecheck     # tsc 7, strict, checkJs over src/
pnpm --filter blueprint-work-board test:e2e      # build + Playwright harness suite (headless Chromium)
pnpm --filter blueprint-work-board pack:gadget   # dist/work-board.gadget
cd packages/blueprint-work-board && node scripts/build.mjs && node scripts/pack-gadget.mjs --formats ../../formats
```

Playwright uses the cached Chromium on this WSL box (see `packages/blueprint-kanban/e2e/README.md`;
never `playwright install`). E2E screenshots land in `e2e/screenshots/` (gitignored; override with
`HARNESS_SHOTS`), and the performance test prints `# perf` timings for 2,000 items.

The `--formats` form writes `formats/work-board.gadget` and `formats/work-board.json`, bumping the
revision in `gadget.lock.json` when the code changes. Commit all three together; the package `test`
task fails when they are stale. Never change `blueprintId` after a deployment has installed it.
