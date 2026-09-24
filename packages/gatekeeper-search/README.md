# gatekeeper-search (`cfos-search`)

A deployment-wide hybrid search index: lexical recall, facets and highlighted snippets from SQLite FTS5
in a Durable Object, and semantic recall from Workers AI embeddings in Vectorize. The two are fused with
reciprocal rank fusion. The plan is [docs/plans/omni-search.md](../../docs/plans/omni-search.md), and the
product limits behind it are in
[docs/research/hybrid-search-on-cloudflare.md](../../docs/research/hybrid-search-on-cloudflare.md). Every
shape that crosses a boundary is in [`src/shared/contract.ts`](src/shared/contract.ts).

## Three faces, one index

| Face | Who calls it | Entry |
| --- | --- | --- |
| HTTP at `/gatekeeper/search/*` | People, through the router, behind Cloudflare Access | default `fetch` (`src/handler.ts` → `src/serve.ts`); the SPA in `app/` is served from `ASSETS` |
| `SearchService` | Sources (chat first) over a service binding with `entrypoint: "SearchService"`, `props: {source}` | `src/service.ts`: `ingest(batch)`, `denseRecall(request)` |
| `GatekeeperVendor` | The Workshop, for the agent's read-only `SearchSession` | `src/vendor/` |

All three call the single `SearchIndex` SQLite Durable Object (`idFromName("main")`, `src/search-index.ts`).
The default handler's `queue()` consumes the `EMBED` queue (`src/queue.ts`).

### Request flow

- **Ingest.** `SearchService.ingest()` passes the binding's `props.source` (never anything from the
  batch) to the index. The index validates the whole batch, then applies it in one transaction:
  documents are chunked (about 400 tokens, 15% overlap, on paragraph boundaries), written to `chunks`
  and indexed by FTS5 through triggers. The chunks that need embedding go on the `EMBED` queue, up to
  50 ids per message. An unchanged push, meaning the same body hash and the same metadata, is a no-op.
- **Embedding.** The consumer claims the chunks that still need their current revision embedded,
  embeds them with `@cf/baai/bge-base-en-v1.5` (`pooling: "cls"`, at most 100 texts per call, through
  the AI Gateway when `AI_GATEWAY` is set) and upserts them to Vectorize, at most 1,000 per call. It
  then marks each chunk embedded, but only for the revision it actually embedded. A chunk that changed
  while it was being embedded is queued again. A failing message is retried with backoff, and after
  `max_retries` it goes to the dead-letter queue.
- **Deletes.** A delete, a `dropScopes` or a shrunk document removes chunk rows, and with them their
  FTS entries, and writes a tombstone in the same transaction, so the content disappears from results
  immediately. A Durable Object alarm then calls Vectorize `deleteByIds` in batches, backs off when that
  fails, and forgets purged tombstones after 7 days.
- **Search.** `src/do/retrieve.ts` does the following, in order:
  1. Parses the query grammar (`src/shared/query.ts`: `in:`, `from:`, `source:`, `kind:`,
     `workspace:`, `before:`, `after:` and `on:`).
  2. Resolves the caller's ACL.
  3. Embeds the query and queries Vectorize with `{vis: "all"}` and with
     `{scope: {$in: [...]}}`, fanned out so that each filter stays under 2,048 bytes.
  4. Runs the FTS5 `MATCH` with the ACL and the qualifiers in `WHERE`, ordered by `bm25()` ascending.
  5. Fuses the two lists with RRF (k = 60) at document level.
  6. Post-filters every candidate against SQL.
  7. Reranks the top 30 with `@cf/baai/bge-reranker-base`, only when `RERANK=1`.
  8. Hydrates the hits.

  Facets are counted in SQL over the caller's lexical and qualifier match set. If Workers AI or
  Vectorize fails, the response carries `dense: "unavailable"` and the lexical results.

## ACL model

Every document has exactly one scalar `scope` (`chat:<channelId>`, `context:<collectionId>` or
`account:<accountId>`) and a `vis` of `"all"` or `"scoped"`. Vectorize cannot filter arrays, so a scope's
membership lives in the `principals` table. As a result, adding someone to a channel re-indexes nothing.

| Caller | Sees |
| --- | --- |
| `person` (Access `sub`) | `vis: "all"` plus every scope that lists them in `principals` |
| `delegated` (chat's phase-1 fusion) | exactly the scopes the source passed, restricted to `<source>:`, and never `vis: "all"` |
| `agent` | `vis: "all"` plus `account:<accountId>` |

The ACL is enforced in four places:

- It is a `WHERE` clause on the lexical half and a metadata pre-filter on the dense half, so it applies
  before ranking. Counts and paging therefore never reveal private content.
- It is enforced again in SQL after fusion and at hydration. Vectorize is eventually consistent, so a
  revoked membership or a deleted document still disappears from results immediately.
- A source can write, delete and change permissions only for ids and scopes under its own `<source>:`
  prefix. The `gadget` source may also use `account:` scopes, which must be `vis: "scoped"`.
- `in:` treats a scope the caller cannot see exactly like one that does not exist.

## Bindings

| Binding | Kind | Notes |
| --- | --- | --- |
| `SEARCH_INDEX` | Durable Object (`SearchIndex`, SQLite) | The index. `SearchGatekeeper` is the vendor's facet class, reached through `ctx.exports`. |
| `VECTORS` | Vectorize | 768 dimensions, cosine |
| `AI` | Workers AI | Embeddings and the optional reranker |
| `EMBED` | Queue producer and consumer | `cfos-search-embed`, dead-letter queue `cfos-search-embed-dlq` |
| `ASSETS` | Assets | `app/dist`, `run_worker_first` so Access runs before the shell is served |
| `CF_ACCESS_ISS`, `CF_ACCESS_AUD` | vars | Access JWT verification |
| `ADMINS` | var | A JSON array or a JSON string of admin emails, for `/api/admin/*` |
| `PUBLIC_BASE_URL` | var | The Origin check on non-GET requests |
| `AI_GATEWAY` | var | The AI Gateway id. Empty means Workers AI is called directly. |
| `RERANK` | var | `"1"` turns the reranker on |

If `AI` or `VECTORS` is missing, search runs lexical-only and reports `dense: "off"`.

## Provisioning prerequisites

Wrangler cannot create a Vectorize index from config, and the metadata indexes must exist **before the
first upsert**. Re-upserting the whole corpus is the only documented repair. Create them once per
deployment:

```sh
wrangler vectorize create cfos-search --dimensions=768 --metric=cosine
for field in scope vis source kind author day; do
  wrangler vectorize create-metadata-index cfos-search --property-name="$field" --type=string
done
wrangler queues create cfos-search-embed
wrangler queues create cfos-search-embed-dlq
```

A seventh metadata field, or any change to the model, pooling or chunking, needs a new index and a
backfill. Bump `EMBED_REVISION` in the contract, then run `POST /api/admin/requeue`.

## HTTP API

These routes live under `/gatekeeper/search/api`. Every response is JSON with
`cache-control: private, no-store`, and errors use the `{error: {code, message}}` envelope.

| Route | Returns |
| --- | --- |
| `GET /me` | `Me` |
| `GET /search?q=&cursor=&limit=&facets=0` | `OmniSearchResult`. Limited to 60 per person per minute (429 after that). |
| `GET /sources` | `{sources: SourceSummary[]}` |
| `GET /documents/:id` | `DocumentText`, or 404 when the document is not visible |
| `GET /admin/stats` | `IndexStats`, admins only |
| `POST /admin/requeue` | `{queued}`, admins only, Origin-checked |

## Development

```sh
eval "$(fnm env)" && fnm use v24.21.0
pnpm exec tsc --noEmit        # types (app/ has its own tsconfig)
pnpm exec vitest run          # the Worker suites, in workerd
pnpm dev                      # wrangler.dev.jsonc: DEV_IDENTITY stands in for Access; lexical-only
```

In tests, the dense half is a deterministic fake (`__tests__/support/fake-dense.ts`), a hashed bag of
words with a crude stemmer. `__tests__/worker.ts` installs it with `overrideDenseIndexFactory()`.
Nothing under `src/` calls that override, and the fake is not under `src/`, so production cannot
select it.

After `wrangler.jsonc` changes, regenerate `worker-configuration.d.ts` with
`pnpm exec wrangler types --strict-vars=false` and re-apply the hand edit described in its header.
