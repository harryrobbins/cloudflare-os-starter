# Build a reusable synthetic data Gatekeeper

This plan defines a deterministic synthetic data service for Cloudflare OS. The service gives agents and bound Gadgets finite, coherent datasets without storing generated rows. A separate [Data Explorer plan](procedural-data-explorer-blueprint.md) describes the first reference UI.

The [performance and cost research](../research/procedural-data-performance-and-cost.md) records the bounded-query rationale, current platform limits, pricing assumptions, and conditions that require another design review.

**Status:** Proposed. Review the public Remote Procedure Call (RPC) contract before implementation.

## Goal and audience

Build one deployment-owned Gatekeeper that can power table explorers, dashboards, maps, timelines, customer relationship management views, observability consoles, and future blueprints. Blueprint authors should connect to one typed capability instead of embedding a different fake-data generator in every Gadget.

Each connection represents one finite synthetic database defined by:

- **Scenario:** the domain model, such as commerce or software as a service (SaaS)
- **Version:** the generation rules and schema revision
- **Seed:** the identity of one reproducible database
- **Size profile:** exact collection cardinalities and supported query limits

The same values must produce the same records, relationships, ordering, cursors, and aggregates. Changing the version may change generated values, so every connection pins it.

## Product vision

The Gatekeeper is a shared demo-data substrate, not a database emulator. It should make a new interface feel populated and internally consistent within minutes while keeping the data disposable and reproducible.

The first release proves three outcomes:

1. A person can configure a finite dataset and explore it in the reference Data Explorer
2. Another Gadget can bind the same dataset resource and render the same entities
3. An agent can discover the contract, wire a new visualization to it, and run bounded queries and exact supported aggregates

“Generated on demand” means the deployment does not persist generated rows. It does not mean the dataset is infinite or that one request can return an unlimited payload. Every collection has an exact row count, and every method caps work, rows, groups, and response bytes.

## One connector with dataset resources

Use one **Synthetic Data** connector rather than separate connectors for small, medium, and large datasets. The connector's resource configurator should select the scenario, version, seed, and size profile. Each selection creates a dataset-scoped capability that multiple Gadgets can bind.

A canonical resource URL could use this shape:

```text
procgen://commerce/v1/demo-4242/medium
```

Treat this as an opaque identifier outside the Gatekeeper. Validate and normalize every component. If seeds may contain arbitrary text, encode them rather than placing raw values in the URL.

The initial profiles should declare exact cardinalities, not approximate labels:

| Profile | Customers | Products | Orders | Order items | Events | Purpose |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `small` | 1,000 | 500 | 10,000 | 30,000 | 50,000 | Tests and lightweight demos |
| `medium` | 100,000 | 10,000 | 1,000,000 | 3,000,000 | 5,000,000 | Product demos and dashboards |
| `large` | Set after benchmarks | Set after benchmarks | Set after benchmarks | Set after benchmarks | Set after benchmarks | Scale demonstrations |

These are proposed starting values. Benchmarks must determine the large profile and may revise the others before the contract stabilizes. A profile is versioned configuration; its cardinalities must not drift under an existing scenario version.

## Why this is a Gatekeeper

Cloudflare OS Gadgets cannot bind directly to other Gadgets. They receive callable shared services through Gatekeeper bindings in their server-side environments. The generator therefore belongs in a Gatekeeper, while each visualization remains an isolated Gadget.

The proposed `packages/gatekeeper-procgen` package should:

- Export a credential-free, auto-provisioned account
- Advertise dataset resources through `getSupportedResources()`
- Provide a resource configurator for scenario, seed, version, and size profile
- Advertise `PROCGEN` as its suggested binding name
- Expose agent-facing TypeScript declarations through `getTypeScriptTypes()`
- Authorize every catalog, data, and aggregate read through `ApprovalQueue.authorizeObservation()`
- Implement an explicit observer policy for shared Gadgets

The deployment wrapper must bind the Worker to the Workshop through `GATEKEEPER_PROCGEN` with the `GatekeeperVendor` entrypoint. The resource configurator returns its iframe through RPC, so v1 does not need a Router binding. Add one only if the Gatekeeper later serves HTTP routes. The Router remains the only public Worker.

## Service boundaries

The first release includes:

- Deterministic, read-only generation
- Finite collection cardinalities
- Stable schemas and relationships
- Primary-key lookup
- Cursor-based scans in canonical order
- Indexed equality and range predicates declared by each collection
- Exact `count`, `sum`, `min`, `max`, and `avg` for declared fields
- Bounded `groupBy` for declared low-cardinality dimensions
- Reproducible scenario presets
- Explicit validation and limit errors

The first release excludes:

- General SQL parsing or database protocol compatibility
- Arbitrary joins, sorting, expressions, and full-text search
- Writes, approval actions, and copy-on-write overlays
- Stored generated rows or materialized indexes
- Fixed latency claims before measurement

These exclusions keep the API honest. A future SQL adapter can translate a supported subset into the typed query and aggregate operations, but SQL should not define the v1 contract.

## Data model

Use a pure TypeScript generation core with no dependency on Durable Object storage. The Gatekeeper and account objects still participate in the Cloudflare OS lifecycle, but generated rows are computed on demand and are not persisted.

Each value derives from a namespaced function:

```text
value = generate(scenario_version, seed, collection, record_id, field)
```

Namespace every input before mixing it. Adding a field must not shift existing field values. Never depend on call order or a mutable random-number generator.

Use string identifiers at the RPC boundary. JavaScript `number` cannot represent every 64-bit integer exactly, and string IDs travel cleanly through TypeScript, JSON views, and UI controls.

### Stable relationships

Every relationship needs a derivation that works in both directions without scanning unrelated records. Two acceptable patterns are:

- Derive a parent ID from the child ID and define a bounded child range that reconstructs child IDs
- Encode the parent partition and local child index into the child ID

The second pattern makes reverse traversal fast but constrains ID layout and maximum children. Document those constraints in scenario metadata rather than presenting the IDs as natural database keys.

### Exact aggregates without full scans

A finite dataset gives aggregates defined meaning, but it does not make a million-row scan affordable in one Worker request. Design aggregatable fields and distributions with an exact reduction strategy.

Supported strategies may include:

- Closed-form formulas for arithmetic sequences and deterministic partitions
- Prefix-summable generators for ranges
- Hierarchical deterministic blocks with exact block summaries derived from the seed
- Small bounded edge scans combined with whole-block summaries

For example, `sum(orders.total_minor)` should reduce deterministic block summaries rather than hydrate every order. The same algorithm must return the same answer as a row-by-row reference implementation on small profiles.

Do not advertise an aggregate for a field or filter combination unless it has an exact bounded algorithm. Never return an estimate under an exact aggregate name. Approximate analytics, if added later, need separate types with error bounds.

### Initial commerce scenario

Start with one polished scenario:

```text
customers
  id, name, email, tier, country_code, created_at

products
  id, sku, title, category, price_minor, currency_code, in_stock

orders
  id, customer_id, status, created_at, total_minor, currency_code

order_items
  id, order_id, product_id, quantity, unit_price_minor

events
  id, customer_id, event_type, occurred_at, properties
```

The generator must enforce invariants such as `order.created_at >= customer.created_at`, line totals matching order totals, valid foreign keys, and plausible event ordering. Tests should verify these rules across many seeds and boundary IDs.

## Proposed RPC contract

The API is dataset-scoped. Once a Gadget binds a resource, it cannot change the seed or profile by passing different arguments. This keeps capability identity clear and prevents two consumers from accidentally querying different universes through one binding.

```typescript
export type SyntheticScalar = string | number | boolean | null;
export type QueryOperator = "eq" | "gt" | "gte" | "lt" | "lte";

export interface DatasetDescription {
  resourceUrl: string;
  scenario: string;
  version: string;
  seedLabel: string;
  sizeProfile: string;
}

export interface CollectionSummary {
  name: string;
  title: string;
  description: string;
  exactRecords: string;
  primaryKey: string;
}

export interface FieldSchema {
  name: string;
  type: "string" | "number" | "boolean" | "timestamp" | "json";
  nullable: boolean;
  semanticType?: "id" | "email" | "country_code" | "currency_minor";
  references?: { collection: string; field: string };
}

export interface CollectionSchema extends CollectionSummary {
  fields: FieldSchema[];
  indexes: Array<{ fields: string[]; operators: QueryOperator[] }>;
  aggregates: Array<{
    functions: Array<"count" | "sum" | "min" | "max" | "avg">;
    field?: string;
    groupBy?: string[];
  }>;
}

export interface QueryPredicate {
  field: string;
  operator: QueryOperator;
  value: SyntheticScalar;
}

export interface QueryRequest {
  collection: string;
  predicates?: QueryPredicate[];
  cursor?: string;
  limit?: number;
  fields?: string[];
}

export interface QueryPage {
  schema: CollectionSchema;
  records: Array<Record<string, unknown>>;
  nextCursor?: string;
}

export interface AggregateRequest {
  collection: string;
  metrics: Array<{
    name: string;
    function: "count" | "sum" | "min" | "max" | "avg";
    field?: string;
  }>;
  predicates?: QueryPredicate[];
  groupBy?: string[];
  limitGroups?: number;
}

export interface AggregateResult {
  groups: Array<{
    key: Record<string, SyntheticScalar>;
    metrics: Record<string, number | string | null>;
  }>;
  exact: true;
}

export interface SyntheticDataSession {
  describeDataset(): Promise<DatasetDescription>;
  listCollections(): Promise<CollectionSummary[]>;
  describeCollection(name: string): Promise<CollectionSchema>;
  getRecord(
    collection: string,
    id: string,
    fields?: string[],
  ): Promise<Record<string, unknown> | null>;
  query(request: QueryRequest): Promise<QueryPage>;
  aggregate(request: AggregateRequest): Promise<AggregateResult>;
}
```

Use strings for exact integer aggregate results that may exceed JavaScript's safe integer range. Define decimal and currency behavior explicitly; v1 should aggregate integer minor units rather than binary floating-point currency.

Set conservative default and hard maximum limits. Reject unsupported predicates or aggregates with structured errors that list valid indexes and aggregate shapes. Cursors must be opaque, versioned, tamper-evident, and bound to the normalized query and dataset resource.

## Bulk reads: table() and facetCounts()

Added 2026-09-23 (`packages/gatekeeper-procgen/src/table.ts`). Paging `query()` costs one observation per 100 rows, and it cannot join, so a mosaic or chart that wants 10,000 orders with each customer's tier took 100 activity records and still lacked the tier. Two calls cover that case, each one observation:

- `table({collection, fields?, where?, sample?, limit?})` returns up to 20,000 rows, column-major, with low-cardinality string columns dictionary-encoded. A field path may follow one declared reference: `customer.tier` on orders, `product.category` on order items. By default it returns the collection's own non-json fields followed by every facet field one reference away. `where` takes up to 4 predicates (`eq`, `in`, `gt`, `gte`, `lt`, `lte`) on any field path. IDs compare as numbers. `sample` reads a keyed affine permutation of the ID space instead of the first IDs. The multiplier is coprime with the collection size, so a sample spreads evenly over the modular foreign keys, where a fixed stride would alias. Rows come back in sample order, so the first k rows of a sample of n are the sample of k.
- `facetCounts({collection, fields, where?})` counts the values of facet fields (fields marked `facet: true` in the schema). Without `where` it derives exact counts where the generator's structure allows: order status by ID, and counts over a reference weighted by children per parent. With the item-to-product stride of 3571 (a prime), each full cycle of products hits every product once. Otherwise it scans. When the scan would pass the budget it counts a permutation sample, scales the counts up and returns `exact: false`.

Both calls stop after generating `PROCGEN_POLICY.maxScanRecords` (200,000) records, joined records included. They report `scannedRecords` and `complete`, so a selective `where` on a medium collection returns what it found rather than scanning further. This deliberately relaxes the rule below against full scans: the budget bounds the work. On a laptop, the worst case is about 0.7 s of CPU (a filter that matches nothing on 5 million events, with a join). A 20,000-row sample with joins takes about 0.25 s.

Not done: caching estimated facet counts per seed in the Gatekeeper's storage, and a SQL subset compiled to the same plan. Add those if a consumer needs them.

## Capability and sharing policy

The generated data contains no customer information or caller-specific secrets. All users connected to the same resource can reproduce it. The observer policy may therefore accept authenticated collaborators for v1, but tests must prove that generation never mixes in account data, request headers, secrets, or deployment metadata.

If later scenarios derive from private schemas, uploads, or organization data, they require a separate capability type and stricter verifier. Do not widen the public synthetic capability to cover private inputs.

Each read should record the scenario, version, size profile, collection, operation, and result count. Do not include generated row values, predicates, or raw seeds in logs.

## Limits and failure behavior

Define limits in one exported policy object and test every boundary. Select initial values through benchmarks. Cover:

- Maximum records and selected fields per query
- Maximum predicates, metrics, and groups
- Supported cursor lifetime and encoded size
- Maximum seed length and allowed characters
- Exact cardinalities for every profile
- CPU and response-size headroom

Reject invalid versions, collections, fields, predicates, aggregates, cursors, and out-of-range IDs before generation. Never fall back to a full scan when an index or aggregate reducer cannot satisfy a request.

## Deployment integration

Keep the Worker outside the pinned `cloudflare-os` submodule. Extend the starter wrapper rather than editing generated `wrangler.prod.jsonc` files.

Implementation work must update:

1. Root workspace and package metadata
2. `deployment.jsonc` types and validation with a stable Worker name
3. `scripts/deploy.ts` package maps, generated bindings, build order, and deployment order
4. A Workshop binding named `GATEKEEPER_PROCGEN` with the `GatekeeperVendor` entrypoint
5. Tests for generated Wrangler configuration and binding discovery
6. Deployment documentation and post-deploy verification

## Verification plan

- **Golden determinism:** repeated calls for one resource produce byte-equivalent records and aggregates
- **Finite bounds:** every collection reports an exact count and rejects out-of-range IDs
- **Version isolation:** a new scenario version cannot change older results
- **Relationships:** every foreign key resolves, reverse traversal matches, and monetary totals reconcile
- **Aggregate equivalence:** optimized reducers equal row-by-row reference results across small datasets and random filtered ranges
- **Pagination:** cursors produce no duplicates or gaps and fail with another query
- **Limits:** oversized queries, invalid indexes, and malformed cursors fail before expensive work
- **Observations:** every successful read is authorized and logged without data or seed leakage
- **Sharing:** owner and collaborator sessions follow the chosen verifier policy
- **Consumer proof:** the Data Explorer and a second Gadget show the same records and aggregates
- **Performance:** publish measured percentiles and Worker resource usage before finalizing profiles

Run package tests, type checks, a Wrangler dry run, root `pnpm check`, and browser-level tests for reference consumers.

## Delivery stages

1. Approve the dataset resource model, RPC contract, invariants, limits, and observer policy
2. Build a row-by-row reference generator for correctness tests
3. Add indexed generation and exact aggregate reducers
4. Implement the Gatekeeper and resource configurator
5. Wire the Worker into the starter deployment and verify discovery
6. Ship the Data Explorer as the first consumer
7. Build a second consumer, such as a metrics dashboard, to prove reuse
8. Benchmark before finalizing size profiles

## Success criteria

A blueprint author can bind `PROCGEN` and build a UI without understanding generator internals. Two independent Gadgets connected to the same resource see identical finite data and exact supported aggregates, while the deployment stores no generated rows.
