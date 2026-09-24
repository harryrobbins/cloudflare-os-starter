// Core rules over the in-memory repository: validation, cascades, idempotency, conflict-aware
// undo, positions and fencing, budgets, snapshots, and failure handling.
import { describe, expect, it } from "vitest";
import { createNetworkMap, migrate } from "../../src/core/network-map.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { LIMITS, storedBytes } from "../../src/shared/protocol.js";

const hex = (n) => n.toString(16).padStart(12, "0");
const E = (n) => "e_" + hex(0xe00000 + n);
const C = (n) => "c_" + hex(0xc00000 + n);

/** A blank map (no demo) with `n` elements in a chain. */
async function chain(n = 3, opts = {}) {
  const repo = new InMemoryRepository();
  const events = [];
  const map = createNetworkMap(repo, { seedDemo: false, onEvent: (e) => events.push(e), ...opts });
  const ops = [];
  for (let i = 0; i < n; i++) ops.push({ op: "create", object: { id: E(i), label: `E${i}` } });
  for (let i = 0; i + 1 < n; i++) ops.push({ op: "create", object: { id: C(i), from: E(i), to: E(i + 1) } });
  const r = await map.applyOperation({ senderId: "setup", by: "Setup", ops });
  expect(r.result.errors).toEqual([]);
  return { repo, map, events };
}
const get = async (map, id) => (await map.getMap()).objects.find((o) => o.id === id);

describe("validation", () => {
  it("normalises and refuses bad objects with per-op errors", async () => {
    const { map } = await chain(1);
    const { result } = await map.applyOperation({ senderId: "s", ops: [
      { op: "create", object: { id: E(10), label: "  Spaced\tlabel  " } },
      { op: "create", object: { id: E(11), label: "" } },
      { op: "create", object: { id: C(10), from: E(10), to: "e_ffffffffffff" } },
      { op: "create", object: { id: "x_" + hex(1), label: "bad kind" } },
      { op: "update", id: E(0), patch: { label: "no base" } },
      { op: "update", id: E(0), baseVersion: 1, patch: { colour: "red" } },
    ] });
    expect(result.status).toBe("applied");
    expect(result.errors.map((e) => [e.index, e.code])).toEqual([[1, "invalid_op"], [2, "invalid_op"], [3, "invalid_id"], [4, "invalid_op"], [5, "invalid_op"]]);
    expect((await get(map, E(10))).label).toBe("Spaced label");
  });

  it("allows self-links and parallel connections (a multigraph)", async () => {
    const { map } = await chain(2);
    const { result } = await map.applyOperation({ senderId: "s", ops: [
      { op: "create", object: { id: C(20), from: E(0), to: E(0) } },
      { op: "create", object: { id: C(21), from: E(0), to: E(1) } },
    ] });
    expect(result.errors).toEqual([]);
  });

  it("checks field values against their definitions", async () => {
    const { map } = await chain(1);
    const F = "f_" + hex(1);
    await map.applyOperation({ senderId: "s", ops: [{ op: "create", object: { id: F, name: "Size", kind: "choice", choices: ["S", "M"] } }] });
    const bad = await map.applyOperation({ senderId: "s", ops: [{ op: "update", id: E(0), baseVersion: 1, patch: { fields: { [F]: "XL" } } }] });
    expect(bad.result.errors[0].message).toMatch(/Invalid value for field "Size"/);
    const ok = await map.applyOperation({ senderId: "s", ops: [{ op: "update", id: E(0), baseVersion: 1, patch: { fields: { [F]: "M" } } }] });
    expect(ok.result.errors).toEqual([]);
    const refused = await map.applyOperation({ senderId: "s", ops: [{ op: "update", id: F, baseVersion: 1, patch: { choices: ["S"] } }] });
    expect(refused.result.errors[0].code).toBe("in_use");
  });

  it("refuses unsafe URLs and strips control characters", async () => {
    const { map } = await chain(1);
    const F = "f_" + hex(2);
    await map.applyOperation({ senderId: "s", ops: [{ op: "create", object: { id: F, name: "Link", kind: "url" } }] });
    const r = await map.applyOperation({ senderId: "s", ops: [{ op: "update", id: E(0), baseVersion: 1, patch: { fields: { [F]: "javascript:alert(1)" } } }] });
    expect(r.result.errors[0].message).toMatch(/Invalid value/);
    await map.applyOperation({ senderId: "s", ops: [{ op: "update", id: E(0), baseVersion: 1, patch: { label: "A‮B\u0007C" } }] });
    expect((await get(map, E(0))).label).toBe("ABC");
  });
});

describe("cascades", () => {
  it("deleting an element removes its connections, loops using them and focus references", async () => {
    const { map } = await chain(3);
    const L = "l_" + hex(1), V = "v_" + hex(1);
    await map.applyOperation({ senderId: "s", ops: [
      { op: "create", object: { id: C(9), from: E(2), to: E(0) } },
      { op: "create", object: { id: L, label: "Cycle", steps: [{ c: C(0) }, { c: C(1) }, { c: C(9) }] } },
      { op: "create", object: { id: V, name: "Focused", focus: { roots: [E(1), E(0)], depth: 1 } } },
    ] });
    const e1 = await get(map, E(1));
    const { result } = await map.applyOperation({ senderId: "s", ops: [{ op: "delete", id: E(1), baseVersion: e1.version }] });
    expect(result.deletes.sort()).toEqual([C(0), C(1), E(1), L].sort());
    expect((await get(map, V)).focus.roots).toEqual([E(0)]);
  });

  it("refuses to delete a type in use or the default view", async () => {
    const { map } = await chain(1);
    const T = "t_" + hex(1);
    await map.applyOperation({ senderId: "s", ops: [{ op: "create", object: { id: T, name: "Person", appliesTo: "element" } }, { op: "update", id: E(0), baseVersion: 1, patch: { typeId: T } }] });
    const m = await map.getMap();
    const { result } = await map.applyOperation({ senderId: "s", ops: [
      { op: "delete", id: T, baseVersion: 1 },
      { op: "delete", id: m.meta.defaultViewId, baseVersion: 1 },
    ] });
    expect(result.errors.map((e) => e.code)).toEqual(["in_use", "in_use"]);
  });

  it("refuses a connection change that would break a loop", async () => {
    const { map } = await chain(3);
    await map.applyOperation({ senderId: "s", ops: [
      { op: "create", object: { id: C(9), from: E(2), to: E(0) } },
      { op: "create", object: { id: "l_" + hex(1), label: "Cycle", steps: [{ c: C(0) }, { c: C(1) }, { c: C(9) }] } },
    ] });
    const r = await map.applyOperation({ senderId: "s", ops: [{ op: "update", id: C(9), baseVersion: 1, patch: { to: E(1) } }] });
    expect(r.result.errors[0].code).toBe("in_use");
  });

  it("checks loops once per request: re-pointing a whole loop works, a broken result is rolled back entirely", async () => {
    const { map } = await chain(3);
    await map.applyOperation({ senderId: "s", ops: [
      { op: "create", object: { id: E(3), label: "E3" } },
      { op: "create", object: { id: C(9), from: E(2), to: E(0) } },
      { op: "create", object: { id: "l_" + hex(1), label: "Cycle", steps: [{ c: C(0) }, { c: C(1) }, { c: C(9) }] } },
    ] });
    // Merge E(0) into E(3): both ends that touch E(0) move in one request.
    const ok = await map.applyOperation({ senderId: "s", ops: [
      { op: "update", id: C(0), baseVersion: 1, patch: { from: E(3) } },
      { op: "update", id: C(9), baseVersion: 1, patch: { to: E(3) } },
      { op: "delete", id: E(0), baseVersion: 1 },
    ] });
    expect(ok.result.errors).toEqual([]);
    expect(await get(map, "l_" + hex(1))).toBeTruthy();
    // Moving only one end breaks the loop: nothing in the request applies, not even the rename.
    const before = await map.getMap();
    const bad = await map.applyOperation({ senderId: "s", ops: [
      { op: "update", id: E(1), baseVersion: 1, patch: { label: "Renamed" } },
      { op: "update", id: C(1), baseVersion: 1, patch: { to: E(1) } },
    ] });
    expect(bad.result.status).toBe("unchanged");
    expect(bad.result.errors.at(-1).message).toMatch(/Nothing in this request was applied/);
    const sorted = (m) => ({ ...m, objects: [...m.objects].sort((a, b) => a.id.localeCompare(b.id)) });
    expect(sorted(await map.getMap())).toEqual(sorted(before));
  });
});

describe("idempotency", () => {
  it("replays a duplicate and refuses a reused requestId with another payload", async () => {
    const { map, events } = await chain(1);
    const req = { senderId: "s", requestId: "a:1", ops: [{ op: "create", object: { id: E(5), label: "Once" } }] };
    const first = await map.applyOperation(req);
    const again = await map.applyOperation(req);
    expect(again.result).toMatchObject({ duplicate: true, status: "applied" });
    expect(again.result.history?.id).toBe(first.result.history.id);
    const reused = await map.applyOperation({ ...req, ops: [{ op: "create", object: { id: E(6), label: "Other" } }] });
    expect(reused.result.errors[0].code).toBe("request_reused");
    expect(events.length).toBe(2);
    // The same requestId from another sender is a new request.
    const other = await map.applyOperation({ ...req, senderId: "t", ops: [{ op: "create", object: { id: E(7), label: "T" } }] });
    expect(other.result.status).toBe("applied");
  });

  it("drops the cached state when a commit fails and recovers from storage", async () => {
    const { map, repo } = await chain(1);
    repo.failNext = new Error("storage down");
    await expect(map.applyOperation({ senderId: "s", ops: [{ op: "create", object: { id: E(5), label: "Lost" } }] })).rejects.toThrow("storage down");
    expect(await get(map, E(5))).toBeUndefined();
    const ok = await map.applyOperation({ senderId: "s", ops: [{ op: "create", object: { id: E(5), label: "Kept" } }] });
    expect(ok.result.status).toBe("applied");
  });
});

describe("undo", () => {
  it("restores a cascaded delete, including positions", async () => {
    const { map } = await chain(3);
    await map.applyOperation({ senderId: "s", ops: [{ op: "move", layout: "shared", items: [{ id: E(1), x: 5, y: 6, pin: true }] }] });
    const e1 = await get(map, E(1));
    await map.applyOperation({ senderId: "s", by: "Ann", ops: [{ op: "delete", id: E(1), baseVersion: e1.version }] });
    const u = await map.undo({ senderId: "s", by: "Ann" });
    expect(u.result.conflicts).toEqual([]);
    const m = await map.getMap();
    expect(m.objects.filter((o) => o.id[0] === "c").length).toBe(2);
    const shared = m.positions.find((p) => p.layout === "shared");
    const i = shared.ids.indexOf(E(1));
    expect([shared.x[i], shared.y[i], shared.pin[i]]).toEqual([5, 6, "1"]);
  });

  it("keeps later edits and later connections (conflict-aware)", async () => {
    const { map } = await chain(1);
    await map.applyOperation({ senderId: "a", by: "Ann", ops: [{ op: "create", object: { id: E(5), label: "Ann's" } }, { op: "create", object: { id: E(6), label: "Ann's too" } }] });
    await map.applyOperation({ senderId: "b", by: "Bob", ops: [
      { op: "update", id: E(5), baseVersion: 1, patch: { label: "Bob renamed" } },
      { op: "create", object: { id: C(5), from: E(0), to: E(6) } },
    ] });
    const u = await map.undo({ senderId: "a", by: "Ann" });
    expect(u.result.conflicts.map((c) => [c.id, c.reason]).sort()).toEqual([[E(5), "changed since"], [E(6), "has connections added later"]]);
    expect((await get(map, E(5))).label).toBe("Bob renamed");
  });

  it("redo is undoing the undo", async () => {
    const { map } = await chain(1);
    await map.applyOperation({ senderId: "a", by: "Ann", ops: [{ op: "update", id: E(0), baseVersion: 1, patch: { label: "Renamed" } }] });
    const u = await map.undo({ senderId: "a", by: "Ann" });
    expect((await get(map, E(0))).label).toBe("E0");
    await map.undo({ senderId: "a", by: "Ann", historyId: u.result.history.id });
    expect((await get(map, E(0))).label).toBe("Renamed");
  });

  it("evicts the oldest undo data when the quota is full", async () => {
    const { map } = await chain(1, { limits: { inverseBytes: 4000 } });
    for (let i = 0; i < 20; i++) await map.applyOperation({ senderId: "a", by: "Ann", ops: [{ op: "update", id: E(0), baseVersion: i + 1, patch: { description: "x".repeat(200) + i } }] });
    const history = await map.getHistory(50);
    expect(history.some((h) => h.evicted)).toBe(true);
    const oldest = history.at(-1);
    const r = await map.undo({ senderId: "a", by: "Ann", historyId: oldest.id });
    expect(r.result.errors[0].code).toMatch(/not_undoable/);
  });
});

describe("positions", () => {
  it("fences layout commits with position versions", async () => {
    const { map } = await chain(2);
    await map.applyOperation({ senderId: "s", ops: [{ op: "move", layout: "shared", items: [{ id: E(0), x: 0, y: 0 }, { id: E(1), x: 1, y: 1 }] }] });
    // Someone drags E(0) while a layout job (which saw v=1) runs.
    await map.applyOperation({ senderId: "t", ops: [{ op: "move", layout: "shared", items: [{ id: E(0), x: 99, y: 99, pin: true }] }] });
    const job = await map.applyOperation({ senderId: "s", ops: [{ op: "move", layout: "shared", items: [{ id: E(0), x: 5, y: 5, base: 1 }, { id: E(1), x: 6, y: 6, base: 1 }] }] });
    expect(job.result.conflicts.map((c) => c.id)).toEqual([E(0)]);
    const shared = (await map.getMap()).positions.find((p) => p.layout === "shared");
    expect(shared.x[shared.ids.indexOf(E(0))]).toBe(99);
    expect(shared.x[shared.ids.indexOf(E(1))]).toBe(6);
  });

  it("keeps own-layout positions per view and refuses moves into a shared-layout view", async () => {
    const { map } = await chain(1);
    const V = "v_" + hex(9), W = "v_" + hex(10);
    await map.applyOperation({ senderId: "s", ops: [{ op: "create", object: { id: V, name: "Own", layout: { kind: "manual", own: true } } }, { op: "create", object: { id: W, name: "Shared" } }] });
    const r = await map.applyOperation({ senderId: "s", ops: [
      { op: "move", layout: V, items: [{ id: E(0), x: 1, y: 2 }] },
      { op: "move", layout: W, items: [{ id: E(0), x: 1, y: 2 }] },
    ] });
    expect(r.result.errors.map((e) => e.index)).toEqual([1]);
    expect((await map.getMap()).positions.map((p) => p.layout)).toEqual([V]);
  });
});

describe("budgets", () => {
  it("refuses objects over the byte caps with maximum-length content", async () => {
    const { map } = await chain(1);
    const huge = "界".repeat(LIMITS.description);
    const r = await map.applyOperation({ senderId: "s", ops: [{ op: "update", id: E(0), baseVersion: 1, patch: { description: huge, tags: Array.from({ length: 40 }, (_, i) => `${i}-` + "t".repeat(60)) } }] });
    // 20,000 CJK characters are ~60 KB of UTF-8 but 40 KB in V8 (two bytes each): under the 64 KiB cap.
    expect(r.result.errors).toEqual([]);
    const e = await get(map, E(0));
    expect(e.tags.length).toBe(LIMITS.tags);
    expect(storedBytes(e)).toBeLessThanOrEqual(LIMITS.objectBytes);
    const map2 = (await chain(1, { limits: { objectsBytes: 2000 } })).map;
    const r2 = await map2.applyOperation({ senderId: "s", ops: [{ op: "create", object: { id: E(9), label: "x", description: "y".repeat(3000) } }] });
    expect(r2.result.errors[0].message).toMatch(/The map is full/);
  });

  it("bounds counts per kind", async () => {
    const { map } = await chain(1, { limits: { elements: 2 } });
    const r = await map.applyOperation({ senderId: "s", ops: [{ op: "create", object: { id: E(1), label: "ok" } }, { op: "create", object: { id: E(2), label: "too many" } }] });
    expect(r.result.errors.map((e) => e.code)).toEqual(["limit"]);
  });
});

describe("snapshots", () => {
  it("pages by bytes at one revision and expires tokens", async () => {
    let t = 1000;
    const { map } = await chain(30, { limits: { snapshotPageBytes: 800 }, now: () => t });
    const first = await map.openSnapshot();
    await map.applyOperation({ senderId: "s", ops: [{ op: "create", object: { id: E(99), label: "after" } }] });
    const objects = [...first.objects];
    let next = first.next, pages = 1;
    while (next !== null) { const p = await map.snapshotPage(first.token, next); objects.push(...p.objects); next = p.next; pages++; }
    expect(pages).toBeGreaterThan(3);
    expect(objects.some((o) => o.id === E(99))).toBe(false);
    t += LIMITS.snapshotTokenMs + 1;
    expect(await map.snapshotPage(first.token, 0)).toEqual({ expired: true });
  });
});

describe("migrate", () => {
  it("repairs meta and refuses a newer schema", () => {
    expect(migrate({ revision: -1 })).toMatchObject({ revision: 0, schemaVersion: 1, title: "Untitled map" });
    expect(() => migrate({ schemaVersion: 99 })).toThrow(/newer version/);
  });
});
