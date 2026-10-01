# Notebook

Python cells, Markdown and saved results. Connect the Notebook Python resource as `PYTHON` to enable execution. The workspace owner’s Run and Stop/reset clicks authorize those exact operations immediately. Workshop Activity records them without a second approval. Shared viewers can read saved outputs, but cannot obtain the one-use owner permits needed to run code. Use the **use** sharing role for readers; **build** collaborators can change application source and should be trusted accordingly.

A kernel keeps variables between cells until it stops, reaches its idle timeout or fails. It has no internet access. Runs are limited to 60 seconds including startup and outputs are capped. Stop/reset discards variables and temporary files; saved cells/results remain. This initial version does not persist the Python filesystem or install packages on demand.

Use Workshop’s gadget menu → Export → Jupyter notebook to download a copy as `.ipynb`, create a new Notebook, import the file and connect your own Python resource. This copies the document and outputs, never a runtime identity, credentials or live variables. Import does not execute code.

## Programmatic use

The agent may edit the document through these gadget methods. Do not edit application source to change a user's cells.

- `getNotebook()` returns title, revision and cells, each with `id`, `type`, `source`, `version`, saved outputs and optional run provenance.
- `saveCell(id, version, source, type)` returns `{conflict, cell}`; on conflict, inspect the current cell before editing again.
- `changeStructure(revision, operation)` supports `{type:'insert',cellType:'code'|'markdown'|'raw',index?}`, `{type:'delete',id}`, `{type:'move',id,index}`, and `{type:'title',title}`. Read the notebook first for the revision.
- `importNotebook(text, revision)` replaces document cells with a bounded Python `.ipynb` v4 file.
- `exportNotebook()` returns `.ipynb` JSON containing saved outputs.
- `getRuntimeStatus()` and `refreshRun()` read current execution state; reading never starts Python.

Execution requires a fresh owner-authenticated UI permit for the exact source and generation. Agents and collaborators cannot mint those permits. Ask the owner to run the cell using the notebook UI. A code edit after submission leaves the output labelled as coming from an older revision.

Limits: 100 cells; 16,000 source characters per cell; 100,000 UTF-8 JSON bytes per cell; 2 MB total notebook storage. Imported active HTML/JavaScript is never executed. Unsupported bounded MIME data/metadata are preserved in downloads, not displayed.

## Adapting this gadget

Each gadget is an editable copy. Changes to a copy do not flow back to this source package.

- `client.js`: readable view entry with the `adapt` block near the top.
- `client.lib.js`: prebuilt UI, sync and rendering library, loaded before the entry.
- `server.js`: readable `Gadget` class and its RPC surface.
- `server.lib.js`: prebuilt core, validation and storage helpers.
- `README.md`: this guide. Never edit `*.lib.js`; rebuild source to change stable library code.

For content work, call `describeGadget()` through `describeBinding` and use the described
operations without editing files. Common operations: `getNotebook`, `appendCell`, `exportNotebook`, `getRuntimeStatus`.

The `adapt` fields are:

- `title`: browser document title; it does not rename stored content.
- `actionLabel`: accessible name of the extra-actions region.
- `styles`: extra CSS applied after the built-in styles.
- `actions`: `{ id, label, title?, run(app) }` commands shown at the bottom right. Buttons
  work with keyboard and touch; invalid or duplicate actions are ignored with a console warning.
- `onReady(app)`: called once after the initial view has loaded (or shown its connection state).
  Async actions and callbacks are supported; failures appear as a short status message.

`app` is a frozen handle with these RPC methods (same arguments and results as the server):
`getNotebook`, `appendCell`, `saveCell`, `changeStructure`, `exportNotebook`, `getRuntimeStatus`. It also has `notify(text)` for a short live status message and
`refresh()` to reload data where the view supports it (otherwise it is a no-op).
The handle exposes no storage, approval tokens, or UI internals.

For example, inspect the current content:

```js
await env.Notebook.getNotebook();
```

To add a help action to your copy, change `actions` in `client.js`:

```js
actions: [{ id: "help", label: "About this view", run(app) {
  app.notify("Use the built-in controls to explore this notebook.");
} }],
```
