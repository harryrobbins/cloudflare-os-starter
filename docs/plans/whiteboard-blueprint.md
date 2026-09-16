# Plan: Whiteboard blueprint (Miro)

Part of the [master plan](collaborative-blueprints.md). Built after the [kanban board](kanban-blueprint.md), from a copy of its package.

**Status: built, not yet deployed (2026-09-16).** The source is [`packages/blueprint-whiteboard`](../../packages/blueprint-whiteboard/README.md). It ships as the bundled format `format.whiteboard` (revision 4) from [`formats/whiteboard.json`](../../formats/whiteboard.json). This page describes the whiteboard as built. The delivery record below lists every departure from the original plan.

**The authoritative RPC and storage reference** is the gadget's own [`src/README.md`](../../packages/blueprint-whiteboard/src/README.md). Where this page and that file disagree, the file wins.

## Delivery record (2026-09-16)

Built in the repo in one session, following the [kanban delivery](kanban-delivery.md) phases, with background agents:

| Phase | What ran |
| --- | --- |
| Spikes | One agent on a real local Cloudflare OS. It checked five things: SVG input in the sandboxed iframe, timers in the Durable Object facet, 30 Hz presence from 3 clients, server-side SVG export, and the "RPC stub was not disposed properly" warning. Stroke simplification was written directly into the contract (`src/shared/simplify.js`). |
| Contract | One author wrote `protocol.js`, `geometry.js`, `render.js`, `simplify.js`, the `Repository`, the store contract, a canvas contract and the README "Programmatic use" section, before any parallel work |
| Parallel streams | A: core and server. B: client sync store. C1: canvas. C2: app shell, harness and harness e2e. Tooling was done by the orchestrator. File ownership was disjoint, in one checkout. |
| Reviews | Three read-only reviewers (server safety, sync correctness with fuzzing, UI and accessibility). Each finding came with a repro script. |
| Fixes | Three fix agents with disjoint file ownership |
| Platform e2e | One agent wrote and ran `e2e/platform.test.mjs` against a local Cloudflare OS. It was re-run on the final code. |

Departures from the plan below, and why:

- **Storage is one key per object (`obj:<id>`), not `objects:<shardId>` values.** A 2,000-object shard would exceed the 128 KiB value limit, the same reason the kanban board keeps one key per card.
- **Frames are objects** (`type: "frame"`). Membership is the member's `frameId`, so the planned "reshard" op is an ordinary field update. Deleting a frame leaves its members alone: their `frameId` reads as null until they are next written. That avoids a 2,000-object cascade, and undoing the frame delete brings the members back.
- **Presence is delivered as arrays of full-state events** and coalesced on the server every 33 ms, latest state wins. The spike found that coalescing at 50 ms added about 40 ms of latency.
- **Clients keep at most one `updatePresence` in flight.** On the local platform a gadget handles roughly 45–50 inbound calls a second, one at a time. Three clients sending at a fixed 30 Hz queued calls for 2–16 s. With one call in flight, cursors arrive at about 15 Hz with 26–31 ms median lag.
- **The hub disposes every callback stub it drops** and never calls `onRpcBroken`. A `dup()`ed stub that is garbage-collected without being disposed logs "An RPC stub was not disposed properly" in production and crashes local workerd. The spike showed this, and the kanban hub had the same bug, now fixed (see below).
- **Rendering goes through one shared node tree** (`src/shared/render.js`). The client builds SVG elements from it, one `<g>` per object patched individually, and the server serialises the same nodes for `exportSvg`. An export is therefore the board as drawn. Text wrapping uses deterministic approximate glyph widths, since the server cannot measure text.
- **Text is edited in an HTML `<textarea>` overlay**, not `foreignObject`. Both worked in the real iframe, but the textarea gives native selection and IME and is simpler to position.
- **`connect` is `connectObjects` on the RPC surface.** A Durable Object stub already has a built-in `connect()` for TCP sockets.
- **The convenience RPCs** were extended beyond the plan:

  | Plan | As built |
  | --- | --- |
  | `getShard` | `getFrame`, with frames given by id or name |
  | — (new) | `findObjects`, `addObjects`, `addStickies`, `arrangeGrid`, `moveObjects`, `updateObjects`, `deleteObjects`, `addFrame` |

  All of them read current versions themselves, so calls from chat never conflict.

**Test status at the end of the build:**

| Suite | Tests passing |
| --- | --- |
| Node unit (shared, core, client store and canvas, fuzz) | 287 |
| workerd (server) | 15 |
| Harness e2e | 27 |
| Local platform e2e | 13 |

**Found only on the real platform or by review, and fixed:**

- **Native undo steals focus.** In the sandboxed iframe, Ctrl+Z outside the editor ran the browser's native undo, which moved focus back into the last edited textarea. The canvas now intercepts it.
- **Slow text wrapping.** Wrapping was quadratic in line length, so a crafted board made `exportSvg` take 107 s inside the mutation queue. It is now linear, with a text budget for exports.
- **Poisoned request ids.** Ids were `clientId:seq`, and the clientId is broadcast, so a peer could pre-record them and silently drop another user's writes. Clients now use a random per-page secret, and replay records match per sender. The kanban board had the same flaw, fixed there too.
- **Under-measured stored sizes.** V8 stores a number in about 12 bytes against 3–4 in JSON. The size measure is now an upper bound of the V8 serialisation, so history cannot exceed 128 KiB.
- **Sync bugs, found with a wider fuzz and targeted repros:**
  - a conflict retry rebased on a stale value, which overwrote a newer change (the kanban store had this too, now fixed);
  - an object deleted and re-created with the same id could vanish from one client;
  - a create or move into a frame someone was deleting was dropped;
  - a slow but alive server was treated as dead, which reloaded the frame;
  - a peer who left during a re-subscribe lingered for about 12 s.
- **Accessibility:** resize, rotate and connecting had no keyboard or button path; the context menu key selected the wrong object; lifting a finger after a long-press ran a menu item; focus rings were weak.

**Known and not fixed:**

- **Warnings around code-edit restarts.** Two runs logged one "RPC stub/result was not disposed properly" warning near a code-edit restart (test T10) or the exports (T9); other runs logged none. An instance the platform aborts for a code update gets no chance to dispose the stubs it holds. The normal churn that caused the kanban warning (reloads, reopened tabs, server load) logs nothing.
- **Connectors.** They have no endpoint handles, so to reconnect one you delete it and draw it again. There is no snapping or alignment guide.
- **No viewport culling.** Performance was checked at 500 objects (60 fps panning); the object cap is 5,000.

**Still to do, by Harry:**

1. `pnpm deploy`. It also ships Board revision 5, with the kanban fixes below.
2. Add a second Access identity, then run the two-browser checks on production and test 8 (agent chat).
3. Optionally publish a blueprint with a screenshot.

**Kanban fixes delivered alongside** (Board revisions 3–5):

- the hub disposes callback stubs and no longer calls `onRpcBroken`, the likely source of the production warning;
- request ids are unguessable and replay records match per sender;
- conflict retries decide from the newest card state.

## Scope

v1, all delivered:

- An infinite canvas with pan and zoom, a minimap, zoom controls and "fit".
- **Objects:** sticky notes, rectangles, ellipses, text labels, straight and elbow connectors between objects (with labels and arrowheads), free-hand pen strokes, and frames (named regions whose members move with them).
- **Editing:** select, Shift-click and marquee multi-select, move, resize, rotate (notes, shapes, text), recolour, edit text inline, bring to front or back, duplicate, delete, and local undo and redo.
- **Keyboard and button alternatives for every gesture:**
  - the Add menu creates objects;
  - arrow keys and the Move buttons move them; Alt+Arrow, `,`/`.` and the Size group resize and rotate;
  - Connect joins two selected objects;
  - the Objects list finds and selects any object;
  - the context menu key opens actions for the selection.
- **Live sync** of every committed change, live remote cursors with names, and live ghosts of objects others are dragging and strokes they are drawing.
- **Follow a collaborator's viewport** from their avatar, or from the "+N" list.
- **Server history** with undo in the Activity panel.
- **AI-usable** through the convenience methods in the gadget README.
- **Exports:** server-side SVG, plus HTML and PDF rendered in the browser.
- **Phones:** a bottom toolbar, a bottom-sheet style bar, one-finger drawing, two-finger pan and pinch, and long-press menus.

Not in v1: images (gadgets have no asset storage), embedded documents, voting, timers, a templates gallery, comments on objects, connector endpoint handles, snapping.

## Data model

Stored in the gadget's Durable Object storage:

```
"meta"       -> { schemaVersion, revision, title, background, lastModified }
"obj:<id>"   -> { id, type, x, y, w, h, rot, z, frameId, text, style, points?, from?, to?, fromSide?, toSide?, routing?, version, createdAt, updatedAt, createdBy }
"history"    -> [ { id, at, by, summary, inverse, undoOf?, undoneBy? } ]   (bounded)
"requests"   -> [ { requestId, senderId, revision, status, conflicts, errors } ]  (idempotency records)
```

- **Types.** `sticky`, `rect`, `ellipse`, `text`, `frame`, `pen`, `connector`. A connector's box is ignored; its route is computed from its endpoints.
- **Pen points** are a flat array normalised to the object's box (each value 0 to 1, 4 decimals). The client simplifies strokes (radial filter, then Ramer-Douglas-Peucker) before committing.
- **Stacking.** Frames always render below everything else. Within a group, objects sort by `z`, a fractional key (`src/shared/order.js`), then by id. Client-supplied keys are accepted up to 64 characters, and the server makes its own short keys past the top or bottom, so no one can jam bring-to-front.
- **Ids** are `o_` or `h_` plus 12 hex digits, generated by the client for optimistic creates.

All rules live in `src/core/whiteboard.js` behind the `Repository` interface. The Durable Object adapter is `src/server/do-repository.js`.

## Committed versus ephemeral state

| Channel | What | Rate | Storage |
| --- | --- | --- | --- |
| **Operations** (`applyOperation` → `callback.operation`) | Object create, delete, final geometry after a gesture, text after editing, style changes | On commit (pointer up, blur, click) | Durable Object storage, versioned, in history |
| **Presence** (`updatePresence` → `callback.presence([...])`) | Cursor, viewport, selection, in-progress `transforms` of dragged objects, in-progress `stroke`, `editingId` | At most one call in flight per client, the latest state sent at most every 33 ms. The hub coalesces per receiver every 33 ms and caps each client at 40 updates/s and each delivery at 512 KiB | Memory only |

Remote clients draw presence transforms as translucent ghosts, and connectors follow the ghosts. When the committing operation arrives, the ghost is replaced by the real object. When a client dies mid-drag, its ghost vanishes:
- **context closed:** under 0.15 s, when a delivery fails;
- **renderer crash:** 1.5–2.5 s;
- **fallback:** every client drops a peer it hasn't heard from for 12 s.

## Concurrency policy

- **Per-object version.** A stale write returns a conflict carrying the authoritative object. The client store handles it:
  - **Geometry** (x, y, w, h, rot) changed by both sides: my delta is re-applied on top of theirs and retried, so two people nudging the same note both get their nudge.
  - **Text, style keys, points or connector fields** changed by both: theirs is kept and the object flashes.
  - **Fields only I changed:** retried as they are.
  - **Deleted meanwhile:** the update is dropped and the object flashes.
  - **A delete that conflicts:** retried, so the delete wins.
  - **Limits:** up to 5 retries, always rebased on the newest state the client holds.
- **Structure.** Title and background are last-writer-wins.
- **Connectors.** Deleting an object deletes its connectors in the same request, and they are listed in `deletes`. A connector whose endpoint is missing is refused with `invalid_ref`.
- **Frames.** A `frameId` naming a missing object is cleared, so a drag into a frame deleted at the same moment still lands.
- **Atomic multi-object changes.** A multi-object move, a frame moving with its members, or a duplicate is one request. Valid ops commit even if others conflict.
- **Idempotency.** Each request carries a `requestId` built from a per-page secret. A request replayed after a lost response or restart returns the recorded outcome.

## Server RPC surface

Summary; full detail in the gadget README.

```
getBoard() / getFrame(frame) / findObjects({type, text, frame, within}) / getHistory(limit)
applyOperation({senderId, by, requestId, objectOps?, structure?})
    -> {status, revision, upserts, deletes, structure, history, conflicts, errors, duplicate?}
undo({senderId, by, historyId?, requestId})     # without historyId: walks back through `by`'s changes
exportSvg({frame?})
subscribe(callback, {clientId, name, color, session?}) -> BoardSnapshot + session
updatePresence({clientId, session, name, color, cursor, viewport, selection, transforms, stroke, editingId}) -> {known, revision}
leavePresence(clientId, session)

# Convenience methods for the agent (frames by id or name, colours by name, versions read for you)
addStickies / addObjects / updateObjects / moveObjects / arrangeGrid / deleteObjects / addFrame / connectObjects
```

`objectOps` entries are `{op: "create", object}`, `{op: "update", id, baseVersion, patch}` or `{op: "delete", id, baseVersion}`.

## Client architecture

Plain DOM and SVG in one bundled `client.js`:

- **Store** (`src/client/sync/store.js`, contract `store-contract.js`). It keeps the kanban machinery:
  - subscription generations, sessions and idempotent replay;
  - heartbeat restart detection;
  - frame reload after a dead stub, carrying the name in `window.name`.

  Added for the whiteboard:
  - an incremental optimistic view: an object's identity changes only when it changed, and a remote event costs O(changed objects), not O(board);
  - the delta rebase described above;
  - local undo and redo, including restoring cascaded connectors;
  - gated presence.
- **Canvas** (`src/client/ui/canvas/`, contract `ui-contract.js`):
  - an SVG camera layer with per-object patching;
  - a separate presence overlay redrawn per animation frame;
  - a gesture state machine (idle, panning, marquee, dragging, resizing, rotating, drawing, editing text, connecting);
  - the textarea editor, touch gestures, keyboard shortcuts and export mode.
- **Shell** (`src/client/ui/*.js`):
  - toolbar, style bar (colours, sizes, Move and Size groups, Connect, reorder);
  - people and follow, minimap and zoom, Objects list and Activity panel;
  - the name dialog, and a polite live region announcing remote changes.
- **Measured** on the local platform:
  - 500 objects pan at 60 fps with zero object re-renders, and a remote single-object update re-renders one element;
  - a ghost follows a remote drag within 25–90 ms;
  - after a code edit, a `use`-role viewer's frame reloads and is live again in 3–4.5 s.

## Server hardening (as built)

- **Caps** (see `LIMITS` in `src/shared/protocol.js`):

  | Item | Cap |
  | --- | --- |
  | Objects | 5,000 |
  | Frames | 50 |
  | Members per frame | 2,000 |
  | Points per pen stroke | 2,000 |
  | Text | 4,000 characters |
  | One object | 64 KiB |
  | All objects | 8 MiB |
  | Ops per request (and items per convenience call) | 1,000 |
  | Objects touched per request, cascades included | 2,000 |
  | History | 200 entries, 100 KiB |
  | Undo inverses | 16 KiB |
  | Subscribers | 200 (idle ones evicted after 32 s when full) |

  Sizes use a conservative measure that bounds both JSON and V8 serialisation.
- **Sanitisers.** Coordinates are clamped to ±1e6, sizes to 1..1e5 and rotation to [0, 360). Types, sides, routing and backgrounds are enums; colours are hex or `none`; unknown keys and prototype keys are dropped. Presence payloads are truncated (100 transforms, 1,000 stroke points, 200 selected ids).
- **Mutation queue.** One transaction per request, with the request record in the same commit. A throwing op cannot stall the queue, and a failed commit drops the cache.
- **SVG export.** Every attribute comes from an enum, a clamped number or a hex colour, and all text is XML-escaped. Text layout is linear, with a budget for the whole export.

## Agent brief

The whiteboard was built in the repo rather than drafted from this brief. The brief is kept to compare against the platform's own vibe-coding:

> Build a Miro-style collaborative whiteboard gadget. An infinite pannable, zoomable SVG canvas with sticky notes, rectangles, ellipses, text labels, connectors between objects, free-hand pen strokes, and named frames that group objects. Select, multi-select with a marquee, move, resize, rotate, recolour, edit text inline, reorder z, duplicate, delete. Several people use the same board at once: committed changes appear live everywhere, and I also want to see everyone's cursor with their name and a translucent ghost of anything they are currently dragging or drawing, before they let go. Keep committed objects in Durable Object storage with a version number per object so concurrent edits produce a conflict rather than an overwrite. Keep cursors, viewports and in-progress drags as ephemeral presence that is broadcast but never stored. Expose `getBoard()` and `applyOperation()` RPCs so an agent can add and arrange objects from chat, an `exportSvg()` RPC, and document them in README.md. Make it work with touch on phones.

## Tests

| # | Test | Automated in |
| --- | --- | --- |
| 1 | A drags a note; B sees the ghost move, then the committed position | harness, platform T1 (ghost within 25–90 ms of each move; commit 25–70 ms after release) |
| 2 | A draws a stroke; B sees it grow, then a committed stroke | harness, platform T2 (commit about 30 ms after release) |
| 3 | A and B move the same note at once; both nudges apply | store unit tests, network tests and fuzz, harness, platform T3 |
| 4 | A deletes a note with a connector; B sees both vanish | harness, platform T4 (about 100 ms) |
| 5 | B follows A; B's view tracks A's until B pans | harness, platform T5 |
| 6 | A's tab dies mid-drag; the ghost goes within 15 s and the note stays committed | harness, platform T6 (0.1–2.5 s) |
| 7 | 500 objects: smooth panning; a remote upsert re-renders only that object | harness, platform T7 (60 fps, 1 object render, 0 full renders) |
| 8 | Agent chat: "add ten stickies with our Q4 priorities and arrange them in a grid" | **manual, on production** (needs a model); the convenience methods are unit-tested |
| 9 | `exportSvg()` output opens and matches the board | render unit tests, harness, platform T9 (SVG, HTML, PDF) |

Also automated:

- **Platform:** use-role chrome (T8); code-edit restart recovery (T10); presence rate, about 15 Hz with a p95 lag under 50 ms (T11); stub disposal under reload churn (T12).
- **Harness:**
  - keyboard-only creating, moving, resizing, rotating and connecting;
  - context menus by key and by long-press;
  - focus handling; the 400 px layout;
  - restarts with stale stubs.

Still to do on production: tests 1–7 with two real browsers and two Access identities, and test 8.

## Promotion

Shipped as a bundled format from [`formats/whiteboard.json`](../../formats/whiteboard.json): `blueprintId` `format.whiteboard` (never change it), and `output` `{ id: "whiteboard", noun: "Whiteboard", plural: "Whiteboards", icon: "flowArrow" }`. `OUTPUT_ICONS` has no canvas icon, so `flowArrow` is the nearest. Run `pnpm --filter blueprint-whiteboard pack:gadget` to rebuild the archive and bump `revision`.

## Follow-ups after v1

- **Connectors and layout:** endpoint handles (reconnect, change sides), snapping and alignment guides.
- **Performance:** viewport culling and lazy loading for boards near the 5,000-object cap.
- **Comments on objects,** reusing the kanban comment model.
- **Viewer identity:** real names on cursors and `createdBy`, and `use`-role viewers who can pan but not edit.
- **Images,** once gadgets can store binary assets.
- **Code-edit restarts:** investigate the one-off "not disposed properly" warnings around them.
