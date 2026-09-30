# blueprint-docs

Source of the **Docs with Drawings** format (`format.docs-drawings`): upstream's bundled Docs (the collaborative rich-text editor) with whiteboard drawings inside documents. People insert a drawing from the toolbar, see its picture inline, and open it to draw together live; the Workshop agent creates and edits drawings through the document's RPC surface.

The design and the reasons for it are in [Drawings in Docs](../../docs/plans/docs-drawing-embeds.md) and the research behind it in [Embeddable apps](../../docs/research/embeddable-apps.md). The gadget's own user guide and RPC reference is [`src/README.md`](src/README.md), which ships inside the gadget as its `README.md`.

## How it fits together

- **Drawings live in the document.** Each drawing is a complete whiteboard (the Whiteboard format's own rules) kept in the document's Durable Object under `drawing:<id>:` keys, through [`blueprint-whiteboard/embed/server`](../blueprint-whiteboard/src/embed/server.js). Copying, sharing, exporting and deleting a document carries its drawings with it.
- **The document holds only a reference.** A drawing is one block, `<figure class="doc-drawing" data-drawing-id="d_…">`, so text edits (per-block versions) and drawing edits (per-object versions) never conflict.
- **Previews.** After each drawing change the server re-renders the drawing's SVG (debounced), stores it in chunks beside the drawing and announces `{type: "drawing", id, revision}` to document subscribers, who fetch it with `getDrawingPreview`. The Markdown export embeds it; HTML and PDF exports show it.
- **Editing.** The client mounts the whole whiteboard UI over the page with [`blueprint-whiteboard/embed/client`](../blueprint-whiteboard/src/embed/client.js), talking to that drawing through the document's own `gadget` stub (`drawingSubscribe`, `drawingApply`, …). Its styles and panels are removed again when the editor closes.
- **The agent** calls `createDrawing`, `listDrawings` and `drawing(id, method, args)`, where `method` is any Whiteboard convenience method. One agent edits both text and drawings; there is no second agent or cross-gadget binding.

## Layout

| Path | What |
| --- | --- |
| `src/server/index.js` | Upstream's Docs Durable Object (with the omni-search push patch) plus the "Drawings" section |
| `src/client/main.js` | Upstream's Docs client; changes are marked `Drawings:` so upstream fixes can be merged by diff |
| `src/client/drawings.js` | Figures, previews, the Insert drawing button and the full-page drawing editor |
| `harness/` | Local multi-user simulator: the real client in panes over the real server (bundled for the browser with `cloudflare:workers` shimmed) |
| `e2e/` | Playwright suites for the harness and for a local Cloudflare OS instance |

## Commands

Run these from the repository root. Node comes from fnm (`fnm use v24.21.0`).

```sh
pnpm --filter blueprint-docs test:run      # archive freshness (node) + server tests (workerd)
pnpm --filter blueprint-docs pack:gadget   # build, then write formats/docs-drawings.gadget (bumps revision on change)
```

Browser tests, from `packages/blueprint-docs`:

```sh
node scripts/build.mjs && node --test e2e/harness.test.mjs       # harness, headless Chromium
node --test --test-concurrency=1 e2e/platform.test.mjs           # needs a local platform:
                                                                 # ../blueprint-whiteboard/e2e/start-local-platform.sh
```

A change to `packages/blueprint-whiteboard/src` changes this format too: repack both.

## Upstream

`src/server/index.js`, `src/client/main.js` and most of `src/README.md` come from upstream's `workspace-docs` bundled format (Apache-2.0), decoded from `formats/workspace-docs.gadget` with `docs/research/bundled-blueprints/extract-gadget.mjs`. Upstream's Docs format stays in `formats/` unchanged; this is a separate format beside it.
