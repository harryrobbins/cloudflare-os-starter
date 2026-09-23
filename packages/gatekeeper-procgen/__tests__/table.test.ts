import { describe, expect, it } from "vitest";
import { generateRecord } from "../src/generator.js";
import { parseResourceUrl } from "../src/resource.js";
import { childCounts, defaultPaths, facetCounts, permutation, table } from "../src/table.js";
import type { TableResult } from "../src/types.js";

const small = parseResourceUrl("procgen://commerce/v1/demo-4242/small");
const medium = parseResourceUrl("procgen://commerce/v1/demo-4242/medium");

/** Row-major objects from a column-major, dictionary-encoded result. */
function rows(result: TableResult): Array<Record<string, unknown>> {
  return Array.from({ length: result.rowCount }, (_, r) => Object.fromEntries(result.columns.map((column, c) => [column.name, column.dictionary ? column.dictionary[result.data[c][r] as number] : result.data[c][r]])));
}
/** The same row built by hand from generateRecord, following one reference per dotted path. */
function reference(resource: typeof small, collection: "orders" | "order_items" | "events", id: number, paths: string[]): Record<string, unknown> {
  const record = generateRecord(resource, collection, id);
  const targets: Record<string, [string, "customers" | "orders" | "products"]> = { customer: ["customer_id", "customers"], order: ["order_id", "orders"], product: ["product_id", "products"] };
  return Object.fromEntries(paths.map(path => {
    const [head, tail] = path.split(".");
    if (!tail) return [path, record[path]];
    const [key, target] = targets[head];
    return [path, generateRecord(resource, target, Number(record[key]))[tail]];
  }));
}

describe("table()", () => {
  it("joins facet fields one reference away by default and matches generateRecord", () => {
    expect(defaultPaths("orders")).toEqual(["id", "customer_id", "status", "created_at", "total_minor", "currency_code", "customer.tier", "customer.country_code"]);
    expect(defaultPaths("order_items")).toEqual(expect.arrayContaining(["order.status", "product.category", "product.in_stock"]));
    expect(defaultPaths("events")).not.toContain("properties");
    const result = table(small, { collection: "order_items", limit: 300 });
    expect(result).toMatchObject({ rowCount: 300, totalRecords: "30000", scannedRecords: 300, complete: false, matchedRecords: "30000", sampled: false });
    const paths = result.columns.map(column => column.name);
    expect(rows(result)).toEqual(Array.from({ length: 300 }, (_, i) => reference(small, "order_items", i + 1, paths)));
    expect(result.columns.find(column => column.name === "product.category")).toMatchObject({ type: "string", facet: true, dictionary: expect.any(Array) });
    expect(result.columns.find(column => column.name === "id")?.dictionary).toBeUndefined();
  });

  it("reads a whole small collection in one call and reports it complete", () => {
    const result = table(small, { collection: "daily_metrics", limit: 20_000 });
    expect(result).toMatchObject({ rowCount: 730, complete: true, matchedRecords: "730" });
  });

  it("filters on joined fields, returning the first matches in ID order", () => {
    const where = [{ field: "customer.tier", operator: "eq" as const, value: "enterprise" }, { field: "status", operator: "in" as const, value: ["paid", "shipped"] }];
    const result = table(small, { collection: "orders", fields: ["id", "status", "customer.tier"], where, limit: 50 });
    const expected: Array<Record<string, unknown>> = [];
    for (let id = 1; expected.length < 50; id++) {
      const row = reference(small, "orders", id, ["id", "status", "customer.tier"]);
      if (row["customer.tier"] === "enterprise" && ["paid", "shipped"].includes(row.status as string)) expected.push(row);
    }
    expect(rows(result)).toEqual(expected);
    expect(result.complete).toBe(false);
    expect(result.matchedRecords).toBeUndefined();
  });

  it("counts every match when the scan finishes, and compares IDs as numbers", () => {
    const result = table(small, { collection: "orders", fields: ["id"], where: [{ field: "id", operator: "gt", value: "9990" }] });
    expect(rows(result).map(row => row.id)).toEqual(["9991", "9992", "9993", "9994", "9995", "9996", "9997", "9998", "9999", "10000"]);
    expect(result).toMatchObject({ complete: true, matchedRecords: "10", scannedRecords: 10 });
  });

  it("uses the parent index instead of scanning a large collection", () => {
    const result = table(medium, { collection: "orders", fields: ["id", "customer_id"], where: [{ field: "customer_id", operator: "eq", value: "7" }] });
    expect(rows(result).map(row => row.id)).toEqual(Array.from({ length: 10 }, (_, i) => String(7 + i * 100_000)));
    expect(result).toMatchObject({ complete: true, scannedRecords: 10 });
  });

  it("samples the whole collection deterministically and prefix-consistently, without aliasing foreign keys", () => {
    const a = table(medium, { collection: "orders", fields: ["id", "customer_id", "status"], sample: true, limit: 10_000 });
    const b = table(medium, { collection: "orders", fields: ["id", "customer_id", "status"], sample: { seed: "sample" }, limit: 10_000 });
    expect(a.data).toEqual(b.data);
    const ids = rows(a).map(row => Number(row.id));
    expect(new Set(ids).size).toBe(10_000);
    expect(Math.min(...ids)).toBeLessThan(1_000);
    expect(Math.max(...ids)).toBeGreaterThan(999_000);
    const prefix = table(medium, { collection: "orders", fields: ["id", "customer_id", "status"], sample: true, limit: 100 });
    expect(rows(prefix)).toEqual(rows(a).slice(0, 100));
    const early = rows(prefix).map(row => Number(row.id));
    expect(Math.max(...early) - Math.min(...early)).toBeGreaterThan(900_000);
    expect(new Set(rows(a).map(row => row.customer_id)).size).toBe(10_000);
    const statuses = new Map<unknown, number>();
    for (const row of rows(a)) statuses.set(row.status, (statuses.get(row.status) ?? 0) + 1);
    for (const count of statuses.values()) expect(count).toBe(2_500);
    const other = table(medium, { collection: "orders", fields: ["id"], sample: { seed: "other" }, limit: 100 });
    expect(other.data[0]).not.toEqual(a.data[0].slice(0, 100));
    expect(a.sampled).toBe(true);
  });

  it("permutes every ID exactly once", () => {
    for (const total of [1, 2, 12, 730, 1000, 30_000]) {
      const at = permutation(total, "seed");
      const seen = new Set(Array.from({ length: total }, (_, i) => at(i)));
      expect(seen.size).toBe(total);
      expect(Math.min(...seen)).toBe(1);
      expect(Math.max(...seen)).toBe(total);
    }
  });

  it("stops at the scan budget and says the read is incomplete", () => {
    const result = table(medium, { collection: "events", fields: ["id"], where: [{ field: "event_type", operator: "eq", value: "nope" }] });
    expect(result).toMatchObject({ rowCount: 0, scannedRecords: 200_000, complete: false });
  });

  it("rejects malformed requests with actionable messages", () => {
    expect(() => table(small, { collection: "nope" })).toThrow("valid collections");
    expect(() => table(small, { collection: "orders", limit: 20_001 })).toThrow("1-20000");
    expect(() => table(small, { collection: "orders", fields: ["customer.nope"] })).toThrow("valid fields");
    expect(() => table(small, { collection: "orders", fields: ["buyer.tier"] })).toThrow("valid references: customer");
    expect(() => table(small, { collection: "order_items", fields: ["order.customer.tier"] })).toThrow("at most one reference");
    expect(() => table(small, { collection: "orders", fields: ["id", "id"] })).toThrow("unique");
    expect(() => table(small, { collection: "orders", where: [{ field: "total_minor", operator: "gt", value: "5" }] })).toThrow("number values");
    expect(() => table(small, { collection: "orders", where: [{ field: "id", operator: "gt", value: "abc" }] })).toThrow("decimal IDs");
    expect(() => table(small, { collection: "orders", where: [{ field: "status", operator: "in", value: "paid" }] })).toThrow("list");
    expect(() => table(small, { collection: "events", where: [{ field: "properties", operator: "eq", value: "x" }] })).toThrow("json");
    expect(() => table(small, { collection: "orders", sample: { seed: "bad seed" } })).toThrow("seed");
  });
});

describe("facetCounts()", () => {
  const brute = (resource: typeof small, collection: "orders" | "order_items" | "events", total: number, paths: string[], keep = (_row: Record<string, unknown>) => true) => {
    const tallies = Object.fromEntries(paths.map(path => [path, new Map<unknown, number>()]));
    for (let id = 1; id <= total; id++) {
      const row = reference(resource, collection, id, paths);
      if (!keep(row)) continue;
      for (const path of paths) tallies[path].set(row[path], (tallies[path].get(row[path]) ?? 0) + 1);
    }
    return paths.map(path => Object.fromEntries(tallies[path]));
  };
  const asObjects = (result: ReturnType<typeof facetCounts>) => result.facets.map(facet => Object.fromEntries(facet.values.map(({ value, count }) => [String(value), count])));

  it("counts small collections exactly, joined facets included", () => {
    const result = facetCounts(small, { collection: "order_items", fields: ["order.status", "product.category", "product.in_stock"] });
    expect(result).toMatchObject({ exact: true, total: 30_000 });
    expect(asObjects(result)).toEqual(brute(small, "order_items", 30_000, ["order.status", "product.category", "product.in_stock"]).map(o => Object.fromEntries(Object.entries(o).map(([k, v]) => [String(k), v]))));
    const facet = result.facets[1].values;
    expect(facet.map(v => v.count)).toEqual(facet.map(v => v.count).toSorted((x, y) => y - x));
  });

  it("applies where to the counted records", () => {
    const where = [{ field: "customer.country_code", operator: "eq" as const, value: "GB" }];
    const result = facetCounts(small, { collection: "orders", fields: ["status", "customer.tier"], where });
    expect(result.exact).toBe(true);
    const expected = brute(small, "orders", 10_000, ["status", "customer.tier", "customer.country_code"], row => row["customer.country_code"] === "GB");
    expect(asObjects(result)).toEqual(expected.slice(0, 2));
    expect(result.total).toBe(Object.values(expected[0]).reduce((a, b) => a + b, 0));
  });

  it("derives exact medium counts from the parent collection instead of scanning children", () => {
    const orders = facetCounts(medium, { collection: "orders", fields: ["status", "customer.tier"] });
    expect(orders).toMatchObject({ exact: true, total: 1_000_000, scannedRecords: 100_000 });
    expect(orders.facets[0].values.map(v => v.count)).toEqual([250_000, 250_000, 250_000, 250_000]);
    let tier = 0;
    for (let id = 1; id <= 100_000; id++) if (generateRecord(medium, "customers", id).tier === "growth") tier++;
    expect(orders.facets[1].values.find(v => v.value === "growth")?.count).toBe(tier * 10);
    const items = facetCounts(medium, { collection: "order_items", fields: ["product.category", "order.status"] });
    expect(items.exact).toBe(true);
    expect(items.facets[0].values.reduce((sum, v) => sum + v.count, 0)).toBe(3_000_000);
    expect(items.facets[1].values.map(v => v.count)).toEqual([750_000, 750_000, 750_000, 750_000]);
  });

  it("derives child counts per parent that agree with generating every child", () => {
    const cases = [["order_items", { prefix: "product", key: "product_id", collection: "products" }, 500], ["order_items", { prefix: "order", key: "order_id", collection: "orders" }, 10_000], ["orders", { prefix: "customer", key: "customer_id", collection: "customers" }, 1_000], ["events", { prefix: "customer", key: "customer_id", collection: "customers" }, 1_000]] as const;
    for (const [collection, via, parents] of cases) {
      const counts = new Map<number, number>();
      const total = { order_items: 30_000, orders: 10_000, events: 50_000 }[collection];
      for (let id = 1; id <= total; id++) { const parent = Number(generateRecord(small, collection, id)[via.key]); counts.set(parent, (counts.get(parent) ?? 0) + 1); }
      const weight = childCounts(small, collection, via)!;
      for (let id = 1; id <= parents; id++) expect(weight(id)).toBe(counts.get(id) ?? 0);
    }
  });

  it("estimates from a sample when a collection is too large to scan", () => {
    const result = facetCounts(medium, { collection: "events", fields: ["event_type"] });
    expect(result.exact).toBe(false);
    expect(result.scannedRecords).toBe(200_000);
    const sum = result.facets[0].values.reduce((total, v) => total + v.count, 0);
    expect(Math.abs(sum - 5_000_000)).toBeLessThan(10);
    for (const v of result.facets[0].values) expect(Math.abs(v.count - 1_000_000)).toBeLessThan(20_000);
  });

  it("refuses non-facet fields", () => {
    expect(() => facetCounts(small, { collection: "orders", fields: ["total_minor"] })).toThrow("not a facet");
    expect(() => facetCounts(small, { collection: "orders", fields: [] })).toThrow("1-8");
  });
});
