import { describe, expect, it } from "vitest";
import { aggregate, candidateIds, generateRecord, schemaFor } from "../src/generator.js";
import { makeResourceUrl, parseResourceUrl } from "../src/resource.js";

const dataset = parseResourceUrl("procgen://commerce/v1/demo-4242/small");

describe("synthetic commerce generator", () => {
  it("normalizes and validates dataset resources", () => {
    expect(makeResourceUrl("demo-4242", "small")).toBe(dataset.url);
    expect(() => parseResourceUrl("procgen://commerce/v2/demo/small")).toThrow("version");
    expect(() => parseResourceUrl("procgen://commerce/v1/bad%20seed/small")).toThrow("Seed");
  });

  it("is deterministic and seed-isolated", () => {
    expect(generateRecord(dataset, "customers", 37)).toEqual(generateRecord(dataset, "customers", 37));
    const other = parseResourceUrl("procgen://commerce/v1/another/small");
    expect(generateRecord(other, "customers", 37)).not.toEqual(generateRecord(dataset, "customers", 37));
  });

  it("keeps foreign keys, timestamps, and monetary totals coherent", () => {
    for (const orderId of [1, 2, 999, 10_000]) {
      const order = generateRecord(dataset, "orders", orderId);
      const customer = generateRecord(dataset, "customers", Number(order.customer_id));
      const items = [1, 2, 3].map(offset => generateRecord(dataset, "order_items", (orderId - 1) * 3 + offset));
      expect(Date.parse(order.created_at as string)).toBeGreaterThanOrEqual(Date.parse(customer.created_at as string));
      expect(items.every(item => item.order_id === String(orderId))).toBe(true);
      expect(items.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price_minor), 0)).toBe(order.total_minor);
      expect(items.every(item => Number(item.product_id) <= 500)).toBe(true);
    }
  });

  it("reports finite exact cardinalities and rejects boundary IDs", () => {
    expect(schemaFor(dataset, "events").exactRecords).toBe("50000");
    expect(() => generateRecord(dataset, "events", 50_001)).toThrow("out of range");
  });

  it("plans bounded indexed pages without scanning the collection", () => {
    expect(candidateIds(dataset, "orders", [{ field: "customer_id", operator: "eq", value: "7" }])).toEqual([7, 1007, 2007, 3007, 4007, 5007, 6007, 7007, 8007, 9007]);
    expect(candidateIds(dataset, "events", [{ field: "id", operator: "gte", value: "100" }], 5, 3)).toEqual([105, 106, 107]);
    expect(() => candidateIds(dataset, "orders", [{ field: "status", operator: "eq", value: "paid" }])).toThrow("Unsupported predicate");
  });

  it("returns exact aggregate values", () => {
    const optimized = aggregate(dataset, { collection: "orders", metrics: [
      { name: "count", function: "count" }, { name: "sum", function: "sum", field: "total_minor" },
      { name: "min", function: "min", field: "total_minor" }, { name: "max", function: "max", field: "total_minor" },
    ] });
    let sum = 0, min = Infinity, max = -Infinity;
    for (let id = 1; id <= 10_000; id++) { const value = Number(generateRecord(dataset, "orders", id).total_minor); sum += value; min = Math.min(min, value); max = Math.max(max, value); }
    expect(optimized.groups[0].metrics).toEqual({ count: "10000", sum: String(sum), min, max });
    const grouped = aggregate(dataset, { collection: "orders", metrics: [{ name: "count", function: "count" }], groupBy: ["status"] });
    expect(grouped.groups.map(group => group.metrics.count)).toEqual([2500, 2500, 2500, 2500]);
  });
});
