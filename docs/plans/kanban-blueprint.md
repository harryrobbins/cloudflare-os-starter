# Plan: Kanban board blueprint (Trello / Jira)

Part of the [master plan](collaborative-blueprints.md). Build this one first: it needs nothing the platform does not already give, and it proves the whole draft, share, promote pipeline.

**Status: built and deployed (2026-09-16).** The source is [`packages/blueprint-kanban`](../../packages/blueprint-kanban/README.md). It ships as the bundled format `format.board` on cfos.surprisingly.ltd: revision 2 is deployed; revision 5, built during the [whiteboard](whiteboard-blueprint.md) work, awaits the next deploy. It disposes subscriber stubs (the production "RPC stub was not disposed properly" warning), makes request ids unguessable with replay records matched per sender, and rebases conflicts on the newest card state. How it was built, and every departure from the original plan, is recorded in the [delivery plan](kanban-delivery.md). This page now describes the board as built.

**The authoritative RPC and storage reference** is the gadget's own [`src/README.md`](../../packages/blueprint-kanban/src/README.md). Where this page and that file disagree, the file wins.

Reference patterns: the Sheets server in [`../research/bundled-blueprints/workspace-sheets.server.js`](../research/bundled-blueprints/workspace-sheets.server.js), summarised in [bundled-blueprint-sync-patterns.md](../research/bundled-blueprint-sync-patterns.md).

## Scope

v1, all delivered:

- A board of ordered columns. Cards have a title, a Markdown-ish plain-text description, labels, an assignee name, a due date, a checklist and an append-only comment thread.
- Drag cards between and within columns, and drag columns to reorder them. There are keyboard equivalents: a "Move to" control in the card panel, Alt+Arrow on a focused card, and Move left/right in the column menu.
- A card detail panel, and an activity panel with undo.
- Filter by label or assignee; search by title.
- **Live sync.** Card and column changes appear in every open browser. Presence shows who has the board open, which card each person has open, and a ghost of any card being dragged.
- **AI-usable.** The agent can list, find, create, move, edit and delete cards, and add columns, from chat.
- **Exports.** A server-side CSV of all cards, plus browser-rendered HTML and PDF of a static, expanded board.

Not in v1: swimlanes, WIP limits, sprints, story points, attachments (gadgets have no file storage), notifications (no outbound network), cross-board links.

## Data model

Stored in the gadget's Durable Object storage, one key per card and per comment:

```
"meta"                              -> { schemaVersion, revision, title, columnOrder: [colId], columns: { colId: { id, name, version, collapsed } }, lastModified }
"labels"                            -> { labelId: { id, name, color } }
"card:<cardId>"                     -> { id, columnId, order, title, description, labels: [], assignee, due, checklist: [{id, text, done}], version, createdAt, updatedAt, createdBy }
"comment:<cardId>:<13-digit ms>:<commentId>" -> { id, cardId, author, text, at }
"history"                           -> [ { id, at, by, summary, inverse } ]   (bounded, newest last)
"requests"                          -> [ { requestId, revision, status, conflicts, errors } ]  (idempotency records)
```

Why not the originally planned `cards:<colId>` layout: a full column would exceed the per-value size limit, and one key per card makes a move a single write. Keys are listed by prefix (`card:`, `comment:<cardId>:`).

- **Order.** `order` is a fractional base-62 key (`src/shared/order.js`), so a move is one card write; ties break on id.
- **Ids.** Ids are a one-letter prefix plus 8 hex digits (`c_`, `k_`, `l_`, `i_`, `m_`, `h_`). The client generates ids so that creates can be optimistic; the server validates every id.
- **Schema version.** `schemaVersion` plus the `migrate(meta)` hook in `src/core/board.js` are how later code upgrades existing boards.

All board rules live in `src/core/` behind a `Repository` interface (`src/core/repository.js`). The Durable Object adapter is `src/server/do-repository.js`. That seam is where a Jira, Grist, Git or database backend would plug in. Gadgets have no network access, so any such backend has to go through a Gatekeeper binding.

## Concurrency policy

- **Cards: per-card version.** Every card op carries `baseVersion`. A stale write returns a conflict with the authoritative card, or `null` if the card was deleted.
  - Moves and deletes are retried automatically, up to 5 times, while only other fields changed.
  - Checklist-only edits merge item by item.
  - A content edit is rebased field by field. It becomes a "someone else changed this card" banner only when the same field was changed.
  - Comparisons run after the server's cleaning, so trimming never causes a false conflict.
- **Columns: per-column version** for rename and delete; last-writer-wins for order and `collapsed`.
- **Comments are append-only**, so they have no versions and cannot conflict.
- **Moves across columns** are a single card write, and all ops in a request commit atomically.
- **Idempotent requests.** Each client request carries a `requestId`. A request replayed after a lost response or a server restart returns the recorded outcome and is not applied twice.
- A request cannot delete a card and recreate the same id.

## Server RPC surface

Summary; full detail is in the gadget README.

```
getBoard()                                            -> BoardSnapshot
applyOperation({senderId, by, requestId, cardOps?, columnOps?, labelOps?, structure?})
                                                      -> {status, revision, upserts, deletes, moved, structure, labels, history, conflicts, errors, duplicate?}
undo({senderId, by, historyId, requestId})            -> OperationResult
addComment({senderId, cardId, author, text})          -> Comment
getComments(cardId) / getHistory(limit)
subscribe(callback, {clientId, name, color, session}) -> BoardSnapshot + session
updatePresence({clientId, session, name, color, openCardId, dragCardId, hoverColumnId}) -> {known, revision}
leavePresence(clientId, session)

# Convenience methods for the agent (columns and labels by id or name; versions read for you)
findCards({column, label, assignee, text}) / addCards({cards, by}) / updateCard({cardId, fields, by})
moveCard({cardId, toColumn, position, by}) / deleteCard({cardId, by}) / addColumn({name, index, by})
```

Broadcasts reach each subscriber as `callback.operation(event)`, where `event.type` is `"operation"`, `"comment"` or `"snapshot"` and carries `senderId` for echo suppression. Presence goes to `callback.presence(event)` with `join`, `update` or `leave`.

- **Sessions.** The session token stops anyone who only knows a `clientId` from taking over that subscription or its presence.
- **Heartbeat.** `updatePresence` doubles as the heartbeat. `known: false` means the server restarted, and a `revision` ahead of the client's means it missed events. Either way the client re-subscribes.

## Client architecture

Plain DOM in one bundled `client.js`, built with esbuild from `src/client/`:

- **Store** (`src/client/sync/store.js`, contract in `store-contract.js`). It holds server state plus pending local ops, applies changes optimistically, and sends one request at a time, with coalescing. Replays keep their original base version and `requestId`. The store handles conflict rebase, presence (4 s heartbeat, 12 s stale expiry) and re-subscribe with backoff.
- **UI** (`src/client/ui/`). It re-renders narrowly per change, reusing card elements so remote updates never clobber a field being typed in. It also provides:
  - pointer-event drag and drop;
  - the card panel, with 400 ms debounced saves and the conflict banner;
  - activity with undo, filters, and a phone layout of one column at a time with tabs;
  - a static export view;
  - a live region for remote changes, focus restoration, and inert backgrounds behind dialogs.
- **Identity.** A name prompt on first load. The name is kept in `window.name`, which survives the frame reloading itself (below) and is the only storage the iframe has. When viewer identity lands, the viewer built in `src/client/main.js` is the place to swap in a real one.

What only the real platform showed:

- **Globals.** `gadget` and `RpcTarget` are module-level variables in the prefix the platform prepends, not globals.
- **No forms.** The sandbox has no `allow-forms`, so there are no `<form>` elements; buttons and Enter handlers only.
- **Stale connection after a code edit.** After an edit to `server.js`, the iframe's `gadget` stub fails for good; neither `onRpcBroken` nor `[Symbol.dispose]` fires. The store reports this as unrecoverable, and `main.js` reloads the frame (at most 3 times a minute). Changes not yet sent are lost; the in-app README says so.

## Server hardening (as built)

- **Caps** (see `LIMITS` in `src/shared/protocol.js`):

  | Item | Cap |
  | --- | --- |
  | Columns | 50 |
  | Cards | 2,000 |
  | Labels | 50 (20 per card) |
  | Description | 10,000 characters |
  | Checklist | 50 items, 200 characters each |
  | Comments per card | 200, and at most 256 KiB |
  | History | 200 entries, at most 100 KiB |
  | Ops per request | 500 |
  | Board budget | 8 MiB of cards in total |

- **Column delete.** Refused above 200 cards or 5,000 comments, so the cascade fits in one transaction.
- **Validation.** Every id is checked against its pattern. Unknown keys are stripped. Label colours must be hex. Text is cleaned of control characters and truncated. CSV fields are guarded against formula injection.
- **Atomic writes.** One transaction per request, with the idempotency record in the same commit. A failed commit drops cached state, and a throwing op cannot stall the mutation queue.
- **Hub** (`src/core/hub.js`):
  - Session-guarded subscribe, presence and leave.
  - At most 200 subscribers.
  - A subscriber is dropped after 500 unacknowledged deliveries or 30 s behind.
  - Identical presence updates within 100 ms are not fanned out.
  - Dead subscribers are detected when a delivery fails, because `onRpcBroken` is not implemented by the runtime.
  - Every kept callback stub is disposed when its entry is replaced, left or dropped (from revision 3).
- **Echo suppression** by `senderId`.
- **Undo inverses** are kept for card create, edit, move and delete, and for column rename and move. Inverses larger than 4 KiB are not kept.

## Agent brief

The board was built in the repo rather than drafted from this brief. The brief is kept to run the platform's own vibe-coding against the same spec as a comparison:

> Build a Trello-style kanban board gadget. Columns hold cards; cards have a title, description, labels, an assignee name, a due date and a checklist. Cards and columns can be dragged to reorder or move. Clicking a card opens a side panel with its fields and an append-only comment thread. Multiple people use the same board at once: changes must appear live in every open browser, and I want to see who has the board open and which card each person is looking at. Store everything in Durable Object storage using one key per card and per comment, with a per-card version number so two people editing the same card get a conflict instead of a silent overwrite. Expose `getBoard()` and `applyOperation()` RPCs so an agent can create and move cards from chat, and document them in README.md. Provide a CSV export of all cards. Use pointer events for drag and drop. Make it work on phones.

Then append the collaboration-pattern sentence from the master plan.

## Tests

The two-browser tests from the original plan are automated. Three suites cover them:

- **Harness:** `e2e/harness.test.mjs`, 19 tests, runs the real client over the real core in several panes.
- **Local platform:** `e2e/platform.test.mjs`, 11 tests, runs against a local Cloudflare OS instance.
- **Unit:** node and workerd, plus a real-core network fuzz test.

| # | Test | Automated in |
| --- | --- | --- |
| 1 | A creates a card; B sees it within a second | harness 1, platform T1 (~160 ms) |
| 2 | A and B drag different cards at once; both land | harness 2, platform T2 |
| 3 | Same card title edited by both; second saver gets the banner | harness 3, platform T3 |
| 4 | A opens a card, B sees the ring; A's tab dies, the ring goes within 15 s | harness 4, platform T4 (~1–4 s) |
| 5 | B at `use` role can do all of this but has no code editor | platform T5 |
| 6 | A edits `server.js`; B recovers without a manual reload | harness 6 and 9b, platform T6 (frame self-reload, ~4.5 s) |
| 7 | Agent chat: "add three cards to Backlog for onboarding tasks" | **manual, on production** (needs a model) |
| 8 | Export CSV and HTML | harness 8, platform T8 |

Still to do on production: tests 1–6 in two real browsers with two Access identities, and test 7.

## Promotion

Shipped as a bundled format from [`formats/board.json`](../../formats/board.json): `blueprintId` `format.board` (never change it), and `output` `{ id: "board", noun: "Board", plural: "Boards", icon: "kanban" }`. `pnpm --filter blueprint-kanban pack:gadget` rebuilds the archive and bumps `revision`.

## Follow-ups after v1

- WIP limits per column (one number in column meta, enforced only in the client).
- Swimlanes by label or assignee (client-side grouping, no model change).
- Bulk import from CSV (an `addCards` batch from a parsed file).
- With viewer identity: real assignees, an "assigned to me" filter, and read-only mode for `use` role.
- A second storage backend behind the `Repository` interface, through a Gatekeeper.
- Publish a blueprint with a screenshot, so the board can be featured in `/admin`.
