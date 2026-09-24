import { describe, it, expect } from "vitest";
import {
  bulkOps, chunk, compareCells, deleteOps, formatFieldValue, groupConnections, mergeOps, orderLoop,
  parseAliases, parseChoices, parseFieldInput, parseTags, planMerge, searchElements, sortRows,
} from "../../src/client/ui/profile-logic.js";
import { LIMITS, loopProblem } from "../../src/shared/protocol.js";
import { buildGraphIndex } from "../../src/shared/rules.js";

const E = (n) => `e_${String(n).padStart(12, "0")}`;
const C = (n) => `c_${String(n).padStart(12, "0")}`;
const L = (n) => `l_${String(n).padStart(12, "0")}`;
const F = (n) => `f_${String(n).padStart(12, "0")}`;

/** A small map: elements 1..n, connections given as [from, to, direction?]. */
function graph(n, links, extra = []) {
  const objects = [];
  for (let i = 1; i <= n; i++) objects.push({ id: E(i), label: `E${i}`, version: 1 });
  links.forEach(([a, b, direction = "directed"], i) => objects.push({ id: C(i + 1), from: E(a), to: E(b), direction, version: 1 }));
  objects.push(...extra);
  const byId = new Map(objects.map((o) => [o.id, o]));
  return { objects, byId, get: (id) => byId.get(id) };
}

describe("text inputs", () => {
  it("parses tags: trimmed, distinct ignoring case, empty parts dropped", () => {
    expect(parseTags(" a, b ,A,, c ")).toEqual(["a", "b", "c"]);
    expect(parseTags("")).toEqual([]);
  });
  it("clamps tag count and length", () => {
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`).join(",");
    expect(parseTags(many)).toHaveLength(LIMITS.tags);
    expect(parseTags("x".repeat(100))[0]).toHaveLength(LIMITS.tag);
    expect(parseAliases(Array.from({ length: 30 }, (_, i) => `a${i}`).join(","))).toHaveLength(LIMITS.aliases);
  });
  it("parses choices by line or comma", () => {
    expect(parseChoices("Low\nMedium, High\n\nlow")).toEqual(["Low", "Medium", "High"]);
  });
});

describe("parseFieldInput", () => {
  const def = (kind, choices) => ({ id: F(1), name: "Field", kind, appliesTo: "element", choices });
  it("clears on empty input", () => {
    for (const kind of ["text", "number", "date", "url", "choice"]) expect(parseFieldInput(def(kind, ["a"]), "  ")).toEqual({ value: null });
    expect(parseFieldInput(def("multichoice", ["a"]), [])).toEqual({ value: null });
    expect(parseFieldInput(def("bool"), false)).toEqual({ value: null });
    expect(parseFieldInput(def("daterange"), { from: "", to: "" })).toEqual({ value: null });
  });
  it("converts and validates per kind", () => {
    expect(parseFieldInput(def("number"), "4.5")).toEqual({ value: 4.5 });
    expect(parseFieldInput(def("number"), "x")).toHaveProperty("error");
    expect(parseFieldInput(def("date"), "2024-02-30")).toHaveProperty("error");
    expect(parseFieldInput(def("date"), "2024-02-29")).toEqual({ value: "2024-02-29" });
    expect(parseFieldInput(def("daterange"), { from: "2024-01-01", to: "" })).toEqual({ value: { from: "2024-01-01", to: null } });
    expect(parseFieldInput(def("daterange"), { from: "2024-03-01", to: "2024-01-01" })).toHaveProperty("error");
    expect(parseFieldInput(def("bool"), true)).toEqual({ value: true });
    expect(parseFieldInput(def("choice", ["a", "b"]), "b")).toEqual({ value: "b" });
    expect(parseFieldInput(def("choice", ["a", "b"]), "z")).toHaveProperty("error");
    expect(parseFieldInput(def("multichoice", ["a", "b"]), ["b", "a"])).toEqual({ value: ["b", "a"] });
    expect(parseFieldInput(def("url"), "javascript:alert(1)")).toHaveProperty("error");
    expect(parseFieldInput(def("url"), "https://example.org/x")).toEqual({ value: "https://example.org/x" });
    expect(parseFieldInput(def("longtext"), "a\nb")).toEqual({ value: "a\nb" });
  });
  it("formats values for display", () => {
    expect(formatFieldValue(def("multichoice"), ["a", "b"])).toBe("a, b");
    expect(formatFieldValue(def("bool"), false)).toBe("No");
    expect(formatFieldValue(def("daterange"), { from: "2024-01-01", to: null })).toBe("2024-01-01 – …");
    expect(formatFieldValue(def("number"), undefined)).toBe("");
    expect(formatFieldValue(def("number"), 0)).toBe("0");
  });
});

describe("op building", () => {
  it("bulk ops skip elements the action would not change", () => {
    const els = [
      { id: E(1), typeId: "t_000000000001", tags: ["x"], fields: { [F(1)]: 3 } },
      { id: E(2), tags: ["X"] },
      { id: E(3) },
      { id: C(1) },
    ];
    expect(bulkOps(els, { kind: "type", typeId: "t_000000000001" }).map((o) => o.id)).toEqual([E(2), E(3)]);
    expect(bulkOps(els, { kind: "type", typeId: null }).map((o) => o.id)).toEqual([E(1)]);
    const tagOps = bulkOps(els, { kind: "tag", tag: "x" });
    expect(tagOps).toEqual([{ op: "update", id: E(3), patch: { tags: ["x"] } }]);
    expect(bulkOps(els, { kind: "field", fieldId: F(1), value: 3 }).map((o) => o.id)).toEqual([E(2), E(3)]);
    expect(bulkOps(els, { kind: "field", fieldId: F(1), value: null })).toEqual([{ op: "update", id: E(1), patch: { fields: { [F(1)]: null } } }]);
  });
  it("chunks at most 1000 ops per call by default", () => {
    const parts = chunk(Array.from({ length: 2500 }, (_, i) => i));
    expect(parts.map((p) => p.length)).toEqual([1000, 1000, 500]);
  });
  it("delete ops: loops, then connections, then elements; cascaded connections skipped", () => {
    const g = graph(3, [[1, 2], [2, 3]], [{ id: L(1), steps: [] }]);
    const ops = deleteOps([E(1), C(1), C(2), L(1), "t_000000000001"], g.get);
    expect(ops).toEqual([{ op: "delete", id: L(1) }, { op: "delete", id: C(2) }, { op: "delete", id: E(1) }]);
  });
});

describe("groupConnections and searchElements", () => {
  it("groups by direction relative to the element", () => {
    const g = graph(4, [[1, 2], [3, 1], [1, 4, "mutual"], [1, 1]]);
    const idx = buildGraphIndex(g.objects);
    const groups = groupConnections(E(1), idx.adjacency.get(E(1)), g.get);
    expect(groups.outgoing.map((x) => x.other)).toEqual([E(2), E(1)]);
    expect(groups.incoming.map((x) => x.other)).toEqual([E(3)]);
    expect(groups.undirected.map((x) => x.other)).toEqual([E(4)]);
  });
  it("finds elements by label or alias, exact matches first", () => {
    const els = [{ id: E(1), label: "Farm income" }, { id: E(2), label: "Farm" }, { id: E(3), label: "Market", aliases: ["farmers' market"] }];
    expect(searchElements(els, "farm").map((e) => e.id)).toEqual([E(2), E(1), E(3)]);
    expect(searchElements(els, "farm", { exclude: new Set([E(2)]), limit: 1 }).map((e) => e.id)).toEqual([E(1)]);
    expect(searchElements(els, "  ")).toEqual([]);
  });
});

describe("orderLoop", () => {
  it("orders a shuffled directed triangle into a valid traversal", () => {
    const g = graph(3, [[1, 2], [2, 3], [3, 1]]);
    const r = orderLoop([C(3), C(1), C(2)], g.get);
    expect(r).toHaveProperty("steps");
    expect(loopProblem(r.steps, g.get)).toBeNull();
    expect(r.steps.every((s) => s.fwd)).toBe(true);
  });
  it("walks undirected connections backwards when needed", () => {
    const g = graph(3, [[1, 2], [3, 2, "undirected"], [3, 1]]);
    const r = orderLoop([C(1), C(2), C(3)], g.get);
    expect(loopProblem(r.steps, g.get)).toBeNull();
    expect(r.steps.find((s) => s.c === C(2)).fwd).toBe(false);
  });
  it("explains a cycle against a directed connection", () => {
    const g = graph(3, [[1, 2], [3, 2], [3, 1]]);
    expect(orderLoop([C(1), C(2), C(3)], g.get).error).toMatch(/point against/);
  });
  it("refuses an open path, non-connections and too many steps", () => {
    const g = graph(3, [[1, 2], [2, 3]]);
    expect(orderLoop([C(1), C(2)], g.get).error).toMatch(/do not form one closed loop/);
    expect(orderLoop([C(1), E(1)], g.get).error).toMatch(/only connections/);
    const big = graph(2, Array.from({ length: LIMITS.loopSteps + 1 }, () => [1, 2, "undirected"]));
    expect(orderLoop(big.objects.filter((o) => o.id[0] === "c").map((o) => o.id), big.get).error).toMatch(/at most/);
  });
  it("accepts a self-link and a figure eight (backtracking)", () => {
    const self = graph(1, [[1, 1]]);
    expect(orderLoop([C(1)], self.get)).toEqual({ steps: [{ c: C(1), fwd: true }] });
    // 1->2->3->1 and 1->4->5->1 through the shared node 1.
    const eight = graph(5, [[1, 2], [2, 3], [3, 1], [1, 4], [4, 5], [5, 1]]);
    const r = orderLoop([C(1), C(2), C(3), C(4), C(5), C(6)], eight.get);
    expect(loopProblem(r.steps, eight.get)).toBeNull();
    expect(r.steps).toHaveLength(6);
  });
  it("orders a 100-step ring quickly", () => {
    const links = Array.from({ length: 100 }, (_, i) => [i + 1, ((i + 1) % 100) + 1]);
    const g = graph(100, links);
    const ids = links.map((_, i) => C(i + 1)).reverse();
    const t = performance.now();
    const r = orderLoop(ids, g.get);
    expect(loopProblem(r.steps, g.get)).toBeNull();
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("merge planning", () => {
  const setup = () => {
    // 1 survivor, 2 and 3 merged in. Loop 2->4->5->2 goes through a merged element.
    const g = graph(5, [[2, 4], [4, 5], [5, 2], [1, 2], [3, 5]], [{ id: L(1), label: "Around", classification: "R", steps: [{ c: C(1), fwd: true }, { c: C(2), fwd: true }, { c: C(3), fwd: true }], version: 1 }]);
    Object.assign(g.byId.get(E(1)), { label: "Acme", aliases: ["ACME Ltd"], tags: ["org"], fields: { [F(1)]: "Private", [F(2)]: 3 } });
    Object.assign(g.byId.get(E(2)), { label: "Acme Inc", tags: ["Org", "big"], typeId: "t_000000000001", description: "From import", fields: { [F(1)]: "Public", [F(3)]: "2020-01-01" }, externalRefs: [{ sourceId: "s", key: "1" }] });
    Object.assign(g.byId.get(E(3)), { label: "acme", fields: { [F(2)]: 3 }, externalRefs: [{ sourceId: "s", key: "1" }, { sourceId: "s", key: "2" }] });
    const idx = buildGraphIndex(g.objects);
    const plan = planMerge({ ids: [E(1), E(2), E(3)], survivorId: E(1), get: g.get, connectionsOf: (id) => idx.adjacency.get(id) ?? [], loops: [g.byId.get(L(1))] });
    return { g, plan };
  };

  it("lists re-pointed connections, including one that becomes a self-link", () => {
    const { plan } = setup();
    const byId = Object.fromEntries(plan.repoint.map((r) => [r.conn.id, r]));
    expect(Object.keys(byId).sort()).toEqual([C(1), C(3), C(4), C(5)]);
    expect(byId[C(1)].patch).toEqual({ from: E(1) });
    expect(byId[C(3)].patch).toEqual({ to: E(1) });
    expect(byId[C(4)]).toMatchObject({ patch: { to: E(1) }, selfLink: true });
    expect(byId[C(5)].patch).toEqual({ from: E(1) });
  });
  it("finds conflicts (survivor first) and takes unique values from the others", () => {
    const { plan } = setup();
    expect(plan.conflicts).toEqual([{ fieldId: F(1), options: [{ elementId: E(1), value: "Private" }, { elementId: E(2), value: "Public" }], chosen: E(1) }]);
    expect(plan.fields).toEqual({ [F(3)]: { elementId: E(2), value: "2020-01-01" } });
  });
  it("unions aliases (merged labels, minus the survivor's own), tags and external refs", () => {
    const { plan } = setup();
    expect(plan.aliases).toEqual(["ACME Ltd", "Acme Inc"]);
    expect(plan.tags).toEqual(["org", "big"]);
    expect(plan.externalRefs).toEqual([{ sourceId: "s", key: "1" }, { sourceId: "s", key: "2" }]);
    expect(plan.typeId).toBe("t_000000000001");
    expect(plan.description).toBe("From import");
    expect(plan.loops.map((l) => l.id)).toEqual([L(1)]);
  });
  it("builds ops: re-point, survivor, deletes; loops keep their ids", () => {
    const { plan } = setup();
    const ops = mergeOps(plan, { [F(1)]: E(2) }, () => { throw new Error("no new ids needed"); });
    expect(ops.map((o) => `${o.op}:${(o.id ?? o.object.id)[0]}`)).toEqual([
      "update:c", "update:c", "update:c", "update:c", "update:e", "delete:e", "delete:e",
    ]);
    const survivorOp = ops.find((o) => o.op === "update" && o.id === E(1));
    expect(survivorOp.patch.fields).toEqual({ [F(1)]: "Public", [F(3)]: "2020-01-01" });
    expect(survivorOp.patch.aliases).toEqual(["ACME Ltd", "Acme Inc"]);
    expect(ops.some((o) => o.id?.[0] === "l" || o.object?.id?.[0] === "l")).toBe(false);
  });
  it("replays the ops into a still-valid loop", () => {
    const { g, plan } = setup();
    const state = new Map(g.byId);
    for (const op of mergeOps(plan, {}, () => L(9))) {
      if (op.op === "delete") state.delete(op.id);
      else if (op.op === "update") {
        const cur = state.get(op.id);
        state.set(op.id, { ...cur, ...op.patch, ...(op.patch.fields ? { fields: { ...cur.fields, ...op.patch.fields } } : {}) });
      }
      else state.set(op.object.id, op.object);
    }
    expect(state.has(E(2)) || state.has(E(3))).toBe(false);
    expect(loopProblem(state.get(L(1)).steps, (id) => state.get(id))).toBeNull();
    expect(state.get(E(1)).fields[F(1)]).toBe("Private");
  });
  it("reports what is over the limits", () => {
    const g = graph(2, []);
    g.byId.get(E(1)).tags = Array.from({ length: 30 }, (_, i) => `a${i}`);
    g.byId.get(E(2)).tags = Array.from({ length: 10 }, (_, i) => `b${i}`);
    const plan = planMerge({ ids: [E(1), E(2)], survivorId: E(1), get: g.get, connectionsOf: () => [], loops: [] });
    expect(plan.tags).toHaveLength(LIMITS.tags);
    expect(plan.dropped.tags).toBe(8);
  });
});

describe("sorting", () => {
  it("compares numbers, natural text and booleans; empty last", () => {
    expect(compareCells(2, 10)).toBeLessThan(0);
    expect(compareCells("Item 2", "Item 10")).toBeLessThan(0);
    expect(compareCells("apple", "Banana")).toBeLessThan(0);
    expect(compareCells(false, true)).toBeLessThan(0);
    expect(compareCells("", "a")).toBeGreaterThan(0);
    expect(compareCells(null, undefined)).toBe(0);
  });
  it("sorts rows either way with empty cells last and stable ties", () => {
    const rows = [{ k: 3, n: "a" }, { k: null, n: "b" }, { k: 1, n: "c" }, { k: 3, n: "d" }];
    expect(sortRows([...rows], "k", "ascending").map((r) => r.n)).toEqual(["c", "a", "d", "b"]);
    expect(sortRows([...rows], "k", "descending").map((r) => r.n)).toEqual(["a", "d", "c", "b"]);
  });
  it("sorts 10,000 rows fast", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ label: `Element ${(i * 7919) % 10_000}` }));
    const t = performance.now();
    sortRows(rows, "label", "ascending");
    expect(rows[0].label).toBe("Element 0");
    expect(rows[9999].label).toBe("Element 9999");
    expect(performance.now() - t).toBeLessThan(500);
  });
});
