# Work Board reporting and triage skill

How the Workshop agent answers questions about a Work Board, builds reports and proposes changes.
Read [README.md](README.md) first for the board itself. Call the board through its gadget binding
from `executeCode` (the examples use `env.WorkBoard`; use the binding name this gadget has).

**Three rules**

1. **Read with WQL, never guess.** `query()`, `summary()`, `dataset()` and the board all run the
   same Work Query Language over the same data, so your answer matches what people see.
2. **You cannot change items. Propose.** `propose(changes, { title, reason })` stores a proposal;
   a person reviews it in the board's **Proposals** tray and applies what they agree with. The
   changes are then attributed to that person and go through Workshop approval. Say so in chat:
   "I've proposed 4 changes; open Proposals on the board to review them."
3. **Errors are `code: detail`.** `invalid_request:` means fix your input (the detail says how,
   often with "did you mean"); `not_found:` a key or name does not exist; `conflict:` the item
   changed since you read it (read it again); `not_connected:` a connection is missing.

Keep to a few calls per answer: the board handles about 45 calls a second for everyone.

## Recipes

Each recipe is a complete `executeCode` body. They are tested against the board's own test
datastore on every build, so they run as written.

### What's blocking the current cycle?

```js
// Recipe: blocking the current cycle
const blocked = await env.WorkBoard.query("cycle:current is:blocked", { limit: 100, fields: ["key", "title", "state", "assignee", "blocked_by"] });
const graph = await env.WorkBoard.dataset("dependencies", { query: "cycle:current" });
const blockers = new Map();
for (const e of graph.rows.filter((r) => r.type === "edge")) blockers.set(e.source, [...(blockers.get(e.source) ?? []), e.target]);
const nodes = new Map(graph.rows.filter((r) => r.type === "node").map((n) => [n.key, n]));
return {
  answer: blocked.total ? `${blocked.total} items in the current cycle are blocked. ${graph.summary}` : "Nothing in the current cycle is blocked.",
  blocked: blocked.items,
  blockers: [...blockers].map(([key, blocks]) => ({ key, title: nodes.get(key)?.title, state: nodes.get(key)?.state, assignee: nodes.get(key)?.assignee, blocks }))
    .sort((a, b) => b.blocks.length - a.blocks.length),
};
```

Answer with the blockers first (they are what to unblock), each with who owns it.

### Who is overloaded?

```js
// Recipe: who is overloaded
const load = await env.WorkBoard.dataset("workload", { query: "cycle:current" });
const people = new Map();
for (const r of load.rows) {
  const p = people.get(r.assignee) ?? { person: r.assignee, items: r.total_count, points: r.total_points, in_progress: 0 };
  if (r.kind === "started") p.in_progress += r.count;
  people.set(r.assignee, p);
}
const list = [...people.values()].filter((p) => p.person !== "Unassigned");
const avg = list.reduce((s, p) => s + p.points, 0) / Math.max(1, list.length);
return { summary: load.summary, overloaded: list.filter((p) => p.points > avg * 1.5 || p.in_progress > 3), everyone: list, unassigned: people.get("Unassigned") ?? null };
```

"Overloaded" here is more than 1.5× the average points in the cycle, or more than three items in
progress at once. Drop `query` for all committed work, or pass `params: { kinds: "open" }` to
include triage and backlog.

### Build a burndown for a named cycle

```js
// Recipe: burndown for a named cycle
const vocab = await env.WorkBoard.vocabulary();
const name = vocab.cycles.at(-2)?.name ?? "current";      // e.g. "Cycle 24"; use the name the person gave
const burn = await env.WorkBoard.dataset("cycle_burndown", { params: { cycle: name } });
const report = await env.WorkBoard.saveReport({
  id: `burndown-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  title: `Burndown: ${burn.params.cycle}`,
  dataset: "cycle_burndown",
  params: { cycle: burn.params.cycle },
  query: "",
  spec: {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { name: "cycle_burndown" },
    transform: [{ fold: ["remaining", "ideal"], as: ["series", "value"] }],
    mark: { type: "line", strokeWidth: 2, point: true },
    encoding: {
      x: { field: "day", type: "temporal", scale: { type: "utc" }, title: null, axis: { format: "%d %b" } },
      y: { field: "value", type: "quantitative", title: burn.rows[0]?.unit === "points" ? "Points remaining" : "Items remaining" },
      color: { field: "series", type: "nominal", title: null, scale: { scheme: "workboard-series" } },
      strokeDash: { field: "series", type: "nominal", scale: { domain: ["remaining", "ideal"], range: [[1, 0], [5, 4]] }, legend: null },
      tooltip: [{ field: "day", type: "temporal", formatType: "utc", format: "%d %b" }, { field: "remaining" }, { field: "scope" }, { field: "ideal" }],
    },
  },
});
return { summary: burn.summary, saved: report.id, rows: burn.rows.filter((r) => !r.future) };
```

The built-in **Cycle burndown** report already has a cycle picker; save your own only when asked
for a lasting chart. Tell the person the summary sentence and that the report is on **Insights**.

### Build a custom chart from a dataset

Choose the dataset from the data dictionary below, read a few rows, then save a spec. The spec
reads its rows from `{ "name": "<dataset>" }`; the board supplies them. Always validate first.

```js
// Recipe: custom chart from a dataset
const sample = await env.WorkBoard.dataset("items", { query: "-status:done", limit: 3 });
const doc = {
  id: "open-by-priority-and-state",
  title: "Open work by priority",
  description: "Unfinished items per priority, split by state kind.",
  dataset: "items",
  query: "-status:done",
  params: {},
  spec: {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { name: "items" },
    mark: { type: "bar", cornerRadiusEnd: 3 },
    encoding: {
      y: { field: "priority", type: "nominal", title: null, sort: { field: "priority_value", op: "min" } },
      x: { aggregate: "count", type: "quantitative", title: "Items" },
      color: { field: "kind", type: "nominal", title: "State kind", scale: { domain: ["triage", "backlog", "unstarted", "started"], scheme: "workboard-kinds" } },
      tooltip: [{ field: "priority" }, { field: "kind" }, { aggregate: "count", title: "Items" }],
    },
  },
};
const check = await env.WorkBoard.validateReport(doc);
if (!check.valid) return { problems: check.errors, columns: Object.keys(sample.rows[0] ?? {}) };
const saved = await env.WorkBoard.saveReport(doc);
return { saved: saved.id, version: saved.version };
```

Spec rules (`validateReport` enforces them): Vega-Lite or Vega JSON only; no `url` (data,
images, lookups), no `href` links, no `loader`; signal and selection events only for pointer,
touch, wheel and key events on the view (no `timer`, no `window:`); inline `values` at most 1 MB;
the whole report at most 256 KiB. Colours: the schemes `workboard-kinds` (triage, backlog,
unstarted, started, completed, canceled, in that order) and `workboard-series` follow the board's
light or dark theme and are colour-blind safe; prefer them to your own colours. Temporal fields
are UTC: add `scale: { type: "utc" }` and `formatType: "utc"`. Every report gets the dataset's
one-sentence summary and a data table, so a chart never has to carry the numbers alone.

### Turn a request into WQL

Grammar: terms `field:value`; any of `field:a,b`; compare `field:<v`, `<=`, `>`, `>=`, range
`field:a..b`; negate `-field:v` or `-(...)`; AND is implicit, `OR` and parentheses group; bare
words or `"phrases"` search titles and descriptions; `sort:field,-field`. Values: `me`, `none`,
dates (`2026-10-30`, `today`, `-7d` = 7 days ago, `7d` = in 7 days, units `d w m y`), cycles
`current`, `next`, `previous`, names in quotes (`assignee:"Ada Lovelace"`). `is:` blocked,
blocking, overdue, archived, parent, sub, unassigned, unestimated, stale, open, active, done.
`has:<field>`. Priority `<` means more urgent (`priority:<=high` is urgent or high).

| Request | WQL |
| --- | --- |
| My open bugs | `assignee:me label:bug -status:done` |
| What's overdue? | `is:overdue` |
| Urgent or high items nobody owns | `priority:<=high is:unassigned -status:done` |
| What did Grace finish this week? | `assignee:"Grace Hopper" status:done updated:>-7d` |
| Stuck in review | `state:"In Review" updated:<-3d` |
| Due in the next two weeks | `due:<14d -status:done sort:due` |
| Items in the Website relaunch project that are not estimated | `project:"Website relaunch" is:unestimated` |
| Anything about login or SSO | `(login OR sso) -status:done` |
| Next cycle's plan, most urgent first | `cycle:next sort:priority` |
| Things created in triage over a week ago | `kind:triage created:<-7d` |

```js
// Recipe: check WQL before using it
const q = await env.WorkBoard.describeQuery('assignee:"Grace Hopper" status:done updated:>-7d');
if (q.errors.length) return { fix: q.errors.map((e) => `${e.message}${e.suggestions?.length ? ` (did you mean ${e.suggestions.join(" or ")}?)` : ""}`) };
const r = await env.WorkBoard.query(q.query, { limit: 20 });
return { understood_as: q.description, total: r.total, items: r.items.map((i) => `${i.key} ${i.title}`) };
```

Always show the person the canonical query (`q.query`) so they can paste it into the board's
filter.

### Triage the Triage state with proposals

```js
// Recipe: triage with proposals
const inbox = await env.WorkBoard.query("kind:triage sort:-created", { limit: 20, fields: ["key", "title", "labels", "priority", "description"] });
const setup = await env.WorkBoard.getSetup();
const changes = [];
if (setup.jev && inbox.items.length) {
  // Optional Jev connection: calibrated suggestions; keep only the confident ones (≥ 0.9).
  const t = await env.WorkBoard.triage(inbox.items.slice(0, 10).map((i) => i.key));
  for (const r of t.results) {
    const sure = r.suggestions.filter((s) => s.probability >= 0.9);
    const input = { id: r.key };
    for (const s of sure) {
      if (s.field === "priority") input.priority = s.value;
      if (s.field === "state") input.state = s.value;
      if (s.field === "label") input.labels_add = [...(input.labels_add ?? []), s.value];
    }
    if (Object.keys(input).length > 1) changes.push({ command: "work.update", input, reason: sure.map((s) => `${s.text} (${s.confidence})`).join("; ") });
  }
}
for (const item of inbox.items) {
  if (changes.some((c) => c.input.id === item.key)) continue;
  // Your own judgement from the title and description; here, a simple rule for the example.
  const bug = /\b(fix|broken|error|crash|fails?)\b/i.test(item.title);
  changes.push({ command: "work.update", input: { id: item.key, state: "Backlog", ...(bug ? { labels_add: ["Bug"], priority: "high" } : {}) }, reason: bug ? "Reads like a defect: backlog it as a high-priority bug." : "Valid work, not planned yet." });
}
if (!changes.length) return "Triage is empty.";
const p = await env.WorkBoard.propose(changes, { title: `Triage ${changes.length} items`, reason: "Proposed triage of the newest items in Triage." });
return { proposal: p.id, changes: p.changes.map((c) => c.text) };
```

`propose` accepts friendly values: keys (`TW-12`), state names, priority words, people's names,
label names, cycle and project names, and `labels_add` / `labels_remove`. It checks everything
against the datastore and returns each change's exact command and a readable line such as
"TW-12 priority High → Urgent". Tell the person what you proposed in a sentence or two.

### Break an item into proposed sub-issues

```js
// Recipe: break an item into sub-issues
const [parent] = (await env.WorkBoard.query("has:description -is:sub -status:done sort:-updated", { limit: 1 })).items;
const item = await env.WorkBoard.item(parent.key);
const steps = ["Write the technical plan", "Build it behind a feature flag", "Add tests and docs", "Roll out and remove the flag"];
const changes = steps.map((title) => ({
  command: "work.create",
  input: { title: `${title}: ${item.title}`.slice(0, 200), parent: item.key, state: "Todo", ...(item.cycle ? { cycle: item.cycle } : {}), ...(item.project ? { project: item.project } : {}) },
  reason: `Part of ${item.key}.`,
}));
const p = await env.WorkBoard.propose(changes, { title: `Break down ${item.key}`, reason: `Split “${item.title}” into ${steps.length} sub-issues.` });
return { proposal: p.id, sub_issues: p.changes.map((c) => c.text), existing: item.sub_issues };
```

Write the sub-issue titles from the item's description (`item.description`) and its acceptance
criteria; check `item.sub_issues` first so you do not propose duplicates.

### Re-prioritise a cycle

```js
// Recipe: re-prioritise a cycle
const items = (await env.WorkBoard.query("cycle:current -status:done sort:priority", { limit: 200, fields: ["key", "title", "priority", "due", "blocked_by", "revision"] })).items;
const today = (await env.WorkBoard.vocabulary()).today;
const rank = { Urgent: 1, High: 2, Medium: 3, Low: 4, "No priority": 5 };
const changes = [];
for (const i of items) {
  // Example policy: overdue or due within 3 days → at least High; blocked items that are not due soon → Low.
  const soon = i.due && i.due <= new Date(Date.parse(`${today}T00:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10);
  let target = null;
  if (soon && rank[i.priority] > 2) target = "high";
  else if (!soon && i.blocked_by.length && rank[i.priority] < 4) target = "low";
  if (target) changes.push({ command: "work.update", input: { id: i.key, priority: target }, revision: i.revision, reason: soon ? `Due ${i.due}.` : `Blocked by ${i.blocked_by.join(", ")}.` });
}
if (!changes.length) return "The cycle's priorities already match the policy.";
const p = await env.WorkBoard.propose(changes, { title: "Re-prioritise the current cycle", reason: "Raise work that is due soon; lower work that is blocked." });
return { proposal: p.id, changes: p.changes.map((c) => c.text) };
```

Passing `revision` (from `query(..., { fields: [..., "revision"] })` or `item()`) makes the
proposal refuse a change to an item someone edited since you read it. When a person applies a
proposal after the items changed, the tray offers **Refresh stale changes**, which rebases them.

## Agent RPC reference

| Method | Returns |
| --- | --- |
| `query(wql, { limit, fields, viewer })` | `{ query, description, total, truncated, items }` (fields as in README) |
| `describeQuery(wql)` | `{ query (canonical), description, errors }` |
| `item(key)` | One item with `revision`, sub_issues, blocks, blocked_by_all, relates, duplicates, comments |
| `history(key, { limit })` | `{ key, entries: [{ at, actor, text, changes }], comments }`, newest first |
| `summary({ query, by })` | Counts: `total, points, open, in_progress, done, blocked, overdue, unassigned, by: { <field>: [{ value, count, points }] }`; `by` up to four of state, status, kind, assignee, priority, label, project, cycle, parent, created_by, due, ext.<name> |
| `vocabulary()` | States, labels, projects, cycles, people, today |
| `datasets()` | The data dictionary below |
| `dataset(name, { params, query, limit })` | `{ name, params (resolved), query, columns, rows, total, truncated, summary, history }` (limit default 2,000) |
| `listReports()` | Built-in and saved reports (`hidden`, `customised` flags) |
| `validateReport(doc)` | `{ valid, errors, kind, bytes }` |
| `saveReport(doc)` / `deleteReport(id)` / `restoreReport(id)` | Save (a built-in's id customises it), delete (hides a built-in), restore a built-in |
| `listViews()` / `saveView(view)` / `deleteView(id)` | Shared saved views (see README) |
| `propose(changes, { title, reason, by })` | The stored proposal: `{ id, status, changes: [{ n, command, input, revision, key, text, diff, reason }] }`. Commands: work.update, work.create, work.relation.create, work.relation.update (remove), work.comment.create, work.label.create. At most 200 changes, 128 KiB |
| `listProposals({ status })` | Open and partly applied proposals (`status: "all"` for every one) |
| `getProposal(id)` / `refreshProposal(id)` / `withdrawProposal(id)` | Read; re-validate and rebase unapplied changes; close without applying |
| `triage(keys)` | Needs the optional Jev connection (`getSetup().jev`). Per item: `suggestions: [{ field, text, value, probability, confidence, preselect }]`, `hidden` (count under 0.5). Up to 20 keys; cached per item revision |

Datasets select items by their **current** values (the query), then read their history. Days
are UTC dates; "at the end of a day" means just before the next midnight UTC (today: now).

## Data dictionary

<!-- dictionary:start (generated by `node scripts/skill-dictionary.mjs`; do not edit by hand) -->

### `items`: Items

One row per work item matching the query, flattened with names and the state kind.

No parameters.

| Column | Type | Meaning |
| --- | --- | --- |
| `key` | string | Item key, e.g. WRK-42 |
| `title` | string | Title |
| `state` | string | Workflow state name |
| `kind` | string | State kind: triage, backlog, unstarted, started, completed, canceled |
| `status` | string | Category: open, active or done |
| `priority` | string | Urgent, High, Medium, Low or No priority |
| `priority_value` | number | 0 none, 1 urgent … 4 low |
| `assignee` | string | Assignee's name, or null |
| `labels` | string | Label names, comma-separated |
| `estimate` | number | Points, or null |
| `due` | date | Due date (YYYY-MM-DD), or null |
| `project` | string | Project name, or null |
| `cycle` | string | Cycle name, or null |
| `parent` | string | Parent key, or null |
| `blocked` | boolean | Blocked by an unfinished item |
| `created_by` | string | Creator's name |
| `created_at` | instant | When the item was created (ISO 8601 UTC), or null when unknown |
| `updated_at` | instant | When the item last changed (ISO 8601 UTC), or null when unknown |

### `transitions`: State transitions

Every change of workflow state from the journal, oldest first, including the state each item was created in (from_state null).

Parameters: `days` (Only changes in the last N days (UTC), 1–3650; default all).

| Column | Type | Meaning |
| --- | --- | --- |
| `key` | string | Item key |
| `title` | string | Item title |
| `from_state` | string | State before, or null when the item was created |
| `from_kind` | string | Kind before, or null |
| `to_state` | string | State after |
| `to_kind` | string | Kind after: triage, backlog, unstarted, started, completed, canceled |
| `actor` | string | Who made the change (display name) |
| `at` | instant | When (ISO 8601 UTC) |
| `day` | date | The UTC day of the change |

### `daily_state_counts`: Items per state kind per day

For each UTC day, how many of the matching items were in each state kind at the end of that day (today: now). Stacked, it is a cumulative flow diagram.

Parameters: `days` (How many days, 1–365; default 30); `end` (The last day (YYYY-MM-DD, UTC); default today).

| Column | Type | Meaning |
| --- | --- | --- |
| `day` | date | UTC day |
| `kind` | string | State kind |
| `kind_label` | string | Kind as shown: Triage, Backlog, Unstarted, Started, Completed, Canceled |
| `order` | number | Kind order, 0 = triage … 5 = canceled (for stacking) |
| `count` | number | Items in that kind at the end of the day |
| `points` | number | Sum of their estimates at the time |

### `cycle_burndown`: Cycle burndown

Remaining work in a cycle per UTC day from its start to its end, with the ideal straight line. Canceled items leave the scope; future days have null values.

Parameters: `cycle` (Cycle name, number, current (default), previous or next); `unit` (points, count or auto (points when at least half the items are estimated)).

| Column | Type | Meaning |
| --- | --- | --- |
| `day` | date | UTC day |
| `cycle` | string | Cycle name |
| `unit` | string | points or count |
| `scope` | number | Work in the cycle at the end of the day (null in the future) |
| `completed` | number | Of which completed |
| `remaining` | number | scope − completed |
| `ideal` | number | The ideal line from the first day's scope to 0 on the last day |
| `future` | boolean | The day has not happened yet |

### `burnup`: Burnup

Scope and completed work per UTC day for a cycle (start to end) or a project (its start, or first item, to today; at most 180 days). Canceled items leave the scope.

Parameters: `scope` (cycle (default) or project); `cycle` (For scope cycle: name, number, current (default), previous or next); `project` (For scope project: the project name (required)); `unit` (points, count or auto).

| Column | Type | Meaning |
| --- | --- | --- |
| `day` | date | UTC day |
| `name` | string | Cycle or project name |
| `unit` | string | points or count |
| `scope` | number | Total work in scope at the end of the day (null in the future) |
| `completed` | number | Completed work at the end of the day |
| `future` | boolean | The day has not happened yet |

### `throughput`: Throughput

Items (and points) completed per ISO week (Monday to Sunday, UTC), by when each currently completed item was last completed. The current week is partial.

Parameters: `weeks` (How many weeks, 1–104; default 12).

| Column | Type | Meaning |
| --- | --- | --- |
| `week` | date | The Monday starting the week (UTC) |
| `completed` | number | Items completed that week |
| `points` | number | Their estimates |
| `partial` | boolean | The week is not over yet |

### `cycle_time`: Cycle time

For each item completed in the period: from first entering a started state to last being completed, in days, with a centred rolling average (window 20% of items, at least 5, odd) and the 50th/85th percentiles. Items completed without ever being started are left out.

Parameters: `days` (Items completed in the last N days, 1–730; default 90).

| Column | Type | Meaning |
| --- | --- | --- |
| `key` | string | Item key |
| `title` | string | Title |
| `assignee` | string | Assignee's name, or null |
| `estimate` | number | Points, or null |
| `started` | instant | First entered a started state (ISO 8601 UTC) |
| `completed` | instant | Last completed (ISO 8601 UTC) |
| `completed_day` | date | UTC day it was completed |
| `days` | number | Cycle time in days (1 decimal) |
| `rolling_avg` | number | Centred rolling average of days |
| `p50` | number | Median cycle time of all rows (same on every row) |
| `p85` | number | 85th percentile of all rows (same on every row) |

### `created_vs_resolved`: Created vs resolved

Items created and resolved (moved into a done-category state: completed or canceled) per UTC day, with running totals over the period. An item resolved, reopened and resolved again counts twice.

Parameters: `days` (How many days, 1–365; default 30).

| Column | Type | Meaning |
| --- | --- | --- |
| `day` | date | UTC day |
| `created` | number | Items created that day |
| `resolved` | number | Items resolved that day |
| `created_total` | number | Created since the first day of the period |
| `resolved_total` | number | Resolved since the first day of the period |

### `workload`: Workload by assignee

Unfinished work per person and state kind now: item counts and estimate sums. By default only committed work (unstarted and started kinds); Unassigned last.

Parameters: `kinds` (Comma-separated kinds to count: triage, backlog, unstarted, started, or open for all four; default unstarted,started).

| Column | Type | Meaning |
| --- | --- | --- |
| `assignee` | string | Person's name, or Unassigned |
| `assignee_id` | string | Records actor id, or null |
| `kind` | string | State kind |
| `kind_label` | string | Kind as shown |
| `order` | number | Kind order, 0 = triage … 3 = started (for stacking) |
| `count` | number | Items |
| `points` | number | Estimate sum |
| `total_count` | number | The person's items across the chosen kinds |
| `total_points` | number | The person's points across the chosen kinds |

### `dependencies`: Dependencies

The live blocking graph: rows with type "node" (items) and type "edge" (an active blocks relation between two unfinished items). An edge is included when either end matches the query; nodes outside the query are marked context. Blocked chains are flagged.

No parameters.

| Column | Type | Meaning |
| --- | --- | --- |
| `type` | string | node or edge |
| `id` | string | Node: the item key. Edge: "FROM->TO" |
| `key` | string | Node: item key |
| `title` | string | Node: title |
| `state` | string | Node: state name |
| `kind` | string | Node: state kind |
| `assignee` | string | Node: assignee's name, or null |
| `blocked` | boolean | Node: blocked by an unfinished item |
| `blocking` | number | Node: how many unfinished items it blocks |
| `depth` | number | Node: longest chain of unfinished blockers above it (0 = not blocked) |
| `chain` | boolean | Node: blocked and itself blocking (a link in a chain) |
| `context` | boolean | Node: outside the query, shown because it is related |
| `source` | string | Edge: the blocking item's key |
| `target` | string | Edge: the blocked item's key |
| `critical` | boolean | Edge: part of a chain of two or more blocks |

<!-- dictionary:end -->
