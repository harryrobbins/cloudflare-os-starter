import type { FacetCountsRequest, FacetCountsResult, FieldSchema, SyntheticScalar, TableColumn, TablePredicate, TableRequest, TableResult } from "./types.js";
import { candidateIds, COLLECTION_NAMES, countFor, DEFINITIONS, generateRecord, hash, isCollection, type CollectionName } from "./generator.js";
import { PROCGEN_POLICY } from "./policy.js";
import type { DatasetResource } from "./resource.js";

// Bulk reads for clients that want many rows at once (Tessera's mosaic, charts, notebooks).
// Records are pure functions of their ID and every foreign key is arithmetic, so joining a
// referenced record costs one more generateRecord() call, and a sample is a keyed permutation of
// the ID space. Work is bounded by PROCGEN_POLICY.maxScanRecords generated records per call.

export interface Reference { prefix: string; key: string; collection: CollectionName }
interface ResolvedPath { path: string; field: FieldSchema; via?: Reference }
interface Predicate { path: ResolvedPath; operator: TablePredicate["operator"]; values: SyntheticScalar[] }

const OPERATORS = new Set(["eq", "gt", "gte", "lt", "lte", "in"]);

function ownFields(collection: CollectionName): FieldSchema[] { return DEFINITIONS[collection].fields as readonly FieldSchema[] as FieldSchema[]; }

/** customer_id -> {prefix: "customer", collection: "customers"}, one per declared reference. */
function referencesOf(collection: CollectionName): Reference[] {
  return ownFields(collection).flatMap(field => field.references && isCollection(field.references.collection) ? [{ prefix: field.name.replace(/_id$/, ""), key: field.name, collection: field.references.collection }] : []);
}

export function resolvePath(collection: CollectionName, path: string): ResolvedPath {
  if (typeof path !== "string" || path.length > 128) throw new Error("Field paths are strings of at most 128 characters.");
  const parts = path.split(".");
  if (parts.length === 1) {
    const field = ownFields(collection).find(candidate => candidate.name === path);
    if (!field) throw new Error(`Unknown field ${path} on ${collection}; valid fields: ${ownFields(collection).map(f => f.name).join(", ")}.`);
    return { path, field };
  }
  const refs = referencesOf(collection);
  if (parts.length > 2) throw new Error(`Field paths follow at most one reference, like ${refs[0] ? `${refs[0].prefix}.id` : "id"}.`);
  const via = refs.find(ref => ref.prefix === parts[0]);
  if (!via) throw new Error(`${collection} has no reference ${parts[0]}; valid references: ${refs.map(ref => ref.prefix).join(", ") || "none"}.`);
  const field = ownFields(via.collection).find(candidate => candidate.name === parts[1]);
  if (!field) throw new Error(`Unknown field ${parts[1]} on ${via.collection}; valid fields: ${ownFields(via.collection).map(f => f.name).join(", ")}.`);
  return { path, field, via };
}

/** The collection's own non-json fields, then every facet field one reference away. */
export function defaultPaths(collection: CollectionName): string[] {
  const own = ownFields(collection).filter(field => field.type !== "json").map(field => field.name);
  const joined = referencesOf(collection).flatMap(ref => ownFields(ref.collection).filter(field => field.facet).map(field => `${ref.prefix}.${field.name}`));
  return [...own, ...joined];
}

function checkValue(path: ResolvedPath, value: SyntheticScalar): SyntheticScalar {
  const { field } = path;
  if (field.semanticType === "id") {
    const text = typeof value === "number" ? String(value) : value;
    if (typeof text !== "string" || !/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(`${path.path} compares with positive decimal IDs.`);
    return Number(text);
  }
  const expected = field.type === "timestamp" ? "string" : field.type;
  if (typeof value !== expected) throw new Error(`${path.path} compares with ${expected} values.`);
  return value;
}

function parsePredicates(collection: CollectionName, where: TablePredicate[] | undefined): Predicate[] {
  if (where === undefined) return [];
  if (!Array.isArray(where) || where.length > PROCGEN_POLICY.maxPredicates) throw new Error(`At most ${PROCGEN_POLICY.maxPredicates} predicates are allowed.`);
  return where.map(predicate => {
    if (!predicate || !OPERATORS.has(predicate.operator)) throw new Error("Predicate operators are eq, in, gt, gte, lt and lte.");
    const path = resolvePath(collection, predicate.field);
    if (path.field.type === "json") throw new Error(`${path.path} is a json field and cannot be filtered on.`);
    if (predicate.operator === "in") {
      if (!Array.isArray(predicate.value) || predicate.value.length < 1 || predicate.value.length > PROCGEN_POLICY.maxInValues) throw new Error(`"in" takes a list of 1-${PROCGEN_POLICY.maxInValues} values.`);
      return { path, operator: "in", values: predicate.value.map(value => checkValue(path, value)) };
    }
    if (Array.isArray(predicate.value)) throw new Error(`Only "in" takes a list of values.`);
    if (predicate.operator !== "eq" && path.field.type === "boolean") throw new Error(`${path.path} is boolean and supports eq and in only.`);
    return { path, operator: predicate.operator, values: [checkValue(path, predicate.value)] };
  });
}

/** Generates one row's records lazily: the record itself, and each referenced record at most once. */
class Row {
  private related = new Map<string, Record<string, unknown>>();
  generated = 1;
  constructor(private resource: DatasetResource, readonly record: Record<string, unknown>) {}
  get(path: ResolvedPath): unknown {
    if (!path.via) return this.record[path.field.name];
    let target = this.related.get(path.via.prefix);
    if (!target) { target = generateRecord(this.resource, path.via.collection, Number(this.record[path.via.key])); this.related.set(path.via.prefix, target); this.generated++; }
    return target[path.field.name];
  }
}

function comparable(path: ResolvedPath, value: unknown): unknown { return path.field.semanticType === "id" ? Number(value) : value; }
function matches(row: Row, predicates: Predicate[]): boolean {
  for (const { path, operator, values } of predicates) {
    const value = comparable(path, row.get(path)) as number | string | boolean;
    if (operator === "in" || operator === "eq") { if (!values.includes(value)) return false; continue; }
    const bound = values[0] as number | string;
    if (operator === "gt" ? !(value > bound) : operator === "gte" ? !(value >= bound) : operator === "lt" ? !(value < bound) : !(value <= bound)) return false;
  }
  return true;
}

/**
 * A keyed affine permutation of 1..total: i -> (a*i + b) mod total + 1 with gcd(a, total) = 1.
 * Because a is coprime with every divisor of total, the first n IDs also spread evenly over the
 * modular foreign keys (order -> customer, item -> order), unlike a fixed stride, which aliases.
 */
export function permutation(total: number, seed: string): (index: number) => number {
  if (total <= 1) return () => 1;
  const gcd = (x: number, y: number): number => { while (y) [x, y] = [y, x % y]; return x; };
  let a = Math.max(1, Math.floor(total * 0.6180339887) + (hash(seed, "sample-a", total) % 1024)) % total || 1;
  while (gcd(a, total) !== 1) a = a % total + 1;
  const b = hash(seed, "sample-b", total) % total;
  return index => ((a * index + b) % total) + 1;
}

/** The IDs to examine, in order: a permutation, an indexed range or parent lookup, or ID order. */
function scope(resource: DatasetResource, collection: CollectionName, predicates: Predicate[], sampleSeed: string | undefined): { size: number; at: (index: number) => number } {
  const total = countFor(resource, collection);
  if (sampleSeed !== undefined) return { size: total, at: permutation(total, sampleSeed) };
  const parent = DEFINITIONS[collection].parent;
  const parentEq = predicates.find(p => !p.path.via && p.path.field.name === parent && p.operator === "eq");
  if (parentEq) {
    const ids = candidateIds(resource, collection, [{ field: parent!, operator: "eq", value: String(parentEq.values[0]) }], 0, PROCGEN_POLICY.maxScanRecords + 1);
    return { size: ids.length, at: index => ids[index] };
  }
  let low = 1, high = total;
  for (const p of predicates) {
    if (p.path.via || p.path.field.name !== "id" || p.operator === "in") continue;
    const n = p.values[0] as number;
    if (p.operator === "eq") { low = Math.max(low, n); high = Math.min(high, n); }
    else if (p.operator === "gt") low = Math.max(low, n + 1);
    else if (p.operator === "gte") low = Math.max(low, n);
    else if (p.operator === "lt") high = Math.min(high, n - 1);
    else high = Math.min(high, n);
  }
  return { size: Math.max(0, high - low + 1), at: index => low + index };
}

function sampleSeedOf(sample: TableRequest["sample"]): string | undefined {
  if (sample === undefined || sample === false) return undefined;
  if (sample === true) return "sample";
  if (!sample || typeof sample.seed !== "string" || !PROCGEN_POLICY.seedPattern.test(sample.seed)) throw new Error("sample is true or {seed}, a seed of 1-64 letters, numbers, dots, dashes or underscores.");
  return sample.seed;
}

/** String columns with few distinct values travel as a dictionary plus indexes. */
function encode(field: TableColumn, values: unknown[]): { column: TableColumn; values: unknown[] } {
  if (field.type !== "string" || values.length < 16) return { column: field, values };
  const index = new Map<string, number>();
  const codes: number[] = [];
  for (const value of values) {
    if (typeof value !== "string") return { column: field, values };
    let code = index.get(value);
    if (code === undefined) { code = index.size; index.set(value, code); if (index.size > 1024 || index.size > values.length / 2) return { column: field, values }; }
    codes.push(code);
  }
  return { column: { ...field, dictionary: [...index.keys()] }, values: codes };
}

export function table(resource: DatasetResource, request: TableRequest): TableResult {
  if (!request || typeof request.collection !== "string" || !isCollection(request.collection)) throw new Error(`Unknown collection; valid collections: ${COLLECTION_NAMES.join(", ")}.`);
  const collection = request.collection;
  const limit = request.limit ?? PROCGEN_POLICY.defaultTableLimit;
  if (!Number.isInteger(limit) || limit < 1 || limit > PROCGEN_POLICY.maxTableLimit) throw new Error(`Table limit must be 1-${PROCGEN_POLICY.maxTableLimit}.`);
  const paths = request.fields ?? defaultPaths(collection);
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > PROCGEN_POLICY.maxTableFields || new Set(paths).size !== paths.length) throw new Error(`Select 1-${PROCGEN_POLICY.maxTableFields} unique field paths.`);
  const selected = paths.map(path => resolvePath(collection, path));
  const predicates = parsePredicates(collection, request.where);
  const sampleSeed = sampleSeedOf(request.sample);
  const { size, at } = scope(resource, collection, predicates, sampleSeed);

  const rows: Row[] = [];
  let scanned = 0, generated = 0, index = 0;
  for (; index < size && rows.length < limit; index++) {
    if (generated >= PROCGEN_POLICY.maxScanRecords) break;
    const row = new Row(resource, generateRecord(resource, collection, at(index)));
    scanned++;
    const keep = matches(row, predicates);
    if (keep) { for (const path of selected) row.get(path); rows.push(row); }
    generated += row.generated;
  }
  const exhausted = index >= size;

  const columns: TableColumn[] = [], data: unknown[][] = [];
  for (const path of selected) {
    const { column, values } = encode({ ...path.field, name: path.path }, rows.map(row => row.get(path) ?? null));
    columns.push(column); data.push(values);
  }
  const total = countFor(resource, collection);
  const matched = exhausted ? rows.length : predicates.length === 0 ? size : undefined;
  return { collection, columns, data, rowCount: rows.length, totalRecords: String(total), scannedRecords: scanned, complete: exhausted, ...(matched !== undefined && { matchedRecords: String(matched) }), sampled: sampleSeed !== undefined };
}

// facetCounts: each field is counted exactly where the generator's structure allows it without
// scanning a large collection; otherwise from a full scan when it fits the budget, otherwise from
// a permutation sample scaled up (and the result is marked inexact).

/** How many `collection` records reference each record of `via.collection`, or undefined if not closed-form. */
export function childCounts(resource: DatasetResource, collection: CollectionName, via: Reference): ((parentId: number) => number) | undefined {
  const total = countFor(resource, collection), parents = countFor(resource, via.collection);
  if (via.key === "customer_id" && (collection === "orders" || collection === "events")) return id => (id <= total ? Math.floor((total - id) / parents) + 1 : 0);
  if (via.key === "order_id" && collection === "order_items") return () => 3;
  if (via.key === "product_id" && collection === "order_items") {
    // itemProduct() steps through products by 3571 (prime) mod the product count, so every full
    // cycle of `parents` items hits each product once; only the remainder needs generating.
    const full = Math.floor(total / parents);
    const extra = new Map<number, number>();
    for (let id = full * parents + 1; id <= total; id++) { const p = Number(generateRecord(resource, "order_items", id).product_id); extra.set(p, (extra.get(p) ?? 0) + 1); }
    return id => full + (extra.get(id) ?? 0);
  }
  return undefined;
}

type Tally = Map<SyntheticScalar, number>;
const bump = (tally: Tally, value: unknown, by = 1) => { const key = (value ?? null) as SyntheticScalar; tally.set(key, (tally.get(key) ?? 0) + by); };

export function facetCounts(resource: DatasetResource, request: FacetCountsRequest): FacetCountsResult {
  if (!request || typeof request.collection !== "string" || !isCollection(request.collection)) throw new Error(`Unknown collection; valid collections: ${COLLECTION_NAMES.join(", ")}.`);
  const collection = request.collection;
  if (!Array.isArray(request.fields) || request.fields.length < 1 || request.fields.length > PROCGEN_POLICY.maxFacetFields || new Set(request.fields).size !== request.fields.length) throw new Error(`Count 1-${PROCGEN_POLICY.maxFacetFields} unique facet fields.`);
  const paths = request.fields.map(path => resolvePath(collection, path));
  for (const path of paths) if (!path.field.facet) throw new Error(`${path.path} is not a facet; facet fields here: ${defaultPaths(collection).filter(p => resolvePath(collection, p).field.facet).join(", ")}.`);
  const predicates = parsePredicates(collection, request.where);
  const total = countFor(resource, collection);
  const tallies = new Map<string, Tally>(paths.map(path => [path.path, new Map()]));
  let scanned = 0, exact = true, counted = total;

  const scanAll = (targets: ResolvedPath[]) => {
    // ID order when the whole collection fits the budget, a permutation sample otherwise, so a
    // scan cut short by the budget is still spread over the collection.
    const inOrder = total <= PROCGEN_POLICY.maxScanRecords;
    const at = inOrder ? (i: number) => i + 1 : permutation(total, "facet-counts");
    let matched = 0, generated = 0, i = 0;
    for (; i < total && generated < PROCGEN_POLICY.maxScanRecords; i++) {
      const row = new Row(resource, generateRecord(resource, collection, at(i)));
      scanned++;
      if (matches(row, predicates)) { matched++; for (const path of targets) bump(tallies.get(path.path)!, row.get(path)); }
      generated += row.generated;
    }
    if (i < total) {
      exact = false;
      const scale = total / i;
      for (const path of targets) for (const [value, count] of tallies.get(path.path)!) tallies.get(path.path)!.set(value, Math.round(count * scale));
      matched = Math.round(matched * scale);
    }
    counted = matched;
  };

  if (predicates.length) scanAll(paths);
  else {
    const rest: ResolvedPath[] = [];
    const byVia = new Map<string, ResolvedPath[]>();
    for (const path of paths) {
      if (path.field.name === "status" && (collection === "orders" ? !path.via : path.via?.key === "order_id")) {
        // generateRecord() cycles status by order ID, as aggregate() also relies on; every order has three items.
        const orders = countFor(resource, "orders"), perOrder = collection === "orders" ? 1 : 3;
        const statuses = ["pending", "paid", "shipped", "refunded"];
        statuses.forEach((status, k) => tallies.get(path.path)!.set(status, perOrder * (k < orders ? Math.floor((orders - 1 - k) / statuses.length) + 1 : 0)));
      } else if (path.via && total > PROCGEN_POLICY.maxScanRecords && countFor(resource, path.via.collection) <= PROCGEN_POLICY.maxScanRecords && childCounts(resource, collection, path.via)) {
        byVia.set(path.via.prefix, [...(byVia.get(path.via.prefix) ?? []), path]);
      } else rest.push(path);
    }
    for (const group of byVia.values()) {
      const via = group[0].via!;
      const weight = childCounts(resource, collection, via)!;
      for (let id = 1; id <= countFor(resource, via.collection); id++) {
        const parent = generateRecord(resource, via.collection, id);
        scanned++;
        const w = weight(id);
        if (w) for (const path of group) bump(tallies.get(path.path)!, parent[path.field.name], w);
      }
    }
    if (rest.length) scanAll(rest);
  }

  return {
    exact, scannedRecords: scanned, total: counted,
    facets: paths.map(path => ({ field: path.path, values: [...tallies.get(path.path)!].filter(([, count]) => count > 0).sort((x, y) => y[1] - x[1] || String(x[0]).localeCompare(String(y[0]))).map(([value, count]) => ({ value, count })) })),
  };
}
