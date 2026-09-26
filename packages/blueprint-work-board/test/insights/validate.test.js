import { describe, expect, it } from "vitest";
import { validateReport, normaliseReport, specKind } from "../../src/shared/insights/validate.js";
import { BUILTIN_REPORTS } from "../../src/shared/insights/builtins.js";

const lite = (/** @type {any} */ extra = {}) => ({ $schema: "https://vega.github.io/schema/vega-lite/v6.json", data: { name: "items" }, mark: "bar", encoding: { x: { field: "state", type: "nominal" }, y: { aggregate: "count" } }, ...extra });
const doc = (/** @type {any} */ spec, /** @type {any} */ extra = {}) => ({ id: "r1", title: "Items by state", dataset: "items", params: {}, query: "", spec, ...extra });
const errs = (/** @type {any} */ d) => validateReport(d).errors.join(" | ");

describe("report validation", () => {
  it("accepts every built-in report", () => {
    for (const r of BUILTIN_REPORTS) expect(validateReport(r), r.id).toMatchObject({ valid: true, errors: [] });
    expect(validateReport(BUILTIN_REPORTS.find((r) => r.id === "dependencies")).kind).toBe("vega");
  });

  it("accepts a plain Vega-Lite spec and normalises the document", () => {
    const r = validateReport(doc(lite()));
    expect(r).toMatchObject({ valid: true, kind: "vega-lite" });
    const n = normaliseReport({ ...doc(lite()), title: "  Items by state ", extra: 1 });
    expect(n).toEqual({ id: "r1", title: "Items by state", description: "", dataset: "items", params: {}, query: "", spec: lite(), kind: "vega-lite" });
  });

  it("detects Vega and Vega-Lite", () => {
    expect(specKind({ marks: [] })).toBe("vega");
    expect(specKind({ mark: "bar" })).toBe("vega-lite");
    expect(specKind({ $schema: "https://vega.github.io/schema/vega/v5.json" })).toBe("vega");
  });

  it("refuses url data, loaders, links and external images, anywhere", () => {
    expect(errs(doc(lite({ data: { url: "https://evil.example/data.json" } })))).toMatch(/data\.url: external data/);
    expect(errs(doc(lite({ layer: [{ data: { name: "items" }, mark: "point", transform: [{ lookup: "key", from: { data: { url: "x.csv" }, key: "k" } }] }] })))).toMatch(/from\.data\.url/);
    expect(errs(doc(lite({ config: { loader: { baseURL: "https://x" } } })))).toMatch(/loader is not allowed/);
    expect(errs(doc(lite({ encoding: { href: { field: "key" } } })))).toMatch(/links \(href\)/);
    expect(errs(doc(lite({ mark: "image", encoding: { url: { value: "https://x/y.png" } } })))).toMatch(/encoding\.url/);
    expect(validateReport(doc(lite({ layer: [{ mark: "image", encoding: { url: { value: "data:image/png;base64,AAAA" } } }] }))).valid).toBe(true);
  });

  it("requires the named dataset and bounds inline data and size", () => {
    expect(errs(doc(lite({ data: { values: [{ a: 1 }] } })))).toMatch(/must read its data from \{ "name": "items" \}/);
    expect(errs(doc(lite({ datasets: { items: [] } })))).toMatch(/datasets\.items/);
    expect(errs(doc({ ...lite(), layer: [{ data: { values: Array.from({ length: 30_000 }, (_, i) => ({ i, text: "x".repeat(10) })) }, mark: "point" }] }))).toMatch(/KiB; the limit is 256 KiB/);
    expect(validateReport(doc(lite({ layer: [{ data: { values: [{ a: 1 }] }, mark: "rule" }] }))).valid).toBe(true);
  });

  it("allows only view pointer and key events in signals and selections", () => {
    const vega = (/** @type {any} */ signals) => doc({ $schema: "https://vega.github.io/schema/vega/v6.json", data: [{ name: "items" }], signals, marks: [] });
    expect(validateReport(vega([{ name: "hover", on: [{ events: "mouseover", update: "datum" }, { events: "@nodes:click", update: "1" }] }])).valid).toBe(true);
    expect(errs(vega([{ name: "tick", on: [{ events: "timer{100}", update: "tick + 1" }] }]))).toMatch(/timer events are not allowed/);
    expect(errs(vega([{ name: "w", on: [{ events: "window:mousemove", update: "1" }] }]))).toMatch(/events from “window” are not allowed/);
    expect(errs(vega([{ name: "w", on: [{ events: { type: "resize", source: "view" }, update: "1" }] }]))).toMatch(/the “resize” event is not allowed/);
    expect(validateReport(doc(lite({ params: [{ name: "pick", select: { type: "point", on: "click" } }] }))).valid).toBe(true);
    expect(errs(doc(lite({ params: [{ name: "pick", select: { type: "point", on: "timer" } }] })))).toMatch(/timer/);
  });

  it("allows only standard Vega transforms and a bare named dataset", () => {
    const vega = (/** @type {any} */ data) => doc({ $schema: "https://vega.github.io/schema/vega/v6.json", data, marks: [] });
    expect(errs(vega([{ name: "items" }, { name: "x", source: "items", transform: [{ type: "evil" }] }]))).toMatch(/transform type "evil" is not allowed/);
    expect(errs(vega([{ name: "items", values: [] }]))).toMatch(/must be a bare \{ "name": "items" \}/);
  });

  it("checks the document fields: id, title, dataset, params, query, schema", () => {
    expect(errs({ ...doc(lite()), id: "Bad Id" })).toMatch(/id must be/);
    expect(errs({ ...doc(lite()), title: "" })).toMatch(/title is required/);
    expect(errs({ ...doc(lite()), dataset: "nope" })).toMatch(/dataset must name a dataset/);
    expect(errs({ ...doc(lite()), dataset: "throughput", spec: lite({ data: { name: "throughput" } }), params: { week: 2 } })).toMatch(/no parameter “week”/);
    expect(errs({ ...doc(lite()), params: { days: { a: 1 } }, dataset: "cycle_time", spec: lite({ data: { name: "cycle_time" } }) })).toMatch(/params\.days must be/);
    expect(errs({ ...doc(lite()), query: "prority:high" })).toMatch(/query: Unknown field/);
    expect(errs(doc(lite({ $schema: "https://example.com/schema.json" })))).toMatch(/\$schema must be/);
    expect(validateReport(null)).toMatchObject({ valid: false });
    expect(validateReport(doc(lite()), { requireId: false }).valid).toBe(true);
    expect(validateReport({ ...doc(lite()), id: undefined }, { requireId: false }).valid).toBe(true);
    expect(() => normaliseReport({ ...doc(lite()), spec: "bar" })).toThrow(/^invalid_request: spec must be/);
  });
});
