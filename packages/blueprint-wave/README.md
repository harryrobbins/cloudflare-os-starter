# blueprint-wave

Source of the **Wave** format: a threaded, co-edited conversation gadget for Cloudflare OS that turns a live discussion into a recorded decision, with an agent that summarises and proposes with sources, and a Markdown export.

The plans are in [wave-blueprint.md](../../docs/plans/wave-blueprint.md) (scope and design) and [wave-blueprint-implementation-1.md](../../docs/plans/wave-blueprint-implementation-1.md) (the binding UX, technical and implementation plan). The gadget's own user guide and RPC reference is [`src/README.md`](src/README.md), which ships inside the gadget as its `README.md`.

This package started as a copy of [`blueprint-whiteboard`](../blueprint-whiteboard/README.md) and keeps its structure: storage-agnostic rules behind a `Repository`, a transport-agnostic hub, a sync store, a multi-pane harness and a local-platform e2e suite. Blip text is a Yjs `Y.Text` per blip; `yjs` is a devDependency that esbuild bundles into both output files, so the client imports nothing at runtime.

## Layout

| Path | What |
| --- | --- |
| `src/shared/` | The contract: types, limits, sanitisers, event shapes and the base64 byte helpers (`protocol.js`); the Markdown tokenizer and node tree used by the read view and the export (`markdown.js`); fractional ordering keys for roots and replies (`order.js`); the templates (`templates.js`) |
| `src/core/` | Storage-agnostic wave rules: blips, text commits, proposals, decisions, events and retention (`wave.js`); the agent run state machine, prompt building and output validation (`runs.js`); the subscriber and presence hub (`hub.js`); the `Repository` seam with an in-memory implementation |
| `src/server/` | The `Gadget` Durable Object (RPC surface, mutation queue, `Y.Doc` cache, model calls), its storage repository, and the `ExportHandler` |
| `src/client/` | Sync store for the structure channel plus the text channel (`sync/`), the textarea to `Y.Text` binding and carets (`editor/`), the conversation, blip cards, composer, panel, dialogs, history and export (`ui/`), wired in `main.js` |
| `harness/` | Local multi-user simulator: the real client in several panes over the real core, with a fake `Model` binding |
| `e2e/` | Playwright suites for the harness and for a local Cloudflare OS instance |
| `scripts/` | `build.mjs` (esbuild into `dist/`), `pack-gadget.mjs` (writes `formats/wave.gadget` from `formats/wave.json`) and `archive.mjs` (`.gadget` archives) |

## Commands

Run these from the repository root. Node comes from fnm (`fnm use v24.21.0`).

```sh
pnpm --filter blueprint-wave test:run      # unit tests (node) + server tests (workerd)
pnpm --filter blueprint-wave build:gadget  # dist/server.js, dist/client.js, dist/README.md
pnpm --filter blueprint-wave pack:gadget   # build, then write formats/wave.gadget (bumps revision on change)
```

The `test` task that `pnpm test` and `pnpm check` run also rebuilds `dist/` and fails if `formats/wave.gadget` is stale. **Run `pack:gadget` and commit the archive with every source change.**

To run the gadget without a deployment, see [`harness/README.md`](harness/README.md). To run it inside a local Cloudflare OS, see [`e2e/README.md`](e2e/README.md).

## Shipping

- **With the deployment:** `deployment.jsonc` sets `"formatBlueprintsDir": "formats"`, so `pnpm deploy` installs the Wave as `format.wave`. Every `formats/*.gadget` with a `.json` sidecar beside it is picked up; nothing else needs registering. See [Bundled formats](../../docs/customization.md#bundled-formats).
- **Without a deploy:** upload `formats/wave.gadget` at Home → Blueprints → Upload .gadget, open `/blueprint/<id>`, publish it, and promote it in `/admin` → Formats.

The sidecar `formats/wave.json` owns the presentation (title, description, `output`, author) and the `bindings` the gadget's `env` expects; the packer validates the bindings against the platform's `BlueprintBinding` shape (`title`, `description`, `type`, plus the type's own fields) and writes them into the archive. Every `formats/*.gadget` with a sidecar beside it is installed by the deploy; nothing else needs registering.

### The Model binding

The Ask agent runs on `env.Model` (an `aiModel` binding; the gadget checks `typeof env.Model?.run === "function"` and reports `no_model` without it). The sidecar declares it, with a suggested model:

```json
"bindings": {
  "Model": {
    "title": "Model for Ask agent",
    "description": "Summarise, compare and catch up run on this model.",
    "type": "aiModel",
    "suggestedModel": { "provider": "openrouter", "modelName": "qwen/qwen3.8-flash" }
  }
}
```

On this platform pin every binding a blueprint declares is mandatory (there is no optional flag), and a format with bindings sends **New** through the blueprint page instead of creating at once. The page prefills the connection when `suggestedModel` matches exactly one of the viewer's models (by id `qwen/qwen3.8-flash` or its name), shows "Everything is ready", and **Create Gadget** makes the Wave. So a new Wave costs one extra click and always has a working Ask. A viewer without that model (for example on a deployment whose gateway catalogue lacks it) picks another model on the same page. Chosen over `"bindings": {}` (one-click **New**, but Ask stays `no_model` until someone adds a model in Connections under the exact name `Model`).

**A new revision only changes what new waves get.** Existing waves keep the code they were created from. The `schemaVersion` in `meta` plus the `migrate` hook in `src/core/wave.js` are how newer code upgrades older data.

**Never change `blueprintId`** (`format.wave`).

## Measured

Decisions and numbers from the phase 0 spikes (plan section 5.1), measured 2026-09-17 on the local Cloudflare OS (pin `a1909a38`, WSL2, headless Chromium) with `e2e/platform.test.mjs` (T0 to T15) and `e2e/platform-spikes.mjs`. Rerun both after a platform upgrade. Every test passed on the final code; see [`e2e/README.md`](e2e/README.md) for the two failures of the last full run.

- **Binary crosses RPC as base64** (decided, not measured). Every Yjs update, state vector and relative position is a base64 string on the wire (`encodeBytes`/`decodeBytes` in `src/shared/protocol.js`); storage keeps `Uint8Array`. Wire caps allow for the 4/3 overhead, and nothing depends on typed-array support across the two platform hops. T7: typing into a 15,000-character blip sent pushes of at most 50 bytes (bytes, not the document).
- **Textarea + `Y.Text` in the sandboxed iframe** (spike items 2 and 3, `platform-spikes.mjs`):
  - Paste: a real `Ctrl+V` of multi-line Unicode and emoji lands in the textarea and reaches another viewer in about 0.5 s. (`navigator.clipboard` is blocked inside the frame; native paste is not.)
  - IME: a CDP composition while a peer types at the start of the text ends as `XYRabc漢` on both sides, with the composing viewer's caret after the committed character.
  - Phone (390 px, touch): card actions are visible without hover, **Edit** is 42 × 44 px, the textarea takes focus on tap, and replacing a selection syncs to the other viewer. Native touch selection handles cannot be driven from CDP; the selection was set programmatically.
  - Links: the iframe's sandbox is `allow-scripts allow-popups allow-popups-to-escape-sandbox`. Rendered Markdown links carry `target="_blank" rel="noopener noreferrer"`; a click opens a new tab and the workspace page stays put. Blip ids render as `.bliplink` buttons that scroll to the blip.
- **Model binding from a facet** (spike item 4):
  - `env.Model.run({prompt, systemPrompt})` returns a string; `src/server/index.js` adapts it as `model().run`, re-read on every ask. The binding cannot be aborted, so the 90 s timeout (unit-tested in `test/core/wave.test.js` with fake timers) abandons the call and fails the run; a late answer is discarded by the run's generation check.
  - With Qwen 3.8 Flash through OpenRouter, one Summarise took 4.4 to 5.5 s end to end across four runs (T10). Refresh brief returns a proposal that replaces the quoted passage, not the whole brief.
  - Without the binding the gadget reports `capabilities.model: false` and `no_model` (harness "no model" test). With it declared, **New** routes through the blueprint page, which prefills the suggested model (see "The Model binding" above).
  - A restart during a call left the use-role viewer live again within 4 s (T15); on these runs the model answered before the restart took effect, so the `unknown` + **Retry** path is covered by the workerd server tests rather than the platform.
- **Typing rate** (spike item 5, T11): three browsers typing continuously (a key every 60 ms) in one blip for 30 s sent 8.6 pushes a second in total (about 3 per typist, against a budget of about 45 calls a second), and a word one typist entered was visible in another's editor after 156 ms median, 200 ms at worst, with no growth over the run. This set the batching constants in `src/shared/protocol.js`: `TEXT_IDLE_MS` 80, `TEXT_FLUSH_BYTES` 1024, and a new `TEXT_MAX_WAIT_MS` 250. Without the cap a typist who never pauses for 80 ms sent nothing until 1 KiB was pending.
- **Presence**: a remote caret appeared in 86 ms (T2); a crashed or closed tab's caret, editing chip and avatar were gone within 3 s (T6); after 10 frame reloads and a closed context the platform log and server console had no undisposed-stub warnings and no runtime crash (T12).
- **`gadgetViewer`** (spike item 6): our fork's platform patch injects `gadgetViewer` (`{id, displayName, role}`) into the iframe prefix, and the client attributes every change (blips, text, reviews, decisions, participants, presence) to `displayName`, falling back to `id`, then the name carried in `window.name`, then "Guest" on a platform without the patch. Nobody is asked for a name; the me button and the People tab change only the colour. The harness injects a per-pane `gadgetViewer` (`?names=Alice,Bob`).
