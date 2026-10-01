# blueprint-project-board

> **Legacy implementation; not migrated.** This package still targets the earlier Projects runtime.
> The standards-based service is implemented separately in [records-service](../records-service/README.md)
> and is deployed at [records.surprisingly.ltd](https://records.surprisingly.ltd).
> See the [current direction](../../docs/plans/external_datastores/records-direction.md) and
> [homeserver deployment record](../records-service/deploy/homeserver.md).
> Routes, credentials, schemas, sync and operator steps below apply to this legacy implementation;
> they are not a deployment or migration runbook for the current service.

Source of the **Project Board** blueprint: a writable board over an organisation Projects datastore, served by the Records service (`packages/gatekeeper-records`). It is one of the two demonstration clients in [organisation-datastores.md](../../docs/plans/external_datastores/organisation-datastores.md) §1 and §9 Phase 3. The other is [`blueprint-project-report`](../blueprint-project-report).

The gadget's own user guide and RPC reference is [`src/README.md`](src/README.md). It ships inside the gadget as `README.md`.

## Layout

| Path | What |
| --- | --- |
| `src/service-requirement.json` | The Records service requirement (`ServiceRequirementSchema` in `packages/records-contracts/src/manifest.ts`) |
| `src/shared/records.js` | Binding name, archive `bindings` entry, Records error-code parsing |
| `src/server/proxy.js` | The gadget server's RECORDS pass-through: reads, and `syncPush`/`syncPull`/`syncApprovals` passed through unchanged |
| `src/server/pokes.js` | Gadget-local record of the latest Records poke (`{datastoreId, head}`); no record content |
| `src/server/index.js` | `Gadget` Durable Object, `[restore]` for the persistent `onChange(…, {deliver: "pokes"})` hook |
| `src/client/transport.js` | SyncClient transport over the gadget: per mutation, intent digest → `$createViewerAssertion("RECORDS", digest)`; RPC errors → `SyncTransportError` |
| `src/client/pokes.js` | Polls the gadget's poke log (3 s when live) and pokes the SyncClient; timed pulls until live |
| `src/client/model.js` | Pure board helpers over the SyncClient's view (columns, transitions, conflicts) |
| `src/client/ui/` | Plain-DOM UI: optimistic changes, `ENG-?` placeholders, approvals, conflicts, unsynced-changes warning |
| `test/fake-records.js` | In-memory `RecordsSession` over the sync client's fake datastore (`records-sync-client/__tests__/fake-server.ts`); `syncPush` verifies each mutation's digest and redeems each assertion once, like the real Gatekeeper |

## Commands

Run these from the repository root.

```sh
pnpm --filter blueprint-project-board test:run      # vitest (node + jsdom)
pnpm --filter blueprint-project-board build:gadget  # dist/{server.js,client.js,README.md,service-requirement.json}
pnpm --filter blueprint-project-board pack:gadget   # also dist/project-board.gadget + dist/project-board.json
```

`pack:gadget` writes only inside `dist/`, which is gitignored.

## Sync

The board uses `@records/sync-client` (imported by relative path from `packages/records-sync-client/src` and bundled by esbuild, like `records-contracts/src/caller.ts`; neither pulls zod into the bundle). The client applies each change locally with the shared Projects mutators, pushes through the gadget server to `RECORDS.syncPush`, and pulls by `seq` on a poke, on a 15 s timer until live updates are on, and every 60 s as a safety net. Each pushed mutation carries its own viewer assertion over `{operation, input: args, idempotencyKey: "sync:<clientId>:<mutationId>"}`, minted again for every attempt.

## Service requirement and binding

- **Binding:** the archive metadata declares `bindings.RECORDS` (`type: "gatekeeper"`, `gatekeeperName: "records"`). Its `typeUrlPattern` (`records://datastore/:datastoreId` in `src/shared/records.js`) is a placeholder. It must equal the Records vendor's `SupportedResource.urlPattern`.
- **Requirement:** `src/service-requirement.json` declares `{service, moduleId: "projects", apiMajor: 1, features, scopes}`. Bundled-format sidecars (`formats/*.json`) are only allowed to hold `blueprintId`, `title`, `description`, `output`, `author` and `revision`, because upstream's build rejects any other key. The requirement therefore ships as a file inside the archive content (`service-requirement.json`), next to `README.md`. The gadget server also returns it from `getSetup()`, and the UI compares it with the binding's granted scopes. The platform does not enforce it yet. Compatibility is checked server-side at bind time (`checkCompatibility`).

## Packaging and import (coordinator)

1. `pnpm --filter blueprint-project-board pack:gadget -- --formats ../../formats` (the directory is relative to the package) writes `formats/project-board.gadget` and `formats/project-board.json` (from `format.json`). It creates `gadget.lock.json` and bumps `revision` whenever the code changes.
2. Commit the archive, the sidecar and `gadget.lock.json` together. `node scripts/pack-gadget.mjs --check ../../formats` fails when they are stale; the package's `vite.config.ts` `test` task runs it. A change under `packages/records-sync-client/src` or `records-contracts/src/caller.ts` also changes the bundle, so repack after one.
3. Alternatively, upload `dist/project-board.gadget` at Home → Blueprints → Upload .gadget without a deploy.

Instantiating it requires setup (it declares a binding), so **New** routes through `/blueprint/<id>`. Never change `blueprintId` (`format.project-board`) after a deployment has installed it.

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

Model evals: `litellm_proxy/deepseek/deepseek-v4-flash` passed 3/3 on 2026-10-01
(one run per eval, with operator authorization to send gadget code).
