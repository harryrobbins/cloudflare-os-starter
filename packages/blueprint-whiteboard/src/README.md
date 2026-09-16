# Whiteboard

A live, shared whiteboard: an infinite canvas with sticky notes, shapes, text, connectors, pen strokes and frames. Everyone who has the whiteboard open sees changes as they happen, sees each other's cursors, and sees a ghost of anything someone is dragging or drawing before they let go.

This gadget is built from `packages/blueprint-whiteboard` in the deployment's starter repository. **Edits made here in the code editor are not carried back to that source.** To change the whiteboard for everyone, change the source and ship a new format revision.

## Using the whiteboard

Everyone with the whiteboard open is shown at the top right. When you first open it, you are asked for a name and colour so others can recognise your cursor; nothing is stored, so you are asked again on the next visit.

- **Tools** (left toolbar; a bottom bar on phones): Select (`V`), Hand to pan (`H`), Sticky note (`N`), Rectangle (`R`), Ellipse (`O`), Text (`T`), Frame (`F`), Connector (`C`) and Pen (`P`). Click on the canvas to create an object at its default size, or drag to size it. After one object the tool returns to Select (the Pen stays on for more strokes); double-click a tool button to keep it on until you pick another. A text label left empty is removed when you finish editing.
- **Add without dragging**: the **+** button (or `A`) opens a menu that adds a sticky note, rectangle, ellipse, text or frame in the middle of the view. Sticky notes and text open for typing straight away.
- **Select and move**: click an object to select it, Shift-click to add to the selection, or drag a box around several on empty canvas (a frame is picked only when the box encloses all of it). Drag to move; use the handles to resize and rotate. Arrow keys move the selection by 1 (Shift: 10), and the style bar's **Move** buttons move it by 10.
- **Edit text**: double-click an object, press `Enter`, or use **Edit text** in the style bar. Changes are saved when you click away, press `Escape`, or press `Ctrl+Enter` (`⌘+Enter` on a Mac). In frame names and connector labels, `Enter` saves too.
- **Style bar**: appears at the top when something is selected (a bottom sheet on phones). Use it to set the fill, line and text colours, line width, text size and alignment. For connectors, it also sets straight or elbow lines and arrowheads. It can also bring objects to the front or send them to the back, duplicate or delete them. Each change applies to every selected object it fits.
- **Frames** are named regions. An object whose centre you drop inside a frame belongs to it, and moving or duplicating the frame brings its members along. Deleting a frame leaves its members where they are.
- **Connectors**: with the Connector tool, drag from one object to another. The line follows both objects as they move, and deleting either object deletes the connector.
- **Pan and zoom**: drag with the Hand tool or hold `Space` and drag; `Shift`+scroll (or a sideways trackpad swipe) pans sideways. Scrolling or pinching zooms about the pointer. The controls at the bottom right zoom out, reset to 100% (click the percentage), zoom in and fit everything (`Shift+1`). Click or drag in the minimap to jump there; the minimap shows everyone's view in their colour.
- **Follow someone**: click a person's avatar at the top right to follow their view; a "Following" chip appears. Click **Stop**, or pan yourself, to stop following.
- **Live collaboration**: you see other people's cursors with their names, a see-through ghost of anything they are dragging, and pen strokes as they are drawn. Their changes appear when they let go. If two people move the same object at once, both moves are kept. If two people change the same text or colour at once, the first saved change wins and the object flashes for the other person.
- **Undo**: `Ctrl+Z` / `Ctrl+Shift+Z` (`⌘` on a Mac) or the buttons at the bottom left undo and redo your own recent changes. The **Activity** panel lists recent changes by everyone and can undo them, including your changes from before a reload.
- **Objects list** (list button or `Shift+O`): every object with its text, filterable. **Show** pans to an object, **Select** selects it and moves focus to the style bar, so the whole board can be used with a keyboard and screen reader. Changes by others are announced to screen readers.
- **Keyboard**: with the canvas focused, `Delete` removes the selection, `Ctrl+D` duplicates, `Ctrl+A` selects all, `]` and `[` bring to front and send to back, `+` and `-` zoom, `Shift+0` resets to 100%, and `Escape` cancels a gesture or clears the selection. Right-click an object, or press the context-menu key, for its actions as a menu; the same actions are in the style bar.
- **Phones and tablets**: drag with one finger to select and move, or to draw with the Pen tool. Two fingers pan and pinch to zoom. Press and hold an object for its actions menu.
- **Export**: the gadget's HTML and PDF export draws the board fitted to the page, without the toolbars. `exportSvg()` (below) returns the same drawing as an SVG file.

- **Connection**: if the gadget's code is changed while the whiteboard is open, it reloads itself to reconnect (your name and colour are kept). Changes that had not reached the server when the connection dropped are lost, so check your last edit. If it has to reload more than 3 times in a minute it stops and asks you to reload the page.

## Programmatic use

Call these from `executeCode` through the gadget's binding (for example `env.Whiteboard`). All methods are on the `Gadget` Durable Object.

**Change the whiteboard through these methods, never by editing this gadget's code.**

Coordinates are world units: x grows to the right, y grows downwards, and a default sticky note is 200 by 200. The visible area depends on each viewer's zoom, so place new content near existing content (use `getBoard()` or `findObjects()` first) or pass `at`.

### Convenience methods (prefer these from chat)

Frames may be given by id or by name (case-insensitive). Colours may be a name (`yellow`, `orange`, `red`, `pink`, `purple`, `blue`, `teal`, `green`, `gray`, `white`, `black`) or `"#rrggbb"`. These methods read current versions themselves, so they never conflict.

```js
// Read
const board = await env.Whiteboard.getBoard();
// board.objects[id]: WhiteboardObject; board.title; board.revision

const stickies = await env.Whiteboard.findObjects({ type: "sticky", text: "q4", frame: "Planning" });
// every filter optional: type, text (case-insensitive substring), frame (id or name),
// within: {x, y, w, h} (objects whose bounds intersect it). Returns objects bottom to top.

const { frame, objects } = await env.Whiteboard.getFrame("Planning"); // null when there is no such frame

// Write
await env.Whiteboard.addStickies({
  by: "Assistant",
  stickies: ["Hire two engineers", { text: "Ship mobile app", color: "green" }],
  frame: "Planning",        // optional: place inside this frame and make them members
  at: { x: 0, y: 0 },       // optional top-left of the grid; default: inside the frame, or right of existing content
  columns: 4,               // optional, default ceil(sqrt(n))
  gap: 40,                  // optional, default 40
}); // -> { created: WhiteboardObject[], errors: OpError[] }

await env.Whiteboard.addObjects({
  by: "Assistant",
  objects: [
    { type: "rect", x: 0, y: 400, w: 300, h: 120, text: "Decision", color: "blue" },
    { type: "text", x: 0, y: -80, text: "Q4 priorities", style: { fontSize: 48 } },
  ],
}); // -> { created, errors }

await env.Whiteboard.arrangeGrid({ ids: stickies.map((s) => s.id), columns: 3, gap: 40, at: { x: 0, y: 0 }, by: "Assistant" });
await env.Whiteboard.moveObjects({ ids: ["o_1a2b3c4d5e6f"], dx: 100, dy: 0, by: "Assistant" });
await env.Whiteboard.updateObjects({
  by: "Assistant",
  updates: [{ id: "o_1a2b3c4d5e6f", fields: { text: "Renamed", color: "pink" } }],
});
await env.Whiteboard.deleteObjects({ ids: ["o_1a2b3c4d5e6f"], by: "Assistant" });

await env.Whiteboard.addFrame({ name: "Themes", contains: stickies.map((s) => s.id), by: "Assistant" });
// with `contains` and no geometry, the frame is sized around those objects; -> { frame, result }

await env.Whiteboard.connectObjects({ from: "o_1a2b3c4d5e6f", to: "o_6f5e4d3c2b1a", label: "blocks", routing: "elbow", by: "Assistant" });
// -> { connector, errors }; routing "straight" (default) or "elbow"; arrow "end" (default), "both" or "none"

const svg = await env.Whiteboard.exportSvg({ frame: "Themes" }); // whole board when frame is omitted
```

`arrangeGrid`, `moveObjects`, `updateObjects` and `deleteObjects` return an `OperationResult`. In `updateObjects`, `fields` is a patch (see "Object fields"); `color` is a shortcut that sets `style.fill` for stickies, shapes, text and frames, and `style.stroke` for pens and connectors.

### Core methods

| Method | Returns |
| --- | --- |
| `getBoard()` | `BoardSnapshot` `{schemaVersion, revision, title, background, objects, lastModified}` |
| `applyOperation({senderId?, by?, requestId?, objectOps?, structure?})` | `OperationResult` |
| `getHistory(limit = 50)` | `HistoryEntry[]`, oldest first |
| `undo({senderId?, by?, historyId?, requestId?})` | `OperationResult`. Without `historyId`, undoes the most recent undoable change made by `by` |
| `exportSvg({frame?})` | SVG document as a string |
| `subscribe(callback, {clientId, name, color, session?})` | `BoardSnapshot` plus `session`; used by the UI. Throws `clientId in use` when a live subscription for `clientId` has a different session, and `board is full` beyond 200 subscribers |
| `updatePresence({clientId, session, name?, color?, cursor?, viewport?, selection?, transforms?, stroke?, editingId?})` | `{known, revision}`; used by the UI, also as its heartbeat. `known: false` means this server instance has no subscription for the client (it restarted) or the session does not match, so the client re-subscribes |
| `leavePresence(clientId, session)` | nothing; used by the UI. Ignored unless `session` matches |

**Ids** are a one-letter prefix, an underscore and 12 lowercase hex digits: `o_` for objects, `h_` for history entries. New object ids may be chosen by the caller, for example `"o_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12)`.

**Object fields**: `id, type, x, y, w, h, rot, z, frameId, text, style, version, createdAt, updatedAt, createdBy`, plus `points` for pens and `from, to, fromSide, toSide, routing` for connectors.

| Type | Notes |
| --- | --- |
| `sticky`, `rect`, `ellipse` | `text` is the content; may rotate |
| `text` | a text label; may rotate |
| `frame` | a named region (`text` is the name); drawn below everything else; cannot rotate or belong to another frame |
| `pen` | a freehand stroke: `points` is `[x0, y0, x1, y1, ...]` normalised to the box (each 0 to 1); `style.stroke` and `style.strokeWidth` draw it |
| `connector` | a line from object `from` to object `to` (neither may be a connector); `fromSide`/`toSide` are `auto`, `top`, `right`, `bottom` or `left`; `routing` is `straight` or `elbow`; `text` is an optional label; `style.arrowStart`/`arrowEnd` are `none` or `arrow`. Its box is ignored |

- **Geometry**: `(x, y)` is the top-left of the unrotated box; `rot` is degrees clockwise about its centre.
- **style**: `{fill, stroke, strokeWidth, textColor, fontSize, align, arrowStart, arrowEnd}`. Colours are `"#rrggbb"` (`fill` and `stroke` also accept `"none"`); `align` is `left`, `center` or `right`.
- **z** is a fractional ordering key (base-62 strings such as `"a0"`, `"a1"`, `"a0V"`); objects stack by `z` then `id`, with frames always below. Omit `z` when creating to put the object on top.
- **frameId** names the frame an object belongs to. Moving a frame does not move its members by itself: move them in the same request. Deleting a frame leaves its members where they are; their `frameId` is cleared the next time each is written.
- **Deleting an object deletes connectors attached to it** in the same request; they appear in `deletes`.

**objectOps** are applied in order, each seeing the ones before it:

- `{op: "create", object: {id, type, ...fields}}` creates an object. Missing fields take defaults. Pens need `points`; connectors need `from` and `to`.
- `{op: "update", id, baseVersion, patch: {fieldsToChange}}` changes only the listed fields; `style` merges key by key; `type` cannot change.
- `{op: "delete", id, baseVersion}` deletes an object and its connectors.

`baseVersion` is the object's `version` as you last read it.

**structure**: `{title?, background?}`, where `background` is `dots`, `grid` or `plain`. Last writer wins.

**OperationResult**: `{status, revision, upserts, deletes, structure, history, conflicts, errors, duplicate?}`.

- Ops apply independently: valid ops are saved even if others in the same request fail.
- `status` is `"applied"`, `"conflict"` (at least one op was rejected because its `baseVersion` was stale; `conflicts[i]` is `{id, current}` with the authoritative object, or `null` if it was deleted) or `"unchanged"`.
- `upserts` are the created or changed objects in their final state; `deletes` are removed ids.
- `errors` lists invalid ops as `{index, code, message}`. The codes are `invalid_id`, `invalid_op`, `unknown_object`, `exists`, `invalid_ref` (a connector endpoint or `frameId` that does not name a suitable object) and `limit`.

**Idempotent requests**: give `applyOperation` or `undo` a `requestId` (1 to 64 characters from `A-Z a-z 0-9 : _ -`) to make retries safe. A request whose `requestId` is already recorded is not applied again: it returns the recorded `status`, `conflicts` (with `current` read now) and `errors`, the current `revision`, empty `upserts` and `deletes`, and `duplicate: true`. The last 500 request ids are remembered.

**Limits**:

| Item | Limit |
| --- | --- |
| Objects | 5,000 |
| Frames | 50 |
| Members of one frame | 2,000 |
| Points in a pen stroke | 2,000 |
| Text in a sticky, shape or text label | 4,000 characters |
| Frame name | 80 characters |
| Connector label | 200 characters |
| One object | 64 KiB stored |
| All objects together | 8 MiB stored |
| Ops in one request | 1,000 |
| Objects changed by one request, cascaded connectors included | 2,000 |
| Coordinates | ±1,000,000 |
| Width and height | 1 to 100,000 |
| History | 200 entries |
| Live subscribers | 200 |

Longer text is truncated and out-of-range numbers are clamped rather than rejected. Stored size is measured conservatively: the UTF-8 bytes of the JSON, or 2 bytes per character when the text has characters beyond Latin-1.

### Storage layout

| Key | Holds |
| --- | --- |
| `meta` | `{schemaVersion, revision, title, background, lastModified}` |
| `obj:<id>` | one object |
| `history` | bounded list of recent changes, with the inverse used by `undo` |
| `requests` | bounded list of recent `requestId` outcomes |

### Live updates

`subscribe(callback, client)` keeps the callback and calls:

- `callback.operation(event)` with `{type: "operation", senderId, revision, upserts, deletes, structure, history, lastModified}` or `{type: "snapshot", board}`. `senderId` lets the originating client skip its own echo.
- `callback.presence(events)` with an **array** of `{type: "join" | "update", clientId, name, color, cursor, viewport, selection, transforms, stroke, editingId, at}` or `{type: "leave", clientId, at}`. Presence is never stored.
