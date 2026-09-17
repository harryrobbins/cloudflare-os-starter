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
packages/blueprint-kanban/e2e/start-local-platform.sh    # -> "PGID <n>" ... "READY http://localhost:8787"
packages/blueprint-kanban/e2e/stop-local-platform.sh     # kills the group, then checks ps is clean
```

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
the Linux node from this package dir so `import 'playwright'` resolves:

```bash
cd /var/web/cloudflare-os-starter/packages/blueprint-kanban
eval "$(fnm env)" && fnm use v24.21.0 >/dev/null
node e2e/smoke-hello.mjs /path/to/hello.gadget          # full upload/create/export/share check
```

Whole smoke run takes ~19 s against a warm server (verified: exit 0, PASS).

## 3. Verified selectors / flows (`platform-helpers.mjs`)

| Step | Selector / behaviour |
| --- | --- |
| Sign up | `/signup`; `getByLabel('Username')`, `getByLabel('Password', {exact:true})`, `getByLabel('Confirm Password')`, button `Create account`. Username must match `/^[a-z0-9_-]+$/i` (so `alice`, **not** `alice@example.com`), password >= 8. Success = `localStorage.authToken` set + redirect to `/`. Taken name -> text `Username already exists`. |
| Onboarding | New accounts get a full-screen wizard (heading `Let's set you up`) instead of any route: click `Next` until button `Let's build` shows, click it. |
| Sign in | `/` with `Username` / `Password` labels, button `Sign in`. |
| Upload | `/blueprints` (h1 `Blueprints`); hidden `input[type="file"][accept=".gadget"]` -> `setInputFiles`; toast `Blueprint uploaded`; rows are `a[href="/blueprint/<id>"]` (id is 32 hex). |
| Create | `/blueprint/<id>`, button `Create Gadget` -> hard navigation to `/workspace/<64-hex id>`. |
| Gadget UI | `page.frameLocator('iframe[title="Gadget UI"]')` (sandboxed `srcdoc`). Same title in owner (GadgetEditor) and use-role (GadgetUseView) views. |
| Export | button `Export Gadget` (download icon in the pane header) opens `role=menu`; formats are `role=menuitem` with the format `label`; loading skeleton is `role=status name="Loading export formats"`. Download: delete `window.showSaveFilePicker` first so the blob `<a download>` path fires a Playwright `download` event. |
| Share | header button `Share workspace` -> `Create a share link` -> role dropdown `Access granted by link` (the `use` role is labelled **Gadget only** and is the default; `build` = "Workspace") -> `Create link` -> "Link ready" card, URL in `p.font-mono`: `http://localhost:8787/workspace/<id>#share=<key>`. |
| Share redeem | Signed-in second user (separate browser context) opens the URL; the `#share` fragment is consumed and they land on the gadget-only view (has `Export Gadget`, no `Share workspace`). The plain `/workspace/<id>` URL keeps working for them afterwards. |

## 4. Board suite (`platform.test.mjs`)

Two users (`alice` owner, `bob` via a `use`-role share link), each in their own browser context at
1920x1000, against the running platform. It uploads the shipped `formats/board.gadget` as is (no
shim):

```bash
eval "$(fnm env)" && fnm use v24.21.0 >/dev/null
packages/blueprint-kanban/e2e/start-local-platform.sh
pnpm --filter blueprint-kanban pack:gadget                           # repo root -> formats/board.gadget (bumps revision)
cd packages/blueprint-kanban
PLATFORM_SHOTS=/tmp/kanban-platform-shots \
  node --test --test-concurrency=1 e2e/platform.test.mjs              # ~55 s against a warm server
cd ../.. && packages/blueprint-kanban/e2e/stop-local-platform.sh
```

- `CFOS_URL` (default `http://localhost:8787`), `PLATFORM_SHOTS` (screenshots, `timings.json`,
  exported CSV/HTML).
- Platform facts the client depends on (all reproduced by the harness, see `harness/README.md`):
  `gadget` / `gadgetViewer` / `RpcTarget` are module-scope bindings in a prefix prepended to
  `client.js`, not `globalThis` properties (`gadgetViewer` = `{id, displayName, role}` of the
  signed-in account, from the forked submodule's `GadgetClient.getViewer()` patch; the frontend
  must be rebuilt from that submodule, so start the platform with `CFOS_REBUILD=1` after changing
  it); the iframe sandbox has no `allow-forms`, so the UI never uses form
  submission; after a code edit restarts the facet, the iframe's `gadget` stub rejects every call
  forever, so the board reloads its own frame (keeping the viewer's colour in `window.name`).
- Names: nobody is asked for one. Every change is attributed to the account's display name, which
  for a password sign-up is the username as typed (`createAccount(username, username, ...)`), so
  the suite expects `alice` and `bob` (`accountDisplayName()` in `platform-kanban-helpers.mjs`).
  The me button (`.me-btn .me-name`) shows it and only opens a colour dialog.
- Tests: `0a` shipped client boots without a name dialog and shows the account name; `0b` neither
  alice (owner) nor bob (use-role link) sees a name prompt, both me buttons show the account
  display names, no blocked form submissions; `T1` create -> other browser; `T5` use-role chrome; `T2`
  concurrent drags; `T3` title conflict banner + "Use theirs"; `T8` CSV/HTML export (the "Created by" column is the creating account's name); `T6` code edit
  in Monaco (a single `keyboard.insertText` into `server.js`, which bumps the code version and
  aborts the facet): bob's frame must reload itself, keep his account name (never a name prompt) and keep
  syncing both ways; reload; bulk 30 cards; `T4` presence ring/avatar after a renderer crash and after
  `context.close()`. `T7` (agent chat) needs a model and is not run locally.
- Verified 2026-09-16 (revision 2): 11/11 pass in ~54 s. T6: bob `reconnecting` at ~2.6 s after the
  edit, "Reconnecting…" overlay at ~4.0 s (3 failed subscribes), live again after the self-reload
  at ~4.5 s. Alice (owner) gets a rebuilt iframe when she switches back from the Code tab
  (platform behaviour, noted in `timings.json`).
- Verified 2026-09-17 (revision 6, account names from `gadgetViewer`): 11/11 pass in ~64 s. T6: bob
  live again after the self-reload at ~3.2 s; alice's rebuilt iframe came back under her account
  name with no dialog.
