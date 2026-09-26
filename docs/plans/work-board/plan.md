# Work Board: flagship plan

Status: accepted for build, 2026-09-26. Research: [research.md](research.md). Build briefs:
[brief-service.md](brief-service.md), [brief-board.md](brief-board.md),
[brief-insights.md](brief-insights.md).

The Work Board becomes one of cloudflare-os's flagship apps: a fast, keyboard-first, accessible
project tracker in the class of Linear and Jira, whose data lives in a Records datastore (so every
change is attributed, permissioned and journalled) and whose intelligence comes mostly from the
in-Workshop agent.

## Product principles

1. **The board is the truth, instantly.** Committed state is what Records holds; pending changes
   are visible overlays (a ghost card where it will land, "awaiting approval"), never silent lies.
2. **Keyboard first, pointer friendly, screen-reader complete.** Every action has a keyboard path
   and a non-drag alternative; WCAG 2.2 AA is a release gate, not a polish item.
3. **One query language everywhere.** Filters, saved views, swimlanes, reports and the agent all
   speak the same Work Query Language (WQL), executed by one shared module.
4. **The agent does the thinking, the person decides.** The agent reads, queries, reports and
   *proposes* changes; a person applies proposals with one click. Jev gives fast calibrated
   suggestions (triage, duplicates) that are always labelled with confidence and never auto-applied.
5. **Delight is in the details.** Motion that explains, zero-latency feel, thoughtful empty states,
   and nothing that makes a careful user nervous.

## Constraints that shape the design

- **Gadget iframe:** CSP forbids network, `eval` and non-`data:` images; no native form submit, no
  clipboard API, no `allow-same-origin` (so no `localStorage`). One ESM bundle loaded as a data URL.
  Per-viewer preferences therefore live in the gadget server, keyed by viewer.
- **Records reads are bounded:** snapshot ≤ 5,000 records, pages ≤ 500, no server-side filtering or
  sort. WQL therefore runs over the synced snapshot (client for the UI, gadget server for the
  agent). The board targets ≤ 5,000 items per datastore; larger needs Records query work later.
- **Writes are approved commands:** each needs a one-use viewer assertion from a signed-in person
  and may wait for Workshop approval. Agents cannot write directly: they propose.
- **Gadget server:** ~45 RPC/s, 128 KiB per stored value. Views, reports, proposals and
  preferences are small documents stored one per key.
- **Charts:** Vega/Vega-Lite via the AST interpreter (no `unsafe-eval`), inline data only, as in
  `blueprint-procgen-explorer`. Adds ~1.5 MB unminified to the client bundle; accepted.

## Data model: `work` v1, additive (Records migration 010)

Additive changes stay within the API major, so existing clients keep working. `status` remains the
three-value category (`open`, `active`, `done`); richer workflow lives in `state`.

`work_item` gains optional fields:

| Field | Type | Notes |
| --- | --- | --- |
| `number` | integer | Server-assigned per datastore at create (1, 2, 3…), shown as `KEY-42`. Read-only. |
| `state` | string | Key of a `workflow_state`; its `category` must equal `status` (server keeps them consistent). |
| `priority` | integer 0–4 | 0 none, 1 urgent, 2 high, 3 medium, 4 low (Linear's scale). |
| `assignee` | string | Records actor id, e.g. `cloudflare-os:ada@example.com`. |
| `labels` | string[] ≤ 20 | Label keys; free text allowed, `label` entities add colour/description. |
| `estimate` | number ≥ 0 | Points. |
| `start_date`, `due_date` | string (ISO date) | |
| `parent` | IRI → work_item | Sub-issues; no cycles (server refuses). |
| `project` | IRI → project | |
| `cycle` | IRI → cycle | |
| `rank` | string | Fractional index for manual order within a column (LexoRank-style). |
| `archived` | boolean | Items are archived, never deleted. |

New entities (all with `created_by`/`updated_by`, 1:1 presentation views and history):

- `project`: `name`, `description`, `state` (`planned|active|paused|completed|cancelled`), `lead`,
  `start_date`, `target_date`, `color`, `archived`.
- `cycle`: `name`, `number` (server), `starts_on`, `ends_on` (no overlaps), `goal`.
- `workflow_state`: `key`, `name`, `kind` (`triage|backlog|unstarted|started|completed|canceled`,
  Linear's categories, which reports rely on), derived `category` (`open|active|done`), `position`,
  `color`, `wip_limit`. Seeded per datastore on first use with Triage, Backlog, Todo, In Progress,
  In Review, Done, Canceled.
- `label`: `key`, `name`, `color`, `description`, `archived`.
- `relation`: `from`, `to` (work_item IRIs), `kind` (`blocks|relates|duplicates`), `active`
  (removal sets `active=false`; the journal keeps history).
- `comment`: `item`, `body` (Markdown text, ≤ 20,000), `edited`.

Commands (all `work.*`, scope `work.write`): `work.create`, `work.update` (extended),
`work.project.create|update`, `work.cycle.create|update`, `work.state.create|update`,
`work.label.create|update`, `work.relation.create|update`, `work.comment.create|update`.
Validation lives in SQL handlers owned by `records_commander`; the extended profile lives in
`records-model/profiles/work.json`. No row rules beyond tenant isolation in this phase (everyone
with `work.read` sees everything); the permission layer is ready for per-project rules later.

## Work Query Language (WQL)

A small, forgiving language shared by the UI, saved views, reports and the agent
(`src/shared/wql/`). Designed to be typed by people and generated by the agent.

```
status:active assignee:me priority:<=2 label:bug -label:wontfix
project:"Website relaunch" cycle:current due:<7d is:blocked has:estimate
(label:bug OR label:regression) text:"login" updated:>-14d sort:priority,-updated
```

- Terms `field:value`, comparison `field:<=v`, negation `-field:v`, `field:a,b` (any of),
  `AND` (implicit) / `OR` / parentheses, free text searches title and description.
- Fields: every item field, `key` (`KEY-42`), `created`, `updated`, `created_by`, `updated_by`,
  `text`, extension fields as `ext.<name>`.
- Values: `me`, `none`, relative dates (`-7d`, `<7d` = within next 7 days, `today`), `current` /
  `next` / `previous` cycle, state names or keys, label names.
- `is:` predicates: `blocked`, `blocking`, `overdue`, `archived`, `parent`, `sub`, `unassigned`,
  `unestimated`, `stale` (no update 14d). `has:` any field.
- `sort:` one or more fields, `-` for descending. Unknown fields are errors with suggestions
  (“did you mean `priority`?”), never silent.
- One module: `parse(text) → AST | errors with positions`, `evaluate(ast, item, context)`,
  `format(ast)` (canonical text), `describe(ast)` (plain English for screen readers and the agent).

## Views, layouts and swimlanes

A **view** is `{ id, name, query, layout, columnsBy, swimlanesBy, sort, display, shared }`, stored
in the gadget server (`view:<id>`); personal defaults per viewer (`pref:<viewer>`).

- **Layouts:** Board, List (sortable, grouped table), and later Timeline.
- **Columns** group by `state` (default) or any single-valued property.
- **Swimlanes** project any property into rows: assignee, priority, project, cycle, parent (epic),
  label (an item with two labels appears in both lanes, marked "also in"), due bucket
  (overdue / this week / later / none), state category, created_by, or `ext.<field>`. Each lane has
  a sticky header with avatar or colour, count, estimate sum and a collapse toggle; "No value" lane
  last; empty lanes hideable; lane order follows the property's natural order (priority, cycle
  dates, state position) or A–Z.
- **Moving a card between lanes changes that property** (e.g. reassign). Every drag has an
  equivalent: the card's Move menu offers both axes, and keyboard move (`Shift`+arrows) announces
  the target cell before commit.
- **WIP limits** per state column (from `workflow_state.wip_limit`), shown and highlighted, not enforced.
- **Display options:** card density, visible properties, show sub-issues, show archived.

## Agent and AI

- **Agent surface (the "skill").** `README.md` becomes a complete agent guide, and the archive
  ships `SKILL.md` (reporting and query recipes) referenced from it. RPC for agents:
  `query(wql, {limit, fields})`, `describeQuery(wql)`, `item(key)`, `history(key)`,
  `datasets()`, `dataset(name, params)`, `listViews/saveView/deleteView`,
  `listReports/saveReport/deleteReport`, `propose(changes, {title, reason})`, `listProposals`,
  `summary({query})` (counts by state/assignee/priority for chat answers).
- **Proposals.** The agent (or Jev-assisted triage) stores a proposal: a list of exact commands with
  reasons. The board shows a Proposals tray with per-change diffs; a person applies all, some or
  none. Applying uses the normal viewer-assertion path, so attribution is the person's, and the
  proposal records who proposed it.
- **Jev (optional `JEV` binding).** Triage suggestions for an item (priority, labels, state,
  possible duplicate among top text matches) using `decide()` with calibrated confidence.
  ≥ 0.9 is pre-selected in the suggestion UI, 0.5–0.9 shown unselected, < 0.5 hidden. Never
  auto-applied. Batch triage for the Triage view.

## Insights (reports)

- A **Reports** screen: a grid of report cards, each a Vega-Lite (or Vega, for graphs) spec bound
  to named datasets computed from the snapshot and the journal:
  `items`, `transitions` (each state change with actor and time), `daily_state_counts` (CFD),
  `cycle_burndown(cycle)`, `burnup(project|cycle)`, `throughput(weekly)`, `cycle_time`,
  `created_vs_resolved`, `workload(assignee)`, `dependencies` (nodes and edges).
- Built-in reports: cycle burndown, burnup, cumulative flow, cycle-time scatter, throughput/velocity,
  created vs resolved, workload by assignee, dependency graph (Vega force layout) with blocked-path
  highlighting.
- The agent customises reports by saving specs via `saveReport`; specs are validated (inline data
  only, no `url`, bounded size, only whitelisted transforms/signals), each chart has a data-table
  alternative and a text summary for accessibility.

## Research reconciliation

[research.md](research.md) broadly agrees with this plan. Where it differs:

- **Query execution.** Research suggests compiling queries to parameterised SQL. Records has no
  filter API yet, so WQL runs over the synced snapshot (≤ 5,000 items). The WQL AST is the stable
  interchange, so server-side compilation can come later without changing clients or the agent.
- **Views and report specs as Records rows.** Research suggests permissioned, journalled rows. We
  store them as gadget documents for now so the agent can adjust presentation without an approval
  per edit; business data stays in Records. Records-backed shared views are a "next" item.
- **History operators** (`was`, `changed … by … after …`) are "next": the journal makes them cheap.
- **Triage inbox merged with the approval queue** and cycle rollover are "next"; timeline,
  milestones and adapters are "later".
- **Accessibility:** the Move menu is the primary drag alternative (Atlassian's testing favoured
  menus); single-key shortcuts must be switchable off (WCAG 2.1.4).
- **Reports MVP:** cumulative flow, cycle-time scatter, cycle burnup/burndown first; the rest of
  the built-in list follows in the same brief if time allows.

## Delivery sequence

1. **Service (brief-service.md):** migration 010, profile, handlers, views, tests. Parallel with 2.
2. **Board foundation (brief-board.md):** new data layer, WQL, views, swimlanes, detail panel,
   command palette, keyboard model, accessibility, harness e2e. Works against a fake with the
   010 contract, then the real service.
3. **Insights and agent (brief-insights.md):** reports, datasets, agent RPC and SKILL.md,
   proposals, Jev triage. Builds on 2.
4. **Review rounds:** independent UX/accessibility review with screenshots at 375/768/1440,
   keyboard-only and screen-reader walkthroughs, performance at 2,000 and 5,000 items; feedback
   to the builders until the acceptance list below passes.
5. **Deploy:** Records 010 to ms, then a cloudflare-os release with Work Board revision 3.

## Acceptance (flagship bar)

- Every brief's checklist passes; `vitest` suites, harness Playwright e2e and axe (0 serious or
  critical violations) are green; typecheck clean.
- 2,000 items: first render < 300 ms after snapshot, filter/regroup < 50 ms, drag at 60 fps.
- Keyboard-only and screen-reader walkthroughs complete create, triage, move, assign, bulk edit,
  filter, save view, and read a report.
- The agent, using only the README/SKILL.md, can answer "what's blocking the current cycle?",
  build a burndown for a named cycle, and propose a re-prioritisation the person applies.
