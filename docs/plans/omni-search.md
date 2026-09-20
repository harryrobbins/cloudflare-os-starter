# Plan: omni-search, a deployment-wide hybrid index

Written 2026-09-20 against the pinned submodule (fork branch `starter-openrouter`, gitlink 90f0591 plus
the `gadgetViewer` commit) and branch `chat`. Status: **planning, not started**. Depends on
[chat.md](chat.md) landing.

Goal: one place to ask "where are the docs about project X?" and get an answer ranked by meaning as
well as by words — across team chat first, then the Context Library, connected services, and finally
the deployment's own gadgets and bundled formats. The same index answers the agent, so "find the docs
about project X" ends with the agent reading them and using them in the workspace.

Product facts, limits, prices and dead ends are in
[hybrid-search-on-cloudflare.md](../research/hybrid-search-on-cloudflare.md); this plan cites it rather
than repeating figures. Platform constraints come from
[gadget-connectors-and-services.md](../research/gadget-connectors-and-services.md),
[gadget-viewer-identity.md](../research/gadget-viewer-identity.md) and
[collaborative-blueprints.md](collaborative-blueprints.md#what-the-platform-does-not-give-us).

## Decisions

1. **One Worker, `cfos-search`, in `packages/gatekeeper-search`.** Same three-faced shape as chat: an
   Access-protected HTTP surface at `/gatekeeper/search/*`, a `GatekeeperVendor` with an
   auto-provisioned ambient singleton for the agent, and a SQLite Durable Object holding the index.
   A Gatekeeper is the platform's only service primitive — gadgets cannot bind each other
   (`cloudflare-os/packages/workshop-backend/src/overseer.ts:1832`). Wiring mirrors chat's
   (`scripts/deploy.ts:606-619`): `GATEKEEPER_SEARCH` on the router for the path, on the Workshop with
   `entrypoint: "GatekeeperVendor"` for the agent, and on chat for `ingest`; plus `ai`, `vectorize` and
   `queues.producers` stanzas on the Worker itself.
2. **Hand-rolled hybrid, not AI Search.** Dense recall from Vectorize over Workers AI
   `@cf/baai/bge-base-en-v1.5` (768 dims, `pooling: "cls"`, cosine); lexical recall and *all* facets and
   snippets from FTS5 in the search DO; fused with reciprocal rank fusion; optional rerank with
   `@cf/baai/bge-reranker-base`. AI Search is now genuinely hybrid and free in beta and is the named
   fallback for the dense half, but it caps custom metadata at **5 fields per instance** where we need
   six, returns **no facet counts and no highlight markup**, halves its file ceiling to 500K with hybrid
   on, and has unannounced pricing. See the research note's
   [AI Search verdict](../research/hybrid-search-on-cloudflare.md#ai-search).
3. **ACL is a single scalar scope per chunk, pre-filtered in Vectorize, authoritative in our SQL.**
   Vectorize cannot index or filter string arrays, but `$in` matches a *stored scalar* against a
   *candidate array* and is applied before `topK`. So each chunk carries one `scope` and one `vis`, and
   a query filters `{vis: "all"}` ∪ `{scope: {$in: [...]}}`. Membership of a scope lives in the DO, so
   adding someone to a channel re-indexes nothing.
4. **Lexical index in a SQLite Durable Object, not D1.** D1 cannot be exported at all once it contains
   virtual tables, and DO SQL storage is 3.75× cheaper. Chat has already proved FTS5, `bm25()` and
   `snippet()` in a DO (`packages/gatekeeper-chat/src/migrations.ts:143`).
5. **Phase 1 changes no UI.** The search service starts as a pure dense-recall service that chat's own
   DO calls, fusing into the existing `SearchHit` shape. Chat keeps its ACL
   (`packages/gatekeeper-chat/src/do/search.ts:64`, `:299`), so phase 1 adds no new authorization
   surface at all.
6. **The agent gets a read-only `SearchSession`**, a `getAgentCatalog` of sources, and a `/find` slash
   command. No actions, so `getAutoApprovableActions()` returns `[]`, like the Context Library.
7. **Bundled Docs/Sheets/Slides are indexed by patching their blueprints to push**, not by a kernel
   change. Their content lives in private gadget facets with no pull path; the archives in `formats/`
   are ours to repack.

### Rejected

| Option | Why not |
| --- | --- |
| AI Search as the primary index | 5 custom metadata fields, no facet counts, no `<mark>` snippets, 500K files with hybrid, open-beta pricing |
| One AI Search instance per user | 5,000 instances per account, and it duplicates every shared document per viewer |
| bge-m3 for a single-model hybrid | Workers AI publishes no sparse/lexical output for it, and its output dimension is undocumented |
| Kernel patch to index gadget facets centrally | Makes the kernel read private gadget state on a schedule; the starter's rule is wrapper Workers first (`docs/customization.md`) |
| A `providesUi` page as the primary omni-search UI | `sandbox="allow-scripts allow-modals"`, opaque origin, `connect-src 'none'` (`cloudflare-os/packages/workshop-frontend/src/SandboxedGatekeeperApp.tsx:365`), and no caller identity — so no ACL and no deep links off-platform |
| Reusing the Workshop's existing GitHub/Google/Notion connections | The Workshop is the authority for those account stubs and exposes no entrypoint that lends one out |

## Architecture

```
chat DO ── env.SEARCH.ingest(batch) ─┐   cfos-search (packages/gatekeeper-search)
bundled format server.js ────────────┤ ┌──────────────────────────────────────────┐
gadget server.js (env.SEARCH) ───────┼►│ fetch(): Access JWT → SPA / API          │
Context feed (phase 2) ──────────────┤ │ GatekeeperVendor + SearchAccount +       │
connection pollers (phase 2) ────────┘ │   SearchGatekeeper (singleton session)   │
                                       │ SearchIndex DO (idFromName "main"):      │
                                       │   documents, chunks, chunks_fts,         │
                                       │   principals, tombstones                 │
                                       │ EMBED queue ──► embed + upsert           │
                                       └──────┬───────────────────┬───────────────┘
                                              ▼                   ▼
                                       Vectorize index    env.AI (bge-base, bge-reranker)
```

Routing is free: the router forwards `/gatekeeper/<binding-suffix>` to whatever is bound
(`cloudflare-os/packages/router/src/index.ts:28-35`), so `GATEKEEPER_SEARCH` on the router creates
`/gatekeeper/search/*` with no code change.

### How each source feeds it

| Source | Mechanism | Scope | Phase |
| --- | --- | --- | --- |
| Team chat | `ChatWorkspace` DO calls `env.SEARCH.ingest()` on commit, in the same code path that writes `messages_fts` | `chat:<channelId>`, `vis:"all"` for public channels | 1 |
| Backfill of any source | The search Worker enqueues its own `EMBED` queue; sources never see it | as pushed | 1 |
| Context Library | See [Context](#the-context-library) — mint a Context account through the vendor binding, else an additive feed entrypoint on the fork | `context:<collectionId>`, `vis:"all"` for public collections | 2 |
| Connections (GitHub first) | The user connects the service **to search** from the search app page; search holds its own account and polls | `github:<owner>/<repo>` | 2 |
| Bundled Docs / Sheets / Slides | Patched `server.js` pushes on mutation, guarded by `typeof env.SEARCH !== "undefined"` | `workspace:<id>` | 3 |
| User-built gadgets | The gadget's own `server.js` calls `env.SEARCH.put(...)`; opt-in by design | `workspace:<id>` | 3 |

A **service binding, not a Queue, for live deltas**: the chat DO already owns the transaction, batches
are a handful of rows, and a Queue would only add the 128 KB message cap and eventual consistency. The
Queue is for the work the search Worker gives *itself* — embedding, backfill, re-embedding after an
edit — where 5,000 msg/s, 250 concurrent consumers and an automatic dead-letter queue earn their keep.

**There is no pull path for gadget content, and there will not be one without kernel work.** Gadget
storage is a private facet of the Overseer (`overseer.ts:2453-2464`), dynamic workers run with
`globalOutbound: null` (`overseer.ts:2411`), and gadget-to-gadget bindings throw (`overseer.ts:1832`).
So a gadget is indexed only if its own code pushes. The binding arrives three ways: the blueprint
declares it (`BlueprintBinding`, `cloudflare-os/packages/workshop-shared/src/api.ts:3125`) and the user
fills it at instantiation; the agent wires the ambient capsule in with `setGadgetBinding`, which is
exactly what the kernel's own comment says ambient capsules are for (`overseer.ts:4524-4530`); or the
user names it in Connections. An auto-provisioning vendor means the capsule already exists in every
workspace, so no connect flow is involved either way.

### Document model

```sql
documents(id TEXT PK,            -- "<source>:<externalId>"
          source TEXT, kind TEXT, title TEXT, url TEXT,
          scope TEXT, vis TEXT,  -- vis: 'all' | 'scoped'
          workspace TEXT, channel TEXT, author TEXT, mime TEXT,
          created_at INTEGER, updated_at INTEGER, deleted_at INTEGER,
          revision INTEGER, body_hash TEXT)
chunks(id TEXT PK,               -- 22-char base64url hash of the document id + '#' + ord, ≤ 64 bytes
       document_id TEXT, ord INTEGER, text TEXT, tokens INTEGER,
       embed_revision INTEGER, embedded_at INTEGER)
chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='unicode61')
principals(scope TEXT, principal TEXT, PRIMARY KEY(scope, principal))
scopes(scope TEXT PK, source TEXT, label TEXT, vis TEXT)
tombstones(chunk_id TEXT PK, deleted_at INTEGER)
```

- **`id` is the caller's business.** A source re-pushes the same id to update; `body_hash` makes a
  no-op push free, which matters because a Docs gadget will push on every save.
- **Vector ids are hashed**, because Vectorize caps a vector id at 64 bytes.
- **Chunk text lives in SQL, never in vector metadata.** Metadata is capped at 10 KiB, and
  `returnMetadata: "all"` halves `topK` to 50 and slows the query; `"indexed"` keeps `topK: 100` with no
  latency overhead.
- **Six metadata indexes, of the ten Vectorize allows**: `scope`, `vis`, `source`, `kind`, `author`,
  `day` (a `YYYY-MM` bucket, because high-cardinality range queries degrade). Every one must exist
  **before the first upsert** — the docs contradict themselves on adding them later, and re-upserting
  the whole corpus is the only documented repair.
- **Facets** (`source`, `kind`, `workspace`, `channel`, `author`, `mime`, month) are counted from
  `documents` on the lexical side; Vectorize returns no counts.

### Chunking and embedding

`bge-base-en-v1.5` takes 512 input tokens, so chunk at ~400 tokens with 15% overlap on paragraph
boundaries. A chat message is one chunk (its body is capped at 8 KiB,
`packages/gatekeeper-chat/src/shared/protocol.ts:195`); a Doc is many. Embed 100 texts per
`env.AI.run()` — the schema cap — through the deployment's AI Gateway (`{gateway: {id:
<aiGateway.name>}}`) for cost logging, but do not rely on gateway caching, which the docs scope to
"text and image responses". Embeddings are 3000 requests/minute, so a backfill is queue-paced rather
than latency-bound. Fix `pooling: "cls"` for the life of the index: mean and cls embeddings are not
interchangeable.

### Hybrid retrieval

```
qualifier parse ─► ACL scope list for this caller (from principals)
   ├─ dense:   embed(query) ─► Vectorize.query(topK 100, filter {vis:'all'})
   │                        ─► Vectorize.query(topK 100, filter {scope:{$in:[…]}})
   └─ lexical: FTS5 MATCH + WHERE acl + qualifiers, ORDER BY bm25() ASC, LIMIT 100
               (this half also yields the facet counts and snippet() highlights)
   ─► RRF (k=60) over the two rank lists
   ─► drop tombstoned chunks and scopes the caller has lost
   ─► optional bge-reranker-base over the top 30 (flag, off by default)
   ─► hydrate title, url, snippet and facets from SQL
```

- **The ACL filter runs before ranking on both halves**, which is the same rule chat already enforces
  and for the same reason (`packages/gatekeeper-chat/src/do/search.ts:8-9`): filtering after ranking
  leaks the existence of private content through counts and paging.
- **The scope list is bounded.** A Vectorize filter must be under 2048 bytes compact, roughly 90 ids.
  Splitting public content into `vis: "all"` keeps the `$in` list to the caller's *restricted* scopes,
  which for a real team is small. Above ~90, fan out across several queries and merge — a query is
  billed as `dimensions`, so fan-out is a rounding error.
- **A post-filter still runs** after fusion, against `principals` in SQL, because Vectorize writes are
  eventually consistent and a revoked membership must take effect immediately.
- `bm25()` is negative and lower is better, so the lexical rank list is ascending — the lesson already
  recorded in `packages/gatekeeper-chat/spikes/README.md`.

### Query language, freshness and deletion

Reuse chat's grammar (`packages/gatekeeper-chat/src/do/search.ts:126`) and extend it with `source:`,
`kind:` and `workspace:` beside `in:`, `from:`, `to:`, `has:`, `is:thread`, `before:`, `after:`, `on:`.
Free text becomes a safe FTS5 MATCH string exactly as `ftsMatchString()` does it (`search.ts:278`), and
the *parsed* query comes back in the response so the UI can show what the server actually did — the
pattern `app/src/views/SearchView.tsx` already renders as chips. The grammar is **copied, not shared**:
`packages/gatekeeper-search/src/shared/query.ts` owns the omni version and chat's stays untouched, so
phase 1 adds no cross-package runtime dependency.

A delete writes a tombstone and drops the chunk from FTS5 in one transaction, so it vanishes from
results at once; `deleteByIds` follows asynchronously. An edit bumps `revision`, re-chunks and upserts —
upsert replaces a vector in full, so a shrunk document must also delete its orphaned tail chunks. Batch
upserts at ≤1000 vectors per request: one-at-a-time writes are the documented way to turn a 250k-vector
backfill into an hour of lag.

## Identity and authorization

| Surface | Who is asking | How |
| --- | --- | --- |
| `/gatekeeper/search/*` (app, API) | a real person | Access JWT verified with `jose`, exactly as `packages/gatekeeper-chat/src/do/access.ts` does; the Access `sub` is the principal |
| chat's own search (phase 1) | a real person | chat already knows; it passes its `visibleChannelIds()` down as the scope list and never delegates the decision |
| agent `SearchSession` | nobody | `createAccount()` takes no arguments and carries no identity (`cloudflare-os/packages/workshop-shared/src/gatekeeper.ts:525-531`) |
| `providesUi` app page | nobody | `AppUiContext` is `{isAdmin}` only |

So the agent and the app page see **deployment-public content only** in v1 — public chat channels,
public Context collections, and documents a source marked `vis: "all"`. That is the same decision chat
made and for the same reason, and it must be stated in the vendor's `description` so `/admin` can
judge it.

Two ways out, and the recommendation:

| Option | Cost | Verdict |
| --- | --- | --- |
| Fork patch: carry the viewer into the singleton's `ctx.props` and add `viewer` to `AppUiContext` | One frontend + backend commit, the same shape and size as the existing `gadgetViewer` commit (`docs/research/gadget-viewer-identity.md`) | **Recommended**, phase 3. Chat's plan wants the same patch, so one commit serves both. |
| Claim flow: the session shows a one-time code, the user pastes it at `/gatekeeper/search/link` | No fork, ~80 lines, one extra user step per account | Fallback if the fork cannot be carried across an upstream rebase |

ACLs per source:

- **Chat** — `principals(scope="chat:<channelId>")` mirrors `memberships`; a public channel is
  `vis: "all"` instead. Chat pushes membership changes with the same `ingest` call.
- **Context** — a collection's `visibility` is already `"public" | "private"` within a sharing domain
  (`cloudflare-os/packages/gatekeeper-context/src/context-types.ts:94`); public maps to `vis: "all"`,
  private to the owning account.
- **Workspaces** — sharing is workspace-wide with roles `"build" | "use"` (`api.ts:3516`), so
  `principals(scope="workspace:<id>")` is the collaborator set. **Search cannot read that set**: there
  is no Worker entrypoint for it. Until the identity patch lands, a gadget push is visible only to the
  account that owns the pushing capsule.
- **Connections** — the account that connected the service, and nobody else.

## Surfaces

| Surface | Gets us | Costs | Build |
| --- | --- | --- | --- |
| Chat's existing search page, fused server-side | Better chat search for everyone, zero new UI, zero new authorization | none | **Phase 1** |
| `/gatekeeper/search/` SPA at the Worker's own origin | Real identity, real URLs, deep links, facet rail, keyboard-first omni box | ~1 week of SPA, same Vite + assets recipe chat proved | **Phase 2** |
| `SearchSession` + `getAgentCatalog` + `/find` | The agent finds and then *uses* documents in the workspace — the actual goal | ~2 days on top of an existing index | **Phase 3** (pull forward if the index is ready) |
| `providesUi` page | A sidebar entry for free, and `openWorkspace()` can navigate the shell (`SandboxedGatekeeperApp.tsx:124`) | No identity, no off-platform deep links, RPC only | Phase 3, public content only, unless the identity patch lands |
| Command-palette fork patch | Search where people already press ⌘K; today it fuzzy-matches titles client-side only (`cloudflare-os/packages/workshop-frontend/src/components/AppShell/CommandPalette.tsx:284`) | One frontend commit on the fork, same class as chat's phase-2 dock | Phase 3 |

**Build the chat fusion first** because it is the only surface that needs no new identity story, no new
UI and no new ACL code, and it makes the index earn its keep on day one. Build the standalone page
second, because it is the only surface with a verified caller. The agent session is third only because
it depends on the index having breadth; its code is small.

### The agent's session

```ts
interface SearchSession {
  search(query: string, options?: {limit?: number; cursor?: string}): Promise<SearchAnswer>;
  facets(query: string): Promise<Facet[]>;
  open(documentId: string): Promise<DocumentText>;   // full text of one indexed document
  cite(documentId: string): Promise<{title: string; url: string}>;
}
```

Every method is an observation and calls `authorizeObservation()` before returning a row, the shape
`packages/gatekeeper-chat/src/vendor/session.ts:132` already uses. `getAgentCatalog()` returns one entry
per source with its document count and what it covers, passed through `boundAgentCatalog()`
(`gatekeeper.ts:136`) — the Context Library does exactly this (`library-gatekeeper.ts:318`).
`SlashCommandProvider` (`gatekeeper.ts:917`) offers `/find <words>`, expanding to the top hits with
their titles and URLs as an ordinary user message, which the agent then reads with `open()`.

### The Context Library

The Library's own `search()` is a linear scan over every document in a collection, scoring `includes()`
hits (`cloudflare-os/packages/gatekeeper-context/src/context-collection.ts:598`). Indexing it is the
biggest quality win after chat. Two routes, resolved by spike 5:

1. **No fork.** `cfos-search` binds `GATEKEEPER_CONTEXT` with `entrypoint: "GatekeeperVendor"` and
   `props: {sharingDomain}`, calls `createAccount()` to mint itself an account, takes that account's
   singleton gatekeeper class and drives `list()`/`read()` over the domain's **public** collections —
   all on the public interface. Unknown: whether a `DurableObjectClass` returned across a service
   binding is usable by a caller that is not the Workshop.
2. **Additive fork patch.** A `SearchFeed` `WorkerEntrypoint` in `gatekeeper-context` that lists and
   reads public collections' documents. No shared-type change, so it rebases cleanly.

Try 1, fall back to 2. Do not have the agent pump documents across: unbounded and unreliable.

### Bundled Docs, Sheets and Slides

Their content is in private facets, and the kernel's export path (`overseer.ts:2556`) is reachable only
through an authenticated `GadgetClient` — there is no Worker entrypoint, and adding one would mean
letting a Worker enumerate a user's workspaces. Rejected.

Patch the blueprints instead. The archives in `formats/` unpack and repack with tooling this repo owns
(`docs/research/bundled-blueprints/extract-gadget.mjs`, `packages/blueprint-kanban/scripts/archive.mjs`),
and `docs/customization.md:305` already requires re-copying them whenever upstream bumps a revision. So
the patch is a **re-appliable script**, `scripts/patch-format-search.mjs`, injecting a push into
`server.js` on mutation, guarded by `typeof env.SEARCH !== "undefined"` so an unbound instance is
unaffected, and bumping the sidecar `revision`. Its test asserts the patched archive still decodes and
that a fresh upstream archive patches cleanly.

## Phases

| Phase | Deliverable | Effort |
| --- | --- | --- |
| 0 | Spikes below, on a protected evaluation deployment | 2–3 days |
| 1 | `cfos-search` Worker, `SearchIndex` DO, Vectorize index, `EMBED` queue, `ingest`/`query` RPC; chat's DO fuses dense recall into its existing `SearchHit` results; backfill of the existing corpus | 1 week |
| 2 | `/gatekeeper/search/` SPA with facets and deep links; Context Library indexed; GitHub as the one connection, connected to search from its own page | 2 weeks |
| 3 | `SearchSession`, `getAgentCatalog`, `/find`; `env.SEARCH` push API and the bundled-format patch script; command-palette fork patch; the identity fork patch | 2 weeks |

### Phase 0 spikes

1. **Vectorize metadata filtering at ACL scale.** 100k vectors across 500 scopes; `{scope: {$in: [90
   ids]}}` versus `{vis: "all"}`; measure the 2048-byte filter ceiling exactly, recall against an
   unfiltered query, and whether a high-cardinality `scope` degrades the way documented range queries
   do. Also prove metadata indexes must exist before the first upsert.
2. **Embedding cost and latency for a backfill of N.** Tokens per chat message on the real corpus,
   wall-clock for 200k messages through a Queue at 3000 requests/minute, and the cost against the
   table below.
3. **AI Search as a drop-in for the dense half.** One instance, built-in storage, 10k chat messages via
   `items.upload()` with a scalar `scope` in `custom_metadata`; compare hybrid + rerank ordering and
   latency against our fused pair, and confirm `$in` on a scalar behaves as a pre-filter. This is the
   decision gate for decision 2: if embedding proves expensive or slow, swap the dense half behind the
   `DenseIndex` interface rather than rewriting the plan.
4. **FTS5 index size and cost in a DO.** Bytes of `chunks` + `chunks_fts` per 100k chunks, and the
   rows-written bill for virtual-table writes, which the DO docs say are charged.
5. **Context without a fork.** Whether `cfos-search` can mint a Context account through the vendor
   binding and drive the returned singleton class.
6. **`bge-m3` probe.** Its output dimension is undocumented; call it once and read `shape`. Only needed
   if the corpus turns out not to be English.

## Cost and limits

200,000 chunks, 768 dimensions, 20,000 queries a month, on Workers Paid:

| Item | Working | Monthly |
| --- | --- | --- |
| Vectorize stored dimensions | 200k × 768 = 153.6M, less the 10M allowance, at $0.05/100M | $0.07 |
| Vectorize queried dimensions | (20k queries + 200k stored) × 768 = 169M, less the 50M allowance, at $0.01/M | $1.19 |
| Embedding: 20k new chunks + 20k queries | ~1.1M tokens at $0.0666/M (backfill of 200k is $0.53 once) | $0.07 |
| Rerank, if enabled: top 30 × ~100 tokens × 20k | 60M tokens at $0.00311/M | $0.19 |
| DO SQL storage, ~600 MB of chunks + FTS | at $0.20/GB-month | $0.12 |
| Queue operations, 240k messages × 3 ops | at $0.40/M, inside the 1M allowance | $0.00 |
| **Total** | | **≈ $1.65/month** |

Ceilings to watch: 20M vectors per Vectorize index; 10 GB per Durable Object; 10 metadata indexes; a
2048-byte filter; 3000 embedding requests/minute; and a DO serving one request at a time, so search
concurrency is the first thing to measure, exactly as chat's plan says of its own DO.

## Risks

| Risk | Mitigation |
| --- | --- |
| Dense results the caller may not see | ACL is a pre-filter on both halves *and* a post-filter against `principals` in SQL before anything is returned |
| Vectorize eventual consistency makes a just-deleted document findable | Tombstone in SQL in the same transaction as the delete; the post-filter drops it before ranking is shown |
| Metadata indexes are effectively immutable | Fix the six-field schema in phase 0; a seventh field means a rebuild, so budget one rebuild path and test it |
| Embedding drift | Record `embed_revision` per chunk; a model or pooling change is a new index plus a backfill, never an in-place edit |
| AI Search repriced out of beta | It is the fallback, not the dependency; the `DenseIndex` seam is the whole hedge |
| The identity fork patch does not survive a rebase | The claim flow is specified as the no-fork fallback, and public-only mode keeps working either way |
| A source floods the index | Per-source ingest rate limits and a `body_hash` no-op check, both in the DO, as chat does per user |

## Not feasible on today's platform

- **Indexing an arbitrary user-built gadget's content without changing that gadget's code.** Private
  facet storage, `globalOutbound: null`, no gadget-to-gadget binding, no pull path. A gadget opts in or
  it is invisible.
- **Attributing a gadget's push to a person.** The gadget's server facet receives no caller identity
  (`docs/research/gadget-viewer-identity.md`), so a push carries a workspace, never a user.
- **Per-user results for the agent or a `providesUi` page** without the fork patch or the claim flow.
- **Reusing the user's existing Workshop connections.** Search must hold its own accounts and ask for
  its own consent.
- **Enumerating a user's workspaces or outputs from a Worker.** `listGadgets()` and `listOutputs()` are
  on the authenticated session API only.
- **A single-model hybrid.** Workers AI publishes no sparse vector, so the lexical half is always ours.
- **Multi-principal ACLs in one vector filter.** One scalar scope per chunk; everything else is a join
  in our SQL.
- **Read-after-write on the dense half.** A message is lexically searchable immediately and
  semantically searchable a few seconds later. Say so in the UI rather than pretending otherwise.

## Open questions

- Does the corpus justify 768 dimensions, or would `bge-small-en-v1.5` at 384 halve the query bill with
  acceptable quality? Spike 2 should measure both on the same queries.
- Should the omni page replace chat's search view once it exists, or stay beside it? Keeping both means
  two UIs over one index; replacing it means the chat dock has to host the omni page.
- Retention: the index is a derivative store, so is deleting the source document enough, or does it need
  a retention policy of its own? Decide before the pilot, as chat's plan requires of itself.
- One `search` block in `deployment.jsonc` (`{enabled, index, embedModel, rerank}`) or per-source
  sub-blocks? Either way the Vectorize index cannot be provisioned by Wrangler, so `--check` must verify
  it exists before deploying.
