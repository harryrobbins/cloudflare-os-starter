# Brief: Work Board foundation (flagship UI)

Owner: board subagent. Read first: [plan.md](plan.md) (all of it), [research.md](research.md)
(Linear/Jira survey and priorities), [brief-service.md](brief-service.md) (the data contract you
build against), the current package `packages/blueprint-work-board/` (README, `src/`, tests),
`~/.claude/projects/-var-web-cloudflare-os-starter/memory/gadget-runtime-gotchas.md`, and for
patterns: `packages/blueprint-procgen-explorer` (Vega under CSP), `packages/blueprint-wave` and
`packages/blueprint-network-map` (rich READMEs, `harness/` + Playwright `e2e/harness.test.mjs`),
`packages/blueprint-kanban/e2e/README.md`.

## Goal

Rebuild the Work Board client into a flagship, Linear-grade tracker on the `work` planning model:
fast, keyboard-first, fully accessible, delightful, and robust. Keep the approval-and-attribution
truth model (committed state only from Records; pending changes as overlays).

You own `packages/blueprint-work-board/**` and `formats/work-board.*`. Insights (reports, agent RPC,
proposals, Jev) is a later brief; leave clean seams for it: a `views/` registry the Reports screen
can join, a dataset module boundary, and a server storage module for documents.

## Architecture (required)

- Keep the no-framework approach, but introduce a small, well-tested rendering core: keyed
  reconciliation for lists (cards, rows, lanes) so re-renders keep focus, scroll and DOM identity.
  No innerHTML with data; text only. Target < 60 KB of our own code (excluding Vega later).
- `src/shared/wql/` — the Work Query Language (parse, evaluate, format, describe, suggest) exactly
  as plan.md specifies; pure, used by client and server. Property-based and table tests.
- `src/client/store/` — normalised state: items, projects, cycles, states, labels, relations,
  comments; snapshot + journal apply (idempotent by revision); derived indexes (by key number,
  by parent, blocking graph); pending-change overlay.
- `src/client/ui/` — shell, board, list, detail panel, command palette, filters, dialogs, toasts,
  proposals tray placeholder.
- Server (`src/server/`): keep the Records proxy exactly pass-through for commands; add a document
  store (views `view:<id>`, per-viewer prefs `pref:<viewerId>`) with validation and size bounds,
  exposed as RPC (`listViews`, `saveView`, `deleteView`, `getPrefs`, `savePrefs`). Also
  `query(wql, opts)` and `item(key)` that sync a server-side snapshot cache (short TTL) and run WQL,
  so the agent gets the same results as the UI.

## Features (must, in priority order)

1. **Data model adoption.** All plan.md fields and entities (workflow states carry `kind`:
   triage/backlog/unstarted/started/completed/canceled; group, colour and order by it); `KEY-n` identifiers (key prefix is a
   per-board setting, default derived from the datastore label, e.g. `WRK`); graceful degradation
   when talking to a datastore without migration 010 (v1-only fields: board still works).
2. **Board layout.** Columns = workflow states (ordered by position, category colours, WIP count
   and limit), cards show key, title, priority icon, assignee avatar (initials, colour from id),
   labels, estimate, due (overdue styling), sub-issue progress, blocked badge, comment count.
   Inline "+ New" per column. Collapsible columns. Horizontal scroll with sticky headers.
3. **Swimlanes.** Any property (plan.md list including labels multi-lane and `ext.*`), sticky lane
   headers with count and estimate sum, collapse/expand all, hide empty, "No value" last, natural
   order. Drag across lane changes that property; drag within column reorders (`rank`).
4. **List layout.** Grouped, sortable table with the same query; column chooser; keyboard grid
   navigation.
5. **Filtering and views.** WQL bar with syntax highlighting, inline errors with position and
   suggestions, autocomplete for fields and values (people, labels, states, projects, cycles);
   a filter builder (chips) that round-trips to WQL; quick filters (My issues, Unassigned,
   Blocked, Overdue, Current cycle). Saved views (shared per board) with name, query, layout,
   grouping, swimlanes, sort and display options; view switcher; unsaved-changes indicator.
6. **Detail panel ("peek").** Opens beside the board (full screen on narrow widths): editable title
   and Markdown description (safe renderer: text-only DOM, no HTML passthrough), all properties
   with pickers, sub-issues (create inline), relations (blocks/blocked by/relates/duplicates) with
   search, comments thread (create/edit own), activity history from the journal with actor
   names ("Ada moved to In Review · 2h ago"), created/updated attribution.
7. **Create.** `C` anywhere opens a quick-create dialog: title plus optional properties via inline
   tokens (`#label`, `@assignee`, `!1` priority, `^cycle`), and "create more" toggle.
8. **Command palette and shortcuts.** `Cmd/Ctrl-K` palette with fuzzy search over commands, items
   (by key or title), views and navigation; contextual commands for the focused/selected items.
   Linear-style single-key shortcuts when not typing: `C` create, `/` filter, `J/K` or arrows move
   focus, `Enter` open, `Esc` close, `X` select, `Shift`-click range select, `S` state, `A` assign,
   `P` priority, `L` labels, `E` estimate, `D` due date, `M` move menu, `?` shortcut sheet. All
   discoverable (tooltips show shortcuts; palette lists them).
9. **Multi-select and bulk edit.** Select via checkbox, `X`, range; a bulk bar applies a property
   change to all selected (one command per item, grouped status, partial failures reported per item).
10. **Pending overlay done beautifully.** Ghost card at the target position with an "awaiting
    approval" shimmer; the real card stays until saved; conflict and rejection explained inline
    with a retry; a compact status centre replaces the current bottom-left panel.
11. **People.** Assignee picker lists actors seen in the datastore (created_by/updated_by/assignee
    values) plus the current viewer ("me"), with display names derived as today (`actorLabel`).
12. **Settings.** Board settings dialog: key prefix, workflow states (create/rename/reorder/colour/
    WIP limit via `work.state.*`), labels (`work.label.*`), projects and cycles management (simple
    lists with create/edit).

## Accessibility (release gate: WCAG 2.2 AA)

- Semantic structure: landmarks, one `h1`, column and lane headings, cards as focusable
  `article`s with an accessible name summarising key, title, state, assignee, priority, due.
- Roving tabindex across the board grid (arrows move between cards, columns and lanes; `Home/End`,
  `PageUp/PageDown`); focus is never lost on re-render, dialog close returns focus to the invoker.
- Every drag has a non-drag alternative (2.5.7). The primary one is the card's Move menu with state and lane choices, and
  keyboard move mode (`M` or `Shift`+arrows) announcing "Moving KEY-12 to In Review, lane Ada.
  Press Enter to confirm, Escape to cancel."
- Live region announcements for saves, approvals, conflicts, filter result counts ("24 items").
- Contrast ≥ 4.5:1 text, 3:1 UI; visible focus ring (2.4.11/2.4.13); target size ≥ 24px (2.5.8);
  works at 400% zoom / 320 CSS px wide (reflow); respects `prefers-reduced-motion` and
  `prefers-color-scheme` / platform theme; no information by colour alone (priority has icon+text).
- Single-key shortcuts can be turned off (and are off while typing) per viewer (WCAG 2.1.4);
  `Space` peeks the focused item.
- Dialogs: proper `dialog` semantics with focus trap; comboboxes follow the ARIA APG pattern.
- Add `axe-core` as a devDependency; run it in jsdom tests for key screens and in Playwright e2e.

## Delight (pick with taste; all must respect reduced motion)

Springy but quick card motion on reorder (FLIP), a satisfying settle when an approval lands, subtle
confetti-free "Done" check animation, skeleton loading instead of spinners, empty states with a
one-line helpful action, keyboard hint chips, relative times that update, smart defaults
(new item in a lane inherits that lane's property; in a filtered view inherits filter values
where unambiguous), undo toast for your own last change that submits the inverse command, and
tasteful microcopy. Theme: clean, dense-but-calm, system font stack, 4/8px spacing grid.

## Robustness and performance

- 2,000 items: first render < 300 ms after snapshot; WQL filter/regroup < 50 ms; drag at 60 fps.
  Use windowing for long lists/columns (> 200 cards) without breaking roving focus.
- Sync: keep the journal pull model; backoff on errors; permission-epoch reset; offline banner;
  never duplicate or lose a pending change; idempotent retries (existing contract).
- All user input validated before sending; server errors mapped to friendly messages.

## Tests (required)

- Unit: WQL (≥ 150 cases incl. errors and round-trip `format(parse(x))`), store apply/idempotency,
  swimlane projection, rank generation, shortcuts, bulk edit, pending overlay, server document store.
- jsdom UI tests for every major flow, plus axe checks with zero serious/critical violations.
- `harness/` (static page + fake gadget server with a seeded realistic dataset of ~300 items across
  projects/cycles/people, and a 2,000-item perf fixture) and Playwright `e2e/harness.test.mjs`:
  keyboard-only journeys (create, move across lanes, bulk assign, filter, save view), drag and drop,
  axe on each screen, screenshots at 375/768/1440 in light and dark saved under `e2e/screenshots/`
  (gitignored) for review, and a perf check at 2,000 items. See `playwright-wsl` skill notes in the
  kanban e2e README for running Playwright on this WSL box.
- Keep `pack-gadget` tests green; rebuild and pack (`node scripts/pack-gadget.mjs --formats ../../formats`).

## Docs

Rewrite `src/README.md` for people and the agent (setup, views, WQL reference, shortcuts,
accessibility notes, programmatic use). The Insights brief will extend it with SKILL.md.

## Rules

- Work in your git worktree on your own branch; commit in coherent steps with messages ending
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push or deploy.
- Build against the 010 contract in brief-service.md using the fake; the real migration is being
  built in parallel. Tolerate absent fields.
- Before reporting: `pnpm exec vitest run` in the package, Playwright harness e2e, typecheck
  (`// @ts-check` everywhere, `tsc` if configured), pack. Report: what shipped vs the list above,
  anything deferred and why, test counts, perf numbers, and screenshot paths.
