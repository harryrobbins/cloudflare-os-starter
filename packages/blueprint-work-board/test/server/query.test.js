import { beforeAll, describe, expect, it } from "vitest";
import { createGadgetApi } from "../../src/server/api.js";
import { memoryStorage } from "../../src/server/documents.js";
import { FakeRecords } from "../fake-records.js";
import { seedWork } from "../../harness/seed.js";

const NOW = Date.parse("2026-09-26T12:00:00Z");

function setup({ ttlMs = 5000 } = {}) {
  const fake = new FakeRecords({ now: () => NOW });
  seedWork(fake, { items: 120, now: NOW });
  let t = NOW;
  const api = createGadgetApi({ getEnv: () => ({ RECORDS: fake.session() }), storage: memoryStorage(), now: () => t, ttlMs });
  const count = (/** @type {string} */ name) => fake.calls.filter((c) => c[0] === name).length;
  return { fake, api, count, tick: (/** @type {number} */ ms) => { t += ms; } };
}

/** @type {ReturnType<typeof setup>} */
let s;
beforeAll(() => { s = setup(); });

describe("query()", () => {
  it("returns the same items the WQL filter selects, with defaults", async () => {
    const all = await s.api.query("");
    expect(all.total).toBeGreaterThan(50);
    expect(all.items.length).toBeLessThanOrEqual(50);
    expect(all.truncated).toBe(all.total > 50);
    expect(all.description).toBe("All items");
    expect(all.items[0].key).toMatch(/^TW-\d+$/);
    expect(all.items[0]).not.toHaveProperty("description");
    expect(all.items[0]).toHaveProperty("state");
    expect(all.items[0]).toHaveProperty("status");
  });
  it("filters and describes", async () => {
    const r = await s.api.query("status:done", { limit: 500 });
    expect(r.items.every((i) => i.status === "done")).toBe(true);
    expect(r.query).toBe("status:done");
    expect(r.description.toLowerCase()).toContain("done");
    expect(r.truncated).toBe(false);
  });
  it("limit is clamped to 1–500", async () => {
    expect((await s.api.query("", { limit: 3 })).items).toHaveLength(3);
    expect((await s.api.query("", { limit: 0 })).items.length).toBe(50);
    expect((await s.api.query("", { limit: 10_000 })).items.length).toBeLessThanOrEqual(500);
  });
  it("selects fields", async () => {
    const r = await s.api.query("", { limit: 2, fields: ["title", "priority"] });
    expect(Object.keys(r.items[0]).sort()).toEqual(["key", "priority", "title"]);
  });
  it("viewer makes `me` work", async () => {
    const r = await s.api.query("assignee:me", { viewer: "cloudflare-os:ada@example.com", limit: 500, fields: ["assignee"] });
    expect(r.total).toBeGreaterThan(0);
    expect(new Set(r.items.map((i) => i.assignee)).size).toBe(1);
    expect((await s.api.query("assignee:me")).total).toBe(0);
  });
  it("syntax errors come back as invalid_request with position and suggestion", async () => {
    await expect(s.api.query("prority:high")).rejects.toThrow(/^invalid_request: .*at character 1.*Did you mean “priority”/);
    await expect(s.api.query("(status:done")).rejects.toThrow(/^invalid_request/);
  });
  it("unknown states are refused by check()", async () => {
    await expect(s.api.query("state:Reviw")).rejects.toThrow(/^invalid_request/);
  });
  it("validates input", async () => {
    await expect(s.api.query(/** @type {any} */ (5))).rejects.toThrow(/^invalid_request/);
    await expect(s.api.query("x".repeat(2001))).rejects.toThrow(/2,000/);
  });
  it("is:blocked agrees with blocked_by", async () => {
    const r = await s.api.query("is:blocked", { limit: 500, fields: ["blocked_by"] });
    expect(r.total).toBeGreaterThan(0);
    expect(r.items.every((i) => Array.isArray(i.blocked_by) && i.blocked_by.length > 0)).toBe(true);
  });
});

describe("describeQuery()", () => {
  it("returns canonical text, a description and no errors for valid input", async () => {
    const r = await s.api.describeQuery("Priority:<=high  label:bug");
    expect(r.query).toBe("priority:<=high label:bug");
    expect(r.errors).toEqual([]);
    expect(r.description.length).toBeGreaterThan(10);
  });
  it("reports errors instead of throwing", async () => {
    const r = await s.api.describeQuery("prority:1");
    expect(r.errors[0].suggestions).toContain("priority");
  });
  it("needs text", async () => { await expect(s.api.describeQuery(/** @type {any} */ (null))).rejects.toThrow(/^invalid_request/); });
});

describe("item()", () => {
  it("returns one item with sub-issues, relations and comments", async () => {
    const ix = await s.api.queries.index();
    const parent = ix.itemList.find((i) => (ix.children.get(i.id)?.length ?? 0) > 0 && i.number);
    const r = await s.api.item(parent.key);
    expect(r.key).toBe(parent.key);
    expect(r.sub_issues.length).toBe(ix.children.get(parent.id).length);
    expect(r.progress.total).toBeGreaterThan(0);
    expect(r).toHaveProperty("description");
    const blocked = ix.itemList.find((i) => ix.blockedBy.has(i.id));
    const b = await s.api.item(String(blocked.number));
    expect(b.blocked_by_all.length).toBeGreaterThan(0);
    const commented = ix.itemList.find((i) => (ix.comments.get(i.id)?.length ?? 0) > 0);
    const c = await s.api.item(commented.key);
    expect(c.comments[0]).toHaveProperty("body");
  });
  it("errors", async () => {
    await expect(s.api.item("TW-99999")).rejects.toThrow(/^not_found/);
    await expect(s.api.item("")).rejects.toThrow(/^invalid_request/);
  });
});

describe("vocabulary()", () => {
  it("lists states, labels, projects, cycles and people", async () => {
    const v = await s.api.vocabulary();
    expect(v.keyPrefix).toBe("TW");
    expect(v.planning).toBe(true);
    expect(v.states.map((x) => x.key)).toContain("canceled");
    expect(v.states.find((x) => x.key === "in_review").wip_limit).toBe(5);
    expect(v.labels.length).toBeGreaterThan(3);
    expect(v.projects.length).toBe(5);
    expect(v.cycles.length).toBe(6);
    expect(v.people.length).toBeGreaterThan(3);
    expect(v.items).toBeGreaterThan(100);
  });
  it("uses the board's key prefix setting", async () => {
    const x = setup();
    await x.api.saveSettings({ keyPrefix: "OPS" });
    expect((await x.api.vocabulary()).keyPrefix).toBe("OPS");
    expect((await x.api.query("", { limit: 1 })).items[0].key).toMatch(/^OPS-/);
  });
});

describe("caching", () => {
  it("snapshots once, pulls at most every TTL, and sees writes after a pull", async () => {
    const x = setup({ ttlMs: 5000 });
    await x.api.query("");
    await x.api.query("status:done");
    await x.api.vocabulary();
    expect(x.count("snapshot")).toBe(1);
    expect(x.count("changes")).toBe(0);
    const before = (await x.api.query("text:\"Brand new thing\"")).total;
    expect(before).toBe(0);
    x.fake.run("work.create", { title: "Brand new thing" }, { actor: "cloudflare-os:ada@example.com" });
    expect((await x.api.query("text:\"Brand new thing\"")).total).toBe(0);
    x.tick(5001);
    expect((await x.api.query("text:\"Brand new thing\"")).total).toBe(1);
    expect(x.count("changes")).toBe(1);
    expect(x.count("snapshot")).toBe(1);
  });
  it("concurrent reads share one sync", async () => {
    const x = setup();
    await Promise.all([x.api.query(""), x.api.query(""), x.api.vocabulary()]);
    expect(x.count("snapshot")).toBe(1);
  });
  it("reset() forgets the cache", async () => {
    const x = setup();
    await x.api.query("");
    x.api.queries.reset();
    await x.api.query("");
    expect(x.count("snapshot")).toBe(2);
  });
});
