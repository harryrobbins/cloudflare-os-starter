# Drawings in Docs: embedded apps with host-owned data

**Status:** Phases 1 to 3 and the tested half of Phase 4 were implemented on 2026-09-30 as the **Docs with Drawings** format (`format.docs-drawings`, [`packages/blueprint-docs`](../../packages/blueprint-docs/README.md)), with Whiteboard revision 9 providing the embed entry points. See [Implementation record](#implementation-record-2026-09-30) for what changed from this design and what is still open. The research behind it is in [Embeddable apps](../research/embeddable-apps.md).

**Goal:** give the Docs app a proper drawing tool. A person can draw in a doc, co-edit the drawing live, and export it with the doc. The doc's agent can create and change drawings as easily as it changes paragraphs. The same approach should then carry a second embed kind, a Vega-Lite chart, to show that it generalises.

## Recommendation

Embed the Whiteboard as a **library with host-owned data**, not as an iframe or a separate app. This is option D in the research. The same idea underlies draw.io embed mode, OLE and Google Docs drawings, and this repository has already done it once with Tessera.

- Drawings live **in the doc's Durable Object**. Each drawing gets its own key prefix, and the doc runs the unchanged whiteboard rules (`core/whiteboard.js`) over a prefixed `Repository`.
- The doc bundles the **whiteboard UI** and mounts it against a store scoped to one drawing. Inline, the drawing shows as its SVG preview. **Edit** opens the full editor inside the doc page, the equivalent of MCP's `fullscreen` display mode.
- The doc's block holds a `<figure>` with the **SVG preview**, so Markdown, HTML, PDF and Google Doc export keep working unchanged.
- The **agent edits drawings through the doc's RPC**, with the same method names as `env.Whiteboard`. The Whiteboard's agent knowledge transfers directly. There is no second agent and no cross-gadget channel.

This answers the worry about "the doc agent can't add stuff to the whiteboard". MCP Apps don't let the host agent into the iframe either. They put the state on the server and give the agent tools over it. Here the doc *is* that server.

### Why not the alternatives

| Option | Verdict |
| --- | --- |
| **A. Static snapshot.** Agent exports SVG from a Whiteboard gadget into the doc. | Works today with no code. Keep it as the stopgap ([Phase 0](#phase-0-the-stopgap-no-code)). The drawing goes stale and its source is orphaned from the doc. |
| **B. Nested gadget iframe.** | Needs fork changes to `frame-src 'none'` (`GadgetUI.tsx:112`), gadget-to-gadget bindings (`overseer.ts:1864`) and cross-gadget auth. It buys origin isolation between two first-party formats that already trust each other, and it still leaves two things to share and keep in step. |
| **C. Whiteboard as a connector with a UI frame.** | The right shape for **untrusted or third-party** embeds: a real MCP-Apps equivalent built on `GatekeeperUiFrame`. It needs a fork patch so a gadget can ask the Workshop to open a connector UI. The drawing would also live outside the doc (the Confluence drift problem). Revisit it only if we want third-party embeds ([Later](#later-untrusted-embeds)). |
| **Agent-to-agent** (doc agent talks to a whiteboard agent). | Unnecessary. The Workshop agent already reaches every gadget, and what it needs is the drawing's operations. A specialist can still be started with `AGENT_SPAWNER.spawnCallable` for long jobs, and it would use the same RPC. |

## Design

### Embed contract

Every embed kind is a small module with the following parts. The Whiteboard supplies the first one and Vega-Lite the second.

| Part | Whiteboard | Chart |
| --- | --- | --- |
| `kind` | `"whiteboard"` | `"chart"` |
| Server engine over a scoped store | `Whiteboard` rules over `prefixedRepository(storage, "embed:wb:<id>:")` | Validates a Vega-Lite spec (inline data only, no `url`) |
| `preview(state) → svg` | `boardToSvg` (`shared/render.js`) | `vega-interpreter` rendering to SVG |
| Client `mount(root, {store, readOnly})` | Whiteboard UI (`client/ui`) against `store-contract.js` | Spec editor and live render |
| Agent API | The `env.Whiteboard` convenience methods | `getChart` / `setChart` |
| Import and export | `exportData` / `importData` format `cloudflare-os-whiteboard` v1 | The spec JSON |

The doc knows only the contract. The contract lives in the doc fork (`packages/blueprint-docs/src/embeds/`), not in the platform.

### Document model

- An embed occupies one block:

  ```html
  <figure data-block-id="b_…" data-embed="whiteboard" data-embed-id="d_…" contenteditable="false">
    <img alt="…" src="data:image/svg+xml;base64,…">
    <figcaption>…</figcaption>
  </figure>
  ```

- The block is atomic in the text editor. It can be moved, deleted and captioned, but its contents are not editable text.
- The drawing's own state is **not** in the block. It lives under `embed:wb:<id>:{meta,obj:*,history,requests}`. Block-level concurrency in Docs therefore never collides with object-level concurrency in the drawing, and each keeps its own conflict rules.
- The **preview is re-rendered by the server** after a drawing commit. This is debounced at about 1 second, and happens straight away when the editor closes. The server writes the new preview through the doc's normal block path, which bumps the block version and broadcasts, so viewers and exports stay current.
- **Deleting** the block keeps the drawing's keys in a trash list with a retention period, so undoing the delete restores the drawing. **Copying** a figure into another doc carries the `exportData()` payload in the clipboard, using the existing `application/vnd.cloudflare-os-whiteboard+json;version=1` format.

### Server (doc fork)

- `drawings.create({title?, afterBlockId?})` returns `{id, blockId}`, and `drawings.list()` returns ids, titles, object counts and block ids.
- For agents: a flat `drawing(id, method, ...args)`, limited to an allow-list of the whiteboard convenience methods: `getBoard`, `findObjects`, `addStickies`, `addObjects`, `addFrame`, `connectObjects`, `findIcons`, `addIcons`, `addCode`, `arrangeGrid`, `moveObjects`, `updateObjects`, `deleteObjects`, `exportSvg`, `exportData`, `importData` and `undo`.
  - It is flat rather than returning an `RpcTarget` per drawing because of the known stub-disposal and dead-stub gotchas ([collaborative-blueprints gaps](collaborative-blueprints.md#what-the-platform-does-not-give-us)).
  - Also expose sugar such as `addStickies(drawingId, …)` if agent trials show the flat form confuses the agent.
- For the editor client: `drawingApply(id, request)` and `drawingSubscribe(id, callback)`, backed by one `core/hub.js` per open drawing, created lazily and dropped when its last subscriber leaves. Presence is scoped to each drawing.
- `getDocument()` gains an `embeds` summary, so the agent sees what is in the doc without fetching every board.

### Client (doc fork)

- The inline figure shows the SVG. On hover it offers **Edit** and **Open full screen**.
- **Edit** mounts the whiteboard UI in an overlay that covers the doc page, with a "Back to document" bar. Only one editor mounts at a time. The overlay is built with DOM calls and never with `<form>`, because there is no `allow-forms`.
- The store is the existing `client/sync` store, parameterised by a transport. Today the transport is `gadget.*` on the whiteboard's own server. In the doc it is `gadget.drawingApply(id, …)` and `gadget.drawingSubscribe(id, …)`.

### Whiteboard library entry points (in `packages/blueprint-whiteboard`)

- `src/embed/server.js` exports `createDrawingEngine(repository, options)` and `prefixedRepository(storage, prefix)`.
- `src/embed/client.js` exports `mountWhiteboard(root, {transport, viewer, readOnly, onClose})`.
- The standalone Whiteboard gadget is rebuilt on these entry points, so there is one engine and fixes reach both. This is the Tessera rule: one engine, installed rather than copied.

### Agent knowledge

- Add a **Whiteboard SKILL.md**, which does not exist yet. It describes the drawing API independently of the host, with tested recipes such as an architecture diagram, a flow with frames, or stickies grouped by theme.
- Add a **Docs SKILL.md** covering blocks and `setDocument`. It adds that to draw, the agent calls `drawings.create` and then `drawing(id, "addStickies", …)`, and that the whiteboard skill has the vocabulary.
- Record the drawing the viewer has open in doc presence. The agent reads it through `getDocument().embeds[].openBy`, so "add a box to this diagram" resolves correctly. This plays the role of MCP's `ui/update-model-context`.

## Delivery

### Phase 0: the stopgap (no code)

Write a short recipe into the Docs skill notes. The agent calls `env.Whiteboard.exportSvg({frame})` or `env.MERMAID2.render({format: "svg"})`, then inserts an `<img>` data-URL block with `applyOperation`. This proves the agent side of the story today, and shows people what the embedded version will improve on.

### Phase 1: extract the whiteboard library (no behaviour change)

- Add `src/embed/*` and `prefixedRepository`. Make the transport injectable in `client/sync`.
- **Gate:** all existing whiteboard unit, workers and e2e suites pass. The rebuilt `whiteboard.gadget` behaves identically in the harness. The added engine test runs two prefixed boards in one Durable Object and shows no key bleed.

### Phase 2: fork Docs and add drawing embeds (server)

- Create `packages/blueprint-docs` from the decoded `workspace-docs` source (Apache-2.0, notices kept) as a **separate format** during the proof. The upstream Docs format stays untouched ([decision 1](#decisions-for-harry)).
- Implement the embed contract, `drawings.*`, the preview write-back and trash retention.
- **Gate:** workers tests pass for these cases:
  - create a drawing, then edit it, then check the preview updates;
  - concurrent text-block and drawing edits;
  - delete and undo;
  - Markdown, HTML and PDF export containing the preview;
  - agent-path calls through `executeCode`.

### Phase 3: in-document editor (client)

- Inline preview, the Edit overlay and live co-editing across two browsers.
- **Gate:** the jsdom and Playwright harness pass for these cases:
  - two viewers edit the same drawing while a third edits text;
  - reconnect keeps queued changes;
  - closing the editor refreshes the preview for everyone within 2 seconds.

### Phase 4: agent proof

- The Docs and Whiteboard skills with recipes.
- **Gate, as a scripted trial:** from a Workshop chat, "Add a diagram of our deploy pipeline under the Architecture heading, then label the router box 'deploys last'". Both steps work without the agent reading source. Then the person opens the drawing, moves a box, and asks the agent to "connect the new box to the router". The agent finds the open drawing through presence and does it.

### Phase 5: second embed kind, Vega-Lite chart

- Reuse the Work Board's Vega-Lite rules (inline data only, `vega-interpreter`).
- **Gate:** no change to the embed contract is needed. If one is, fix the contract before inviting more kinds.

### Release

Follow `CLAUDE.md` and the operator skill. The mutation summary names the new format and the affected Workers, and the release runs `pnpm release` from clean committed `main`. Nothing in this plan authorises a production mutation.

## Decisions for Harry

1. **New format or replace Docs?** The recommendation is a separate "Docs" format owned by us, e.g. blueprint id `format.docs`, alongside upstream `workspace-docs` until the drawing embed has been used for real. After that, hide the upstream one. Replacing it on day one would put every existing doc on our fork before it has proven itself.
2. **Bundle size.** The whiteboard build is about 890 KB of `client.js` and 325 KB of `server.js`. Formats are inlined into the Workshop Worker, and Docs is currently 28 KB. Options are to accept this, or to load the editor lazily from the server as a `data:` module on first Edit. The measurement is recorded in Phase 3 before choosing.
3. **Importing existing Whiteboards.** Offer "Insert existing whiteboard" as a copy through `exportData`/`importData`, which is cheap. A live link to a separate Whiteboard gadget is not offered, because it needs gadget-to-gadget bindings.

## Risks

| Risk | Mitigation |
| --- | --- |
| The whiteboard UI assumes it owns the whole page: key handlers, the undo stack, focus | Mount it in an overlay that captures input while open. Keep doc undo and drawing undo separate and say so in the UI. Test this in Phase 3. |
| Preview write-back conflicts with a person editing the caption | The caption lives in the same block, so the server rebases the preview onto the latest block version, the same way Docs already retries local drafts. |
| Many drawings in one doc raise Durable Object storage and CPU use | Hubs are lazy and per drawing. Caps are per drawing (the existing `LIMITS`) plus a per-doc drawing count. Measure with the whiteboard benchmark script. |
| Inbound RPC ceiling of about 45–50 calls a second per gadget, now shared by text and drawing traffic | The whiteboard sync already batches. Measure two drawings and text being edited concurrently in Phase 3. |
| Upstream Docs changes are no longer picked up | Accept this while it is a separate format. Diff upstream when the submodule pin moves. |

## Later: untrusted embeds

If we want arbitrary apps, from other people or other deployments, to be embeddable in docs, build option C as the MCP-Apps equivalent:

- a connector exposes a `ui://`-style template through `GatekeeperUiFrame`;
- a fork patch lets a gadget ask the Workshop to open that frame in a modal or pinned panel;
- the frame's state stays with the connector;
- the agent reaches it through the connector's model-visible RPC.

The embed contract above maps onto it directly: `preview` becomes a connector render (MermaiD2 already works like this, returning SVG or PNG), and `mount` becomes the connector UI frame. Keep that door open by never letting doc code call into an embed except through the contract.

## Implementation record (2026-09-30)

Built on branch `feat/docs-drawings`. Decisions 1 to 3 above were taken as recommended:
- a separate format beside upstream Docs ("Docs with Drawings", noun "Illustrated doc");
- the bundle size accepted, not lazy-loaded;
- no live links to separate Whiteboard gadgets.

**Changed from the design above:**

- **Previews are not written into the document block.** A figure block is an empty `<figure class="doc-drawing" data-drawing-id="d_…">`. The server stores the SVG beside the drawing, chunked under the facet's per-value limit. It announces a `{type: "drawing", id, revision}` event, and clients fetch the preview with `getDrawingPreview`. Preview refreshes therefore never bump block versions, so the caption-conflict risk in the risks table does not arise. There is no caption. The drawing's title is shown under its picture instead. The Markdown export inlines the SVG as a base64 image.
- **Agent knowledge lives in the format's README, not in SKILL.md files.** The Workshop agent reads a format's `README.md` before calling it (`agent.ts:2346-2356`). A server test runs the README's example verbatim.
- **Trash retention was not built.** Removing a figure keeps the drawing's data, and an undo brings it back. `removeDrawing` deletes both. Orphans show in `listDrawings` with empty `blockIds`.
- **Copy and paste of a figure is not supported.** The paste sanitizer drops figures.
- **Upstream's `dup.onRpcBroken()` call was removed** from the Docs server. Workers RPC stubs do not implement it, so the call rejected on every subscribe. Dead subscribers are still dropped when a delivery fails.
- **The Whiteboard gained three things:**
  - `DoStorageRepository({prefix})`;
  - `mountApp(root, store, {embedded})` with `destroy()`: page-level listeners use an `AbortSignal`, and `document.title` and `pagehide` are left to the host;
  - the entry points `blueprint-whiteboard/embed/server` (`DrawingHost`, `whiteboardMethods`) and `blueprint-whiteboard/embed/client` (`mountWhiteboard`).

**Tests:**

| Suite | Result |
| --- | --- |
| Docs server, workerd | 17/17 |
| Docs archive freshness | 1/1 |
| Docs harness e2e | 3/3 |
| Whiteboard unit | 672/672 |
| Whiteboard workerd | 21/21, including the new prefixed-repository and `DrawingHost` tests |
| Whiteboard harness e2e | 41/41 |

The Docs harness e2e covers these flows:
- insert, draw, agent edit, a live preview in the other pane, and a clean close;
- an agent-created drawing co-edited by two people;
- the HTML export.

One Whiteboard harness test ("connect without dragging") failed once in a full run and passed in three reruns.

**Still open:**
- Signed-in production checks.
- A real agent trial from a Workshop chat, which needs a model.
- Phase 5 (Vega-Lite chart).

