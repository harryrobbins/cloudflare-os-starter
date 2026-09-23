# Plan: Whiteboard improvements

**Status:** Proposed

**Date:** 2026-09-24

**Target:** the source blueprint in [`packages/blueprint-whiteboard`](../../packages/blueprint-whiteboard/README.md) and the bundled `format.whiteboard` archive

**Research:** [`whiteboard-improvement-options.md`](../research/whiteboard-improvement-options.md)

## Objective

Improve the Whiteboard's reliability, daily editing experience, large-board performance, security, and sharing without discarding its tested operation model or making an external service part of every edit.

The work is deliberately incremental. Each phase must leave a shippable blueprint, preserve old stored boards through `schemaVersion` migrations, and keep the current RPC methods compatible for agents and replayed calls.

## Scope

### In scope

- Accurate saved/reconnecting/unsaved state and a non-destructive reconnect path.
- Alignment guides, snapping, align/distribute, connector endpoint editing, curated icon/stencil packs, clipboard workflows, shortcuts help, deep links, and presentation mode.
- Client spatial indexing, viewport culling, panel virtualisation, adaptive presence, and privacy-safe performance counters.
- A platform proposal and implementation seam for authenticated viewer sessions and server-enforced roles.
- Data-only backup/import and a design for static published snapshots.
- Refactoring the three oversized modules along existing boundaries.
- Tests, migration fixtures, archive packing, documentation, and rollout evidence.

### Deferred until prerequisites exist

- Comments, mentions, voting, and compliance-grade audit: require verified actor identity and policy decisions.
- Image uploads: require an authorised, quota-controlled blob capability backed by R2 or an equivalent service.
- Live public/view-only links: require a host-enforced read-only capability.
- Snapshot pagination/delta replay: implement only if instrumentation shows full snapshots are a real bottleneck.
- External search/audit projection: implement only for a defined organisation-wide requirement.

### Non-goals

- Replacing the custom canvas with tldraw/Excalidraw in this programme.
- Rewriting the whole board as Yjs/CRDT.
- Sharding one board across multiple Durable Objects.
- Making Postgres or another remote database synchronous in the gesture commit path.
- Rendering arbitrary HTML or unsanitised inline SVG. A future SVG import may compile a strict subset to inert primitives or ingest it as a bounded image.
- Automatically modifying existing whiteboard gadget code without a reviewed platform upgrade mechanism.

## Design principles

1. The board Durable Object remains the authoritative coordinator for committed board state.
2. Ephemeral presence is never persisted and must degrade before committed operations do.
3. The server validates every imported or generated object through the same normalisers and limits as interactive edits.
4. Display names from the client are labels, not authority.
5. No content, names, stable IDs, coordinates, or operation payloads enter telemetry.
6. Selected, focused, edited, and remotely transformed objects remain rendered even when outside normal culling bounds.
7. Existing agent methods remain compatible; new methods are additive.
8. Every gesture has a keyboard/button equivalent.
9. Keep `blueprintId: format.whiteboard`; pack and commit the archive and sidecar with every shipped source change.
10. Stored board objects and portable backups never contain executable markup; exports are generated from trusted renderer primitives.
11. Third-party visual assets are pinned, reproducibly compiled, and shipped with licence/notice metadata.

## Target component boundaries

| Boundary | Responsibility | Planned source |
| --- | --- | --- |
| Host identity/connection | Authenticated viewer, effective role, replaceable RPC target | Cloudflare OS `GadgetUI`/`GadgetClient` extension; fork patch until upstreamed |
| Client application | Commands, panels, connection status, help, presentation | `src/client/ui/` |
| Canvas controller | Camera, selection/focus, gestures, render scheduling | split from `src/client/ui/canvas/index.js` |
| Client model/index | Object view, dependency graph, spatial queries | `src/client/model/` |
| Sync session | Subscribe/reconnect, pending operation queue, idempotent retry | split from `src/client/sync/store.js` |
| Presence session | Adaptive send policy, peer state, expiry | split from `src/client/sync/store.js` |
| Server session facade | Verified actor and role, rate budgets, RPC delegation | new only after host identity seam |
| Whiteboard core | Validated operations, history, undo, convenience commands | split from `src/core/whiteboard.js` |
| Repository | Atomic Durable Object storage commits | `src/server/do-repository.js` |
| Realtime hub | Operation and presence fan-out/backpressure | `src/core/hub.js` |
| Optional services | Blob assets or published snapshots; never required for ordinary text/shape edits | separate Gatekeeper/Worker after security review |

The intended data flow is: the authenticated host creates a viewer-bound session; the iframe submits idempotent operations through that session; the core commits once to Durable Object storage; committed deltas fan out through the hub. Presence uses the same session but a separately throttled, memory-only channel. Optional asset/publish services receive explicit, capability-scoped calls and are not in the ordinary operation path.

## Phase 0 — establish baselines and decisions

### 0.1 Correct the baseline documentation

- Update [`docs/plans/whiteboard-blueprint.md`](whiteboard-blueprint.md) from shipped revision 4 to the current revision recorded by the manifest/lock.
- Remove the obsolete “asked for a name” statement from the gadget [`src/README.md`](../../packages/blueprint-whiteboard/src/README.md).
- Add a compact compatibility table: schema version, RPC protocol version, archive revision, and minimum host feature set.
- State prominently that a new bundled revision affects newly created whiteboards only.

Acceptance:

- Manifest, lock, source README, package README, and plan agree on current identity behavior and shipped revision.
- Documentation link checks pass.

### 0.2 Add a reproducible performance harness

Extend the existing harness with deterministic fixtures for 500, 2,000, and 5,000 objects, including frames, connectors, long text, and pen strokes.

Measure:

- initial snapshot bytes and time;
- Durable Object cold/warm load time;
- client model construction time and heap estimate;
- SVG node count;
- pan/zoom frame time and long tasks;
- hit-test latency;
- single and 100-object operation round-trip latency;
- gap recovery time;
- inbound/outbound presence calls and estimated bytes for 1, 10, 50, and 200 viewers.

Add thresholds as test configuration rather than hard-coding machine-specific wall-clock assertions in ordinary unit tests. CI should assert algorithmic proxies (rendered node count, scan count, calls, bytes); a scheduled/manual benchmark records timing.

Files:

- new `test/performance/fixtures.js`
- new `test/performance/model.test.js`
- extend `harness/` and `e2e/harness.test.mjs`
- optional `scripts/benchmark.mjs`

Acceptance:

- One command produces a JSON/Markdown benchmark report without board content.
- Current revision results are committed as the comparison baseline.

### 0.3 Resolve product-policy questions

Record decisions for:

- all collaborators edit versus viewer/editor/facilitator roles;
- collaboration history versus compliance audit;
- target simultaneous active editors;
- whether existing instances must be upgradeable;
- whether comments need external notifications;
- whether images must work with zero connection setup.

Stop identity, comments, voting, live view-only sharing, and image implementation until their corresponding decisions are made.

## Phase 1 — connection truth and recoverability

### 1.1 Model explicit connection/save states

Replace the current loose flags with a documented state machine:

- `connecting`: no initial snapshot;
- `live`: subscribed and no pending work;
- `saving`: live with queued/in-flight committed operations;
- `reconnecting`: subscription/RPC is being replaced; queue retained;
- `recovery-required`: automatic recovery budget exhausted; pending work may exist;
- `read-only`: authenticated session lacks edit authority (enabled after Phase 4).

Expose derived values on the store contract: `pendingCount`, `oldestPendingAt`, `lastAcknowledgedRevision`, and `riskOfLoss`.

Files:

- `src/client/store-contract.js`
- new `src/client/sync/connection.js`
- `src/client/sync/store.js`
- `src/client/ui/app.js`

Acceptance:

- “Saved” appears only when the pending queue is empty and the last response is acknowledged.
- A screen reader is notified on meaningful state transitions, not every retry.
- The UI tells the user when reload may lose a change.

### 1.2 Add a replaceable host connection seam

Preferred host API:

- the gadget iframe receives a stable forwarding target whose underlying `Gadget` stub can be replaced;
- the host emits `connectionLost`, `connectionRestored`, and terminal failure events or exposes an awaited `reconnect()` method;
- replacing the target does not reload the iframe;
- a queued call either completes once or rejects clearly; it is never ambiguously applied without an idempotency key.

The sync store retains pending operations and their request IDs, resubscribes, reconciles from the authoritative snapshot/revision, and replays only unacknowledged operations.

This requires a core/fork change and should be proposed upstream as a generic gadget-session facility rather than a Whiteboard special case.

Interim blueprint behavior:

- never auto-reload while an operation RPC is unresolved unless the terminal recovery timeout has elapsed;
- show the pending count on the terminal recovery screen;
- offer a data-only download containing the last acknowledged snapshot plus pending operations;
- never store that recovery payload in `window.name` or logs.

Acceptance:

- Killing/restarting the facet during a queued edit reconnects without destroying the iframe and applies the edit at most once.
- If the host cannot refresh the stub, the UI stops and explains the risk before reload.
- Tests cover response loss after commit, response loss before commit, duplicate replay, snapshot gap, and repeated host failure.

### 1.3 Recovery tests

Add deterministic network cases for:

- commit succeeds and reply is lost;
- request never reaches the server;
- operation broadcast arrives before the request result;
- restart between subscribe registration and snapshot response;
- three consecutive target replacements;
- an edited/deleted object conflicts while the client is reconnecting.

Preserve random request IDs and per-sender replay matching.

## Phase 2 — high-value editing usability

All Phase 2 features use the existing `applyOperation` protocol and require no storage migration.

### 2.1 Alignment guides and snapping

Add a client geometry module that indexes candidate edges and centres for objects near the moving/resizing selection.

Behavior:

- snap to object left/centre/right and top/middle/bottom;
- optional grid snap matching the visual grid;
- show only the winning horizontal and vertical guides;
- threshold is screen-space stable across zoom;
- hold a documented modifier to disable snapping temporarily;
- keyboard moves remain exact and gain explicit Align/Distribute commands rather than implicit snapping.

Files:

- new `src/client/model/spatial-index.js`
- new `src/client/model/alignment.js`
- `src/client/ui/canvas/gestures.js`
- `src/client/ui/canvas/presence-layer.js` or a new guide layer
- `src/client/ui/stylebar.js`

Tests:

- rotated bounds, mixed sizes, frames, zoom invariance, multi-select, modifier bypass, and no snap to the moving set.

### 2.2 Align and distribute

Add left/centre/right/top/middle/bottom alignment and horizontal/vertical distribution for multi-selection.

- Build one atomic update request.
- Preserve selection order only where it is meaningful; distribution sorts by geometry.
- Expand a selected frame to its members only when the existing move semantics already do so.
- Add buttons/menu commands and keyboard-accessible labels.

Acceptance:

- Concurrent edits use the existing geometry delta rebase.
- One undo reverses the whole command when the inverse fits the existing limit.

### 2.3 Connector endpoint editing

Add draggable endpoint handles and `Reconnect start`/`Reconnect end` commands.

- During drag, highlight valid non-connector targets.
- Preserve the other endpoint, label, routing, sides, style, and stacking.
- Drop on empty space cancels rather than creating an invalid connector.
- Server `invalid_ref` remains authoritative if the target disappeared.
- Keyboard path: choose endpoint, open searchable object picker, choose target.

Tests cover endpoint deletion races, self-links, connector targets, frame targets, keyboard flow, and touch size.

### 2.4 Curated icon and stencil packs

Create a pack registry that supports multiple versioned sources while shipping only:

- a first-party core diagram pack containing common flowchart and architecture stencils; and
- one compact general icon subset chosen after comparing pinned [Tabler Icons](https://github.com/tabler/tabler-icons) and [Lucide](https://github.com/lucide-icons/lucide) sources for visual fit, licence/notice requirements, archive size, and rendering consistency.

Do not fetch packs at runtime. The gadget CSP has `connect-src 'none'`, and reproducible archives require the exact glyph set to be local.

Add a build-time compiler, for example `scripts/build-icon-packs.mjs`, which:

1. reads only pinned, declared source files;
2. parses rather than regex-rewrites XML;
3. accepts bounded numeric geometry for `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, and `g`;
4. rejects scripts, event attributes, links, `foreignObject`, `image`, `use`, CSS, animation, filters, masks, patterns, URL values, unsupported transforms, and unknown elements/attributes;
5. enforces source bytes, element count, path-command count, coordinate count, nesting depth, and finite/view-box bounds;
6. normalises accepted content to the renderer's inert virtual-node representation; and
7. emits deterministic generated geometry, search metadata, upstream version/hash, and a licence manifest.

Suggested files:

- `src/shared/icons/registry.js` for lookup and stable public IDs;
- `src/shared/generated/icon-packs.js` for checked-in compiler output;
- `src/client/ui/icon-picker.js` for categories, fuzzy search, recent icons, keyboard navigation, and insertion;
- `scripts/build-icon-packs.mjs` and malicious/complexity fixtures;
- `THIRD_PARTY_NOTICES.md` for upstream attribution and licences.

Add `icon` to the object protocol with a stable `packId` and `iconId`, plus the existing geometry and style fields. The source SVG is never stored. Pack IDs are versioned; a published ID continues resolving forever, and a materially changed glyph receives a new version. Update normalisation, byte estimation, bounds, hit testing, the spatial index, shared rendering, copy/paste, backup/import, object-list labels, culling, and SVG/PNG export in the same change.

Add `findIcons({ query, packId?, limit? })` and `addIcons({ icons })` convenience methods. Results expose stable IDs, labels, tags, and intrinsic aspect ratio; callers never submit markup. Document the catalogue and keep existing agent methods compatible.

Acceptance:

- The picker is fully keyboard accessible, gives each result an accessible name, and inserts by click or drag.
- Icons can be recoloured where the pack declares themeable fill/stroke behavior, without mutating source geometry.
- The UI, exported SVG, and future PNG export use the same compiled geometry and produce matching bounds.
- Malicious SVG fixtures fail the compiler; excessive but syntactically valid geometry fails deterministic limits.
- Pack generation is reproducible, licence notices are present, and archive/start-up budgets pass.
- No icon insertion, rendering, or search performs a network request or parses raw SVG at runtime.

Organisation-specific packs may later run through the same reviewed compiler during deployment. Do not add end-user pack upload until an isolated ingestion service can enforce ownership/licensing, compiler limits, quotas, and version retention.

### 2.5 Clipboard and data-only backup

Define `application/vnd.cloudflare-os-whiteboard+json;version=1`:

```json
{
  "version": 1,
  "objects": [],
  "origin": { "x": 0, "y": 0 }
}
```

Rules:

- copied connectors are included only when both endpoints are copied;
- IDs are regenerated on paste and internal references remapped;
- timestamps, versions, `createdBy`, and order keys are not trusted from clipboard input;
- paste is offset near the pointer/viewport and submitted through normal create ops;
- plain text pastes as one sticky per non-empty line, subject to operation/text caps;
- `Download board backup` exports a versioned JSON snapshot;
- import previews counts and errors, then creates through the normal validation path in bounded batches;
- never render clipboard HTML or SVG as active markup;
- extract supported plain-text/table semantics into normal board objects;
- defer editable SVG import until the same allowlisted compiler can run safely at ingestion, or ingest it as a bounded image/raster asset instead.

Add agent methods only if needed: `exportData()` and `importData()` with the same caps. Keep current convenience methods unchanged.

### 2.6 Discoverability and navigation

- Add a shortcuts/help dialog generated from the same command definitions as key handling.
- Add empty-board onboarding with three actions: add a sticky, paste text, or choose a template.
- Add `#frame=<id>` and `#object=<id>` links; resolve only after the initial snapshot, focus/fit safely, and ignore invalid/deleted IDs.
- Add `Copy link to frame/object` without including content in the URL.
- Update the user guide and E2E selectors.

## Phase 3 — large-board client performance and presence cost

### 3.1 Refactor before optimisation

Make behavior-preserving splits with characterization tests:

- `core/whiteboard.js` → `state.js`, `validation.js`, `operations.js`, `history.js`, `commands.js`, facade;
- `client/sync/store.js` → `session.js`, `queue.js`, `reconcile.js`, `presence.js`, facade;
- `client/ui/canvas/index.js` → `controller.js`, `scheduler.js`, `selection.js`, and host/event wiring.

Do not mix these moves with protocol or behavior changes. Preserve public imports with re-exports until callers migrate.

Acceptance:

- Existing unit/fuzz/harness/workerd suites pass without fixture changes other than import paths.
- No archive revision is shipped for a source-only refactor unless output bytes change.

### 3.2 Spatial index

Maintain a client spatial index of effective object bounds:

- shapes/text/pens/frames index their rotated bounds;
- connectors index the route bounds and update when either endpoint changes;
- creates, updates, deletes, rebase, snapshot replacement, and undo update the index incrementally;
- debug/test mode compares indexed queries with a brute-force scan.

Use the index for hit testing, marquee candidates, nearest alignment candidates, minimap aggregation, and viewport render selection.

Start with a simple fixed-grid index that is easy to fuzz. Move to an R-tree only if measurements show the grid performs poorly across realistic object sizes.

### 3.3 Viewport culling

Render committed SVG objects intersecting the viewport plus an overscan margin. Always pin:

- selected, focused, hovered, or text-edited objects;
- objects in an active local gesture;
- objects transformed by remote presence;
- connector endpoints needed by a rendered connector;
- a connector when either endpoint or its own route bounds are visible.

Do not cull data from the client model. Accessibility navigation through the Objects panel must still reach any object; selecting an off-screen object pans it into view before moving DOM focus to its controls.

Acceptance:

- At 5,000 off-screen simple objects, rendered SVG groups stay proportional to viewport contents plus a documented bound.
- Panning does not flash objects at viewport edges.
- Selection, connectors, text editing, follow mode, minimap, export, and presence ghosts remain correct.

### 3.4 Virtualise panels

Virtualise Objects and Activity rows while retaining correct list counts, keyboard navigation, focus restoration, and screen-reader position metadata (`aria-setsize`/`aria-posinset` where appropriate).

### 3.5 Adaptive presence

Separate heartbeat health from visual-state publication.

- Send immediately on join, selection/editing changes, gesture start/end, follow changes, and pointer re-entry.
- While moving, cap to a measured target (initial experiment: 20 Hz) and deduplicate equivalent rounded states.
- When idle, send heartbeat only.
- When `document.visibilityState !== "visible"`, clear cursor/gesture once and use heartbeat-only traffic.
- Back off visual rate when an update is in flight or peer count crosses measured thresholds.
- Preserve server-side token bucket, coalescing, byte cap, slow-subscriber eviction, and session validation.

Consider a presence-patch protocol only after the adaptive full-state version is measured. A patch version needs an explicit protocol number and a full-state repair path.

Acceptance:

- Cursor/ghost perceived latency remains within the agreed budget for a normal small team.
- An idle visible tab and a hidden tab emit no gesture-frequency traffic.
- The 50-viewer simulation stays within the agreed RPC/byte budget.

### 3.6 Snapshot/delta decision gate

After 3.1–3.5, compare measurements with Phase 0. Implement a new load protocol only when either:

- p95 initial snapshot transfer/parse exceeds the product budget at a supported board size; or
- Durable Object wake/load exceeds the budget because rebuilding all indexes dominates.

If triggered, design `subscribeV2` around a consistent snapshot plus a bounded persisted delta journal:

1. Register the subscriber.
2. Record snapshot revision `R`.
3. Transfer versioned snapshot pages or a stream.
4. Apply deltas `R+1..current` from the journal.
5. If the journal no longer covers `R`, restart from a newer snapshot.

Do not ship page-at-a-time `getObjects()` without this consistency mechanism.

## Phase 4 — verified identity and server-enforced roles

This phase spans the pinned Cloudflare OS fork and the blueprint. It is a trust-boundary change and needs specialist/upstream review.

### 4.1 Specify a generic viewer-bound gadget session

Proposed host contract:

```ts
type VerifiedGadgetViewer = {
  subject: string;       // stable opaque deployment-local ID
  displayName: string;
  role: "view" | "edit" | "facilitate" | "build";
  gadgetId: number;
  sessionId: string;
  expiresAt: number;
};
```

The authenticated `GadgetClient`, not iframe code, creates the session. The server receives a per-viewer session capability/facade. Raw viewer data is not accepted as proof. Sessions expire and are invalid after sharing/access revocation; reconnection obtains a fresh session.

Prefer a session capability over one signed assertion per pointer-up: it avoids a security-token mint/redeem round trip for every edit while retaining a narrow gadget/session scope.

Required threat-model tests:

- forge display name/role/subject;
- replay an expired session;
- use a session for another gadget;
- continue after access revocation;
- hand a session to another iframe/client;
- bypass the session and call the shared mutation facet directly;
- reconnect during a mutation;
- build-role code preview versus committed gadget.

The shared mutable facet must not remain as an alternate path around the session policy.

### 4.2 Change attribution storage

Add `actor` to operations/history and `createdBy` replacement data:

```js
actor: { id: "opaque-id", displayName: "Name" }
```

Migration policy:

- schema v1 entries remain `{by}` and are labelled unverified/legacy;
- new entries store the verified actor ID and display-name snapshot;
- UI handles renamed/deleted accounts without rewriting history;
- do not store email addresses unless explicitly approved as the deployment's stable identifier.

Keep the public agent methods' optional `by` only as an automation label. The server separately records the verified calling principal when the platform can supply one; do not conflate “Assistant” with a person.

### 4.3 Enforce roles and quotas

- `view`: snapshot/subscription/presence and export, no mutations.
- `edit`: normal object/structure writes; undo own verified changes.
- `facilitate`: edit plus undo any change and run facilitation features.
- `build`: existing workspace builder authority; board policy must decide whether that implies facilitate.

Add per-session token buckets for mutation requests and operation counts. Global board caps and mutation queue remain. Return structured retryable errors without including content.

Acceptance:

- Direct RPC calls cannot escalate role or forge history attribution.
- Revoked/view-only sessions fail closed on writes.
- Existing v1 boards remain readable; legacy entries are not misrepresented as verified.

## Phase 5 — sharing and review

### 5.1 Presentation mode

- Order frames by existing `z` and then ID; later add explicit presentation order only if users need it.
- Fullscreen-like canvas mode hides editing chrome, fits one frame, and provides next/previous/exit.
- `#frame=<id>&present=1` starts at a frame after access is checked.
- Viewers can follow the presenter only by explicit action; do not force camera movement silently.
- Keyboard and reduced-motion behavior are tested.

### 5.2 Static published snapshots

Design a separate publish capability with:

- immutable snapshot version;
- owner/facilitator approval;
- explicit public/authenticated audience, expiry, and revocation;
- sanitised SVG/HTML generated from the shared renderer;
- no Gadget RPC, presence, comments, credentials, or live mutation path;
- cache and content-security headers appropriate to static content;
- clear “snapshot from <time>” UI.

Do not implement this by creating an unauthenticated route to the gadget Durable Object.

### 5.3 Data portability

- Finish versioned JSON backup/import from Phase 2.
- Add a migration registry for backup format versions independent of stored `schemaVersion`.
- Include title/background/objects but exclude presence, history, request IDs, viewer IDs, sessions, and credentials by default.
- Provide an optional history-inclusive administrative export only if compliance policy requires it.

## Phase 6 — richer collaboration and content

Start only after Phase 4 identity and role enforcement.

### 6.1 Comments and mentions

Use separate records (`comment:<id>` and bounded thread indexes), not fields inside drawable objects.

Define before coding:

- object-anchored versus coordinate-anchored threads;
- resolved/deleted behavior when an object is deleted or restored;
- edit/delete windows and facilitator powers;
- retention and export;
- mention syntax and whether notification delivery is required.

If notifications are required, invoke a reviewed Gatekeeper asynchronously after the authoritative comment commit. Delivery failure must not roll back the comment; store a bounded delivery status/outbox.

### 6.2 Templates

Ship a small static gallery (brainstorm, retrospective, journey map, architecture sketch). Templates expand into ordinary operations and are fully undoable. Keep template JSON versioned and covered by the normal caps.

### 6.3 Images/assets

Required service behavior:

- R2 object storage outside the board's 8 MiB object budget;
- capability-scoped upload/read/delete;
- MIME sniffing and an allow-list, maximum encoded/decoded size and dimensions, quota per board/account, and safe download headers;
- opaque asset IDs in board objects, never raw public URLs as authority;
- lifecycle rules for orphaned uploads and board deletion;
- image rendering that cannot execute SVG/script content;
- export behavior for missing/expired assets.

Prefer a host-native optional asset API so **New → Whiteboard** remains zero-configuration. If implemented as a Gatekeeper binding, the blueprint landing flow and missing-connection UX must be accepted explicitly.

Add `image` to the object protocol only after the service contract is tested. This becomes a stored schema migration.

### 6.4 Checkpoints and restore

Add named checkpoints after deciding retention and storage budget.

- A checkpoint records a revision and immutable snapshot reference.
- Restore is a new operation producing a normal history event; it does not silently replace storage.
- Large restores are bounded and may require a background/import protocol.
- Checkpoints do not replace external backup or blueprint code versions.

## Optional enterprise projection

Do not implement by default. If cross-board search, retention, analytics, or e-discovery is approved:

1. Define the minimum projected fields and permission model.
2. Emit a versioned outbox event after the Durable Object commit.
3. Deliver asynchronously to an organisation service; retries never block edits.
4. Make events idempotent by board ID and revision.
5. Treat the external database as a rebuildable derivative.
6. Re-check access at query time; deleting/revoking a board must remove or hide its projection.
7. Never project cursor/presence data.

Postgres is appropriate for the projection and organisation-wide queries. It is not the primary whiteboard transaction coordinator.

## Migration and compatibility strategy

### Version axes

Track these independently:

- **Stored schema version:** Durable Object data shape (`meta.schemaVersion`).
- **Wire protocol version:** subscription/presence/load semantics.
- **Backup format version:** portable board JSON.
- **Bundled blueprint revision:** archive bytes installed as `format.whiteboard`.
- **Minimum host capabilities:** e.g. viewer session and replaceable connection.

### Rules

- Run storage migration before every read/write entrypoint through the existing core load gate.
- Migrations are deterministic, idempotent, bounded, and tested from every historical fixture.
- Additive RPCs precede client use; keep old methods until shipped clients/archives no longer rely on them.
- A new client must tolerate legacy history entries and a legacy server must never receive a new protocol accidentally; negotiate explicitly.
- Never change `format.whiteboard`.
- Packing a new revision changes only new instances. For existing boards, offer a reviewed code-upgrade/copy flow or document that the feature is new-instance-only.

## Test plan

### Unit and property tests

- Geometry: snapping, alignment, distribution, endpoint picking, viewport intersection.
- Spatial index: incremental mutations versus brute-force queries under fuzz.
- Clipboard/import: ID/reference remap, malicious keys, caps, truncated text, invalid connectors, duplicate IDs.
- Icon packs: deterministic compilation, stable ID resolution, renderer/export parity, search, licence manifest, and rejection of active or excessive SVG fixtures.
- Sync: reconnect matrices, acknowledgement ambiguity, queue replay, conflict during reconnect.
- Presence: adaptive cadence, hidden tabs, deduplication, slow receiver, peer-count backoff.
- Identity: role matrix, forged fields, replay, expiry, revocation, cross-gadget use.
- Migrations: all stored/backup versions and legacy attribution.

### Harness E2E

- Two users snap/move the same objects and converge.
- Reattach a connector while its target is moved/deleted remotely.
- Copy in one pane and paste in another board fixture.
- Pan through a 5,000-object board while DOM-count assertions remain bounded.
- Keyboard-only creation, alignment, endpoint editing, deep-link navigation, and presentation.
- Screen-reader-visible object selection outside the current viewport.
- Connection replacement with queued writes and no iframe reload.

### Local platform/workerd

- Signed-in viewer identity and role reach the server session without client trust.
- The proposed `view` role cannot call mutation RPCs directly; any decision to map today's `use` role to edit or view is tested explicitly.
- Code-edit/facet restart refreshes the target and preserves queued work.
- SVG, HTML, PDF, JSON backup, and future PNG exports.
- Archive instantiation through **New → Whiteboard**.
- No undisposed RPC warnings in ordinary churn; preserve the documented platform-abort exception evidence if it still exists.

### Accessibility

- Automated name/role/state tests for every new control.
- Focus order and focus restoration with virtualised lists/culling.
- Pointer gesture equivalents and touch target sizes.
- Reduced-motion presentation/follow behavior.
- Contrast and forced-colours checks for guides, handles, selection, presence, and connection states.

### Security and abuse

- Operation/request/presence floods.
- Oversized clipboard/backup/assets and decompression/image bombs.
- Stored text/SVG escaping, CSP behavior, raw-markup rejection, popup escape attempts, and exported-file active-content checks.
- Session theft/replay/cross-board attempts.
- Permission revocation during open sessions.
- Public snapshot contains no credentials, sessions, history, private metadata, or live endpoints.

## Observability

Emit sampled structured counters/timings only:

- board object count and conservative byte bucket;
- snapshot load/serialize duration and byte bucket;
- operation count, touched-object bucket, queue latency, result class;
- subscriber-count bucket, presence calls/bytes, coalescing, drops/backpressure;
- reconnect attempts/outcome and pending-count bucket;
- render node count/frame-time bucket from opt-in local diagnostics, not raw remote telemetry by default.

Never log board text, titles, display names, viewer IDs, object IDs, coordinates, request IDs, comments, asset names, or serialized payloads.

Add a local diagnostics dialog that users can copy as sanitised JSON for support. It should show versions, counts, connection state, recent error codes, and timing buckets.

## Delivery and rollout

For each phase:

1. Land behavior behind an internal capability/protocol check where old hosts may exist.
2. Run the narrow unit, fuzz, harness, workerd, archive, and local-platform suites.
3. Run `pnpm --filter blueprint-whiteboard pack:gadget`; inspect the revision and deterministic content hash.
4. Verify `formats/whiteboard.gadget` and `formats/whiteboard.json` changed together and `blueprintId` did not.
5. Run the repository's full `pnpm check` when the workspace package-manager environment is healthy.
6. Deploy to an isolated evaluation environment with separate Worker identities and data.
7. Verify new-instance creation, two real identities, reconnect/restart, exports, accessibility smoke, and privacy-safe logs.
8. Record that existing whiteboards remain on their copied code, and provide the chosen upgrade/copy instructions.
9. Roll out production through the normal starter approval and rollback procedure.

No deployment is part of this plan document.

## Exit criteria by milestone

### Milestone A — reliable and easier

- Phases 0–2 complete.
- No misleading saved state; terminal recovery protects or exports pending work.
- Snapping, alignment/distribution, connector reattachment, curated icons/stencils, clipboard, help, and deep links work with mouse, touch where applicable, and keyboard.

### Milestone B — large-board ready

- Phase 3 complete.
- 5,000-object client DOM and interaction budgets pass.
- Idle/hidden presence traffic is reduced and the 50-viewer simulation meets the agreed budget.
- Snapshot/delta gate has a recorded go/no-go decision based on measurements.

### Milestone C — trustworthy collaboration

- Phase 4 complete and reviewed upstream/security-wise.
- Server-enforced roles and verified actor attribution pass adversarial tests.
- Legacy entries are clearly represented and no client string grants authority.

### Milestone D — share and extend

- Presentation, deep links, data backup/import, and the approved static publishing path are complete.
- Comments/images/checkpoints are delivered only where their prerequisites and policies are satisfied.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Culling breaks selection/connectors/accessibility | Pin special objects, compare index to brute force, run keyboard/screen-reader E2E |
| Reconnect replays a committed edit | Retain the same random request ID and reconcile before replay |
| Identity patch creates an alternate bypass | Route all mutable calls through the session facade; adversarial direct-RPC tests |
| Rich features inflate storage/value size | Separate comments/assets, keep conservative byte accounting, add quotas before UI |
| Icon catalogues inflate the archive or introduce licence drift | Ship a curated subset, pin sources/hashes, generate notices, and enforce archive/start-up budgets |
| Imported SVG executes or becomes active after export | Never store raw markup; compile an inert allowlist or ingest as a bounded image/raster; generate exports only from trusted primitives |
| Presence tuning feels laggy | Measure perceived latency, send gesture boundaries immediately, degrade adaptively |
| Refactor destabilises mature sync logic | Characterisation-only commits, no behavior changes mixed with moves |
| New blueprint revision leaves old boards behind | Decide and document an explicit existing-instance upgrade/copy path before launch |
| External projection leaks revoked data | Derivative-only design, permission-filtered queries, deletion/revocation events, no presence |

## Definition of done

- Code, README, protocol/schema compatibility notes, archive, sidecar, and tests land together.
- Node, workerd, fuzz, harness, local-platform, archive-staleness, accessibility, and applicable security suites pass.
- Performance results meet the agreed budgets at supported limits.
- Trust-boundary changes have an explicit security review and upstream/fork disposition.
- Icon packs are reproducibly generated from pinned sources, retain stable IDs, and include complete third-party notices.
- No new Worker, binding, route, secret, R2 bucket, or external database is required unless its phase explicitly adds it and the operator approves that deployment boundary.
- Production verification uses two real identities and records the exact blueprint revision tested.
