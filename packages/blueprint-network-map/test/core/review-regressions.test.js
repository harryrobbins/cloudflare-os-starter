// Regressions from the Phase 1 correctness review (2026-09-24): undo ordering and loops, field
// deletion, undo idempotency, stored value sizes, and import batches that are refused, stale or
// match one element twice.
import { describe, expect, it } from "vitest";
import { createNetworkMap } from "../../src/core/network-map.js";
import { createChangesets } from "../../src/core/changesets.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { LIMITS, loopProblem, storedBytes } from "../../src/shared/protocol.js";

const hex = (n) => n.toString(16).padStart(12, "0");
const E = (n) => "e_" + hex(0xe00000 + n);
const C = (n) => "c_" + hex(0xc00000 + n);
const L = (n) => "l_" + hex(0xa00000 + n);
const F = (n) => "f_" + hex(0xf00000 + n);

async function setup(n = 4) {
  const repo = new InMemoryRepository();
  const map = createNetworkMap(repo, { seedDemo: false });
  const ops = [];
  for (let i = 0; i < n; i++) ops.push({ op: "create", object: { id: E(i), label: `E${i}` } });
  await map.applyOperation({ senderId: "s", by: "Setup", ops });
  return { repo, map, cs: createChangesets(map) };
}
const obj = async (map, id) => (await map.getMap()).objects.find((o) => o.id === id);
const apply = (map, by, ops) => map.applyOperation({ senderId: by, by, ops }).then((r) => r.result);

describe("undo", () => {
  it("restores a merge: connections go back to the recreated element", async () => {
    const { map } = await setup();
    await apply(map, "Ann", [{ op: "create", object: { id: C(0), from: E(0), to: E(1) } }]);
    await apply(map, "Ann", [
      { op: "update", id: C(0), baseVersion: 1, patch: { to: E(2) } },
      { op: "delete", id: E(1), baseVersion: 1 },
    ]);
    const u = (await map.undo({ senderId: "Ann", by: "Ann" })).result;
    expect(u.conflicts).toEqual([]);
    expect((await obj(map, C(0))).to).toBe(E(1));
  });

  it("never leaves a loop broken", async () => {
    const { map } = await setup();
    await apply(map, "Ann", [
      { op: "create", object: { id: C(0), from: E(0), to: E(1) } },
      { op: "create", object: { id: C(1), from: E(2), to: E(0) } },
    ]);
    await apply(map, "Ann", [{ op: "update", id: C(0), baseVersion: 1, patch: { to: E(2) } }]);
    // Bob builds a loop over the re-pointed connection; undoing Ann's change would break it.
    await apply(map, "Bob", [{ op: "create", object: { id: L(0), label: "Bob's", steps: [{ c: C(0) }, { c: C(1) }] } }]);
    const u = (await map.undo({ senderId: "Ann", by: "Ann" })).result;
    expect(u.status).toBe("unchanged");
    expect(u.errors.at(-1).message).toMatch(/would break loop "Bob's"/);
    const m = await map.getMap();
    const get = (id) => m.objects.find((o) => o.id === id);
    expect(loopProblem(get(L(0)).steps, get)).toBeNull();
    expect(get(C(0)).to).toBe(E(2));
  });

  it("replays a retried undo instead of refusing it", async () => {
    const { map } = await setup();
    await apply(map, "Ann", [{ op: "update", id: E(0), baseVersion: 1, patch: { label: "X" } }]);
    const first = (await map.undo({ senderId: "Ann", by: "Ann", requestId: "u:1" })).result;
    const retry = (await map.undo({ senderId: "Ann", by: "Ann", requestId: "u:1" })).result;
    expect(first.status).toBe("applied");
    expect(retry).toMatchObject({ duplicate: true, status: "applied", errors: [] });
    expect(retry.revision).toBe(first.revision);
  });

  it("keeps every inverse chunk within the value budget", async () => {
    const repo = new InMemoryRepository();
    const map = createNetworkMap(repo, { seedDemo: false });
    const ops = Array.from({ length: 2000 }, (_, i) => ({ op: "create", object: { id: E(i), label: `E${i}` } }));
    await apply(map, "Ann", ops);
    await apply(map, "Ann", [{ op: "move", layout: "shared", items: ops.map((o, i) => ({ id: o.object.id, x: i, y: -i })) }]);
    await apply(map, "Ann", [{ op: "move", layout: "shared", items: ops.map((o, i) => ({ id: o.object.id, x: -i, y: i, pin: true })) }]);
    for (const [k, v] of repo.kv) expect(storedBytes(v), k).toBeLessThanOrEqual(LIMITS.valueBytes);
  });
});

describe("fields", () => {
  it("deleting a field removes its values; undo brings both back", async () => {
    const { map } = await setup();
    await apply(map, "Ann", [{ op: "create", object: { id: F(0), name: "Score", kind: "number" } }]);
    await apply(map, "Ann", [{ op: "update", id: E(0), baseVersion: 1, patch: { fields: { [F(0)]: 5 } } }]);
    const del = await apply(map, "Ann", [{ op: "delete", id: F(0), baseVersion: 1 }]);
    expect(del.errors).toEqual([]);
    expect((await obj(map, E(0))).fields).toBeUndefined();
    await map.undo({ senderId: "Ann", by: "Ann", historyId: del.history.id });
    expect((await obj(map, E(0))).fields).toEqual({ [F(0)]: 5 });
    // Edits keep working after the delete (no dangling values block them).
    await apply(map, "Ann", [{ op: "delete", id: F(0), baseVersion: 2 }]);
    const e0 = await obj(map, E(0));
    expect((await apply(map, "Ann", [{ op: "update", id: E(0), baseVersion: e0.version, patch: { label: "Still editable" } }])).errors).toEqual([]);
  });

  it("undoing a field's creation is refused while someone else's values use it", async () => {
    const { map } = await setup();
    await apply(map, "Ann", [{ op: "create", object: { id: F(0), name: "Score", kind: "number" } }]);
    await apply(map, "Bob", [{ op: "update", id: E(0), baseVersion: 1, patch: { fields: { [F(0)]: 7 } } }]);
    const u = (await map.undo({ senderId: "Ann", by: "Ann" })).result;
    expect(u.conflicts[0].reason).toBe("field has values added later");
    expect(await obj(map, F(0))).toBeTruthy();
  });
});

describe("import batches", () => {
  const stage = async (cs, items, source = "src") => {
    const m = await cs.createChangeset({ name: "T", source, by: "Ann" });
    await cs.addChangesetItems({ changesetId: m.id, items });
    return cs.finalizeChangeset({ changesetId: m.id });
  };

  it("a batch refused as a whole leaves the other rows pending, and they apply", async () => {
    const { map, cs } = await setup();
    const first = await stage(cs, [
      { kind: "element", key: "a", label: "A" }, { kind: "element", key: "b", label: "B" },
      { kind: "connection", key: "ab", from: "a", to: "b" }, { kind: "connection", key: "ba", from: "b", to: "a" },
    ]);
    await cs.acceptChangeset({ changesetId: first.id, digest: first.digest, by: "Ann" });
    const m = await map.getMap();
    const conn = (key) => m.objects.find((o) => o.externalRefs?.some((r) => r.key === key)).id;
    await apply(map, "Ann", [{ op: "create", object: { id: L(1), label: "L", steps: [{ c: conn("ab") }, { c: conn("ba") }] } }]);
    // Re-import re-points "ab" (breaking the loop) and adds a new connection.
    const second = await stage(cs, [
      { kind: "element", key: "a", label: "A" }, { kind: "element", key: "b", label: "B" }, { kind: "element", key: "c", label: "C" },
      { kind: "connection", key: "ab", from: "a", to: "c" }, { kind: "connection", key: "new", from: "b", to: "c" },
    ]);
    const done = await cs.acceptChangeset({ changesetId: second.id, digest: second.digest, by: "Ann" });
    expect(done.status).toBe("partial");
    const page = await cs.getChangeset({ changesetId: second.id });
    expect(page.items.find((it) => it.data.key === "new").state).toBe("applied");
    expect((await map.getMap()).objects.some((o) => o.externalRefs?.some((r) => r.key === "new"))).toBe(true);
  });

  it("a row whose target changed or vanished after review fails instead of overwriting", async () => {
    const { map, cs } = await setup();
    const review = await stage(cs, [{ kind: "element", key: "k", label: "E0", description: "from import" }, { kind: "element", key: "j", label: "E1" }]);
    await apply(map, "Bob", [{ op: "update", id: E(0), baseVersion: 1, patch: { description: "Bob's" } }, { op: "delete", id: E(1), baseVersion: 1 }]);
    const done = await cs.acceptChangeset({ changesetId: review.id, digest: review.digest, by: "Ann" });
    expect(done.status).toBe("partial");
    expect((await obj(map, E(0))).description).toBe("Bob's");
    const items = (await cs.getChangeset({ changesetId: review.id })).items;
    expect(items.map((it) => it.state)).toEqual(["failed", "failed"]);
  });

  it("two rows matched to one element both leave their reference", async () => {
    const { map, cs } = await setup();
    const review = await stage(cs, [{ kind: "element", key: "k1", label: "E0" }, { kind: "element", key: "k2", label: "e0" }], "crm");
    await cs.acceptChangeset({ changesetId: review.id, digest: review.digest, by: "Ann" });
    expect((await obj(map, E(0))).externalRefs).toEqual([{ sourceId: "crm", key: "k1" }, { sourceId: "crm", key: "k2" }]);
  });
});
