# blueprint-kanban

Source of the **Board** format: a live, shared kanban board gadget for Cloudflare OS.

The plans are in [kanban-blueprint.md](../../docs/plans/kanban-blueprint.md) (scope and design) and [kanban-delivery.md](../../docs/plans/kanban-delivery.md) (how it was built and shipped). The gadget's own user guide and RPC reference is [`src/README.md`](src/README.md), which ships inside the gadget as its `README.md`.

## Layout

| Path | What |
| --- | --- |
| `src/shared/` | The contract: data shapes, wire protocol, limits, sanitisers (`protocol.js`), and fractional ordering keys (`order.js`) |
| `src/core/` | Storage-agnostic board rules (`board.js`), the subscriber and presence hub (`hub.js`), and the `Repository` seam with an in-memory implementation |
| `src/server/` | The `Gadget` Durable Object, its storage repository, and the `ExportHandler` |
| `src/client/` | Sync store (`sync/`, `model/`) and plain-DOM UI (`ui/`), wired in `main.js` |
| `harness/` | Local multi-user simulator: the real client in several panes over the real core |
| `e2e/` | Playwright suites for the harness and for a local Cloudflare OS instance |
| `scripts/` | `build.mjs` (esbuild into `dist/`), `pack-gadget.mjs` and `archive.mjs` (`.gadget` archives) |

## Commands

Run these from the repository root. Node comes from fnm (`fnm use v24.21.0`).

```sh
pnpm --filter blueprint-kanban test:run      # unit tests (node) + server tests (workerd)
pnpm --filter blueprint-kanban build:gadget  # dist/server.js, dist/client.js, dist/README.md
pnpm --filter blueprint-kanban pack:gadget   # build, then write formats/board.gadget (bumps revision on change)
```

The `test` task that `pnpm test` and `pnpm check` run also rebuilds `dist/` and fails if `formats/board.gadget` is stale. **Run `pack:gadget` and commit the archive with every source change.**

To run the gadget without a deployment, see [`harness/README.md`](harness/README.md). To run it inside a local Cloudflare OS, see [`e2e/README.md`](e2e/README.md).

## Shipping

There are two ways to ship the board:

- **Without a deploy:** upload `formats/board.gadget` at Home → Blueprints → Upload .gadget, open `/blueprint/<id>`, publish it, and promote it in `/admin` → Formats.
- **With the deployment:** `deployment.jsonc` sets `"formatBlueprintsDir": "formats"`, so `pnpm deploy` installs the board as `format.board`. See [Bundled formats](../../docs/customization.md#bundled-formats).

**A new revision only changes what new boards get.** Existing boards keep the code they were created from. The `schemaVersion` in `meta` plus the `migrate` hook in `src/core/board.js` are how newer code upgrades older data.

**Never change `blueprintId`** (`format.board`).
