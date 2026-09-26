# Brief: Work Board Insights, agent skill, proposals and Jev

Owner: insights subagent, building on the board foundation branch. Read first: [plan.md](plan.md)
("Agent and AI", "Insights", "Research reconciliation"), [research.md](research.md) sections 4–6,
[brief-board.md](brief-board.md), the foundation's `src/README.md`, and
`packages/blueprint-procgen-explorer/src/client/chart.js` (Vega under the gadget CSP) plus its
README notes on inline data and the AST interpreter. Jev: `packages/gatekeeper-jev/README.md` and
`src/types.d.ts` (`decide({state, questions})`).

## Goal

Make the board answer questions and explain itself: a Reports screen of Vega charts derived from
the Records journal, an agent surface good enough that the in-Workshop agent can query, report and
propose changes from the README and SKILL.md alone, a Proposals tray for human-applied agent
suggestions, and optional Jev triage.

## 1. Datasets (`src/shared/datasets/`, pure, shared by client and server)

Computed from the store (snapshot + full journal pulled from seq 0 and cached):
`items` (flattened, with state kind), `transitions` (item, from/to state and kind, actor, at),
`daily_state_counts` (per day × state kind; CFD), `cycle_burndown(cycle)` (remaining estimate or
count per day, ideal line), `burnup(scope: cycle|project)` (scope and completed over time),
`throughput(week)`, `cycle_time` (started→completed per item, with p50/p85 and rolling average),
`created_vs_resolved(day)`, `workload(assignee)` (open estimate/count by person and state kind),
`dependencies` (nodes = items, edges = active `blocks` relations, with blocked-chain flags).
All accept a WQL filter. Deterministic, timezone-explicit (UTC days, documented), unit-tested with
hand-built journals including reopen, cancel, estimate change and scope change.

## 2. Reports screen

- A "Insights" layout next to Board/List. A responsive grid of report cards; each card: title,
  chart, "Data" toggle showing an accessible table of the plotted data, a one-sentence generated
  text summary ("Scope grew 12% this cycle; 18 of 40 points done; projected to finish 2 days late"),
  menu (edit query, duplicate, delete, view spec).
- Built-in reports, in priority: cumulative flow, cycle-time scatter (p50/p85 rules, rolling
  average), cycle burnup and burndown (selector for cycle; defaults to current), throughput,
  created vs resolved, workload by assignee, dependency graph (full Vega with force layout; blocked
  paths highlighted; click a node to open the item).
- Charts via Vega/Vega-Lite with the AST expression interpreter and SVG renderer as in procgen;
  theme matches the board (light/dark), colour-blind-safe palette, keyboard-focusable marks where
  practical (at least the dependency graph nodes), tooltips.
- Report documents stored in the gadget server (`report:<id>`): `{ id, title, dataset, params,
  query, spec, created_by }`. Validation: Vega-Lite or Vega JSON only; data must be the named
  dataset (no `url`, no `data.values` over 1 MB); reject `signals` with `on` handlers other than an
  allow-list, `loader`, `image` marks with external `url`, and anything over 256 KiB.

## 3. Agent surface and SKILL.md

- Server RPC (document in README): `query(wql, {limit, fields})`, `describeQuery(wql)`,
  `item(key)`, `history(key)`, `summary({query, by})`, `datasets()`,
  `dataset(name, {params, query, limit})`, `listReports/saveReport/deleteReport`,
  `validateReport(doc)`, `listViews/saveView/deleteView`, `propose(changes, {title, reason})`,
  `listProposals`, `withdrawProposal(id)`. Every method validates input, returns plain JSON, errors
  as `code: detail`, and stays under the ~45 RPC/s budget (server caches the snapshot/journal).
- `SKILL.md` shipped in the archive and linked from README: "Work Board reporting and triage skill"
  with recipes the agent can follow verbatim: answer "what's blocking the current cycle?",
  "who is overloaded?", build a burndown for a named cycle, build a custom chart from a dataset
  (with a complete example spec), turn a natural-language request into WQL (grammar summary and
  10 worked examples), triage the Triage state with proposals, break an item into proposed
  sub-issues, re-prioritise a cycle. Include the data dictionary for every dataset.
- Update `pack-gadget.mjs` FILES and tests so SKILL.md ships; bump the format revision via pack.

## 4. Proposals

- `propose()` stores `{ id, title, reason, proposed_by (agent or viewer), created_at, changes:
  [{ command, input, revision?, reason }] }` (bounded: ≤ 200 changes, 128 KiB). Validates commands
  against the known command list and item existence/revisions at proposal time.
- A Proposals tray (badge count in the shell): each proposal shows a readable diff per change
  ("KEY-12 priority High → Urgent", "new sub-issue under KEY-7: …"), select all/none, apply
  selected. Applying runs the normal viewer-assertion command path for each change (so
  attribution is the person's), reports per-change outcomes, marks the proposal applied/partial,
  and records who applied it. Stale revisions become "needs refresh" with a one-click rebase that
  re-reads the item and re-validates.
- Fully keyboard accessible; announces outcomes.

## 5. Jev triage (optional binding `JEV`)

- Add an optional archive binding for the Jev connector (`jev://decisions`; confirm the
  gatekeeper name from `scripts/deploy.ts`/deployment.jsonc and the Jev README). The board works
  without it.
- Server `triage(keys)` builds a compact state (item title/description, candidate states,
  labels, priority scale, top-5 similar open items by token overlap) and asks `decide()` for
  priority (choice), labels (yes/no per candidate, ≤ 8), state (choice), and duplicate-of
  (choice among candidates or none). Returns suggestions with probabilities.
- UI: "Suggest" button in the detail panel and "Triage with Jev" bulk action in the Triage state.
  Suggestions ≥ 0.9 pre-selected, 0.5–0.9 shown unselected, < 0.5 hidden; always a proposal the
  person applies; confidence shown as text, not colour alone. Rate-limit and cache per revision.

## Tests

Unit tests for every dataset and the report validator; jsdom UI tests for the Reports screen and
Proposals tray with axe; harness e2e for reports rendering (screenshots light/dark at 3 widths),
proposal apply flow keyboard-only, and a fake Jev. Keep all foundation tests green.

## Rules

Work in your git worktree on a branch created from the foundation branch you are given; commit
coherent steps (messages end `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`); never
push or deploy. Report shipped vs brief, deferrals with reasons, test counts, screenshot paths and
known weaknesses.
