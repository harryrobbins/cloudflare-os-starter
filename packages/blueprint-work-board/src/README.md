# Work board

A board of **work items** stored in a Records datastore. Columns are the work module's statuses — **Open**, **Active** and **Done** — and each card is one item with a title and an optional description.

This gadget stores no items. Every read and write goes to the Records service through the `RECORDS` binding. Items belong to the datastore: deleting this board, or removing its connection, keeps them, and every other board, explorer or client connected to the same datastore shows the same items.

This gadget is built from `packages/blueprint-work-board` in the deployment's starter repository. **Edits made here in the code editor are not carried back to that source.**

## Setup

Open the gadget's Connections tab and add a **Records** datastore that uses the `work` module (API v1), named `RECORDS`.

- Choose **Read and request changes** to create, edit and move items.
- Choose **Read only** to show the board without editing controls.

A datastore with another module (for example `messaging`) is refused with "This board needs a work v1 datastore".

## How changes are saved

- **New item**, **Save changes** in the item panel, the **Move** menu on a card and dragging a card to another column each send one change.
- Each change asks the Workshop to confirm it came from you: a one-use viewer assertion over the exact change (datastore, connection, command, fields, the item's revision and an idempotency key).
- The change is then queued for approval in the Workshop, unless the owner has allowed that kind of change to apply automatically. The card shows **Awaiting approval (action #N)** and the status panel in the bottom left follows it until it is **Saved** or **Not saved**.
- Cards move only when the Records service has saved the change. A pending change never moves a card.
- **Conflict** means someone else changed the item first. The board shows their version; make your change again if it is still needed.
- Retrying a change reuses its idempotency key, so a change is never applied twice.

## Freshness

The board loads a complete snapshot (up to 2,000 items), then checks the datastore's change journal every 3 seconds while visible and every 15 seconds in the background. **Refresh** checks now. If the datastore's permissions change, the board discards what it holds and loads a new snapshot. Larger datastores show an explicit "too large" message; use a Records Explorer instead.

## Programmatic use

Call these from `executeCode` through the gadget's binding (for example `env.WorkBoard`). They pass straight through to the Records session; each read is recorded as an observation.

```js
await env.WorkBoard.getSetup();                 // { connected, requirement, connection, description, error }
await env.WorkBoard.connection();               // { datastore, binding, label, moduleId, apiMajor, access, scopes }
await env.WorkBoard.snapshot(2000);             // { records, seq, permission_epoch, complete }
await env.WorkBoard.changes(seq, epoch);        // { changes, cursor, permission_epoch }
await env.WorkBoard.records({ entity: "work_item", limit: 100 });
await env.WorkBoard.model();                    // the work profile and JSON Schemas
```

**Agents cannot change items through this board.** `command` needs a viewer assertion, which only a signed-in person using the board can obtain. Ask the person to make the change here.
