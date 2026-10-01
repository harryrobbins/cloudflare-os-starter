# Project board

A board over an organisation **Projects datastore**. Columns are the datastore's workflow states and cards are issues. People can create issues, edit the title, description, priority and assignee, move issues between states and comment.

This gadget stores no business records. Every read and write goes to the Records service through the `RECORDS` binding, and the records belong to the organisation. Deleting this board, or removing its connection, does not delete them.

This gadget is built from `packages/blueprint-project-board` in the deployment's starter repository. **Edits made here in the code editor are not carried back to that source.**

## Setup

Open the gadget's Connections tab, connect a Records account and choose a Projects datastore. Use the binding name `RECORDS`. The board asks for these operations (see `service-requirement.json`): `projects.read`, `issues.read`, `issues.create`, `issues.edit`, `issues.transition` and `comments.create`. If you grant fewer, the board becomes read-only for the missing actions and says so.

Each viewer's own datastore membership still applies. If this board is shared with someone who is not a member of the datastore, they see "You don't have access to this datastore".

## How changes are saved

- Every change shows on the board at once, as your local version. A new issue shows with the key `ENG-?` (dashed card, "Not saved yet") until the Records service numbers it. You can keep working on it meanwhile.
- The board sends changes to the Records service in order, in the background. Each change asks the Workshop to confirm that you made it (a one-use viewer assertion bound to that exact change). The Records service then applies it, queues it for approval or refuses it. The server's version always replaces your local one when it arrives.
- The status panel in the bottom left shows each change: **Saving**, **Pending approval** (with the action number, checked every few seconds), **Saved**, **Conflict** or **Not saved**. A change counts as saved only when it shows **Saved**.
- **Pending approval**: the card shows where the datastore has it, marked **Awaiting approval**, until the Workshop owner decides. If they approve, the change arrives by itself. If they decline, the panel says so.
- **Conflict** means someone else changed the issue first, or the move is no longer allowed. The board shows their version. If the issue is open, a table compares your values with the current ones, and the form holds yours on top of theirs: **Save changes** applies them again, **Discard** drops them.
- **Not saved** means the Records service refused the change (for example, the connection lacks that operation). The board shows the server's version again.
- Changes are kept in this page only, never stored offline. While any have not reached the Records service, the header shows **N unsynced changes** and the browser asks before you close the page. If they cannot be sent (for example, you are not signed in), a banner says so and offers **Retry**. Network failures are retried automatically.

## Freshness

The board keeps a synced copy of the datastore and pulls only what changed since its last pull. With **Turn on live updates**, the board asks Records to notify it after each change. The Workshop owner approves this once, and the board then updates within a few seconds. Until notifications arrive, the board checks every 15 seconds. **Refresh** sends any unsent changes and pulls at once.

Very large datastores (more than 5,000 issues or 20,000 comments) cannot be synced; the board says so. Use a Project report or the Records API for those.

## Programmatic use

Call these from `executeCode` through the gadget's binding (for example `env.ProjectBoard`). They pass straight through to the Records session. Reads return current data, and each read is recorded as an observation.

```js
await env.ProjectBoard.getSetup();          // { connected, requirement, binding: { datastore, scopes, … }, error }
await env.ProjectBoard.listProjects();
await env.ProjectBoard.getWorkflow();       // { states, transitions }
await env.ProjectBoard.listIssues({ projectId, order: "updated_desc", limit: 50 });
await env.ProjectBoard.getIssue(issueId);
await env.ProjectBoard.listComments({ issueId });
await env.ProjectBoard.syncPull({ clientGroupId, cookie: null }); // sync protocol: { cookie, patch, lastMutationIdChanges }
await env.ProjectBoard.getPokes();          // { live, head, … }: the latest change notification this board received
```

**Agents cannot write through this board.** `syncPush` needs a viewer assertion per change, and only a signed-in person using the board UI can obtain one. Ask the person to make the change in the board, or use a Records service credential with the HTTP API.

To turn on live updates from `executeCode`, register the gadget's restore target as the hook:

```js
import { restore } from "cloudflare:workers";
const hook = await env.ProjectBoard[restore]({ type: "records-poke" });
await env.RECORDS.onChange(hook, { deliver: "pokes" });
```

Clicking **Turn on live updates** in the board does the same.

## Adapting this gadget

Each gadget is an editable copy. Changes to a copy do not flow back to this source package.

- `client.js`: readable view entry with the `adapt` block near the top.
- `client.lib.js`: prebuilt UI, sync and rendering library, loaded before the entry.
- `server.js`: readable `Gadget` class and its RPC surface.
- `server.lib.js`: prebuilt core, validation and storage helpers.
- `README.md`: this guide. Never edit `*.lib.js`; rebuild source to change stable library code.

For content work, call `describeGadget()` through `describeBinding` and use the described
operations without editing files. Common operations: `getSetup`, `listProjects`, `getWorkflow`, `listIssues`, `getIssue`.

The `adapt` fields are:

- `title`: browser document title; it does not rename stored content.
- `actionLabel`: accessible name of the extra-actions region.
- `styles`: extra CSS applied after the built-in styles.
- `actions`: `{ id, label, title?, run(app) }` commands shown at the bottom right. Buttons
  work with keyboard and touch; invalid or duplicate actions are ignored with a console warning.
- `onReady(app)`: called once after the initial view has loaded (or shown its connection state).
  Async actions and callbacks are supported; failures appear as a short status message.

`app` is a frozen handle with these RPC methods (same arguments and results as the server):
`getSetup`, `listProjects`, `getWorkflow`, `listAssignees`, `listIssues`, `getIssue`, `listComments`. It also has `notify(text)` for a short live status message and
`refresh()` to reload data where the view supports it (otherwise it is a no-op).
The handle exposes no storage, approval tokens, or UI internals.

For example, inspect the current content:

```js
await env.ProjectBoard.getSetup();
```

To add a help action to your copy, change `actions` in `client.js`:

```js
actions: [{ id: "help", label: "About this view", run(app) {
  app.notify("Use the built-in controls to explore this project-board.");
} }],
```
