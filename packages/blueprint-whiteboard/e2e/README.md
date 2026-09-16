# Local platform e2e (Cloudflare OS Workshop + Playwright)

Verified 2026-09-16 on WSL2 (kernel 6.6.114.1, Node v24.21.0, 11 cores) against the pinned
`cloudflare-os/` submodule. The local Workshop really executes gadget code: Worker Loader + Durable
Object facets run in workerd, storage persists, `.gadget` upload works, exports and share links work.

## 1. Start the local platform

`pnpm run-local` in `cloudflare-os/` does **not** boot as-is on this box: its pre-flight runs
`vp run -r --cache build:app:dev` and Vite+'s cached task mode fails with `Error: spawn EBUSY`
(esbuild spawn inside vp's tracked sandbox), so the gatekeeper app UI build aborts. It also starts
a `vite build --watch` per gatekeeper once Wrangler is up (heat).

Workaround without touching the submodule: `start-local-platform.sh` copies
`scripts/run-dev-server.ts` into a temp dir at run time and patches the copy (imports point back at
the submodule, `--cache` becomes `--no-cache`, the per-gatekeeper watchers are skipped). It refuses
to start if a wrangler/workerd/run-dev-server process already exists, builds typed-storage and the
Workshop frontend when their outputs are missing (or `CFOS_REBUILD=1`), starts the server with
`setsid` in its own process group, waits for the URL and prints the PGID.

```bash
eval "$(fnm env)" && fnm use v24.21.0 >/dev/null
packages/blueprint-whiteboard/e2e/start-local-platform.sh    # -> "PGID <n>" ... "READY http://localhost:8787"
packages/blueprint-whiteboard/e2e/stop-local-platform.sh     # kills the group, then checks ps is clean
```

- **Access-mode frontend**: if `workshop-frontend/dist` was built with `VITE_CF_ACCESS_MODE=true`
  (a deploy build), `/signup` never shows its form and every sign-up times out. The script detects
  this (only such a bundle contains `authenticateFromCfAccess` / "Authenticating...") and rebuilds
  the frontend with the flag unset. Rebuild with Access mode again before a deploy that reuses dist.
- State: patched launcher + PGID file in `${TMPDIR:-/tmp}/cfos-local-platform/`; log in
  `${TMPDIR:-/tmp}/cfos-local-platform.log` (`CFOS_LOG` overrides). Manual stop: `kill -- -<PGID>`.
- The script fails loudly if an upstream change stops one of the sed patches from applying.

- URL: **http://localhost:8787** (frontend served as static assets by the backend Worker).
- Timings: install+typed-storage+frontend `vite build` ~20 s; server (28 configurator/app UI builds
  with `--no-cache`, then Wrangler bundling all workers) ready in **~25-34 s**; the very first `GET /`
  takes ~15 s. So ~1 min cold, ~35 s on later starts.
- No env vars needed. No `CF_ACCESS_AUD` -> password auth with open sign-up. No AI keys needed
  (chat shows "No agent"; gadgets without `aiModel` bindings create without configuration).
- Wrangler still watches `packages/workshop-backend/src` (it logged one restart right after boot
  when the pre-flight regenerated files there); harmless.
- Data lives in `cloudflare-os/.wrangler/` (gitignored). Delete it for a clean slate; the helpers'
  `signUpOrIn` copes with accounts that already exist.
- Generated files (`wrangler.dev.jsonc`, `src/generated/*`, `.run-local-stamp`) are all gitignored
  in the submodule; `git status` there stays clean.

## 2. Run the helpers

`playwright@1.61.0` is a devDependency of this package (it matches the cached
`~/.cache/ms-playwright/chromium*-1228`; never run `playwright install` on this distro). Run with
the Linux node from this package dir so `import 'playwright'` resolves.

## 3. Verified selectors / flows (`platform-helpers.mjs`)

| Step | Selector / behaviour |
| --- | --- |
| Sign up | `/signup`; `getByLabel('Username')`, `getByLabel('Password', {exact:true})`, `getByLabel('Confirm Password')`, button `Create account`. Username must match `/^[a-z0-9_-]+$/i` (so `alice`, **not** `alice@example.com`), password >= 8. Success = `localStorage.authToken` set + redirect to `/`. Taken name -> text `Username already exists`. |
| Onboarding | New accounts get a full-screen wizard (heading `Let's set you up`) instead of any route: click `Next` until button `Let's build` shows, click it. |
| Sign in | `/` with `Username` / `Password` labels, button `Sign in`. |
| Upload | `/blueprints` (h1 `Blueprints`); hidden `input[type="file"][accept=".gadget"]` -> `setInputFiles`; toast `Blueprint uploaded`; rows are `a[href="/blueprint/<id>"]` (id is 32 hex). |
| Create | `/blueprint/<id>`, button `Create Gadget` -> hard navigation to `/workspace/<64-hex id>`. |
| Gadget UI | `page.frameLocator('iframe[title="Gadget UI"]')` (sandboxed `srcdoc`). Same title in owner (GadgetEditor) and use-role (GadgetUseView) views. |
| Export (whiteboard) | Labels are `SVG image` (server mode), `HTML`, `PDF` (browser mode). Pass exact regexes (`/^SVG image$/`) to `downloadExport`. After one export the button keeps focus and its tooltip intercepts the next click; `openExportMenu` blurs and moves the pointer away first. |
| Export | button `Export Gadget` (download icon in the pane header) opens `role=menu`; formats are `role=menuitem` with the format `label`; loading skeleton is `role=status name="Loading export formats"`. Download: delete `window.showSaveFilePicker` first so the blob `<a download>` path fires a Playwright `download` event. |
| Share | header button `Share workspace` -> `Create a share link` -> role dropdown `Access granted by link` (the `use` role is labelled **Gadget only** and is the default; `build` = "Workspace") -> `Create link` -> "Link ready" card, URL in `p.font-mono`: `http://localhost:8787/workspace/<id>#share=<key>`. |
| Share redeem | Signed-in second user (separate browser context) opens the URL; the `#share` fragment is consumed and they land on the gadget-only view (has `Export Gadget`, no `Share workspace`). The plain `/workspace/<id>` URL keeps working for them afterwards. |

## 4. Whiteboard suite (`platform.test.mjs`)

Users `alice` (owner) and `bob` (via a `use`-role share link) in their own browser contexts at
1920x1000, plus `carol` (a third use-role context) in T6. The suite uploads the shipped
`formats/whiteboard.gadget` as is. Everything inside the gadget runs through the same selectors
(`SEL`) and `inPane` evaluation as the harness suite. On the platform, `window.whiteboardStore` and
`window.whiteboardCanvas` live inside `iframe[title="Gadget UI"]`, and `inPane(frameLocator, fn)`
reaches them. Whiteboard helpers are in `platform-whiteboard-helpers.mjs`.

```bash
eval "$(fnm env)" && fnm use v24.21.0 >/dev/null
ps -ef | grep -E 'wrangler|workerd|run-dev-server' | grep -v grep     # must be empty
packages/blueprint-whiteboard/e2e/start-local-platform.sh              # repo root; ~30 s warm
pnpm --filter blueprint-whiteboard pack:gadget                         # rebuilds dist, writes formats/whiteboard.gadget (bumps revision on change)
cd packages/blueprint-whiteboard
PLATFORM_SHOTS=/tmp/whiteboard-platform-shots \
  node --test --test-concurrency=1 e2e/platform.test.mjs               # ~2.5-3 min against a warm server
cd ../.. && packages/blueprint-whiteboard/e2e/stop-local-platform.sh   # always, also after a failure
```

- Env: `CFOS_URL` (default `http://localhost:8787`), `PLATFORM_SHOTS` (screenshots, exports,
  `timings.json`, `server-console.log`), `CFOS_LOG` (platform log scanned for stub warnings and
  runtime crashes; same default as the start script).
- Each test starts from an empty board (alice deletes everything through her store), the Select
  tool and the camera at the world origin. When a test fails, `FAIL-<test>.png` and `FAIL-<test>.json`
  are written: frame console, frame errors, owner `server: ` lines, and platform log problems.
- Server logs: the owner's Workshop page receives each facet `console.*` call as a browser
  console message prefixed `server: `. workerd's own "RPC stub/result was not disposed properly"
  warnings and "The Workers runtime crashed unexpectedly" are **not** sent there. They appear
  only in the platform log, so the suite scans both. `timings.logProblemsByTest` attributes log
  problems to the test during which they appeared.

| Test | What it checks |
| --- | --- |
| 0a | Shipped client boots. The name dialog joins via the button (alice) and Enter (bob). No `<form>`, no blocked form submissions, no gadget-frame console errors. |
| T1 | Alice drags a sticky slowly with the real pointer. Bob sees `.wb-ghost` move before release, nothing is committed before release, then the committed position arrives and the ghost goes. |
| T2 | Pen tool. Bob's `.wb-peer-stroke` path grows while alice draws, then a committed `pen` object replaces it. |
| T3 | Same sticky, two phases. (a) Real pointer drags in both browsers at once. (b) `store.updateObjects` in both frames in the same tick. Both deltas land in both settled stores and in a fresh subscription (bob's frame reloaded). |
| T4 | Alice selects a sticky that has a connector and presses Delete. Both vanish for bob. |
| T5 | Bob clicks alice's avatar and follows her hand-tool pans (viewport centres within 5). Bob panning stops following, and alice's later pans don't move him. |
| T6 | Carol starts a drag and her tab dies without releasing, first by renderer crash (`Page.crash`, no pagehide) and then by `context.close()`. Alice's ghost and carol's avatar go within 15 s, and the object stays at its committed position. |
| T7 | 500 objects seeded through alice's store (5 × 100). Bob pans with the hand tool (rAF frame times). A remote single-object update adds `objectRenders` 1..5 and `fullRenders` 0 in bob's `__wbRenderStats`. |
| T8 | Bob's use-role chrome has no Share, no Code tab and no Monaco, but has Export. Bob adds a sticky and types into it through the UI, and alice sees the text. Bob pointer-moves it, and alice sees the move. |
| T9 | Export menu offers exactly `SVG image`, `HTML`, `PDF`. The SVG parses as XML (browser `DOMParser`) with every object's `data-id`. The HTML contains `<svg`. The PDF starts with `%PDF-`. |
| T10 | Alice inserts one comment into `server.js` in Monaco (one code-version bump, one facet restart) while bob is open. Bob must go live again (self-reload keeping the name, or an in-place resubscribe) and stay live for 3 s. Syncing then works both ways. |
| T11 | Alice's pointer moves over the canvas at 60 Hz for 5 s. A capture listener in alice's frame logs each pointer's world position and time, and bob's store subscription logs each change to alice's peer cursor. Asserts lag p95 <= 300 ms, no growth from the first to the last second, and convergence within 1 s of stopping. |
| T12 | Bob reloads his gadget frame 10 times, then closes and reopens his context. Alice must see exactly one peer. Alice then creates and deletes 200 bulky stickies 3 times, and 5 s later syncing still works. Neither the owner console nor the platform log may show a stub warning or runtime crash. |

Verified 2026-09-16 (formats/whiteboard.json revisions 1-3, with the store/canvas under concurrent
edit). Runs 2, 3 and 4 passed 13/13 in 154-169 s; run 4 was on a freshly restarted platform. Typical
numbers: ghost visible 0.83 s after drag start (the drag threshold plus the first presence send),
release to commit on bob 25-70 ms, delete to bob about 80 ms, follow converged about 0.5 s. Crashed
tab: ghost gone after 1.5-2.5 s. Closed context: under 0.15 s. 500 objects: bob pans at 16.7 ms
frames (p95 16.8) with no object or full renders, and a remote update causes 1 object render and
0 full renders. Exports: SVG 0.2 s, HTML 1.1 s, PDF 0.8 s. Code edit: bob reloads itself 2.9-4.5 s
after the edit and is live about 0.25 s later. Alice (owner) gets a rebuilt iframe when she
switches back from Code, so she sees the name dialog again (platform behaviour, recorded in
`notes`). Presence: bob receives alice's cursor at about 15 Hz, lag p50 26-31 ms and p95 39-49 ms,
and converges 40-50 ms after she stops. Frame reload: about 2.15 s each. In run 1 (the first run
on a fresh platform, revision 1), the platform log showed one "An RPC stub was not disposed
properly" during setup and one "An RPC result was not disposed properly" between the T10 restart
and T12. Neither came back in later runs.
