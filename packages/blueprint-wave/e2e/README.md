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
packages/blueprint-wave/e2e/start-local-platform.sh    # -> "PGID <n>" ... "READY http://localhost:8787"
packages/blueprint-wave/e2e/stop-local-platform.sh     # kills the group, then checks ps is clean
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
| Export again | After one export the button keeps focus and its tooltip intercepts the next click; `openExportMenu` blurs and moves the pointer away first. Pass exact regexes (`/^Markdown$/`) to `downloadExport`. |
| Export | button `Export Gadget` (download icon in the pane header) opens `role=menu`; formats are `role=menuitem` with the format `label`; loading skeleton is `role=status name="Loading export formats"`. Download: delete `window.showSaveFilePicker` first so the blob `<a download>` path fires a Playwright `download` event. |
| Share | header button `Share workspace` -> `Create a share link` -> role dropdown `Access granted by link` (the `use` role is labelled **Gadget only** and is the default; `build` = "Workspace") -> `Create link` -> "Link ready" card, URL in `p.font-mono`: `http://localhost:8787/workspace/<id>#share=<key>`. |
| Share redeem | Signed-in second user (separate browser context) opens the URL; the `#share` fragment is consumed and they land on the gadget-only view (has `Export Gadget`, no `Share workspace`). The plain `/workspace/<id>` URL keeps working for them afterwards. |

## 4. Wave suite (`platform.test.mjs`)

Nobody is asked for a name: the Wave runs under the signed-in account's display name, which the
platform injects as `gadgetViewer` (our fork's patch). On the local platform a password sign-up's
display name is the username as typed, so alice, bob and carol appear as `alice`, `bob`, `carol`
(`accountDisplayName()` in `platform-wave-helpers.mjs`). `waveIdentity()` and `ensureLive()`
replace the old name-dialog joining: they assert there is no name prompt
(`SEL.namePrompt`) and that the me button and the store's viewer carry the account name. T0 checks
this for the owner and the use-role link, T4 and T8 after a frame reload and a code edit, T6 and
T11 for carol, and T13 and T14 check that replies, reviews and decisions carry the account name.
The platform must be started with a frontend that carries the `gadgetViewer` injection
(`CFOS_REBUILD=1` after updating the submodule).

Setup needs `OPENROUTER_API_KEY`: the Wave declares a `Model` binding with Qwen suggested, so the
suite adds that model to alice's account through **AI providers → Add provider → Other
OpenRouter...** (`platform-model-helpers.mjs`; the key is typed into the Workshop's dialog, never
written to a file) and creates the Wave from the prefilled blueprint page. `WAVE_ARCHIVE` points
the suite at a trial pack instead of `formats/wave.gadget`.

```bash
set -a; . /path/to/.env.local; set +a        # OPENROUTER_API_KEY
node --test --test-concurrency=1 e2e/platform.test.mjs
node e2e/platform-spikes.mjs                  # paste, IME, phone, links (SPIKES=phone,links to pick)
```

Runs on 2026-09-17, final code, about 5 to 6 minutes each (evidence screenshots and `timings.json`
in `PLATFORM_SHOTS`):

- Full run 1: 15/16. T10 failed on a wrong check (it compared the whole brief with a replacement
  that only covers the quoted passage); fixed, then T10 passed twice on its own.
- Full run 2: 14/16. T10 failed because OpenRouter rate-limited `qwen/qwen3.8-flash` upstream (429);
  the Wave showed the run as failed with that error. **T13 failed intermittently**: after T12's
  server churn, bob's edit stayed "Saving…" for more than 15 s (no client error, nothing in the
  log). T12 then T13 passed on their own twice. Suspected: a `pushText` that hangs rather than
  rejects after a restart, which the client only abandons after `PUSH_TIMEOUT_MS` (30 s). Open
  for the sync review.

| Test | What it proves | Measured |
| --- | --- | --- |
| T0 | Boots under account names for owner and use-role link; no name prompt; templates; no console errors | create to live 4.2 s |
| T1 | Two browsers type interleaved words in one blip; identical text, nothing lost or duplicated | converged 5.4 s after 20 words each |
| T2 | Remote caret drawn in the right place and follows text inserted above it | caret seen 86 ms |
| T3 | A paragraph reply stays on its paragraph after text above it is edited | |
| T4 | Frame reload mid-typing: acknowledged text intact; unsent text offered back (harness 4/4b force the unsent case) | reload to live 1.5 s |
| T5 | History replays in order from each blip's create; scrubber end equals live | |
| T6 | Crashed, then closed, tab: caret, editing chip and avatar gone | under 3 s |
| T7 | 15,000-character blip stays responsive; pushes are bytes, not the document | max push 50 bytes |
| T8 | Owner edits server.js; use-role frame reloads itself and both keep syncing | about 1.4 s each way after recovery |
| T9 | The chat's calls (`getWaveMarkdown`, `reply`) make a live summary reply with blip links | reply to bob 210 ms |
| T10 | Ask agent with the real model: sourced agent blip; stale proposal refuses Accept; double Accept applies the quoted replacement once | Summarise 4.4-5.5 s |
| T11 | Three typists for 30 s: rate under budget, remote text within 1 s, no lag growth | 8.6 pushes/s; p50 156 ms, max 200 ms |
| T12 | 10 frame reloads, a closed context and server churn: no undisposed-stub warnings, no crash | |
| T13 | Use role has no Share or Code, and can edit, reply and review under its account name | |
| T14 | Decisions Markdown export; platform Markdown, HTML and PDF exports | |
| T15 | Restart during a model call: viewers recover, nothing respawns | live again 3.9 s |
