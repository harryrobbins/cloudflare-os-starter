# Project board

A board over an organisation **Projects datastore**. Columns are the datastore's workflow states and cards are issues. People can create issues, edit the title, description, priority and assignee, move issues between states and comment.

This gadget stores no business records. Every read and write goes to the Records service through the `RECORDS` binding, and the records belong to the organisation. Deleting this board, or removing its connection, does not delete them.

This gadget is built from `packages/blueprint-project-board` in the deployment's starter repository. **Edits made here in the code editor are not carried back to that source.**

## Setup

Open the gadget's Connections tab, connect a Records account and choose a Projects datastore. Use the binding name `RECORDS`. The board asks for these operations (see `service-requirement.json`): `projects.read`, `issues.read`, `issues.create`, `issues.edit`, `issues.transition` and `comments.create`. If you grant fewer, the board becomes read-only for the missing actions and says so.

Each viewer's own datastore membership still applies. If this board is shared with someone who is not a member of the datastore, they see "You don't have access to this datastore".

## How changes are saved

- Every change asks the Workshop to confirm that you made it (a one-use viewer assertion bound to that exact change). The Records service then either applies it, queues it for approval or refuses it.
- The status panel in the bottom left shows each change: **Saving**, **Pending approval** (with the action number, checked every few seconds), **Saved**, **Conflict** or **Not saved**. A change counts as saved only when it shows **Saved**. Nothing is queued offline.
- **Conflict** means someone else changed the issue first, or the move is no longer allowed. Choose **Reload issue** to see the current version next to yours, then decide again.
- **Unconfirmed** means the call got no answer. **Check again** resends the same change with the same idempotency key. If the first attempt was saved, Records returns that result and nothing is applied twice.
- Drag a card to another column, or open it and use **Move to …**. Only moves the workflow allows are offered.

## Freshness

With **Turn on live updates**, the board asks Records to notify it of changes. The Workshop owner approves this once. Until notifications arrive, the board re-reads the datastore every 15 seconds. **Refresh** reads everything again at any time.

## Programmatic use

Call these from `executeCode` through the gadget's binding (for example `env.ProjectBoard`). They pass straight through to the Records session. Reads return current data, and each read is recorded as an observation.

```js
await env.ProjectBoard.getSetup();          // { connected, requirement, binding: { datastore, scopes, … }, error }
await env.ProjectBoard.listProjects();
await env.ProjectBoard.getWorkflow();       // { states, transitions }
await env.ProjectBoard.listIssues({ projectId, order: "updated_desc", limit: 50 });
await env.ProjectBoard.getIssue(issueId);
await env.ProjectBoard.listComments({ issueId });
await env.ProjectBoard.getWriteOutcome(actionId);
```

**Agents cannot write through this board.** `createIssue`, `editIssue`, `transitionIssue` and `addComment` need a viewer assertion, and only a signed-in person using the board UI can obtain one. Ask the person to make the change in the board, or use a Records service credential with the HTTP API.

To turn on live updates from `executeCode`, register the gadget's restore target as the hook:

```js
import { restore } from "cloudflare:workers";
const hook = await env.ProjectBoard[restore]({ type: "records-change" });
await env.RECORDS.onChange(hook);
```

Clicking **Turn on live updates** in the board does the same.
