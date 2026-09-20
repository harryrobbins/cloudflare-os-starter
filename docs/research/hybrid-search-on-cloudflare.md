# Hybrid search on Cloudflare: products, limits, prices and dead ends

Product facts behind [omni-search.md](../plans/omni-search.md). Every figure was read from
developers.cloudflare.com on **2026-09-20**; each row carries its URL. Nothing here is from memory,
and the "not found in docs" rows are deliberate — treat them as spikes, not as defaults.

## Headline findings

1. **Workers AI has no sparse/lexical vector.** `@cf/baai/bge-m3` returns dense embeddings from
   `{text}` and *reranker scores* from `{query, contexts}`; the strings `sparse`, `lexical_weights`
   and `colbert` appear nowhere in the Workers AI docs. So a hybrid index cannot come from one
   model — the lexical half has to be our own FTS5.
2. **Vectorize metadata filtering is a pre-filter** and `$in` matches a *stored scalar* against a
   *candidate array*. That is exactly the shape an ACL needs (`{scope: {$in: [...caller's scopes]}}`),
   and it is applied before `topK`. The binding constraint is the **2048-byte compact-JSON filter
   cap**, not the operator set.
3. **Vectorize cannot index or filter string arrays**, so a document may carry only **one** scope id.
   Multi-principal ACLs must be modelled as a scope whose membership lives in our own SQL.
4. **AI Search is now genuinely hybrid** (BM25 + vector, RRF fusion, optional `bge-reranker-base`
   reranking, query rewriting, similarity cache) and is **free in open beta with R2 and Vectorize
   bundled**. It is ruled out as the primary index by **5 custom metadata fields per instance**, no
   facet counts, and unannounced pricing — not by retrieval quality. See [AI Search](#ai-search).
5. **FTS5 is documented on both D1 and Durable Object SQLite.** D1 loses `wrangler d1 export` for any
   database containing virtual tables, and DO SQL storage is 3.75× cheaper, which decides it.

## Vectorize

V2 indexes. <https://developers.cloudflare.com/vectorize/platform/limits/> (updated 2026-08-05).

| Limit | Value |
| --- | --- |
| Max dimensions per vector | 1536, float32 |
| Max vectors per index | 20,000,000 |
| Max vector ID length | **64 bytes** |
| Metadata per vector | 10 KiB |
| Metadata indexes per index | **10** |
| Indexed data per metadata index per vector | **first 64 bytes** of the string |
| `topK` without values and `returnMetadata:"all"` | **100** |
| `topK` with `returnValues` or `returnMetadata:"all"` | **50** |
| Upsert batch size | 1000 (Workers) / 5000 (HTTP) |
| Namespaces per index | 50,000 (paid) — but [insert-vectors](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/) still says 1,000; plan for 1,000 |
| Indexes per account | 50,000 paid / 100 free |

Filtering — <https://developers.cloudflare.com/vectorize/reference/metadata-filtering/>:

- Verbatim: "`filter` is applied first, and the `topK` results are taken from the filtered set".
- Operators: `$eq $ne $in $nin $lt $lte $gt $gte`. Multiple keys are an implicit AND. **No `$or`.**
- "`filter` must be non-empty object whose compact JSON representation must be **less than 2048
  bytes**". At ~20 bytes per quoted id that is roughly **90 ids in one `$in`**.
- Filtering needs a metadata index; "Vectors upserted before a metadata index was created won't have
  their metadata contained in that index", while the same page's Limitations section claims indexes must
  exist *before* any insert. **Create every metadata index before the first upsert** and treat
  re-upsert as the only repair.
- Namespace filters run before metadata filters. High-cardinality *range* queries degrade ("a full
  index scan in the worst case"); bucket timestamps. Values may be string, number, boolean or null;
  `string[]` is storable but Vectorize "does not currently index or filter" arrays.

Writes — <https://developers.cloudflare.com/vectorize/reference/client-api/>:

- Inserts, upserts and `deleteByIds` are asynchronous: "It typically takes a few seconds for inserted
  vectors to be available for querying." There is **no documented way to poll a `mutationId`**.
- Upsert "replaces the existing vector in full"; insert keeps the first write for a duplicate id.
- Write jobs coalesce at "200,000 total vectors or 1,000 individual updates, whichever limit it hits
  first" — 250k vectors inserted one at a time "could take at least an hour"; the same 250k in 100
  batched requests lands "within minutes".
- `query`, `queryById`, `getByIds`, `deleteByIds`, `listVectors`, `describe` are binding methods.
  Metadata-index management is **Wrangler/REST only** (`wrangler vectorize create-metadata-index`).
- Dimensions and metric are immutable after creation. No documented query rate limit or latency SLA.

Pricing — <https://developers.cloudflare.com/vectorize/platform/pricing/>: **$0.01 per million
queried vector dimensions**, **$0.05 per 100 million stored dimensions**; paid tier includes 50M
queried and 10M stored. Queried dimensions are `(number of queries + stored vectors) × dimensions`,
so **dimension count is the cost lever and `topK` does not appear in the formula**. Published example:
1536 dims, 500k vectors, 1M queries/month = **$23.42/month**.

Wrangler config (`node_modules/wrangler/config-schema.json`, wrangler 4.124.0) requires
`{binding, index_name}` — **there is no automatic provisioning**, unlike R2. The index must be created
by `wrangler vectorize create` before deploy, and local dev needs `remote: true`.

## Workers AI

Embedding models, the complete Text Embeddings category on
<https://developers.cloudflare.com/workers-ai/models/>:

| Model | Dims | Max input tokens | Batch items | $/M input tokens |
| --- | --- | --- | --- | --- |
| `@cf/baai/bge-small-en-v1.5` | 384 | 512 | 100 | 0.0202 |
| `@cf/baai/bge-base-en-v1.5` | 768 | 512 | 100 | 0.0666 |
| `@cf/baai/bge-large-en-v1.5` | 1024 | 512 | 100 | 0.204 |
| `@cf/baai/bge-m3` (multilingual) | **not found in docs** | not stated, 60k context | 100 | 0.0118 |
| `@cf/qwen/qwen3-embedding-0.6b` | **not found in docs** | 8192 | 32 | 0.0118 |
| `@cf/google/embeddinggemma-300m` (beta) | **not found in docs** | not found | — | **no price published** |
| `@cf/pfnet/plamo-embedding-1b` (Japanese) | **not found in docs** | not found | — | 0.0186 |

- No gte, e5, nomic, jina or voyage model exists on Workers AI today.
- Dense response shape is `{shape: number[], data: number[][]}`. The bge v1.5 family takes
  `pooling: "mean" | "cls"`, default `mean`, and the docs warn the two are **not compatible** —
  "we highly suggest using the new `cls` pooling for better accuracy". Pick one per index, forever.
  `bge-m3`'s published `SynchronousOutput` schema is wrong (it is the async `request_id` envelope), so
  its dense shape and dimension are undocumented; probe `shape` before sizing an index.
- **Async Batch API**: `env.AI.run(model, {requests: [...]}, {queueRequest: true})`, poll by
  `request_id`. Only documented bound is a **10 MB payload**; max requests per batch, turnaround and
  batch pricing are **not found in docs**.
  <https://developers.cloudflare.com/workers-ai/features/batch-api/>

Reranker — exactly one, <https://developers.cloudflare.com/workers-ai/models/bge-reranker-base/>:
**`@cf/baai/bge-reranker-base`**, task Text Classification, input `{query, contexts: [{text}], top_k?}`,
output `{response: [{id, score}]}` where `id` indexes the request's contexts and `score` is a raw
logit. **$0.00311 per M input tokens** — the cheapest text model on the platform. No batch schema, so
it cannot go through the Batch API; `bge-m3` in `{query, contexts}` mode is the batchable stand-in.
No `bge-reranker-v2-m3`, no Cohere rerank.

Limits — <https://developers.cloudflare.com/workers-ai/platform/limits/> and
<https://developers.cloudflare.com/workers-ai/platform/pricing/>: **Text Embeddings 3000 requests per
minute** (`bge-large-en-v1.5` 1500), **Text Classification 2000 rpm**; 10,000 neurons/day free,
$0.011 per 1,000 neurons, all limits reset 00:00 UTC. Concurrency limits and the max non-batch request
size are **not found in docs**.

## AI Search

<https://developers.cloudflare.com/ai-search/>. The marketing page
(<https://www.cloudflare.com/products/ai-search/>) is behind the developer docs: it mentions neither
hybrid search nor reranking, both of which are documented.

- **Pipeline**: ingestion → Workers AI Markdown conversion → chunking → embedding → "Each chunk is
  also indexed for BM25 keyword matching" → stored. Every instance ships "built-in storage and a
  built-in vector index, powered by R2 and Vectorize" — not user-accessible.
  <https://developers.cloudflare.com/ai-search/concepts/how-ai-search-works/>
- **Sources, exactly three**: built-in storage, a website crawl of a domain you own, and an R2 bucket.
  Arbitrary text can be pushed with no R2 of your own via `instance.items.upload({name, content})`,
  ≤ 4 MB, with `options.metadata`; built-in-storage items are "indexed immediately", R2 and website
  sources follow a 1/2/4/6/12/24-hour sync (default 6 h, manual jobs at most once per 30 s).
  <https://developers.cloudflare.com/ai-search/configuration/data-source/>,
  <https://developers.cloudflare.com/ai-search/api/items/workers-binding/>
- **Retrieval**: `retrieval_type` defaults to `hybrid`; `fusion_method` `rrf` (default) or `max`;
  Porter (default) or Trigram tokenizer; `keyword_match_mode` `and`/`or`; `max_num_results` 1–50
  (default 10); `match_threshold` default 0.4; `boost_by` max 3 fields; reranking **off by default**
  with `@cf/baai/bge-reranker-base`; query rewriting off by default; similarity cache on with a 48 h
  default TTL. Response `chunks[]` carries `text`, `score` and `scoring_details` (per-method score and
  rank) — but **no highlight markup and no facet counts**. Instances are creatable at runtime
  (`create/get/list/delete` on an `ai_search_namespaces` binding), and instance-per-tenant is the
  documented multitenancy pattern.
  <https://developers.cloudflare.com/ai-search/api/search/workers-binding/>,
  <https://developers.cloudflare.com/ai-search/how-to/per-tenant-search/>
- **Limits/pricing** <https://developers.cloudflare.com/ai-search/platform/limits-pricing/>:
  5,000 instances and 100 namespaces per account (paid); **1M files per instance, or 500K with hybrid
  search**; 4 MB per file; 10 instances per cross-instance search; **5 custom metadata fields per
  instance**; 10 KiB metadata per vector; **filters match only the first 64 UTF-8 bytes**. Free in
  open beta with storage and vector indexing included; Workers AI and AI Gateway billed separately;
  "Pricing details will be communicated at least 30 days before any billing begins." Queries per
  minute: **not found in docs**.
- **Metadata**: built-ins `filename`, `folder`, `timestamp`; custom fields declared per instance as
  `{field_name, data_type}` over `text|number|boolean|datetime`. Same operator set as Vectorize, with
  the same verbatim caveats: "`$in` does not search inside stored arrays" and "Vectorize can store
  string arrays, but does not currently index or filter them."

**Verdict for this plan.** A single scalar `scope` plus `{scope: {$in: [...]}}` *would* work here too,
so AI Search is not disqualified by ACLs alone. It is disqualified as the primary index by the 5-field
metadata budget (the plan needs scope, vis, source, kind, author and a date bucket = 6), the absence
of facet counts and highlight markup, the 500K-file hybrid ceiling, and beta pricing. It remains the
right fallback for the *dense half* if embedding cost or backfill time proves prohibitive: the Items
API is a strictly smaller integration than Vectorize plus Workers AI.

## Lexical index: D1 vs Durable Object SQLite

Both document the same extension set, including "FTS5 module for full-text search (including
`fts5vocab`)" — <https://developers.cloudflare.com/d1/sql-api/sql-statements/> and
<https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>.

| | D1 | DO SQLite |
| --- | --- | --- |
| Max size | 10 GB per database | 10 GB per object, unlimited objects |
| Storage price | **$0.75 / GB-month** | **$0.20 / GB-month** |
| Rows read / written | $0.001 / M and $1.00 / M | identical |
| Query cap | 1000 queries per Worker invocation, **30 s max query**, single-threaded per database | one request at a time per object; 30 s CPU, raisable to 5 min |
| Export | **"Export is not supported for databases containing virtual tables"** — no `wrangler d1 export` with FTS5 | no documented restriction |
| Other | max 100 bound params, 100 columns, 2 MB row, **50-byte LIKE/GLOB pattern** | "Writing data to SQLite virtual tables also counts towards rows written"; `sql.exec()` cannot run `BEGIN TRANSACTION` |

Sources: <https://developers.cloudflare.com/d1/platform/limits/>, [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/),
[D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/),
<https://developers.cloudflare.com/durable-objects/platform/limits/>, [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Queues and AI Gateway

Queues — <https://developers.cloudflare.com/queues/platform/limits/> and
[pricing](https://developers.cloudflare.com/queues/platform/pricing/): **128 KB per message**, 100 per
consumer batch, 100 or 256 KB per `sendBatch`, **5,000 messages/s per queue**, 250 concurrent consumer
invocations, 100 retries, 25 GB backlog, 14-day retention. Consumer defaults are batch 10 / 5 s /
3 retries; a dead-letter queue is created automatically if named. **"Any Worker can write to a queue"**,
including from inside a Durable Object. Billing counts **one operation per 64 KB written, read or
deleted**, at **$0.40 per million**, ≈3 operations per small message end to end; each retry is another
read. The 128 KB cap means messages carry ids, not bodies.

AI Gateway — <https://developers.cloudflare.com/ai-gateway/>: analytics, logging, caching, rate
limiting, retries and fallback are **free**; 20 gateways per account (paid), 500 logs/s per gateway.
Workers AI rides it with a third argument, `env.AI.run(model, input, {gateway: {id, skipCache}})`
(<https://developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/>). Caching is off
by default and keyed on an exact hash of the whole request; the docs scope it to "text and image
responses", and **whether embedding responses are cacheable is not found in docs**, so do not plan on it.

## Not found in docs (open, and therefore spikes)

1. Output dimensions for `bge-m3`, `qwen3-embedding-0.6b`, `embeddinggemma-300m`, `plamo-embedding-1b`.
2. Any sparse / lexical-weight / ColBERT output from Workers AI — affirmatively absent.
3. A way to poll a Vectorize `mutationId` to completion.
4. Any Vectorize per-index query rate limit, QPS ceiling or latency SLA.
5. Workers AI concurrency limits and max non-batch request size; Batch API max requests and pricing.
6. AI Search queries per minute; its chunking defaults; its max reranked chunks.
7. Whether Vectorize `$in` on a high-cardinality indexed string degrades the way range queries do.
8. Two live doc contradictions to design around: Vectorize namespaces per index (50,000 vs 1,000), and
   whether metadata indexes may be created after vectors exist.
