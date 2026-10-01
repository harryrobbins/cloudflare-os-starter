# Network Map gadget

A collaborative, Kumu-style network map: **elements** (nodes), **connections** (edges), **loops**
(named feedback cycles), typed **fields**, and **views** that decorate, filter and focus the map.
Everyone with the gadget open edits the same map live.

This file is for agents calling the gadget from chat (`executeCode` with the gadget bound as, for
example, `env.Map`). Read `describeMap()` first. The plan behind it is
`docs/plans/network-map-blueprint.md` in the starter repository.

## Reading

| Method | Returns |
|---|---|
| `describeMap()` | title, counts, types, fields, views and limits |
| `findElements({text?, type?, tag?, limit?})` | elements whose label or alias contains `text`; `type` is a type id or name |
| `getNeighbourhood({id? \| label?, depth? (1-3), limit?})` | `{root, elements, connections}` around one element |
| `getMapMarkdown({limit?})` | an outline of the map in Markdown, for reading and summarising |
| `getHistory(limit?)` | recent changes, newest first |
| `openSnapshot()` then `snapshotPage(token, next)` | the whole map in pages, from one revision |

## Writing

All writes go through `applyOperation`:

```js
await env.Map.applyOperation({
  senderId: "agent", by: "Assistant", requestId: "agent:1",   // requestId makes retries safe
  ops: [
    { op: "create", object: { id: "e_1a2b3c4d5e6f", label: "Food bank", typeId: "t_…" } },
    { op: "create", object: { id: "c_1a2b3c4d5e6f", from: "e_…", to: "e_…", direction: "directed", polarity: "+" } },
    { op: "update", id: "e_…", baseVersion: 3, patch: { description: "…", fields: { "f_…": 4 } } },
    { op: "delete", id: "c_…", baseVersion: 1 },
    { op: "move", layout: "shared", items: [{ id: "e_…", x: 120, y: -40, pin: true }] },
  ],
  structure: { title: "…" },                                  // optional
});
```

- **Ids.** You choose them: a kind letter, an underscore and 12 hex digits. The letters are `e` element, `c` connection, `l` loop, `v` view, `t` type and `f` field.
- **baseVersion.** An update or delete needs the object's `version`. If it is stale, the result lists a conflict with the current object; read it and retry.
- **Results.** A result is `{status, revision, upserts, deletes, moves, conflicts, errors, history}`.
  - Ops apply in order; each op sees the ones before it.
  - A failed op is listed in `errors` by its index. The others still apply.
- **Cascades.**
  - Deleting an element deletes its connections, the loops that use them, and view focus references.
  - A type in use and the default view cannot be deleted.
  - A connection change that would break a loop is refused.
- **Limits per request.** At most 2,000 ops, and at most 2,000 objects touched, cascades included.
- **Limits per map.** 10,000 elements, 30,000 connections, 500 loops, 50 views, 100 types and 200 fields. Objects are capped at 64 KiB each and 16 MiB in total.
- **Positions.** A move does not change an element's version. `layout` is `"shared"`, or a view id when that view has `layout.own: true`. An item with `base` (a position version) is skipped if the element moved since. Layout jobs use this so they never overwrite a person's drag.
- **Undo.** `undo({senderId, by, historyId?})` undoes your newest change, or the one named.
  - Undo keeps later edits by others and reports them as conflicts.
  - It never deletes an element that gained a connection since.
  - Redo is undoing the undo.

## Objects

- **Element** `{id, label, typeId?, description?, tags?, aliases?, fields?, externalRefs?, provenance?}`
- **Connection** `{id, from, to, direction: "directed"|"undirected"|"mutual", typeId?, label?, polarity?: "+"|"-", strength?, description?, tags?, fields?}`
  - Self-links and parallel connections are allowed.
- **Loop** `{id, label, steps: [{c: connectionId, fwd: true|false}], classification?: "R"|"B", description?}`
  - The steps must form a closed walk.
  - A directed connection can only be walked forwards.
- **Type** `{id, name, appliesTo: "element"|"connection", color?, shape?: circle|square|diamond|triangle|hexagon}`
- **Field** `{id, name, kind, appliesTo: "element"|"connection"|"both", choices?}`
  - `kind` is one of `text`, `longtext`, `number`, `date` (YYYY-MM-DD), `daterange` (`{from, to}`), `bool`, `choice`, `multichoice` or `url`.
  - Values go in `fields: {fieldId: value}`; `null` clears one.
- **View** `{id, name, rules, filter?, focus?, showcase?, layout: {kind, own}}`, as described next.

## Views and rules

A rule is `{selector, set}`. Rules apply in order, and a later rule wins.

```js
{ selector: { target: "element", match: "all", where: [{ subject: { k: "field", id: "f_…" }, op: "eq", value: "Public" }] },
  set: { color: { value: "#e15759" }, size: { byNumber: { k: "metric", id: "degree" }, range: [4, 16], scale: "sqrt" } } }
```

- **Subjects.**
  - For both elements and connections: `label`, `type`, `tag`, `field` (with `id`), `id`, `origin`.
  - Elements only: `metric` with `degree`, `indegree` or `outdegree`.
  - Connections only: `direction`, `polarity`.
- **Operators.** `eq`, `ne`, `lt`, `le`, `gt`, `ge`, `contains`, `in`, `exists`, `missing`.
- **Element decorations.**
  - `color`: `{value}`, `{byCategory: subject}` or `{byNumber: subject, range: [hex, hex]}`.
  - `size`: `{value}` or `{byNumber, range, scale}`.
  - Also `shape`, `label` (`"label"`, `"none"` or `{field}`), `hidden`, `opacity` and `border`.
- **Connection decorations.** `color`, `width`, `arrow` (`"auto"` or `"none"`), `curved`, `hidden`, `opacity`, `label`.
- **Filter, showcase and focus.**
  - `filter` hides what a selector does not match.
  - `showcase` dims what it does not match.
  - `focus: {roots, depth 1-4, direction}` shows only the neighbourhood of the roots.

## Imports (changesets)

People import spreadsheets and Kumu JSON through the Data tab. Nothing reaches the map until someone accepts the import. The same workflow is open to agents:

1. `createChangeset({name, source, by})`.
2. `addChangesetItems({changesetId, items})`, at most 2,000 items per call. The item shapes are in `src/core/changesets.js`: types, fields, elements by key, and connections between keys.
3. `finalizeChangeset({changesetId})`. The server matches items against the map: by `source` plus `key` (re-importing updates), and by label (which is only a suggestion).
4. `getChangeset(...)` and `setDecisions(...)` to review.
5. `acceptChangeset({changesetId, digest, by})`.

Accepting requires the digest of the version that was reviewed. It proves the changeset did not change, **not** that a person pressed the button. Anyone who holds this gadget can accept, so treat review as a cooperative convention: leave acceptance to the people using the map unless they ask you to accept. An applied import is undone with `undoGroup({groupId: changesetId})`.

## Exports

The gadget's Export menu offers several formats:
- Network map backup (JSON, lossless)
- Kumu JSON
- Elements CSV and Connections CSV (Kumu's spreadsheet layout, safe from spreadsheet formulas)
- GraphML
- GEXF

## Adapting this gadget

Each gadget is an editable copy. Changes to a copy do not flow back to this source package.

- `client.js`: readable view entry with the `adapt` block near the top.
- `client.lib.js`: prebuilt UI, sync and rendering library, loaded before the entry.
- `server.js`: readable `Gadget` class and its RPC surface.
- `server.lib.js`: prebuilt core, validation and storage helpers.
- `README.md`: this guide. Never edit `*.lib.js`; rebuild source to change stable library code.

For content work, call `describeGadget()` through `describeBinding` and use the described
operations without editing files. Common operations: `describeMap`, `findElements`, `addElements`, `getMapMarkdown`, `applyOperation`.

The `adapt` fields are:

- `title`: browser document title; it does not rename stored content.
- `actionLabel`: accessible name of the extra-actions region.
- `styles`: extra CSS applied after the built-in styles.
- `actions`: `{ id, label, title?, run(app) }` commands shown at the bottom right. Buttons
  work with keyboard and touch; invalid or duplicate actions are ignored with a console warning.
- `onReady(app)`: called once after the initial view has loaded (or shown its connection state).
  Async actions and callbacks are supported; failures appear as a short status message.

`app` is a frozen handle with these RPC methods (same arguments and results as the server):
`describeMap`, `findElements`, `getNeighbourhood`, `getMapMarkdown`, `addElements`, `applyOperation`. It also has `notify(text)` for a short live status message and
`refresh()` to reload data where the view supports it (otherwise it is a no-op).
The handle exposes no storage, approval tokens, or UI internals.

For example, inspect the current content:

```js
await env.NetworkMap.describeMap();
```

To add a help action to your copy, change `actions` in `client.js`:

```js
actions: [{ id: "help", label: "About this view", run(app) {
  app.notify("Use the built-in controls to explore this network-map.");
} }],
```
