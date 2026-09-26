import { describe, expect, it } from "vitest";
import { PEOPLE_LIMITS, createPeople, memoryStorage } from "../../src/server/documents.js";
import { createGadgetApi } from "../../src/server/api.js";
import { FakeRecords } from "../fake-records.js";

const ADA = { id: "ada@example.com", displayName: "Ada Lovelace" };

describe("people document", () => {
  it("learns a viewer's display name under the connector's actor mapping", async () => {
    const people = createPeople(memoryStorage(), { now: () => 1000 });
    const list = await people.rememberViewer(ADA);
    expect(list).toEqual([{ actor: "cloudflare-os:ada@example.com", name: "Ada Lovelace", alias: null, displayName: "Ada Lovelace", seen: 1000 }]);
  });

  it("does not lose names when viewers arrive at the same time", async () => {
    const people = createPeople(memoryStorage());
    await Promise.all(["a", "b", "c", "d", "e"].map((id) => people.rememberViewer({ id: `${id}@x.com`, displayName: id.toUpperCase() })));
    expect((await people.people()).map((p) => p.displayName)).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("aliases any actor and clears the alias", async () => {
    const people = createPeople(memoryStorage());
    await people.rememberViewer(ADA);
    await people.setPersonAlias("records:principal:0a0a", "Import bot");
    let list = await people.setPersonAlias("cloudflare-os:ada@example.com", "Countess");
    expect(list.find((p) => p.actor === "cloudflare-os:ada@example.com")).toMatchObject({ name: "Ada Lovelace", alias: "Countess", displayName: "Countess" });
    expect(list.find((p) => p.actor === "records:principal:0a0a")?.displayName).toBe("Import bot");
    list = await people.setPersonAlias("cloudflare-os:ada@example.com", null);
    expect(list.find((p) => p.actor === "cloudflare-os:ada@example.com")?.displayName).toBe("Ada Lovelace");
  });

  it("validates input", async () => {
    const people = createPeople(memoryStorage());
    await expect(people.rememberViewer({})).rejects.toThrow(/^invalid_request/);
    await expect(people.setPersonAlias("not an actor", "x")).rejects.toThrow(/^invalid_request/);
    await expect(people.setPersonAlias("cloudflare-os:a", "x".repeat(81))).rejects.toThrow(/^invalid_request/);
    const list = await people.rememberViewer({ id: "b@x.com", displayName: "  Bob\u0007 " });
    expect(list[0].name).toBe("Bob");
  });

  it("stays within 500 people, forgetting the longest-unseen without an alias", async () => {
    let t = 0;
    const people = createPeople(memoryStorage(), { now: () => ++t });
    await people.setPersonAlias("records:principal:keep", "Kept");
    for (let i = 0; i < PEOPLE_LIMITS.people + 5; i++) await people.rememberViewer({ id: `p${i}@x.com`, displayName: `P${i}` });
    const list = await people.people();
    expect(list.length).toBe(PEOPLE_LIMITS.people);
    expect(list.some((p) => p.actor === "records:principal:keep")).toBe(true);
    expect(list.some((p) => p.actor === "cloudflare-os:p0@x.com")).toBe(false);
  });

  it("gives the agent's query() display names", async () => {
    const fake = new FakeRecords({ now: () => Date.parse("2026-09-26T12:00:00Z") });
    fake.run("work.create", { title: "Named", assignee: "cloudflare-os:ada@example.com" }, { actor: "cloudflare-os:ada@example.com" });
    const api = createGadgetApi({ getEnv: () => ({ RECORDS: fake.session() }), storage: memoryStorage() });
    expect((await api.query("assignee:Lovelace")).total).toBe(0);
    await api.rememberViewer(ADA);
    api.queries.reset();
    const r = await api.query("assignee:\"Ada Lovelace\"", { fields: ["title", "assignee"] });
    expect(r.items).toEqual([{ key: "TW-1", title: "Named", assignee: "Ada Lovelace" }]);
  });
});
