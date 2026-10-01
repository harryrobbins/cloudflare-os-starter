# MermaiD2

A diagram playground: Mermaid or D2 source, TALA/Dagre/ELK layout, 14 examples,
palettes, sketch, pan/zoom, and SVG/PNG/JPEG/WebP/PDF/ASCII/source/JSON exports.
Drafts are stored with the gadget. Rendering uses the MermaiD2 connector.

## Connection

Bind `MERMAID2` to the `mermaid2` connector resource `mermaid2://renderer`.
The renderer is private, credential-free and read-only. It processes supplied
source ephemerally on Cloudflare, blocks external resources, and records
observations. Browser usage applies. PDF contains a raster image; SVG is vector.

## Agent RPC

- `getDocument()` → `{ revision, drafts?, language?, layout?, theme?, sketch?, live? }`.
- `setDocument({ expectedRevision, document })` → saved document. Requires the current
  revision, two string drafts keyed by mermaid/d2, language, layout, string theme,
  and boolean sketch/live. `conflict:` means another editor saved; reread before editing.
- `renderDiagram({ source, language?, layout?, theme?, sketch?, format?, scale? })`
  → `{ data: Uint8Array, contentType, filename, nodes, edges, d2Source? }`.
- `exportDiagram(format, scale)` renders the saved active draft.
- `readSkill(id)` reads one of the skills below through the connector.

For UI editing use one editor at a time. Simultaneous edits are detected by
revision checks, with a copy-before-reload message; they are not automatically merged.

## Bundled skills

Read the relevant skill before using the API:

- `skills/mermaid2-blueprint/SKILL.md`: persistent document editing and conflict handling.
- `skills/mermaid2-connector/SKILL.md`: render options, bytes, formats and limits.
- `skills/d2-authoring/SKILL.md`: D2 patterns and layout choices.

These are also discoverable in the connector's agent catalog and available through
`MERMAID2.readSkill(id)`. Use the actual connected binding name in agent code.

## Adapting this gadget

Each gadget is an editable copy. Changes to a copy do not flow back to this source package.

- `client.js`: readable view entry with the `adapt` block near the top.
- `client.lib.js`: prebuilt UI, sync and rendering library, loaded before the entry.
- `server.js`: readable `Gadget` class and its RPC surface.
- `server.lib.js`: prebuilt core, validation and storage helpers.
- `README.md`: this guide. Never edit `*.lib.js`; rebuild source to change stable library code.

For content work, call `describeGadget()` through `describeBinding` and use the described
operations without editing files. Common operations: `getDocument`, `updateDiagram`, `renderDiagram`.

The `adapt` fields are:

- `title`: browser document title; it does not rename stored content.
- `actionLabel`: accessible name of the extra-actions region.
- `styles`: extra CSS applied after the built-in styles.
- `actions`: `{ id, label, title?, run(app) }` commands shown at the bottom right. Buttons
  work with keyboard and touch; invalid or duplicate actions are ignored with a console warning.
- `onReady(app)`: called once after the initial view has loaded (or shown its connection state).
  Async actions and callbacks are supported; failures appear as a short status message.

`app` is a frozen handle with these RPC methods (same arguments and results as the server):
`getDocument`, `updateDiagram`, `renderDiagram`, `exportDiagram`. It also has `notify(text)` for a short live status message and
`refresh()` to reload data where the view supports it (otherwise it is a no-op).
The handle exposes no storage, approval tokens, or UI internals.

For example, inspect the current content:

```js
await env.Mermaid2.getDocument();
```

To add a help action to your copy, change `actions` in `client.js`:

```js
actions: [{ id: "help", label: "About this view", run(app) {
  app.notify("Use the built-in controls to explore this mermaid2.");
} }],
```
