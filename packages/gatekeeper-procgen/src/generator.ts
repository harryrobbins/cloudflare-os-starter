import type { AggregateRequest, AggregateResult, CollectionSchema, QueryPredicate, SyntheticScalar } from "./types.js";
import { PROFILE_CARDINALITIES } from "./policy.js";
import type { DatasetResource } from "./resource.js";

const COUNTRIES = ["US", "GB", "DE", "FR", "CA", "AU", "JP", "BR"] as const;
const TIERS = ["starter", "growth", "enterprise"] as const;
const CATEGORIES = ["apparel", "electronics", "home", "outdoors", "office"] as const;
const STATUSES = ["pending", "paid", "shipped", "refunded"] as const;
const EVENTS = ["page_view", "search", "add_to_cart", "purchase", "support_view"] as const;
const BASE_TIME = Date.UTC(2021, 0, 1);

export type CollectionName = keyof (typeof PROFILE_CARDINALITIES)["small"];
export const COLLECTION_NAMES: CollectionName[] = ["customers", "products", "orders", "order_items", "events"];

function hash(seed: string, namespace: string, id: number): number {
  let h = 2166136261;
  const value = `${seed}\0${namespace}\0${id}`;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function iso(ms: number): string { return new Date(ms).toISOString(); }
function price(productId: number): number { return 100 + ((productId * 7919) % 9900); }
function itemProduct(itemId: number, productCount: number): number { return ((itemId * 3571 - 1) % productCount) + 1; }
function itemQuantity(itemId: number): number { return ((itemId - 1) % 3) + 1; }
function orderTotal(orderId: number, productCount: number): number {
  let total = 0;
  for (let offset = 1; offset <= 3; offset++) {
    const itemId = (orderId - 1) * 3 + offset;
    total += price(itemProduct(itemId, productCount)) * itemQuantity(itemId);
  }
  return total;
}

const field = (name: string, type: "string" | "number" | "boolean" | "timestamp" | "json", semanticType?: "id" | "email" | "country_code" | "currency_minor", references?: { collection: string; field: string }) => ({ name, type, nullable: false, ...(semanticType && { semanticType }), ...(references && { references }) });

const DEFINITIONS = {
  customers: { title: "Customers", description: "Synthetic customer accounts.", fields: [field("id", "string", "id"), field("name", "string"), field("email", "string", "email"), field("tier", "string"), field("country_code", "string", "country_code"), field("created_at", "timestamp")], parent: undefined },
  products: { title: "Products", description: "Synthetic product catalog.", fields: [field("id", "string", "id"), field("sku", "string"), field("title", "string"), field("category", "string"), field("price_minor", "number", "currency_minor"), field("currency_code", "string"), field("in_stock", "boolean")], parent: undefined },
  orders: { title: "Orders", description: "Customer orders with three line items each.", fields: [field("id", "string", "id"), field("customer_id", "string", "id", { collection: "customers", field: "id" }), field("status", "string"), field("created_at", "timestamp"), field("total_minor", "number", "currency_minor"), field("currency_code", "string")], parent: "customer_id" },
  order_items: { title: "Order items", description: "Exactly three line items for every order.", fields: [field("id", "string", "id"), field("order_id", "string", "id", { collection: "orders", field: "id" }), field("product_id", "string", "id", { collection: "products", field: "id" }), field("quantity", "number"), field("unit_price_minor", "number", "currency_minor")], parent: "order_id" },
  events: { title: "Events", description: "Synthetic customer activity events.", fields: [field("id", "string", "id"), field("customer_id", "string", "id", { collection: "customers", field: "id" }), field("event_type", "string"), field("occurred_at", "timestamp"), field("properties", "json")], parent: "customer_id" },
} as const;

export function isCollection(value: string): value is CollectionName { return COLLECTION_NAMES.includes(value as CollectionName); }
export function countFor(resource: DatasetResource, collection: CollectionName): number { return PROFILE_CARDINALITIES[resource.profile][collection]; }

export function schemaFor(resource: DatasetResource, collection: CollectionName): CollectionSchema {
  const def = DEFINITIONS[collection];
  const indexes: CollectionSchema["indexes"] = [{ fields: ["id"], operators: ["eq", "gt", "gte", "lt", "lte"] }];
  if (def.parent) indexes.push({ fields: [def.parent], operators: ["eq"] });
  const aggregates: CollectionSchema["aggregates"] = [{ functions: ["count"] }];
  if (collection === "orders") {
    aggregates.push({ functions: ["sum", "min", "max", "avg"], field: "total_minor" });
    aggregates.push({ functions: ["count"], groupBy: ["status"] });
  }
  return { name: collection, title: def.title, description: def.description, exactRecords: String(countFor(resource, collection)), primaryKey: "id", fields: [...def.fields], indexes, aggregates };
}

export function generateRecord(resource: DatasetResource, collection: CollectionName, id: number): Record<string, unknown> {
  const sizes = PROFILE_CARDINALITIES[resource.profile];
  if (!Number.isSafeInteger(id) || id < 1 || id > sizes[collection]) throw new Error(`Record ID is out of range for ${collection}.`);
  const customerId = ((id - 1) % sizes.customers) + 1;
  switch (collection) {
    case "customers": {
      const created = BASE_TIME + (hash(resource.seed, "customer-created", id) % (365 * 3)) * 86_400_000;
      return { id: String(id), name: `Customer ${id}`, email: `customer-${id}-${hash(resource.seed, "email", id).toString(36)}@example.test`, tier: TIERS[hash(resource.seed, "tier", id) % TIERS.length], country_code: COUNTRIES[hash(resource.seed, "country", id) % COUNTRIES.length], created_at: iso(created) };
    }
    case "products": return { id: String(id), sku: `SKU-${String(id).padStart(6, "0")}`, title: `Product ${id}`, category: CATEGORIES[hash(resource.seed, "category", id) % CATEGORIES.length], price_minor: price(id), currency_code: "USD", in_stock: hash(resource.seed, "stock", id) % 7 !== 0 };
    case "orders": {
      const customer = generateRecord(resource, "customers", customerId);
      const created = Date.parse(customer.created_at as string) + (1 + Math.floor((id - 1) / sizes.customers)) * 86_400_000;
      return { id: String(id), customer_id: String(customerId), status: STATUSES[(id - 1) % STATUSES.length], created_at: iso(created), total_minor: orderTotal(id, sizes.products), currency_code: "USD" };
    }
    case "order_items": {
      const orderId = Math.ceil(id / 3); const productId = itemProduct(id, sizes.products);
      return { id: String(id), order_id: String(orderId), product_id: String(productId), quantity: itemQuantity(id), unit_price_minor: price(productId) };
    }
    case "events": {
      const customer = generateRecord(resource, "customers", customerId);
      const occurred = Date.parse(customer.created_at as string) + (1 + Math.floor((id - 1) / sizes.customers)) * 3_600_000;
      return { id: String(id), customer_id: String(customerId), event_type: EVENTS[hash(resource.seed, "event", id) % EVENTS.length], occurred_at: iso(occurred), properties: { channel: hash(resource.seed, "channel", id) % 2 ? "web" : "mobile" } };
    }
  }
}

function integer(value: SyntheticScalar, label: string): number {
  const parsed = typeof value === "string" && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a positive decimal string.`);
  return parsed;
}

export function candidateIds(resource: DatasetResource, collection: CollectionName, predicates: QueryPredicate[], offset = 0, take = Number.MAX_SAFE_INTEGER): number[] {
  const total = countFor(resource, collection);
  if (!predicates.length) return [];
  const fields = new Set(predicates.map(p => p.field));
  if (fields.size !== 1) throw new Error("Predicates must match one declared index; valid indexes are listed by describeCollection().");
  const indexedField = predicates[0].field;
  const def = DEFINITIONS[collection];
  if (indexedField !== "id" && indexedField !== def.parent) throw new Error("Unsupported predicate index; valid indexes are listed by describeCollection().");
  if (indexedField !== "id") {
    if (predicates.length !== 1 || predicates[0].operator !== "eq") throw new Error(`${indexedField} supports equality only.`);
    const parent = integer(predicates[0].value, indexedField);
    if (collection === "order_items") return parent <= countFor(resource, "orders") ? [parent * 3 - 2, parent * 3 - 1, parent * 3].slice(offset, offset + take) : [];
    const stride = countFor(resource, "customers");
    if (parent > stride) return [];
    const ids: number[] = [];
    for (let id = parent + offset * stride; id <= total && ids.length < take; id += stride) ids.push(id);
    return ids;
  }
  let low = 1, high = total;
  for (const predicate of predicates) {
    const n = integer(predicate.value, "id");
    if (predicate.operator === "eq") { low = Math.max(low, n); high = Math.min(high, n); }
    else if (predicate.operator === "gt") low = Math.max(low, n + 1);
    else if (predicate.operator === "gte") low = Math.max(low, n);
    else if (predicate.operator === "lt") high = Math.min(high, n - 1);
    else high = Math.min(high, n);
  }
  const ids: number[] = [];
  for (let id = low + offset; id <= high && ids.length < take; id++) ids.push(id);
  return ids;
}

export function aggregate(resource: DatasetResource, request: AggregateRequest): AggregateResult {
  if (!isCollection(request.collection)) throw new Error(`Unknown collection ${request.collection}.`);
  if (request.predicates?.length) throw new Error("Aggregates with predicates are not supported in v1; valid shapes are listed by describeCollection().");
  if (request.groupBy?.length) {
    if (request.collection !== "orders" || request.groupBy.length !== 1 || request.groupBy[0] !== "status" || request.metrics.some(m => m.function !== "count" || m.field !== undefined)) throw new Error("Unsupported group aggregate; valid shapes are listed by describeCollection().");
    const total = countFor(resource, "orders");
    return { exact: true, groups: STATUSES.map((status, index) => ({ key: { status }, metrics: Object.fromEntries(request.metrics.map(m => [m.name, Math.floor((total + 3 - index) / 4)])) })) };
  }
  const total = countFor(resource, request.collection);
  const result: Record<string, number | string | null> = {};
  for (const metric of request.metrics) {
    if (metric.function === "count" && metric.field === undefined) { result[metric.name] = String(total); continue; }
    if (request.collection !== "orders" || metric.field !== "total_minor" || metric.function === "count") throw new Error("Unsupported aggregate; valid shapes are listed by describeCollection().");
    // The order-value sequence repeats after lcm(product count, 3) orders. Reduce one bounded period.
    const period = PROFILE_CARDINALITIES[resource.profile].products;
    let cycleSum = 0, min = Infinity, max = -Infinity;
    for (let id = 1; id <= Math.min(total, period); id++) { const value = orderTotal(id, period); cycleSum += value; min = Math.min(min, value); max = Math.max(max, value); }
    const cycles = Math.floor(total / period), remainder = total % period;
    let sum = cycleSum * cycles;
    for (let id = 1; id <= remainder; id++) sum += orderTotal(id, period);
    result[metric.name] = metric.function === "sum" ? String(sum) : metric.function === "min" ? min : metric.function === "max" ? max : sum / total;
  }
  return { exact: true, groups: [{ key: {}, metrics: result }] };
}
