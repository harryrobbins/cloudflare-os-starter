# Local platform e2e (Cloudflare OS Workshop + Playwright)

Verified 2026-09-16 on WSL2 (kernel 6.6.114.1, Node v24.21.0, 11 cores) against the pinned
`cloudflare-os/` submodule. The local Workshop really executes gadget code: Worker Loader + Durable
Object facets run in workerd, storage persists, `.gadget` upload works, exports and share links work.

## 1. Start the local platform

`pnpm run-local` in `cloudflare-os/` does **not** boot as-is on this box: its pre-flight runs
`vp run -r --cache build:app:dev` and Vite+'s cached task mode fails with `Error: spawn EBUSY`
(esbuild spawn inside vp's tracked sandbox), so the gatekeeper app UI build aborts. It also starts
a `vite build --watch` per gatekeeper once Wrangler is up (heat).

Workaround without touching the submodule: a patched copy of `scripts/run-dev-server.ts` that uses
`--no-cache` and can skip watchers. Generate it into any scratch dir (paths are absolute):

```bash
C=/var/web/cloudflare-os-starter/cloudflare-os
OUT=/tmp/run-dev-server-spike.ts   # anywhere outside the submodule
sed -e "s#from \"\./#from \"$C/scripts/#g" \
    -e "s#^import { parse } from .*#import { createRequire } from \"node:module\"; const { parse } = createRequire(\"$C/scripts/run-dev-server.ts\")(\"jsonc-parser\");#" \
    -e "s#^const SCRIPTS_DIR = .*#const SCRIPTS_DIR = \"$C/scripts\";#" \
    -e 's#"--cache"#"--no-cache"#g' \
    -e 's#^function spawnDevWatcher(label: string, command: string, args: string\[\]): void {#&  if (process.env.SPIKE_NO_WATCHERS) return;#' \
    $C/scripts/run-dev-server.ts > $OUT
```

First time only (or after submodule source changes), build the frontend bundle + typed-storage.
Either run `pnpm run-local` once and let it fail at the EBUSY step (it writes `.run-local-stamp`
and `packages/workshop-frontend/dist` before failing), or run the two builds directly:

```bash
eval "$(fnm env)" && fnm use v24.21.0 >/dev/null
cd $C && pnpm install && pnpm --filter @gadgets/typed-storage build \
  && pnpm --filter @gadgets/workshop-frontend exec vite build
```

Start (own process group, no watchers, log to file):

```bash
ps -ef | grep -E 'vite|wrangler|workerd' | grep -v grep     # nothing should already be running
cd $C && eval "$(fnm env)" && fnm use v24.21.0 >/dev/null && \
  SPIKE_NO_WATCHERS=1 setsid node $OUT --serve-frontend-assets > /tmp/run-local.log 2>&1 < /dev/null & echo $!
# wait for: until curl -sf -o /dev/null http://localhost:8787/; do sleep 2; done
```

Stop: `kill -- -<pid printed above>` (it is the process-group id), then confirm with the `ps` line.

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
