# Whiteboard

A live, shared whiteboard: an infinite canvas with sticky notes, shapes, text, connectors, pen strokes and frames. Everyone who has the whiteboard open sees changes as they happen, sees each other's cursors, and sees a ghost of anything someone is dragging or drawing before they let go.

This gadget is built from `packages/blueprint-whiteboard` in the deployment's starter repository. **Edits made here in the code editor are not carried back to that source.** To change the whiteboard for everyone, change the source and ship a new format revision.

## Using the whiteboard

Everyone with the whiteboard open is shown at the top right, under their account's display name and a colour, so others can recognise their cursor. Nobody is asked for a name.

- **Tools** (left toolbar; a bottom bar on phones, where Add, Objects and Activity come first): Select (`V`), Hand to pan (`H`), Sticky note (`N`), Rectangle (`R`), Ellipse (`O`), Text (`T`), Frame (`F`), Connector (`C`) and Pen (`P`). Click on the canvas to create an object at its default size, or drag to size it. After one object the tool returns to Select (the Pen stays on for more strokes); double-click a tool button to keep it on until you pick another. New objects use the fill, line and text colours you last chose for that kind of object. A text label left empty is removed when you finish editing. The toolbar is one `Tab` stop: use the arrow keys to move between its buttons. When it does not fit, a shadow at its edge shows that it scrolls.
- **Add without dragging**: the **+** button (or `A`) opens a menu that adds a sticky note, rectangle, ellipse, text or frame in the middle of the view. Sticky notes and text open for typing straight away.
- **Icons and shapes**: **Icons and shapes…** in the Add menu (or `I`) opens the insert panel. Its **Icons & shapes** tab lists diagram shapes (flowchart and architecture: decision, start/end, document, database, cloud, queue, server, user and more) and a set of general icons (people, devices, files, actions, data, network, cloud and infrastructure, security, communication). Search by name or meaning ("db", "person"), or pick a category; your recently used icons are listed first. Click an icon, or press `Enter` on it, to add it in the middle of the view, or drag it onto the board to place it. In the panel, `↓` moves from the search field to the results, the arrow keys move between icons and `Escape` closes it. Shapes take a fill colour and hold text (double-click or `Enter` to type); icons keep their proportions and take the line colour, and a fill colour draws a tile behind them. Icons are part of the gadget, so they work offline and never load anything from the internet.
- **Emoji and symbols**: the panel's second tab, **Emoji & symbols** (or **Emoji and symbols…** in the Add menu, or `Ctrl+.` / `⌘+.`), lists every current emoji (Emoji 17.0, with their standard names and keywords) and useful symbols for diagrams: arrows, maths and logic, ticks and ballot boxes, stars and shapes, bullets, punctuation, box drawing, currency, Greek letters, superscripts and subscripts, and keyboard keys (`⌘ ⌥ ⇧ ⏎ ⌫`). Search by name or meaning ("smile", "tick", "implies"), pick a category, or pick from your recently used ones at the top. The hand menu beside the categories sets a skin tone for emoji that have one (default none); the panel remembers it, and the tab you used last, until you close the whiteboard. Click a character, press `Enter` on it, or drag it onto the board: while you are typing in a sticky note, shape, text, frame name or connector label it goes in at the text cursor (click one, or press `Ctrl+.` while typing, then `Enter` on your pick; `Escape` returns to your text); otherwise it is added as a large text object in the middle of the view (or where you drop it). The tabs are one `Tab` stop: the left and right arrow keys switch between them. Emoji are ordinary text drawn by each viewer's own emoji font, so they look a little different on Windows, macOS, Android and Linux; emoji a device cannot draw are left out of its list (the panel says how many), but still appear for others.
- **Select and move**: click an object to select it, Shift-click to add to the selection, or drag a box around several on empty canvas (a frame is picked only when the box encloses all of it). Drag to move; use the handles to resize and rotate. When an object is small on screen (zoomed far out), only its corner handles show, or none, and dragging anywhere on it moves it. Arrow keys move the selection by 1 (Shift: 10), and the style bar's **Move** buttons move it by 10.
- **Snapping and guides**: while you drag or resize, the selection snaps to the left, centre and right edges and the top, middle and bottom of nearby objects (a rotated object by the box around it), and a pink guide shows the line it snapped to. It never snaps to the objects being moved (such as a frame's members). On a board with the **grid** background it also snaps to the grid. The snap distance is the same on screen at every zoom. Hold `Alt` (`Option` on a Mac) while dragging to place freely; keyboard moves are always exact.
- **Align and distribute**: with two or more objects selected, the style bar's align buttons line up their left edges, horizontal centres, right edges, top edges, vertical middles or bottom edges; with three or more, **Distribute horizontally** and **Distribute vertically** space them evenly (the outermost two stay put). The same commands are under **Align or distribute…** in the actions menu (right-click, or the context-menu key / `Shift+F10`). A selected frame moves as one with its members. Each command is one change, so one undo reverses it.
- **Resize and rotate without dragging**: `Alt`+arrow keys make the selection wider or narrower (`Alt+→` / `Alt+←`) and taller or shorter (`Alt+↓` / `Alt+↑`) by 1 (Shift: 10), keeping its top-left corner in place. `.` rotates it 15° clockwise and `,` 15° anticlockwise (sticky notes, rectangles, ellipses and text). The style bar's **Size** group does the same: type a width (**W**) or height (**H**) and press `Enter`, use its − and + buttons (10 at a time), or its rotate buttons. Screen readers hear the new size or angle.
- **Edit text**: double-click an object, press `Enter`, or use **Edit text** in the style bar. Changes are saved when you click away, press `Escape`, or press `Ctrl+Enter` (`⌘+Enter` on a Mac). In frame names and connector labels, `Enter` saves too.
- **Style bar**: appears at the top when something is selected (a bottom sheet on phones). Use it to set the fill, line and text colours, line width, text size and alignment, size and rotation. For connectors, it also sets straight or elbow lines and arrowheads. It can also bring objects to the front or send them to the back, duplicate or delete them. Each change applies to every selected object it fits. From the canvas, `Tab` goes straight to it; arrow keys move between its buttons and `Escape` returns to the canvas.
- **Frames** are named regions. An object whose centre you drop inside a frame belongs to it, and moving or duplicating the frame brings its members along. Deleting a frame leaves its members where they are.
- **Connectors**: with the Connector tool, drag from one object to another. Or, without dragging, select exactly two objects (the first one you select is where the line starts) and choose **Connect** in the style bar or the actions menu. The line follows both objects as they move, and deleting either object deletes the connector. To move one end of a connector to another object, select the connector and drag the round handle at that end onto the object (it is highlighted when it can take the connector); dropping on empty canvas, on the connector's other end or on another connector changes nothing. Without dragging, choose **Reconnect start…** or **Reconnect end…** in the style bar or the actions menu, type to search the list of objects, and press `Enter` on the one you want. The label, line style, arrows and the other end stay as they were. If someone deletes the object at the same moment, the connector keeps its old end.
- **Pan and zoom**: drag with the Hand tool or hold `Space` and drag; `Shift`+scroll (or a sideways trackpad swipe) pans sideways. Scrolling or pinching zooms about the pointer. With nothing selected, the arrow keys pan the view (Shift: bigger steps). If your system asks for reduced motion, zooming and following jump instead of gliding. The controls at the bottom right zoom out, reset to 100% (click the percentage), zoom in and fit everything (`Shift+1`). Click or drag in the minimap to jump there; the minimap shows everyone's view in their colour.
- **Your name** is your account's display name: your cursor, the objects you create and your Activity entries carry it. Nobody is asked for a name. Click your avatar at the top right to change your colour.
- **Follow someone**: click a person's avatar at the top right to follow their view; a "Following" chip appears. When more people are here than there is room for, the **+N** button lists everyone, each with Follow. Click **Stop**, or pan yourself, to stop following.
- **Live collaboration**: you see other people's cursors with their names, a see-through ghost of anything they are dragging, and pen strokes as they are drawn. Their changes appear when they let go. If two people move the same object at once, both moves are kept. If two people change the same text or colour at once, the first saved change wins and the object flashes for the other person.
- **Undo**: `Ctrl+Z` / `Ctrl+Shift+Z` (`⌘` on a Mac) or the buttons at the bottom left undo and redo your own recent changes. The **Activity** panel lists recent changes by everyone and can undo them, including your changes from before a reload.
- **Objects list** (list button or `Shift+O`): every object with its text, filterable, however large the board. **Show** pans to an object, **Select** selects it, brings it into view and moves focus to the style bar, so the whole board can be used with a keyboard and screen reader. In the Objects and Activity lists `Tab` reaches one row; the up and down arrow keys move between rows (left and right between a row's buttons, `Home`/`End` and `Page Up`/`Page Down` jump), and screen readers announce each row's position in the whole list. The Objects and Activity panels sit beside the board rather than blocking it: `Tab` moves in and out of them, and `Escape` or the close button closes them. Changes by others are announced to screen readers.
- **Keyboard**: with the canvas focused, `A` opens the Add menu, `I` icons and shapes, `Ctrl+.` (`⌘+.`) emoji and symbols (also while typing), `Shift+O` the Objects list, `Delete` removes the selection, `Ctrl+D` duplicates, `Ctrl+A` selects all, `]` and `[` bring to front and send to back, `+` and `-` zoom, `Shift+0` resets to 100%, and `Escape` cancels a gesture or clears the selection. Arrow keys move the selection (or pan with nothing selected), `Alt`+arrow keys resize it, and `,` and `.` rotate it. Right-click an object for its actions as a menu; the context-menu key or `Shift+F10` opens the same menu for the current selection, next to it. The same actions are in the style bar. After loading or deleting, focus stays on the canvas.
- **Phones and tablets**: drag with one finger to select and move, or to draw with the Pen tool. Two fingers pan and pinch to zoom. Press and hold an object for its actions menu: it opens beside your finger, and lifting the finger does not choose anything; tap an item to run it. Buttons in the style bar, menus and the colour dialog are at least 44 pixels on phones.
- **Getting started**: an empty whiteboard shows three ways to begin: **Add a sticky note**, **Paste text** (one sticky note per line) and **Choose a template** (Brainstorm, Retrospective, Journey map or Architecture sketch). A template is added in the middle of your view as one change, so Undo removes it. The same are in the board menu (the **⋯** button next to the title) and in the right-click menu on empty canvas.
- **Copy, cut and paste**: `Ctrl+C`, `Ctrl+X` and `Ctrl+V` (`⌘` on a Mac), or **Copy** and **Cut** in the selection's actions menu. Copying a frame copies what is in it; a connector comes along only when both its ends do. Pasted objects are new copies placed at the pointer (or the middle of the view); pasting again steps them down and right. You can paste into another whiteboard. Text copied from elsewhere becomes one sticky note per line (at most 200), and a table copied from a spreadsheet keeps its rows and columns. Formatting, pictures and web page markup on the clipboard are ignored. The whiteboard runs in a protected frame that cannot read the clipboard by itself, so the menus' **Paste** pastes what you last copied on this whiteboard, and **Paste text as sticky notes…** gives you a box to paste into.
- **Keyboard shortcuts**: press `?` (or **Keyboard shortcuts** in the board menu) for the full list.
- **Links to a frame or object**: select one object and choose **Copy link to frame** (or **to object**) in its actions menu. Opening the link shows that frame, or selects and shows that object; a link to something since deleted is ignored. Links carry only the object's id, never its content. Add `&present=1` to a frame link to start presenting there. (Links work where the host page keeps the `#frame=…` part of its address; if copying is blocked, the link is shown for you to copy.)
- **Present**: `Shift+P`, **Present frames** in the board menu, or **Present from this frame** on a selected frame. The toolbars disappear and the view fits one frame at a time, in their stacking order. Move with the arrow keys, `Page Up` / `Page Down`, `Space`, `Home` and `End`, or the buttons at the bottom; `Escape` or **Exit** stops. Only your own view moves: others can follow you by clicking your avatar if they want to. With reduced motion, the view jumps instead of gliding.
- **Backup**: **Download board backup** in the board menu saves the title, background and objects as a JSON file (no history, names, cursors or other people's details). The protected frame may block downloads; the dialog then lets you copy the backup as text, and the gadget's **Export** menu offers **Whiteboard backup (JSON)** as a file. **Import backup…** reads such a file (or its pasted text), shows what it holds and anything wrong with it, and adds the objects beside what is already on the board as new copies; nothing is replaced. Tick the box to also take the backup's title and background.
- **Export**: the gadget's HTML and PDF export draws the board fitted to the page, without the toolbars. `exportSvg()` (below) returns the same drawing as an SVG file, and the **Whiteboard backup (JSON)** export returns `exportData()`.

- **Saving and connection**: the status beside the title says **Saved** only when every change you made has been confirmed by the server. It shows **Saving…** while changes are on their way, and **Reconnecting** or **Connection lost** with the number of unsaved changes when the connection drops. Changes you make while reconnecting are kept and sent once it is back. If saving takes unusually long or the connection is down, the status warns that reloading now would lose your unsaved changes; screen readers hear about lost and restored connections, not about every save.
- **Recovering after the gadget's code changes**: if the gadget's code is changed while the whiteboard is open, it reloads itself to reconnect (your colour is kept), but only when nothing is unsaved. With unsaved changes it shows a **Connection lost** screen instead, with how many changes are unsaved and **Download unsaved changes** (a data file with the last saved board and your unsaved changes; **Show as text** gives the same data to copy if the download is blocked). **Reload and lose them** reloads at once; otherwise the page keeps trying to reconnect and reloads by itself after 5 minutes. If it has to reload more than 3 times in a minute it stops and asks you to reload the page.

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

// Icons and diagram shapes: look up stable ids first, then add by id (never markup or SVG).
const hits = await env.Whiteboard.findIcons({ query: "database", packId: "core.1", limit: 5 });
// -> [{packId, iconId, label, category, categoryLabel, tags, kind, aspect, text}], best first;
//    also findIcons("cloud"). limit 1..100 (default 20); omit query to list a pack or category.
await env.Whiteboard.addIcons({
  by: "Assistant",
  icons: [
    "core.1/decision",                                   // "packId/iconId", or a bare iconId
    { icon: "tabler.1/server", size: 64, color: "blue" }, // size: the longer side, keeping proportions
    { packId: "core.1", iconId: "database", x: 0, y: 400, text: "Orders" },
  ],
  frame: "Architecture",   // optional: inside this frame (id or name) and members of it
  at: { x: 0, y: 0 },      // optional top-left of the grid for icons without x and y
  columns: 4, gap: 40,     // optional, as for addStickies
}); // -> { created: WhiteboardObject[], errors: OpError[] }
// -> { connector, errors }; routing "straight" (default) or "elbow"; arrow "end" (default), "both" or "none"

const svg = await env.Whiteboard.exportSvg({ frame: "Themes" }); // whole board when frame is omitted
```

```js
// Backup: title, background and objects as data (no history, attribution, versions or order keys)
const backup = await env.Whiteboard.exportData();
// -> {format: "cloudflare-os-whiteboard", version: 1, exportedAt, title, background, objects: [...]}

// Import a backup (the object or its JSON text) as new objects: fresh ids, references remapped
await env.Whiteboard.importData({
  data: backup,
  at: { x: 0, y: 2000 },  // optional top-left; default: as saved on an empty board, else right of existing content
  structure: true,        // optional: also take the backup's title and background
  by: "Assistant",
}); // -> {created, ids, counts, skipped, problems, errors, revision} or {error}
```

**Emoji and symbols** are plain text: put them in any `text` (for example `{ type: "text", text: "🚀", w: 80, h: 80, style: { fontSize: 64, align: "center" } }` in `addObjects`, or `"Ship it ✅"` as a sticky's text). Keep sequences whole (joiners, variation selectors, skin tones and flags); the server keeps them intact and never splits one when it truncates.

`arrangeGrid`, `moveObjects`, `updateObjects` and `deleteObjects` return an `OperationResult`. In `updateObjects`, `fields` is a patch (see "Object fields"); `color` is a shortcut that sets `style.fill` for stickies, shapes, text, frames and diagram shapes (`kind: "stencil"`), and `style.stroke` for pens, connectors and icons (`kind: "glyph"`).

**Icon packs**: `core.1` "Diagram shapes" (`kind: "stencil"`; categories `flowchart` and `architecture`) and `tabler.1`, a subset of [Tabler Icons](https://github.com/tabler/tabler-icons) 3.48.0 (`kind: "glyph"`; categories `people`, `devices`, `files`, `actions`, `data`, `network`, `infrastructure`, `security`, `communication`). A published `packId`/`iconId` pair always draws the same icon; a changed design would ship as a new pack version (`tabler.2`) alongside the old one. `addIcons` takes each icon's default size and style (stencils at their own size with a white fill; glyphs 96 on the longer side); `w`, `h`, `rot`, `text`, `color`, `style` and `frame` may be given per icon, and items without both `x` and `y` are laid out in a grid, each centred in its cell. Unknown icons are reported in `errors` (`invalid_ref`) and the rest are added.

### Core methods

| Method | Returns |
| --- | --- |
| `getBoard()` | `BoardSnapshot` `{schemaVersion, revision, title, background, objects, lastModified}` |
| `applyOperation({senderId?, by?, requestId?, objectOps?, structure?})` | `OperationResult` |
| `getHistory(limit = 50)` | `HistoryEntry[]`, oldest first |
| `undo({senderId?, by?, historyId?, requestId?})` | `OperationResult`. Without `historyId`, undoes the most recent change made by `by` that is still in effect: undos and changes already undone are skipped, so calling it again walks further back. To redo, undo the undo's entry by its `historyId` |
| `exportSvg({frame?})` | SVG document as a string. At most 2,000,000 characters of text are laid out; text beyond that is cut |
| `subscribe(callback, {clientId, name, color, session?})` | `BoardSnapshot` plus `session`; used by the UI. Throws `clientId in use` when a live subscription for `clientId` has a different session, and `board is full` beyond 200 subscribers. When full, subscribers that have not called `updatePresence` for 32 seconds are removed first |
| `updatePresence({clientId, session, name?, color?, cursor?, viewport?, selection?, transforms?, stroke?, editingId?})` | `{known, revision}`; used by the UI, also as its heartbeat (every 4 seconds). `known: false` means this server instance has no subscription for the client (it restarted) or the session does not match, so the client re-subscribes. Each client's updates are passed on at most 40 times a second; faster ones are merged into the next |
| `leavePresence(clientId, session)` | nothing; used by the UI. Ignored unless `session` matches |

**History entries** are `{id, at, by, summary, inverse, undoOf?, undoneBy?}`: `undoOf` is set on an undo's entry (the id it undid) and `undoneBy` on an entry whose change is currently undone.

**Ids** are a one-letter prefix, an underscore and 12 lowercase hex digits: `o_` for objects, `h_` for history entries. New object ids may be chosen by the caller, for example `"o_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12)`.

**Object fields**: `id, type, x, y, w, h, rot, z, frameId, text, style, version, createdAt, updatedAt, createdBy`, plus `points` for pens, `from, to, fromSide, toSide, routing` for connectors and `packId, iconId` for icons.

| Type | Notes |
| --- | --- |
| `sticky`, `rect`, `ellipse` | `text` is the content; may rotate |
| `text` | a text label; may rotate. Emoji and symbols inserted from the picker are text objects holding just that character (`style.fontSize` 64, `align` `center`, a box of about 80 by 80) |
| `frame` | a named region (`text` is the name); drawn below everything else; cannot rotate or belong to another frame |
| `pen` | a freehand stroke: `points` is `[x0, y0, x1, y1, ...]` normalised to the box (each 0 to 1); `style.stroke` and `style.strokeWidth` draw it |
| `icon` | an icon or diagram shape from a pack: `packId` and `iconId` name it (see `findIcons`; an unknown pair is `invalid_ref`) and may be changed by an update; only the reference is stored, never the drawing. May rotate. Stencils (`core.1`) stretch to the box, fill with `style.fill` and hold `text`; glyphs (`tabler.1`) keep their proportions inside the box, draw in `style.stroke` with `style.strokeWidth` in the icon's own units (2 is the design weight; it scales with the icon), draw a tile in `style.fill` unless it is `none`, and always have empty `text`. `addObjects` accepts `{type: "icon", packId, iconId, ...}` too |
| `connector` | a line from object `from` to object `to` (neither may be a connector); `fromSide`/`toSide` are `auto`, `top`, `right`, `bottom` or `left`; `routing` is `straight` or `elbow`; `text` is an optional label; `style.arrowStart`/`arrowEnd` are `none` or `arrow`. Its box is ignored |

- **Geometry**: `(x, y)` is the top-left of the unrotated box; `rot` is degrees clockwise about its centre.
- **style**: `{fill, stroke, strokeWidth, textColor, fontSize, align, arrowStart, arrowEnd}`. Colours are `"#rrggbb"` (`fill` and `stroke` also accept `"none"`); `align` is `left`, `center` or `right`.
- **z** is a fractional ordering key (base-62 strings such as `"a0"`, `"a1"`, `"a0V"`); objects stack by `z` then `id`, with frames always below. Omit `z` when creating to put the object on top. A `z` is taken as given when it is at most 64 characters and starts with a letter from `B` to `y` (every key made by stepping from `"a0"` does). Any other key above every object of its group is replaced by a short key on top, one below every object by a short key at the bottom, and anything else is ignored (a create then goes on top).
- **frameId** names the frame an object belongs to. Moving a frame does not move its members by itself: move them in the same request. Deleting a frame leaves its members where they are; their `frameId` is cleared the next time each is written. A create or update whose `frameId` names no object (for example a frame someone just deleted) stores `null` and applies the rest.
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
- `errors` lists invalid ops as `{index, code, message}`. The codes are `invalid_id`, `invalid_op`, `unknown_object`, `exists`, `invalid_ref` (a connector endpoint that does not name a suitable object, or a `frameId` naming an object that is not a frame) and `limit`.

**Idempotent requests**: give `applyOperation` or `undo` a `requestId` (1 to 64 characters from `A-Z a-z 0-9 : _ -`) to make retries safe. A request whose `requestId` is already recorded for the same `senderId` is not applied again: it returns the recorded `status`, `conflicts` (with `current` read now) and `errors`, the current `revision`, empty `upserts` and `deletes`, and `duplicate: true`. The last 500 request ids are remembered. Make request ids unguessable, for example a random value made once per session plus a counter (`crypto.randomUUID().replace(/-/g, "") + ":" + n`): the records are shared by everyone on the board and a `senderId` is visible to others, so an id someone else can predict could be recorded first, and your request would then be answered as a duplicate without being applied.

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
| Ops in one request (and items in one `addObjects`, `addStickies` or `updateObjects` call) | 1,000 |
| Objects changed by one request, cascaded connectors included | 2,000 |
| Coordinates | ±1,000,000 |
| Width and height | 1 to 100,000 |
| History | 200 entries |
| Live subscribers | 200 |

Text limits count UTF-16 code units, as a browser's text fields do: most characters count 1, an emoji 2, and an emoji sequence all of its parts (a family of four is 11). Longer text is truncated, never inside an emoji sequence or another multi-part character, and out-of-range numbers are clamped rather than rejected. Stored size is measured conservatively, as an upper bound of both the JSON and the binary form storage writes: each number counts at least 9 bytes (plus 4 per array element), text 1 byte per character, or 2 when it has characters beyond Latin-1, or its UTF-8 JSON size when that is more. A pen stroke at the point cap measures about 52 KiB. The history is kept within 100 KiB and 200 entries in the same measure; a change whose undo information would exceed 16 KiB (such as deleting a long pen stroke) is recorded but cannot be undone with `undo`.

### Backup format

`exportData()`, the JSON backup export, the in-app backup and the clipboard (as `application/vnd.cloudflare-os-whiteboard+json;version=1`) share one data-only format: `{format: "cloudflare-os-whiteboard", version: 1, objects, origin?, title?, background?, exportedAt?}`. `objects` lists objects bottom to top (frames first) with `id, type, x, y, w, h, rot, text, style`, plus `frameId`, `points` or the connector fields; an `id` is only a reference inside the document. Nothing else is read: versions, timestamps, `createdBy` and `z` are ignored, every value goes through the same checks as an ordinary create, a connector is kept only when both ends are in the document, and a `frameId` only when its frame is. At most 5,000 objects and 16 MB of text. The format version is separate from the stored `schemaVersion`; older versions are upgraded on read (version 0 is a `getBoard()` result). `importData()` creates in requests of at most 1,000 objects; errors report the object's position in the document as `index`.

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

The UI sends presence adaptively (`src/client/sync/presence.js`): selection and editing changes, gesture start and end, and the pointer leaving or re-entering are sent at once; movement is capped at about 20 updates a second (fewer with 10, 25 or 50 or more people present, while one of its own changes is being saved, or when the gadget answers slowly), and states that look the same once rounded are skipped. An idle tab sends only the heartbeat, and not even that shortly after another update. A hidden tab clears its cursor and ghosts once and then sends heartbeats only. The server-side limits above still apply.

### Client connection state (for the UI and tests)

The client store (`src/client/store-contract.js`) exposes `connection` as one of `connecting`, `live` (nothing pending: "Saved"), `saving`, `reconnecting`, `recovery-required` (automatic recovery gave up; retries continue) and `read-only` (reserved for verified sessions, not produced yet), plus `pendingCount`, `oldestPendingAt`, `lastAcknowledgedRevision` and `riskOfLoss`. `store.replaceTarget(gadget)` swaps the RPC stub without reloading the frame: the store re-subscribes on it, reconciles from its snapshot and replays only unacknowledged requests with their original `requestId`, so each change applies at most once. The platform cannot hand the frame a fresh stub yet (that needs a host change), so on the platform the frame still reloads, as described under "Recovering" above. `store.getRecoveryData()` returns the data-only recovery file (`{format: "whiteboard-recovery", version: 1, savedAt, lastAcknowledgedRevision, board, pending}`); it never contains request ids or the session and is never written to `window.name` or logs.

## Third-party notices

The general icons are a subset of [Tabler Icons](https://github.com/tabler/tabler-icons) 3.48.0, MIT licence, Copyright (c) 2020-2026 Paweł Kuna. They are compiled into inert drawing data when the gadget is built; the full licence text ships inside the gadget's code with that data (the `licence` of pack `tabler.1`), and in `THIRD_PARTY_NOTICES.md` of the source package.

The emoji names, keywords and groups come from [emojibase-data](https://github.com/milesj/emojibase) 17.0.0 (MIT licence, Copyright (c) 2017-2019 Miles Johnson), derived from the Unicode CLDR annotations and emoji data files; the symbols' names are from the Unicode Character Database. Unicode data is under the Unicode License v3 (Copyright © 1991-2025 Unicode, Inc.). Both licence texts ship inside the gadget's code with that data (`UNICODE_LICENCES`) and in `THIRD_PARTY_NOTICES.md`. No emoji images are included: emoji are drawn by the viewer's system font.
