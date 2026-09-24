import { describe, expect, it } from "vitest";
import { InMemoryRepository, VoteService, loadState } from "../../src/core/store.js";
import { Vote, emptyState, shuffledFor } from "../../src/core/vote.js";

const alice = { id: "alice@x", name: "Alice" };
const bob = { id: "bob@x", name: "Bob" };
const cara = { id: "cara@x", name: "Cara" };

function setup() {
  const repo = new InMemoryRepository();
  let t = 1000;
  const svc = new VoteService(repo, { now: () => t++, random: () => 0 });
  return { repo, svc };
}

/** @param {VoteService} svc @param {any} by @param {string} title */
async function add(svc, by, title, values) {
  const r = await svc.write("addOption", { by, title, values });
  if (r.error) throw new Error(r.error);
  return r.option.id;
}

describe("vote rules", () => {
  it("runs the whole flow: propose, rank, reveal, count, reopen", async () => {
    const { svc, repo } = setup();
    const a = await add(svc, alice, "Hoarse", { description: "husky voice" });
    const b = await add(svc, bob, "Lumen");
    const c = await add(svc, cara, "Tessel");
    expect((await svc.write("saveRanking", { by: alice, ranking: [a, b, c] })).error).toBeUndefined();
    await svc.write("saveRanking", { by: bob, ranking: [b, a, c] });
    await svc.write("saveRanking", { by: cara, ranking: [a, c, b] });
    await svc.write("setReady", { by: alice, ready: true });
    await svc.write("setReady", { by: bob, ready: true });
    let v = await svc.view(alice.id);
    expect(v.phase).toBe("open");
    expect(v.voters.map((x) => [x.name, x.ready])).toEqual([["Alice", true], ["Bob", true], ["Cara", false]]);
    await svc.write("setReady", { by: cara, ready: true });
    v = await svc.view(bob.id);
    expect(v.phase).toBe("closed");
    expect(v.results[0].winner).toBe(a);
    expect(v.results[0].options[a]).toBe("Hoarse");
    expect(v.mine.ranking).toEqual([b, a, c]);

    // Persisted: a fresh service over the same storage sees the same thing.
    const again = new VoteService(repo);
    expect((await again.view(bob.id)).results[0].winner).toBe(a);

    expect((await svc.write("addOption", { by: alice, title: "Late" })).error).toMatch(/reopen/);
    await svc.write("reopen", { by: bob });
    v = await svc.view(alice.id);
    expect(v.phase).toBe("open");
    expect(v.voters.every((x) => !x.ready)).toBe(true);
    expect(v.mine.ranking).toEqual([a, b, c]);
    expect(v.results).toHaveLength(1);
  });

  it("never sends anyone else's ballot", async () => {
    const { svc } = setup();
    const a = await add(svc, alice, "One");
    const b = await add(svc, alice, "Two");
    await svc.write("saveRanking", { by: bob, ranking: [b, a] });
    const v = await svc.view(alice.id);
    expect(v.mine).toBe(null);
    expect(JSON.stringify(v)).not.toContain(`"ranking"`);
    expect(v.voters).toEqual([{ id: bob.id, name: "Bob", ready: false }]);
    expect(await svc.markdown()).not.toMatch(/ranking/i);
  });

  it("appends a new option to every ballot, marks it new and clears readiness", async () => {
    const { svc } = setup();
    const a = await add(svc, alice, "One");
    const b = await add(svc, alice, "Two");
    await svc.write("setReady", { by: bob, ready: true, ranking: [b, a] });
    await svc.write("saveRanking", { by: alice, ranking: [a, b] });
    const c = await add(svc, alice, "Three");
    const vb = await svc.view(bob.id);
    expect(vb.mine).toEqual({ ranking: [b, a, c], unseen: [c], ready: false });
    expect((await svc.view(alice.id)).mine.unseen).toEqual([]);
    expect((await svc.write("setReady", { by: bob, ready: true })).error).toMatch(/new options/);
    // Revealing with the order on screen confirms it.
    await svc.write("setReady", { by: bob, ready: true, ranking: [c, b, a] });
    expect((await svc.view(bob.id)).mine).toEqual({ ranking: [c, b, a], unseen: [], ready: true });
  });

  it("refuses duplicates, incomplete rankings and edits while ready", async () => {
    const { svc } = setup();
    const a = await add(svc, alice, "Hoarse");
    expect((await svc.write("addOption", { by: bob, title: "  hoarse " })).error).toMatch(/already/);
    const b = await add(svc, bob, "Lumen");
    expect((await svc.write("saveRanking", { by: bob, ranking: [a] })).error).toMatch(/changed/);
    expect((await svc.write("saveRanking", { by: bob, ranking: [a, a] })).error).toMatch(/changed/);
    await svc.write("setReady", { by: bob, ready: true, ranking: [a, b] });
    expect((await svc.write("saveRanking", { by: bob, ranking: [b, a] })).error).toMatch(/Undo Reveal/);
    expect((await svc.write("setReady", { by: alice, ready: true })).error).toMatch(/order first/);
  });

  it("lets only the proposer rename or withdraw, and anyone fill fields", async () => {
    const { svc } = setup();
    const a = await add(svc, alice, "Hoarse");
    const b = await add(svc, alice, "Lumen");
    const f = await svc.write("addField", { by: bob, label: "Proposed URL", kind: "url" });
    expect(f.field).toMatchObject({ label: "Proposed URL", kind: "url" });
    expect((await svc.write("addField", { by: bob, label: "proposed url" })).error).toMatch(/already/);
    await svc.write("updateOption", { by: bob, optionId: a, values: { [f.field.id]: "hoarse.co.uk", nope: "x" } });
    let o = (await svc.view(bob.id)).options.find((x) => x.id === a);
    expect(o.values).toEqual({ [f.field.id]: "hoarse.co.uk" });
    expect(o.editedBy).toEqual(bob);
    expect((await svc.write("updateOption", { by: bob, optionId: a, title: "Horse" })).error).toMatch(/Only Alice/);
    expect((await svc.write("withdrawOption", { by: bob, optionId: a })).error).toMatch(/Only Alice/);

    await svc.write("setReady", { by: bob, ready: true, ranking: [a, b] });
    await svc.write("updateOption", { by: alice, optionId: a, title: "Horse" });
    const vb = await svc.view(bob.id);
    expect(vb.mine).toEqual({ ranking: [b, a], unseen: [a], ready: false });
    expect((await svc.view(alice.id)).mine).toBe(null);

    await svc.write("removeField", { by: cara, fieldId: f.field.id });
    o = (await svc.view(bob.id)).options.find((x) => x.id === a);
    expect(o.values).toEqual({});
    expect((await svc.write("removeField", { by: cara, fieldId: "description" })).error).toMatch(/cannot/);

    await svc.write("withdrawOption", { by: alice, optionId: a });
    expect((await svc.view(bob.id)).mine.ranking).toEqual([b]);
  });

  it("waits for the minimum number of voters", async () => {
    const { svc } = setup();
    const a = await add(svc, alice, "One");
    const b = await add(svc, alice, "Two");
    await svc.write("setReady", { by: alice, ready: true, ranking: [a, b] });
    let v = await svc.view(alice.id);
    expect(v.phase).toBe("open");
    expect(v.activity[0].text).toBe("clicked Reveal (needs 1 more voter)");
    await svc.write("setMinVoters", { by: bob, minVoters: 3 });
    await svc.write("setReady", { by: bob, ready: true, ranking: [b, a] });
    expect((await svc.view(alice.id)).phase).toBe("open");
    expect((await svc.write("setMinVoters", { by: bob, minVoters: 0 })).error).toMatch(/between/);
    await svc.write("setMinVoters", { by: bob, minVoters: 2 });
    v = await svc.view(alice.id);
    expect(v.phase).toBe("closed");
    expect(v.minVoters).toBe(2);
  });

  it("removing the last unready ballot runs the count", async () => {
    const { svc } = setup();
    const a = await add(svc, alice, "One");
    const b = await add(svc, alice, "Two");
    await svc.write("saveRanking", { by: bob, ranking: [b, a] });
    await svc.write("setReady", { by: alice, ready: true, ranking: [a, b] });
    await svc.write("setReady", { by: cara, ready: true, ranking: [a, b] });
    expect((await svc.write("removeBallot", { by: bob, voterId: alice.id })).error).toMatch(/ready/);
    await svc.write("removeBallot", { by: alice, voterId: bob.id });
    const v = await svc.view(alice.id);
    expect(v.phase).toBe("closed");
    expect(v.results[0]).toMatchObject({ winner: a, ballots: 2, voters: ["Alice", "Cara"] });
    expect(v.activity[0].text).toMatch(/removed Bob’s ballot; everyone left is ready/);
  });

  it("pushes each subscriber its own view and drops broken ones", async () => {
    const { svc } = setup();
    const got = { alice: [], bob: [] };
    await svc.subscribe({ update: (v) => got.alice.push(v) }, { clientId: "c1", voterId: alice.id });
    await svc.subscribe({ update: (v) => got.bob.push(v) }, { clientId: "c2", voterId: bob.id });
    let disposed = 0;
    await svc.subscribe({ update: () => Promise.reject(new Error("gone")), [Symbol.dispose]: () => { disposed++; } }, { clientId: "c3", voterId: cara.id });
    const a = await add(svc, alice, "One");
    const b = await add(svc, alice, "Two");
    await svc.write("saveRanking", { by: bob, ranking: [b, a] });
    await new Promise((r) => setTimeout(r, 0));
    expect(got.bob.at(-1).mine.ranking).toEqual([b, a]);
    expect(got.alice.at(-1).mine).toBe(null);
    expect(disposed).toBe(1);
    expect((await svc.ping("c3", cara.id)).subscribed).toBe(false);
    expect((await svc.ping("c1", alice.id)).subscribed).toBe(true);
  });

  it("suggests a stable, per-voter shuffle", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    expect(shuffledFor(ids, "alice")).toEqual(shuffledFor(ids, "alice"));
    expect(shuffledFor(ids, "alice").toSorted()).toEqual(ids);
    expect(shuffledFor(ids, "alice")).not.toEqual(shuffledFor(ids, "bob"));
  });

  it("loads an empty repository as a fresh vote", async () => {
    const s = await loadState(new InMemoryRepository());
    expect(s.meta).toEqual(emptyState().meta);
    expect(new Vote(s).viewFor("x").fields.map((f) => f.label)).toEqual(["Description"]);
  });
});
