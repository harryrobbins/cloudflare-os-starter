import { describe, expect, it } from "vitest";
import {
  tableLayout, cellAt, insertRow, removeRow, insertColumn, removeColumn, parseTable, tableToMarkdown, fitColumns, columnFractions,
} from "../../src/shared/table.js";
import { diagramHash, renderRequest, acceptSvg, svgSize, svgDataUrl, renderErrorMessage } from "../../src/shared/diagram.js";
import { normalizeNewObject, cleanCells, cleanColWidths, cleanObjectPatch, LIMITS } from "../../src/shared/protocol.js";
import { objectNode, serialize, boardToSvg } from "../../src/shared/render.js";
import { textWidth } from "../../src/shared/geometry.js";
import { codeFenceToEntry, tableToEntry, toPortable, parseBackup, buildBackup } from "../../src/shared/backup.js";

const oid = (n) => "o_" + n.toString(16).padStart(12, "0");
const make = (fields) => ({ ...normalizeNewObject({ id: oid(1), ...fields }), z: "a0", version: 1, createdAt: 0, updatedAt: 0, createdBy: "t" });

describe("table protocol", () => {
  it("squares, bounds and cleans cells; defaults to a 3 x 3 grid with a header", () => {
    expect(cleanCells([["a", "b"], ["c"]])).toEqual([["a", "b"], ["c", ""]]);
    expect(cleanCells([["x", 5, null]])).toEqual([["x", "5", ""]]);
    expect(cleanCells([])).toBeNull();
    expect(cleanCells([[]])).toBeNull();
    expect(cleanCells("nope")).toBeNull();
    const big = cleanCells(Array.from({ length: 999 }, () => Array.from({ length: 99 }, () => "x".repeat(5000))));
    expect(big.length).toBe(LIMITS.tableRows);
    expect(big[0].length).toBe(LIMITS.tableCols);
    expect(big[0][0].length).toBe(LIMITS.tableCell);
    const t = make({ type: "table" });
    expect(t.cells).toHaveLength(3);
    expect(t.cells[0]).toEqual(["Column 1", "Column 2", "Column 3"]);
    expect(t.header).toBe(true);
    expect(t.text).toBe("");
  });

  it("column widths: weights clamped, null clears, junk dropped", () => {
    expect(cleanColWidths([1, 2, 100, 0])).toEqual([1, 2, 20, 0.05]);
    expect(cleanColWidths(null)).toBeNull();
    expect(cleanColWidths([1, "x"])).toBeUndefined();
    expect(cleanObjectPatch({ cells: [["a"]], header: false, colWidths: [1], rot: 30 }, "table")).toEqual({ cells: [["a"]], header: false, colWidths: [1] });
  });
});

describe("table layout and edits", () => {
  const t = make({ type: "table", x: 0, y: 0, w: 300, h: 90, cells: [["A", "B", "C"], ["1", "2", "3"], ["", "", "long text that wraps across the cell"]], colWidths: [1, 1, 2] });

  it("lays out columns by weight and rows equally, wrapping text in cells", () => {
    const L = tableLayout(t);
    expect(L.xs).toEqual([0, 75, 150, 300]);
    expect(L.rowH).toBe(30);
    expect(L.cells[0].header).toBe(true);
    expect(L.cells[8].lines.at(-1)).toMatch(/…$|cell$/);
    expect(columnFractions({ colWidths: [1] }, 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("finds the cell under a point", () => {
    expect(cellAt(t, { x: 10, y: 10 })).toEqual({ r: 0, c: 0 });
    expect(cellAt(t, { x: 200, y: 80 })).toEqual({ r: 2, c: 2 });
    expect(cellAt(t, { x: 400, y: 10 })).toBeNull();
  });

  it("adds and removes rows (height follows) and columns (weights follow), within limits", () => {
    expect(insertRow(t, 1)).toEqual({ cells: [t.cells[0], ["", "", ""], t.cells[1], t.cells[2]], h: 120 });
    expect(removeRow(t, 0).cells).toEqual([t.cells[1], t.cells[2]]);
    expect(removeRow(make({ type: "table", cells: [["x"]] }), 0)).toBeNull();
    const c = insertColumn(t, 3);
    expect(c.cells[0]).toEqual(["A", "B", "C", ""]);
    expect(c.colWidths).toEqual([1, 1, 2, 1.333]);
    expect(removeColumn(t, 0)).toEqual({ cells: t.cells.map((r) => r.slice(1)), colWidths: [1, 2] });
    const wide = make({ type: "table", cells: [Array.from({ length: LIMITS.tableCols }, () => "")] });
    expect(insertColumn(wide, 0)).toBeNull();
  });

  it("fits columns to their text and writes Markdown", () => {
    const w = fitColumns(make({ type: "table", cells: [["id", "a much longer heading"]] }), textWidth);
    expect(w[0]).toBe(1);
    expect(w[1]).toBeGreaterThan(2);
    expect(tableToMarkdown(make({ type: "table", cells: [["a|b", "c"], ["1", "2"]] }))).toBe("| a\\|b | c |\n| --- | --- |\n| 1 | 2 |");
  });
});

describe("pasted tables", () => {
  it("reads spreadsheet rows, CSV and Markdown; ignores prose", () => {
    expect(parseTable("a\tb\n1\t2\n")).toEqual({ cells: [["a", "b"], ["1", "2"]], header: false });
    expect(parseTable('name,notes\n"Smith, J","said ""hi"""')).toEqual({ cells: [["name", "notes"], ["Smith, J", 'said "hi"']], header: false });
    expect(parseTable("| A | B |\n|---|:---:|\n| 1 | 2 |")).toEqual({ cells: [["A", "B"], ["1", "2"]], header: true });
    expect(parseTable("Hello, world")).toBeNull();
    expect(parseTable("one line\nanother line")).toBeNull();
    expect(parseTable("a,b\nc")).toBeNull();
    const e = tableToEntry("x\ty\n1\t2");
    expect(e.object).toMatchObject({ type: "table", cells: [["x", "y"], ["1", "2"]] });
    expect(e.object.colWidths).toHaveLength(2);
  });
});

describe("diagrams", () => {
  it("defaults, cleaning and render requests", () => {
    const d = make({ type: "diagram", text: "a -> b" });
    expect(d).toMatchObject({ syntax: "d2", layout: "dagre", sketch: false, theme: "light" });
    expect(cleanObjectPatch({ syntax: "plantuml", layout: "tala", sketch: 1, text: "x".repeat(LIMITS.diagramText + 5) }, "diagram")).toEqual({ layout: "tala", text: "x".repeat(LIMITS.diagramText) });
    expect(renderRequest({ ...d, theme: "dark", syntax: "mermaid" })).toEqual({ source: "a -> b", language: "mermaid", layout: "dagre", theme: 200, sketch: false, format: "svg" });
  });

  it("hashes everything a render depends on", () => {
    const d = make({ type: "diagram", text: "a -> b" });
    const h = diagramHash(d);
    expect(diagramHash({ ...d })).toBe(h);
    for (const change of [{ text: "a -> c" }, { layout: "elk" }, { sketch: true }, { theme: "dark" }, { syntax: "mermaid" }]) {
      expect(diagramHash({ ...d, ...change })).not.toBe(h);
    }
    expect(diagramHash({ ...d, x: 99 })).toBe(h);
  });

  it("accepts only SVG documents within the size limit, and reads their size", () => {
    const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"></svg>';
    expect(acceptSvg(new TextEncoder().encode(svg))).toBe(svg);
    expect(acceptSvg("<html><script>alert(1)</script></html>")).toBeNull();
    expect(acceptSvg("x".repeat(10))).toBeNull();
    expect(acceptSvg(42)).toBeNull();
    expect(svgSize(svg)).toEqual({ w: 120, h: 80 });
    expect(svgSize('<svg viewBox="0 0 300 150">')).toEqual({ w: 300, h: 150 });
    expect(svgDataUrl("<svg>é</svg>")).toBe("data:image/svg+xml;base64," + Buffer.from("<svg>é</svg>").toString("base64"));
    expect(renderErrorMessage(new Error("bad\n  syntax"))).toBe("bad syntax");
  });

  it("draws the render as an image only for the current source, else a placeholder with status", () => {
    const d = make({ type: "diagram", x: 0, y: 0, w: 200, h: 100, text: "a -> b" });
    const images = new Map([[d.id, { hash: diagramHash(d), status: "ok", href: "data:image/svg+xml;base64,AAAA" }]]);
    const drawn = serialize(objectNode(d, () => undefined, /** @type {any} */ ({ images })));
    expect(drawn).toContain('<image');
    expect(drawn).toContain('href="data:image/svg+xml;base64,AAAA"');
    const stale = serialize(objectNode({ ...d, text: "a -> c" }, () => undefined, /** @type {any} */ ({ images })));
    expect(stale).not.toContain("<image");
    expect(stale).toContain("Not rendered yet");
    const err = new Map([[d.id, { hash: diagramHash(d), status: "error", error: "line 1: bad <arrow>" }]]);
    const errSvg = serialize(objectNode(d, () => undefined, /** @type {any} */ ({ images: err })));
    expect(errSvg).toContain("Could not render: line 1: bad");
    expect(errSvg).toContain("&lt;arrow&gt;");
    const none = new Map([[d.id, { hash: diagramHash(d), status: "unavailable" }]]);
    expect(serialize(objectNode(d, () => undefined, /** @type {any} */ ({ images: none })))).toContain("Renderer not connected");
    const board = { title: "t", objects: { [d.id]: d } };
    expect(boardToSvg(board, { images })).toContain("<image");
  });

  it("tables render grid, header shading and cell text; code fences in d2 or mermaid become diagrams", () => {
    const t = make({ type: "table", x: 0, y: 0, w: 200, h: 60, cells: [["H1", "H2"], ["<b>", "x"]] });
    const svg = serialize(objectNode(t, () => undefined));
    expect(svg).toContain('fill-opacity="0.14"');
    expect(svg).toContain(">H1<");
    expect(svg).toContain("&lt;b&gt;");
    expect(codeFenceToEntry("```d2\na -> b\n```").object).toMatchObject({ type: "diagram", syntax: "d2", text: "a -> b" });
    expect(codeFenceToEntry("```mermaid\nflowchart LR\n a-->b\n```").object.syntax).toBe("mermaid");
    expect(codeFenceToEntry("```js\nlet a\n```").object.type).toBe("code");
  });

  it("round-trips tables and diagrams through a backup", () => {
    const t = make({ type: "table", cells: [["a", "b"]], header: false, colWidths: [1, 3] });
    const d = { ...make({ type: "diagram", text: "x -> y", syntax: "mermaid", layout: "elk", sketch: true }), id: oid(2) };
    const doc = buildBackup({ title: "t", background: "dots", objects: { [t.id]: t, [d.id]: d } });
    const parsed = parseBackup(JSON.stringify(doc));
    const objs = parsed.entries.map((e) => e.object);
    expect(objs.find((o) => o.type === "table")).toMatchObject({ cells: [["a", "b"]], header: false, colWidths: [1, 3] });
    expect(objs.find((o) => o.type === "diagram")).toMatchObject({ text: "x -> y", syntax: "mermaid", layout: "elk", sketch: true });
    expect(toPortable([t], { [t.id]: t })[0].cells).toEqual([["a", "b"]]);
  });
});
