# blueprint-whiteboard

Source of the **Whiteboard** format: a live, shared, Miro-style whiteboard gadget for Cloudflare OS.

The plans are in [whiteboard-blueprint.md](../../docs/plans/whiteboard-blueprint.md) (scope, design and how it was built). The gadget's own user guide and RPC reference is [`src/README.md`](src/README.md), which ships inside the gadget as its `README.md`.

This package started as a copy of [`blueprint-kanban`](../blueprint-kanban/README.md) and keeps its structure: storage-agnostic rules behind a `Repository`, a transport-agnostic hub, a sync store, a multi-pane harness and a local-platform e2e suite.

## Layout

| Path | What |
| --- | --- |
| `src/shared/` | The contract: data shapes, wire protocol, limits, sanitisers (`protocol.js`); geometry, text layout and connector routing (`geometry.js`); the object renderer shared by the client and the SVG export (`render.js`); stroke simplification (`simplify.js`); fractional ordering keys (`order.js`) |
| `src/core/` | Storage-agnostic whiteboard rules (`whiteboard.js`), the subscriber and presence hub (`hub.js`), and the `Repository` seam with an in-memory implementation |
| `src/server/` | The `Gadget` Durable Object, its storage repository, and the `ExportHandler` |
| `src/client/` | Sync store (`sync/`, `model/`), the canvas (`ui/canvas/`) and the app shell (`ui/`), wired in `main.js` |
| `harness/` | Local multi-user simulator: the real client in several panes over the real core |
| `e2e/` | Playwright suites for the harness and for a local Cloudflare OS instance |
| `scripts/` | `build.mjs` (esbuild into `dist/`), `pack-gadget.mjs` and `archive.mjs` (`.gadget` archives) |

## Commands

Run these from the repository root. Node comes from fnm (`fnm use v24.21.0`).

```sh
pnpm --filter blueprint-whiteboard test:run      # unit tests (node) + server tests (workerd)
pnpm --filter blueprint-whiteboard build:gadget  # dist/server.js, dist/client.js, dist/README.md
pnpm --filter blueprint-whiteboard pack:gadget   # build, then write formats/whiteboard.gadget (bumps revision on change)
```

The `test` task that `pnpm test` and `pnpm check` run also rebuilds `dist/` and fails if `formats/whiteboard.gadget` is stale. **Run `pack:gadget` and commit the archive with every source change.**

To run the gadget without a deployment, see [`harness/README.md`](harness/README.md). To run it inside a local Cloudflare OS, see [`e2e/README.md`](e2e/README.md).

## Shipping

- **With the deployment:** `deployment.jsonc` sets `"formatBlueprintsDir": "formats"`, so `pnpm deploy` installs the whiteboard as `format.whiteboard`. See [Bundled formats](../../docs/customization.md#bundled-formats).
- **Without a deploy:** upload `formats/whiteboard.gadget` at Home → Blueprints → Upload .gadget, open `/blueprint/<id>`, publish it, and promote it in `/admin` → Formats.

**A new revision only changes what new whiteboards get.** Existing whiteboards keep the code they were created from. The `schemaVersion` in `meta` plus the `migrate` hook in `src/core/whiteboard.js` are how newer code upgrades older data.

**Never change `blueprintId`** (`format.whiteboard`).
