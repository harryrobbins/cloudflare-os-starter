import { describe, it, expect } from "vitest";
import { parseDelimited, parseKumuSheets, parseEdgeList, parseKumuJson, inferFieldKind, MAX_COLUMNS } from "../../src/shared/imports.js";
import { createNetworkMap } from "../../src/core/network-map.js";
import { InMemoryRepository } from "../../src/core/repository.js";
import { createChangesets } from "../../src/core/changesets.js";

/** @param {any} plan @param {string} kind */
const itemsOf = (plan, kind) => plan.items.filter((/** @type {any} */ it) => it.kind === kind);

describe("parseDelimited", () => {
  it("handles quotes, doubled quotes, embedded newlines, CRLF and a BOM", () => {
    const text = '﻿Label,Description\r\n"Alpha, Inc","He said ""hi""\r\nsecond line"\r\nBeta,plain\r\n';
    const t = parseDelimited(text);
    expect(t.delimiter).toBe(",");
    expect(t.headers).toEqual(["Label", "Description"]);
    expect(t.rows).toEqual([["Alpha, Inc", 'He said "hi"\r\nsecond line'], ["Beta", "plain"]]);
    expect(t.problems).toEqual([]);
  });

  it("detects tab and semicolon delimiters, and honours an explicit one", () => {
    expect(parseDelimited("a\tb\n1\t2").delimiter).toBe("\t");
    expect(parseDelimited("a;b;c\n1;2;3").rows).toEqual([["1", "2", "3"]]);
    expect(parseDelimited("a,b;c\n1,2;3").delimiter).toBe(",");
    expect(parseDelimited("a,b;c\n1,2;3", { delimiter: ";" }).headers).toEqual(["a,b", "c"]);
  });

  it("skips empty rows, reports an unclosed quote and caps columns", () => {
    const t = parseDelimited("a,b\n\n,\n1,2\n\"open,3");
    expect(t.rows).toEqual([["1", "2"], ["open,3"]]);
    expect(t.problems[0]).toMatch(/never closed/);
    const wide = parseDelimited(Array.from({ length: MAX_COLUMNS + 5 }, (_, i) => `c${i}`).join(","));
    expect(wide.headers).toHaveLength(MAX_COLUMNS);
    expect(wide.problems.join()).toMatch(/columns/);
  });

  it("never throws on non-string input", () => {
    expect(parseDelimited(/** @type {any} */ (null))).toMatchObject({ headers: [], rows: [] });
  });
});

describe("inferFieldKind", () => {
  it("infers each kind", () => {
    expect(inferFieldKind(["1", "2.5", "-3", "", "4", "5", "6", "7", "8", "9", "10"])).toBe("number");
    expect(inferFieldKind(["1", "2", "3", "4", "5", "6", "7", "8", "9", "n/a"])).toBe("number");
    expect(inferFieldKind(["1", "x", "3"])).not.toBe("number");
    expect(inferFieldKind(["2024-01-31", "2020-02-29"])).toBe("date");
    expect(inferFieldKind(["2024-02-30"])).not.toBe("date");
    expect(inferFieldKind(["2024-01"])).toBe("text");
    expect(inferFieldKind(["Yes", "no", "TRUE"])).toBe("bool");
    expect(inferFieldKind(["https://example.com/a", "http://x.org"])).toBe("url");
    expect(inferFieldKind(["a|b", "b|c", "a"])).toBe("multichoice");
    expect(inferFieldKind(["Public", "Private", "Public", "Private", "Public"])).toBe("choice");
    expect(inferFieldKind(["one", "two", "three"])).toBe("text");
    expect(inferFieldKind(["x".repeat(201)])).toBe("longtext");
    expect(inferFieldKind(["line one\nline two"])).toBe("longtext");
    expect(inferFieldKind(["", "  "])).toBe("text");
  });
});

describe("parseKumuSheets", () => {
  it("reads elements and connections without an ID column (labels are keys)", () => {
    const plan = parseKumuSheets({
      sourceName: "My Map.xlsx",
      elements: "Label,Element Type,Description,Tags,Sector,Influence,Since\n" +
        "Farms,Actor,Growers,local|food,Private,4,2010-04-01\n" +
        "Market,Actor,,weekly,Community,3,2012-04-01\n" +
        "Council,Actor,,,Private,5,\n" +
        "Land,Resource,,,Private,2,\n" +
        "Bank,Actor,,,Community,1,\n",
      connections: "From,To,Connection Type,Direction,Label,Strength,Sign,Notes\n" +
        "Farms,Market,Supports,,sells,2,+,a\n" +
        "market,Council,Supports,mutual,,,opposite,b\n" +
        "Council,Nowhere,,Undirected,,,,c\n",
    });
    expect(plan.format).toBe("kumu-sheets");
    expect(plan.source).toBe("kumu:my map.xlsx");
    const elements = itemsOf(plan, "element");
    expect(elements.map((e) => e.key)).toEqual(["Farms", "Market", "Council", "Land", "Bank", "Nowhere"]);
    expect(elements[0]).toMatchObject({ label: "Farms", type: "Actor", description: "Growers", tags: ["local", "food"], fields: { Sector: "Private", Influence: 4, Since: "2010-04-01" } });
    expect(itemsOf(plan, "type")).toEqual([
      { kind: "type", name: "Actor", appliesTo: "element" }, { kind: "type", name: "Resource", appliesTo: "element" },
      { kind: "type", name: "Supports", appliesTo: "connection" },
    ]);
    const fields = itemsOf(plan, "field");
    expect(fields.find((f) => f.name === "Sector")).toMatchObject({ fieldKind: "choice", appliesTo: "element", choices: ["Private", "Community"] });
    expect(fields.find((f) => f.name === "Influence")).toMatchObject({ fieldKind: "number" });
    expect(fields.find((f) => f.name === "Since")).toMatchObject({ fieldKind: "date" });
    expect(fields.find((f) => f.name === "Notes")).toMatchObject({ fieldKind: "text", appliesTo: "connection" });
    const conns = itemsOf(plan, "connection");
    expect(conns[0]).toMatchObject({ from: "Farms", to: "Market", type: "Supports", label: "sells", strength: 2, polarity: "+", fields: { Notes: "a" } });
    expect(conns[1]).toMatchObject({ from: "Market", to: "Council", direction: "mutual", polarity: "-" });
    expect(conns[2]).toMatchObject({ from: "Council", to: "Nowhere", direction: "undirected" });
    expect(plan.preview).toMatchObject({ elements: 6, connections: 3, autoCreated: 1, unresolved: ["Nowhere"], delimiter: "," });
    expect(plan.preview.problems.join()).toMatch(/created from connection endpoints/);
    expect(plan.preview.headers.elements).toContain("Sector");
  });

  it("uses an ID column as the key, resolves From/To by ID, and reports duplicates", () => {
    const plan = parseKumuSheets({
      elements: "ID\tLabel\tType\na1\tAcme\tOrg\na2\tAcme\tOrg\na1\tRepeat\tOrg\n\tNo id\tOrg\n",
      connections: "From\tTo\na1\ta2\nNo id\ta1\n",
    });
    expect(plan.preview.delimiter).toBe("\t");
    expect(itemsOf(plan, "element").map((e) => [e.key, e.label])).toEqual([["a1", "Acme"], ["a2", "Acme"], ["No id", "No id"]]);
    expect(plan.preview.duplicateKeys).toEqual(["a1"]);
    expect(plan.preview.duplicateLabels).toEqual(["Acme"]);
    expect(itemsOf(plan, "connection").map((c) => [c.from, c.to])).toEqual([["a1", "a2"], ["No id", "a1"]]);
    expect(plan.preview.autoCreated).toBe(0);
  });

  it("gives repeated connections distinct keys and strips export formula quotes", () => {
    const plan = parseKumuSheets({ connections: "From,To,Note\nA,B,'-foo\nA,B,x\n" });
    const conns = itemsOf(plan, "connection");
    expect(conns.map((c) => c.key)).toEqual(["A -> B", "A -> B #2"]);
    expect(conns[0].fields.Note).toBe("-foo");
    expect(plan.preview.autoCreated).toBe(2);
  });

  it("reports missing required columns without throwing", () => {
    const plan = parseKumuSheets({ elements: "Name\nX\n", connections: "A,B\n1,2\n" });
    expect(plan.items).toEqual([]);
    expect(plan.preview.problems.join("\n")).toMatch(/no "Label" column/);
    expect(plan.preview.problems.join("\n")).toMatch(/"From" and "To"/);
    expect(parseKumuSheets(/** @type {any} */ (undefined)).preview.problems[0]).toMatch(/Nothing to import/);
  });

  it("merges a column present in both tables into one field for both", () => {
    const plan = parseKumuSheets({ elements: "Label,Notes\nA,x\n", connections: "From,To,Notes\nA,B,y\n" });
    expect(itemsOf(plan, "field")).toEqual([{ kind: "field", name: "Notes", fieldKind: "text", appliesTo: "both" }]);
  });

  it("produces items the server accepts", async () => {
    const plan = parseKumuSheets({
      sourceName: "sheet",
      elements: "Label,Type,Tags,Sector,Influence,Topics,Site,Active\n" +
        "Farms,Actor,a|b,Private,4,soil|water,https://farms.example,yes\n" +
        "Market,Actor,,Community,3,water,,no\n" +
        "Council,Public body,,Private,5,,,\n" +
        "Bank,Actor,,Community,1,soil,,\n",
      connections: "From,To,Type,Direction,Polarity,Strength,Weight note\n" +
        "Farms,Market,Supports,,+,2,high\nMarket,Council,Supports,mutual,-,1.5,low\nCouncil,Newcomer,,,,,\n",
    });
    const map = createNetworkMap(new InMemoryRepository(), { seedDemo: false });
    const cs = createChangesets(map);
    const m = await cs.createChangeset({ name: plan.sourceName, source: plan.source, format: plan.format, by: "Tester" });
    const added = await cs.addChangesetItems({ changesetId: m.id, items: plan.items });
    expect(added.errors).toEqual([]);
    const fin = await cs.finalizeChangeset({ changesetId: m.id });
    expect(fin.counts.invalid).toBe(0);
    const done = await cs.acceptChangeset({ changesetId: m.id, digest: fin.digest, by: "Tester", senderId: "t" });
    expect(done.status).toBe("applied");
    const got = await map.getMap();
    const byName = new Map(got.objects.filter((o) => o.id[0] === "f").map((o) => [o.name, o]));
    expect(byName.get("Sector")).toMatchObject({ kind: "choice", appliesTo: "element" });
    expect(byName.get("Topics")).toMatchObject({ kind: "multichoice" });
    expect(byName.get("Active")).toMatchObject({ kind: "bool" });
    const elements = got.objects.filter((o) => o.id[0] === "e");
    expect(elements.map((e) => e.label).sort()).toEqual(["Bank", "Council", "Farms", "Market", "Newcomer"]);
    const farms = elements.find((e) => e.label === "Farms");
    expect(farms.tags).toEqual(["a", "b"]);
    expect(farms.fields).toEqual({
      [byName.get("Sector").id]: "Private", [byName.get("Influence").id]: 4, [byName.get("Topics").id]: ["soil", "water"],
      [byName.get("Site").id]: "https://farms.example/", [byName.get("Active").id]: true,
    });
    expect(farms.externalRefs).toEqual([{ sourceId: "kumu:sheet", key: "Farms" }]);
    const actor = got.objects.find((o) => o.id[0] === "t" && o.name === "Actor");
    expect(farms.typeId).toBe(actor.id);
    const conns = got.objects.filter((o) => o.id[0] === "c");
    expect(conns).toHaveLength(3);
    const idOf = (/** @type {string} */ l) => elements.find((e) => e.label === l).id;
    const mc = conns.find((c) => c.from === idOf("Market"));
    expect(mc).toMatchObject({ to: idOf("Council"), direction: "mutual", polarity: "-", strength: 1.5 });
    expect(mc.fields[byName.get("Weight note").id]).toBe("low");
    expect(done.counts.failed).toBe(0);
  });
});

describe("parseEdgeList", () => {
  it("reads Source/Target/Weight headers", () => {
    const plan = parseEdgeList("Source,Target,Weight,Type\nA,B,3,knows\nB,C,,knows\n", { sourceName: "edges.csv" });
    expect(plan.format).toBe("edge-list");
    expect(itemsOf(plan, "element").map((e) => e.label)).toEqual(["A", "B", "C"]);
    expect(itemsOf(plan, "connection")[0]).toMatchObject({ from: "A", to: "B", strength: 3, type: "knows" });
    expect(plan.preview.autoCreated).toBe(3);
  });

  it("uses the first two columns when there is no header", () => {
    const plan = parseEdgeList("x\ty\ny\tz\n");
    expect(itemsOf(plan, "connection").map((c) => [c.from, c.to])).toEqual([["x", "y"], ["y", "z"]]);
    expect(plan.preview.problems.join()).toMatch(/No header row/);
  });

  it("needs two columns", () => {
    const plan = parseEdgeList("only\none\n");
    expect(plan.items).toEqual([]);
    expect(plan.preview.problems.join()).toMatch(/two columns/);
  });
});

describe("parseKumuJson", () => {
  it("reads a Kumu project export and skips loops and maps", () => {
    const text = JSON.stringify({
      elements: [
        { _id: "elem-1", attributes: { label: "Alice", "element type": "Person", tags: ["x"], age: 30, image: "https://i/a.png", nested: { a: 1 } } },
        { _id: "elem-2", attributes: { label: "Bob", "element type": "Person", age: 41 } },
      ],
      connections: [{ _id: "conn-1", from: "elem-1", to: "elem-2", direction: "mutual", attributes: { "connection type": "Friend", label: "since school", strength: 2 } }],
      loops: [{ _id: "loop-1" }, { _id: "loop-2" }],
      maps: [{ _id: "map-1" }],
    });
    const plan = parseKumuJson(text, { sourceName: "project.json" });
    expect(plan.format).toBe("kumu-json");
    expect(itemsOf(plan, "element")).toEqual([
      { kind: "element", key: "elem-1", label: "Alice", type: "Person", tags: ["x"], fields: { age: 30 } },
      { kind: "element", key: "elem-2", label: "Bob", type: "Person", fields: { age: 41 } },
    ]);
    expect(itemsOf(plan, "connection")[0]).toMatchObject({ key: "conn-1", from: "elem-1", to: "elem-2", direction: "mutual", type: "Friend", label: "since school", strength: 2 });
    expect(plan.preview.skipped).toContain("skipped: 2 loops, 1 perspective (not supported yet)");
    expect(plan.preview.skipped.join()).toMatch(/image/);
    expect(plan.preview.problems.join()).toMatch(/"nested"/);
  });

  it("reads blueprint JSON where from/to are labels", () => {
    const text = JSON.stringify({
      elements: [{ label: "A", type: "Org", sector: "x" }, { label: "B", type: "Org", sector: "x" }],
      connections: [{ from: "A", to: "B", type: "Funds", direction: "undirected", amount: 5 }, { from: "B", to: "Z" }],
    });
    const plan = parseKumuJson(text);
    expect(itemsOf(plan, "element").map((e) => e.key)).toEqual(["A", "B", "Z"]);
    expect(itemsOf(plan, "connection")[0]).toMatchObject({ from: "A", to: "B", type: "Funds", direction: "undirected", fields: { amount: 5 } });
    expect(plan.preview.unresolved).toEqual(["Z"]);
    expect(plan.preview.skipped).toEqual([]);
  });

  it("reports bad JSON instead of throwing", () => {
    expect(parseKumuJson("{nope").preview.problems).toEqual(["This is not valid JSON"]);
    expect(parseKumuJson("[]").preview.problems[0]).toMatch(/object/);
  });
});
