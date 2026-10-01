# Project report

A read-only report on an organisation **Projects datastore**: issue counts by state, priority and assignee, the most recently updated issues, and a CSV download of the current view.

The report stores no business records and cannot change any. It reads through the `RECORDS` binding, and its server has no write methods. The records belong to the organisation, so deleting this report does not affect them.

This gadget is built from `packages/blueprint-project-report` in the deployment's starter repository. **Edits made here in the code editor are not carried back to that source.**

## Setup

Open the gadget's Connections tab, connect a Records account and choose a Projects datastore. Use the binding name `RECORDS`. Grant only `projects.read` and `issues.read` (see `service-requirement.json`). Each viewer's own datastore membership still applies.

## Using the report

- **Filters** (project, state, priority, assignee) apply to every figure, chart and the CSV. They are remembered in this browser tab only.
- **Charts** are horizontal bars. Hover a bar for its share. **Show as table** lists the same numbers.
- **Download CSV** saves the issues in the current view. If the browser blocks the download, the gadget menu → Export → **CSV (all issues)** exports every issue from the server.
- **Freshness:** the report keeps a synced copy of the datastore and reads only what changed since its last read. It checks every minute. With **Turn on live updates**, which the Workshop owner approves once, it updates within a few seconds of each change. **Refresh** checks at once.
- The report covers every project and issue. A datastore larger than sync allows (more than 5,000 issues) shows a message instead; the gadget menu → Export → **CSV (all issues)** still works for it.

## Programmatic use

Call these from `executeCode` through the gadget's binding (for example `env.ProjectReport`). Each read is recorded as an observation.

```js
await env.ProjectReport.getSetup();       // { connected, requirement, binding, error }
await env.ProjectReport.listProjects();
await env.ProjectReport.getWorkflow();
await env.ProjectReport.listIssues({ order: "updated_desc", limit: 100 });
await env.ProjectReport.syncPull({ clientGroupId, cookie: null }); // sync protocol: { cookie, patch, … }
await env.ProjectReport.exportCsv();      // CSV text of every issue
```

There are no write methods. To change issues, use a Project board on the same datastore.

## Adapting this gadget

Each gadget is an editable copy. Changes to a copy do not flow back to this source package.

- `client.js`: readable view entry with the `adapt` block near the top.
- `client.lib.js`: prebuilt UI, sync and rendering library, loaded before the entry.
- `server.js`: readable `Gadget` class and its RPC surface.
- `server.lib.js`: prebuilt core, validation and storage helpers.
- `README.md`: this guide. Never edit `*.lib.js`; rebuild source to change stable library code.

For content work, call `describeGadget()` through `describeBinding` and use the described
operations without editing files. Common operations: `getSetup`, `listProjects`, `getWorkflow`, `listIssues`, `exportCsv`.

The `adapt` fields are:

- `title`: browser document title; it does not rename stored content.
- `actionLabel`: accessible name of the extra-actions region.
- `styles`: extra CSS applied after the built-in styles.
- `actions`: `{ id, label, title?, run(app) }` commands shown at the bottom right. Buttons
  work with keyboard and touch; invalid or duplicate actions are ignored with a console warning.
- `onReady(app)`: called once after the initial view has loaded (or shown its connection state).
  Async actions and callbacks are supported; failures appear as a short status message.

`app` is a frozen handle with these RPC methods (same arguments and results as the server):
`getSetup`, `listProjects`, `getWorkflow`, `listIssues`, `exportCsv`. It also has `notify(text)` for a short live status message and
`refresh()` to reload data where the view supports it (otherwise it is a no-op).
The handle exposes no storage, approval tokens, or UI internals.

For example, inspect the current content:

```js
await env.ProjectReport.getSetup();
```

To add a help action to your copy, change `actions` in `client.js`:

```js
actions: [{ id: "help", label: "About this view", run(app) {
  app.notify("Use the built-in controls to explore this project-report.");
} }],
```
