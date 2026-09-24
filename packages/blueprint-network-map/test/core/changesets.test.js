// Changesets (reviewed imports): resolution, decisions, digest binding, dependency handling,
// chunked apply with checkpoints, crash and resume, re-import identity, quotas and undo.
import { describe, expect, it } from "vitest";
import { createNetworkMap } from "../../src/core/network-map.js";
import { createChangesets } from "../../src/core/changesets.js";
import { InMemoryRepository } from "../../src/core/repository.js";

/** @param {any} [limits] */
function setup(limits, repo = new InMemoryRepository()) {
  const map = createNetworkMap(repo, { seedDemo: false, limits });
  return { repo, map, cs: createChangesets(map) };
}

const people = [
  { kind: "type", name: "Person", appliesTo: "element" },
  { kind: "field", name: "Age", fieldKind: "number", appliesTo: "element" },
  { kind: "element", key: "a", label: "Ann", type: "Person", fields: { Age: "41" } },
  { kind: "element", key: "b", label: "Bob", type: "Person", fields: { Age: "not a number" } },
  { kind: "element", key: "c", label: "Cy" },
  { kind: "connection", from: "a", to: "b", label: "knows" },
  { kind: "connection", from: "b", to: "c" },
  { kind: "connection", from: "c", to: "nobody" },
];

async function stage(cs, items, source = "test:people") {
  const m = await cs.createChangeset({ name: "People", source, by: "Ann" });
  await cs.addChangesetItems({ changesetId: m.id, items });
  return cs.finalizeChangeset({ changesetId: m.id });
}

const elements = async (map) => (await map.getMap()).objects.filter((o) => o.id[0] === "e");

describe("changesets", () => {
  it("resolves, applies typed values with provenance and reports what it skipped", async () => {
    const { map, cs } = setup();
    const review = await stage(cs, people);
    expect(review.counts).toMatchObject({ create: 7, invalid: 1 });
    const done = await cs.acceptChangeset({ changesetId: review.id, digest: review.digest, by: "Ann", senderId: "s" });
    expect(done.status).toBe("applied");
    const list = await elements(map);
    const ann = list.find((e) => e.label === "Ann");
    expect(Object.values(ann.fields)).toEqual([41]);
    expect(ann.provenance).toMatchObject({ origin: "import", changesetId: review.id, acceptedBy: "Ann" });
    expect(list.find((e) => e.label === "Bob").fields).toBeUndefined();
    const page = await cs.getChangeset({ changesetId: review.id, filter: "problems" });
    expect(page.items.find((it) => it.data.to === "nobody").problems[0]).toMatch(/No element "nobody"/);
  });

  it("binds acceptance to the reviewed digest and blocks edges of skipped elements", async () => {
    const { map, cs } = setup();
    const review = await stage(cs, people);
    const { changeset } = await cs.setDecisions({ changesetId: review.id, decisions: [{ iid: "i4", action: "skip" }] });
    await expect(cs.acceptChangeset({ changesetId: review.id, digest: review.digest, by: "Ann" })).rejects.toThrow(/changed since you reviewed/);
    expect(changeset.counts.blocked).toBe(1);
    await cs.acceptChangeset({ changesetId: review.id, digest: changeset.digest, by: "Ann" });
    const labels = (await elements(map)).map((e) => e.label).sort();
    expect(labels).toEqual(["Ann", "Bob"]);
    expect((await map.getMap()).objects.filter((o) => o.id[0] === "c").length).toBe(1);
  });

  it("suggests an existing element by label but never merges on a label alone without review", async () => {
    const { map, cs } = setup();
    await map.applyOperation({ senderId: "s", ops: [{ op: "create", object: { id: "e_" + "a".repeat(12), label: "ann" } }] });
    const review = await stage(cs, people);
    const page = await cs.getChangeset({ changesetId: review.id });
    const ann = page.items.find((it) => it.data.label === "Ann");
    expect(ann.action).toBe("use-existing");
    expect(ann.problems[0]).toMatch(/Matches an existing element by label/);
    const { changeset } = await cs.setDecisions({ changesetId: review.id, decisions: [{ iid: ann.iid, action: "create" }] });
    await cs.acceptChangeset({ changesetId: review.id, digest: changeset.digest, by: "Ann" });
    expect((await elements(map)).filter((e) => e.label.toLowerCase() === "ann").length).toBe(2);
  });

  it("re-importing the same source updates instead of duplicating", async () => {
    const { map, cs } = setup();
    const first = await stage(cs, people);
    await cs.acceptChangeset({ changesetId: first.id, digest: first.digest, by: "Ann" });
    const again = await stage(cs, [{ kind: "element", key: "a", label: "Ann Smith" }]);
    const page = await cs.getChangeset({ changesetId: again.id });
    expect(page.items[0].action).toBe("update");
    await cs.acceptChangeset({ changesetId: again.id, digest: again.digest, by: "Ann" });
    const list = await elements(map);
    expect(list.map((e) => e.label).sort()).toEqual(["Ann Smith", "Bob", "Cy"]);
  });

  it("applies in chunks with checkpoints, and resumes after a crash without duplicates", async () => {
    const repo = new InMemoryRepository();
    const items = Array.from({ length: 12 }, (_, i) => ({ kind: "element", key: `k${i}`, label: `N${i}` }));
    for (let i = 0; i + 1 < 12; i++) items.push({ kind: "connection", from: `k${i}`, to: `k${i + 1}` });
    const a = setup({ commitObjects: 5 }, repo);
    const review = await stage(a.cs, items);
    // Fail the third commit of the job (two element batches land first).
    let commits = 0;
    const commit = repo.commit.bind(repo);
    repo.commit = async (c) => { if (c.changesetChunks && ++commits === 3) throw new Error("crash"); return commit(c); };
    await expect(a.cs.acceptChangeset({ changesetId: review.id, digest: review.digest, by: "Ann" })).rejects.toThrow("crash");
    repo.commit = commit;
    // A restarted facet over the same storage.
    const b = setup({ commitObjects: 5 }, repo);
    expect((await b.cs.listChangesets())[0].status).toBe("applying");
    const done = await b.cs.resumeChangeset({ changesetId: review.id, by: "Ann" });
    expect(done.status).toBe("applied");
    const m = await b.map.getMap();
    expect(m.objects.filter((o) => o.id[0] === "e").length).toBe(12);
    expect(m.objects.filter((o) => o.id[0] === "c").length).toBe(11);
    const history = await b.map.getHistory(50);
    expect(history.filter((h) => h.groupId === review.id).length).toBeGreaterThan(3);
    // Undo the whole import.
    const undone = await b.map.undoGroup({ groupId: review.id, senderId: "s", by: "Ann" });
    expect(undone.conflicts).toEqual([]);
    expect((await b.map.getMap()).objects.length).toBe(1); // the default view
  });

  it("keeps staging within its quota and refuses edits after review", async () => {
    const { cs } = setup({ stagingBytes: 2000 });
    const m = await cs.createChangeset({ name: "Big", by: "Ann" });
    await expect(cs.addChangesetItems({ changesetId: m.id, items: Array.from({ length: 50 }, (_, i) => ({ kind: "element", key: `k${i}`, label: "x".repeat(100) })) })).rejects.toThrow(/Staged imports may take/);
    await cs.addChangesetItems({ changesetId: m.id, items: [{ kind: "element", key: "one", label: "One" }] });
    await cs.finalizeChangeset({ changesetId: m.id });
    await expect(cs.addChangesetItems({ changesetId: m.id, items: [] })).rejects.toThrow(/only be added while/);
    const rejected = await cs.rejectChangeset({ changesetId: m.id });
    expect(rejected.status).toBe("rejected");
  });
});
