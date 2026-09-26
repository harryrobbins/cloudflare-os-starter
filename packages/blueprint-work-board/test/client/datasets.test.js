import { describe, expect, it } from "vitest";
import { listDatasets, registerDataset, runDataset } from "../../src/shared/datasets/index.js";
import { buildIndex } from "../../src/shared/model/index.js";
import { FakeRecords } from "../fake-records.js";
import { seedWork } from "../../harness/seed.js";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const fake = new FakeRecords({ now: () => NOW });
seedWork(fake, { items: 60, now: NOW });
const index = buildIndex([...fake.rows.values()], { planning: true, label: "Team work" });
const ctx = { index, viewer: null, now: NOW, today: "2026-09-26" };

describe("datasets", () => {
  it("lists a data dictionary", () => {
    const items = listDatasets().find((d) => d.name === "items");
    expect(items?.columns.map((c) => c.name)).toContain("kind");
  });
  it("runs the items dataset through WQL", () => {
    const all = runDataset("items", ctx);
    expect(all.length).toBe(index.itemList.filter((i) => !i.archived).length);
    const blocked = runDataset("items", ctx, { query: "is:blocked" });
    expect(blocked.every((r) => r.blocked === true)).toBe(true);
    expect(runDataset("items", ctx, { limit: 3 })).toHaveLength(3);
  });
  it("refuses unknown datasets and bad queries with coded errors", () => {
    expect(() => runDataset("nope", ctx)).toThrow(/^not_found:/);
    expect(() => runDataset("items", ctx, { query: "prority:high" })).toThrow(/^invalid_request:/);
  });
  it("lets later work register more datasets", () => {
    registerDataset({ name: "count", description: "Count", columns: [{ name: "n", type: "number", description: "Items" }], rows: (_c, items) => [{ n: items.length }] });
    expect(runDataset("count", ctx, { query: "status:done" })[0].n).toBe(index.itemList.filter((i) => i.category === "done" && !i.archived).length);
  });
});
