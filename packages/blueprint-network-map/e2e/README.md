# Network map e2e

Two kinds of end-to-end suite:
- **Harness suites** run the real client in sandboxed frames under the gadget CSP. The parent page
  runs the real core, changesets and hub. They need no platform.
- **Platform suite** (`platform.test.mjs`) runs the packed `.gadget` on a real local Cloudflare OS
  Workshop. There the server runs as a Durable Object facet in workerd, and the client runs in the
  Workshop's `iframe[title="Gadget UI"]`.

Every command here runs from `packages/blueprint-network-map` with the Linux node, so that
`import "playwright"` resolves. `playwright@1.61.0` matches the cached Chromium; never run
`playwright install` on this distro.

```bash
eval "$(fnm env)" && fnm use v24.21.0 >/dev/null
```

## Harness suites

Each suite starts its own harness server on its own port and builds its own dist directory, so the
suites can run in parallel. No file watchers are involved.

| Command | Port / dist | Covers |
|---|---|---|
| `node --test --test-concurrency=1 e2e/harness.test.mjs` | 8801 / `dist` | Loading under the CSP, list fallback without WebGL, two-pane edits and presence, conflict rebase, quick add, cascade delete + undo, shared layout, and recovery after a facet restart (reload if clean; recovery screen if unsaved) |
| `node --test e2e/profile.test.mjs` | 8811 / `dist-profile` | Profile panel and list mode |
| `node --test e2e/design.test.mjs` | 8821 / `dist-design` | Design tab: rules, filter/showcase/focus, views, types, fields |
| `node --test e2e/data.test.mjs` | 8831 / `dist-data` | Data and Activity: paste imports, re-import by source, undo of an import, Kumu JSON, per-entry undo |
| `node e2e/bench.mjs [--headed] [--sizes 1000x3000,10000x30000]` | 8805 / `dist` | Load-to-interaction, edit latency, snapshot transfer and heap. SwiftShader frame rates are not GPU numbers. |

`harness.test.mjs` passed 9/9 in 25 s on 2026-09-24, with the `isTransportError` fix below.

## Platform suite

### 1. Start one local platform

```bash
# from the repo root; refuses if something listens on :8787 or a run-dev-server is running
CFOS_LOG=/tmp/claude-1000/netmap-platform.log packages/blueprint-network-map/e2e/start-local-platform.sh
```

`start-local-platform.sh` is the whiteboard's script (see
`packages/blueprint-whiteboard/e2e/README.md` section 1) with two changes:
- **Guard.** It refuses to start only if something already listens on :8787 or a `run-dev-server`
  launcher is running. Wrangler/workerd processes from other worktrees that do not serve :8787 do
  not block it.
- **State dir.** The PGID file is in `${TMPDIR:-/tmp}/netmap-local-platform/`.

Everything else is unchanged:
- The patched launcher copy, with `--no-cache` and no per-gatekeeper watchers.
- `setsid` puts the server in its own process group.
- The Access-mode frontend check.
- `REPO` is three levels above `e2e/`, so it runs this checkout's `cloudflare-os/` submodule.

`stop-local-platform.sh` kills only that process group, then checks that :8787 is free. Always run
it, including after a failure.

The first start in a fresh worktree took **52 s**. That includes `pnpm install` in `cloudflare-os/`,
the typed-storage build, the Workshop frontend build and the server boot.

### 2. Pack and run

```bash
node scripts/build.mjs && node scripts/pack-gadget.mjs     # writes ../../formats/network-map.gadget
CFOS_LOG=/tmp/claude-1000/netmap-platform.log PLATFORM_SHOTS=/tmp/claude-1000/netmap-platform-shots \
  node --test --test-concurrency=1 e2e/platform.test.mjs
cd ../.. && packages/blueprint-network-map/e2e/stop-local-platform.sh
ss -ltn | grep 8787 || echo free
```

**Environment variables**

| Variable | Default | Purpose |
|---|---|---|
| `CFOS_URL` | `http://localhost:8787` | Workshop URL |
| `PLATFORM_SHOTS` | `${TMPDIR:-/tmp}/netmap-platform-shots` | Screenshots, exported files, `timings.json` and `server-console.log`. A failing test adds `FAIL-<test>.png` and `FAIL-<test>.json`, with frame console, page errors, owner `server:` lines and platform log lines. |
| `CFOS_LOG` | `${TMPDIR:-/tmp}/cfos-local-platform.log` | The platform log scanned for stub warnings and runtime crashes. Use the same value as for the start script. |

**Suite setup**
- Each run uploads the archive at `/blueprints` and creates a new workspace. It needs no clean
  `.wrangler`, because `signUpOrIn` copes with existing accounts.
- Users: `alice` (owner) and `bob` (use-role share link), each in their own 1600x1000 context.
- Chromium runs with SwiftShader WebGL, so the map renders on the canvas and not in list mode.

**How the tests reach the map**
- `platform-helpers.mjs` holds the Workshop steps (copied from the whiteboard) and the map helpers.
- `mapFrame(page)` re-acquires the gadget iframe on each call and waits until
  `globalThis.networkMap.app.model` exists and the store is `live`. It survives both frame reloads
  and iframe rebuilds.
- A context init script records `securitypolicyviolation` events in every frame. It does reach the
  srcdoc gadget frame.

| Test | What it checks |
|---|---|
| P0 | **Boot.**<br>• Create Gadget goes straight to `/workspace/<id>`, with no setup page.<br>• The demo map is live on the WebGL canvas (`app.mode === "map"`) with 16 elements and 22 connections.<br>• The demo banner shows.<br>• `store.viewer.name === "alice"` comes from `gadgetViewer`, which is not a global.<br>• There is no `<form>` and no dialog.<br>• There are no gadget-frame console errors, no blocked form submissions, no CSP console errors and no `securitypolicyviolation` events. |
| P1 | **Persistence and attribution.**<br>• Alice renames demo `e_000000000001` and creates an element through `store.apply`.<br>• Both survive a full page reload.<br>• `updatedBy` and `createdBy` are `alice`, and the version is bumped by 1. |
| P2 | **Two users.**<br>• Bob opens a use-role link. He has no Share and no Code tab, his viewer name is `bob`, and he loads alice's persisted rename.<br>• Alice's live edit reaches bob.<br>• Bob's new element reaches alice with `createdBy: "bob"`.<br>• Alice's `app.select` shows up in bob's `store.peers`, under her name and with that selection.<br>• Each browser shows the other's avatar button.<br>• Bob's frame has no errors and no CSP violations. |
| P3 | **Import through the real Data tab DOM.**<br>• Alice pastes Kumu Elements and Connections TSV, then runs Preview. The summary reads `3 elements · 2 connections…`.<br>• She continues to review and accepts. The outcome is `applied`.<br>• The 3 elements and 2 connections exist in both browsers with the same ids and `provenance.origin: "import"`. |
| P4 | **Export.**<br>• The `Export Gadget` menu offers exactly: Network map backup (JSON), Kumu JSON, Elements (CSV), Connections (CSV), GraphML and GEXF.<br>• The backup JSON parses, has every element and contains the edited, created and imported labels.<br>• The Kumu JSON parses, has one entry in `elements` per element, and has the labels under `attributes.label`.<br>• The GraphML parses as XML (`DOMParser`), with root `graphml` and one `<node>` per element. |
| P5 | **Code-edit recovery** (the whiteboard's T10).<br>• Alice inserts one comment at the end of `server.js` in Monaco while bob is open.<br>• Bob's frame must reload itself and stay live for 3 s.<br>• Alice goes back to the `Map` tab.<br>• Then elements created in each browser reach the other, attributed to their creators. |
| P7 | **Scale on a facet.** This test measures and only gates on completeness.<br>• Alice's store applies 2,000 elements and then 4,000 connections, 2,000 ops per `apply`. The store sends 1,000 per request.<br>• It records the time until alice has nothing pending and the time until bob's model has every element.<br>• Bob's frame then reloads, and the test records time-to-model, snapshot pages and bytes (re-read through `store.call`) and the JS heap. |
| P6 | **Platform log.**<br>• Syncing still works at the end of the suite.<br>• Across the whole suite, the platform log (`CFOS_LOG`) and the owner `server:` console show no "RPC stub/result was not disposed properly" and no "Workers runtime crashed". |

## Verified 2026-09-24

**Environment**
- WSL2, Node v24.21.0, Playwright 1.61.0 headless Chromium with SwiftShader.
- Branch `feat/network-map` (starter 5f8c12c) in the `cloudflare-os-starter-netmap` worktree.
- `cloudflare-os/` at 0bef286.
- `formats/network-map.json` revision 2.

**Runs.** Five runs against one platform instance:

| Run | Result | Time | Notes |
|---|---|---|---|
| 1 | Failed | 204 s | Found the `isTransportError` bug below, which failed P5 and cascaded to P7 and P6. A test bug also failed P4: Kumu labels are under `attributes.label`. |
| 2 | 7/8 | 48 s | P6 caught one "An RPC stub was not disposed properly" line in the platform log. It appeared during P5, between the old facet's "Gadget restarted due to code update." errors and the old session's "Peer closed WebSocket: 1001". |
| 3 | 8/8 | 46 s | No log problems |
| 4 | 8/8 | 55 s | No log problems |
| 5 | 8/8 | 52 s | No log problems |

The whiteboard suite records the same pattern in its README: a stub warning at the code-edit restart
in some runs only. It is most likely an object held by the aborted facet that is finalised without a
dispose. P6 stays strict, so a repeat fails the suite.

**Timings** (runs 3-5)

| Step | Time |
|---|---|
| Upload | 1.1-1.2 s |
| Create Gadget to alice's map live | 4.5-4.7 s |
| Full page reload to live | 1.8-2.4 s |
| Bob's share link to live | 1.8-2.0 s |
| Alice's edit reaches bob | 117-136 ms |
| Bob's create reaches alice | 160-165 ms |
| Alice's selection reaches bob's peers | 206-247 ms |
| Data tab: stage to review | 0.39-0.43 s |
| Data tab: accept to outcome | 0.33-0.39 s |
| Data tab: accept to bob having the objects | 0.6-0.7 s |
| Each export | 0.25-0.3 s (backup 24 KB, Kumu 11 KB, GraphML 11 KB) |
| P5: edit to bob's frame reloaded and live | 1.4-3.6 s |
| P5: sync after the restart | 140-200 ms each way |

In P5, bob goes `reconnecting`, then shows "Reconnecting…", then his frame reloads. He never sees the
recovery screen.

**P7: the S1/S2 recheck on a facet**

| Measurement | Result |
|---|---|
| Fill (2,000 elements + 4,000 connections, three `apply` chunks of 2,000 ops) | **1.8-2.3 s** until alice has nothing pending (0.52-0.80 s per chunk) |
| Fill to bob's model holding every element | 2.7-3.2 s |
| Bob's reload to model (subscribe, paged snapshot, model, render) | **0.56-0.78 s** |
| Snapshot | **2 pages**, 6,063 objects, 1.09 MB JSON. Re-reading it through bob's store took 119-177 ms. |
| JS heap | Alice 72-86 MB, bob after reload 29-57 MB (Chromium `performance.memory`). Facet memory is not observable from the page. |
| Errors | No frame errors and no platform-log problems |

## Bug found only on the platform (fixed)

**File:** `src/client/sync/store.js:60`, `isTransportError()`.

**Problem.** After a code edit, the real Workshop aborts the facet with
`new Error("Gadget restarted due to code update.")`. The source is
`cloudflare-os/packages/workshop-backend/src/overseer.ts:3491`, in `bumpVersion` →
`ctx.facets.abort`. Every later call on the old stub fails with that message. The classifier regex
did not match it, so `failTransport()` returned early:
- The heartbeat failed every 4 s, but the store stayed `live`.
- A use-role viewer never reloaded and silently stopped syncing.

The harness did not catch this because its simulated restart throws "RPC stub is broken: the gadget
facet restarted", which does match.

**Fix.** Add `restart` to the regex. `harness/parent.js:179` could also throw the platform's exact
message, so that the harness covers this path.
