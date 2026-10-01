# Whiteboard

A live, shared whiteboard: an infinite canvas with sticky notes, shapes, text, code blocks, connectors, pen strokes and frames. Everyone who has the whiteboard open sees changes as they happen, sees each other's cursors, and sees a ghost of anything someone is dragging or drawing before they let go.

To read or change a board's content from chat, call its operations (see "Adapting this gadget" below, then "Programmatic use"); to change what the whiteboard looks like or can do, edit the adapt block at the top of `client.js`.

## Using the whiteboard

Everyone with the whiteboard open is shown at the top right, under their account's display name and a colour, so others can recognise their cursor. Nobody is asked for a name.

- **Tools** (left toolbar; a bottom bar on phones, where Add, Objects and Activity come first): Select (`V`), Hand to pan (`H`), Sticky note (`N`), Rectangle (`R`), Ellipse (`O`), Text (`T`), Frame (`F`), Connector (`C`) and Pen (`P`). Click on the canvas to create an object at its default size, or drag to size it. After one object the tool returns to Select (the Pen stays on for more strokes); double-click a tool button to keep it on until you pick another. New objects use the fill, line and text colours you last chose for that kind of object. A text label left empty is removed when you finish editing. The toolbar is one `Tab` stop: use the arrow keys to move between its buttons. When it does not fit, a shadow at its edge shows that it scrolls.
- **Shapes**: the **Shapes** tool (`R`) draws the shape last picked from its grid. **Basic**: rectangle, rounded rectangle, ellipse (`O`), pill, diamond, triangle, right triangle, pentagon, hexagon, octagon, parallelogram, trapezoid, star, cross and cube. **Flowchart**: database (cylinder), queue, document, multiple documents, note, subprocess, manual input, delay, off-page link and cloud. **Arrows and callouts**: speech bubble, block arrow, double arrow and chevron. Click the tool to pick another shape; click the board for the default size or drag for any size (`Shift` keeps the shape's proportions). To change a selected shape, use **Shape** in the style bar; its text, colours, size and connectors stay. **Line pattern** in the style bar makes shape outlines, frames, drawings and connectors solid, dashed or dotted. More diagram shapes (flowchart and architecture stencils) are under **Icons and shapes…** (`I`).
- **Add without dragging**: the **+** button (or `A`) opens a menu that adds a sticky note, rectangle, ellipse, text or frame in the middle of the view, or any shape from **Shape…**. Sticky notes and text open for typing straight away.
- **Tables**: the **Table** button on the toolbar (or **Table** in the Add menu) adds a three-column table with a header row and opens its first cell for typing. Type in a cell; `Tab` moves to the next cell (and past the last cell adds a row), `Shift+Tab` to the previous one, `Enter` to the cell below (adding a row at the bottom), `Shift+Enter` starts a new line in the cell, and `Escape` finishes. Double-click any cell to edit it. The style bar adds or removes rows and columns (next to the cell being edited, else at the end), turns the header row on or off, fits the column widths to their text, and copies the table as Markdown; it also sets the table's fill, line and text colours, text size and alignment. Paste cells copied from a spreadsheet (tab-separated), CSV or a Markdown table onto the board and they become a table.
- **Diagrams (D2 and Mermaid)**: the **Diagram** button on the toolbar (or **Diagram (D2)** and **Diagram (Mermaid)** in the Add menu) adds a diagram written as text and drawn by the MermaiD2 renderer. Double-click it (or **Source** in the style bar) to edit its source; when you finish, it is drawn again. The style bar switches between D2 and Mermaid, picks the layout (Dagre, ELK or TALA), and turns on a hand-drawn (sketch) or dark style; **Fit** gives the box the drawing's proportions and **Render** draws it again. Paste a fenced ```` ```d2 ```` or ```` ```mermaid ```` block onto the board and it becomes a diagram. If the source has a mistake, the diagram shows the renderer's message in red. Drawing needs the MermaiD2 connector (`mermaid2://renderer`) connected to the board as `MERMAID2` (ask the Workshop agent to connect it); without it a diagram shows its source and says so. Diagrams are drawn as images, so nothing in a diagram can run in the page.
- **Code blocks**: **Code block** on the toolbar or in the Add menu (or `K`) adds a block of code in the middle of the view and opens it for typing, in a monospace font. `Tab` indents (the selected lines, or at the cursor) and `Shift+Tab` outdents, using the indent the code already uses; `Enter` keeps the current line's indentation; `Escape` or `Ctrl+Enter` (`⌘+Enter`) finishes, and `Escape` then `Tab` leaves the block. The block grows and shrinks to fit its lines. Paste code into an empty block and its language is guessed; paste a fenced Markdown block (```` ```python ````) onto the board and it becomes a code block in that language. The style bar sets the language (a searchable list: plain text, JavaScript, TypeScript, JSON, Python, SQL, HTML/XML, CSS, Shell, YAML, Markdown, Go, Rust, Java, C, C++, C#, PHP, Ruby, Diff), a light or dark theme, line numbers, wrapping long lines (otherwise they are cut at the block's edge), the code size and a file name shown in the header, and **Copy code** copies the code as text. Highlighting is drawn by the gadget itself, the same on the board and in exports; it never runs the code.
- **Icons and shapes**: **Icons and shapes…** in the Add menu (or `I`) opens the insert panel. Its **Icons & shapes** tab lists diagram shapes (flowchart and architecture: decision, start/end, document, database, cloud, queue, server, user and more) and a set of general icons (people, devices, files, actions, data, network, cloud and infrastructure, security, communication). Search by name or meaning ("db", "person"), or pick a category; your recently used icons are listed first. Click an icon, or press `Enter` on it, to add it in the middle of the view, or drag it onto the board to place it. In the panel, `↓` moves from the search field to the results, the arrow keys move between icons and `Escape` closes it. Shapes take a fill colour and hold text (double-click or `Enter` to type); icons keep their proportions and take the line colour, and a fill colour draws a tile behind them. Icons are part of the gadget, so they work offline and never load anything from the internet.
- **Emoji and symbols**: the panel's second tab, **Emoji & symbols** (or **Emoji and symbols…** in the Add menu, or `Ctrl+.` / `⌘+.`), lists every current emoji (Emoji 17.0, with their standard names and keywords) and useful symbols for diagrams: arrows, maths and logic, ticks and ballot boxes, stars and shapes, bullets, punctuation, box drawing, currency, Greek letters, superscripts and subscripts, and keyboard keys (`⌘ ⌥ ⇧ ⏎ ⌫`). Search by name or meaning ("smile", "tick", "implies"), pick a category, or pick from your recently used ones at the top. The hand menu beside the categories sets a skin tone for emoji that have one (default none); the panel remembers it, and the tab you used last, until you close the whiteboard. Click a character, press `Enter` on it, or drag it onto the board: while you are typing in a sticky note, shape, text, frame name or connector label it goes in at the text cursor (click one, or press `Ctrl+.` while typing, then `Enter` on your pick; `Escape` returns to your text); otherwise it is added as a large text object in the middle of the view (or where you drop it). The tabs are one `Tab` stop: the left and right arrow keys switch between them. Emoji are ordinary text drawn by each viewer's own emoji font, so they look a little different on Windows, macOS, Android and Linux; emoji a device cannot draw are left out of its list (the panel says how many), but still appear for others.
- **Select and move**: click an object to select it, Shift-click to add to the selection, or drag a box around several on empty canvas (a frame is picked only when the box encloses all of it). Drag to move; use the handles to resize and rotate. When an object is small on screen (zoomed far out), only its corner handles show, or none, and dragging anywhere on it moves it. Arrow keys move the selection by 1 (Shift: 10), and the style bar's **Move** buttons move it by 10.
- **Snapping and guides**: while you drag or resize, the selection snaps to the left, centre and right edges and the top, middle and bottom of nearby objects (a rotated object by the box around it), and a pink guide shows the line it snapped to. It never snaps to the objects being moved (such as a frame's members). On a board with the **grid** background it also snaps to the grid. The snap distance is the same on screen at every zoom. Hold `Alt` (`Option` on a Mac) while dragging to place freely; keyboard moves are always exact.
- **Align and distribute**: with two or more objects selected, the style bar's align buttons line up their left edges, horizontal centres, right edges, top edges, vertical middles or bottom edges; with three or more, **Distribute horizontally** and **Distribute vertically** space them evenly (the outermost two stay put). The same commands are under **Align or distribute…** in the actions menu (right-click, or the context-menu key / `Shift+F10`). A selected frame moves as one with its members. Each command is one change, so one undo reverses it.
- **Resize and rotate without dragging**: `Alt`+arrow keys make the selection wider or narrower (`Alt+→` / `Alt+←`) and taller or shorter (`Alt+↓` / `Alt+↑`) by 1 (Shift: 10), keeping its top-left corner in place. `.` rotates it 15° clockwise and `,` 15° anticlockwise (sticky notes, rectangles, ellipses and text). The style bar's **Size** group does the same: type a width (**W**) or height (**H**) and press `Enter`, use its − and + buttons (10 at a time), or its rotate buttons. Screen readers hear the new size or angle.
- **Edit text**: double-click an object, press `Enter`, or use **Edit text** in the style bar. Changes are saved when you click away, press `Escape`, or press `Ctrl+Enter` (`⌘+Enter` on a Mac). In frame names and connector labels, `Enter` saves too.
- **Style bar**: appears at the top when something is selected (a bottom sheet on phones). Use it to set the fill, line and text colours, line width, text size and alignment, size and rotation. For connectors, it also sets straight or elbow lines and arrowheads. It can also bring objects to the front or send them to the back, duplicate or delete them. Each change applies to every selected object it fits. From the canvas, `Tab` goes straight to it; arrow keys move between its buttons and `Escape` returns to the canvas.
- **Frames** are named regions. An object whose centre you drop inside a frame belongs to it, and moving or duplicating the frame brings its members along. Deleting a frame leaves its members where they are.
- **Connectors**: select a shape to see four blue connection handles. Drag a handle to another object to connect from that side, or click a handle to search for the destination. Drag a handle (or, with the Connector tool, drag from a shape) to an empty spot to add a copy of the shape there, already connected, and selected so you can keep going; one undo removes both. With the Connector tool, the points where lines attach show as you point at an object; lines meet each shape's actual outline (a diamond's tips, a triangle's slopes). In the style bar, **Start marker** and **End marker** choose each end: none, arrow, open arrow, hollow triangle, filled or hollow diamond, dot, bar or crow's foot (for entity-relationship "many"), and **Swap end markers** reverses the arrow. The **Connect…** button, **Connect to…** action and `Shift+C` offer the same searchable picker without dragging. With the Connector tool, drag from one object to another. Or, without dragging, select exactly two objects (the first one you select is where the line starts) and choose **Connect** in the style bar or the actions menu. The line follows both objects as they move, and deleting either object deletes the connector. To move one end of a connector to another object, select the connector and drag the round handle at that end onto the object (it is highlighted when it can take the connector); dropping on empty canvas, on the connector's other end or on another connector changes nothing. Without dragging, choose **Reconnect start…** or **Reconnect end…** in the style bar or the actions menu, type to search the list of objects, and press `Enter` on the one you want. The label, line style, arrows and the other end stay as they were. If someone deletes the object at the same moment, the connector keeps its old end.
- **Connector routes**: the style bar's **Straight line**, **Elbow line** and **Curved line** buttons set how a connector runs. When sides are automatic, each end attaches to the side that gives the shortest, simplest line. Elbow lines go around sticky notes, shapes, text, icons and code blocks in their way (never around frames, which they may cross, or drawings); curved lines leave each object at a right angle to its side. To attach an end to a particular side, drop it on (or start the drag from) the dot in the middle of that side; elsewhere the side stays automatic. A selected elbow line shows a handle on each segment: drag one to move that segment sideways (a segment next to an end gains a small step); it snaps to other objects' edges and centres and into line with the rest of the route (hold `Alt` to place freely). A curved line has one handle in its middle: drag it to bend the curve. Collaborators see the new route as you drag, and it is one change, so one undo reverses it. Without a pointer: select the connector and press `E` (or **Edit route** in the style bar or the actions menu), then `Tab` picks a handle, the arrow keys move it by 1 (`Shift`: 10), `Delete` resets the route and `Enter` or `Escape` finishes. **Reset route** in the style bar or actions menu returns selected connectors to the automatic route and sides. Edited routes follow their objects: moving both ends moves the route, and moving one end stretches it.
- **Pan and zoom**: drag with the Hand tool or hold `Space` and drag; `Shift`+scroll (or a sideways trackpad swipe) pans sideways. Scrolling or pinching zooms about the pointer. With nothing selected, the arrow keys pan the view (Shift: bigger steps). If your system asks for reduced motion, zooming and following jump instead of gliding. The controls at the bottom right zoom out, reset to 100% (click the percentage), zoom in and fit everything (`Shift+1`). Click or drag in the minimap to jump there; the minimap shows everyone's view in their colour.
- **Your name** is your account's display name: your cursor, the objects you create and your Activity entries carry it. Nobody is asked for a name. Click your avatar at the top right to change your colour.
- **Follow someone**: click a person's avatar at the top right to follow their view; a "Following" chip appears. When more people are here than there is room for, the **+N** button lists everyone, each with Follow. Click **Stop**, or pan yourself, to stop following.
- **Live collaboration**: you see other people's cursors with their names, a see-through ghost of anything they are dragging, and pen strokes as they are drawn. Their changes appear when they let go. If two people move the same object at once, both moves are kept. If two people change the same text or colour at once, the first saved change wins and the object flashes for the other person.
- **Undo**: `Ctrl+Z` / `Ctrl+Shift+Z` (`⌘` on a Mac) or the buttons at the bottom left undo and redo your own recent changes. The **Activity** panel lists recent changes by everyone and can undo them, including your changes from before a reload.
- **Objects list** (list button or `Shift+O`): every object with its text, searchable and filterable by type, however large the board. Press `Enter` or `↓` in the search field to reach the results. The **+** / **−** buttons include or remove objects from the selection without closing the panel; selection survives filtering, so you can find objects one at a time. **Edit selection** brings the selected objects into view and opens their editing controls; **Clear selection** starts again. **Show** pans to an object, **Select** selects it, brings it into view and moves focus to the style bar, so the whole board can be used with a keyboard and screen reader. In the Objects and Activity lists `Tab` reaches one row; the up and down arrow keys move between rows (left and right between a row's buttons, `Home`/`End` and `Page Up`/`Page Down` jump), and screen readers announce each row's position in the whole list. The Objects and Activity panels sit beside the board rather than blocking it: `Tab` moves in and out of them, and `Escape` or the close button closes them. Changes by others are announced to screen readers.
- **Keyboard**: with the canvas focused, `A` opens the Add menu, `I` icons and shapes, `Ctrl+.` (`⌘+.`) emoji and symbols (also while typing), `K` adds a code block, `Shift+O` the Objects list, `Delete` removes the selection, `Ctrl+D` duplicates, `Ctrl+A` selects all, `]` and `[` bring to front and send to back, `+` and `-` zoom, `Shift+0` resets to 100%, and `Escape` cancels a gesture or clears the selection. Arrow keys move the selection (or pan with nothing selected), `Alt`+arrow keys resize it, and `,` and `.` rotate it. Right-click an object for its actions as a menu; the context-menu key or `Shift+F10` opens the same menu for the current selection, next to it. The same actions are in the style bar. After loading or deleting, focus stays on the canvas.
- **Phones and tablets**: drag with one finger to select and move, or to draw with the Pen tool. Two fingers pan and pinch to zoom. Press and hold an object for its actions menu: it opens beside your finger, and lifting the finger does not choose anything; tap an item to run it. Buttons in the style bar, menus and the colour dialog are at least 44 pixels on phones.
- **Getting started**: an empty whiteboard shows three ways to begin: **Add a sticky note**, **Paste text** (one sticky note per line) and **Choose a template** (Brainstorm, Retrospective, Journey map or Architecture sketch). A template is added in the middle of your view as one change, so Undo removes it. The same are in the board menu (the **⋯** button next to the title) and in the right-click menu on empty canvas.
- **Copy, cut and paste**: `Ctrl+C`, `Ctrl+X` and `Ctrl+V` (`⌘` on a Mac), or **Copy** and **Cut** in the selection's actions menu. Copying a frame copies what is in it; a connector comes along only when both its ends do. Pasted objects are new copies placed at the pointer (or the middle of the view); pasting again steps them down and right. You can paste into another whiteboard. Text copied from elsewhere becomes one sticky note per line (at most 200), a table copied from a spreadsheet keeps its rows and columns, and a single fenced code block (```` ```lang ```` … ```` ``` ````) becomes a code block. Formatting, pictures and web page markup on the clipboard are ignored. The whiteboard runs in a protected frame that cannot read the clipboard by itself, so the menus' **Paste** pastes what you last copied on this whiteboard, and **Paste text as sticky notes…** gives you a box to paste into.
- **Keyboard shortcuts**: press `?` (or **Keyboard shortcuts** in the board menu) for the full list.
- **Links to a frame or object**: select one object and choose **Copy link to frame** (or **to object**) in its actions menu. Opening the link shows that frame, or selects and shows that object; a link to something since deleted is ignored. Links carry only the object's id, never its content. Add `&present=1` to a frame link to start presenting there. (Links work where the host page keeps the `#frame=…` part of its address; if copying is blocked, the link is shown for you to copy.)
- **Present**: `Shift+P`, **Present frames** in the board menu, or **Present from this frame** on a selected frame. The toolbars disappear and the view fits one frame at a time, in their stacking order. Move with the arrow keys, `Page Up` / `Page Down`, `Space`, `Home` and `End`, or the buttons at the bottom; `Escape` or **Exit** stops. Only your own view moves: others can follow you by clicking your avatar if they want to. With reduced motion, the view jumps instead of gliding.
- **Website and video cards**: paste one complete HTTP or HTTPS URL onto the board to create a link card. YouTube watch, share, Shorts, live and embed URLs get a video label; timestamps and other URL parameters are preserved. Select the card and choose **Open website…** in the style bar (or context menu) to inspect the destination, copy its address or open it in a new tab. Cards do not fetch previews or play videos inside the board. They are ordinary editable rectangles, so undo, collaboration, search, backup and export work as usual. Keep the address on its own second line and the final hint line to retain the website action when editing its title. **Paste text as sticky notes…** still pastes URLs as plain notes.
- **Backup**: **Download board backup** in the board menu saves the title, background and objects as a JSON file (no history, names, cursors or other people's details). The protected frame may block downloads; the dialog then lets you copy the backup as text, and the gadget's **Export** menu offers **Whiteboard backup (JSON)** as a file. **Import backup…** reads such a file (or its pasted text), shows what it holds and anything wrong with it, and adds the objects beside what is already on the board as new copies; nothing is replaced. Tick the box to also take the backup's title and background.
- **Export**: the gadget's HTML and PDF export draws the board fitted to the page, without the toolbars. `exportSvg()` (below) returns the same drawing as an SVG file, and the **Whiteboard backup (JSON)** export returns `exportData()`.

- **Saving and connection**: the status beside the title says **Saved** only when every change you made has been confirmed by the server. It shows **Saving…** while changes are on their way, and **Reconnecting** or **Connection lost** with the number of unsaved changes when the connection drops. Changes you make while reconnecting are kept and sent once it is back. If saving takes unusually long or the connection is down, the status warns that reloading now would lose your unsaved changes; screen readers hear about lost and restored connections, not about every save.
- **Recovering after the gadget's code changes**: if the gadget's code is changed while the whiteboard is open, it reloads itself to reconnect (your colour is kept), but only when nothing is unsaved. With unsaved changes it shows a **Connection lost** screen instead, with how many changes are unsaved and **Download unsaved changes** (a data file with the last saved board and your unsaved changes; **Show as text** gives the same data to copy if the download is blocked). **Reload and lose them** reloads at once; otherwise the page keeps trying to reconnect and reloads by itself after 5 minutes. If it has to reload more than 3 times in a minute it stops and asks you to reload the page.

## Adapting this gadget

| File | What it is |
| --- | --- |
| `client.js` | The main view, readable. Starts with the **adapt block**: settings, styles and extra commands. Edit this. |
| `client.lib.js` | The prebuilt client library (store, canvas, panels, sync) that `client.js` uses through `gadgetLib`. **Never edit or read it**: it is generated and is replaced whenever the gadget is rebuilt. |
| `server.js` | The server, readable: class `Gadget` (the RPC methods below and `describeGadget()`) and the export formats. Add server methods here. |
| `server.lib.js` | The prebuilt server library (whiteboard rules, storage, presence). **Never edit it.** |
| `README.md` | This guide. |

### Use: change the board's content

Call the gadget's methods from `executeCode` on its binding (`env.Whiteboard` here). `describeBinding` shows `describeGadget()`: each operation with an input schema and a runnable example. They are `getBoard`, `findObjects`, `getFrame`, `addStickies`, `addObjects`, `connectObjects`, `addFrame`, `updateObjects`, `moveObjects`, `arrangeGrid`, `deleteObjects`, `findIcons`, `addIcons`, `addCode`, `undo` and, low-level, `applyOperation` (also how to rename the board or change its background); plus `getHistory`, `exportSvg`, `exportData` and `importData`. "Programmatic use" below documents them in full. Never edit code to change content.

### Adapt: change what it looks like or can do

Edit the adapt block near the top of `client.js`. The library validates it: unknown keys are ignored, and a bad field or action is reported in the browser console and left out rather than breaking the board.

| Field | Meaning |
| --- | --- |
| `newObjectColors` | Colours of new objects made with the tools and the Add menu, per type (`sticky`, `rect`, `ellipse`, `text`, `frame`, `pen`, `connector`, `icon`, `code`): a colour name (`yellow`, `orange`, `red`, `pink`, `purple`, `blue`, `teal`, `green`, `gray`, `white`, `black`) or `"#rrggbb"`, which sets the fill (the line for `pen` and `connector`), or `{fill, stroke, textColor}`. The colour a person last picks in the style bar takes over for the rest of their session. Example: `{ sticky: "blue", text: { textColor: "#2563eb" } }`. |
| `minimap` | `false` hides the minimap at the bottom right; the zoom buttons stay. |
| `styles` | Extra CSS, applied after the built-in styles. Useful hooks: `.wb-topbar` (title bar), `.wb-toolbar` (tools), `.wb-stylebar` (selection bar), `.wb-minimap`, `.wb-canvas-host`, `.menu` and `.menu .adapt-action` (menus and your commands), `.toast`, and the CSS variables on `:root` such as `--accent`. |
| `actions` | Extra commands, each `{ id, label, title?, run(app) }`. They are listed **first in the board menu** (the **⋯** button beside the title: `Tab` to it, `Enter`, arrow keys) and **last in the right-click menu** (also `Shift+F10` or a long press), so they are reachable by mouse, keyboard and touch. `run` may be async; if it throws, the person sees "<label> failed: …". |
| `onReady(app)` | Called once, after the board has loaded and is shown, with the same `app` handle. Use it for set-up such as `app.onChange(...)`. |

**The `app` handle** passed to `run` and `onReady` holds the server's domain verbs with the same names and argument objects, applied through the page's own copy of the board: they show at once, sync in the background, count as the viewer's own change, and each call is one undo step (`Ctrl+Z`). They are synchronous. Colours and frames are given as in the server methods.

| Method | Returns |
| --- | --- |
| `app.getBoard()` | `{title, background, objects}`, objects bottom to top (a copy) |
| `app.findObjects({type?, text?, frame?})` | matching objects: `type` one or a list, `text` a case-insensitive substring, `frame` an id or name |
| `app.addStickies({stickies, frame?, at?, columns?, gap?})` | `{created, errors}`; without `at` or `frame` the grid is centred in the viewer's view |
| `app.addObjects({objects})` | `{created, errors}`; objects without `x`/`y` go in the middle of the view |
| `app.connectObjects({from, to, label?, routing?, arrow?, color?})` | `{connector, errors}` |
| `app.updateObjects({updates: [{id, fields}]})` | `{errors}` |
| `app.moveObjects({ids, dx, dy})` | `{errors}` (a frame's members do not move with it) |
| `app.arrangeGrid({ids, columns?, gap?, at?})` | `{errors}`; lays the objects out in the order given |
| `app.deleteObjects({ids})` | `{errors}` (attached connectors go too) |
| `app.getSelection()` / `app.setSelection(ids)` | the selected ids / selects those ids |
| `app.showObjects(ids)` | pans and zooms so they are in view |
| `app.getViewport()` | the visible world rectangle `{x, y, w, h}` |
| `app.toast(message)` | shows a short message for a few seconds (screen readers hear it) |
| `app.onChange(listener)` | calls `listener(board)` after every change to the board; returns an unsubscribe function |

`errors` are `{index, message}`: the item at `index` was skipped, the rest applied.

For a change the block cannot express, edit the rest of `client.js` (connection handling and the call `mountApp(root, store, { adapt })`), or add a method to class `Gadget` in `server.js` and describe it in its `DESCRIPTION` list; the client reaches server methods through the `gadget` stub. If what you need is not reachable from `client.js` or `server.js`, say so rather than editing a `.lib.js` file.

### Examples

Use, from `executeCode`: seven notes in a row, one colour each.

```js
const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const colors = ["yellow", "orange", "red", "pink", "purple", "blue", "green"];
const { created, errors } = await env.Whiteboard.addStickies({
  stickies: days.map((text, i) => ({ text, color: colors[i] })), columns: 7, by: "Assistant",
});
```

Adapt, in the adapt block of `client.js`: a board-menu command that turns the selected objects red, and blue sticky notes by default.

```js
const adapt = {
  newObjectColors: { sticky: "blue" },
  minimap: true,
  styles: "",
  actions: [
    { id: "mark-red", label: "Mark selection red", run(app) {
      const ids = app.getSelection();
      if (!ids.length) return app.toast("Select something first");
      app.updateObjects({ updates: ids.map((id) => ({ id, fields: { color: "red" } })) });
    } },
  ],
  onReady(app) {},
};
```

### Where your changes live

Edits made in this gadget's code editor change **this gadget only**. They are not carried back to its source, `packages/blueprint-whiteboard` in the deployment's starter repository, and other whiteboards keep the original. To change the whiteboard for everyone, change the source and ship a new format revision.


## Programmatic use

Call these from `executeCode` through the gadget's binding (for example `env.Whiteboard`). All methods are on the `Gadget` Durable Object; `describeGadget()` summarises them with input schemas and examples.

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
    { type: "diamond", x: 400, y: 400, w: 180, h: 120, text: "Approved?" },   // any shape name works as a type
    { type: "rect", shape: "cylinder", x: 700, y: 380, w: 140, h: 160, text: "Orders DB", dash: "dashed" },
    { type: "table", x: 0, y: 700, w: 400, rows: [["Service", "Owner"], ["API", "Ann"], ["Web", "Bo"]] },
    { type: "diagram", x: 500, y: 700, w: 480, h: 320, language: "d2", source: "web -> api -> db" },
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
// arrow: "end" (default) | "both" | "none"; or name each end's marker (none, arrow, open, triangle,
// diamond, diamondOpen, circle, bar, crow) and the line pattern:
await env.Whiteboard.connectObjects({ from: "o_1a2b3c4d5e6f", to: "o_6f5e4d3c2b1a", startMarker: "bar", endMarker: "crow", dash: "dashed", by: "Assistant" });

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
// -> { connector, errors }; routing "straight" (default), "elbow" or "curved"; optional fromSide / toSide
//    ("top", "right", "bottom", "left"; default automatic); arrow "end" (default), "both" or "none".
// Change a route later with updateObjects: { routing: "curved", curve: [0.5, 0.3] } or { segments: [] }.

// Code: one syntax-highlighted block, its height fitted to the code.
await env.Whiteboard.addCode({
  by: "Assistant",
  code: "def main():\n    print('hi')\n",
  language: "python",       // optional: id, label or alias ("py", "c++", "sh"); omitted or "auto": guessed
  title: "main.py",         // optional file name shown in the header (also accepted as `filename`)
  at: { x: 0, y: 0 },       // optional top-left; default: inside `frame`, else right of existing content
  frame: "Snippets",        // optional: id or name
  theme: "dark", lineNumbers: true, wrap: false, fontSize: 14, w: 480,  // all optional
}); // -> { block: WhiteboardObject|null, errors: OpError[] }
// findObjects({ type: "code", text: "main" }) finds code blocks by their code.

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
| `exportSvg({frame?})` | SVG document as a string. At most 2,000,000 characters of text are laid out; text beyond that is cut. Diagrams appear as their cached drawings (an image), or as placeholders when they have not been drawn yet |
| `getDiagramRender(id)` | `{id, hash, status, svg?, error?, w?, h?}` for diagram `id`, or `null` when there is no such diagram. `status` is `ok` (with `svg`), `error` (with a one-line `error`) or `unavailable` (no renderer is connected). Draws it with the renderer when its source changed since the last drawing (once, however many clients ask), and never changes the board. Used by the UI |
| `subscribe(callback, {clientId, name, color, session?})` | `BoardSnapshot` plus `session`; used by the UI. Throws `clientId in use` when a live subscription for `clientId` has a different session, and `board is full` beyond 200 subscribers. When full, subscribers that have not called `updatePresence` for 32 seconds are removed first |
| `updatePresence({clientId, session, name?, color?, cursor?, viewport?, selection?, transforms?, stroke?, editingId?})` | `{known, revision}`; used by the UI, also as its heartbeat (every 4 seconds). `known: false` means this server instance has no subscription for the client (it restarted) or the session does not match, so the client re-subscribes. Each client's updates are passed on at most 40 times a second; faster ones are merged into the next |
| `leavePresence(clientId, session)` | nothing; used by the UI. Ignored unless `session` matches |

**History entries** are `{id, at, by, summary, inverse, undoOf?, undoneBy?}`: `undoOf` is set on an undo's entry (the id it undid) and `undoneBy` on an entry whose change is currently undone.

**Ids** are a one-letter prefix, an underscore and 12 lowercase hex digits: `o_` for objects, `h_` for history entries. New object ids may be chosen by the caller, for example `"o_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12)`.

**Object fields**: `id, type, x, y, w, h, rot, z, frameId, text, style, version, createdAt, updatedAt, createdBy`, plus `points` for pens, `from, to, fromSide, toSide, routing` (and, when edited, `segments` and `curve`) for connectors, `packId, iconId` for icons and `language, theme, lineNumbers, wrap, filename` for code blocks.

| Type | Notes |
| --- | --- |
| `sticky`, `rect`, `ellipse` | `text` is the content; may rotate. A `rect` draws the outline in `style.shape`: `rect` (default), `rounded`, `pill`, `diamond`, `triangle`, `hexagon`, `octagon`, `pentagon`, `parallelogram`, `trapezoid`, `cylinder` (database), `document`, `cloud`, `callout` (speech bubble), `star`, `cross`, `arrow` (block arrow) or `chevron`; its text sits in the shape's inner area and connectors meet the outline. `addObjects` also takes `{type: "rect", shape: "diamond"}` or just `{type: "diamond"}` |
| `text` | a text label; may rotate. Emoji and symbols inserted from the picker are text objects holding just that character (`style.fontSize` 64, `align` `center`, a box of about 80 by 80) |
| `frame` | a named region (`text` is the name); drawn below everything else; cannot rotate or belong to another frame |
| `pen` | a freehand stroke: `points` is `[x0, y0, x1, y1, ...]` normalised to the box (each 0 to 1); `style.stroke` and `style.strokeWidth` draw it |
| `icon` | an icon or diagram shape from a pack: `packId` and `iconId` name it (see `findIcons`; an unknown pair is `invalid_ref`) and may be changed by an update; only the reference is stored, never the drawing. May rotate. Stencils (`core.1`) stretch to the box, fill with `style.fill` and hold `text`; glyphs (`tabler.1`) keep their proportions inside the box, draw in `style.stroke` with `style.strokeWidth` in the icon's own units (2 is the design weight; it scales with the icon), draw a tile in `style.fill` unless it is `none`, and always have empty `text`. `addObjects` accepts `{type: "icon", packId, iconId, ...}` too |
| `table` | a table: `cells` is an array of rows of cell text (1 to 60 rows of the same 1 to 20 columns, each cell up to 1,000 characters, newlines kept; short rows are padded), `header` (boolean, default `true`) shades and bolds the first row, and `colWidths` (optional) gives relative column widths (one number per column, 0.05 to 20; absent means equal columns). Rows share the height equally. `style.fill`, `stroke`, `strokeWidth`, `textColor`, `fontSize` and `align` style it. Never rotates. `addObjects` also takes `rows` for `cells` |
| `diagram` | a D2 or Mermaid diagram: `text` is its source (at most 20,000 characters), `syntax` is `d2` or `mermaid`, `layout` is `dagre` (default), `elk` or `tala`, `sketch` a boolean and `theme` `light` or `dark`. It is drawn by the MermaiD2 connector when it is connected to the board as `MERMAID2` (see `getDiagramRender`); the drawing is cached beside the board, never stored in the object. `style.fill` and `style.stroke` draw its frame. Never rotates. `addObjects` also takes `source` for `text` and `language` for `syntax` |
| `code` | a code block: `text` is the code, kept verbatim (tabs, blank lines; at most 20,000 characters and 1,000 lines). `language` is an id: `plain`, `javascript`, `typescript`, `json`, `python`, `sql`, `html` (also XML), `css`, `bash`, `yaml`, `markdown`, `go`, `rust`, `java`, `c`, `cpp`, `csharp`, `php`, `ruby` or `diff` (aliases such as `py`, `ts`, `sh`, `c++` are accepted and stored as the id; anything else is ignored). `theme` is `light` or `dark`, `lineNumbers` and `wrap` are booleans (defaults `plain`, `light`, `true`, `false`), `filename` an optional one-line title (120 characters). `style.fontSize` sets the code size; the other style keys are not used. Never rotates. Created without `h`, its height fits the code. Highlighting is computed when drawn (never stored) by bounded, regex-free lexers; a block that would take too much work is drawn plain from that point on |
| `connector` | a line from object `from` to object `to` (neither may be a connector); `fromSide`/`toSide` are `auto`, `top`, `right`, `bottom` or `left`; `routing` is `straight`, `elbow` or `curved`; `text` is an optional label; `style.arrowStart`/`arrowEnd` are `none`, `arrow`, `open`, `triangle` (hollow), `diamond`, `diamondOpen`, `circle`, `bar` or `crow` (crow's foot). Its box is ignored. Route edits (optional, see "Connector routes" below): `segments` and `curve` |

- **Geometry**: `(x, y)` is the top-left of the unrotated box; `rot` is degrees clockwise about its centre.
- **style**: `{fill, stroke, strokeWidth, textColor, fontSize, align, arrowStart, arrowEnd}`, plus `shape` on rectangles and `dash` (`solid`, `dashed` or `dotted`) on rectangles, ellipses, frames, pens and connectors. Colours are `"#rrggbb"` (`fill` and `stroke` also accept `"none"`); `align` is `left`, `center` or `right`. Objects made before `shape` and `dash` existed lack them; read a missing one as `rect` or `solid`.
- **z** is a fractional ordering key (base-62 strings such as `"a0"`, `"a1"`, `"a0V"`); objects stack by `z` then `id`, with frames always below. Omit `z` when creating to put the object on top. A `z` is taken as given when it is at most 64 characters and starts with a letter from `B` to `y` (every key made by stepping from `"a0"` does). Any other key above every object of its group is replaced by a short key on top, one below every object by a short key at the bottom, and anything else is ignored (a create then goes on top).
- **frameId** names the frame an object belongs to. Moving a frame does not move its members by itself: move them in the same request. Deleting a frame leaves its members where they are; their `frameId` is cleared the next time each is written. A create or update whose `frameId` names no object (for example a frame someone just deleted) stores `null` and applies the rest.
- **Deleting an object deletes connectors attached to it** in the same request; they appear in `deletes`.

**Connector routes**: `routing: "elbow"` without `segments` is routed automatically: two short stubs leave the anchors along their sides, and when the simple elbow between them would cross a sticky note, shape, text or icon (padded by 16), the cheapest orthogonal route around them is used (length plus a penalty per bend; frames, pens and connectors are ignored, and so are objects overlapping either end). `routing: "curved"` is a cubic Bézier leaving each anchor along its side. With `fromSide`/`toSide` `auto`, the side pair with the cheapest line is used. Route edits are data, never markup:

- `segments` (elbow only): up to 16 numbers, the positions of the route's middle segments in order from the start. Segments alternate between vertical and horizontal, starting with the one perpendicular to the start side; each value is an offset from the midpoint of the two stub ends on that axis (x for a vertical segment, y for a horizontal one), so moving both ends moves the route and moving one stretches it. Set `fromSide` and `toSide` with it (the UI does), since the list assumes them. `[]` or `null` returns to the automatic route.
- `curve` (curved only): `[u, v]`, the point the curve passes through halfway, as fractions of the line between the anchors: `u` along it from the start, `v` across it (to the right when looking from start to end). Each is clamped to ±8. `null` is the default curve.

Both are cleaned like other fields (non-finite values drop the field; numbers are clamped and rounded), may be omitted, and are not present on connectors stored before they existed.

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
| Code in a code block | 20,000 characters, 1,000 lines; file name 120 characters |
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

`exportData()`, the JSON backup export, the in-app backup and the clipboard (as `application/vnd.cloudflare-os-whiteboard+json;version=1`) share one data-only format: `{format: "cloudflare-os-whiteboard", version: 1, objects, origin?, title?, background?, exportedAt?}`. `objects` lists objects bottom to top (frames first) with `id, type, x, y, w, h, rot, text, style`, plus `frameId`, `points`, the connector fields, `packId, iconId` or the code-block fields; an `id` is only a reference inside the document. Nothing else is read: versions, timestamps, `createdBy` and `z` are ignored, every value goes through the same checks as an ordinary create, a connector is kept only when both ends are in the document, and a `frameId` only when its frame is. At most 5,000 objects and 16 MB of text. The format version is separate from the stored `schemaVersion`; older versions are upgraded on read (version 0 is a `getBoard()` result). `importData()` creates in requests of at most 1,000 objects; errors report the object's position in the document as `index`.

### Storage layout

| Key | Holds |
| --- | --- |
| `meta` | `{schemaVersion, revision, title, background, lastModified}` |
| `obj:<id>` | one object |
| `history` | bounded list of recent changes, with the inverse used by `undo` |
| `requests` | bounded list of recent `requestId` outcomes |
| `render:<id>`, `render:<id>:<n>` | a diagram's cached drawing: `{hash, status, error?, w?, h?, chunks, length}` and its SVG in chunks of 60,000 characters; removed when the diagram is deleted |

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
