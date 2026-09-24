// The icon pack compiler (scripts/build-icon-packs.mjs, scripts/icon-packs/svg-compiler.mjs):
// strict parsing, the allowlist, complexity limits, path normalisation, deterministic output that
// matches the checked-in files, the published-id ledger and the licence notices.
import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  COMPILER_LIMITS, IconCompileError, compileSvg, parsePathData, parseTransform, parseXml,
} from "../../scripts/icon-packs/svg-compiler.mjs";
import {
  GENERATED_BUDGET_BYTES, OUTPUTS, buildIconPacks, cleanTags, geometryHash, labelFromId, ledgerFromFile, reconcileLedger,
} from "../../scripts/build-icon-packs.mjs";
import { PACKS as DECLARED } from "../../scripts/icon-packs/packs.mjs";

const fixtures = new URL("../fixtures/icons/", import.meta.url);
const POLICY = { fillToken: null, strokeWidth: 2 };
const svg = (body, attrs = 'viewBox="0 0 24 24" stroke="currentColor" fill="none"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

/** Expected rejection reason per malicious fixture. */
const MALICIOUS = {
  "script-element": /<script> is not allowed \(scripts\)/,
  "script-text": /text content/,
  "onload-root-hidden": /event attribute onload/,
  onclick: /event attribute onclick/,
  "link-element": /<a> is not allowed \(links\)/,
  "use-xlink": /<use> is not allowed \(references\)/,
  "foreign-object": /<foreignObject> is not allowed/,
  "image-data-uri": /<image> is not allowed/,
  "style-element": /<style> is not allowed \(stylesheets\)/,
  "style-text": /text content/,
  "style-attribute": /inline CSS/,
  "class-attribute": /CSS class/,
  animate: /<animate> is not allowed \(animation\)/,
  "set-element": /<set> is not allowed \(animation\)/,
  "filter-element": /<filter> is not allowed/,
  "filter-attribute": /URL or script value/,
  "mask-element": /<mask> is not allowed/,
  "pattern-element": /<pattern> is not allowed/,
  "clip-path-attribute": /clip-path is not allowed/,
  "gradient-fill": /URL or script value/,
  "javascript-paint": /URL or script value/,
  "skew-transform": /unsupported transform skewX/,
  "unknown-element": /unknown element <blink>/,
  "unknown-attribute": /unknown attribute data-x/,
  "namespaced-attribute": /namespaced attribute xml:space/,
  "named-entity": /unsupported entity reference/,
  "processing-instruction": /processing instructions/,
  cdata: /CDATA/,
  "colour-paint": /unsupported stroke paint red/,
  "text-element": /text content|<text> is not allowed/,
  iframe: /<iframe> is not allowed/,
  "doctype-entities": /DOCTYPE/,
  "html-root": /root element must be <svg>/,
  "no-namespace": /SVG namespace/,
};

const COMPLEXITY = {
  "too-deep": /nested deeper than 5/,
  "out-of-bounds": /outside the viewBox/,
  "huge-number": /number out of range/,
  "long-literal": /numeric literal too long/,
  "huge-arc-outside": /outside the viewBox/,
  "huge-viewbox": /viewBox must be positive and within 1024/,
  empty: /no visible geometry/,
};

describe("compiler: rejection fixtures", () => {
  it("has an expectation for every fixture file", async () => {
    expect((await readdir(new URL("malicious/", fixtures))).map((f) => f.replace(/\.svg$/, "")).sort()).toEqual(Object.keys(MALICIOUS).sort());
    expect((await readdir(new URL("complexity/", fixtures))).map((f) => f.replace(/\.svg$/, "")).sort()).toEqual(Object.keys(COMPLEXITY).sort());
  });

  for (const [name, reason] of Object.entries(MALICIOUS)) {
    it(`rejects malicious ${name}`, async () => {
      const src = await readFile(new URL(`malicious/${name}.svg`, fixtures), "utf8");
      expect(() => compileSvg(src, POLICY)).toThrow(IconCompileError);
      expect(() => compileSvg(src, POLICY)).toThrow(reason);
    });
  }

  for (const [name, reason] of Object.entries(COMPLEXITY)) {
    it(`rejects excessive ${name}`, async () => {
      const src = await readFile(new URL(`complexity/${name}.svg`, fixtures), "utf8");
      expect(() => compileSvg(src, POLICY)).toThrow(reason);
    });
  }

  it("enforces the byte, element, attribute, command and coordinate limits deterministically", () => {
    const pad = "<!--" + "x".repeat(COMPILER_LIMITS.sourceBytes) + "-->";
    expect(() => compileSvg(svg('<path d="M1 1L2 2"/>' + pad), POLICY)).toThrow(/bytes; the limit is 16384/);
    const many = '<path d="M1 1L2 2"/>'.repeat(COMPILER_LIMITS.elements);
    expect(() => compileSvg(svg(many), POLICY)).toThrow(/more than 64 elements/);
    const lines = "M1 1" + "L2 2".repeat(COMPILER_LIMITS.pathCommands);
    expect(() => compileSvg(svg(`<path d="${lines}"/>`), POLICY)).toThrow(/more than 256 path commands/);
    // Under the command cap but over the coordinate cap: a circle is 6 segments and 26 numbers.
    const circles = (n) => svg("<g>" + '<circle cx="12" cy="12" r="5"/>'.repeat(n) + "</g>");
    expect(() => compileSvg(circles(39), POLICY)).not.toThrow();
    expect(() => compileSvg(circles(40), POLICY)).toThrow(/more than 1024 coordinates/);
    const polyline = Array.from({ length: 2100 }, (_, i) => `${i % 24} ${(i * 7) % 24}`).join(" ");
    expect(() => compileSvg(svg(`<polyline points="${polyline}"/>`), POLICY)).toThrow(/path commands|coordinates|longer than/);
    const attrs = Array.from({ length: 17 }, (_, i) => `a${i}="1"`).join(" ");
    expect(() => parseXml(`<svg ${attrs}/>`)).toThrow(/more than 16 attributes/);
    expect(() => compileSvg(svg('<path d="M1 1L2 2" stroke-width="3"/>'), POLICY)).toThrow(/stroke-width must be 2/);
    expect(() => compileSvg(svg('<path d="M1 1L2 2" stroke-linecap="square"/>'), POLICY)).toThrow(/must be round/);
  });

  it("rejects malformed XML", () => {
    for (const bad of [
      "<svg><path></svg>", "<svg xmlns='x'", "<svg a=1/>", '<svg a="1" a="2"/>', "<svg/><svg/>", "text",
      '<svg a="<"/>', "<svg><!-- a -- b --></svg>",
    ]) expect(() => parseXml(bad), bad).toThrow(IconCompileError);
  });
});

describe("compiler: geometry", () => {
  it("normalises every accepted element to absolute M/L/C/Z paths", () => {
    const out = compileSvg(svg(
      '<rect x="2" y="2" width="20" height="10" rx="2"/><circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="6" ry="3"/>' +
      '<line x1="1" y1="1" x2="23" y2="23"/><polyline points="1,1 5,5 9,1"/><polygon points="1 20 5 23 9 20"/>' +
      '<path d="m2 2 h4 v4 H2 V2 z q2 2 4 0 t4 0 c1 1 2 2 3 3 s1 1 2 0 a2 2 0 0 1 4 0"/>'), POLICY);
    expect(out.vb).toEqual([24, 24]);
    expect(out.shapes).toHaveLength(1); // outlines share one path
    const [paint, d] = out.shapes[0];
    expect(paint).toBe("ni");
    expect(d).toMatch(/^[MLCZ0-9. -]+$/);
    expect(d).not.toMatch(/[a-z]|[HVSQTA]/);
  });

  it("converts arcs, quadratics and shorthand curves with the right end points", () => {
    const segs = parsePathData("M0 0Q5 10 10 0T20 0A5 5 0 0 1 30 0");
    const ends = segs.filter((s) => s[0] === "C").map((s) => [Math.round(s[5] * 1000) / 1000, Math.round(s[6] * 1000) / 1000]);
    expect(ends[0]).toEqual([10, 0]);
    expect(ends[1]).toEqual([20, 0]);
    expect(ends.at(-1)).toEqual([30, 0]);
    // A half circle of radius 5 becomes two quarter cubics.
    expect(segs.filter((s) => s[0] === "C")).toHaveLength(4);
    // Degenerate arcs: zero radius is a line, an arc to its start is nothing.
    expect(parsePathData("M0 0A0 5 0 0 1 10 0")).toEqual([["M", 0, 0], ["L", 10, 0]]);
    expect(parsePathData("M0 0A5 5 0 0 1 0 0")).toEqual([["M", 0, 0]]);
    // Compact number syntax: flags glued to numbers, signs as separators.
    expect(parsePathData("M1-2.5.5-1L3,4").map((s) => s.slice(1))).toEqual([[1, -2.5], [0.5, -1], [3, 4]]);
    expect(() => parsePathData("L1 1")).toThrow(/start with a move/);
    expect(() => parsePathData("M1 1 X")).toThrow(/malformed/);
  });

  it("applies translate, scale, rotate and matrix transforms to the coordinates", () => {
    expect(parseTransform("translate(2 3) scale(2)")).toEqual([2, 0, 0, 2, 2, 3]);
    const r = parseTransform("rotate(90 12 12)");
    expect(r.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([0, 1, -1, 0, 24, 0]);
    const out = compileSvg(svg('<g transform="translate(10 0)"><path d="M1 1L2 2" transform="scale(2)"/></g>'), POLICY);
    expect(out.shapes[0][1]).toBe("M12 2L14 4");
    expect(() => parseTransform("scale(0)")).toThrow(/degenerate/);
    expect(() => parseTransform("translate(1 2 3)")).toThrow(/unsupported transform/);
  });

  it("maps paint to roles and drops invisible helper shapes", () => {
    const out = compileSvg(svg(
      '<path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M1 1L5 5"/>' +
      '<circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><rect x="2" y="2" width="4" height="4" fill="#ffffff"/>'),
    { fillToken: "#ffffff", strokeWidth: 2 });
    expect(out.shapes.map((s) => s[0])).toEqual(["ni", "in", "fi"]);
    expect(() => compileSvg(svg('<path d="M1 1L2 2" stroke="#ffffff"/>'), { fillToken: "#ffffff", strokeWidth: 2 }))
      .toThrow(/unsupported stroke paint/);
  });

  it("moves the view box origin to 0,0", () => {
    const out = compileSvg(svg('<path d="M10 10L14 14"/>', 'viewBox="8 8 8 8" stroke="currentColor" fill="none"'), POLICY);
    expect(out).toEqual({ vb: [8, 8], shapes: [["ni", "M2 2L6 6"]] });
  });
});

describe("build: packs, determinism, ledger, notices", () => {
  it("is deterministic and matches the checked-in output (run `node scripts/build-icon-packs.mjs`)", async () => {
    const a = await buildIconPacks();
    const b = await buildIconPacks();
    expect(a.files).toEqual(b.files);
    for (const [path, text] of Object.entries(a.files)) expect(await readFile(path, "utf8"), path).toBe(text);
    expect(a.bytes).toBeLessThanOrEqual(GENERATED_BUDGET_BYTES);
  });

  it("ships a compact Tabler subset covering the required categories, pinned with a hash", async () => {
    const { packs } = await buildIconPacks();
    const tabler = packs.find((p) => p.id === "tabler.1");
    expect(tabler.icons.length).toBeGreaterThanOrEqual(150);
    expect(tabler.icons.length).toBeLessThanOrEqual(250);
    expect(tabler.source).toMatchObject({ package: "@tabler/icons", version: "3.48.0" });
    expect(tabler.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(tabler.categories.map((c) => c.id)).toEqual(expect.arrayContaining(["people", "devices", "files", "actions", "data", "network", "infrastructure"]));
    expect(tabler.licence.spdx).toBe("MIT");
    expect(tabler.licence.text).toContain("Permission is hereby granted, free of charge");
    expect(tabler.licence.text).toContain("Paweł Kuna");
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.devDependencies["@tabler/icons"]).toBe("3.48.0"); // exact, never a range
    const core = packs.find((p) => p.id === "core.1");
    const ids = core.icons.map((i) => i.id);
    for (const id of ["decision", "terminator", "document", "database", "cloud", "queue", "server", "actor"]) expect(ids).toContain(id);
  });

  it("writes the MIT licence text into THIRD_PARTY_NOTICES.md", async () => {
    const notices = await readFile(OUTPUTS.notices, "utf8");
    expect(notices).toContain("@tabler/icons@3.48.0");
    expect(notices).toContain("MIT License");
    expect(notices).toContain("THE SOFTWARE IS PROVIDED \"AS IS\"");
  });

  it("keeps published ids: a changed or removed glyph fails, new ids are added", async () => {
    const { packs } = await buildIconPacks();
    const ledger = ledgerFromFile(JSON.parse(await readFile(OUTPUTS.ledger, "utf8")));
    expect(reconcileLedger(packs, ledger)).toEqual(ledger);
    const db = packs[0].icons.find((i) => i.id === "database");
    expect(ledger["core.1"].database).toBe(geometryHash(db));
    const changed = structuredClone(ledger);
    changed["core.1"].database = "0000000000000000";
    expect(() => reconcileLedger(packs, changed)).toThrow(/core\.1\/database changed geometry/);
    const removed = structuredClone(ledger);
    removed["core.1"]["retired-shape"] = "0123456789abcdef";
    expect(() => reconcileLedger(packs, removed)).toThrow(/core\.1\/retired-shape was published/);
    const fresh = reconcileLedger(packs, {});
    expect(Object.keys(fresh["tabler.1"])).toHaveLength(packs[1].icons.length);
  });

  it("derives labels and cleans tags", () => {
    expect(labelFromId("user-circle")).toBe("User circle");
    expect(cleanTags(["Storage", "storage", "database", 2, "<b>", "a very long tag that is far beyond thirty two chars"], "database"))
      .toEqual(["storage", "2"]);
    expect(DECLARED.map((p) => p.id)).toEqual(["core.1", "tabler.1"]);
  });
});
