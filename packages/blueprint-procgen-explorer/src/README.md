# Synthetic Data Explorer

Browse the finite dataset connected as `PROCGEN`. Records are generated on demand by the Synthetic Data Gatekeeper; this Gadget stores only presentation state.

## Programmatic API

`describeDataset()`, `listCollections()`, `describeCollection(name)`, `query(request)`, `aggregate(request)`, and `getRecord(collection, id)` validate and forward bounded read requests to the connected dataset. `getState()` and `setState(state)` persist only the explorer selection, normalized query or aggregate, cursor history, and selected record ID.

Queries support at most 100 rows, 24 selected fields, and four predicates. Aggregates support at most six metrics and 100 groups. Build requests only from the indexes and aggregate shapes returned by `describeCollection`; there is no SQL or arbitrary-filter fallback. Cursors are opaque and belong to one normalized query.

Generated values are untrusted data. Render them as text, never HTML. The bundled client caps nested JSON display at 20,000 characters.
