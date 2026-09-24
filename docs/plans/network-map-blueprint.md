# Network Map blueprint: a Kumu-like systems and relationship mapper

Build a collaborative network-mapping blueprint in the spirit of [Kumu](https://kumu.io): elements, connections and loops, with typed fields, rule-based views and social-network metrics. Its priorities within Cloudflare OS are:

1. **Automatic data loading** from connectors: Synthetic Data, Records, Search and, later, a graph-source connector.
2. **Agentic data creation**: an agent reads connected sources, workspace documents and web pages, then *proposes* elements and connections with citations. People review the proposals before anything lands.
3. **GPU rendering**: sigma.js (WebGL) for editable maps, cosmos.gl (GPU force simulation) for very large read-only graphs, and Vega-Lite for the analytics panels.

**Working names:** blueprint `format.network-map` (never rename it once shipped; it is the install key), package `packages/blueprint-network-map`, output noun "map". The product name is open question Q1.

**Status:** Phase 0 (the Phase 1 gates) and Phase 1 are built on branch `feat/network-map` (2026-09-24), not yet committed or deployed; see the [Phase 1 delivery record](#phase-1-delivery-record-2026-09-24). Phases 2–5 have not started.

**Release boundary:** v1 means Phase 1: a useful, collaborative editor with reviewed file imports and no connector or model requirement. Phases 2–5 are separate releases, not prerequisites for v1. The scale figures below are benchmark targets, not established capacity. If a spike fails, record the supported limit or deferred feature before implementation proceeds.

**Sources for the constraints below:**
- `docs/plans/tessera-blueprint.md`: WebGL2, the CSP, `data:` workers, the optional-connector pattern and the adapter contract.
- `packages/blueprint-whiteboard`: the op model, presence, undo, size caps and culling.
- `docs/plans/agentic-wave-blueprint.md` and `packages/blueprint-wave`: agent runs, proposals and budgets.
- `packages/blueprint-procgen-explorer/src/client/chart.js`: Vega under the CSP.
- `docs/research/external_datastores/gadget-connectors-and-services.md` and the two datastore plans under `docs/plans/external_datastores/`.
- Runtime behavior must be backed by a source path or a reproducible platform test; memory notes alone are not evidence.

### Review decisions (2026-09-24)

- Preserve `format.network-map` independently of the display name.
- Keep sigma + graphology as the first renderer candidate; defer the second GPU renderer and Vega until their phases and measured bundle budgets permit them.
- Use stable source keys, explicit field ownership and complete-snapshot checks before detecting deletions.
- Treat proposal review as a workflow until a server-verifiable human acceptance path is proven. A caller-supplied name or changeset ID does not establish approval.
- Bound storage and transport by bytes as well as counts, including history, metrics, proposals and images.
- Keep Graph Sources as a separate capability and deployment design review; this document does not authorize its provisioning.

---

## 1. Goals and non-goals

**Goals**
- A person can create a map with New in one click. It opens on a demo system map, with no setup page.
- The editor feels like Kumu: add elements and connections quickly, type them, and fill in custom fields and descriptions. Views control decoration, filtering, clustering and focus. Metrics size and colour elements. Presentations step through views.
- Maps are collaborative in real time, with the same guarantees as the whiteboard: per-object versions, idempotent retries, presence, server-side undo and honest save state.
- Maps load data from any bound connector through a declared **source mapping** (rows → elements and connections). They refresh on demand or live, without overwriting people's manual edits.
- An agent can build or extend a map from sources. Every proposed element, connection and field value carries evidence and must be accepted by a person.
- Performance:
  - 60 fps pan and zoom at 10,000 elements and 30,000 connections in the editable renderer, on a mid-range laptop.
  - Interactive exploration of 100,000+ nodes in the large-graph mode.
- Analytics: degree, betweenness, closeness, eigenvector/PageRank, communities and components, shown as fields and as Vega-Lite charts.
- Export to Kumu JSON, CSV (elements and connections), GraphML/GEXF, PNG and SVG. Import from Kumu's spreadsheet layout and from Kumu JSON, so existing Kumu users can migrate.

**Non-goals for v1**
- Kumu's CSS-like "advanced editor". We ship a structured rule editor. Rules are stored as JSON and a text form can come later (§5.3).
- Map tiles or basemaps. The CSP allows `img-src data:` only, so geographic layout uses a bundled low-resolution outline at most.
- Gadget-to-gadget live links. The platform throws "Gadget-to-gadget bindings are not supported yet" (`overseer.ts:1832`).
- Per-row permissions on map content. Anyone who can open the map sees all of it, as with every other blueprint.
- Replacing Tessera. Tessera shows *rows as cards*, and this blueprint shows *relationships*. They share the adapter contract (§6.2) and can later share adapters as a package.

---

## 2. Platform constraints that shape the design

| Constraint | Consequence |
|---|---|
| Iframe CSP: `script-src data: 'unsafe-inline'`, `connect-src 'none'`, `img-src data:`, no `unsafe-eval` or `wasm-unsafe-eval`, `worker-src` falls back to `script-src` (`GadgetUI.tsx:112`) | Everything is bundled into `client.js`. Workers must be `data:` URLs, not `blob:`. Vega must use `vega-interpreter`. No WASM, so no DuckDB-Wasm, elkjs-wasm or graph WASM libraries. Images are embedded as `data:` URLs. The client cannot fetch anything; all data arrives over gadget RPC. |
| Opaque-origin sandbox without `allow-forms`, and no `localStorage` | Use no `<form>` submit; wire click and keydown handlers instead. Per-viewer preferences live on the server, keyed by viewer id, or in `window.name` for the frame's lifetime. |
| Server `globalOutbound: null` | The gadget's server cannot fetch URLs. Importing from a URL (a Google Sheets CSV, GraphML on the web) needs a connector (§6.4). |
| Any declared binding makes New go through `/blueprint/<id>` setup, and bindings cannot be optional (`admin-config.ts:272`) | **Declare no bindings.** Detect connectors at runtime in `env`, as Tessera does. People add connectors from the Connections tab, or the agent adds them with `setGadgetBinding` / `requestConnection`. Whether an `aiModel` can be attached after creation this way is spike S7. |
| Formats are bundled into the Workshop Worker | Provisional budgets: **compressed archive ≤ 600 KiB; core JS ≤ 700 KiB; all client JS ≤ 1.5 MiB**, measured separately. Re-measure the Workshop's compressed upload and startup with all formats; the earlier 7.3 MB figure has no reproducible baseline here. Lazy modules reduce initial browser work, not deployed code size. S6 must establish headroom before approving dependencies. |
| About 45–50 inbound RPC calls per second per gadget, handled one at a time | Batch everything. Layout commits, imports and accepted proposals are chunked ops of ≤ 2,000 objects. Presence is gated to one call in flight. |
| The whiteboard uses conservative serialized-size limits and batched storage writes | Reuse its `storedBytes` estimator as a guard, not an exact memory model. Keep each stored value ≤ 100 KiB and individual objects ≤ 64 KiB; verify facet behavior in S1. Chunk all unbounded collections (§3.3). |
| Facet stubs die after a code edit (`use` role); stubs must be disposed; never use `onRpcBroken`; never name a method `connect` | Copy the whiteboard's connection state machine, reload-if-clean, recovery screen and stub-disposal discipline. |
| Connector reads are audited observations (`authorizeObservation`); writes go through the approval queue | Refreshes are explicit and bounded. Live sync coalesces reads. Nothing writes back to a connector in v1. |

---

## 3. Data model

### 3.1 Entities

```ts
Map meta   { schemaVersion, revision, title, description, defaultViewId, directedDefault,
             lastModified, limits }
Schema     { elementTypes: TypeDef[], connectionTypes: TypeDef[], fields: FieldDef[] }
TypeDef    { id, name, color?, shape?, icon?, description? }
FieldDef   { id, name, kind: 'text'|'longtext'|'number'|'date'|'daterange'|'bool'|
             'choice'|'multichoice'|'url'|'image'|'person', appliesTo: 'element'|'connection'|'both',
             choices?, unit?, computed?: MetricId }
Element    { id, version, label, typeId?, description? (markdown, sanitised), tags[], image?,
             fields: {fieldId: value}, aliases[], externalRefs: ExternalRef[], provenance,
             createdBy, createdAt }
Connection { id, version, from, to, direction: 'directed'|'undirected'|'mutual', typeId?,
             label?, strength?, fields, externalRefs, provenance }
Loop       { id, version, label, connectionIds[] (a cycle), polarity?: 'R'|'B', description? }
View       { id, version, name, rules: Rule[], filter?: Selector, focus?: FocusSpec,
             cluster?: ClusterSpec, layout: LayoutSpec, legend: 'auto'|LegendSpec, charts: ChartSpec[] }
Presentation { id, version, name, steps: [{viewId, focus?, selection?, camera?, caption (markdown)}] }
Source     { id, version, kind, connectorBinding, mapping: SourceMapping, sync: SyncSpec,
             lastSync?: SyncReport }
Changeset  { id, origin: 'agent'|'import'|'sync', runId?, status, items: ProposedItem[] }
```

**Provenance** is attached to every element, connection and field value:

```ts
Provenance = { origin: 'manual' | 'source' | 'agent' | 'import',
               sourceId?, recordRef?, syncedAt?,          // source-owned
               runId?, evidence?: Evidence[], acceptedBy?, acceptedAt? }  // agent-proposed
Evidence   = { kind: 'record'|'document'|'web'|'text', ref, quote (≤ 400 chars), title? }
ExternalRef = { sourceId, key }   // stable identity for re-sync and entity resolution
```

The shapes above are conceptual, not executable TypeScript. The implementation contract must define field-value unions, null versus unset, validation errors, and separate source/overlay provenance. Use a mixed multigraph: stable connection IDs allow parallel edges and self-links; mutual connections expand into two arcs only in algorithm projections. A named loop is an ordered, closed traversal with explicit orientation, not just an unordered set of edges. Add connection `polarity: '+'|'-'|'unknown'` separately from numeric weight; derive reinforcing/balancing only when all signs and traversal directions are known, otherwise label the loop classification as manual.

Deleting an element must atomically handle incident edges, affected loops and view references. A merge preview lists all rewrites and field conflicts; apply it against expected versions. Duplicate labels are allowed and never constitute identity by themselves.

### 3.2 Source-owned and user-owned fields

To preserve manual edits across refreshes, each element carries two layers:

- **Source layer.** Fields written by a source mapping, keyed by `sourceId`. A re-sync replaces only this layer.
- **Overlay layer.** Fields people or accepted agent proposals have set. Where both layers set the same field, the overlay wins, and the UI shows a "differs from source" badge with a *Revert to source* action.

A record that disappears from the source makes the element a **tombstone candidate**. The sync report lists it, and a person decides whether to *Remove* it or *Keep as manual*. Deletions are never automatic unless the mapping sets `onMissing: 'remove'`.

Apply these layers to connections and built-in attributes such as labels and types too. Missing overlay means inherit; an explicit null means clear. Removing an override restores inheritance. If multiple sources supply a field, use a saved source-priority order and show competing values; refresh order must not determine the winner. Detaching a source preserves the effective values as manual only after preview and confirmation. `onMissing: 'remove'` may remove only that source's contribution; it must not delete content owned by another source or an overlay.

### 3.3 Storage layout (ctx.storage)

The key layout follows the whiteboard's (`meta`, `obj:<id>`, `history`, `requests`):

| Key | Content |
|---|---|
| `meta`, `schema` | as above |
| `el:<id>`, `cn:<id>`, `loop:<id>` | one per object, with a 64 KiB cap per object |
| `view:<id>`, `pres:<id>`, `src:<id>` | small objects |
| `pos:<viewId>:<chunk>` | columnar `{ids[], x Float32 as base64, y}` in blocks of 2,048. Layout positions are per view (Kumu's perspectives can each have their own layout). |
| `metrics:<jobId>:meta`, `metrics:<jobId>:<chunk>` | bounded vectors keyed by graph revision, projection and algorithm parameters; keep only the latest successful result per configured metric scope |
| `cs:<id>:meta`, `cs:<id>:<chunk>` | manifest and byte-bounded proposal chunks; at most 2,000 items per chunk, and a separate total staging quota |
| `history`, `requests:<chunk>` | history metadata capped at 200 entries / 100 KiB; byte-bounded deduplication records with a map-wide quota and documented retry window |
| `pref:<viewerId>` | a viewer's last view, panel layout and camera |

**Limits for the editable (materialised) map:** 10,000 elements, 30,000 connections, 500 loops, 50 views, 32 MiB total. Spike S1 confirms that facet storage copes with this. If `ctx.storage.sql` is available in facets, elements and connections move to SQLite tables behind the same repository seam (`do-repository.js`), and the limits are re-measured.

These count limits are independent ceilings, not simultaneously guaranteed capacities. The 32 MiB quota includes source layers, overlays, provenance, positions, metric results, proposal staging, undo data and embedded images. Reserve working space before a job starts; reject over-budget work before mutation. Every key, including schema, manifests and preferences, has a byte cap. Position chunks contain pin state and a position version; shrink the nominal 2,048-item block when encoded IDs exceed the value budget. Garbage-collect expired staging/jobs, obsolete metrics and unused position chunks in bounded batches. S1 must measure peak facet memory as well as persisted bytes; a full in-memory copy is not assumed safe.

### 3.4 Large read-only layers

Graphs bigger than the editable limits (for example a 100k-node procgen `events` graph) are **live layers**. They load in bounded pages and render in large-graph mode (§4.2). Keep only a byte-capped, evictable working set in facet memory; a 100k-node full copy is not assumed affordable. Cap visible edges separately and disclose sampling/truncation. A person can **promote** a subset into the editable map: a filter or focus selection of up to 2,000 elements per step becomes source-owned elements, subject to destination byte and edge limits.

---

## 4. Rendering

### 4.1 Decision

| Need | Choice | Why |
|---|---|---|
| Editable maps up to 10k/30k | **sigma.js v3 + graphology**, candidate | WebGL rendering and graph data structures fit the intended split. Custom shapes, arrows, curved parallel edges, picking and CSP compatibility require S3; they are not confirmed. Pin exact versions and audit their transitive dependencies. |
| 100k+ nodes, read-only exploration | **cosmos.gl** (`@cosmos.gl/graph`), lazily loaded | Runs the force simulation and rendering in WebGL shaders, so it handles 100k–1M nodes. Tessera proves WebGL2 works in the frame. Spike S3 checks that its shader and luma.gl path needs no `eval` or `blob:`. |
| Charts, the metrics panel, the adjacency matrix and timelines | **Vega-Lite + Vega + `vega-interpreter`**, lazily loaded | The same route the procgen explorer already ships (`chart.js`). Specs are data, so agents can write them safely: inline data only, validated, no `url` data. |
| WebGPU | Not in v1 | WebGL2 is proven in the frame. WebGPU needs a secure context, and whether an opaque sandboxed frame qualifies is unverified. Spike S9 records it for later. |

G6, Cytoscape.js and deck.gl remain alternatives if S3 fails. Do not reject them on an uncited node-count threshold or assumed bundle size; compare the same graph, labels, interactions and device. The [Sigma documentation](https://www.sigmajs.org/docs/) confirms its WebGL/graphology architecture, not this plan's performance targets. Record the exact Cosmos package, version, license and supported API in S3 before adopting it; library throughput claims are not gadget measurements.

Keep a `Renderer` interface so switching later is local:

```ts
interface Renderer {
  mount(el, graph: GraphModel, opts): void
  setDecorations(decorations: DecorationTable): void  // per-element size, colour, shape, image, label, hidden
  setPositions(ids, x: Float32Array, y: Float32Array, animate?): void
  setCamera(camera) / getCamera()
  onPick(cb) / onHover(cb) / onDragNode(cb) / onLasso(cb)
  highlight(ids, mode: 'focus'|'showcase'|'dim')
  exportImage(kind: 'png'|'svg'): Promise<string>   // data: URL; SVG built from our own model, not the canvas
  destroy()
}
```

### 4.2 Modes

- **Map mode** (sigma) is the default. It supports editing, decorations, labels and presence.
- **Large-graph mode** (cosmos.gl) is chosen automatically above 10,000 visible nodes, or on request. It is read-only apart from selecting, focusing and promoting. Clusters are colour-coded and labels appear only for hovered or selected nodes and the top-N by metric.
- **Matrix mode** (Vega) shows the adjacency matrix ordered by community. It suits dense graphs.
- **List mode**: a virtualised table of elements and connections (reusing `virtual-list.js`). This is the accessible equivalent of the canvas and a spreadsheet-style editor (§9).

### 4.3 Layout

- Layouts:
  - **Force**: d3-force (Barnes-Hut many-body) in a `data:` worker we build ourselves. S5 replaced ForceAtlas2, whose Barnes-Hut mode was far too slow (see Phase 0 results). Without a worker, cancellable time-sliced work handles small graphs, and larger graphs are offered circular or grid layouts. A large force simulation never runs synchronously on the UI thread.
  - **Circular, grid and radial-by-degree**: computed on the main thread.
  - **Hierarchical**: evaluate a bundled JavaScript layered layout in Phase 4; measure size and cycle handling before choosing an implementation.
  - **Clustered**: force layout with community gravity.
  - **Timeline**: x = a date field.
  - **Geographic**: latitude and longitude fields over a bundled outline, ≤ 150 KB of TopoJSON.
- **Determinism:** each layout is seeded by view id plus revision, so collaborators who run the same layout see the same result.
- **Commit:** only the person who presses *Run layout* animates it. When they stop, the positions are committed in chunked ops of ≤ 2,000, and others see them tween in.
- **Pinned elements.** Dragging an element pins it in that view, and pinned elements are skipped by layout. This matches Kumu's "fixed" state.
- Connection routing: straight or curved in the renderer. The whiteboard's orthogonal router (`orthogonal.js`) is **not** reused for the canvas, because it is too expensive per edge at this scale. It is reused only in the SVG export, for maps under 500 connections, where elbows look better.

### 4.4 Lazily loaded modules

- cosmos.gl, Vega, the geographic outline and the import parsers (XLSX) are each built as a separate ESM chunk.
- The server returns a chunk's text from `getModule(name, hash)`. The client imports it with `import('data:text/javascript;base64,…')`, which `script-src data:` allows (spike S4).
- Chunks are cached in memory for the life of the frame.
- The core `client.js` (sigma, graphology, UI) targets ≤ 700 KB, and the build fails if the core plus all chunks exceed the §2 budget.

Each chunk must be self-contained: no bare imports, relative imports, CDN requests or nested `blob:` workers. `getModule` accepts only an allowlisted build manifest name/hash, never caller-authored code. S4 measures RPC transfer, base64 expansion, parsing and peak memory. Lazy loading does not remove these bytes from the archive or Worker upload. If the total fails S6, defer a dependency or separately design platform asset delivery; changing CSP is not an implicit fallback.

---

## 5. Kumu-equivalent features

### 5.1 Editing
- Double-click the canvas to add an element. Drag from an element's edge handle to connect. Press `Enter` to add a connected element, and `Tab` to add a sibling.
- The quick-add bar understands `A -> B`, `A <-> B`, `A -- B` and `A -> B, C, D`, creating elements by label and reusing existing ones through alias matching.
- The profile panel shows the label, type, description (markdown, sanitised), fields, tags, image, connections (grouped by type and direction), provenance and evidence, and a "differs from source" badge.
- Paste a table (TSV or CSV from a spreadsheet) with the same columns as the Kumu import (§6.5), and it becomes an import changeset.
- Bulk edit: select elements, then set a type, field or tag. Merging elements (entity resolution) keeps connections, unions aliases and external refs, and records the merge in history, where it can be undone.
- Loops: select connections that form a cycle (validated), name the loop and mark it R or B. Loops render as a labelled arc marker at their centroid.

### 5.2 Views (Kumu "perspectives")
A view is a named, shareable lens: `rules`, `filter`, `focus`, `cluster`, `layout` and `charts`. The map's default view is used when no other is selected. Deep links require a verified host navigation contract; do not overwrite the host fragment, which may carry sharing capabilities. Until supported, use the in-map view picker and presentation controls.

### 5.3 Decoration rules
Rules are an ordered list stored as JSON, with later rules winning:

```ts
Rule = { select: Selector, set: {
  size?: number | { by: FieldOrMetric, scale: 'linear'|'sqrt'|'log', range: [min,max] },
  color?: string | { by: FieldOrMetric, scheme: SchemeId } | { byCategory: FieldId, palette?: PaletteId },
  shape?: 'circle'|'square'|'diamond'|'triangle'|'hexagon', image?: 'field:<id>',
  label?: 'label'|'field:<id>'|'none', labelSize?, border?: {color, width}, opacity?,
  hidden?: boolean,
  // connections
  width?, style?: 'solid'|'dashed'|'dotted', arrow?: 'auto'|'none', curvature? } }
Selector = 'all' | { elements|connections: Predicate[] } | { tag } | { type } | { ids }
Predicate = { field|metric|type|tag|provenance, op: '='|'!='|'<'|'<='|'>'|'>='|'contains'|'in'|'exists', value? }
```

- A small, total evaluator compiles each selector to a predicate function. No `eval`, no regular expressions from user input, and bounded evaluation. The evaluator is shared with the server, so agent-written rules are validated on the server.
- The UI is a list of rules, each built from pickers ("Color **elements** where **type = Organisation** by **betweenness**"), with a live preview.
- The legend is generated automatically from the rules, and each legend entry can be clicked to filter.
- A Kumu-style text syntax (`element["Type"="Person"] { color: red; }`) can be added later as a parser to this same JSON (open question Q4).

### 5.4 Filter, focus, showcase and cluster
- **Filter:** a selector. Elements it excludes are hidden, and connections are hidden if either end is.
- **Focus:** `{ root: ids, depth: 1..4, direction: 'in'|'out'|'both' }`. It shows the neighbourhood, and the rest fades.
- **Showcase:** matching elements are highlighted and everything else dims (Kumu's showcase).
- **Cluster by field:** elements that share a category value are grouped into a cluster node. This is Kumu's "cluster" mode, where field values become hub nodes. It is computed on the client, not stored.

### 5.5 Metrics
- Metrics:
  - degree (in, out, total)
  - weighted degree
  - betweenness (exact only within a measured work/time budget; seeded sampling otherwise)
  - closeness
  - eigenvector
  - PageRank
  - Louvain community
  - connected component
  - reach (the number of elements within 2 steps)
- They run as cancellable jobs in the `data:` worker. Pressing *Compute metrics* writes byte-bounded vectors through the server to `metrics:<jobId>:<chunk>`. Track a separate graph-data revision so camera or style changes do not invalidate results. A result from an older graph revision is retained as stale, never relabelled as current.
- Metrics can be used anywhere a field can be (in rules, filters and charts) under a `metric:` prefix. People can also turn metrics into real computed fields (`FieldDef.computed`) so they appear in exports.

Every result records full-map versus filtered-subgraph scope, directed/undirected projection, treatment of mutual/parallel/self edges, weight field, algorithm version, seed, sample size and convergence status. Define in/out degree separately; define disconnected closeness explicitly (offer harmonic centrality), and weak versus strong components. Path-distance weights must be positive and separate from signed causal polarity or tie strength. Publish a metric only when its preconditions pass. Matrix mode aggregates or limits cells; it must not allocate a dense 10k × 10k matrix. Sampled live-layer metrics are labelled as sample metrics, not whole-source metrics.

### 5.6 Presentations and narrative
- A presentation is a sequence of steps, each with a view, focus, selection, camera and a markdown caption.
- Presenting fills the frame; it is not true fullscreen, which the host does not grant.
- Steps can be reordered.
- The agent can draft a presentation, for example "walk through the three reinforcing loops", as a proposal.

### 5.7 Timeline
- Kumu-style time slices: an element or connection field of kind `date` or `daterange` drives a slider.
- Elements outside the chosen window are hidden or faded.
- A Vega chart above the slider shows how many elements are active over time.

### 5.8 Charts panel
- Each view carries `charts: ChartSpec[]`.
- A `ChartSpec` is a Vega-Lite spec whose data is one of the named datasets `elements`, `connections` or `metrics`. The client injects that data inline.
- Selecting points in a chart selects the matching elements on the map, and the reverse holds too (brushing).
- Built-in charts: degree distribution, type × community heat map, field histogram and elements over time.
- The agent can write charts from natural language (§7).

### 5.9 Export and sharing
- JSON backup `{format: 'cloudflare-os-network-map', version: 1}`, with its own migration registry as the whiteboard has.
- Kumu JSON.
- CSV of elements and of connections.
- GraphML and GEXF.
- PNG from the canvas.
- SVG built from the model: exact, with labels and orthogonal elbows at ≤ 500 connections.

Downloads use the whiteboard's backup route (a data URL plus copy text), because clipboard access is blocked.

---

## 6. Data sources and connectors

### 6.1 How connectors are detected

Detection follows Tessera's approach (`src/server/sources/`):

- On `listSources()`, the server walks `env`. It never touches `GADGET`.
- Well-known prefixes are checked first: `PROCGEN*`, `RECORDS*`, `SEARCH*`, `WEBSEARCH*` and `GRAPH*`.
- Other keys are probed with a 3 s timeout (`describeDataset`, `describe`, `describeGraph`). A failed probe is retried after 30 s, and definite results are cached for the life of the facet.
- Each adapter declares its kind and capabilities.
- If a source's connector disappears, its source-owned elements stay but are marked "source disconnected". Nothing is deleted.

### 6.2 Adapter contract

This is a superset of Tessera's contract. The graph-specific methods are optional, and the table methods are shared, so the two blueprints can later import one `packages/source-adapters` package.

```ts
interface SourceAdapter {
  kind: 'procgen'|'records'|'search'|'websearch'|'graph'
  probe(stub): Promise<{title, description, capabilities} | null>
  // tabular: any adapter that serves tables
  listTables?(stub): Promise<TableInfo[]>             // with column schema + references
  loadTable?(stub, name, {fields, where, maxRows, sample}): Promise<TableData>
  // native graph: connectors that already know nodes/edges
  describeGraph?(stub): Promise<GraphInfo>
  loadGraph?(stub, {maxNodes, maxEdges, seed, filter}): Promise<GraphData>
  neighbours?(stub, {keys, depth, limit}): Promise<GraphData>   // expand-on-demand for big graphs
  // documents: for agentic extraction
  searchDocs?(stub, query, opts): Promise<DocHit[]>
  openDoc?(stub, ref): Promise<{title, text (≤ 64 KiB), ref}>
  // change feed
  subscribe?(stub, hook): Promise<Unsubscribe>
}
GraphData = { nodes: { key[], label[], type[], columns: TableData['columns'], data }, edges: { from[], to[], type[], directed[], data } }
```

Every call is bounded: rows ≤ 20,000 per call, nodes ≤ 100,000 per live layer, an 8 MB JSON guard, and a remembered refusal after the source reports "Too large:". Connection errors are prefixed `Data source <id> is unavailable:`, so the client never mistakes them for dead stubs.

### 6.3 Source mappings: "auto data loading"

A **source mapping** turns tables into a graph:

```ts
SourceMapping = {
  elements: [{ table, key: col, label: col|template, type: const|col, fields: {fieldId: col},
               where?, maxRows? }],
  connections: [
    { kind: 'foreignKey', fromTable, fromCol, toTable, toCol?, type?, direction },        // orders.customer_id → customers
    { kind: 'edgeTable', table, from: col, to: col, type?: col, fields?, direction },   // an explicit link table
    { kind: 'sharedValue', table, col, via: 'hub'|'clique', maxGroup },                // "same company" → hub or clique
    { kind: 'nested', table, col /* array of keys */ } ],
  onMissing: 'flag'|'remove', identity: 'stableKey'
}
```

**Auto-mapping.** When a source is added, the server builds a *proposed* mapping without calling a model. The person reviews it and presses Load.

- Every table with an id-like key becomes an element type.
- Every `FieldSchema.references` link becomes a foreign-key connection. procgen already exposes these: `orders.customer_id`, `order_items.order_id` and `order_items.product_id`, and `events.customer_id`.
- A table with exactly two reference columns and few other columns becomes an edge table. This is the classic join-table heuristic.
- Low-cardinality string columns (2–50 distinct values, measured with `facetCounts`) become choice fields, and are offered as cluster or colour candidates.
- Tables expected to exceed the editable limits (from `totalRecords`) are offered as live layers, with a *Sample N* option.

The agent can refine the mapping in natural language (§7.2), but the deterministic proposal always comes first. It works with no AI binding at all.

**Sync modes**
- **Snapshot.** Loaded once. A *Refresh* button re-runs the mapping.
- **On open.** Refreshes when the map is opened, if the last sync is older than N minutes. This is one bounded read per table, and each read is an audited observation.
- **Live.** Only for sources with `subscribe` (Records `onChange`). Notifications carry only ids and revisions, so the server coalesces them for 5 s and then refetches the changed records. Delivery is at-least-once and out of order, and applying a change is idempotent by `(sourceId, key, sourceRevision)`.

**Sync report** (stored in `src.lastSync`): elements added, updated and unchanged; tombstone candidates; overlay conflicts; rows skipped, with reasons; whether the read was truncated or sampled; and the observation count.

**Sync correctness contract**

- Identity is `(sourceId, tableOrCollection, stableKey)`; mapping entries have stable IDs, and edge-table mappings require an explicit edge key. Label changes never create new entities. Missing or duplicate keys are validation errors. Label/alias matches only suggest a merge for review.
- Adapter reads return a cursor, completeness flag, source revision/snapshot token where supported, and truncation/sampling metadata. Respect the connector's own page size (Records issue pages are at most 100); the 20,000-row bound is an aggregate ceiling, not a supported page size for every adapter.
- Only a complete, unsampled enumeration of the same mapping/filter scope can produce missing-record candidates. Timeouts, revoked access, failed pages, partial searches and live-layer samples cannot imply deletion. Without stable snapshot support, flag possible absence for review rather than automatically removing it.
- Stage reads outside the mutation queue, then apply with a source-generation fence and current overlay versions. Serialize refreshes per source; coalesce on-open requests from multiple viewers. A mapping edit, disconnect or newer refresh invalidates an older result.
- Expand references with explicit endpoint-table mappings. Missing endpoints are reported, not invented silently. Bound clique expansion by predicted edge count (`n × (n − 1) / 2`) and bytes before materialising it; offer hubs when over budget.
- Records `onChange` requires a persistent callback and Workshop-owner approval, not a transient UI subscription. S8 must prove registration, restart recovery, duplicate/out-of-order delivery and reconciliation after missed notifications. Until then, expose snapshot/on-open only and report live mode as unavailable.

### 6.4 Connector plan

**Phase 1–2: no new connector.** Adapters for the connectors that already exist:

| Connector | Adapter use |
|---|---|
| **Synthetic Data** (`gatekeeper-procgen`) | `table()` with fields and one reference hop, `facetCounts()`, and `references`. The first demo source, and the auto-mapping test bed. |
| **Records** (`gatekeeper-records`) | Projects module: projects, issues and assignees become elements. Issue→project and issue→assignee become connections, and comment co-occurrence becomes collaboration edges. Live mode through `onChange`. Reads only; writes to Records are out of scope. |
| **Search** (`gatekeeper-search`) | `search` and `open` find workspace Docs, Sheets and Slides (which push to search) for agentic extraction, and let an element link to a document as evidence. Whiteboard, Board and Wave don't push to search yet (see §6.6). |
| **Web Search** (`gatekeeper-websearch`) | `search` and `fetchPage` for agentic research, through the Jev-gated checks it already applies. Each fetch is an observation, and "review" outcomes go through the approval queue. |
| **Jev** (`gatekeeper-jev`), optional | `decide()` to score entity-resolution candidates ("are these the same organisation?"), when it is bound. |

**Phase 3: a new `gatekeeper-graph` connector ("Graph Sources").** It is justified by three needs that adapters cannot meet:

1. **URL imports.** Gadget servers have no outbound fetch. The connector fetches published CSV (Google Sheets "publish to web"), JSON, GraphML, GEXF and Kumu JSON from an **admin-maintained allow-list of hosts** in `deployment.jsonc`. Each fetch is an observation, and the response is capped at 16 MB.
2. **Large graphs that shouldn't live in a gadget.** It stores the parsed graph in its own SQLite Durable Object, one per resource, and precomputes metrics and a layout. It then serves `loadGraph` (sampled or top-N by metric), `neighbours(keys, depth)` for expand-on-demand, and `search(label)`. This lets large-graph mode explore a million-edge graph without shipping it whole.
3. **A contract other connectors can adopt.** It publishes `GraphSourceSession` (`describeGraph`, `loadGraph`, `neighbours`, `subscribe`) as a type in `packages/graph-contracts`. procgen and Records can implement `graph()` natively later, and the map's `graph` adapter then works with any of them.

Its shape copies Web Search and Jev:
- Resource `graph://<id>` (pattern `graph://*`), suggested binding name `GRAPH`.
- `autoProvisionsAccount: true`, `revocable: true`.
- Registered in `scripts/deploy.ts` / `deployment.jsonc` (`workers.graph`, `graph.enabled`), and bound to the Workshop as `GATEKEEPER_GRAPH`.
- No secrets in v1: public URLs only. Private Google Sheets would need OAuth and follow `upstream-gatekeepers.md`; that is out of scope here.
- Its own audit table: URL host, bytes, row counts and outcome. No content is logged.

Before implementing Graph Sources, specify per-resource ownership, observer access, storage/CPU quotas, retention, revocation and deletion. Public URLs do not make a cached resource public to every account. Validate HTTPS destinations and every redirect against the allow-list; reject credentials in URLs, private/link-local/loopback destinations and disallowed ports, and enforce time, redirect and decompressed-byte limits. XML imports reject DTD/entity declarations; XLSX imports bound expanded ZIP size and cell count. Large-graph parsing and metrics need resumable jobs with explicit budgets, not an unbounded request. This connector design is independently gated and must not delay the Workshop-agent proposal route.

**Phase 4+: datastore-backed maps.** When `docs/plans/external_datastores/immutable-datastores.md` lands, "declared collections" (§4 of that plan) can hold `element` and `connection` collection types. A map could then be *backed by* a datastore: the source of truth moves to the shard, the gadget becomes a view plus overlay, and the lake gets `gold` graph tables for analytics. This plan keeps that option open through the repository seam and `ExternalRef`, and does not depend on it.

### 6.5 File and paste imports (no connector)
- **Kumu spreadsheet layout:** an *Elements* sheet with `Label`, `Type`, `Description`, `Tags` and custom columns, and a *Connections* sheet with `From`, `To`, `Type`, `Direction` and custom columns. Pasted as TSV/CSV, or uploaded as `.xlsx` through the lazily loaded parser chunk.
- **Kumu JSON:** a versioned, tested subset of elements, connections, loops and views. Decorations our rules cannot represent are reported as skipped. Distinguish full project JSON from remote blueprint JSON: Kumu documents different support for those formats. Presentations are not included in Kumu project JSON exports. See [Kumu JSON import](https://docs.kumu.io/guides/import/blueprints) and [export](https://docs.kumu.io/guides/export).
- **GraphML and GEXF** (XML parsed with `DOMParser`) and **CSV edge lists**.
- Every import becomes a **changeset** (§7.3) and never writes directly, so the same review UI, entity resolution and undo apply.

Preview encoding, delimiter, headers, inferred types, duplicate labels, unresolved endpoints and unsupported fields before acceptance. Keep native JSON as the lossless backup; publish a compatibility matrix for each foreign format rather than promising universal round-trips. Reject active SVG/HTML, unsafe URL schemes and over-budget images; escape CSV formula prefixes in spreadsheet-safe exports. Server validation remains authoritative after client-side XML/XLSX parsing. Test export delivery inside the actual sandbox; a download attribute or clipboard call alone is not an acceptance test.

### 6.6 The map as a source for others
- Search publication is opt-in and requires a verified indexing capability, resource identity and audience matching the map. A search/read binding does not imply `put` authority. Confirm the existing Docs/Sheets/Slides ingestion path before adopting it; define stable document IDs, update/delete reconciliation and revocation behavior. Do not publish private source excerpts by default. Phase 4 remains gated on this contract.
- It provides documented agent RPCs (§7.1) so the Workshop chat agent can read the map and write to it from `executeCode`, for example to build a map from a whiteboard's `getBoard()` in the same workspace.

---

## 7. Agentic data creation

### 7.1 Two routes, both supported

1. **The Workshop chat agent (no binding).** The README documents agent-friendly RPCs in the whiteboard's style:
   - They accept stable IDs, with names as a convenience only when uniquely resolved.
   - They read versions inside the serial mutation queue; stale proposal targets still return conflicts.
   - They return `{created, updated, errors}`.

   The RPCs:
   - `findElements`, `getNeighbourhood`, `describeMap`, `getMapMarkdown`
   - `proposeElements`, `proposeConnections`, `proposeFields`, `proposeView`, `proposeChart`, `proposePresentation`
   - `addSource`, `runSync`

   Agent content writes always create proposals. A changeset ID or `acceptedBy` string is not proof of human approval. S10 must establish a trusted UI acceptance capability that an `executeCode` caller cannot mint or bypass through generic mutation RPCs. Acceptance binds the exact proposal digest and expected target versions, and applies it in the same server-controlled workflow. If the platform exposes identical write authority to UI and agent, explicitly document that review is a cooperative convention and do not claim enforced human approval; resolving this is a gate for Phase 3. Agent requests to add sources or start sync also respect configured read budgets and any connector approval.
2. **The in-gadget agent (optional `aiModel`).** It works as Wave's does: `askAgent({task, scope, instructions})`, `getRun` and `cancelRun`, with a queue, a dispatcher and generation-fenced commits (`src/core/runs.js`). Because the blueprint declares no bindings, the model is attached after creation. If spike S7 shows an `aiModel` can't be attached that way, the in-gadget agent is dropped from v1 and route 1 carries agentic creation. We would not declare a mandatory `Model`, because that would break one-click New.

LLM access always goes through the platform's `aiModel` binding and AI Gateway configuration. The blueprint holds no provider keys.

### 7.2 Tasks

| Task | Inputs | Output (always a changeset or proposal) |
|---|---|---|
| **Map this document** | a Search doc ref (`openDoc`), pasted text, or a web page (`fetchPage`) | elements, connections and field values, each with a quote as evidence |
| **Expand element** | an element, plus Search and/or Web Search | new neighbours and connections with evidence; the search queries used are shown |
| **Find missing links** | the current map and its sources | proposed connections between existing elements, each with evidence |
| **Resolve duplicates** | the map, optionally `JEV.decide` | merge proposals with a score and rationale |
| **Suggest mapping** | a source's tables and the deterministic proposal | edits to the mapping (not data); the person presses Load |
| **Describe / summarise** | a selection or cluster | description text proposals |
| **Build a view / chart / presentation** | a natural-language request | rule JSON, a Vega-Lite spec or presentation steps, validated on the server by the same evaluator and schema |
| **Explain a loop or pathway** | selected connections | a caption proposal for a presentation step |

### 7.3 Changesets and review
- **Staging layer.** Proposed items render on the map as ghost elements (dashed outline) and dashed connections, and in a *Proposals* panel grouped by run.
- Each item shows its evidence: the quote, a link to open the source in the profile panel, and the source title. It also shows how it was **matched** (new, or merged into an existing element by alias, key or a Jev score) and a model-reported confidence. The confidence is a hint only and never used as a gate.
- Actions:
  - Accept, reject or edit, per item.
  - Accept or reject everything that matches a filter.
  - Accept the whole run.
- Acceptance uses the validated operation core, with byte-bounded chunks of at most 2,000 items. Preserve the origin (`agent`, `import` or `sync`) rather than labelling every accepted item as agent-created. Store accepted versions, digest, evidence and attribution. A logical history group may contain several commits; it is not automatically an atomic transaction or fully undoable (§8.1).
- Stale checks work like Wave's `baseSeq`. If an element a proposal targets has changed since the run started, the item shows as `stale` and has to be re-reviewed.

Each item has a stable ID, expected target version and dependencies. Accepting an edge requires its endpoints to exist or be accepted in the same dependency-closed batch; rejecting a node blocks dependent edges. States are `pending`, `stale`, `rejected`, `applying`, `applied` and `failed`, with durable chunk checkpoints. Retries return prior outcomes instead of duplicating objects. Editing an item changes its digest and invalidates prior acceptance. Evidence proves what a source says, not that the claim or inferred relationship is true.

### 7.4 Extraction pipeline
1. **Gather.** Read the sources within the budget (§7.5). Long documents are split into chunks of about 6 KiB with overlap, and each chunk is tagged `[d<n>:c<m>]`.
2. **Schema-guided extraction.** The prompt carries the map's schema (element types, connection types and fields), a sample of existing labels and aliases for matching, and the content, fenced with data markers as Wave does. The model returns strict JSON: `{elements:[{label,type,aliases,fields,evidence:[chunkTag, quote]}], connections:[{from,to,type,direction,evidence}]}`.
3. **Validate.** Parsing is lenient, then:
   - Items without valid evidence are dropped, as Wave drops claims that don't cite `[b_…]`.
   - Each quote must appear verbatim in the cited chunk, after whitespace normalisation.
   - Types that aren't in the schema become a separate **schema proposal**, never an implicit type.
4. **Resolve.** Match against existing elements by external ref, then normalised label or alias, then Jev (if bound) for the ambiguous remainder. Within a run, identical proposals are merged.
5. **Map-reduce** for multi-chunk documents: extract per chunk, then run a merge pass without a model (resolution in step 4), then an optional model pass to add connections across chunks.

### 7.5 Budgets, safety and attribution
- Budgets, in the app as Wave has them: 1 active run, 3 queued, 30 runs per hour per map, ≤ 24 KiB in and ≤ 16 KiB out per model call, ≤ 12 calls per run, a 90 s timeout per call, and ≤ 10 web fetches per run. The last 50 runs are kept.
- A run that was running when the facet restarted comes back as `unknown` and is not restarted automatically.
- All source content is untrusted. It is fenced as data, and the model is never given tool access from inside the gadget: the server decides which reads happen.
- Rendered text is escaped and markdown is sanitised. Images are accepted only as `data:` URLs from uploads.
- Attribution: `by` is the viewer from `gadgetViewer`, which the server treats as an unverified label until whiteboard Phase 4 identity lands. Agent items are shown as "Proposed by Assistant · accepted by <name>".
- Observation volume: each search, open or fetch is an audited observation. A run's report lists them, and the proposals panel shows "this run read 7 documents and 3 web pages".

---

## 8. Collaboration

Copy the whiteboard's architecture into the new package:
- `core/network-map.js` holds the rules and a serial mutation queue. `core/hub.js`, `server/do-repository.js` and `shared/protocol.js` follow the whiteboard's.
- `applyOperation({senderId, by, requestId, objectOps, structure})` supports create, update and delete for `el`, `cn`, `loop`, `view`, `pres` and `src`, with `baseVersion` conflicts returning the current value.
- Position ops `{op:'moveMany', viewId, ids, x, y}` are last-writer-wins per element and per view, and don't bump element versions. They are coalesced by the client at about 10 Hz while dragging.
- Client rebase by field:
  - Positions: my delta is re-applied.
  - Fields: per field. The other side's change wins where both edited the same field; otherwise both apply.
  - Label and description: the other side's change wins, and the element flashes.
- Presence: the cursor in graph coordinates, the selection, the view being looked at, focus, and the element being edited, plus "following <name>" (the camera follows a presenter). The whiteboard's caps and 4 s heartbeat apply.
- Undo on the server, grouped by actor/session for convenience, including logical groups for accepted changesets and imports. Attribution is not authorization. Large inverses require reserved, chunked storage; follow the conflict-aware compensation rules below rather than deleting by provenance.
- Initial load uses a revision-consistent snapshot token and byte-bounded pages (S2 fixes the size). Register for deltas before capturing revision R; buffer later deltas during paging, discard events ≤ R and replay in order. An expired token, revision gap or bounded-buffer overflow restarts the snapshot. Do not mix pages from different revisions or extrapolate transfer size from object count alone.
- Revisions and migration: `migrate(meta)` is idempotent and runs on every load. Existing maps keep the code they were created from; upgrading them is covered by whiteboard open decision 0.3 and is not solved here.

### 8.1 Commit, undo and recovery contract

- Commit each bounded operation with object writes, map revision, deduplication result and history metadata in one repository transaction. Broadcast only after success. Limits apply to request bytes, fan-out deltas and inverse bytes as well as object count.
- Multi-chunk imports/acceptances are explicitly resumable jobs: show completed/total chunks, reserve quota, persist progress and report partial application after failure. Each chunk preserves graph referential integrity. Do not claim all-or-nothing semantics for the whole job without a separately tested staging-and-publish design.
- Replace the proposed provenance-only bulk delete with conflict-aware compensation. Undo only fields/objects still at the versions written by the job; preserve subsequent manual edits, new incident edges and other sources' contributions, and report conflicts. Store chunked inverses within the reserved quota or warn before acceptance that an operation is not undoable. A backup/export is offered before large destructive edits.
- Position commits include expected per-view position versions. A layout job skips nodes dragged, pinned or deleted since it started; its last chunk cannot overwrite intervening manual placement. Transient drag animation belongs in presence; durable positions are coalesced and sent on gesture completion.
- Conflict UI retains the user's unapplied field value and offers retry/compare; flashing an element while discarding text is insufficient. Duplicate request IDs with different payload digests are rejected. Expired deduplication windows require reconciliation, not a blind retry.
- Migrations refuse newer unsupported schemas and checkpoint large upgrades. Export/restore and restart tests must cover an existing map before a format revision can claim upgrade support.

---

## 9. UX layout and accessibility

```
┌ toolbar: map title · view ▾ · mode (Map | Large | Matrix | List) · Layout ▾ · Metrics · Present · Share/Export ┐
│┌ left rail ────────┐┌──────────────── canvas (sigma / cosmos / vega matrix / list) ──────────┐┌ right panel ──────┐│
││ Views              ││                                                                        ││ Profile           ││
││ Legend (clickable) ││                                                                        ││ | Design (rules)  ││
││ Filter / Focus     ││                         + ghost proposals                              ││ | Data (sources)  ││
││ Timeline slider    ││                                                                        ││ | Proposals       ││
│└────────────────────┘└──────────────── quick-add bar  A -> B ─────────────────────────────────┘│ | Charts | Activity│
└──────────────────────────────────────────────────────────────────────────────────────────────────┴──────────────────┘
```

- The *Data* tab lists sources, the proposed mapping, sync mode, the last sync report and a Refresh button. When nothing is bound, it says "Add a connector in this gadget's **Connections** tab: Synthetic Data, Records, Search, Web Search", as Tessera's Data popover does.
- Accessibility:
  - List mode is a full alternative to the canvas: a virtualised grid of elements with a connections sub-list, and full keyboard editing.
  - On the canvas, arrow keys move to the nearest element in that direction, and `[` and `]` step through neighbours. An `aria-live` region announces the focused element with its type and degree.
  - Reduced motion turns off layout tweening.
  - Colour scales come from the `dataviz` palette guidance, and every colour encoding also has a shape or label alternative in the legend.
- Remember sandbox rules: no `<form>`, no `navigator.clipboard`, and native Ctrl+Z moves focus. Handle undo shortcuts on the canvas.

---

## 10. Package layout

```
packages/blueprint-network-map/
  package.json          build:gadget, pack:gadget, test:run, test:workers, test:e2e, harness, bench
  scripts/              build.mjs (core + chunks, budgets), pack-gadget.mjs (SIDECAR_KEYS, lock), archive.mjs
  gadget.lock.json
  src/README.md         agent-facing guide: RPCs, data model, rule JSON, mapping JSON, limits
  src/shared/           protocol.js (limits, storedBytes), selectors.js (evaluator), rules.js, mapping.js,
                        validate.js, kumu.js (import/export), graphml.js, ids.js
  src/core/             network-map.js, hub.js, history.js, sync.js (source sync + overlay), changesets.js,
                        runs.js (agent), resolve.js (entity resolution), automap.js
  src/server/           index.js (thin wrapper), core-wiring.js, do-repository.js, sources/{procgen,records,
                        search,websearch,graph}.js, agent/{prompts,extract}.js, modules.js (lazy chunks)
  src/client/           app.js, sync/{store,connection,presence}.js (from whiteboard), render/{sigma,cosmos,
                        matrix,list,svg-export}.js, layout/{worker.js, fa2, hierarchy, radial, geo}.js,
                        metrics/worker.js, ui/{toolbar,rail,profile,design,data,proposals,charts,present,
                        quickadd,legend,timeline}.js
  harness/              multi-pane fake server (latency/restart/stale-stub), fake procgen/records/search/model
  e2e/                  harness.test.mjs, platform.test.mjs
  bench/                10k/30k render + layout + metrics + snapshot benchmarks (Playwright, headless GPU flags)
  test/                 unit + workers-pool tests
formats/network-map.json + network-map.gadget
packages/graph-contracts/        (Phase 3) GraphSourceSession types
packages/gatekeeper-graph/       (Phase 3) Graph Sources connector
```

Sidecar keys are limited to `blueprintId`, `title`, `description`, `output`, `author`, `revision` and `$comment`. `bindings: {}` goes in the archive metadata.

---

## 11. Phases

### Phase 0: feasibility gates

Do not commit to a 2–3 day estimate before fixtures and the platform harness exist. Gate Phase 1 on S1–S3, S5 and S6 for its actual dependencies; S4, S7, S8 and S10 gate their later features. Each result records commits, dependency versions, browser/device, fixture, command, measurements and a pass/fail decision with fallback.

| # | Spike | Pass criterion |
|---|---|---|
| S1 | Facet storage at scale: `ctx.storage` KV vs `ctx.storage.sql` in a facet | 10k elements, 30k connections and position chunks write, and load in < 1.5 s; the total fits; `storedBytes` is honest |
| S2 | Snapshot transfer over capnweb | Maximum safe message size; chunk size so that 10k/30k arrive in < 1.5 s p95 locally |
| S3 | sigma v3, graphology and cosmos.gl under the gadget CSP in the harness and on the local platform | Renders; no `eval` or `blob:` CSP violations; 60 fps pan at 10k/30k (sigma) and 100k (cosmos) |
| S4 | `import('data:…')` lazy chunk of about 900 KB (Vega) from a server RPC | Works in Chrome and Firefox; the time to first chart is measured |
| S5 | ForceAtlas2 and metrics in a `data:` worker | Cancellable layout works without blocking input; measure exact/sampled betweenness separately and choose a work budget. A < 10 s target is not a promise of exact 10k/30k computation; bounded fallback works. |
| S6 | Workshop Worker size with the new archive (plus Graph Sources later) | Stays under the Worker limit with margin; the combined format budget is recorded |
| S7 | Attaching an `aiModel` binding after creation (Connections tab or `setGadgetBinding`) with no declared bindings | Decides whether route 2 ships in v1 |
| S8 | Records `onChange` hook delivery to a gadget on the real Workshop (untested so far per the datastore briefing) | Decides whether live mode ships in Phase 2 |
| S9 | `navigator.gpu` in the opaque sandboxed frame | Recorded only; no v1 dependency |
| S10 | Human acceptance and agent mutation authority | Prove a proposal-only agent cannot forge acceptance or invoke a bypass mutation. If unsupported, record the platform work required and the narrower cooperative guarantee; do not ship an enforced-review claim. |

#### Phase 0 results (2026-09-24)

**Environment.** All runs used the starter at 5f8c12c on branch `feat/network-map`:
- Node 24.19.0 on WSL2 (Linux 6.6)
- Playwright 1.61.0 headless Chromium, with WebGL through SwiftShader (software rendering)
- workerd through `@cloudflare/vitest-pool-workers` (compat date 2026-02-01, SQLite-backed Durable Object)
- sigma 3.0.3, graphology 0.26.0, @sigma/edge-curve 3.1.0, @sigma/node-square, node-border and node-image 3.0.0, d3-force 3.0.0

**Fixture.** The same fixture was used throughout:
- 10,000 elements with ~40-character labels and tags.
- 30,000 connections: two thirds directed, a fifth labelled.
- Endpoints skewed towards hubs (`b = floor(rand² × N)`), so there are parallel edges and self-links.

| # | Result | Decision |
|---|---|---|
| S1 | **Pass (local workerd).** At exactly 10,000 elements and 30,000 connections (demo included), with 10,000 positions:<br>• Writes in 2,000-op requests: elements 195 ms, connections 507 ms, 0.8 s in total.<br>• Cold load of a new map over the same storage: 188 ms.<br>• SQLite database: 10.8 MB.<br>• `ctx.storage.sql` is available in a SQLite-backed Durable Object; whether a *facet* has it is not proven, so the KV API stays.<br>• Core heap with the map loaded plus one snapshot token: 29 MB (Node, same V8; `spikes/s1-memory.mjs`).<br>Command: `vitest run --config vitest.workers.config.ts -t spike`. | Keep KV keys behind the repository seam. The limits stand. **Recheck on the local platform** (a facet shares an isolate with other facets), then in production. |
| S2 | **Pass (local).** The 10k/30k map moved in 10 byte-bounded pages of ≤ 1 MiB (7.6 MB of JSON) in 118 ms over Workers RPC from one revision. The whiteboard already sends 3 MiB snapshots in production. | Pages of 1 MiB (`LIMITS.snapshotPageBytes`). Paging during writes returns one revision (tested). |
| S3 | **Pass for CSP; fps not certified.** sigma and graphology render inside the exact gadget CSP (`GadgetUI.tsx:112`) in a sandboxed srcdoc frame, with no `eval`, `blob:` or other CSP violations:<br>• 10k/30k: builds in 167 ms, mounts in 556 ms; picking works.<br>• Under SwiftShader, panning is p50 103 ms per frame. This is software rendering, so it says nothing about GPU fps.<br>• @sigma/node-image builds two default programs at import, and each probes WebGL. `scripts/build.mjs` annotates those calls as pure so that a frame without WebGL can still fall back to the list.<br>• cosmos.gl is not part of Phase 1 and was not tried.<br>Command: `node spikes/run-s3.mjs 10000 30000`. | Adopt sigma. **60 fps at 10k/30k is still to be measured on a real GPU laptop** (the performance protocol below). |
| S5 | **Pass, with a change of engine.**<br>• graphology's ForceAtlas2 Barnes-Hut measured 176 ms per iteration at 1k/3k and 16 s at 10k/30k in Node; exact mode was 11 ms at 1k.<br>• Its worker helper uses `blob:`, which the CSP blocks.<br>• **d3-force** (Barnes-Hut quadtree) measured 6.6 ms per warm tick at 1k/3k and 105 ms at 10k/30k in Node.<br>• In a `data:` module worker inside the CSP frame it ran 8 ms per tick at 1k and 102 ms at 10k/30k.<br>Commands: `node spikes/fa2-node.mjs …`, `node spikes/d3-node.mjs …`, `node spikes/run-s3.mjs`. | Force layout = d3-force in a `data:` worker (`src/client/layout/`), streaming positions, cancellable, and committed with position-version fences. Without a worker it falls back to time-sliced layout on the main thread only up to 3,000 nodes; above that, Circle or Grid. Metrics (Phase 4) will use the same worker route. |
| S6 | **Partly measured.**<br>• Built `client.js`: see the delivery record.<br>• The packed archive is checked against 600 KiB by `pack-gadget.mjs`.<br>• The Workshop's compressed upload with all formats still has to be read from `pnpm check` (Wrangler dry-run) before the first release. | Blocking only for release, not for the build. |
| S9 | **Recorded.** In the harness the sandboxed srcdoc frame reports `isSecureContext: false` and has no `navigator.gpu`. The harness parent is `about:blank`, not https, so production may differ. | No v1 dependency. |
| S4, S7, S8, S10 | Not run: they gate Phases 2–4. | |

### Phase 1: an editable map (MVP)
- Data model, storage, ops, presence, undo and history, and the connection state machine and recovery screen, all copied from the whiteboard.
- sigma renderer; list mode; profile panel; quick-add syntax; types and fields.
- Views with rules, filter, focus and showcase; the automatic legend; force (d3-force, per S5), circular and grid layouts with per-view positions and pinning.
- Paste and import of the Kumu spreadsheet layout and CSV as changesets, with a review UI (no agent yet).
- Export: JSON backup, CSV, Kumu JSON and PNG.
- The demo map on New, for example a small system map with loops and a stakeholder map, with no bindings.
- **Exit:** harness e2e (multi-pane, restart, stale stub), platform e2e green, 10k/30k benchmarks meet the targets, archive within budget.

### Phase 2: auto data loading
- Connector detection, and adapters for procgen and Records (read), plus Search for evidence links.
- The deterministic auto-mapper, source mappings, the overlay and source layers, the sync report, and handling of tombstones.
- Sync modes: snapshot and on-open; live for Records if S8 passes.
- Live layers and large-graph mode (cosmos.gl, lazy); promoting a subset.
- **Exit:** the procgen small profile maps customers, orders and products automatically with one click after review, and a re-sync after manual edits keeps the edits.

### Phase 3: agentic creation; independent Graph Sources track
- Documented agent RPCs for the Workshop chat agent (route 1) with changesets.
- The in-gadget agent (route 2) if S7 passes: the §7.2 tasks, the extraction pipeline, validation, budgets and run history.
- Web Search and Jev adapters; entity resolution.
- Separate Phase 3b, after its capability review: `packages/graph-contracts` and `packages/gatekeeper-graph`, with URL imports, large-graph storage, `neighbours` expansion and deployment wiring. Phase 3a agent proposals can ship using existing connectors.
- **Exit:**
  - "Map this document" on a workspace Doc produces reviewed elements with verbatim-quote evidence.
  - Malicious source instructions and a direct agent RPC caller cannot apply an unapproved proposal under the S10 guarantee.
  - Phase 3b separately passes ownership/isolation, redirect/SSRF, resource-budget, interrupted-job and allow-list refusal tests.

### Phase 4: analytics and narrative
- Metrics worker and computed fields; the Charts panel (Vega, lazy) with brushing; matrix mode; timeline; loops UI; presentations; hierarchical, radial and geographic layouts; SVG, GraphML and GEXF export.
- Map elements pushed to Search.
- Agent-authored views, charts and presentations.

### Phase 5: datastore-backed maps (depends on the immutable datastores plan)
- Declared `element` and `connection` collections; the map as view plus overlay over a shard; lake graph tables.

Every phase ships as a new revision through the usual route:
1. `pack:gadget`, then `pnpm check`.
2. Follow the operator skill (`.agents/skills/cloudflare-os-operator/SKILL.md`) and get Harry's approval of the mutation summary.
3. Release with `pnpm release` from a clean worktree of committed main.
4. Harry runs the signed-in production checks, since Access blocks automated sign-in.

The connector ships before, or together with, the map revision that uses it.

---

## 12. Testing

- **Unit (vitest):**
  - selector evaluator (totality and bounds, fuzzed)
  - rule application
  - mapping and auto-mapper against procgen schemas
  - overlay/source merge
  - changeset apply and undo
  - entity resolution
  - Kumu, GraphML and GEXF round-trips
  - `storedBytes` caps
  - migration registry
  - extraction validator: verbatim quotes, unknown types, injection fixtures
- **Workers pool:** the repository on real DO storage, chunked positions, limits and snapshot paging.
- **Harness e2e (Playwright):**
  - two and three panes: concurrent edits, conflict rebase, presence and follow
  - facet restart, stale stub and the recovery screen
  - lazy chunk load
  - fake connectors (procgen, records, search) and a fake model with a scripted output
- **Platform e2e:** start-local-platform. Covers New without setup, adding Synthetic Data from Connections, auto-mapping, and an agent proposal through the chat agent.
- **Benchmarks** (recorded in this plan, as whiteboard-improvements records its own): render fps, layout time, metrics time, snapshot load p50/p95 at 1k/10k/30k, and cosmos at 100k.
- **Runtime checklist**, backed by source references and harness tests: prefix globals, no forms, stale stubs, stub disposal, measured RPC throughput, no `connect` method, serialized-size guards and sidecar keys.

**Release-blocking correctness fixtures:**

- A sampled or interrupted refresh never marks absent rows for deletion; a label rename preserves identity; source precedence does not depend on arrival order.
- A proposal accepting an edge without endpoints fails cleanly; duplicate chunk retries create no duplicates; restart halfway through acceptance resumes from its checkpoint.
- Concurrent edit during layout, merge, sync or undo preserves the newer edit or returns an actionable conflict. Paging a snapshot during writes yields one revision plus ordered deltas.
- Every stored value, RPC payload and export stays within its byte budget at maximum-length labels, evidence and IDs, not just tiny synthetic rows.
- Forged acceptance, changed proposal digests, unsafe Markdown/SVG/URLs, CSV formulas, XML entities and compressed-file expansion have explicit rejection or safe-output tests.
- WebGL unavailable/context lost, worker creation failure and reduced motion leave list mode usable with keyboard focus and save/recovery state intact.

**Performance protocol:** report warm/cold load separately, p50/p95 frame and input latency, snapshot transfer/parse time, peak browser/facet memory and compressed Workshop upload. Record physical hardware, browser, viewport, DPR, label density and graph distribution (including hubs and parallel edges). Software-rendered headless CI validates behavior but cannot certify laptop GPU fps. Test 1k nodes, 10k/30k editable and 100k-node live-layer fixtures separately; include bounded edge counts and at least one nontrivial attribute/evidence fixture. Record cancellation latency and total load-to-interaction time, not render fps alone.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Workshop Worker size grows with every format | S6 and a CI check of compressed total upload; defer cosmos/Vega or redesign asset delivery if needed. Lazy chunks only reduce initial browser work. |
| Facet storage too slow or small for 10k/30k | S1; SQLite if available; otherwise lower the editable limits and rely on live layers or Graph Sources for scale. |
| Agent proposals cause review fatigue | Bulk accept by filter, grouping by run, deterministic de-duplication, and the ability to accept "all with ≥ 2 evidence quotes". |
| Prompt injection through documents or web pages | Data markers, no tools in the model, verbatim-quote validation, proposals only, and Web Search's own gate layers. |
| Records live mode is untested on the Workshop | S8; fall back to on-open refresh. |
| Layout determinism across browsers (floating point) | Positions are committed by the person who ran the layout, not recomputed per client. |
| The optional-binding workaround breaks if the platform adds true optional bindings | Welcome; switch the declaration then, keeping runtime detection. |

---

## 14. Open questions for Harry

1. **Q1 Name.** "Network Map", "Systems Map", or a brand in the style of Tessera (for example "Constellation" or "Filament")? This changes the display name only; keep `format.network-map` stable.
2. **Q2 Agent route.** Is route 1 (the Workshop chat agent plus changesets) enough for v1 if S7 shows an `aiModel` can't be attached after creation? Or is a setup step with a declared `Model` acceptable, as Wave has?
3. **Q3 Graph Sources host allow-list.** Which hosts at launch (docs.google.com published CSV, raw.githubusercontent.com, others)? Should private Google Sheets over OAuth come later?
4. **Q4 Kumu syntax.** Is Kumu's CSS-like decoration language worth supporting as text on top of the rule JSON, for users coming from Kumu?
5. **Q5 Records scope.** Is read-only mapping of Records enough, or should the map be able to *propose* Records writes (for example "create an issue for this gap") through the approval queue?
6. **Q6 Tessera sharing.** Extract the adapters into a shared `packages/source-adapters` now (touching Tessera's pinned library route), or copy them first and converge later?

---

## Phase 1 delivery record (2026-09-24)

**Where.** Everything is in the worktree `/var/web/cloudflare-os-starter-netmap`, branch `feat/network-map` from main 5f8c12c:
- the package `packages/blueprint-network-map`
- `formats/network-map.json` and `formats/network-map.gadget`: revision 1, 205 KB, no bindings
- `docs/plans/network-map-blueprint.md`
- `.gitignore` (`packages/*/dist-*/`)

Nothing is committed, pushed or deployed.

**What shipped (Phase 1 scope):**
- **Server.** Rules and repository seam (`src/core/`), with changesets for reviewed imports. The Durable Object server has an `ExportHandler` offering backup, Kumu JSON, element and connection CSV, GraphML and GEXF.
- **Client:**
  - sync store: an optimistic queue, requests replayed with their requestId, rebase by field, gap resync and recovery
  - sigma renderer with five shapes, arrows and parallel-edge curves; list mode is the accessible alternative and the fallback when WebGL is unavailable
  - layouts: d3-force in a `data:` worker, circle and grid, all fenced by position versions
  - editing: quick-add syntax; the Profile, Design, Data and Activity panels; loops; merge; bulk edit; presence and follow; the demo map with Start blank
- **Agents.** `src/README.md` documents the RPCs for the Workshop agent.

**Decisions made while building:**
- d3-force replaced ForceAtlas2 (S5).
- Any caller can accept a changeset: the digest binds what was reviewed, not who accepted. This is documented as cooperative review (§7.1, S10).
- Loops are checked once per request, and a request that would break one is refused as a whole. Undo uses the same check.
- Deleting a field removes its values within the same commit, and undo brings them back.
- An import row whose target changed after review fails as stale instead of overwriting the newer edit.
- The platform offers no network icon, so the sidecar uses `gridNine`.

**Verification (final run, 2026-09-24):**
- **Unit (vitest):** 168/168 across core, changesets, review regressions, imports/exports and panel logic.
- **Server (workerd pool):** 8/8, including spike S1/S2 at 10k/30k.
- **Harness e2e under the exact gadget CSP:** 29/29. That is sync 9, Profile 8, Design 7 and Data 5. They cover two panes, conflict rebase, a facet restart with and without unsaved changes, the list when WebGL is missing, imports, undo, merge and 10,000-row list windowing.
- **Local platform (real Workshop, facets in workerd):** 8/8 on three consecutive runs of 46–55 s. They cover upload and one-click create; the demo; the account name from `gadgetViewer`; persistence; a second user through a share link; import through the Data tab; the six exports; code-edit recovery for a shared viewer; and a platform-log scan. P6 (no "RPC stub was not disposed" line) failed once in 5 runs, right after a code-edit facet abort, as the whiteboard also saw.
- **Platform-only bug, found and fixed:** the Workshop's "Gadget restarted due to code update." error was not treated as a transport failure, so a shared viewer never reloaded. The harness now throws the same message.
- **Independent correctness review:** 11 verified defects, all fixed, with `test/core/review-regressions.test.js`:
  - undo inverse ordering
  - broken loops left by undo
  - dangling field values
  - undo idempotency
  - oversized inverse chunks
  - refused, stale and double-matched import rows
  - two client races (a duplicate replay advancing the revision; an older conflict value overwriting a newer one)
  - quadratic import resolution

**Benchmarks** (`e2e/bench.mjs`, headless Chromium with software WebGL; pan times are not GPU numbers):

| Map | Cold load to model | Edit to model | Rebuild stages (model / sync / rail) | JS heap |
|---|---|---|---|---|
| 1k elements, 3k connections | 383 ms | 55 ms | 16 / 11 / 1 ms | 17 MB |
| 10k elements, 30k connections | 728 ms | 95 ms | 66 / 27 / 0.3 ms | 73 MB |

On the platform (P7), 2,000 elements and 4,000 connections filled in about 2 s; a reload took 0.6–0.8 s to model; the snapshot was 2 pages (1.09 MB).

**Sizes.** `client.js` is 528 KB (budget 700 KiB core) with the layout worker inlined (14 KB); `server.js` is about 160 KB; the archive is 205 KB (budget 600 KiB).

**Still open before a release:**
- S6: read the Workshop's compressed upload from a `pnpm check` dry-run, with all formats.
- 60 fps at 10k/30k on a real GPU laptop (`node e2e/bench.mjs --headed`).
- Signed-in production checks after deploy. The release goes through the operator skill and Harry's approval of the mutation summary, then `pnpm release` from a clean worktree of committed main.
- Known gaps:
  - self-links are not drawn on the canvas (the list and profile show them)
  - dashed connection styles are not offered
  - the default undo target is chosen by display name
  - the fill and border colours in "colour by number" rules are typed as hex

