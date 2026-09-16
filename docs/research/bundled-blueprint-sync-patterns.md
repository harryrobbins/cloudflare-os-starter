# How the bundled Docs, Sheets and Slides blueprints do multi-user sync

Decoded from the three `.gadget` archives in `cloudflare-os/packages/workshop-backend/format-blueprints/` (pin `90f0591`). The decoded `server.js` and `README.md` of each are in [bundled-blueprints/](bundled-blueprints/); the client bundles are 70 KB to 150 KB each and are not checked in, decode them with `extract-gadget.mjs` when needed.

These three are the only worked examples of collaborative gadgets we have, and the plans copy their conventions deliberately so the AI agent, which was trained on the same prompt that produced them, finds the code familiar.

## The shared skeleton

All three follow the same shape. Server:

```js
import { DurableObject } from "cloudflare:workers";

export class Gadget extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.subscribers = new Map();          // callback stub -> {clientId, name, color}
    this.mutationQueue = Promise.resolve(); // serialises overlapping RPCs
  }

  enqueueMutation(fn) {
    const result = this.mutationQueue.then(fn);
    this.mutationQueue = result.catch(() => {});
    return result;
  }

  async subscribe(callback, client = {}) {
    const dup = callback.dup();            // long-lived stub; the param is disposed at return
    this.subscribers.set(dup, {...});
    dup.onRpcBroken(() => { this.subscribers.delete(dup); /* broadcast leave */ });
    // replay current roster to the newcomer, announce newcomer to the room
    return this.assembleDocument(await this.loadMeta());   // full snapshot
  }

  async broadcast(event) {
    await Promise.all([...this.subscribers.keys()].map(stub =>
      Promise.resolve(stub.operation(event)).catch(() => this.subscribers.delete(stub))));
  }
}
```

Client:

```js
const clientId = Math.random().toString(36).slice(2);
class Callbacks extends RpcTarget {          // RpcTarget is a pre-injected global
  operation(event) { event.type === "snapshot" ? applySnapshot(event.document) : applyRemoteOperation(event); }
  presence(event)  { applyPresence(event); }
}
const doc = await gadget.subscribe(new Callbacks(), { clientId, name, color });
applySnapshot(doc);
```

Every mutating RPC carries `senderId: clientId`, and `applyRemoteOperation` ignores events whose `senderId` matches its own, because the caller already applied the change optimistically.

Note the bundled clients do *not* implement the `[Symbol.dispose]` re-subscribe the agent prompt recommends. They rely on the page reloading after a facet restart. The plans should add it.

> **Update 2026-09-16:** the kanban build found that `[Symbol.dispose]` and `onRpcBroken` never fire on the real runtime. It detects restarts with a heartbeat that returns `{known, revision}`, and reloads the frame when the stub is dead. See `packages/blueprint-kanban/src/client/sync/store.js` and the master plan's gaps table. The whiteboard build later found that the bundled servers' pattern of keeping `callback.dup()` stubs without ever disposing them logs "An RPC stub was not disposed properly" when they are garbage-collected. `packages/blueprint-whiteboard/src/core/hub.js` disposes each stub when its entry is removed.

## Side by side

| | Docs (`format.document`) | Sheets (`format.spreadsheet`) | Slides (`format.slides`) |
| --- | --- | --- | --- |
| Unit of conflict | Block (paragraph) | Cell | Whole deck |
| Concurrency rule | Per-block `baseRevision`; stale write returns `conflict` with the authoritative block | Per-cell `baseVersion`; stale write returns `conflict` with the authoritative cell. Structure (sheet list, sizes, title) is last-writer-wins | None; every mutation re-sends the full deck |
| Broadcast payload | Diff: `upserts`, `deletes`, `revision` | Diff: `upserts`, `deletes`, `structure`; full cell map only for `sheetReplacements` (sort, clear, insert/delete) | Full deck snapshot |
| Storage keys | `document:v2` `{revision, title, blocks}` | `meta` plus `cells:<sheetId>` `{A1: {value, fmt, version}}` | one deck record |
| Presence | Caret and selection per collaborator, drawn as coloured carets with name labels; 70 ms debounce on `selectionchange`; 4 s heartbeat, 12 s stale expiry | Cell-range per collaborator on the wire; **rendering disabled in the UI** ("presents as a single-user spreadsheet even though remote operations still synchronize") | Roster only |
| Undo | Local | Local, cleared on structural edits | Broadcast |
| Server size | 16 KB | 14 KB | 28 KB |
| Export | HTML/PDF via platform, plus a Google Docs sync binding | Per-sheet CSV via `ExportHandler extends WorkerEntrypoint` | HTML/PDF via platform |

## Sheets in detail

Server RPC surface (`workspace-sheets.server.js`):

- `getDocument()` → `{revision, title, sheetOrder, sheets, cells, lastModified}`. Also the documented entry point for the AI agent and scripts to read the workbook.
- `applyOperation({senderId, structure?, sheetReplacements?, cellOps?})` → `{status: "applied"|"unchanged"|"conflict", revision, upserts, deletes, conflicts, ...}`. One mutation queue serialises overlapping calls. Cell ops carry `baseVersion` (0 for a new cell). A delete is `value: null, fmt: null`.
- `subscribe(callback, {clientId, name, color})`, `updatePresence({clientId, sheetId, r1, c1, r2, c2})`, `leavePresence(clientId)`.
- Sanitisers cap everything: 50,000 rows, 702 columns, 8,192 chars per cell, 200-char titles, 200,000 cells per replacement, a closed set of format keys.

Client (`client.js`, 129 KB): the whole grid, formula engine (100+ functions, cross-sheet refs, cycle detection) and clipboard live in the browser. Edits go to a local model immediately, then a debounced save batches `cellOps`. `applyRemoteOperation` merges peers' diffs into the model and re-renders. Presence is sent every 4 s and on selection change but `renderPresence()` is a no-op in this build.

## Docs in detail

Blocks are `{id, type, html, revision}`. The client is a `contenteditable` editor whose DOM children are blocks; `serializeBlocks()` diffs the DOM against the model to produce `upserts`/`deletes` with `baseRevision`. The server rejects stale blocks and returns them so the client can rebase. There is also `setDocument()` for wholesale replacement (used by the agent) and `initializeBlocks()` for the legacy-HTML migration.

Presence is the reference implementation for live cursors on this platform: `sendPresence()` serialises the DOM selection to `{anchorBlockId, anchorOffset, focusBlockId, focusOffset}`, the server rebroadcasts it, and `renderPresence()` maps it back to DOM ranges and draws an absolutely positioned caret layer. A comment in the client says "Presence decoration is ephemeral UI and must never enter persisted HTML." Heartbeat and stale-expiry constants: `PRESENCE_HEARTBEAT_MS = 4000`, `PRESENCE_STALE_MS = 12000`.

## Slides in detail

Coarse by design: "store with realtime broadcast. Mutations are coarse: any change re-sends". Fine for a deck a few people edit; a poor model for a whiteboard with many small objects.

## What upstream did next

Upstream `main` extracted this skeleton into `packages/bundled-blueprints/libraries/sync/` (`MutationQueue`, `applyVersioned`, a subscriber registry on the server; `PresenceRoster`/`PresenceReporter` on the client), and rewrote the three gadgets in TypeScript on top of it. That library is the natural base for the plans if the submodule is moved forward; until then, the plans copy the pattern from Sheets and Docs by hand.

## Lessons the plans adopt

1. **Version per independently editable item.** Card, sticky note, message. Reject stale writes and return the authoritative item so the client can rebase or show a conflict.
2. **Last-writer-wins for coarse structure** (column order, board title, canvas viewport defaults). Cheap and rarely contended.
3. **Broadcast diffs, not snapshots.** Send a snapshot only on `subscribe` and after a bulk replace.
4. **Presence is ephemeral.** Never persisted, throttled to tens of milliseconds, heartbeat plus stale expiry so a killed tab disappears.
5. **`senderId` echo suppression** so the originating client does not double-apply.
6. **Serialise mutations** through a promise queue; the DO is single-threaded but `await` points inside a handler interleave.
7. **Sanitise every field** on the server. The client is untrusted code running in a peer's browser.
8. **Expose a plain RPC read/write surface** (`getDocument`, `applyOperation`) and document it in the README, because that is how the AI agent will populate and edit the gadget from chat.
9. **Keep client state in memory and re-subscribe on facet restart.** There is no client-side storage.
