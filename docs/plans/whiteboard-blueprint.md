# Plan: Whiteboard blueprint (Miro)

Part of the [master plan](collaborative-blueprints.md). Build after the [kanban board](kanban-blueprint.md); it reuses that server skeleton and presence code and adds the two hard things: many small objects and high-frequency ephemeral state.

Reference: presence rendering in the Docs client (see [bundled-blueprint-sync-patterns.md](../research/bundled-blueprint-sync-patterns.md), "Docs in detail") and the per-item versioning in [`workspace-sheets.server.js`](../research/bundled-blueprints/workspace-sheets.server.js). Do **not** copy the Slides gadget's full-snapshot rebroadcast; it will not scale to a board with hundreds of objects.

## Scope

v1:

- Infinite canvas with pan and zoom.
- Objects: sticky notes, rectangles, ellipses, straight and elbow connectors between objects, free-hand pen strokes, text labels, and frames (named regions that group objects).
- Select, multi-select (marquee), move, resize, rotate (notes and shapes), recolour, edit text inline, bring to front/back, duplicate, delete.
- Live sync of every committed change; live remote cursors with names; live ghost of objects others are dragging.
- Minimap and "follow user" (jump to a collaborator's viewport).
- AI-usable: the agent can add and arrange objects from chat ("cluster these stickies by theme").
- Export: SVG of the board (server-side, so no rendering dependency), plus the platform's HTML/PDF capture.

Not in v1: images (no asset storage in gadgets), embedded documents, voting, timers, templates gallery, comments on objects (add later using the kanban comment model).

## Data model

Objects are small and numerous, so shard by frame rather than putting everything in one value. Objects outside any frame live in the root shard.

```
"meta"               -> { revision, title, frameOrder: [frameId], frames: { frameId: {id, name, x, y, w, h, version} }, background, lastModified }
"objects:<shardId>"  -> { objId: { id, type, x, y, w, h, rot, z, style: {fill, stroke, font, size}, text?, points?, from?, to?, frameId, version, createdBy, updatedAt } }
"history"            -> bounded list of applied ops with inverses (undo)
```

`shardId` is `root` or a `frameId`. Moving an object into or out of a frame moves it between shards in one mutation. A shard is capped at 2,000 objects; the client refuses to add more to a full frame and suggests a new one. Pen strokes store simplified points (Douglas-Peucker in the client before commit) capped at 2,000 points per stroke.

`z` is a fractional order key like the kanban `order`, so bring-to-front is one write.

## Committed versus ephemeral state

This is the design decision that makes a whiteboard feel right. Two channels over the same RPC session:

| Channel | What | Rate | Storage |
| --- | --- | --- | --- |
| **Operations** (`applyOperation` → `broadcast`) | Object create, delete, final position and size after a drag, text after editing, style changes | On commit only (pointer up, blur) | Written to `ctx.storage`, versioned, in history |
| **Presence** (`updatePresence` → `broadcastPresence`) | Cursor position, viewport, current selection, the *in-progress* transform of dragged objects (`{objId, x, y, w, h, rot}`), the in-progress pen stroke | Throttled to 30 to 40 ms on the client | Memory only, never stored |

Remote clients render presence transforms as a translucent ghost over the last committed object state. On the committing `applyOperation`, the ghost is replaced by the real update. If a client dies mid-drag, its presence expires and the ghost vanishes, leaving the committed state. This is the same separation the Docs client applies to carets ("must never enter persisted HTML").

Server side, presence handlers do no storage I/O and no queueing; they just fan out. If it turns out fan-out of one cursor to N peers at 30 Hz is too chatty for large sessions, coalesce on the server: keep the latest presence per client and flush all of them every 50 ms with one `presenceBatch` call per subscriber.

## Concurrency policy

- **Per-object version** on every committed write; stale write returns `conflict` with the authoritative object. Client policy: for a move or resize conflict, re-apply the delta against the authoritative object and retry once (both people nudging the same note ends up with both nudges); for text or style, keep the authoritative value and flash the object.
- **Frames**: per-frame version for name and bounds.
- **Structure** (`frameOrder`, background): last-writer-wins.
- **Connectors**: reference `from`/`to` object ids. Deleting an object deletes its connectors in the same mutation, and the broadcast lists them in `deletes`.
- **Multi-object moves** are one `applyOperation` with many `objectOps`, applied atomically in the queue; partial conflict returns applied and conflicted sets separately.

## Server RPC surface

```
getBoard()                                       -> full snapshot
getShard(shardId)                                -> one shard (for lazy loading large boards)
applyOperation({senderId, by, objectOps?, frameOps?, structure?})
                                                 -> {status, revision, upserts, deletes, conflicts}
subscribe(callback, {clientId, name, color})     -> snapshot (meta + all shards; switch to meta + root and lazy shards if boards get big)
updatePresence({clientId, name, color, cursor: {x, y}, viewport: {x, y, zoom}, selection: [objId], transforms: [{objId, x, y, w, h, rot}], stroke?: {points, style}})
leavePresence(clientId)
undo({senderId, by})                             -> applies the inverse of the last history entry by this `by`, if still valid
exportSvg()                                      -> string
```

`objectOps` entries: `{op: "upsert"|"delete"|"reshard", shardId, objId, baseVersion, object?, toShardId?}`.

Presence rendering contract for the client: `{type: "cursor", clientId, name, color, cursor, viewport, selection, transforms, stroke, at}`.

Document all of this in the gadget README under "Programmatic use".

## Client architecture

- **Rendering**: SVG for objects, connectors and strokes (crisp at any zoom, easy hit testing, and the server-side SVG export can share the same serialiser). A single `<svg>` with a transformed `<g>` for the camera. Presence (cursors, ghosts, selection boxes of others) in a separate overlay `<svg>` so it re-renders independently of committed objects.
- **Camera**: `{x, y, zoom}`; wheel to zoom about the pointer, space-drag or two-finger to pan, pinch on touch.
- **Interaction state machine**: `idle`, `panning`, `marquee`, `dragging`, `resizing`, `rotating`, `drawing`, `editingText`, `connecting`. Each transition either sends presence (in-progress) or commits an operation (on completion).
- **Incremental rendering**: keep a `Map<objId, SVGElement>`; on remote `upserts`, patch the element rather than rebuild the board. Only `applySnapshot` rebuilds.
- **Text editing**: a `foreignObject` with a `contenteditable` div for inline editing; commit on blur or Escape.
- **Connectors**: recompute endpoints on the client from the current (committed or ghost) geometry of the two endpoints; store only ids and an anchor side.
- **Undo/redo**: local stack of inverses for own ops; the server `undo` is the fallback for undoing the last own change after a reload.
- **Presence**: throttle `updatePresence` to 33 ms while the pointer moves, plus the 4 s heartbeat; expire at 12 s. Cursor labels are the collaborator's name in their colour. "Follow" sets the local camera to the followed user's `viewport` on each presence event until the user pans.
- **Re-subscribe** on `[Symbol.dispose]`, replaying unsent ops.
- **Export mode**: when `gadgetExportFormatId` is set, fit the camera to the bounding box of all objects, hide presence, and stop.
- **Phones**: touch pan and zoom, tap to select, long-press for the context menu; drawing works with one finger when the pen tool is chosen.

## Server hardening checklist

- Caps: 50 frames, 2,000 objects per shard, 2,000 points per stroke, 4 KiB text per object, 200 history entries.
- Numeric sanitiser: clamp coordinates to ±1e6, sizes to 1..1e5, rotation to 0..360, zoom to 0.05..20.
- Whitelist `type` and style keys; hex colours only.
- Reject connectors whose endpoints do not exist.
- Presence payload cap: at most 100 `transforms`, 2,000 stroke points, drop anything larger silently.
- `senderId` echo suppression on both channels.
- All committed mutations through `enqueueMutation`; presence bypasses it.

## Agent brief

> Build a Miro-style collaborative whiteboard gadget. An infinite pannable, zoomable SVG canvas with sticky notes, rectangles, ellipses, text labels, connectors between objects, free-hand pen strokes, and named frames that group objects. Select, multi-select with a marquee, move, resize, rotate, recolour, edit text inline, reorder z, duplicate, delete. Several people use the same board at once: committed changes appear live everywhere, and I also want to see everyone's cursor with their name and a translucent ghost of anything they are currently dragging or drawing, before they let go. Keep committed objects in Durable Object storage, sharded by frame, each object with a version number so concurrent edits produce a conflict rather than an overwrite. Keep cursors, viewports and in-progress drags as ephemeral presence that is broadcast but never stored. Expose `getBoard()` and `applyOperation()` RPCs so an agent can add and arrange objects from chat, an `exportSvg()` RPC, and document them in README.md. Make it work with touch on phones.

Then append the collaboration-pattern sentence from the master plan.

## Tests (two-browser session)

1. A drags a note; B sees the ghost move smoothly and then snap to the committed position on release.
2. A draws a stroke; B sees it appear point by point, then as a committed stroke.
3. A and B move the same note at once; both nudges end up applied, no note lost.
4. A deletes a note with a connector; B sees both vanish.
5. B clicks "follow A"; B's viewport tracks A's until B pans.
6. A kills the tab mid-drag; the ghost disappears within 15 s and the note is at its last committed position.
7. 500 objects on the board: panning stays smooth in both browsers; a remote upsert does not cause a full re-render (check with the performance panel).
8. Agent chat: "add ten stickies with our Q4 priorities and arrange them in a grid"; they appear live.
9. `exportSvg()` output opens in a browser and matches the board.

## Promotion

`output`: `{ id: "whiteboard", noun: "Whiteboard", plural: "Whiteboards", icon: "flowArrow" }`. `OUTPUT_ICONS` is a closed set with no canvas icon; `flowArrow` is the nearest, and adding a proper one is a `workshop-shared` plus frontend change. Blueprint id if bundled: `format.whiteboard`.

## Follow-ups after v1

- Comments on objects, reusing the kanban comment model.
- Lazy shard loading and viewport culling for very large boards.
- Server-side presence coalescing if sessions exceed ~10 concurrent editors.
- With viewer identity: real names on cursors and `createdBy`, and `use`-role viewers who can pan but not edit.
- Images, once gadgets have a way to store binary assets (currently none).
