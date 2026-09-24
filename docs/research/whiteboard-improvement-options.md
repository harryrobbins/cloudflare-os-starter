# Whiteboard improvement options

**Date:** 2026-09-24

**Status:** Recommendation

**Scope:** [`packages/blueprint-whiteboard`](../../packages/blueprint-whiteboard/README.md), the bundled `format.whiteboard` blueprint, and the Cloudflare OS seams it depends on

## Recommendation

Evolve the current whiteboard rather than replacing it.

The existing blueprint already has the difficult foundations: an authoritative Durable Object, per-object optimistic concurrency, idempotent writes, bounded storage, live presence, accessible non-pointer controls, shared rendering for the UI and SVG export, migrations, a multi-user harness, and broad tests. Replacing it with a canvas library, CRDT, or external database would reset much of that work without first solving the product's highest-value gaps.

Prioritise five improvements:

1. **Make recovery and authorship trustworthy.** Do not lose queued edits during reconnection, and add an upstream identity-bound gadget session before using history attribution for permissions or audit.
2. **Improve everyday creation.** Add alignment guides and snapping, connector endpoint editing, a searchable icon/stencil library, clipboard workflows, a shortcuts/help surface, deep links, and presentation mode.
3. **Scale the client before the datastore.** Add viewport culling, a client spatial index, list virtualisation, and adaptive presence. Keep the Durable Object as the source of truth until measurements show that snapshot transfer or wake-up, rather than SVG/DOM work and presence fan-out, is the limiting factor.
4. **Add richer collaboration on top of verified identity.** Comments, mentions, view-only roles, voting, and durable audit should not trust client-supplied names.
5. **Treat binary assets and public publishing as separate capabilities.** Store images in an authorised R2-backed service, not as base64 in Durable Object values. Publish explicit snapshots rather than exposing the live gadget Durable Object publicly.

The corresponding delivery plan is [`docs/plans/whiteboard-improvements.md`](../plans/whiteboard-improvements.md).

## Baseline reviewed

The review used the current source and shipped manifest, not only the older design plan:

- [`formats/whiteboard.json`](../../formats/whiteboard.json) and [`gadget.lock.json`](../../packages/blueprint-whiteboard/gadget.lock.json) are at revision **5**.
- The older [`whiteboard-blueprint.md`](../plans/whiteboard-blueprint.md) still says revision 4; that is documentation drift.
- The source is about 12,700 lines of JavaScript. Three files carry a disproportionate amount of complexity: `core/whiteboard.js` (1,339 lines), `client/sync/store.js` (1,547), and `client/ui/canvas/index.js` (1,237).
- The current limits are 5,000 objects, 8 MiB of stored object data, 200 live subscribers, 1,000 operations per request, and 2,000 touched objects per commit.
- On 2026-09-24, all 287 Node/Vitest tests passed. The workerd suite could not start in the restricted review environment because Wrangler could not write its log or bind a local port; this is an unexecuted check, not a product test failure.

### What is already strong

| Area | Existing strength |
| --- | --- |
| Data integrity | Per-object versions, conflict results, bounded retries, random idempotency keys, and atomic multi-key commits |
| Collaboration | Committed operations plus separately rate-limited ephemeral presence, follow mode, cursors, selections, live transforms, and strokes |
| Recovery | Heartbeat-based restart detection, resubscription, revision-gap recovery, and guarded iframe reloads |
| Security hygiene | Strict object sanitisation, size/count caps, safe text rendering, XML escaping, bounded export work, and disposable callback handling |
| Accessibility | Keyboard/button alternatives for pointer gestures, object list, focus handling, live announcements, large touch targets, and reduced-motion handling |
| Maintainability | Storage-independent core and hub, shared client/server renderer, deterministic archive packing, schema versioning, and extensive unit/fuzz/E2E coverage |
| Agent use | Small convenience RPCs for finding, adding, arranging, updating, connecting, deleting, and exporting objects |

These are assets to preserve in every option.

## Findings and opportunities

### Usability and accessibility

The whiteboard is unusually capable for a v1, but common diagramming workflows remain costly:

- A connector cannot be reattached; users must delete and redraw it.
- There is no snapping, alignment guide, equal-spacing aid, or distribute command.
- Copy/paste and cross-board transfer are not first-class. Duplicate works, but structured clipboard import/export does not.
- Diagramming is limited to basic shapes. There is no searchable library of flowchart stencils or general-purpose icons.
- Discoverability relies on tooltips, the shipped README, and keyboard hints. There is no visible shortcuts/help panel or first-run tour.
- The connection UI says “Saving…” and “Connecting…”, but a forced iframe reload still discards writes that have not reached the server.
- The object list is valuable for keyboard and screen-reader use, but renders the whole collection and will become unwieldy near the object cap.
- Deep links cannot focus a frame or object. Sharing a workspace link does not preserve the intended view.
- There is no presentation/review mode that hides editing chrome and steps through frames.
- The shipped user guide contradicts itself: its introduction says a user is asked for a name, while the later identity section correctly says the account display name is used without a prompt.

Recommended near-term work:

- endpoint handles with a keyboard-accessible “Reconnect from/to” equivalent;
- smart guides, grid/object snapping, align, and distribute actions with an easy temporary bypass;
- copy selected objects as versioned whiteboard JSON plus plain-text fallback, and paste text as stickies;
- a searchable, keyboard-accessible icon/stencil picker backed by bundled, versioned packs;
- a searchable shortcuts/help dialog and concise empty-board onboarding;
- visible `Saved`, `Saving`, `Offline/reconnecting`, and `Unsaved changes` states;
- deep links such as `#frame=<id>` and `#object=<id>`, implemented without putting board content in the URL;
- presentation mode over ordered frames;
- virtualised object/activity lists.

Accessibility must remain a release gate. Every new gesture needs a keyboard and button route, announcements must be coalesced, and culling must not remove selected/focused objects from the accessibility tree.

### Reliability

The sync store retains and retries operations during ordinary transient failures, but the final recovery path reloads the iframe and explicitly loses unsent local changes. This is the highest-impact reliability gap.

Do not put board content or a potentially large operation queue in `window.name`; it is currently appropriate only for tiny reload state such as colour and retry timestamps. Browser storage in the sandbox also needs a real-platform spike before it can be relied on.

Preferred solution:

- add a host/platform seam that can refresh the gadget RPC target without destroying the iframe;
- preserve the in-memory pending queue and request IDs across that refresh;
- do not reload while a request may still be acknowledged;
- after a bounded failure window, show an explicit recovery screen with a safe JSON download of pending operations before offering reload.

An interim blueprint-only improvement can make the risk visible and delay reload while requests are in flight, but it cannot guarantee recovery after the browsing context is destroyed.

### Scalability, performance, and cost

The current limits are safe product boundaries, not proof that the experience is fast at every boundary.

Current scaling characteristics:

- The first load reads every `obj:*` key and returns a full snapshot.
- The client stores every object and creates an SVG group for every committed object; there is no viewport culling.
- Many geometry and hit-test paths scan `Object.values(objects)`.
- The object list renders all matching rows.
- Each active user sends presence while moving; the hub fans updates out to every other subscriber. Presence therefore approaches quadratic outbound work as the number of simultaneously active users rises.
- Operation events are incremental, but recovery from a revision gap falls back to a full snapshot; there is no persisted delta journal by revision.
- A hibernated/restarted Durable Object rebuilds its in-memory index from all object keys.

The best first investments are client-side and protocol-compatible:

1. Establish cold-load, warm-load, pan, zoom, hit-test, memory, mutation-latency, and presence-fan-out budgets at 500, 2,000, and 5,000 objects and 1, 10, 50, and 200 simulated viewers.
2. Add a client spatial index and render only the viewport plus overscan, while pinning selected, edited, remotely transformed, and connector-dependent objects.
3. Virtualise the Objects and Activity panels.
4. Make presence adaptive: no cursor traffic for hidden/idle tabs, deduplicate unchanged state, reduce frequency with peer count or slow delivery, and keep the heartbeat separate from visual updates.
5. Instrument counts, durations, byte estimates, retries, dropped subscribers, and reconnects without logging text, names, IDs, coordinates, or board contents.

Only then decide whether the full snapshot is a demonstrated bottleneck. If it is, add a versioned snapshot-plus-delta protocol. Do not bolt naïve pagination onto a changing board: pages from different revisions can produce a state that never existed. A safe design needs either an immutable snapshot session or a bounded revision journal that lets the client apply everything committed after the page sequence began.

Sharding one board across several Durable Objects is not recommended at the present 8 MiB/5,000-object boundary. It would make atomic multi-object moves, connector cascades, ordering, history, subscriptions, and undo distributed problems. Prefer multiple frames or multiple whiteboards as the human-scale partition.

### Functionality

Recommended additions, in order of value and architectural fit:

| Capability | Recommendation | Important constraint |
| --- | --- | --- |
| Alignment and distribution | Build now | Pure client operation generation; server protocol already supports atomic multi-object updates |
| Connector endpoint editing | Build now | Preserve reference validation and keyboard alternatives |
| Curated icon and stencil packs | Build now | Compile pinned, licensed sources to inert internal geometry; store stable pack/icon IDs, never raw markup |
| Clipboard and JSON backup | Build now | Validate imports through the same normalisers and caps; never accept executable HTML/SVG |
| Templates | Build now | Start with bundled, static templates that expand to normal operations |
| Frame deep links and presentation | Build now | URL fragment contains IDs only; links still obey workspace access |
| Search | Extend current Objects panel | Search type/text/frame first; do not add an external index for one board |
| Comments and mentions | Build after verified identity | Store threads separately from drawable object size; define deletion and retention semantics |
| Voting and facilitation timers | Build after verified identity/roles | Anonymous voting and result visibility are product-policy decisions, not only UI |
| Images and attachments | Build after an asset capability exists | R2-backed, quota-controlled, authorised, MIME-validated; no base64 blobs in board objects |
| Durable version restore | Add as checkpoints plus a bounded delta log | Current history is intentionally short and some large operations are not undoable |
| PNG export | Reasonable client export | Bound pixel dimensions and memory; retain SVG as the canonical lossless export |
| SVG import | Add only as an explicitly safe mode | Compile a strict inert vector subset, embed as an SVG image, or rasterise; never insert untrusted SVG as active DOM or carry it raw into export |
| Raw HTML import | Do not render | Convert supported semantics such as text or tables to board primitives; never make imported HTML part of the gadget DOM |

#### Icon and stencil packs

Add two pack classes behind one registry:

- a small first-party diagram pack for process, decision, terminator, document, database, cloud, actor, container, and connector-related stencils;
- a curated subset of [Tabler Icons](https://github.com/tabler/tabler-icons), pinned to an exact upstream version and shipped under its MIT licence, for general symbols such as people, devices, files, controls, networks, and cloud/infrastructure concepts.

Tabler is the recommended initial general pack because its broad, consistent outline set fits diagramming. [Lucide](https://github.com/lucide-icons/lucide/blob/main/LICENSE) is a good ISC-licensed alternative if a small rendering and archive-size spike shows a better visual fit. Do not initially bundle both: a compact, well-tagged subset is more usable and avoids turning every whiteboard load into an icon-catalogue download. The registry should support additional packs later, including reviewed organisation-specific packs.

An icon-pack build step should parse upstream SVG files and emit only the internal primitives used by the shared renderer. Permit bounded numeric geometry and ordinary fill/stroke/transform data for `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, and `g`. Reject scripts, event attributes, links, `foreignObject`, `image`, `use`, stylesheets, animation, filters, masks, patterns, and every URL-bearing value. Apply byte, element, path-command, coordinate, nesting, and bounding-box limits.

Store icon objects by a stable `{ packId, iconId }` reference plus normal position, size, rotation, and style. Do not store the source SVG. Bundle the compiled geometry, searchable names/tags, accessible label, source version/hash, and licence metadata into the gadget. Pin source versions, check generated output into the repository, and ship a third-party notice. Existing IDs must continue to resolve; removing or materially changing a glyph requires a new pack version.

The picker should support categories, fuzzy search, recent items, keyboard navigation, click/drag insertion, and accessible names. Rendering, bounds, copy/paste, backup/import, hit testing, culling, and SVG/PNG export should all consume the same trusted geometry. Add agent-facing `findIcons()` and `addIcons()` methods using stable IDs rather than asking agents to generate SVG strings.

Because the gadget CSP blocks network fetches, packs must be in the deterministic archive rather than loaded from a CDN. Measure archive size, parse time, and search latency; prefer a compact core subset and generated indexes over shipping thousands of unused glyphs. Organisation-specific packs can use the same reviewed build pipeline. End-user pack upload should remain deferred until there is an isolated ingestion service, explicit licence ownership, and the same compiler and complexity limits.

### Security and privacy

The current implementation is robust against malformed object data, oversized values, unsafe SVG text, predictable request-ID poisoning, and presence-session hijacking. Those protections should remain.

#### What the gadget sandbox does—and does not—make safe

The sandbox materially reduces the impact of hostile content. The host iframe in [`GadgetUI.tsx`](../../cloudflare-os/packages/workshop-frontend/src/GadgetUI.tsx) uses `allow-scripts allow-popups allow-popups-to-escape-sandbox` without `allow-same-origin`, so the gadget has an opaque origin and cannot directly read the parent DOM, cookies, or origin storage. Its CSP sets `default-src 'none'`, `connect-src 'none'`, `frame-src 'none'`, `object-src 'none'`, `form-action 'none'`, and permits only data images/media. The host also checks that RPC messages came from the expected frame with origin `null`.

That is strong containment, but it is not an SVG or HTML sanitizer:

- Scripts are deliberately enabled. Inline SVG supports scripts and event attributes, and raw HTML has the same active-content problem. If untrusted markup is inserted into the document rather than treated as an image, it can execute inside the gadget.
- Code running in the frame can read and alter the visible board and invoke app capabilities exposed in that realm. This whiteboard deliberately publishes its store as `globalThis.whiteboardStore` for tests/debugging, so active imported content could submit mutations as the current collaborator even though it cannot reach the parent DOM.
- Hostile markup can cover the UI, imitate prompts, capture pointer/keyboard input, degrade accessibility, or consume CPU and memory with huge paths, filters, animation, nesting, or embedded data. An iframe sandbox does not provide a useful per-object CPU or memory budget.
- Popups are allowed and are explicitly allowed to escape the sandbox. The host disables `window.open()` and adds `noopener` to target-blank links, which blocks opener access, but a user-activated malicious link can still put board-derived data in an outbound URL. The export service also records that CSP/request interception does not cover every WebRTC/STUN path.
- Export crosses the boundary. A downloaded SVG or HTML document can later be opened outside the gadget sandbox, where the iframe CSP no longer applies. Raw imported active content must therefore never be copied into an export.

Embedding SVG through an `<img>` data URL is substantially safer than inserting it inline: browsers process SVG in image mode with scripting and external resource loading disabled. It is still less editable, can be expensive to decode/render, and needs a separate export decision. Rasterising it with strict byte, dimension, time, and memory limits is safer still for untrusted uploads.

Use these policies:

1. **Bundled icons and stencils:** compile at build time into bounded internal geometry. This is the preferred editable path.
2. **User SVG import:** defer until a parser converts an allowlisted subset into inert board primitives and fuzz/adversarial tests cover it. As a simpler alternative, ingest it as an image or rasterise it; never use `innerHTML`, `DOMParser` followed by direct insertion, `<object>`, or inline raw SVG.
3. **HTML paste/import:** extract explicitly supported data such as plain text or table cells and create ordinary board objects. Do not preserve raw HTML.
4. **Export:** generate SVG/HTML only from the trusted renderer and escaped board data. Never round-trip source markup.

If arbitrary HTML preview ever becomes a product requirement, give each preview a second, capability-free sandbox with no scripts, same-origin access, popups, forms, navigation, or network—not the gadget's script-enabled frame—and exclude the source from board exports. The current gadget CSP has `frame-src 'none'`, so this would require an explicit host design and security review rather than a whiteboard-only change.

The sandbox changes the likely impact from “parent-origin compromise” to “board capability abuse, deceptive UI, resource exhaustion, and unsafe exported content.” That is a meaningful reduction, but still enough reason to reject active markup.

The important remaining trust issue is identity:

- The official UI derives the display name from `gadgetViewer`.
- The gadget server still receives `by`, `senderId`, and presence `name` from client-controlled RPC arguments.
- Therefore `createdBy` and history `by` are useful collaboration labels, but not authenticated audit evidence.
- Anyone allowed to use the gadget can call its mutation RPCs and can request undo by history ID. The whiteboard has no trustworthy board-specific editor/viewer/facilitator policy.

Do not “fix” this with a hidden client flag or a signed token exposed once and then reused indefinitely. The platform needs a first-class, short-lived, viewer-bound gadget session capability created by the authenticated host. The server should receive a stable opaque viewer ID, display name, effective role, gadget ID, and session expiry from that capability. Mutations and presence should flow through the session, so the server supplies actor fields rather than trusting caller text.

The fork's current viewer-assertion work is not a direct substitute: those assertions are one-use, intent-bound proofs redeemed by a connected Gatekeeper. Whiteboard mutation targets the gadget's own facet and occurs far too frequently to mint and redeem a Gatekeeper assertion for every gesture. The session proposal should reuse the same principles—host-derived identity, narrow scope, expiry, and no client-forgeable claims—at the correct granularity.

Once that exists:

- store an opaque actor ID and display-name snapshot on history; avoid storing an email address unless the deployment explicitly treats it as the stable ID;
- allow ordinary users to undo their own changes and a facilitator to undo any change;
- enforce view-only, edit, and facilitate permissions server-side;
- apply per-viewer/session mutation and presence budgets;
- record policy-relevant events without board content;
- make presence visibility and retention explicit. Presence remains memory-only.

Until it exists, label history as attribution rather than audit and do not use `by` for access control.

### Sharing and portability

There are three different things called “sharing” and they should stay distinct:

1. **Live collaboration:** share the Cloudflare OS workspace, which preserves authentication and the authoritative board.
2. **Portable editable copy:** export/import a versioned whiteboard JSON document containing data, not code or credentials.
3. **Public or embedded view:** publish an immutable, sanitised snapshot with explicit expiry/revocation. Do not expose the live gadget Durable Object or mint a public mutation capability.

Blueprint sharing only shares the application code; it intentionally does not carry a board's Durable Object storage. A user should not have to understand that distinction, so the UI should call the second workflow “Download board backup” or “Copy board”, not “Export blueprint”.

A read-only live link requires a platform-level role/capability because the shared Gadget RPC surface is currently mutable. The safe interim is a static SVG/PDF/HTML export or a published snapshot service.

For enterprise discovery, an external database may index board metadata and permission-filtered text asynchronously, but it should be a derivative index rather than the source of truth. CDC from Durable Object storage is not available as a generic relational stream in this design, and dual writes would make board commits depend on a remote database. Emit a versioned outbox/event after the authoritative commit if cross-board search, retention, or e-discovery becomes a real requirement.

### Maintainability and operability

The separation between shared protocol, core rules, storage adapter, hub, sync store, and UI is sound. The problem is concentration within a few very large modules and duplication with the Board blueprint.

Recommended maintenance work:

- split `whiteboard.js` into validation, indexing, operation planning, history/undo, convenience commands, and orchestration without changing its public API;
- split `store.js` into transport/session, operation queue, reconciliation/rebase, presence, and public store facade;
- split `canvas/index.js` into controller, render scheduler, selection/focus, gestures, and host bindings;
- replace implicit cross-module object shapes with checked JSDoc typedefs or TypeScript only when it improves contracts without forcing a rewrite;
- add protocol/schema compatibility fixtures for every stored version and archive revision;
- extract shared Board/Whiteboard sync code only after both implementations can adopt it without protocol compromises, or use upstream `libraries/sync` if it lands and passes the existing adversarial suites;
- correct revision and identity documentation as part of every packed archive change;
- add privacy-safe runtime counters and a support diagnostics panel rather than logging content.

The bundle/archive rule remains: edit package source, run `pack:gadget`, commit the archive and sidecar, never change `format.whiteboard`, and remember that a new bundled revision affects new whiteboards only. Existing instances retain their copied gadget code unless a separate upgrade path is provided.

## Architecture options

### Option A — evolve the current operation model (recommended)

Keep the Durable Object, repository seam, operation protocol, and SVG renderer. Add the UX, identity session, culling, adaptive presence, and optional services described above.

**Advantages**

- Lowest migration and regression risk.
- Preserves the extensive concurrency, abuse, accessibility, export, and restart tests.
- Keeps one authoritative serialization point for atomic multi-object operations.
- Makes improvements independently shippable and reversible.
- Keeps data local to each gadget unless a user explicitly invokes another capability.

**Disadvantages**

- The team continues to own a specialised canvas and sync stack.
- Rich text and offline multi-writer editing remain difficult.
- Very large boards eventually need a snapshot/delta protocol or a higher cap strategy.

### Option B — adopt an established canvas engine

Use a library such as tldraw or Excalidraw for interaction/rendering while adapting persistence and collaboration to Cloudflare OS.

**Advantages**

- Much faster access to mature shape tooling, snapping, selection, images, clipboard, and polish.
- A broader upstream ecosystem can fix browser/input edge cases.

**Disadvantages**

- Data model, licensing, bundle size, upgrade policy, CSP/network behavior, accessibility, and server-side export all require separate review.
- The existing RPC, optimistic rebase, agent API, deterministic SVG, and tests would need adapters or replacement.
- Library collaboration backends may not fit the gadget Durable Object/capability model.

**Decision:** prototype only if the desired product becomes a general-purpose diagram editor and maintaining the interaction layer demonstrably dominates cost. Do not migrate for snapping or endpoint handles alone.

### Option C — move committed state to a CRDT/Yjs document

**Advantages**

- Strong fit for concurrent rich text, offline edits, and eventually reusable upstream sync infrastructure.
- Can merge more classes of simultaneous edits without explicit conflicts.

**Disadvantages**

- Geometry conflicts that currently have clear domain-specific rules become less obvious, not automatically better.
- Server validation, caps, references, history, undo ownership, exports, and the agent RPC still need an authoritative application layer.
- A migration must translate every stored object and preserve existing boards; the current benefits do not justify that cost.

**Decision:** use CRDTs for a targeted rich-text/comments experiment, or reconsider after upstream sync support is stable. Do not rewrite the whole board now.

### Option D — use an external database as the primary store

**Advantages**

- Cross-board queries, enterprise backups, retention, analytics, and integration with existing data platforms become easier.
- Postgres can support durable audit and search workloads well.

**Disadvantages**

- Adds network latency and availability to every gesture commit.
- Does not remove the need for a per-board coordinator for ordering, presence, atomic multi-object operations, and fan-out.
- Dual-write/CDC semantics are complex, and credentials plus tenant isolation become new high-risk surfaces.
- A row database does not solve client SVG rendering or presence fan-out.

**Decision:** keep the board in its Durable Object. Add an asynchronous, permission-filtered external projection only for proven organisation-wide search, compliance, analytics, or backup requirements.

## Prioritised roadmap

| Priority | Outcome | Main work |
| --- | --- | --- |
| P0 | Trust the product under failure | Baselines, docs correction, connection state, pending-write recovery design, identity-session upstream proposal |
| P1 | Faster everyday editing | Snapping/guides, align/distribute, connector reattachment, icon/stencil library, clipboard, shortcuts help, deep links |
| P1 | Smooth large boards | Spatial index, viewport culling, virtualised panels, adaptive presence, privacy-safe metrics |
| P2 | Better review and sharing | Presentation mode, JSON backup/import, static publish design, view-only capability design |
| P2 | Accountable collaboration | Verified actor sessions, server-enforced roles, own-change undo, comments and mentions |
| P3 | Rich content | Templates, images through an asset service, PNG export, checkpoint restore |
| Conditional | Organisation features | External search/audit projection; snapshot-plus-delta loading after measured thresholds |

## Success measures

- No acknowledged operation is lost across transient RPC failure or host connection refresh.
- The UI never claims an unsent change is saved.
- Attribution used for policy comes from a host-authenticated session, never a client string.
- At 5,000 simple objects, pan/zoom remains responsive and the DOM contains only visible objects plus a bounded overscan/pinned set.
- Presence traffic falls toward idle heartbeat rate when users stop moving or hide the tab.
- A 50-viewer simulation stays within an agreed mutation/presence latency and fan-out budget; the 200-subscriber cap remains an admission limit, not a performance promise.
- Every pointer-only addition has a keyboard/button equivalent and automated accessibility coverage.
- A user can share a link to a frame, present frames, and export/import a data-only board without exposing code or credentials.
- New format revisions remain deterministic, preserve `format.whiteboard`, and document which changes reach only newly created boards.

## Decisions required before implementation

1. Are `use` collaborators all editors, or is a true view-only role required?
2. Is history a convenience feed or a compliance-grade audit trail? The latter changes identity, retention, export, and deletion requirements.
3. Is the target one team workshop (tens of simultaneous editors) or a broadcast event (hundreds)? The presence architecture differs.
4. Should comments/mentions notify people outside the open board? If yes, which Gatekeeper owns delivery and retention?
5. Are image uploads required for the default bundled format? If yes, a zero-configuration, host-native asset capability is preferable to making every new whiteboard request a connector.
6. Must existing whiteboards receive upgrades, or is improving newly created instances sufficient? Cloudflare OS currently copies blueprint code and does not auto-update existing gadgets.
