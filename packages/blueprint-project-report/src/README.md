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
- **Freshness:** the report re-reads the datastore every minute. With **Turn on live updates**, which the Workshop owner approves once, it re-reads when Records reports a change. **Refresh** re-reads at any time.
- The report covers at most the 2,000 most recently updated issues, and says so when there are more.

## Programmatic use

Call these from `executeCode` through the gadget's binding (for example `env.ProjectReport`). Each read is recorded as an observation.

```js
await env.ProjectReport.getSetup();       // { connected, requirement, binding, error }
await env.ProjectReport.listProjects();
await env.ProjectReport.getWorkflow();
await env.ProjectReport.listIssues({ order: "updated_desc", limit: 100 });
await env.ProjectReport.exportCsv();      // CSV text of every issue
```

There are no write methods. To change issues, use a Project board on the same datastore.
