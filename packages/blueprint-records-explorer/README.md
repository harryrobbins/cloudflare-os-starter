# blueprint-records-explorer

Source of the **Records Explorer** blueprint (`format.records-explorer`): a read-only browser over any Records service datastore, adapted from the Synthetic Data explorer's UI. It binds `RECORDS` to the Records service connector (`packages/gatekeeper-records-service`, vendor `recordservice`, URL pattern `records-service://datastore/*`). Plan: [records-explorer-blueprint.md](../../docs/plans/external_datastores/records-explorer-blueprint.md) — this package delivers the stage E1 read-only explorer; approved commands, JSON-LD export and history are later stages.

The gadget's user guide is [`src/README.md`](src/README.md), shipped inside the archive.

```sh
pnpm --filter blueprint-records-explorer test:run
pnpm --filter blueprint-records-explorer pack:gadget   # writes formats/records-explorer.gadget, bumps revision on change
node scripts/pack-gadget.mjs --check                   # fails when the committed archive is stale
```

The server forwards only bounded reads (`describe`, `model`, `records`, `changes`) and stores presentation state (entity, columns, tab; at most 8 KB). Never change `blueprintId` after a deployment has installed it.

## Adaptable gadget checks

The packed format ships readable client/server entries, prebuilt libraries, and a bounded
`describeGadget()` contract. Evals live in `src/evals.mjs` and are never packed.

Run the archive integration checks with `node --test scripts/blueprint-adapt.test.ts` from
the repository root. They run every RPC example and every reference eval against the
shipped archive, including the real assembled client in Chromium. Connector-backed formats
use deterministic fixtures, not live accounts.

Reference validation (2026-10-01): 3/3 evals pass against the packed archive; all
`describeGadget()` examples run. Package unit/server suites pass. Shared extension and
build checks, scoped tooling lint, and script type checks pass. Signed-in Workshop
smoke tests have not been run.

Model evals: pending authorization to send gadget source and prompts to the configured
`litellm_proxy/deepseek/deepseek-v4-flash` test proxy (2026-10-01). No model pass rate is claimed.
