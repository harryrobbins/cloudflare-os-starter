import { describe, it, expect } from "vitest";
import {
  detectFormat, sheetKind, sourceNameFromFile, planFor, planSummary, delimiterName, hasDecodingErrors, kindTotals, chunk,
  countRows, effectiveAction, decisionOptions, currentDecision, decisionFor, bulkDecisions, acceptCounts, countWritable,
  acceptLabel, progressOf, manifestSummary, groupUndoState, importedElementIds, undoMessage, historyBadges,
  positionsToColumns, storedMapOf, exportFileName,
} from "../../src/client/ui/data-logic.js";
import { toElementsCsv, toKumuJson } from "../../src/shared/exports.js";

const ELEMENTS = "Label\tType\tBudget\tStatus\nAlpha\tCharity\t100\tActive\nBeta\tCharity\t250\tActive\nGamma\tFunder\t75\tPlanned\nDelta\tFunder\t10\tPlanned\n";
const CONNECTIONS = "From\tTo\tType\nAlpha\tBeta\tFunds\nGamma\tAlpha\tFunds\n";

describe("format detection", () => {
  it("recognises sheets by their header row", () => {
    expect(sheetKind(ELEMENTS)).toBe("elements");
    expect(sheetKind(CONNECTIONS)).toBe("connections");
    expect(sheetKind("Source,Target\na,b")).toBe("connections");
    expect(sheetKind("\uFEFFLabel,Type\nA,B")).toBe("elements");
    expect(sheetKind("x,y\n1,2")).toBe(null);
    expect(sheetKind("")).toBe(null);
    expect(sheetKind(undefined)).toBe(null);
  });

  it("detects the format from the file name, then the content", () => {
    expect(detectFormat("map.json", "")).toBe("kumu-json");
    expect(detectFormat("paste", '  {"elements": []}')).toBe("kumu-json");
    expect(detectFormat("Map - Elements.csv", ELEMENTS)).toBe("kumu-sheets");
    expect(detectFormat("Map - Connections.csv", CONNECTIONS)).toBe("kumu-sheets");
    expect(detectFormat("my-edges.csv", "Source,Target\na,b")).toBe("edge-list");
    expect(detectFormat("pairs.csv", "a,b\nc,d")).toBe("edge-list");
    expect(detectFormat("notes.md", "hello")).toBe(null);
  });

  it("derives a source name shared by both sheets of a Kumu export", () => {
    expect(sourceNameFromFile("Partners 2026 - Elements.csv")).toBe("Partners 2026");
    expect(sourceNameFromFile("Partners 2026 - Connections.csv")).toBe("Partners 2026");
    expect(sourceNameFromFile("C:\\data\\partners_map.json")).toBe("partners map");
    expect(sourceNameFromFile("edges.tsv")).toBe("");
    expect(sourceNameFromFile("food-network (edges).csv")).toBe("food-network");
  });

  it("names delimiters and spots undecodable text", () => {
    expect(delimiterName("\t")).toMatch(/Tab/);
    expect(delimiterName(",")).toBe("Comma");
    expect(delimiterName(";")).toBe("Semicolon");
    expect(delimiterName(undefined)).toBe("—");
    expect(hasDecodingErrors("caf\uFFFD")).toBe(true);
    expect(hasDecodingErrors("café")).toBe(false);
  });
});

describe("plans", () => {
  it("parses each format and summarises the preview", () => {
    const sheets = planFor({ format: "kumu-sheets", elements: ELEMENTS, connections: CONNECTIONS, sourceName: "Test" });
    expect(sheets.source).toBe("kumu:test");
    expect(planSummary(sheets.preview)).toBe("4 elements · 2 connections · 3 types · 2 fields");
    const kinds = Object.fromEntries(sheets.preview.fields.map((f) => [f.name, f.kind]));
    expect(kinds).toEqual({ Budget: "number", Status: "choice" });
    expect(kindTotals(sheets.items)).toEqual({ type: 3, field: 2, element: 4, connection: 2 });

    const edges = planFor({ format: "edge-list", edges: "From,To\na,b\nb,c", sourceName: "E" });
    expect(edges.preview.connections).toBe(2);
    expect(edges.preview.elements).toBe(3);

    const json = planFor({ format: "kumu-json", json: JSON.stringify({ elements: [{ label: "A" }], connections: [] }) });
    expect(planSummary(json.preview)).toBe("1 element · 0 connections");
  });

  it("chunks for staging", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
    expect(chunk(Array.from({ length: 4001 }, (_, i) => i)).map((c) => c.length)).toEqual([2000, 2000, 1]);
  });
});

const el = (iid, extra = {}) => ({ iid, data: { kind: "element", key: iid, label: "L" + iid }, action: "create", candidates: [], problems: [], ...extra });
const cn = (iid, extra = {}) => ({ iid, data: { kind: "connection", from: "a", to: "b" }, action: "create", problems: [], ...extra });

describe("review decisions", () => {
  it("lists counts in a fixed order without zeros", () => {
    expect(countRows({ skip: 1, create: 3, update: 0, blocked: 2 })).toEqual([
      { key: "create", label: "Create new", n: 3 }, { key: "skip", label: "Skip", n: 1 }, { key: "blocked", label: "Blocked", n: 2 },
    ]);
    expect(countRows(undefined)).toEqual([]);
  });

  it("shows invalid and blocked over the action", () => {
    expect(effectiveAction(el("i1", { invalid: true, action: "skip" }))).toBe("invalid");
    expect(effectiveAction(cn("i2", { blocked: true }))).toBe("blocked");
    expect(effectiveAction(el("i3", { action: "use-existing" }))).toBe("use-existing");
  });

  it("offers create, each candidate, update and skip for elements", () => {
    const item = el("i1", { action: "use-existing", targetId: "e_000000000001", candidates: [{ id: "e_000000000001", label: "Food bank" }, { id: "e_000000000002", label: "Food bank" }] });
    expect(decisionOptions(item).map((o) => o.value)).toEqual(["create", "use-existing:e_000000000001", "use-existing:e_000000000002", "skip"]);
    expect(currentDecision(item)).toBe("use-existing:e_000000000001");
    expect(decisionFor(item, "use-existing:e_000000000002")).toEqual({ iid: "i1", action: "use-existing", targetId: "e_000000000002" });
    expect(decisionFor(item, "create")).toEqual({ iid: "i1", action: "create" });

    const updating = el("i2", { action: "update", targetId: "e_000000000003", target: { id: "e_000000000003", label: "Old" } });
    expect(decisionOptions(updating).map((o) => o.value)).toEqual(["create", "update:e_000000000003", "skip"]);
    expect(currentDecision(updating)).toBe("update:e_000000000003");
    expect(currentDecision(el("i3", { action: "skip" }))).toBe("skip");
  });

  it("offers create/update and skip for connections; update goes back to automatic", () => {
    const c = cn("i4", { action: "update" });
    expect(decisionOptions(c).map((o) => o.value)).toEqual(["update", "skip"]);
    expect(decisionFor(c, "update")).toEqual({ iid: "i4", action: "create" });
    expect(decisionOptions(cn("i5")).map((o) => o.value)).toEqual(["create", "skip"]);
  });

  it("offers nothing to choose for an existing type or field", () => {
    expect(decisionOptions({ iid: "i0", data: { kind: "type", name: "Actor" }, action: "use-existing" })).toHaveLength(1);
    expect(decisionOptions({ iid: "i0", data: { kind: "field", name: "New" }, action: "create" }).map((o) => o.value)).toEqual(["create", "skip"]);
  });

  it("builds bulk decisions", () => {
    const items = [
      el("i1", { candidates: [{ id: "e_000000000001", label: "A" }] }), // create, one candidate
      el("i2", { action: "use-existing", targetId: "e_000000000002", candidates: [{ id: "e_000000000002", label: "B" }] }),
      el("i3", { candidates: [{ id: "e_1", label: "C" }, { id: "e_2", label: "C" }] }), // several: left alone
      el("i4", { action: "update", targetId: "e_000000000004", candidates: [{ id: "e_000000000004", label: "D" }] }),
      cn("i5", { invalid: true }),
      el("i6", { invalid: true, action: "skip" }),
    ];
    expect(bulkDecisions(items, "use-existing-single")).toEqual([{ iid: "i1", action: "use-existing", targetId: "e_000000000001" }]);
    expect(bulkDecisions(items, "create-label-matches")).toEqual([{ iid: "i2", action: "create" }]);
    expect(bulkDecisions(items, "skip-invalid")).toEqual([{ iid: "i5", action: "skip" }]);
  });

  it("counts what accepting writes", () => {
    const items = [el("i1"), el("i2", { action: "skip" }), el("i3", { action: "use-existing" }), cn("i4"), cn("i5", { blocked: true }), cn("i6", { invalid: true }), { iid: "i7", data: { kind: "type" }, action: "create" }];
    expect(countWritable(items)).toEqual({ elements: 2, connections: 1 });
    expect(acceptCounts({ element: 10, connection: 5 }, { skipped: { element: 2 }, invalid: { connection: 1 }, blocked: 3 })).toEqual({ elements: 8, connections: 1 });
    expect(acceptCounts({ element: 1, connection: 0 }, { blocked: 4 })).toEqual({ elements: 1, connections: 0 });
  });

  it("labels the accept button with what will happen", () => {
    expect(acceptLabel({ elements: 120, connections: 300 })).toBe("Import 120 elements and 300 connections");
    expect(acceptLabel({ elements: 1, connections: 0 })).toBe("Import 1 element");
    expect(acceptLabel({ elements: 0, connections: 2 })).toBe("Import 2 connections");
    expect(acceptLabel({ elements: 1200, connections: 1 })).toBe("Import 1,200 elements and 1 connection");
    expect(acceptLabel({ elements: 0, connections: 0 })).toMatch(/nothing/);
  });
});

describe("changeset status", () => {
  it("reports progress", () => {
    expect(progressOf({ items: 200, applied: 50 })).toEqual({ done: 50, total: 200, fraction: 0.25, text: "50 of 200 items applied" });
    expect(progressOf({ items: 0, applied: 0 }).fraction).toBe(0);
    expect(progressOf({ items: 2, applied: 5 }).done).toBe(2);
  });

  it("summarises a manifest", () => {
    expect(manifestSummary({ status: "applied", applied: 7, counts: { skip: 1 } })).toBe("7 applied · 1 skipped");
    expect(manifestSummary({ status: "partial", applied: 5, counts: { failed: 2 } })).toBe("5 applied · 2 failed");
    expect(manifestSummary({ status: "review", items: 4, counts: { create: 3, "use-existing": 1 } })).toBe("3 create new · 1 use existing");
    expect(manifestSummary({ status: "staging", items: 4, counts: {} })).toBe("4 items");
  });

  it("knows whether an import was undone", () => {
    const history = [
      { id: "h3", groupId: "x_1", undoOf: "h1" },
      { id: "h2", groupId: "x_1", undoneBy: null },
      { id: "h1", groupId: "x_1", undoneBy: "h3" },
      { id: "h0", groupId: "x_2", undoneBy: "h9" },
    ];
    expect(groupUndoState("x_1", history)).toBe("partly");
    expect(groupUndoState("x_2", history)).toBe("undone");
    expect(groupUndoState("x_3", history)).toBe("unknown");
    expect(groupUndoState("x_1", [{ id: "h2", groupId: "x_1" }])).toBe("no");
  });

  it("finds the elements an import wrote", () => {
    const objects = [
      { id: "e_1", provenance: { changesetId: "x_1" } },
      { id: "e_2", externalRefs: [{ sourceId: "kumu:test", key: "B" }] },
      { id: "e_3", externalRefs: [{ sourceId: "kumu:other", key: "B" }] },
      { id: "c_1", provenance: { changesetId: "x_1" } },
    ];
    expect(importedElementIds(objects, { id: "x_1", source: "kumu:test" })).toEqual(["e_1", "e_2"]);
  });
});

describe("undo messages and history badges", () => {
  it("explains undo results", () => {
    expect(undoMessage(null).ok).toBe(false);
    expect(undoMessage({ status: "applied", conflicts: [], errors: [] })).toEqual({ ok: true, message: "Undone." });
    expect(undoMessage({ status: "applied", conflicts: [{ id: "e_1" }, { id: "e_1" }, { layout: "shared", id: "e_2" }], errors: [] }).message).toBe("Undone. 1 item was changed since and kept.");
    expect(undoMessage({ status: "unchanged", conflicts: [], errors: [{ message: "This change was already undone" }] })).toEqual({ ok: false, message: "This change was already undone" });
    expect(undoMessage({ parts: 0, conflicts: [], errors: [] })).toEqual({ ok: false, message: "Nothing left to undo for this import." });
    expect(undoMessage({ parts: 3, conflicts: [{ id: "e_1" }, { id: "t_1" }], errors: [] }).message).toBe("Import undone. 2 items were changed since and kept.");
    expect(undoMessage({ parts: 1, conflicts: [], errors: [] }).message).toBe("Import undone.");
  });

  it("badges history entries", () => {
    expect(historyBadges({ undoable: true })).toEqual([]);
    expect(historyBadges({ undoable: false, evicted: true, undoneBy: "h2" }).map((b) => b.label)).toEqual(["undone", "too old to undo"]);
    expect(historyBadges({ undoable: false }).map((b) => b.label)).toEqual(["not undoable"]);
    expect(historyBadges({ undoable: true, undoOf: "h1" }).map((b) => b.key)).toEqual(["undo"]);
  });
});

describe("exports from the store", () => {
  const positions = new Map([["shared", new Map([["e_000000000001", { x: 1, y: 2, pin: true, v: 3 }], ["e_000000000002", { x: 4, y: 5, pin: false }]])]]);

  it("converts positions to columns", () => {
    expect(positionsToColumns(positions)).toEqual([{ layout: "shared", ids: ["e_000000000001", "e_000000000002"], x: [1, 4], y: [2, 5], pin: "10", v: [3, 0] }]);
    expect(positionsToColumns(new Map())).toEqual([]);
  });

  it("builds a map the exporters read", () => {
    const store = {
      meta: { title: "T" },
      objects: new Map([
        ["e_000000000001", { id: "e_000000000001", label: "A" }],
        ["e_000000000002", { id: "e_000000000002", label: "B" }],
      ]),
      positions,
    };
    const map = storedMapOf(store);
    expect(map.objects).toHaveLength(2);
    expect(toElementsCsv(map).split(/\r?\n/)[1]).toContain("A");
    expect(toKumuJson(map).elements).toHaveLength(2);
  });

  it("names export files", () => {
    expect(exportFileName("Food network: 2026!", "elements.csv")).toBe("food-network-2026-elements.csv");
    expect(exportFileName("", "kumu.json")).toBe("network-map-kumu.json");
  });
});
