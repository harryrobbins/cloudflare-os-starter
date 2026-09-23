# Tessera blueprint: a GPU mosaic of demo or connected data

Build a Cloudflare OS blueprint that embeds [Tessera](https://harryrobbins.github.io/tessera/), the WebGL2 unit-visualisation engine. In Tessera, every row of a dataset is a card that flies between grid, bars, cross-tab, scatter and map layouts. A new gadget opens on Tessera's built-in demo collections. Once someone binds a data connector, the same gadget shows that connector's tables.

**Status:** Approved for implementation (2026-09-23). Revised after a code-level review: opaque-origin harness, core/wrapper server split, asynchronous worker fallback, observation volume, and the procgen schema facts. Harry owns the Tessera repo (`github.com/harryrobbins/tessera`) and has agreed that it can be refactored into an installable library.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Embed the live site in an `<iframe>`? | **No.** Bundle Tessera into `client.js`. | The gadget CSP has `frame-src 'none'` and `connect-src 'none'`. The only way in is one `data:` module script. |
| Copy Tessera's source into the blueprint? | **No.** Refactor Tessera into a library entry point and install it as a pinned git dependency. | Harry controls the repo. The demo site and the gadget share one engine, and fixes flow both ways. |
| Declare a binding in the archive? | **No bindings.** | Any declared binding forces New through `/blueprint/<id>` setup, and the platform has no optional flag (`admin-config.ts:272`). With no bindings, New is one click and shows demo data. A connector is added later in the gadget's Connections tab, or by the agent with `setGadgetBinding`. |
| Which connector? | **Synthetic Data (`procgen`)** now, behind a small source-adapter interface. | It is the only deployed gatekeeper that serves tables. Google Sheets and BigQuery exist upstream but are not deployed. The adapter interface lets them slot in later. |
| Which demo datasets? | The five procedural families (tax cases, tax returns, card payments, invoices, products), plus Titanic with its 116 KB CSV inlined. | Birds and pixels need 9 MB of images, which would bloat the Workshop Worker because formats are base64-inlined into it. They are hidden in the gadget. |
| Layout worker | A `data:` URL module worker built from Tessera's `layout/worker.ts`, with an in-thread fallback that switches over on `onerror` or a 3-second timeout. | `worker-src` falls back to `script-src data:`, so `data:` workers pass. `blob:` is blocked. A worker failure is asynchronous: it fires `onerror` and never throws. |
| State | Server Durable Object storage (`ctx.storage`): source selection and view. No live multi-user sync. | Opaque-origin iframe: localStorage throws. The view is small. The last saved view wins. |

## Architecture

```
┌──────────── gadget iframe (opaque origin, CSP: data: scripts only) ────────────┐
│ client.js                                                                      │
│   tessera/lib  mountTessera(root, {layoutWorker, storage:null, urlSync:false,  │
│                                    tour:false, families:[...], fetchAsset})    │
│   Source bar ─ Demo ▾ | Connected: Synthetic Data ▾ collection, rows cap        │
│   datasetFromTable(table) → Dataset → tessera.registerDataset / load           │
└──────────────┬─────────────────────────────────────────────────────────────────┘
               │ capnweb RPC: `gadget.*`
┌──────────────▼──────────── Gadget facet (server.js, DurableObject) ─────────────┐
│ getState / setState       (validated, ctx.storage)                              │
│ listSources()             demo + each detected connector                        │
│ loadTable(sourceId, table, {maxRows})  → TableData (paged via adapter)          │
│ sources/procgen.js        env.PROCGEN (or any env binding answering            │
│                           describeDataset) → query pages of ≤100 rows           │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### TableData: the contract between the server and Tessera

The same shape is produced by every source adapter and consumed by Tessera's `datasetFromTable`:

```ts
export interface TableColumn {
  name: string;                 // key in each row
  title?: string;               // display name
  type: 'string' | 'number' | 'boolean' | 'timestamp';
  semantic?: 'id' | 'latitude' | 'longitude' | 'currency_minor' | string;
  currency?: string;            // with currency_minor, e.g. "GBP"
}
export interface TableData {
  name: string;                 // collection title shown in the menu
  columns: TableColumn[];
  rows: unknown[][];            // row-major, aligned with columns
  truncated?: boolean;          // true when maxRows cut it short
  totalRows?: number;           // exact total when the source knows it
}
```

`datasetFromTable(table, opts?)` infers the column types as follows:
- Booleans become categories. Strings with 2 to 50 distinct values become categories, with null shown as "Unknown".
- Other strings become text. An id-like column becomes the label unless a better title-like column (`name`, `title`, `label`) exists.
- Numbers become numeric columns. `currency_minor` is divided by 100 and formatted with `Intl.NumberFormat`.
- A timestamp becomes a numeric epoch-days column with a date `format`, plus derived `<col> year` and `<col> month` categories.
- A latitude/longitude pair sets `geo`.
- JSON fields are dropped by the adapter.
- `facets` lists categories first in column order, then numerics. `card` and `detail` are omitted, so Tessera derives them.

## Part A: Tessera library refactor (repo `scratch/tessera`, branch `embed-api`)

The public demo must keep working unchanged. Its `main.ts` becomes a thin caller of the library.

1. **`src/lib/index.ts`** exports the following:
   - `mountTessera(root: HTMLElement, options): TesseraHandle`
   - `datasetFromTable`
   - the types (`Dataset`, `TableData`, `TesseraOptions`, `TesseraHandle`, `ViewState`)
   - `computeLayout`, for the fallback engine.
2. **The chrome moves from `index.html` into the library** (`src/lib/chrome.ts`) as an HTML template that `mountTessera` injects into `root`. `index.html` keeps only a mount point. Element lookups become `root.querySelector` or scoped lookups, and nothing depends on global IDs outside `root`. Overlays can keep `position: fixed`.
3. **Options**, all optional, with defaults matching today's demo:
   - `storage: Storage | null` (default: safe `localStorage`)
   - `urlSync: boolean`: the deep-link read and `history.replaceState` write. It is guarded by try/catch either way.
   - `tour: boolean`
   - `bench: boolean`
   - `families?: string[]`: which built-in families appear in the menu
   - `fetchAsset?: (path) => Promise<Response>`: Titanic's loader (`titanic.ts:259`) goes through it. The gadget returns `new Response(inlinedCsv)`. It must not call `fetch`: `connect-src 'none'` blocks even `data:` URLs.
   - `layoutWorker?: () => Worker`. The demo passes its Vite `new URL('./worker.ts', import.meta.url)` worker from `main.ts`.
     - The engine is injected through the `PivotApp` constructor. Today `app.ts:75` creates it in a field initializer, and `layout/client.ts:29` hard-codes the URL.
     - Fall back to the synchronous in-thread engine (on `computeLayout`) when the factory throws, when `onerror` fires before the first reply, or after a 3 s timeout. After switching, replay the last solve.
     - `handle.layoutEngine()` reports `'worker' | 'inline'`.
   - `initialDataset?: string`
   - `initialView?: ViewState`
   - `onViewChange?(view, datasetKey)`
4. **Runtime datasets:** `handle.registerDataset(key, label, dataset | () => Promise<Dataset>, {group?})` adds the dataset to the registry map, checked before `FAMILIES`. It also rebuilds the collection menu with a "Connected" `<optgroup>`. `handle.unregisterDataset(key)`.
5. **Handle API:**
   - `load(key)`, `getView()`, `applyView(view)`, `currentDatasetKey()`, `dispose()`
   - `setMenuExtras(node)`: a slot in the top bar where the host adds its own control (the gadget's source button).
6. **Fixes needed in the sandbox:**
   - The tour's `shouldAutoStart` must return false when storage is null.
   - Guard `writeUrl`.
   - `window.pivot` and the bench globals are set only when `bench` is true.
   - The library never references `import.meta.env` or `new URL(..., import.meta.url)`, which bundles as-is under esbuild.
   - Lazy-import the tour and bench code (`await import`) so it stays out of the gadget's critical path.
   - Hide `#tourBtn` and `#benchBtn` when those features are off.
   - `dispose()` removes the global `keydown` listener (`main.ts:501`).
   - `families` filters `menuEntries()`, and the default key must belong to an allowed family.
   - Runtime keys (`src:*`) are checked before `resolveDataset`'s default fallback (`registry.ts:151`).
7. **CSS:** `src/ui/style.css` stays a plain file, exported as `tessera/style.css`. The Vite demo imports it. The gadget imports it as text and injects a `<style>`.
8. **package.json:** add `"exports": { ".": "./src/lib/index.ts", "./style.css": "./src/ui/style.css", "./worker": "./src/layout/worker.ts", "./data/titanic.csv": "./public/data/titanic.csv" }`. Consumers bundle the TypeScript source with esbuild or Vite. There is no separate build step.
9. **Tests:**
   - vitest for `datasetFromTable`: type inference, nulls, categories versus text threshold, timestamps, geo, currency, empty tables, and a 50k-row performance smoke test.
   - vitest for the registry: runtime registration, and that unknown keys still fall back.
   - The existing 28 test files still pass, and `pnpm build` and `pnpm test:e2e` (the tour) still pass.

**Part A implementation notes (embed-api `d530971`):**
- Additions, all compatible with the contract:
  - `handle.app` (the `PivotApp`) and `handle.ready` (settles once the opening collection is on screen).
  - Extra type and helper exports: `FetchAsset`, `FromTableOptions`, `InlineLayoutEngine`, `ResilientLayoutEngine`, `FAMILIES`, and the column helpers.
- Mount timing: boot waits one microtask. A key registered straight after `mountTessera` (a lazy `() => Promise<Dataset>` loader) can therefore be the `initialDataset`.
- Precedence: a `?dataset=` deep link wins over `initialDataset` only when `urlSync` is on. The same goes for the linked view over `initialView`.
- `layoutWorker` omitted means in-thread solving. The library cannot build a worker by itself.
- Refinement to the rule for when strings become categories: 2 to 50 distinct values, *and* the values must mostly repeat (distinct ≤ max(2, non-null/2)). Without this, a 10-row table would turn its names into a category.
  - Booleans are shown as Yes/No/Unknown.
  - Month categories are `YYYY-MM`.
  - A numeric `id` column becomes text.
- `shouldAutoStart` with `null` storage now returns false. The existing test that asserted true was updated. `?tour=1` still forces the tour to open.
- A `tests/lib-bundle.test.ts` test esbuild-bundles `src/lib/index.ts` and asserts the output has no `import.meta`. `esbuild` was added as a devDependency for it.
- The jsdom mount smoke test mocks `PivotApp`, because jsdom has no WebGL2.
- Sizes:
  - esbuild, minified: the library is 658 KB, of which faker `en_GB` is 443 KB. The worker is 7.8 KB.
  - Vite demo: the entry chunk is 182 KB (it was 199 KB). The tour (32 KB) and bench (3 KB) are now lazy chunks. faker `en_GB` is 426 KB.

## Part B: blueprint package `packages/blueprint-tessera`

Model it on `blueprint-procgen-explorer`: esbuild build, `pack-gadget.mjs` with lock and revision bump, and a Vite+ `test` task.

- **Sidecar** `formats/tessera.json`:
  ```json
  {"blueprintId":"format.tessera","title":"Tessera Mosaic","description":"Every row a card: explore demo collections or a connected data source as a GPU mosaic that flies between grid, bars, cross-tab, scatter and map layouts.","output":{"id":"tessera","noun":"Mosaic","plural":"Mosaics","icon":"chartBar"},"author":{"type":"user","name":"Surprisingly Ltd","id":"harryrobbins@gmail.com"},"revision":1}
  ```
- **Dependency:** `"tessera": "github:harryrobbins/tessera#<sha>"`, pinned to the pushed `embed-api` commit. While Part A is in flight, use `"link:../../scratch/tessera"`. `scratch/` is git-ignored, so the pin must switch before commit.
- **Build** (`scripts/build.mjs`):
  1. Bundle `tessera/worker` into an ES module string first.
  2. Inject it as `data:text/javascript;base64,…` into the client (a `define`d constant).
  3. Bundle the client with `.css` and `.csv` loaded as text.
  4. Bundle `src/server/index.js` the way procgen-explorer does.
  5. Record the `client.js` size in the build output. Budget: 1.5 MB; review if it is exceeded.
- **Server.** Split it so tests and the browser harness can run the real logic:
  - `src/server/core.js` is pure. `createCore({env, storage})` takes a `get`/`put` storage interface.
  - `src/server/index.js` is a thin `class Gadget extends DurableObject` wrapper. It is the only file that imports `cloudflare:workers`.

  The core provides:
  - `getState()` and `setState(state)`: validated state, stored under one key.
    ```
    State = { source: {kind:'demo', key} | {kind:'connector', sourceId, table, maxRows}, view?: ViewState, rev }
    ```
    `rev` is the last-writer revision. Reject values over 16 KB.

    `ViewState` follows Tessera's `deepLink.ts:42-50`, including nested `filters: FilterEntry[]`, so validation checks that structure. It bounds counts (≤ 32 filters, ≤ 200 values each) and string lengths.
  - `listSources()` returns `[{id:'demo', title:'Demo collections'}, …connectors]`. Each connector entry is `{id, kind:'procgen', title, description, tables:[{name,title,exactRecords}]}` or `{…, error}` when its probe fails.
  - `loadTable(sourceId, table, {maxRows})` returns `TableData`. `maxRows` is clamped to 1 to 10,000 (default 2,000). A result over about 8 MB of JSON fails with a clear error. The source adapter pages through the data. Results are cached in memory per facet lifetime only, never in durable storage (procgen observation semantics).

    Every procgen read is written as an activity record. In a chat preview, it is also posted as a chat message (`overseer.ts:2830-2893`). So the adapter keeps calls few: 100-row pages, the in-memory cache, and cached detection.
  - **Connector detection:** use `env.PROCGEN` first. `Connect resource` names the binding `PROCGEN` (or `PROCGEN_2`, …).
    - Only if no binding starts with `PROCGEN`, scan the other `env` keys (excluding `GADGET`) and probe `describeDataset()` for a `scenario` field. Each probe gets a 3 s timeout and catches its own failure. A probe opens a gatekeeper session, so unrelated bindings are probed at most once.
    - Cache the result for the facet's lifetime. Binding changes restart the facet (`overseer.ts:1858`), so the cache can never go stale.
- **Source adapter interface** (`src/server/sources/*.js`):
  ```js
  { kind, probe(stub) → {title, description} | null, listTables(stub), loadTable(stub, name, {maxRows}) → TableData }
  ```
  The `procgen` adapter:
  - maps `describeCollection` fields to `TableColumn`: it drops `json`, maps `timestamp` to `timestamp`, and carries `semanticType` across;
  - uses `Number(exactRecords)`, because it is a string;
  - reads the schema once, then keeps only `records` from each page;
  - pages `query({collection, limit:100, cursor})` until it reaches `maxRows` or `nextCursor` is absent;
  - sets `totalRows` from `exactRecords`.
  - `*_minor` money fields take their currency from the row's `currency_code` column (first row) when one exists. Procgen has no lat/lon fields, so its tables never open on the map. `geo` stays for future sources.
- **Validation** (`src/shared/validation.js`): source ids, table names (`^[a-z0-9_]{1,64}$`), `maxRows`, and `ViewState` keys and values (short strings only).
- **Client** (`src/client/main.js`):
  - **Mount:** inject the CSS, then call `mountTessera(document.body, {storage:null, urlSync:false, tour:false, bench:false, families:[the five procedural + 'titanic'], fetchAsset: inlined titanic.csv, layoutWorker: () => new Worker(WORKER_DATA_URL, {type:'module'})})`.
  - **Source control** in the top-bar slot: a "Data" button opening a popover with **Demo collections** (the Tessera menu already covers these) and each connector with its tables.
    - Picking a table loads it with a "Loading 1,200 of 2,000 rows…" progress toast. Progress is coarse: the rows cap only, with one RPC.
    - The table is registered with `registerDataset('src:<sourceId>:<table>', …)`, loaded, and saved to state.
    - Each connector also shows a row cap selector (500 / 2,000 / 10,000 / 20,000).
    - When no connector is bound, the popover explains: *"Connect a data source: open this gadget's Connections tab and add Synthetic Data (if a chat is open, accept its changes). The mosaic reloads with it automatically."*
  - **Restore on load:** `getState()`. For demo it calls `initialDataset`/`initialView`; for a connector it loads the table first. If the connector has gone, it falls back to demo and shows a toast.
  - **Persist:** `onViewChange` is debounced (800 ms) into `setState`.
  - **RPC resilience:** GadgetUI already reconnects, and reloads the frame on code and binding changes (`GadgetUI.tsx:204-264`). As a last resort only, a broken-stub rejection triggers `location.reload()` once, guarded by a `window.name` flag.
- **`src/README.md`:** the agent-facing guide. It covers the RPC methods, the state shape, how to bind a connector (the binding name `PROCGEN` is recommended), and the row caps.

- **Review fixes (revision 3):**
  - Detection caches each binding's probe on its own. A success, or a definite "not a connector" (it answered without a `scenario`, or has no `describeDataset`), is kept for the facet's lifetime. A rejection or timeout is retried after 30 s (`PROBE_RETRY_MS`), and healthy bindings are never re-probed. Fallback probing still runs only when no `PROCGEN*` binding exists; the README says binding as `PROCGEN` avoids it.
  - The 8 MB guard runs per page (UTF-8 bytes via `TextEncoder`) and aborts the read early with a `Too large:` error. The refusal is remembered for 60 s for any request of at least as many rows. A smaller request that joined the refused load retries on its own.
  - The procgen adapter stops on a repeated cursor or a page that adds no rows, and skips null records.
  - `loadTable` prefixes adapter and gatekeeper errors with `Data source <id> is unavailable:` (a failed `listSources` with `Data source list is unavailable:`). The client's `isBrokenStubError` treats these as application errors, so a gatekeeper-side "disconnected" never reloads the frame.
  - Client: the debounced save flushes on `pagehide` and `visibilitychange` (hidden). A connector load that finishes after the user picked another collection registers the table but does not switch away. The Data popover closes when focus leaves it. The status and toast live regions stay rendered while empty.
  - `build.mjs` sets esbuild's `absWorkingDir`, so the output no longer depends on the caller's cwd.

## Part C: verification

- **Unit tests** (vitest), all against `core.js`:
  - a capnweb serialisation round-trip of a 10,000 × 15 row table;
  - validation;
  - the procgen adapter against a fake session: paging, caps, column mapping, and error on an unknown table;
  - connector detection with renamed or non-procgen bindings;
  - state round-trip;
  - `pack-gadget --check` freshness. `--check` rebuilds from source into a temporary directory and compares that build with `gadget.lock.json` and `formats/tessera.gadget`, so a stale `dist/` cannot pass.
- **Harness** `harness/`: a static server and a **fidelity page** that reproduce the platform frame.
  - Do not copy wave's harness: it uses `allow-same-origin`, which hides the sandbox failures.
  - The page creates a srcdoc iframe with `sandbox="allow-scripts"` and the exact `GadgetUI.tsx:112` CSP. It loads `dist/client.js` as a `data:` module behind the same kind of prefix: capnweb `newMessagePortRpcSession` over a `MessageChannel`, plus `gadgetViewer`.
  - The parent side serves the real `core.js`, with in-memory storage and an optional fake `PROCGEN` session (`?procgen=1`).
  - Reuse the prefix logic from `GadgetUI.tsx:25-118` as closely as possible. If importing it is impractical, copy it with a comment citing the source lines.
- **Browser test** (Playwright, following the `playwright-wsl` skill), `e2e/harness.test.mjs` against the harness:
  1. The gadget renders a WebGL2 canvas with cards (a non-blank pixel sample) and no CSP violations. The console is collected, and violations fail the test.
  2. The layout worker ran as a `data:` worker (the handle reports the engine: `worker` vs `inline`).
  3. Switching the demo collection and layout works, and the view persists across a pane reload.
  4. Titanic loads from the inlined CSV.
  5. With `?procgen=1`, the Data popover lists the tables. Loading `daily_metrics` shows 730 cards and survives a reload.
  6. Without a connector, the popover shows the "Connect a data source" hint.
- **Production smoke** after deploy: the router must return the Access redirect. Checks that need sign-in (New → Tessera Mosaic, binding Synthetic Data) are listed for Harry, since Access blocks automated sign-in.

## Implementation checklist

Agents tick items (`[x]`) as they finish them and note anything deferred inline.

### Phase 1: in parallel

**A: Tessera library (repo `scratch/tessera`, branch `embed-api`)**
- [x] A1 Create branch `embed-api`; `pnpm install`; baseline `pnpm test` and `pnpm build` pass
- [x] A2 `src/lib/chrome.ts` template, and `index.html` reduced to a mount point
- [x] A3 `mountTessera(root, options)`, with `main.ts` rewritten as a thin demo caller (URL sync, tour, bench, localStorage on)
- [x] A4 Options: storage null-safe, urlSync guarded, tour and bench switchable, families filter, fetchAsset, layoutWorker with in-thread fallback, initialDataset/initialView, onViewChange
- [x] A5 Runtime `registerDataset`/`unregisterDataset`, menu rebuild with a "Connected" group, and `setMenuExtras` slot
- [x] A6 `datasetFromTable` in `src/data/fromTable.ts`, with inference rules as specified
- [x] A7 Fixes: tour autostart when storage is null, globals only when bench is on, no `import.meta` in library paths
- [x] A8 `package.json` `exports`; README section "Embedding Tessera"
- [x] A9 Tests: fromTable, registry, and a mount smoke test in jsdom if feasible. All existing tests pass, and `pnpm build` passes
- [x] A10 `pnpm test:e2e` (tour) passes, or the reason it cannot run here is recorded
- [x] A11 Commit on `embed-api` (no push; the coordinator pushes)

**B: blueprint server and packaging (`packages/blueprint-tessera`)**
- [x] B1 Package scaffold copied from procgen-explorer (package.json, vite.config test task, vitest config, scripts), with `formats/tessera.json` sidecar, revision 1
- [x] B2 `src/shared/validation.js` (state, ids, maxRows, ViewState)
- [x] B3 `src/server/core.js` (getState/setState/listSources/loadTable, with cached connector detection) and a thin `src/server/index.js` DurableObject wrapper
- [x] B4 `src/server/sources/procgen.js` adapter
- [x] B5 Unit tests for B2 to B4 with a fake procgen session
- [x] B6 `src/README.md` agent guide
- [x] B7 `build.mjs`: worker bundled to a `data:` URL, CSS and CSV as text, `minify: true`, `charset: 'ascii'`; size printed. The client entry can be a stub until C. Use `link:../../scratch/tessera` (B is the only agent that edits the starter lockfile)
- B notes (deviations and facts for C1):
  - The procgen gatekeeper binds a cursor to the whole query, `limit` included. So the adapter keeps `limit` fixed (100, or `maxRows` when that is smaller) and slices the last page. The schema comes from the first query page (no `describeCollection` call, one read fewer). The core checks the table name against the cached `listCollections` before any read.
  - `setState` assigns `rev` (the previous `rev` + 1) and ignores any incoming one. `source.key` is optional for demo; absent means Tessera's default. Unknown `view` keys are dropped, not rejected, so a newer Tessera never breaks saving. `layout` accepts any short identifier. `maxRows` is clamped, never rejected, so a 20,000 selection loads 10,000.
  - A `PROCGEN*` binding that fails its probe is listed with `error` and re-probed on the next call. A failed probe of an unrelated binding is cached for the facet's lifetime.
  - `test/fake-procgen.js` wraps the real `gatekeeper-procgen/src/generator.ts`, with limit-bound cursors. C2's harness can reuse it.
  - `build.mjs` resolves `tessera/worker` and falls back to `node_modules/tessera/src/layout/worker.ts` until Part A's `exports` land. `test/build.test.js` imports the bundled `data:` worker in Node and gets a real grid layout back.
  - `pack:gadget` has already written `formats/tessera.gadget` (stub client) and the lock at revision 1. Because the formats directory is deployed as a whole, do not deploy before C4. C4's repack will bump the revision to 2.
  - `vp run test` fails in this WSL session with `spawn EBUSY` while loading the vitest config. procgen-explorer's task fails the same way, so the cause is the environment. The same chain run by hand passes: `vitest run`, then `build.mjs`, then `pack-gadget --check`.

### Phase 2: after A and B

**C: client, harness and browser tests**
- [x] C1 `src/client/main.js`: mount, Data popover, restore/persist, reload-once resilience (a saved connector table is fetched before mounting, so a vanished connector falls back to the demo with a toast; pure helpers in `src/client/helpers.js`, tested)
- [x] C2 Opaque-origin fidelity harness (srcdoc, `sandbox="allow-scripts"`, exact CSP, capnweb MessagePort, real `core.js`, optional fake PROCGEN) — `harness/serve.mjs` (127.0.0.1:8791, esbuild-bundles `parent.js` per request); prefix copied verbatim from GadgetUI.tsx:14-118 with capnweb 0.11.1 via a `capnweb?raw` plugin; only addition is an inline CSP-violation reporter (`?cspProbe=0` drops it); state in sessionStorage; `window.harness.reloadGadget()`
- [x] C3 `e2e/harness.test.mjs`, scenarios 1–6 passing in headless Chromium — `pnpm run test:e2e` (7 tests: a detector self-check plus 1–6; real pixel sample works under SwiftShader); no client or server bugs found
- [x] C4 `client.js` size recorded; `pack:gadget` writes `formats/tessera.gadget`, lock and revision (client.js 817.2 KB incl. 10.5 KB worker; archive 294,794 bytes, revision 2)

### Phase 3: coordinator

- [x] D1 Review the diffs (Tessera and blueprint), and fix findings
- [x] D2 (pinned `5fb8520`) Push Tessera `embed-api`; switch the blueprint dependency to `github:harryrobbins/tessera#<sha>`; reinstall; repack (expect a revision bump); the lockfile has no `link:` entry
- [x] D3 Root `pnpm check` passes
- [x] D4 Commit to the starter `main`; gitleaks is clean
- [x] D5 `pnpm deploy`; record Worker versions here
- [x] D6 Production smoke check (Access redirect); list signed-in checks for Harry
- [x] D7 Update memory (deploy state)

## Risks

- **WebGL in headless Chromium on WSL:** SwiftShader should render WebGL2. If it doesn't, assert the canvas's `getContext('webgl2')` and the card count through the handle instead of pixels.
- **Bundle size:** faker `en_GB` is the unknown. If `client.js` exceeds 1.5 MB, replace faker in the gadget build with Tessera's `NameSource` stub interface. The option is then `nameSource`.
- **Git dependency on TypeScript source:** pnpm installs the repo as-is, and esbuild handles `.ts`. Tessera's `@faker-js/faker` is a regular dependency, so it installs.
- **Connector rows:** 10,000 rows is 100 procgen RPCs and 100 activity records, and in a chat preview 100 chat messages. That is why the default is 2,000 and the cap is 10,000, and the README says so.
- **Last-writer-wins view state** between two viewers is acceptable for a visualisation. Shared live cursors are out of scope.

## Later

- A Google Sheets or BigQuery adapter once `gatekeeper-google` is deployed.
- Paste or drop CSV into the gadget. There is no file upload in the sandbox, but `paste` events work.
- Opt-in birds and pixels via server-side `.js` data modules loaded lazily.

## Deployment record (2026-09-23)

Committed as starter `3157780`, with Tessera pinned at `embed-api` `5fb8520` (pushed to GitHub; `main` and the Pages demo are untouched). `pnpm check` passed, then `pnpm deploy` exited 0. `format.tessera` shipped at revision 3; the Workshop upload is 7.3 MB (2.4 MB gzip).

| Worker | Version |
| --- | --- |
| `cfos-error-reporter` | `b8a0fd9b-1ba6-4afe-a43a-ea114bf5a31a` |
| `cfos-context` | `9ec8f13e-1ca7-4a56-9c61-ae2dfafd1354` |
| `cfos-scheduler` | `aad19896-b4de-447d-b7de-94596480f2d5` |
| `cfos-procgen` | `6369e18f-ab97-4512-922f-6f49366b34d1` |
| `cfos-custom-gatekeeper` | `9df9dede-607d-4274-b730-30d9a7358ce8` |
| `cfos-notebook-python` | `049644b5-c723-40aa-9396-bddcd9a4ac69` |
| `cfos-websearch` | `32a3b80b-5f9d-4393-b267-09bc555cf407` |
| `cfos-workshop` | `838a8d92-109e-4ea2-8fea-9590bb4f68b3` |
| `cfos-chat` | `139efb4d-29a6-4889-9c11-20de0f1c9f56` |
| `cfos-router` | `c143eaab-8c6f-42ab-b027-ecf95e0b77cd` |

An unauthenticated probe of `https://cfos.surprisingly.ltd/` returns 302 to the Access login, as expected.

Signed-in checks still to do. Access blocks automated sign-in, so these are for Harry:

1. **New → Tessera Mosaic** opens without a setup page and shows tax cases on the map. Switch the collection and the layout, then reload: the choice is kept.
2. **Titanic** shows 1,309 cards.
3. **Connections tab → Synthetic Data** (it is named `PROCGEN`; if a chat is open, accept its changes). The frame reloads. Then **Data → Daily metrics** shows 730 cards, and "Loaded 730 rows" appears.
4. Check the gadget's Activity: each 100 rows is one recorded read.
