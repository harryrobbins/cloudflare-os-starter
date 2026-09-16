# Plan: Kanban board blueprint (Trello / Jira)

Part of the [master plan](collaborative-blueprints.md). Build this one first: it needs nothing the platform does not already give, and it proves the whole draft, share, promote pipeline.

Execution order, agent orchestration and deployment are in the [delivery plan](kanban-delivery.md), which builds the board in this repo rather than in the Workshop editor.

Reference: the Sheets server in [`../research/bundled-blueprints/workspace-sheets.server.js`](../research/bundled-blueprints/workspace-sheets.server.js) and the pattern summary in [bundled-blueprint-sync-patterns.md](../research/bundled-blueprint-sync-patterns.md).

## Scope

v1:

- Board with ordered columns; cards with title, description (Markdown-ish plain text), labels, assignee name, due date, checklist.
- Drag cards between and within columns; drag columns to reorder.
- Card detail panel with comments (append-only) and activity.
- Filter by label or assignee; search by title.
- Live sync: card and column changes appear in every open browser; presence shows who has the board open and which card each person has open.
- AI-usable: the agent can list, create, move and edit cards from chat.
- Exports: CSV of cards; the platform's HTML/PDF export renders the board read-only.

Not in v1: swimlanes, WIP limits, sprints, story points, attachments (no file storage in gadgets), notifications (no outbound network), cross-board links.

## Data model

Stored in `ctx.storage` as a small number of keys, the way Sheets does, rather than one key per card. A board of a few thousand cards is well under the 128 KiB per-value limit if cards are split by column, so:

```
"meta"              -> { revision, title, columnOrder: [colId], columns: { colId: { id, name, version, collapsed } }, lastModified }
"cards:<colId>"     -> { cardId: { id, title, description, labels: [], assignee, due, checklist: [{id, text, done}], order, version, createdAt, updatedAt, createdBy } }
"comments:<cardId>" -> [ { id, author, text, at } ]
"history"           -> [ { at, by, summary, inverse? } ]   (bounded, newest last, 200 entries)
"labels"            -> { labelId: { id, name, color } }
```

`order` is a fractional string key (`"a0"`, `"a0V"`, ...) so a move is one card write, not a renumbering. Use a small LexoRank-style helper in `lib/order.js`; the agent can write it or copy one.

Ids: `crypto.randomUUID().slice(0, 8)` with a prefix (`c_`, `k_`), like Sheets.

## Concurrency policy

- **Cards: per-card version.** Every `cardOps` entry carries `baseVersion`. Server rejects a stale write with `conflict` and returns the authoritative card. The client rebases trivially for moves (re-apply the move against the new version) and shows a "someone else edited this card" banner for content edits, offering to overwrite or reload.
- **Columns: per-column version** for rename, last-writer-wins for `columnOrder` and `collapsed`.
- **Comments: append-only,** no versions, no conflicts.
- **Checklist items:** part of the card, so a card-level version. Two people ticking different items simultaneously will conflict; the client retries once automatically against the fresh version, which resolves it.
- **Moves across columns** are one operation with two writes (`delete from cards:A, insert into cards:B`) inside one `enqueueMutation`, so no client ever sees the card in both or neither.

## Server RPC surface

```
getBoard()                                    -> full snapshot {revision, meta, columns, cards, labels}
applyOperation({senderId, by, cardOps?, columnOps?, structure?, labelOps?})
                                              -> {status, revision, upserts, deletes, conflicts, moved}
addComment({cardId, author, text})            -> comment
getComments(cardId)                           -> [comment]
getHistory(limit)                             -> [entry]
subscribe(callback, {clientId, name, color})  -> snapshot
updatePresence({clientId, name, color, openCardId, hoverColumnId})
leavePresence(clientId)
```

`cardOps` entries: `{op: "upsert"|"delete"|"move", columnId, cardId, baseVersion, card?, toColumnId?, order?}`.

Broadcast event shape mirrors Sheets: `{type: "operation", senderId, revision, upserts: [{columnId, card}], deletes: [{columnId, cardId}], structure?, labels?}`. Presence events: `{type: "join"|"leave"|"cursor", clientId, name, color, openCardId, hoverColumnId}`.

Document all of this in the gadget's `README.md` under "Programmatic use", as Sheets does, because that README is what the agent reads before editing.

## Client architecture

Plain DOM, one file, following Sheets' structure (styles at top, model, renderers, event handlers, callbacks, init with top-level `await`).

- **Model** in memory: the snapshot from `subscribe`, mutated optimistically, re-rendered per column.
- **Rendering**: one `renderColumn(colId)` that rebuilds that column's DOM; `renderBoard()` for structure changes. Cards render from a template function; keep it cheap because remote operations re-render the affected columns.
- **Drag and drop**: pointer events, not the HTML5 DnD API (unreliable inside sandboxed iframes and on touch). While dragging, send `updatePresence` with the dragged card id so others see a ghost outline; commit with one `move` op on drop.
- **Card panel**: a side panel with fields that save on blur or after a 400 ms debounce, each save a single `upsert` with `baseVersion`.
- **Presence**: avatars in the header; a coloured ring on a card someone has open; a ghost where someone is dragging. Heartbeat 4 s, stale 12 s, exactly the Docs constants.
- **Re-subscribe**: `class Callbacks extends RpcTarget { ...; [Symbol.dispose]() { resubscribe(); } }` where `resubscribe` calls `gadget.subscribe` again, applies the fresh snapshot, and replays any unsent local ops.
- **Name prompt** on first load (until [viewer identity](collaborative-blueprints.md#phase-0-optional-but-recommended-viewer-identity) lands): a small dialog, stored only in memory.
- **Responsive**: columns scroll horizontally; on phones, one column at a time with a tab strip.
- **Export**: when `gadgetExportFormatId` is defined, render a static, expanded board (all card details visible) for the platform's HTML/PDF capture.

## Server hardening checklist

- Cap: 50 columns, 5,000 cards per board, 20 KiB description, 100 checklist items, 50 labels, 500 comments per card, 200 history entries.
- Validate ids against `/^[a-z]_[0-9a-f]{8}$/` and card refs against known columns.
- Strip unknown keys from cards; whitelist label colours as hex.
- `senderId` echo: the originating client ignores its own broadcast.
- All mutations through `enqueueMutation`.
- `broadcast` drops stubs that throw.
- History entries carry an `inverse` op where cheap (move, delete) to support board-level undo of the last few actions from the activity panel.

## Agent brief

Give this to the agent in step 1 of the common path:

> Build a Trello-style kanban board gadget. Columns hold cards; cards have a title, description, labels, an assignee name, a due date and a checklist. Cards and columns can be dragged to reorder or move. Clicking a card opens a side panel with its fields and an append-only comment thread. Multiple people use the same board at once: changes must appear live in every open browser, and I want to see who has the board open and which card each person is looking at. Store everything in Durable Object storage using a few keys (`meta`, `cards:<columnId>`, `comments:<cardId>`), with a per-card version number so two people editing the same card get a conflict instead of a silent overwrite. Expose `getBoard()` and `applyOperation()` RPCs so an agent can create and move cards from chat, and document them in README.md. Provide a CSV export of all cards. Use pointer events for drag and drop. Make it work on phones.

Then append the collaboration-pattern sentence from the master plan.

## Tests (two-browser session)

1. A creates a card, B sees it within a second without reload.
2. A and B drag different cards at once; both land correctly.
3. A and B edit the same card's title; the second saver gets the conflict banner with A's value.
4. A opens a card; B sees A's ring on it. A closes the tab; the ring disappears within 15 s.
5. B, as a `use`-role share-link collaborator, can do everything above but cannot open the code editor.
6. A edits `server.js` in the code editor (any no-op change); B's board reconnects and continues syncing without reload.
7. Agent chat: "add three cards to Backlog for onboarding tasks"; they appear live in both browsers.
8. Export CSV; open in a spreadsheet.

## Promotion

`output`: `{ id: "board", noun: "Board", plural: "Boards", icon: "kanban" }`. `kanban` is in the closed `OUTPUT_ICONS` set. Blueprint id if bundled: `format.board`.

## Follow-ups after v1

- WIP limits per column (one number in column meta, enforced in the client only).
- Swimlanes by label or assignee (client-side grouping, no model change).
- Bulk import from CSV via a `sheetReplacements`-style `replaceColumn` op.
- With viewer identity: real assignees, "assigned to me" filter, `use`-role read-only mode.
