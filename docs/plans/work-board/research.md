# Work Board: competitive research (Linear, Jira, GitHub Projects, Shortcut)

Status: research input, 2026-09-26. Informs the flagship Work Board gadget (`packages/blueprint-work-board`)
on the Records datastore. Sources are official docs and changelogs unless marked otherwise. Where a
statement comes from general product knowledge rather than a fetched page, the nearest official
reference page is cited.

Our constraints, restated so the recommendations make sense:

- one sandboxed iframe app inside a collaborative workspace;
- a Postgres-backed Records datastore with typed modules and row-level permissions;
- every write is a **command** that may need human approval, and is attributed;
- a **change journal** records every change and who made it;
- an in-product AI agent that calls the app's RPC surface and runs queries.

---

## 1. Core data models

### Jira Software Cloud

- **Work items** (formerly "issues") have a **work type** (Epic, Story, Task, Bug, Subtask). The
  default hierarchy has three levels: Epic (level 1), standard work types (level 0) and subtasks
  (level -1). Premium and Enterprise can add levels above Epic
  ([work types](https://support.atlassian.com/jira-cloud-administration/docs/what-are-issue-types/),
  [custom hierarchy](https://support.atlassian.com/jira-software-cloud/docs/configure-custom-hierarchy-levels-in-advanced-roadmaps/)).
  A single **Parent** field now expresses both epic-to-story and task-to-subtask. Any type can be a
  parent or a child, except that a subtask can only be a child
  ([create and configure work items](https://support.atlassian.com/jira-software-cloud/docs/create-and-configure-your-work-items/)).
- **Fields**: summary, description, status, resolution, assignee, reporter, priority, labels,
  components, fix versions (releases), sprint, story point estimate, original/remaining estimate
  (time tracking), start date, due date, plus unlimited typed **custom fields**. The Sprint and
  Story points fields appear automatically when those features are enabled
  ([team-managed fields](https://support.atlassian.com/jira-software-cloud/docs/customize-an-issues-fields-in-team-managed-projects/)).
- **Workflows**: statuses are free-form, but each belongs to one of three **status categories**
  (To Do, In Progress, Done). Transitions can carry conditions, validators and post-functions.
  "Resolution" is a separate field and a common source of reporting bugs.
- **Work item links** are typed pairs such as *blocks / is blocked by*, *duplicates / is duplicated
  by*, *relates to* and *clones*. The timeline draws only the **Blocks** type, and only within one
  space ([timeline dependencies](https://support.atlassian.com/jira-software-cloud/docs/manage-dependencies-between-epics-on-the-timeline/)).
- **Sprints** belong to a board. A **board** is defined by a saved JQL filter, with columns mapped
  to one or more statuses.
- Company-managed and team-managed spaces differ. Team-managed spaces lack many board options, such
  as configurable swimlanes.

### Linear

- The hierarchy runs **Workspace → Teams → Issues**. Planning layers are **Cycles** (repeating
  timeboxes), **Projects** (outcome-scoped, with **Milestones**) and **Initiatives** above projects
  ([conceptual model](https://linear.app/docs/conceptual-model)).
- **Workflow statuses** are per team, but every status sits in a fixed category: Triage, Backlog,
  Unstarted, Started, Completed, Canceled, plus a reserved system **Duplicate** status. Teams can
  auto-close stale issues and auto-archive
  ([configuring workflows](https://linear.app/docs/configuring-workflows)). These fixed categories
  are why Linear's reports work without per-team setup. **We should copy this.**
- **Priority** is a fixed 5-value enum: No priority, Urgent, High, Medium, Low.
- **Estimates** come in four scales: exponential, Fibonacci, linear and T-shirt. Teams can extend a
  scale and allow zero. By default an unestimated issue counts as 1 point, and estimates drive the
  cycle and project graphs ([estimates](https://linear.app/docs/estimates)).
- **Relations**: blocked by (`M B`), blocking (`M X`), related (`M R`), and duplicate, which merges
  into the canonical issue. Once a blocker resolves, the relation moves under Related
  ([issue relations](https://linear.app/docs/issue-relations)). **Sub-issues** use a single parent
  ([parent and sub-issues](https://linear.app/docs/parent-and-sub-issues)). Projects can also depend
  on other projects ([project dependencies](https://linear.app/docs/project-dependencies)).
- **Cycles** are created automatically every 1 to 8 weeks, with optional cooldown. Unfinished issues
  roll over. A capacity dial is predicted from the last three cycles' velocity, and up to 15
  upcoming cycles can exist at once ([cycles](https://linear.app/docs/use-cycles)).
- **Labels** can be organised into label groups. Grouping by a label group acts like a single-select
  field. Linear has historically preferred labels and label groups to arbitrary custom fields.
  Structured properties are arriving gradually, for example
  [initiative properties](https://linear.app/changelog/2026-07-02-initiative-properties) in July 2026.

### GitHub Projects (brief)

- Projects hold issues and PRs, plus custom **text, number, date, single-select and iteration**
  fields. They also carry organisation-level issue fields (priority, effort), issue types, parent
  issues and sub-issue progress ([fields](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields)).
  The model is the most minimal of the four: almost everything is a typed field on a project item.

### Shortcut (brief)

- **Stories** have a type (feature, bug or chore) and can hold sub-tasks. Stories group into
  **Epics**, and epics into **Objectives**. The model also has **Iterations**, per-team
  **Workflows** with automations, labels, estimates, custom fields and story relationships
  ([help centre](https://www.shortcut.com/help)).

### Implication for our model

Use one `work_item` record type with these fields:

- `parent` as a single self-reference. Epics and sub-issues are just depth, so one parent field
  covers both, as it now does in Jira and Linear.
- `status`, referencing a per-board status table. Each status carries a **fixed category** enum
  (`triage | backlog | unstarted | started | completed | canceled`).
- `priority` as a fixed 0 to 4 enum, and `estimate` as a number with a per-board scale.
- `assignee`, `labels[]`, `cycle`, `project`, `milestone`, `start_date` and `due_date`.
- `rank`, a fractional index for manual order.
- typed `custom` fields from the module schema.

Relations go in a separate edge table:
`relation(from, to, kind ∈ blocks|relates|duplicates)`. Store `blocks` in one direction only, and
derive `blocked_by` from it.

---

## 2. Views

### Board columns and swimlanes

**Jira** offers six swimlane modes on company-managed boards: **Queries, Stories, Assignees, Epics,
Spaces (projects) and None**
([configure swimlanes](https://support.atlassian.com/jira-software-cloud/docs/configure-swimlanes/)).
Team-managed boards have no configurable swimlanes. The modes behave as follows:

- **Queries**: each lane is a JQL clause, in admin-defined order. The defaults are *Expedite*
  (`priority = Blocker`) and an undeletable **Everything Else** catch-all. Each card appears once,
  in the **first lane whose query matches**, so order matters.
- **Stories**: parents become lanes that contain their subtasks. Items without subtasks go in a
  trailing "Other" lane.
- **Assignees**: one lane per person, with Unassigned last.
- **Epics**: one lane per parent epic, plus a "no epic" lane.

Columns map to one or more statuses and may carry min/max (WIP) constraints. **Quick filters**, JQL
toggles above the board, work alongside lanes.

**Linear** replaces fixed swimlane modes with **grouping** (columns) and **sub-grouping** (lanes).
Both can use status, assignee, project, priority, cycle, label, label group, parent issue, team,
customer, release or SLA status. The group header stays pinned while you scroll, and dragging an
issue between groups **applies that group's value** to it. Options include "show empty groups" and
ordering (manual, priority, created, updated, due date, link count). Manual order is shared
workspace-wide ([display options](https://linear.app/docs/display-options),
[board layout](https://linear.app/docs/board-layout)). List and board views share one ordering,
lanes collapse, and `Alt+Shift+↑/↓` moves an issue to the top or bottom of its column.

**GitHub Projects** also works this way:

- any single-select or iteration field can serve as the column field;
- "Group by" produces horizontal lanes, and dropping a card into a group sets that group's value;
- "Slice by" adds a side panel that filters the view by field value;
- field sums appear per column;
- column limits are advisory only.

([board layout](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-board-layout)).

**Our design** is a *projection* in the form `{columns: FieldRef, lanes: FieldRef | QueryLanes | none}`:

- A `FieldRef` lane follows Linear and GitHub: one lane per distinct value, plus an "empty" lane.
- `QueryLanes` follows Jira: an ordered list of `{label, query}`, placed by **first match wins**,
  with a mandatory fallback lane.
- Multi-valued fields such as labels show the card in every matching lane. Mark each copy as a
  mirror. Dropping a card on a new lane issues a precise command, such as "replace label X with
  Y".
- Dropping into a query lane is **not** a field write, because the query may be arbitrary. Either
  disallow it, or let a lane declare an `onDrop` patch.
- Drop targets derived from `parent`, `cycle` or `project` write that field.

### Other views

- **List**: Linear shares grouping and ordering with the board. Toggle between them with
  `Cmd/Ctrl+B`.
- **Backlog** (Jira Scrum): a stack of future sprints plus the backlog, where you drag to rank or
  move work into a sprint, then start or complete sprints. Linear gets the same result from a
  status-category filter (Backlog) and cycle grouping.
- **Timeline / roadmap**: in Jira, epics appear as bars. A parent's dates roll up from its
  children's earliest start and latest due date. **Blocks** links are drawn as arrows, and an
  "inline hierarchy" option shows two levels
  ([timeline](https://support.atlassian.com/jira-software-cloud/docs/what-is-the-timeline-and-how-do-i-use-it/),
  [child planning](https://support.atlassian.com/jira-software-cloud/docs/enable-child-issue-planning-for-kanban-teams-on-the-roadmap/)).
  Linear's timeline covers projects and initiatives.
- **Triage / inbox**: Linear's Triage is a per-team inbox for issues from integrations or other
  teams. Its actions are Accept (`1`), Duplicate (`2`), Decline (`3`) and Snooze (`H`). A
  triage-responsibility rota can sync with PagerDuty and similar tools
  ([triage](https://linear.app/docs/triage)). This maps well onto our approval queue.
- **My Issues**: Linear has Assigned, Created, Subscribed and Activity tabs, with a unique "Focus"
  grouping. Jira has "Assigned to me" / "For you" and the JQL `assignee = currentUser()`.

---

## 3. Querying

### JQL essentials

References: [advanced search](https://support.atlassian.com/jira-software-cloud/docs/what-is-advanced-search-in-jira-cloud/),
[operators](https://support.atlassian.com/jira-software-cloud/docs/jql-operators/),
[functions](https://support.atlassian.com/jira-software-cloud/docs/jql-functions/).

- **Shape**: a clause is `field operator value`. Clauses combine with `AND`, `OR` and `NOT` and group
  with parentheses. An optional `ORDER BY f1 [ASC|DESC], f2` comes last.
- **Operators**:
  - comparison: `= != > >= < <=`, `IN (...)` and `NOT IN`;
  - text: `~` (contains) and `!~`;
  - emptiness: `IS EMPTY` and `IS NOT EMPTY`;
  - history: `WAS`, `WAS IN`, `WAS NOT` and `CHANGED`, with the predicates
    `AFTER / BEFORE / ON / DURING (a, b) / BY user / FROM x TO y`. For example,
    `status CHANGED FROM "In Progress" TO "Done" BY currentUser() AFTER -1w`.
- **Functions**:
  - people: `currentUser()` and `membersOf("group")`;
  - sprints: `openSprints()`, `closedSprints()` and `futureSprints()`;
  - dates: `startOfDay/Week/Month/Year(±n)`, `endOf…()` and `now()`;
  - versions: `releasedVersions()` and `unreleasedVersions()`;
  - activity: `updatedBy()`, `watchedIssues()`, `issueHistory()` and `linkedIssues(key)`.
- **Relative dates** are durations: `created >= -7d`, `due <= 2w`.
- **Saved filters** are named JQL. They can be shared, subscribed to by email, used to define boards
  and dashboard gadgets, and exported as a gadget
  ([manage search results](https://support.atlassian.com/jira-software-cloud/docs/manage-search-results/)).
- Rovo turns natural-language requests into JQL ([Rovo in Jira](https://www.atlassian.com/software/jira/ai)).

### Linear filters

- The operators are *is / is not*, *is either of*, and *includes any / all / neither / none* for
  labels and links. Dates use before/after, with relative values.
- **Advanced filters** add nested AND/OR groups, and there is an AI natural-language filter.
- Filters live in the URL, so they can be shared. `F` opens the filter menu.
- There is also an "Added to cycle" filter, which differs from membership in a cycle
  ([filters](https://linear.app/docs/filters)).
- Custom views save filters together with display options.

### GitHub and Shortcut token syntax

GitHub Projects uses tokens:

- `field:value` terms, where a space means AND and a comma means OR within a field, as in
  `assignee:a,b`;
- `-field:` for negation, `>`, `>=` and `..` ranges, and `*` wildcards;
- the special values `@me`, `@today` and `@current/@previous/@next` for iterations;
- `has:` and `no:` for presence, and `is:open`.

([filtering projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/filtering-projects)).
Shortcut search uses a similar `owner:` / `state:` / `is:blocked` style.

### Recommended minimal language for us

Use **one JSON AST as the canonical form**, with two projections of it: a filter-chip UI and a
text syntax.

1. **AST** (what views store and what the agent emits):
   `{and|or|not: [...]}`, where each leaf is a clause `{field, op, value}`. The `op` is one of
   `eq ne lt lte gt gte in nin contains empty notEmpty was changed`. A `value` can be a literal or
   a token (`@me`, `@currentCycle`, `@today-7d`, `@startOfWeek`). Views also store
   `orderBy: [{field, dir}]`.
   Validate the AST against the module schema, then compile it to parameterised SQL. Row-level
   permissions stay in Postgres, never in the compiler.
2. **Text syntax**: a JQL-lite, readable by humans and quick to type in the command palette:
   `status in (Todo, "In Progress") and assignee = @me and label != wontfix and due < @today+7d order by priority desc, rank`.
   Keep the grammar tiny:
   - no user-defined functions;
   - about eight built-in tokens;
   - GitHub-style shorthands (`assignee:@me -label:bug`) accepted as sugar.
   Parsing is round-trip safe. Error messages point at a character offset and suggest field names.
   Build accessible autocomplete as a combobox.
3. **History operators** (`was`, `changed from X to Y after -1w by @user`) should compile against
   the **journal**, which gives us JQL's hardest feature almost for free. Ship them in "next", not
   the MVP.
4. **Saved view** = `{query AST, layout (board|list|timeline|report), columns, lanes, orderBy,
   visible properties, chart specs}`. Store it as a Records row, so views are permissioned,
   journaled and editable by the agent through the same approved commands.

---

## 4. Reporting

| Report | What it shows | Data needed |
|---|---|---|
| **Sprint burndown** | Remaining estimate over the sprint, against a guideline; a scope-change log | Sprint start/end; per-item sprint membership changes; estimate changes; transitions into Done. Computed at a point in time, retroactively ([burndown](https://support.atlassian.com/jira-software-cloud/docs/view-and-understand-the-burndown-chart/)) |
| **Burnup** | Scope line and completed line over time | Same as burndown ([burnup](https://support.atlassian.com/jira-software-cloud/docs/view-and-understand-the-burnup-chart/)) |
| **Velocity** | Per sprint: *commitment* (estimate total at sprint start) against *completed* (at sprint end). Sub-task estimates are excluded | Snapshot of sprint scope at start; completions at end ([velocity](https://support.atlassian.com/jira-software-cloud/docs/view-and-understand-the-velocity-chart/)) |
| **Sprint report** | Completed, not completed, removed, and added after start | Sprint membership history |
| **Cumulative flow** | Stacked counts per status over time | A daily snapshot of every item's status, derived from transitions ([CFD](https://support.atlassian.com/jira-software-cloud/docs/view-and-understand-the-cumulative-flow-diagram/)) |
| **Control chart / cycle time** | Scatter of per-item time spent in chosen "active" statuses, with a rolling average (window = 20% of items, minimum 5, always odd) and a standard-deviation band | Status intervals per item ([control chart](https://support.atlassian.com/jira-software-cloud/docs/view-and-understand-the-control-chart/)) |
| **Created vs resolved** | Two cumulative or daily series | Created timestamp; first entry into the Done category ([gadgets](https://support.atlassian.com/jira-cloud-administration/docs/use-dashboard-gadgets/)) |
| **Epic / release burndown** | Remaining work for an epic or version across sprints | Parent membership and estimate history |

- **Linear Insights** (`Cmd/Ctrl+Shift+I`), on Business and Enterprise plans, works in any view.
  - Measures: issue count, effort, cycle time, lead time, triage time and issue age.
  - Charts: bars, scatterplots with 25th, 50th, 75th and 95th percentile markers, and burn-up.
  - Chart setup: choose a **slice** (x-axis), a **segment** (colour) and filters.
  - Export: CSV.
  ([insights](https://linear.app/docs/insights)).
- **Linear Dashboards** (July 2025, Enterprise) combine insights into modular charts, tables and
  single-number tiles ([changelog](https://linear.app/changelog/2025-07-24-dashboards),
  [docs](https://linear.app/docs/dashboards)).
- Cycle pages add a scope, started, completed and target graph.

**Almost every report derives from status-change history, and our journal already records it with
the actor.** Each report reduces to a few derived relations:

- `status_interval(item, status, category, entered_at, left_at, actor)`, built from journal status
  changes. This feeds CFD, cycle time, lead time, triage time, time in status and the control chart.
- `membership_interval(item, cycle|parent|project, from, to)`. This feeds scope change, velocity
  commitment and burndown.
- `estimate_interval(item, value, from, to)`. This feeds points-based burndown.

Materialise these as SQL views or incrementally maintained tables in Records. The reporting screen
then only needs:

1. **named datasets** backed by parameterised queries over these relations, filtered by the view's
   query AST;
2. a **Vega-Lite spec** per chart that references a dataset by name.

The agent customises a chart by editing the spec, then saving it through a normal approved command.
Validate specs against the Vega-Lite schema, block `url` data sources and external loads, and render
inside the iframe. Every chart must include a data-table alternative and a text summary for
accessibility.

The **dependency graph** is not a Jira report. Jira shows dependencies on the timeline and in Plans
([dependencies view](https://support.atlassian.com/jira-software-cloud/docs/refine-the-dependencies-report-in-advanced-roadmaps/)).
Vega-Lite has no graph layout, so build it with the Network Map blueprint's layout, or with a Vega
(not -Lite) force transform. Always pair it with a list form: "blocked items and their blockers".

---

## 5. Keyboard and UX

**Linear** sets the bar:

- `Cmd/Ctrl+K` opens a command menu that acts on the focused or selected issues, and right-click
  opens the same actions ([select issues](https://linear.app/docs/select-issues)).
- Single-key verbs:
  - `C` create, `S` status, `A` assign, `I` assign to me, `P` priority and `L` labels;
  - `M B / M X / M R` for relations;
  - `F` filter, and `G then T` to jump to triage.
- `X` selects the hovered issue and `Shift+X` extends the selection. A floating **bulk action bar**
  offers common actions.
- `Space` toggles **Peek**, and holding it shows a temporary preview. `↑/↓` then moves through
  adjacent issues while the preview updates ([peek](https://linear.app/docs/peek)).
- `Cmd/Ctrl+B` toggles board and list, and `Cmd/Ctrl+Z` undoes a move
  ([editing issues](https://linear.app/docs/editing-issues)).
- Issues moved by keyboard go to the top of the column, while mouse drops land exactly where
  dropped ([board layout](https://linear.app/docs/board-layout)).
- Speed comes from a local-first sync engine: the app hydrates from IndexedDB, applies
  **optimistic updates** and syncs deltas over WebSocket, so the network is never in the path of an
  interaction. That description comes from third-party analysis, for example
  [performance.dev](https://performance.dev/how-is-linear-so-fast-a-technical-breakdown).

**Jira**:

- Shortcuts: `C` create, `J/K` next/previous, `N/P` next/previous column, `A` assign, `I` assign to
  me, `M` comment, `O` open and `?` help. Users can switch shortcuts off in the help dialog
  ([shortcuts](https://support.atlassian.com/jira-software-cloud/docs/use-keyboard-shortcuts/)).
- Per-user accessibility settings include underlined links and patterns on status lozenges, so
  status is not colour-only ([DC docs](https://confluence.atlassian.com/jirasoftwareserver/accessibility-998878998.html)).
- Atlassian's **Pragmatic drag and drop** guidance is the best public reference. User testing
  found that **action menus** ("Move to… column / top / bottom / lane") beat directional
  keyboard dragging on reliability, discoverability and cost. If an item has no "more actions"
  menu, its drag handle should become a menu button
  ([a11y guidelines](https://atlassian.design/components/pragmatic-drag-and-drop/accessibility-guidelines)).

### WCAG 2.2 AA requirements that bite a kanban board

- **2.5.7 Dragging Movements (AA)**: anything done by dragging must also be possible with a single
  pointer and no drag. A "Move to" menu or a status picker on the card qualifies. Keyboard support
  alone does **not** satisfy this criterion, because it is evaluated separately from 2.1.1
  ([Understanding 2.5.7](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html)).
- **2.1.1 Keyboard**: every drag outcome must be reachable by keyboard.
- **2.1.4 Character Key Shortcuts (A)**: Linear-style single-letter shortcuts must be possible to
  turn off or remap, or be active only when the relevant component has focus. Our iframe helps
  here, because keys only reach the gadget when it has focus. We still need a setting to disable or
  remap them, and we must not steal keys while an input is focused.
- **2.4.11 Focus Not Obscured (AA)**: pinned lane headers, sticky column headers and the bulk bar
  must not cover the focused card. Use `scroll-padding`.
- **2.5.8 Target Size (AA)**: controls must be at least 24×24 CSS px. This includes card menu
  buttons, lane toggles and chips.
- **4.1.3 Status Messages**: announce moves, approvals and failures through a polite live region,
  for example: "Moved ABC-12 to In Progress, position 1 of 4. Awaiting approval."
- **1.4.1 Use of Colour / 1.4.11 Non-text Contrast**: priority and status need icons or text as
  well as colour.

**Accessible kanban pattern.** There is no WAI-ARIA APG kanban pattern, so the robust choice is:

- each column is a labelled region (`<section aria-labelledby>`) containing a list, and each card is
  a list item with a single focusable primary control;
- arrow keys move focus: ↑/↓ within a column, ←/→ across columns keeping the row, and lanes are a
  higher level of the same scheme. Use roving `tabindex` so Tab moves between columns, not between
  cards;
- a **keyboard "pick up" mode** (`Space` to lift, arrows to move, `Space` to drop, `Esc` to cancel)
  with live-region narration is optional polish. The menu alternative is mandatory;
- after a move, focus follows the card.

---

## 6. AI features (brief)

- **Linear**:
  - **Linear Agent** (public beta March 2026) is a workspace-aware chat opened with `Cmd/Ctrl+J`.
    Users can save successful workflows as reusable **Skills**, and **automations trigger when
    issues enter triage** ([changelog](https://linear.app/changelog/2026-03-24-introducing-linear-agent)).
  - **Code Intelligence** (May 2026) and **coding sessions** that delegate to Claude Code or Codex
    (June 2026) followed ([code intelligence](https://linear.app/changelog/2026-05-14-code-intelligence),
    [coding sessions](https://linear.app/changelog/2026-06-11-coding-sessions)).
  - **Triage Intelligence** suggests assignee, labels and duplicates from workspace history
    ([triage](https://linear.app/docs/triage)).
  - Other features include natural-language filters, discussion summaries
    ([Oct 2025](https://linear.app/changelog/2025-10-02-issue-discussion-summaries)) and
    assigning or delegating issues to agents ([assigning](https://linear.app/docs/assigning-issues)).
- **Jira (Rovo)**:
  - work can be assigned to agents "like a teammate";
  - a Work Readiness Checker agent;
  - **work breakdown**, which suggests child items that the user accepts or declines one by one;
  - natural language to JQL;
  - "instant context" summaries;
  - Rovo PM skills that create and update items and draft status reports;
  - Rovo Dev, which turns work items into code.

  ([Rovo in Jira](https://www.atlassian.com/software/jira/ai)).

**Takeaway**: both tools converge on *propose, then a human accepts*. Rovo's per-suggestion
accept/decline and Linear's triage suggestions are exactly what our **approved command** model does
natively. Our advantage is that every agent action is already a first-class, reviewable, attributed
command, with journal history.

---

## 7. Delightful touches commonly praised in Linear

- **No spinners.** Edits are optimistic, navigation is instant and URLs are shareable, including
  their filters.
- **One consistent verb grammar.** The same single keys work in list, board, peek and detail.
  `Cmd+K` operates on the current selection, and every command shows its shortcut, so the palette
  teaches the keys.
- **Peek while you move.** Hold Space and arrow through issues.
- **Fixed status categories and few knobs.** Opinionated defaults such as cycles that roll over,
  auto-archive and a capacity dial let reports work with no setup.
- **Sub-grouping with sticky headers.** Dropping on a lane sets its value, and empty groups can be
  toggled.
- **Small crafted details.** Issue IDs copy with the branch name. Triage uses the numbers 1, 2 and 3.
  Blocked cards show an orange flag and blocking cards a red one, and a relation moves to "Related"
  once the blocker resolves. Undo is always available.
- **Careful typography and density.** The palette is calm, with keyboard focus rings that are
  visible without being loud.

---

## 8. Recommendation

### MVP for the flagship (must)

1. **Data model**:
   - `work_item` with `parent` as a single self-reference, so epics and sub-issues share one
     field;
   - statuses with **fixed categories**, a priority enum 0 to 4, a numeric estimate with a scale,
     assignee, labels, cycle, project, due date and a fractional `rank`;
   - typed custom fields from the module schema;
   - a `relation` edge table (`blocks`, `relates`, `duplicates`).
2. **Board with generic projection**: columns from any single-select field (status by default), and
   **lanes from any field** (assignee, priority, label, cycle, project, parent, custom). Empty lanes
   can be toggled, headers are sticky, lanes collapse, and each column shows a count, an estimate
   sum and an advisory WIP limit. Dropping writes the lane or column value as **one command**.
3. **List view** sharing the same query, grouping and ordering, plus **peek** (Space) and a detail
   panel.
4. **Query AST and a JQL-lite text syntax**:
   - AND, OR, NOT and parentheses;
   - the operators `= != < > in nin ~ is empty`;
   - `@me`, `@today±Nd` and `@currentCycle`, and `order by`;
   - a chip-based filter UI over the same AST.
   **Saved views** are Records rows. The agent reads and writes the AST, never SQL.
5. **Command-aware optimistic UX**: apply auto-approved commands optimistically, with rollback. When
   a command needs approval, show a **pending ghost** in the target position with the badge
   "awaiting approval by …". Rejections roll back with an announced reason. Every card links to
   its journal history.
6. **Keyboard and accessibility baseline**:
   - `Cmd/Ctrl+K` palette over the selection;
   - `C / S / A / I / P / L / X / Shift+X / Space / F / ?`, with a setting to disable or remap
     single-key shortcuts (2.1.4);
   - roving-focus board navigation;
   - a **"Move to…" menu on every card** (2.5.7);
   - live-region announcements, 24 px targets and non-colour status cues;
   - bulk edit through a selection bar, where each bulk edit is one approvable batch command.
7. **Reporting v1**:
   - journal-derived `status_interval` and `membership_interval` views;
   - three stock Vega-Lite charts: **cumulative flow**, **cycle-time scatter** (percentiles and
     rolling average) and **cycle burnup** (scope against completed);
   - each chart has a data-table fallback;
   - the agent can clone and edit a chart spec through approved commands.

### Next

- **History operators** in the query language (`was`, `changed from/to/by/after`), compiled against
  the journal. This is a differentiator that only Jira has.
- **Query-based lanes** (first match wins, mandatory "Everything else") and quick-filter toggles.
- **Cycles** with auto-cadence, rollover and velocity (commitment snapshot at start against
  completed), plus burndown with a scope-change log and created vs resolved.
- **Triage inbox**, merged with the approval queue: accept, decline, duplicate and snooze on
  `1 / 3 / 2 / H`. The agent pre-fills suggested assignee, labels and duplicate candidates as
  *proposed* commands.
- **Agent skills**: work breakdown into proposed sub-items, NL to query AST, and "why is this
  blocked?" explanations. All output goes through the existing command and approval path.
- **Keyboard pick-up mode** for drag, with narration.

### Later

- **Timeline**: parent date roll-up and `blocks` arrows, with a list alternative for 2.5.7.
- **Dependency graph** report, reusing the Network Map layout.
- **Dashboards**: multiple saved charts and number tiles per page.
- Milestones and initiatives, and project-level dependencies.
- Filter subscriptions (digest via the chat gatekeeper) and SLAs.
- Optional Jira/Linear import and sync adapters. These are a per-module adapter, not core.

**What not to build**:

- Jira-style per-transition validators and post-functions. Our approval policy already covers
  that intent.
- Configurable hierarchy levels. A single parent pointer is enough.
- Time tracking.
- A JQL function plug-in system.

**Opinion**: win on *trust and speed*, not configurability. Fixed status categories, one query AST
shared by humans, views and the agent, journal-native history queries, and approval-aware
optimistic UI together give a board that Linear users find fast and Jira users find powerful. No
competitor can show *who, or which agent, changed what, and who approved it* on every card.
