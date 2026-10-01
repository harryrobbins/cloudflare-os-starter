# Synthetic Data Explorer

Browse the finite dataset connected as `PROCGEN`. Records are generated on demand by the Synthetic Data Gatekeeper; this Gadget stores only presentation state.

## Programmatic API

`describeDataset()`, `listCollections()`, `describeCollection(name)`, `query(request)`, `aggregate(request)`, and `getRecord(collection, id)` validate and forward bounded read requests to the connected dataset. `getState()` and `setState(state)` persist only the explorer selection, normalized query or aggregate, cursor history, and selected record ID.

Queries support at most 100 rows, 24 selected fields, and four predicates. Aggregates support at most six metrics and 100 groups. Build requests only from the indexes and aggregate shapes returned by `describeCollection`; there is no SQL or arbitrary-filter fallback. Cursors are opaque and belong to one normalized query.

Generated values are untrusted data. Render them as text, never HTML. The bundled client caps nested JSON display at 20,000 characters.

## Reusing charts

The bundled client includes reusable `buildPageChartSpec()` and `renderVegaLite()` helpers. The builder accepts declared scalar fields, `bar`, `line`, or `point`, and at most one bounded query page. The renderer uses Vega's AST interpreter, so it works under the Gadget iframe CSP without `unsafe-eval`. When adapting the visualization, keep data inline; never add URLs or arbitrary specifications, expressions, or transforms derived from untrusted values.

## Adapting this gadget

Each gadget is an editable copy. Changes to a copy do not flow back to this source package.

- `client.js`: readable view entry with the `adapt` block near the top.
- `client.lib.js`: prebuilt UI, sync and rendering library, loaded before the entry.
- `server.js`: readable `Gadget` class and its RPC surface.
- `server.lib.js`: prebuilt core, validation and storage helpers.
- `README.md`: this guide. Never edit `*.lib.js`; rebuild source to change stable library code.

For content work, call `describeGadget()` through `describeBinding` and use the described
operations without editing files. Common operations: `describeDataset`, `listCollections`, `query`, `aggregate`, `getState`, `setState`.

The `adapt` fields are:

- `title`: browser document title; it does not rename stored content.
- `actionLabel`: accessible name of the extra-actions region.
- `styles`: extra CSS applied after the built-in styles.
- `actions`: `{ id, label, title?, run(app) }` commands shown at the bottom right. Buttons
  work with keyboard and touch; invalid or duplicate actions are ignored with a console warning.
- `onReady(app)`: called once after the initial view has loaded (or shown its connection state).
  Async actions and callbacks are supported; failures appear as a short status message.

`app` is a frozen handle with these RPC methods (same arguments and results as the server):
`describeDataset`, `listCollections`, `describeCollection`, `query`, `aggregate`, `getRecord`, `getState`, `setState`. It also has `notify(text)` for a short live status message and
`refresh()` to reload data where the view supports it (otherwise it is a no-op).
The handle exposes no storage, approval tokens, or UI internals.

For example, inspect the current content:

```js
await env.DataExplorer.describeDataset();
```

To add a help action to your copy, change `actions` in `client.js`:

```js
actions: [{ id: "help", label: "About this view", run(app) {
  app.notify("Use the built-in controls to explore this data-explorer.");
} }],
```
