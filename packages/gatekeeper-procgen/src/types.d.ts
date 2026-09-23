/** Scalar values accepted by synthetic-data predicates. */
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
  /** Exact number of records, represented as a string to avoid integer precision loss. */
  exactRecords: string;
  primaryKey: string;
}
export interface FieldSchema {
  name: string;
  type: "string" | "number" | "boolean" | "timestamp" | "json";
  nullable: boolean;
  semanticType?: "id" | "email" | "country_code" | "currency_minor";
  references?: { collection: string; field: string };
  /** A low-cardinality category: table() joins it in by default and facetCounts() counts it. */
  facet?: boolean;
}
export interface CollectionSchema extends CollectionSummary {
  fields: FieldSchema[];
  /** Predicate shapes accepted by query(). Predicates must match one declared index. */
  indexes: Array<{ fields: string[]; operators: QueryOperator[] }>;
  /** Exact aggregate shapes accepted by aggregate(). */
  aggregates: Array<{ functions: Array<"count" | "sum" | "min" | "max" | "avg">; field?: string; groupBy?: string[] }>;
}
export interface QueryPredicate { field: string; operator: QueryOperator; value: SyntheticScalar }
export interface QueryRequest {
  collection: string;
  predicates?: QueryPredicate[];
  /** Opaque continuation returned by an earlier identical query. */
  cursor?: string;
  /** Defaults to 50 and cannot exceed 100. */
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
  metrics: Array<{ name: string; function: "count" | "sum" | "min" | "max" | "avg"; field?: string }>;
  predicates?: QueryPredicate[];
  groupBy?: string[];
  /** Defaults to 25 and cannot exceed 100. */
  limitGroups?: number;
}
export interface AggregateResult {
  groups: Array<{ key: Record<string, SyntheticScalar>; metrics: Record<string, number | string | null> }>;
  exact: true;
}
/**
 * A field of the collection, or of a record one reference away: "customer_id" names a customer, so
 * "customer.tier" is that customer's tier. The prefix is the reference field without "_id".
 */
export type FieldPath = string;
export type TableOperator = QueryOperator | "in";
export interface TablePredicate {
  field: FieldPath;
  operator: TableOperator;
  /** A list of at most 50 values for "in"; one value otherwise. IDs compare as numbers. */
  value: SyntheticScalar | SyntheticScalar[];
}
export interface TableRequest {
  collection: string;
  /**
   * At most 32 field paths. Defaults to the collection's own fields (json fields excluded) followed
   * by every facet field one reference away, such as "customer.tier" and "customer.country_code".
   */
  fields?: FieldPath[];
  /** At most 4 predicates, all of which must hold. Any field path may be filtered on. */
  where?: TablePredicate[];
  /**
   * Read a spread-out sample of the whole collection instead of the first records in ID order.
   * Rows come back in sample order, not ID order: the same seed always yields the same order, so
   * the first k rows of a sample of n are exactly the sample of k. `true` uses the seed "sample".
   */
  sample?: boolean | { seed: string };
  /** Defaults to 2,000 and cannot exceed 20,000. */
  limit?: number;
}
export interface TableColumn extends FieldSchema {
  /** Present on string columns sent dictionary-encoded: that column's values are indexes into it. */
  dictionary?: string[];
}
export interface TableResult {
  collection: string;
  columns: TableColumn[];
  /** Column-major: data[c][r] is row r of columns[c]. */
  data: unknown[][];
  rowCount: number;
  /** Exact number of records in the collection, as a string. */
  totalRecords: string;
  /**
   * Records examined. A call generates at most 200,000 records, joined records included, so a
   * selective `where` on a large collection can stop early with fewer rows than `limit`.
   */
  scannedRecords: number;
  /** True when the rows are every record that matches: nothing in scope was left unread. */
  complete: boolean;
  /** Exact number of matching records, when known: the read is complete, or there is no `where`. */
  matchedRecords?: string;
  sampled: boolean;
}
export interface FacetCountsRequest {
  collection: string;
  /** 1-8 facet field paths (fields marked `facet`, possibly one reference away). */
  fields: FieldPath[];
  where?: TablePredicate[];
}
export interface FacetCountsResult {
  /**
   * False when the counts were scaled up from a spread-out sample because the scan passed the
   * 200,000-record budget. Counts over a reference (such as "customer.tier" on orders) and order
   * status are derived exactly without scanning the larger collection, when there is no `where`.
   */
  exact: boolean;
  scannedRecords: number;
  /** Records counted (scaled when not exact). */
  total: number;
  facets: Array<{ field: FieldPath; values: Array<{ value: SyntheticScalar; count: number }> }>;
}
/** One finite, reproducible synthetic database. IDs are decimal strings. */
export interface SyntheticDataSession {
  describeDataset(): Promise<DatasetDescription>;
  listCollections(): Promise<CollectionSummary[]>;
  describeCollection(name: string): Promise<CollectionSchema>;
  getRecord(collection: string, id: string, fields?: string[]): Promise<Record<string, unknown> | null>;
  /** Scans canonical ID order. Only predicates matching a declared index are accepted. */
  query(request: QueryRequest): Promise<QueryPage>;
  /** Computes only the exact aggregate shapes advertised by describeCollection(). */
  aggregate(request: AggregateRequest): Promise<AggregateResult>;
  /**
   * Up to 20,000 rows in one call, with facet fields joined across references and categories
   * dictionary-encoded. Prefer it to paging query() when you need many rows: it is one read.
   */
  table(request: TableRequest): Promise<TableResult>;
  /** Value counts for facet fields over the whole collection (or those matching `where`). */
  facetCounts(request: FacetCountsRequest): Promise<FacetCountsResult>;
}
