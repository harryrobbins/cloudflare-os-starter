# Records Explorer

A read-only browser for one **Records datastore**: which entities its installed module declares, what records it holds, what each field means, and what changed while you were looking. It never changes records. Changes are made by apps such as the Work Board, and every gadget connected to the same datastore sees the same records.

This gadget is built from `packages/blueprint-records-explorer` in the deployment's starter repository. **Edits made here in the code editor are not carried back to that source.**

## Setup

Open the Connections tab and connect a **Records** datastore as `RECORDS`. Read access is enough. The connector lists only datastores the deployment operator approved; the gadget never holds a credential.

## Tabs

- **Records**: pick an entity in the left rail. Records load 50 at a time in server ID order. **Next** continues after the last record shown; a full page does not prove there is more, so an empty next page shows **End of records**. Pages are current reads, not a consistent snapshot. **Open record by ID** fetches one record by its UUID. **Filter loaded rows only** searches the rows already on screen, never the whole datastore. Choose visible columns with the checkboxes. Selecting a record opens the inspector: every returned field, the profile's definition of each (type, required, allowed values, term IRI), fields the profile does not declare (marked *not in profile*), and the raw JSON.
- **Model**: the installed profile: vocabulary and version, each entity's term and fields, and its generated JSON Schema. Term IRIs are shown as text and never fetched. Installed commands are listed for reference.
- **Activity**: changes seen since you opened the explorer, newest first, checked every 5 seconds while the explorer is visible, at most 200 kept. This is not a history of the datastore: earlier changes are not loaded and the journal does not record who made a change. If the datastore's permissions change, the feed is cleared and restarts.
- **Connection**: the datastore, connection ID, module and API major, scopes and access. Removing this gadget or its connection keeps every record.

## Programmatic use

From `executeCode`, through the gadget's binding (for example `env.RecordsExplorer`). Each read is authorised by the connector as an observation.

```js
await env.RecordsExplorer.getSetup();                 // { connected, connection, error }
await env.RecordsExplorer.describe();                 // installed module, granted scopes, permission epoch
await env.RecordsExplorer.model();                    // { profile, schemas }
await env.RecordsExplorer.records({ entity: "work_item", limit: 100, after });  // { records, seq, permission_epoch }
await env.RecordsExplorer.changes(seq, epoch);        // { changes, cursor, permission_epoch }
```

`records()` accepts only `entity`, `id`, `after` (UUIDs) and `limit` (1–500). There is no sorting, text search or totals.
