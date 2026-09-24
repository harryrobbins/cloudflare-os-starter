# blueprint-whiteboard

Source of the **Whiteboard** format: a live, shared, Miro-style whiteboard gadget for Cloudflare OS.

The plans are in [whiteboard-blueprint.md](../../docs/plans/whiteboard-blueprint.md) (scope, design and how it was built). The gadget's own user guide and RPC reference is [`src/README.md`](src/README.md), which ships inside the gadget as its `README.md`.

This package started as a copy of [`blueprint-kanban`](../blueprint-kanban/README.md) and keeps its structure: storage-agnostic rules behind a `Repository`, a transport-agnostic hub, a sync store, a multi-pane harness and a local-platform e2e suite.

## Layout

| Path | What |
| --- | --- |
| `src/shared/` | The contract: data shapes, wire protocol, limits, sanitisers (`protocol.js`); geometry, text layout and connector routing (`geometry.js`); the object renderer shared by the client and the SVG export (`render.js`); stroke simplification (`simplify.js`); fractional ordering keys (`order.js`); icon and stencil packs (`icons/registry.js` over the checked-in, generated `generated/icon-packs.js`); grapheme clusters, so emoji sequences are never split by truncation or wrapping (`graphemes.js`) |
| `src/core/` | Storage-agnostic whiteboard rules (`whiteboard.js`), the subscriber and presence hub (`hub.js`), and the `Repository` seam with an in-memory implementation |
| `src/server/` | The `Gadget` Durable Object, its storage repository, and the `ExportHandler` |
| `src/client/` | Sync store (`sync/`, `model/`), the canvas (`ui/canvas/`) and the app shell (`ui/`), wired in `main.js`; the emoji and symbol data of the picker's second tab (`ui/unicode.js` over the checked-in, generated, client-only `generated/unicode-data.js`) |
| `harness/` | Local multi-user simulator: the real client in several panes over the real core |
| `e2e/` | Playwright suites for the harness and for a local Cloudflare OS instance |
| `scripts/` | `build.mjs` (esbuild into `dist/`), `pack-gadget.mjs` and `archive.mjs` (`.gadget` archives), `build-icon-packs.mjs` (icon pack compiler; see below) |

## Commands

Run these from the repository root. Node comes from fnm (`fnm use v24.21.0`).

```sh
pnpm --filter blueprint-whiteboard test:run      # unit tests (node) + server tests (workerd)
pnpm --filter blueprint-whiteboard build:gadget  # dist/server.js, dist/client.js, dist/README.md
pnpm --filter blueprint-whiteboard pack:gadget   # build, then write formats/whiteboard.gadget (bumps revision on change)
pnpm --filter blueprint-whiteboard benchmark     # performance report (JSON + Markdown, no board content)
```

Large-board performance: `test/performance/` holds deterministic 500/2,000/5,000-object fixtures, the CI proxy tests (`model.test.js` against `budgets.js`: bytes, scans, rendered SVG counts, presence fan-out; no timings) and the committed baseline with the snapshot/delta decision ([`test/performance/baseline.md`](test/performance/baseline.md)). `benchmark` writes `test/performance/results/benchmark.{json,md}`.

The `test` task that `pnpm test` and `pnpm check` run also rebuilds `dist/` and fails if `formats/whiteboard.gadget` is stale. **Run `pack:gadget` and commit the archive with every source change.**

To run the gadget without a deployment, see [`harness/README.md`](harness/README.md). To run it inside a local Cloudflare OS, see [`e2e/README.md`](e2e/README.md).

## Icon packs

Icons are compiled at build time, never fetched or parsed at runtime. `scripts/icon-packs/packs.mjs` declares each pack and exactly which source files it takes: the first-party diagram shapes in `scripts/icon-packs/core/*.svg`, and a named subset of `@tabler/icons`, pinned to an exact version as a devDependency (the build fails if the installed version differs). `node scripts/build-icon-packs.mjs` runs each source through a strict compiler (`scripts/icon-packs/svg-compiler.mjs`: a real XML tokenizer, an element and attribute allowlist, byte, element, depth, command, coordinate and view-box limits) and writes three checked-in files: `src/shared/generated/icon-packs.js` (absolute M/L/C/Z path data, labels, tags, source version and SHA-256, licence text), `scripts/icon-packs/published.json` (the ledger of published ids with a geometry hash each; the build fails if a published icon changes or disappears) and `THIRD_PARTY_NOTICES.md`. `--check` verifies all three are current; the unit tests do the same.

The same script also writes `src/client/generated/unicode-data.js` (by `scripts/unicode/build-unicode.mjs`): every emoji of `emojibase-data` 17.0.0 (Emoji 17.0; pinned exactly as a devDependency, British English CLDR names with the US names and keywords kept as search words, groups, subgroups and a skin tone template per emoji that takes one) and the curated symbols of `scripts/unicode/symbols.mjs` (character, Unicode name, extra search words), plus both licence texts, and appends their section to `THIRD_PARTY_NOTICES.md`; `--check` covers it too. It is client-only (emoji are plain text; the server needs no emoji data) and must stay under 200 KiB: today about 150 KiB, 44 KiB gzipped, for 1,914 emoji and 475 symbols, which grows `client.js` by about 180 KiB (50 KiB gzipped). No emoji images are shipped.

Budget: the generated module must stay under 160 KiB (today about 101 KiB, 29 KiB gzipped, for 260 icons and shapes); it ships in both `client.js` and `server.js` (the server draws icons in `exportSvg`), which grows the packed archive from about 107 KiB to about 175 KiB. To add icons, list them in `packs.mjs` and rebuild. To change a published glyph (for example after a Tabler upgrade), add a new pack version instead and keep the old one.

## Shipping

- **With the deployment:** `deployment.jsonc` sets `"formatBlueprintsDir": "formats"`, so `pnpm deploy` installs the whiteboard as `format.whiteboard`. See [Bundled formats](../../docs/customization.md#bundled-formats).
- **Without a deploy:** upload `formats/whiteboard.gadget` at Home → Blueprints → Upload .gadget, open `/blueprint/<id>`, publish it, and promote it in `/admin` → Formats.

### Compatibility

| Axis | Current | Where |
| --- | --- | --- |
| Bundled archive revision | 6 | `gadget.lock.json`, `formats/whiteboard.json` |
| Stored schema version | 1 (the `icon` type is additive; no migration) | `SCHEMA_VERSION` in `src/shared/protocol.js` |
| Wire protocol | subscribe + `applyOperation` + presence, unchanged since revision 4; new RPCs are additive (`findIcons`, `addIcons`, `exportData`, `importData`) | `src/server/index.js` |
| Backup format | `cloudflare-os-whiteboard` version 1 (version 0 = a `getBoard()` result) | `src/shared/backup.js` |
| Icon packs | `core.1`, `tabler.1` (Tabler Icons 3.48.0) | `scripts/icon-packs/published.json` |
| Minimum host | any Cloudflare OS host that runs revision 5; no viewer-session or replaceable-connection API needed yet | — |

**A new revision only changes what new whiteboards get.** Existing whiteboards keep the code they were created from. The `schemaVersion` in `meta` plus the `migrate` hook in `src/core/whiteboard.js` are how newer code upgrades older data.

**Never change `blueprintId`** (`format.whiteboard`).
