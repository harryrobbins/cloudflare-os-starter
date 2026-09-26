# Work board

A fast, keyboard-first project tracker for **work items** stored in a Records datastore. Plan with
workflow states, priorities, assignees, labels, estimates, dates, projects, cycles, sub-issues and
relations; view them as a board (with swimlanes) or a list; filter with the Work Query Language
(WQL); save shared views; see how work flows in **Insights** (cumulative flow, cycle time,
burndown and burnup, throughput, created vs resolved, workload, dependencies); and review changes
the Workshop agent or Jev **proposes**.

Every item lives in the Records datastore, not in this gadget. Every change is an approved,
attributed command: the board shows what Records holds, and your pending changes are shown as
overlays until they are saved. Other boards, explorers and clients connected to the same datastore
see the same items.

This gadget is built from `packages/blueprint-work-board` in the deployment's starter repository.
**Edits made here in the code editor are not carried back to that source.**

## Setup

Open the gadget's Connections tab and add a **Records** datastore that uses the `work` module
(API v1), named `RECORDS`.

- **Read and request changes** lets signed-in people create, edit and move items.
- **Read only** shows the board without editing controls.
- A datastore with another module (for example `messaging`) is refused with "This board needs a
  work v1 datastore".

**Optional: Jev triage.** Add the **Jev decisions** connector (`jev://decisions`) named `JEV` to get
triage suggestions (priority, state, labels, possible duplicates) with calibrated confidence. The
board works fully without it. (The connection is added in the Connections tab rather than asked
for when the board is created, because the platform makes every declared binding mandatory at
creation, and not every deployment runs Jev.) Item titles, descriptions and the board's label
names are sent to Jev (through OpenRouter) for each item you ask about; nothing else.

The full planning model (states, priorities, labels, projects, cycles, relations, comments, item
numbers) needs Records migration 010. On an older datastore the board still works with the basic
model: columns Open, Active and Done, and items with a title and description.

## Using the board

- **Columns** are workflow states by default (Triage, Backlog, Todo, In Progress, In Review, Done,
  Canceled, or your own), with counts, point totals and WIP limits (shown in red when exceeded; not
  enforced). Collapse a column with its arrow button. **Display** changes what columns show:
  state, status, assignee, priority, project or cycle, and whether empty columns hide (by default
  they hide while the view has a filter). Columns size themselves so about five fit on a laptop.
- **Phones and narrow windows** show one column at a time: tap a column in the switcher above the
  board, swipe sideways, or press ← →. The filter box sits behind the **Filter** button.
- **Swimlanes** (Display → Swimlanes) split the board by assignee, priority, project, cycle,
  parent, label, due date, status, creator or any extension field (`ext.<name>`). Lanes are
  sticky, collapsible, ordered naturally with "No value" last, and can hide when empty. An item
  with two labels appears in both label lanes ("also shown in another lane"). An empty cell is a
  slim drop zone; its **+** creates an item right there.
- **Cards** show the key (for example `WRK-42`), title, priority (an icon; only Urgent is coloured),
  assignee, labels (as many as fit, then "+N"), estimate, due date (red when overdue), sub-issue
  progress, a Blocked badge and the comment count. Display chooses which, and the density.
- **List** (Ctrl/⌘+B switches) shows the same items as a grouped, sortable table; choose columns
  in Display.
- **Details** open beside the board (full screen on narrow screens). The top shows the key, the
  title and pills for state, priority and assignee; **Share…** shows the key as text to copy. Edit the title and Markdown
  description, set every property, add sub-issues, relations (blocks, blocked by, relates,
  duplicates) and comments, and read the item's activity ("Ada moved it from Todo to In Review").
- **Create** with **New item** or `C`. Type tokens in the title: `#label`, `@person` or `@me`,
  `!urgent`/`!high`/`!1`–`!4`, `^current` or `^cycle name`. A new item inherits the column and
  lane it was created in, and unambiguous values from the filter. Tick **Create more** to add
  several.
- **Move** by dragging, with the card's **⋯ Move** menu (`M`), or with `Shift`+arrows (keyboard
  move: arrows choose the column, position and lane; `Enter` confirms, `Escape` cancels). Moving
  to another lane changes that lane's property (for example reassigns the item).
- **Select several** with the checkbox, `X` or Shift-click, then use the bar at the bottom to set a
  property on all of them (one change per item).
- **Undo** your own last change from its notification or with Ctrl/⌘+Z; it sends the inverse
  change once the original is saved.

## Insights

**Insights** (next to Board and List, or `G` then `I`) is a grid of reports. Each has a chart, a
one-sentence summary ("Scope grew 12% this cycle; 18 of 40 points done; projected to finish 2 days
late"), **Data** (an accessible table of what is plotted) and a menu: edit (title, filter,
parameters, spec), duplicate, view spec, delete or hide. The view's filter applies to every report,
so `project:"Billing v2"` turns the whole screen into that project's reports.

- **Built in:** cumulative flow, cycle time (with the median, the 85th percentile and a rolling
  average), cycle burndown and burnup (choose the cycle; the current one by default), throughput
  per week, created vs resolved, workload by assignee, and the dependency graph (arrows from
  blocker to blocked; chains in orange; click a node, or Tab into the graph and use the arrow keys
  and Enter, to open an item).
- **Reports are shared** by everyone using the board. Built-ins can be edited (**edited** tag;
  "Reset" restores them) and hidden (bring them back from **Hidden**). **New report** takes a
  Vega-Lite or Vega spec over a dataset; the Workshop agent can write them for you ([SKILL.md](SKILL.md)).
- **Time:** reports read the datastore's change journal from the start, so they cover changes made
  before the board existed. Days are UTC dates. Charts refresh at most every 5 seconds as changes
  arrive.
- Charts follow the light or dark theme with colour-blind-safe colours; shape and text carry
  meaning too (blocked items are diamonds; every chart has a summary and a data table).

## Proposals

The Workshop agent cannot change items; it **proposes** changes, and so does Jev triage. The
**Proposals** button (with a count; `G` then `P`) opens the tray: each proposal shows who proposed
it, why, and every change as a readable line ("TW-12 priority High → Urgent", "New sub-issue under
TW-7: …"). Tick the ones you agree with (all are ticked to start; **Select none** clears them) and
**Apply selected**. Each change is then sent as your own change, through approval like any other,
and the tray shows its progress (sent, awaiting approval, saved, not saved). A change to an item
someone edited since it was proposed is marked **Needs refresh**; **Refresh stale changes**
re-checks them against the items as they are now. **Withdraw** closes a proposal you do not want.

**Jev triage** (with the optional `JEV` connection): **Suggest** in an item's details, or
**Triage with Jev** in the Triage view or the selection bar (up to 20 items at a time). Suggestions
Jev is at least 90% sure of are ticked, 50–90% are shown unticked, less likely ones are hidden;
confidence is written out ("94% likely"). **Apply selected** applies them as your changes (recorded
as a proposal from Jev), or **Save as proposal** to review later.

## How changes are saved

- Each change is one Records command for one record. The Workshop asks the Records connector to
  confirm it came from you (a one-use viewer assertion over the exact change), then queues it for
  approval unless the owner allows that kind of change automatically.
- While a change waits, the card shows **Pending** where it is and a dashed **Awaiting approval**
  copy where it will land. It moves only once Records has saved it. The status button (bottom
  right) lists your changes, groups bulk edits and offers Retry, Undo and Dismiss.
- **Conflict** means someone else changed the item first: the board shows their version; retry
  if your change is still needed. **Not saved** explains why (declined in the Workshop, invalid,
  not allowed). **Retry** sends the change again against the current version. An automatic resend
  after a network failure reuses the same idempotency key, so a change is never applied twice.
- Pending changes survive a reload of the board frame.

## People

Everyone is shown by name. A person's display name is learned the first time they open the board
(their Workshop account name); until then they appear as their account. **Settings → People**
renames anyone for everyone using this board, for example a service credential used by an import
("Import bot"). Hover a name to see the account behind it. Filters accept names:
`assignee:"Ada Lovelace"`.

## Views

The filter, layout, columns, swimlanes, order and display options together make a **view**.
Built-in views: All items, My issues, Current cycle (by person) and Triage. **Views → Save as a new
view** stores a shared view (everyone using this board sees it); a dot on the view button means
you have unsaved changes (**Save view** or **Reset**). Your last view, collapsed lanes, shortcut
preference and an unsent draft are remembered for you only.

## Work Query Language (WQL)

Type in the filter box (`/`). Autocomplete suggests fields and values; mistakes are underlined
with a "did you mean" fix, and the last valid filter keeps applying until you fix it. Each clause
also appears as a chip you can change or remove, and **+ Filter** builds clauses without typing.

```
assignee:me priority:<=high label:bug -label:wontfix
state:"In Review" cycle:current is:blocked due:<7d
(label:bug OR label:regression) "login" updated:>-14d sort:priority,-updated
```

- **Terms:** `field:value`; any of: `field:a,b`; comparisons `field:<v`, `<=`, `>`, `>=`; ranges
  `field:a..b`; negation `-field:v`, `-(…)` or `NOT`; `AND` is implicit, `OR` and parentheses
  group. Bare words or `"quoted phrases"` search titles and descriptions.
- **Values:** `me`, `none`; dates `2026-10-30`, `today`, `yesterday`, `tomorrow`, relative `-7d`
  (7 days ago), `7d` or `+7d` (in 7 days), units `d`, `w`, `m` (30 days), `y`; cycles `current`,
  `next`, `previous`.
- **`is:`** `blocked`, `blocking`, `overdue`, `archived`, `parent`, `sub`, `unassigned`,
  `unestimated`, `stale` (not updated for 14 days), `open`, `active`, `done`.
- **`has:<field>`** any field with a value; `-has:due` has none.
- **`sort:`** one or more fields, `-` for descending: `sort:priority,-updated`. Without it the
  board keeps its manual order (drag to reorder) and the list sorts by priority.

| Field | Meaning |
| --- | --- |
| `status` (`category`) | open, active or done |
| `state` | Workflow state name or key (`state:"In Review"`) |
| `kind` | triage, backlog, unstarted, started, completed, canceled |
| `priority` | urgent, high, medium, low, none (or 0–4). `<` means *more urgent*: `priority:<=high` is urgent or high |
| `assignee`, `created_by` (`creator`), `updated_by` | `me`, `none`, a name or account |
| `label` (`labels`) | Has the label; `label:a,b` any of them |
| `estimate` | Points |
| `start`, `due` | Dates; `due:<7d` = due within 7 days, overdue included |
| `created`, `updated` | When known (see Freshness) |
| `parent` | Parent key (`parent:WRK-7`) or `none` |
| `project`, `cycle` | Name (cycles also by number, `current`, `next`, `previous`) or `none` |
| `key` (`number`) | `key:WRK-42`, `key:10..20` |
| `text`, `title`, `description` | Contains |
| `archived` | `true` or `false` (archived items are hidden unless the query mentions them) |
| `ext.<name>` | An extension field |

## Keyboard

Single-key shortcuts work when you are not typing and can be switched off (keyboard button in the
header, or Settings → General). Arrows, `Enter`, `Space`, `Escape` and Ctrl/⌘ shortcuts always
work. Every action is also in the command palette, which shows its shortcut.

| Keys | Action |
| --- | --- |
| Ctrl/⌘+K | Command palette: actions, items by key or title, views |
| `C` | Create item |
| `/` | Filter |
| `J` `K` or ↓ ↑, `H` or ←, → | Move between cards and columns (lanes continue past a column's end) |
| Home, End, PageUp, PageDown | First/last column, 10 cards up/down |
| Enter, Space | Open details; peek (toggle details, keep your place) |
| `X`, Ctrl/⌘+A, Escape | Select; select all shown; clear selection or close |
| `S` `A` `I` `P` `L` `E` `D` | State, assign, assign to me, priority, labels, estimate, due date |
| `M`, Shift+arrows | Move menu; keyboard move |
| Ctrl/⌘+B, `G` then `B` / `L` / `I`, Ctrl/⌘+Z, `?` | Board/list, go to board / list / insights, undo, shortcut sheet |
| `G` then `P` | Proposals |

## Accessibility

Designed to WCAG 2.2 AA: landmarks and headings for columns and lanes; cards are focusable with
a full spoken summary (key, title, state, assignee, priority, due, labels, blocked, pending); one
tab stop per board with arrow-key navigation; focus returns to where you were after dialogs and
updates; every drag has a single-pointer Move menu and a keyboard move with spoken targets;
saves, approvals, conflicts and filter counts are announced; 24 px targets; light and dark themes
with checked contrast; meaning never by colour alone; works at 320 px wide and 400 % zoom; motion
is off when your system asks for reduced motion. The focused card stays put while you scroll a
long column with the mouse, so the keyboard carries on where you left it.

## Settings

**Settings** (gear): the item key prefix (shared; default from the datastore name), your
single-key shortcut preference, and the datastore's workflow states (name, kind, colour, WIP
limit, order), labels, projects and cycles. Changes to states, labels, projects and cycles are
Records commands and go through approval like any other change. A state that items use cannot
change category; cycles cannot overlap.

## Freshness

The board loads a complete snapshot (up to 5,000 records), then pulls the datastore's change
journal every 3 seconds while visible (15 seconds in the background), backing off when the service
is unreachable (an offline banner offers Retry). When permissions change it discards what it holds
and reloads. Activity history is read from the journal in the background. Records carries who
made each change and when, so activity reads "Ada moved it to In Review · 2 h ago" and
`created:`, `updated:` and `is:stale` work on every item. (Against an older Records service
without record times, times appear only for changes the board saw arrive.)

## Programmatic use (agents)

**For reporting, triage and proposing changes, follow [SKILL.md](SKILL.md)**: recipes you can run
as written (what's blocking the cycle, who is overloaded, burndowns, custom charts, WQL from a
request, triage, breaking work down, re-prioritising), the full RPC reference and the data
dictionary of every dataset.

Call these through the gadget's binding (for example `env.WorkBoard`) from `executeCode`. Reads
use the same WQL as the board, so `query()` returns exactly what a person sees with that filter.

```js
await env.WorkBoard.query("cycle:current is:blocked", { limit: 50, fields: ["key", "title", "state", "assignee", "blocked_by"] });
// → { query, description, total, truncated, items: [{ key, title, state, status, assignee, blocked_by, … }] }
await env.WorkBoard.describeQuery("priority:<=high -label:bug");  // { query (canonical), description (plain English), errors }
await env.WorkBoard.item("WRK-12");        // one item with sub_issues, blocks, blocked_by_all, relates, duplicates, comments, progress
await env.WorkBoard.vocabulary();          // keyPrefix, states, labels, projects, cycles, people, item count, today
await env.WorkBoard.listViews();           // shared saved views
await env.WorkBoard.saveView({ id: "blocked-now", name: "Blocked now", query: "is:blocked", layout: "board", swimlanesBy: "assignee" });
await env.WorkBoard.deleteView("blocked-now");
await env.WorkBoard.people();              // [{ actor, name, alias, displayName }]: names used for actors
await env.WorkBoard.setPersonAlias("records:principal:…", "Import bot");
await env.WorkBoard.getSetup();            // { connected, requirement, connection, description, error }
await env.WorkBoard.snapshot(5000);        // raw Records snapshot; changes(seq, epoch), records(query), model() also pass through
await env.WorkBoard.summary({ query: "cycle:current", by: ["assignee", "kind"] });   // counts for a chat answer
await env.WorkBoard.history("WRK-12");     // the item's changes as sentences, newest first
await env.WorkBoard.datasets();            // the data dictionary; dataset(name, { params, query, limit }) reads one
await env.WorkBoard.propose([{ command: "work.update", input: { id: "WRK-12", priority: "urgent" }, reason: "Customer escalation" }], { title: "Escalate WRK-12" });
```

`query` options: `limit` (1–500, default 50), `fields` (default: key, title, state, status,
priority, assignee, labels, estimate, due, start, project, cycle, parent, created_by, updated_by,
archived), `viewer` (a Records actor for `me`). Errors are `code: detail` strings, e.g.
`invalid_request: Unknown field “prority” (at character 1) Did you mean “priority”?`.

**Agents cannot change items through this board.** A change needs a viewer assertion, which only
a signed-in person using the board can obtain. Use `propose()` instead: the person applies your
proposal from the board's Proposals tray, and the change is attributed to them.
