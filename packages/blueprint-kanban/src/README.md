# Board

A live, shared kanban board. Columns hold cards; cards have a title, description, labels, an assignee, a due date, a checklist and a comment thread. Everyone who has the board open sees changes as they happen and can see who else is here and which card they have open.

This gadget is built from `packages/blueprint-kanban` in the deployment's starter repository. **Edits made here in the code editor are not carried back to that source.** To change the board for everyone, change the source and ship a new format revision.

## Using the board

- **Add a card** with the **+ Add card** button at the foot of a column. Click a card to open its panel.
- **Move cards** by dragging them within or between columns. **Reorder columns** by dragging a column header.
- **The card panel** saves as you type. If someone else changed the same field first, a banner shows their version and lets you keep yours or take theirs.
- **Filter** by label or assignee, or search titles, from the toolbar.
- **Activity** lists recent changes; recent moves, edits, creations and deletions can be undone from there.
- **Presence**: avatars in the header show who is here; a coloured ring marks the card each person has open.
- **Export**: CSV of all cards, or HTML/PDF of the board, from the gadget's export menu.

## Programmatic use

Call these from `executeCode` through the gadget's binding (for example `env.Board`). All methods are on the `Gadget` Durable Object. Read the board with `getBoard()` before writing, so you have real ids.

**Change the board through these methods, never by editing this gadget's code.**

### Convenience methods (prefer these from chat)

Columns and labels may be given by id or by name (case-insensitive). Unknown label names are ignored. Each of these methods reads the current card versions itself, so it never conflicts.

```js
// Read
const board = await env.Board.getBoard();
// board.columnOrder: ["k_1a2b3c4d", ...]; board.columns[id].name; board.cards[id]: Card; board.labels[id]: Label

const cards = await env.Board.findCards({ column: "In progress", label: "Bug", assignee: "Sam", text: "login" });
// every filter optional; text matches title and description, case-insensitive

// Write
await env.Board.addCards({
  by: "Assistant",
  cards: [
    { column: "Backlog", title: "Set up laptop", description: "Order hardware", labels: ["Chore"],
      assignee: "Sam", due: "2026-10-01", checklist: ["Order", "Image", "Hand over"] },
  ],
}); // -> { created: Card[], errors: OpError[] }

await env.Board.updateCard({ cardId: "c_1a2b3c4d", fields: { title: "New title", due: null }, by: "Assistant" });
await env.Board.moveCard({ cardId: "c_1a2b3c4d", toColumn: "Done", position: "top", by: "Assistant" });
// position: "top" | "bottom" (default) | a 0-based index within the target column
await env.Board.deleteCard({ cardId: "c_1a2b3c4d", by: "Assistant" });
await env.Board.addColumn({ name: "Review", index: 2, by: "Assistant" }); // -> { column, errors }
await env.Board.addComment({ cardId: "c_1a2b3c4d", author: "Assistant", text: "Done in PR 42" });
```

These convenience methods return an `OperationResult`, except where the comment beside a call says otherwise.

### Core methods

| Method | Returns |
| --- | --- |
| `getBoard()` | `BoardSnapshot` `{schemaVersion, revision, title, columnOrder, columns, cards, labels, lastModified}` |
| `applyOperation({senderId?, by?, requestId?, cardOps?, columnOps?, labelOps?, structure?})` | `OperationResult` |
| `addComment({senderId?, cardId, author, text})` | `Comment` |
| `getComments(cardId)` | `Comment[]`, oldest first |
| `getHistory(limit = 50)` | `HistoryEntry[]`, oldest first |
| `undo({senderId?, by?, historyId, requestId?})` | `OperationResult` |
| `subscribe(callback, {clientId, name, color, session?})` | `BoardSnapshot` plus `session`; used by the UI. Throws `clientId in use` when a live subscription for `clientId` has a different session, and `board is full` beyond 200 subscribers |
| `updatePresence({clientId, session, name, color, openCardId, dragCardId, hoverColumnId})` | `{known, revision}`; used by the UI as its heartbeat. `known: false` means this server instance has no subscription for the client (it restarted) or the session does not match, so the client re-subscribes; a `revision` ahead of the client's means it missed events and resyncs |
| `leavePresence(clientId, session)` | nothing; used by the UI. Ignored unless `session` matches |

**Sessions**: `subscribe` returns a random 128-bit `session` token (32 lowercase hex digits) that is never broadcast. Pass it to `updatePresence` and `leavePresence`, and to `subscribe` when re-subscribing, so that nobody who only knows your `clientId` can take over your subscription or presence. When the server has no subscription for the `clientId` (for example after a restart), a well-formed `session` passed to `subscribe` is kept, so the token stays stable.

**Idempotent requests**: give `applyOperation` or `undo` a `requestId` (1 to 64 characters from `A-Z a-z 0-9 : _ -`; anything else is ignored) to make retries safe. The board records the outcome of the last 500 such requests (at most 64 KiB) in the same atomic write as their changes, including requests that changed nothing. A request whose `requestId` is already recorded is not applied again: it returns the recorded `status`, `conflicts` (with `current` read now) and `errors`, the current `revision`, empty `upserts`/`deletes`/`moved`, and `duplicate: true`, and nothing is broadcast. Very long error or conflict lists are shortened in the record.

**Ids** are a one-letter prefix, an underscore and 8 lowercase hex digits:

| Prefix | Kind |
| --- | --- |
| `c_` | card |
| `k_` | column |
| `l_` | label |
| `i_` | checklist item |
| `m_` | comment |
| `h_` | history entry |

New ids may be chosen by the caller, for example `"c_" + crypto.randomUUID().slice(0, 8)`.

**Card fields**: `id, columnId, order, title, description, labels (label ids), assignee, due ("YYYY-MM-DD" or null), checklist ([{id, text, done}]), version, createdAt, updatedAt, createdBy`.

`order` is a fractional ordering key: cards sort by `order`, then by `id`. Keys are base-62 strings such as `"a0"`, `"a1"` and `"a0V"`. Omit `order` to append a card at the end of its column.

**cardOps**: `{op, cardId, baseVersion, ...}`. `baseVersion` is the card's `version` as you last read it, or `0` when creating.

- `{op: "upsert", cardId, columnId, baseVersion: 0, card: {title, ...}}` creates a card.
- `{op: "upsert", cardId, baseVersion, card: {fieldsToChange}}` patches only the listed fields.
- `{op: "move", cardId, baseVersion, toColumnId, order?}` moves a card.
- `{op: "delete", cardId, baseVersion}` deletes a card and its comments.

A request cannot delete a card and then create a card with the same id: the create fails with `exists`.

**columnOps**:

- `{op: "upsert", columnId, baseVersion: 0, column: {name}, index?}` creates a column.
- `{op: "upsert", columnId, baseVersion, column: {name?, collapsed?}}` renames it (version-checked) or collapses it (no version check).
- `{op: "move", columnId, index}` reorders it.
- `{op: "delete", columnId, baseVersion}` deletes it together with its cards and their comments. It fails with `limit` when the column holds more than 200 cards, or when the request would delete more than 5,000 comments in total; move or delete cards first.

**labelOps**:

- `{op: "upsert", labelId, label: {name, color: "#rrggbb"}}`
- `{op: "delete", labelId}`

**structure**: `{title}` renames the board.

**OperationResult**: `{status, revision, upserts, deletes, moved, structure, labels, history, conflicts, errors, duplicate?}`.

- Ops apply independently: valid ops are saved even if others in the same request fail.
- `status` is `"applied"`, `"conflict"` (at least one op was rejected because its `baseVersion` was stale; `conflicts[i].current` holds the authoritative value) or `"unchanged"`.
- `errors` lists invalid ops, each as `{kind, index, code, message}`. The codes are `invalid_id`, `unknown_card`, `unknown_column`, `exists`, `limit` and `invalid_op`.

**Limits**:

| Item | Limit |
| --- | --- |
| Columns | 50 |
| Cards | 2,000 |
| All cards together | 8 MiB stored |
| Labels | 50 |
| Labels per card | 20 |
| Checklist items | 50 |
| Checklist item | 200 characters |
| Comments per card | 200, and 256 KiB stored |
| Card title | 500 characters |
| Description | 10,000 characters |
| Comment | 2,000 characters |
| History | 200 entries |
| Cards removed with one column delete | 200 |
| Comments removed by one request | 5,000 |
| Live subscribers | 200 |
| Remembered request ids | 500 (64 KiB) |

Longer text is truncated rather than rejected. Stored size is measured conservatively: the UTF-8 bytes of the JSON, or 2 bytes per character when the text has characters beyond Latin-1. When the cards would exceed 8 MiB, creating a card, an edit that makes a card larger and undoing a delete fail with `limit`; edits that make a card smaller, moves and deletes always work. `addComment` throws once a card reaches its comment count or size limit.

### Storage layout

The board is stored in this gadget's Durable Object storage:

| Key | Holds |
| --- | --- |
| `meta` | `{schemaVersion, revision, title, columnOrder, columns, lastModified}` |
| `labels` | `{labelId: Label}` |
| `card:<cardId>` | one card |
| `comment:<cardId>:<13-digit ms>:<commentId>` | one comment |
| `history` | bounded list of recent changes |
| `requests` | bounded list of recent `requestId` outcomes `[{requestId, revision, status, conflicts: [{kind, id}], errors}]` |

### Live updates

`subscribe(callback, client)` keeps the callback and calls `callback.operation(event)` with `{type: "operation" | "comment" | "snapshot", ...}` and `callback.presence(event)` with `{type: "join" | "update" | "leave", clientId, name, color, openCardId, dragCardId, hoverColumnId, at}`. Events carry the `senderId` of the request that caused them so the originating client can skip its own echo.

A subscriber that falls behind is dropped, and a `leave` is broadcast for it: this happens when it has more than 500 deliveries unacknowledged, or its oldest unacknowledged delivery is over 30 seconds old. Its next `updatePresence` returns `known: false`, so it re-subscribes and gets a fresh snapshot. Presence updates identical to the previous one and less than 100 ms after it are accepted but not broadcast.
