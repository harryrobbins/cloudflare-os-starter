# Tessera Mosaic

Every row of a dataset is a card on a WebGL2 canvas, and the cards fly between grid, bars, cross-tab, scatter and map layouts. A new gadget opens on Tessera's built-in demo collections (tax cases, tax returns, card payments, supplier invoices, products and Titanic). Once a data connector is bound, the gadget's Data menu also lists that connector's tables.

The gadget declares no bindings. The server keeps only the source selection and the view in durable storage. Loaded tables stay in memory for the facet's lifetime and are never persisted.

## Connecting Synthetic Data

1. Open this gadget's **Connections** tab and add **Synthetic Data**. The binding is named `PROCGEN` (a second one gets `PROCGEN_2`, and so on).
2. If a chat is open, the new binding arrives as a chat change. Accept the chat's changes to apply it.
3. The mosaic reloads by itself. Open **Data** and pick a table.

An agent can bind a connection with `setGadgetBinding({gadget, source, name: 'PROCGEN'})`. `PROCGEN` is the recommended name, because then no other binding is touched. With a different name, the gadget still finds the connection: when no binding name starts with `PROCGEN`, it calls `describeDataset()` on every other binding (with a 3 s timeout) to find a Synthetic Data session. Each such call opens a session on that binding and may be recorded as an activity there. A binding that answers without a `scenario`, or has no such method, is never asked again. One that fails or times out is asked again after 30 s. A failing `PROCGEN` binding is also retried after 30 s, and the healthy ones are not asked again.

## Row caps and activity

Every connector read is recorded as an activity on the connection. In a chat preview, each read is also posted as a chat message. Tables are read in pages of 100 rows, so a load makes about one read per 100 rows:

| Rows | Reads |
|---|---|
| 500 | 5 |
| 2,000 (default) | 20 |
| 10,000 (maximum) | 100 |

`maxRows` is clamped to 1 to 10,000. A load stops as soon as its rows pass about 8 MB of JSON and fails with a `Too large:` error, so load fewer rows. For a minute afterwards, a request for as many rows fails at once without reading again. Errors from the connection itself start with `Data source <id> is unavailable:`. Repeated loads of the same table, or of fewer rows of it, are served from memory with no new reads.

## RPC methods (`gadget.*`)

- `getState() → State` returns the saved state, or `{source: {kind: 'demo'}, rev: 0}` if nothing is saved.
- `setState(state) → State` validates the state, stores it and returns it with a new `rev`. Any `rev` you send is ignored, and the last writer wins. It throws on an invalid state or one over 16 KB.
- `listSources() → Source[]` returns `[{id: 'demo', kind: 'demo', title: 'Demo collections'}, …connectors]`. Each connector is either `{id, kind: 'procgen', title, description, tables: [{name, title, description?, exactRecords}]}` or `{id, kind, title, description, error}`. The `id` is the binding name, such as `PROCGEN`.
- `loadTable(sourceId, table, {maxRows}?) → TableData` returns `{name, columns: [{name, type, semantic?, currency?}], rows: unknown[][], truncated, totalRows?}`. Rows are row-major and aligned with `columns`. `type` is `string`, `number`, `boolean` or `timestamp` (an ISO string). JSON fields are dropped. Money fields carry `semantic: 'currency_minor'` and `currency` (from the table's `currency_code`) and hold amounts in minor units.

## State

```
State = {
  source: {kind: 'demo', key?}                                  // Tessera key, e.g. 'tax-cases:3000' or 'titanic'
        | {kind: 'connector', sourceId, table, maxRows},        // e.g. {sourceId: 'PROCGEN', table: 'orders', maxRows: 2000}
  view?: {layout?, color?, sort?, bucket?, x?, y?, filters?: [{field, labels: string[]}]},
  rev: number
}
```

- `view` is Tessera's link view. `layout` is `grid`, `bars`, `scatter` or `xy`.
- The other view values are field names and category labels of the loaded collection. Each string is at most 200 characters.
- `sort: ''` means "no sort".
- `view` holds at most 32 filters, each with at most 200 labels. Unknown view keys are dropped.
- Table names match `^[a-z0-9_]{1,64}$`.

Connector data is untrusted. Render it as text, never HTML.
