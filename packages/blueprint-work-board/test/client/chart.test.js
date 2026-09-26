// Every built-in report compiles and renders to SVG with seeded data through Vega's AST
// interpreter (the CSP-safe path the gadget uses), in both themes.
import { describe, expect, it } from "vitest";
import { View, parse } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { prepare, THEMES } from "../../src/client/ui/chart.js";
import { BUILTIN_REPORTS } from "../../src/shared/insights/builtins.js";
import { computeDataset } from "../../src/shared/datasets/index.js";
import { seededContext } from "../datasets-fixture.js";

describe("charts", async () => {
  const { ctx } = await seededContext({ items: 200 });
  for (const report of BUILTIN_REPORTS) {
    it(`renders ${report.id} in light and dark`, async () => {
      const { rows } = computeDataset(report.dataset, ctx, { params: report.params, query: report.query });
      expect(rows.length).toBeGreaterThan(0);
      for (const theme of /** @type {const} */ (["light", "dark"])) {
        const spec = prepare(report.spec, report.dataset, rows, { width: 520, height: 220, theme });
        expect(JSON.stringify(spec)).not.toMatch(/"url"/);
        const view = new View(parse(spec, undefined, { ast: true }), { expr: /** @type {any} */ (expressionInterpreter), renderer: "none" });
        await view.runAsync();
        const svg = await view.toSVG();
        expect(svg).toMatch(/^<svg/);
        expect(svg.length).toBeGreaterThan(1000);
        if (report.id === "cfd") for (const c of THEMES[theme].kinds.slice(1, 5)) expect(svg.toLowerCase()).toContain(c);
        if (report.id === "dependencies") {
          const nodes = view.scenegraph().root.items[0].items.find((/** @type {any} */ m) => m.name === "nodes")?.items ?? [];
          expect(nodes.length).toBe(rows.filter((r) => r.type === "node").length);
          // The force layout placed every node inside the view.
          for (const n of nodes) { expect(n.x).toBeGreaterThan(-40); expect(n.x).toBeLessThan(560); }
        }
        view.finalize();
      }
    });
  }

  it("never lets a spec's own dataset rows through and keeps the spec's own signals", () => {
    const spec = prepare({ $schema: "https://vega.github.io/schema/vega/v6.json", data: [{ name: "items" }], signals: [{ name: "ink", value: "red" }], marks: [] }, "items", [{ a: 1 }], { width: 100, height: 50, theme: "light" });
    expect(spec.data[0].values).toEqual([{ a: 1 }]);
    expect(spec.signals.filter((/** @type {any} */ s) => s.name === "ink")).toEqual([{ name: "ink", value: "red" }]);
    expect(spec.signals.map((/** @type {any} */ s) => s.name)).toEqual(expect.arrayContaining(["muted", "surface", "linkHot"]));
  });
});
