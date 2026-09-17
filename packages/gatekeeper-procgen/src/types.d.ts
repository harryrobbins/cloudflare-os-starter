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
}
