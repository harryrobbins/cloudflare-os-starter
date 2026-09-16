# Plan: Wave blueprint (Google Wave)

Part of the [master plan](collaborative-blueprints.md). Build last. It adds the one thing the [kanban board](kanban-blueprint.md) and [whiteboard](whiteboard-blueprint.md) did not need: several people typing in the same paragraph at the same time.

## Start here: notes for the agent building Wave

Written 2026-09-16, after the kanban board and whiteboard were both built in this repo and deployed (`format.board` revision 5, `format.whiteboard` revision 4). **These notes override anything older below them.**

### Read first, in this order

1. The master plan's [gaps table](collaborative-blueprints.md#what-the-platform-does-not-give-us). Several rows were found only on a real instance, and each cost time: facet restarts, dead stubs after a code edit, prefix bindings, no forms, stub disposal, the RPC rate, `connect()`, V8 sizes, request ids and native undo.
2. [whiteboard-blueprint.md](whiteboard-blueprint.md), "Delivery record". It covers the process that worked, what the spike measured, what the reviews found, and what is still known-broken.
3. [kanban-delivery.md](kanban-delivery.md), for the phase template: spikes → contract → parallel streams → reviews → fixes → local platform e2e → pack → deploy.
4. The whiteboard package's [`README.md`](../../packages/blueprint-whiteboard/README.md), [`harness/README.md`](../../packages/blueprint-whiteboard/harness/README.md) and [`e2e/README.md`](../../packages/blueprint-whiteboard/e2e/README.md).

### Start from a copy of `packages/blueprint-whiteboard`, not the kanban package

The whiteboard is the newer and more hardened copy of the same skeleton. Copy it to `packages/blueprint-wave`. Delete the whiteboard-specific `src/core/whiteboard.js`, `src/client/model`, `src/client/ui`, `src/shared/{geometry,render,simplify}.js` and their tests. Keep:

| Part | Why it matters for Wave |
| --- | --- |
| `src/core/hub.js` | Sessions and backpressure, plus what the kanban hub lacks: stubs are disposed on replace, leave and drop; presence is coalesced (33 ms, latest state wins, arrays delivered); presence is capped at 512 KiB per delivery and 40 updates/s per client; idle subscribers are evicted when the board is full. Carets go through it unchanged; only `cleanPresence` changes. |
| `src/client/sync/store.js` | Subscription generations, verbatim idempotent replay, heartbeat restart detection, frame reload on a dead stub. Also: one `updatePresence` in flight; request ids from a per-page secret; `onUnrecoverable` that tolerates a slow server; peers reconciled after a re-subscribe. Use it for the **structure** channel (blips, participants, reads). |
| `src/shared/protocol.js` `storedBytes`, `cleanPresence`, `isRequestId`, `newSession` | `storedBytes` bounds the V8 serialisation, not JSON. Use it for every cap, including Yjs state. |
| `src/core/repository.js` + `src/server/do-repository.js` | One transaction per commit, writes in batches of 128 |
| `test/client/net.js` + `fuzz.test.js` | A real-core network simulator with latency, reordering (`FIFO=0`) and restarts fenced by epoch, plus a seeded convergence fuzz. Extend it with text updates: it is the fastest way to find sync bugs. |
| `harness/` + `e2e/harness-helpers.mjs` | The multi-pane simulator mirroring the platform prefix, sandbox, CSP and stale stubs. Pass `HARNESS_PORT` to avoid clashing with a harness someone already has on 8790. |
| `e2e/start-local-platform.sh`, `platform-helpers.mjs`, `platform-whiteboard-helpers.mjs` | The start script boots a local Cloudflare OS on WSL, and rebuilds the frontend if a deploy left it in Access mode. The helpers cover sign-up, upload, share, export and scanning the platform log for "not disposed properly" or runtime crashes. |
| `scripts/` | esbuild bundling (unminified), deterministic packing, and the revision lock. Point `pack-gadget.mjs` at `formats/wave.*`. |

### Changes to this plan that follow from the builds

- **Yjs is just an import.** Both `server.js` and `client.js` are esbuild bundles built from `src/` (see `scripts/build.mjs`). Ignore the hand-concatenation, `lib/yjs.js` and `lib/client-app.js` steps below. They were for the Workshop-agent route, which neither build used. Add `yjs` as a devDependency; the kanban package already pins `yjs` 13.6.31.
- **Spike binary RPC first.** Before writing the contract, on the local platform, check that a `Uint8Array` round-trips through both hops (browser → Workshop → facet, and facet → callback → browser) with its type intact, and that stored `Uint8Array`s come back as such. The whiteboard spike did not test binary. If it fails, base64 in strings works everywhere; size the caps for the 4/3 overhead.
- **Budget the RPC rate.** A gadget handled about 45–50 inbound calls a second, one at a time, on the local platform. The plan's `pushTextUpdate` on a 50 ms timer is 20 calls/s per typist, before presence, so three typists would saturate it. Keep at most one `pushTextUpdate` in flight per client per blip. Merge queued updates with `Y.mergeUpdatesV2` while one is in flight. Send carets through the gated presence path. Measure with three browsers in the platform e2e, as whiteboard test T11 does.
- **Size values by V8, not JSON.** A value is capped at 128 KiB, and V8 stores a number in about 12 bytes. The `updates:<id>` list is one value, so a burst of small updates can outgrow it before the 200-entry compaction trigger. Compact by `storedBytes`, not by count. Consider one key per update (`upd:<blipId>:<seq>`), listed by prefix, as the kanban board does for comments.
- **Idempotency for text.** Yjs makes a duplicate text update harmless, but `pushTextUpdate` still appends to storage and history. Carry a `requestId` built from the per-page secret, or de-duplicate by update hash, so a replay after a restart does not double the log or the playback.
- **Stub disposal.** Every `callback.dup()` must be disposed exactly once when its entry leaves the hub. An undisposed dup that is garbage-collected crashes local workerd and logs a warning in production. Disposal never reaches the client's `[Symbol.dispose]`, so don't rely on it for reconnects.
- **Don't name an RPC method `connect`.** A Durable Object stub already has a built-in `connect()` for TCP sockets, so `env.Wave.connect()` never reaches the gadget. `fetch` is taken the same way.
- **Unguessable request ids.** Client ids are broadcast, so request ids must not be derived from them. Replay records must match per `senderId`, or a peer can make another user's writes vanish as duplicates.
- **Undo inside a `contenteditable`.** In the sandboxed iframe, Ctrl+Z outside a text field runs the browser's native undo, which moves focus into the last edited field. Inside the editor you want `Y.UndoManager`, not native undo. Intercept Ctrl/Cmd+Z, Shift+Z and Y in a capture-phase `keydown` in both cases. See `src/client/ui/canvas/index.js` in the whiteboard.
- **Clipboard.** `navigator.clipboard` is blocked by permissions policy. Handle paste with the `paste` event's `clipboardData`, and sanitise it to the tiny rich-text model.
- **Accessibility.** The UI review is part of the gate, and it failed both earlier builds on keyboard alternatives. Plan from the start:
  - a keyboard path to every blip and reply action;
  - roving tabindex in toolbars;
  - focus restored after dialogs and deletes;
  - visible `outline` focus rings;
  - 44 px targets on phones;
  - no `<form>`, `alert`, `confirm` or `localStorage`.
- **Presence of carets.** Relative positions are binary. Give `cleanPresence` a size cap per caret, and drop malformed carets rather than rejecting the whole update.

### Process lessons

- **Contract first, one author.** Parallel streams against the contract worked twice. Give each stream a disjoint file list, and expose a small internal interface between canvas and shell (the whiteboard's `ui-contract.js`) so the UI can split into two streams.
- **Reviews with repro scripts, then fix agents with disjoint ownership.** Each reviewer writes runnable repros in the scratchpad; each fix agent turns them into regression tests. The sync reviewer's widened fuzz (`SEEDS=1..20 STEPS=1500 MAXLAT=120 FIFO=0`) found bugs the default fuzz missed.
- **API session limits stop background agents mid-task.** Their files stay on disk. Resume each agent with SendMessage rather than starting over, and check for leftover servers (`ps -ef | grep -E 'wrangler|workerd|serve.mjs'`), because a stopped agent does not stop its platform.
- **Don't commit while agents edit.** The gitleaks pre-commit hook stashes unstaged files for a moment, which can clobber an agent's in-flight edit. An agent that runs `git stash` does the same.
- **Check exit codes, not grep output.** `cmd | grep Tests && git commit` commits even when tests failed.
- **Repack after any source change.** `pnpm check` fails when any `formats/*.gadget` is stale, including the board's after a kanban-only fix.
- **Local platform.** Run one at a time and stop it when done. `pnpm check` and `pnpm deploy` leave `workshop-frontend/dist` built in Access mode; the whiteboard start script detects that and rebuilds.

### Known open items you may hit

- **Stub warnings around code edits.** An instance aborted by a code edit cannot dispose what it holds, so an "RPC stub/result was not disposed properly" warning can appear around a code-edit restart. It is harmless, but the platform e2e should record it rather than fail on it.
- **Production tests are pending** for both earlier boards: the two-browser checks (they need a second Access identity) and agent chat. Wave test 9 is in the same position.

Reference: the Docs gadget's block model and caret presence ([bundled-blueprint-sync-patterns.md](../research/bundled-blueprint-sync-patterns.md), "Docs in detail"). Docs stops at block-level conflicts, which is exactly the limit Wave has to get past.

## What Wave was, and what we keep

A wave is a threaded conversation where every message ("blip") is a live, editable rich-text document, replies nest inline, anyone can edit anyone's blip, and a playback slider replays the wave's history. We keep:

- A wave with a title and a tree of blips (root blips, inline replies at a position inside a parent, and end-of-thread replies).
- Every blip is co-editable by everyone with real character-level merging and live carets.
- Participants list, "unread" markers per participant, and playback of history.
- Gadgets inside blips are out of scope (that would be gadgets in gadgets).

Not in v1: federation, per-blip permissions, attachments, notifications, search across waves.

## The core decision: inline a CRDT

Block-level versioning (Docs) makes two people typing in one blip conflict on every keystroke. The right tool is a text CRDT. The gadget sandbox has no npm at runtime, but the two sides load code differently, and the plan has to respect both (verified in `overseer.ts` on our pin):

- **Server:** every `.js` file in the gadget becomes a module for the Dynamic Worker Loader, keyed by its path, so `server.js` can `import * as Y from "./lib/yjs.js"`.
- **Client:** `getUiBundle` returns the text of `client.js` alone and the iframe runs it as one inline script with `connect-src 'none'`. It cannot import a sibling file. Yjs has to be *inside* `client.js`.

So:

1. Build Yjs once as a single self-contained ES module, roughly 90 KB minified, with esbuild locally: `esbuild --bundle --format=esm --minify yjs -o yjs.esm.js`. Check the output has no bare imports.
2. Save it as `lib/yjs.js` in the gadget for the server.
3. For the client, keep the application code in `lib/client-app.js` during development and produce `client.js` by concatenating the Yjs build (with its `export` statements rewritten to a `const Y = {...}` binding, which esbuild's `--format=iife --global-name=Y` does directly) followed by the app code. A ten-line Node script in this repo does the concatenation; commit it beside the blueprint. The bundled Sheets client is already 129 KB, so a 200 KB `client.js` is within normal range.
4. The whole `.gadget` archive stays far under the 32 MiB content cap.

The agent must be told not to `import` anything in `client.js` and to treat the global `Y` as given.

The Workshop itself already syncs gadget *source* through Yjs, so the platform has no objection to the algorithm; we are just running it inside a gadget for the gadget's own data.

Alternative considered and rejected: writing a minimal RGA or Fugue CRDT by hand. Feasible, but Yjs' snapshot and update encoding, undo manager and awareness-style relative positions are exactly what playback and carets need, and a hand-rolled one would be the least tested part of the system.

## Data model

One Yjs document per blip keeps updates small and lets blips load lazily. Wave structure stays in plain versioned records like the other plans.

```
"meta"                -> { revision, title, participants: [{id, name, color}], rootBlipIds: [blipId], lastModified }
"blip:<id>"           -> { id, parentId, anchor: {type: "end"} | {type: "inline", index}, childIds: [], author, createdAt, version, deleted }
"text:<id>"           -> Uint8Array   (Yjs V2 state of the blip's Y.XmlFragment, the full state)
"updates:<id>"        -> [Uint8Array] (incremental updates since the last compaction, capped)
"read:<participantId>"-> { blipId: lastSeenClock }
"history"             -> [ { at, by, kind: "blip.create"|"blip.delete"|"text", blipId, update?: Uint8Array } ]  (bounded, for playback)
```

Compaction: when `updates:<id>` exceeds 200 entries or 256 KiB, fold them into `text:<id>` and clear the list, inside one mutation.

## Sync protocol

Structure (blips, participants, reads) uses the standard operation channel from the kanban plan: `applyOperation` with per-blip versions, diff broadcast, conflict responses.

Text uses a second, CRDT-specific path:

```
openBlip(blipId)                                   -> { state: Uint8Array, clock }
pushTextUpdate({senderId, blipId, update: Uint8Array})
                                                   -> { clock }        (server applies to its Y.Doc, appends to updates:<id>, broadcasts)
```

Broadcast event: `{type: "text", senderId, blipId, update, clock}`. Peers call `Y.applyUpdateV2(doc, update)`; Yjs makes order and duplicates irrelevant, so a dropped or reordered broadcast is harmless and a re-subscribe can simply re-open the blip and get the merged state.

The server keeps a `Map<blipId, Y.Doc>` in memory as a cache, hydrated from `text:` plus `updates:` on first touch and evicted after ten minutes idle. Memory is a cache only; every update is written to storage before the broadcast, per the platform rule "always store server state in Durable Object storage".

Carets go over presence, encoded as Yjs relative positions (`Y.createRelativePositionFromTypeIndex`) so they stay correct as text shifts under them. Presence payload: `{clientId, name, color, blipId, anchor: RelativePosition, head: RelativePosition}`. Rendering follows the Docs caret layer.

## Concurrency policy

- **Text inside a blip**: CRDT merge, no conflicts by construction.
- **Blip tree**: per-blip version for `deleted`, `anchor` and `parentId`; `childIds` ordering last-writer-wins within a parent (rare contention).
- **Inline reply anchors**: stored as a Yjs relative position into the parent's text, not an integer index, so the anchor survives edits above it.
- **Participants**: append-only set with last-writer-wins on name and colour.
- **Reads**: per participant, per blip, a Yjs clock; only that participant writes their own record.

## Playback

`history` records blip creations and deletions with timestamps, plus a pointer into each blip's update log. Playback on the client: start from empty docs, apply updates in timestamp order up to the slider position, render. Because Yjs updates are timestamped by us on receipt, playback is per-server-time, which is what Wave did too. Cap history at 5,000 entries; beyond that, playback starts from the oldest retained compaction snapshot.

## Server RPC surface

```
getWave()                                        -> { meta, blips: {id: blipRecord} }   (no text)
openBlip(blipId)                                 -> { state, clock }
pushTextUpdate({senderId, blipId, update})       -> { clock }
applyOperation({senderId, by, blipOps?, participantOps?, structure?})
                                                 -> {status, revision, upserts, deletes, conflicts}
markRead({participantId, blipId, clock})
getPlayback({from, to})                          -> [historyEntry]
subscribe(callback, {clientId, name, color})     -> { meta, blips }
updatePresence({clientId, name, color, blipId, anchor, head})
leavePresence(clientId)
getBlipText(blipId)                              -> plain text  (for the agent)
setBlipText({blipId, text, by})                  -> { clock }   (for the agent; a delete-all plus insert as one Yjs transaction)
```

`blipOps` entries: `{op: "create"|"delete"|"restore"|"move", blipId, baseVersion, blip?, parentId?, anchor?}`.

## Client architecture

- **Editor per blip**: a `contenteditable` bound to a `Y.XmlFragment` with a small hand-written binding (insert, delete, bold, italic, link, list). Do not try to port a full ProseMirror or Tiptap bundle in v1; the binding for a paragraph-and-inline-marks model is a few hundred lines and the Docs client already has most of the DOM plumbing (selection to offset, offset to DOM point).
- **Lazy open**: blips render collapsed with a plain-text preview from `getWave()` until scrolled into view or focused, then `openBlip` and bind.
- **Local Y.Doc per open blip**; `doc.on("update", ...)` batches into `pushTextUpdate` on a 50 ms timer; incoming `text` events apply directly.
- **Undo**: `Y.UndoManager` per blip, tracking the local origin only, so undo never reverts a colleague's typing.
- **Threading UI**: root blips as cards in a column; inline replies rendered as an indented block at the anchor; end replies below. A "reply here" affordance at the caret creates an inline reply anchored at the current relative position.
- **Unread**: blips whose clock exceeds the participant's `read` record get a marker; scrolling a blip fully into view for a second marks it read.
- **Playback**: a slider in the header; dragging it swaps the live docs for replay docs built from `getPlayback()`.
- **Presence**: carets and selections per blip, Docs-style; participants in the header with a coloured dot on whoever is typing.
- **Re-subscribe** when the heartbeat reports `known: false`: re-run `subscribe`, then `openBlip` for every open blip and merge (Yjs makes the merge trivial). Reload the frame when the stub is permanently dead, as the kanban store does.
- **Export**: when `gadgetExportFormatId` is set, render every blip expanded and read-only.

## Server hardening checklist

- Caps: 2,000 blips per wave, 64 KiB of Yjs state per blip, 200 pending updates before compaction, 5,000 history entries, 100 participants.
- Validate that `update` is a `Uint8Array` and that `Y.applyUpdateV2` on a scratch doc succeeds before touching the real doc, so a malformed update cannot poison a blip.
- Blip ids and participant ids by regex; anchors decoded through Yjs' own relative-position parser.
- `senderId` echo suppression is optional for text (Yjs ignores duplicates) but keep it to save work.
- All structure mutations through `enqueueMutation`; text updates through a per-blip queue so two updates to one blip are applied and stored in order.

## Agent brief

> Build a Google Wave-style collaborative conversation gadget. A wave has a title, a participant list and a tree of messages called blips. Root blips are shown in order; a reply can be attached at the end of a thread or inline at a position inside the parent's text. Every blip is a rich-text document that anyone can edit at the same time as anyone else, character by character, with live coloured carets showing where each person is typing. Use Yjs on both sides: on the server import it from `lib/yjs.js`; in `client.js` it is already present as the global `Y` at the top of the file, so do not import anything there. One Y.Doc per blip, incremental updates pushed to the server, stored in Durable Object storage and broadcast to peers, with periodic compaction. Keep the blip tree and participants as plain versioned records. Track per-participant unread markers and provide a playback slider that replays the wave's history. Expose `getWave()`, `getBlipText()`, `setBlipText()` and `applyOperation()` RPCs so an agent can read and write blips from chat, and document them in README.md.

Then append the collaboration-pattern sentence from the master plan. Before giving the brief, add `lib/yjs.js` through the code editor and paste the IIFE build at the top of `client.js`, so both are in place when the agent starts.

## Tests (two-browser session)

1. A and B type in the same blip simultaneously, interleaved words; both end with identical text and neither loses characters.
2. B's caret is visible in A's window and stays on the right character while A types above it.
3. A adds an inline reply in the middle of a sentence; B sees it at the same spot even after B has edited earlier text.
4. A reloads mid-typing; text is intact and the caret positions of others reappear.
5. Playback slider replays a five-minute session in order.
6. A kills the tab; the caret disappears within 15 s.
7. A blip with 20 KB of text: typing stays responsive; check update sizes are small (bytes, not the whole document).
8. Edit `server.js` to force a facet restart while both are typing; both windows resume without divergence. A `use`-role window may reload its own frame; that is expected, as the kanban board showed.
9. Agent chat: "summarise this wave as a new root blip"; the blip appears live.

## Promotion

`output`: `{ id: "wave", noun: "Wave", plural: "Waves", icon: "notebook" }`. `OUTPUT_ICONS` is a closed set (`fileText`, `gridNine`, `presentation`, `appWindow`, `flowArrow`, `kanban`, `chartBar`, `table`, `notebook`, `listChecks`) and has no chat icon; adding one is a `workshop-shared` plus frontend change. Blueprint id if bundled: `format.wave`.

## Risks specific to this plan

- **Yjs on both sides.** Server: only `.js` files become modules and the loader bundles nothing, so `lib/yjs.js` must be one self-contained file with no bare specifiers. Client: `client.js` is served alone, so Yjs must be concatenated into it and the agent must never add an `import`. Verify both with a trivial gadget (server imports Yjs and returns `Y.Doc` state; client creates a doc from the global `Y`) before writing anything else. Budget the first half day for this.
- **Editing a 200 KB `client.js` with the agent.** The agent reads and rewrites files whole. Keeping the app code in `lib/client-app.js` and regenerating `client.js` keeps the agent's edits small; tell it to edit `lib/client-app.js` and re-run the concatenation script yourself.
- **Storage value size.** DO KV values are capped at 128 KiB; a very long blip's full state could approach that. Cap blips at 64 KiB of state and prompt users to reply rather than extend. If needed later, switch `text:` to SQLite rows.
- **Memory in the facet.** Cached Y.Docs for hundreds of open blips add up; the ten-minute eviction and per-blip cap keep it bounded.
- **Editor binding quality.** The hand-written `contenteditable` binding is the most fiddly code. Keep the rich-text model tiny (paragraphs, bold, italic, link, bullet) and add features only after the two-browser tests pass.

## Follow-ups after v1

- Move to upstream's `libraries/sync` for the structure channel when the submodule catches up.
- With viewer identity: participants are real users, unread tracking works across devices, and `use`-role viewers can read but not edit.
- Search within a wave (client-side over open blips first).
- Embedding a kanban card or whiteboard frame as a read-only preview inside a blip, once cross-gadget references exist.
