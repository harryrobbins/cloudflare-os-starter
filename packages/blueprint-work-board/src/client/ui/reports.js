// @ts-check
// The report editor: title, dataset, filter query, dataset parameters and the Vega-Lite / Vega
// spec as JSON, checked by the gadget server's validator before saving. Also the read-only "View
// spec" for people who cannot edit. Saving a built-in's id customises that built-in for everyone.

import { h, setChildren } from "./dom.js";
import { parse } from "../../shared/wql/index.js";

const LITE = "https://vega.github.io/schema/vega-lite/v6.json";

/** A starting spec for a dataset: a bar per value of its first text column, or a line over days. @param {any} ds */
export function templateSpec(ds) {
  const cols = ds?.columns ?? [];
  const day = cols.find((/** @type {any} */ c) => c.type === "date");
  const num = cols.find((/** @type {any} */ c) => c.type === "number");
  const cat = cols.find((/** @type {any} */ c) => c.type === "string" && !["key", "title", "id"].includes(c.name));
  if (day && num) {
    return { $schema: LITE, data: { name: ds.name }, mark: { type: "line", strokeWidth: 2 },
      encoding: { x: { field: day.name, type: "temporal", scale: { type: "utc" }, title: null }, y: { field: num.name, type: "quantitative" }, ...(cat ? { color: { field: cat.name, type: "nominal", scale: { scheme: "workboard-series" } } } : {}), tooltip: [{ field: day.name, type: "temporal", formatType: "utc", format: "%d %b" }, { field: num.name }] } };
  }
  return { $schema: LITE, data: { name: ds?.name ?? "items" }, mark: { type: "bar", cornerRadiusEnd: 4 },
    encoding: { y: { field: cat?.name ?? "state", type: "nominal", sort: "-x", title: null }, x: { aggregate: "count", type: "quantitative", title: "Items" }, tooltip: [{ field: cat?.name ?? "state" }, { aggregate: "count", title: "Items" }] } };
}

/**
 * @param {{
 *   layers: ReturnType<typeof import("./overlay.js").createLayers>, report: any|null, datasets: any[], canWrite: boolean,
 *   validate: (doc: any) => Promise<{ valid: boolean, errors: string[] }>, save: (doc: any) => Promise<any>, announce: (t: string) => void,
 * }} o
 */
export function openReportEditor(o) {
  const r = o.report;
  const readOnly = !o.canWrite;
  const uid = `re-${Math.random().toString(36).slice(2, 7)}`;
  const title = /** @type {HTMLInputElement} */ (h("input", { type: "text", id: `${uid}-title`, value: r?.title ?? "", maxlength: "120", readonly: readOnly }));
  const dataset = /** @type {HTMLSelectElement} */ (h("select", { id: `${uid}-ds`, disabled: readOnly || Boolean(r?.builtin) },
    o.datasets.map((d) => h("option", { value: d.name, selected: d.name === (r?.dataset ?? "items") }, `${d.title} (${d.name})`))));
  const query = /** @type {HTMLInputElement} */ (h("input", { type: "text", id: `${uid}-q`, value: r?.query ?? "", class: "mono", readonly: readOnly, placeholder: "e.g. label:bug -is:archived", spellcheck: "false" }));
  const queryError = h("p", { class: "field-error", id: `${uid}-qe`, role: "alert" });
  const paramsBox = h("div", { class: "param-grid" });
  const spec = /** @type {HTMLTextAreaElement} */ (h("textarea", { id: `${uid}-spec`, class: "mono spec-edit", rows: "14", spellcheck: "false", readonly: readOnly, "aria-describedby": `${uid}-spec-h` }));
  const errors = h("div", { class: "report-errors", role: "alert" });
  let specTouched = Boolean(r);
  spec.value = JSON.stringify(r?.spec ?? templateSpec(o.datasets.find((d) => d.name === dataset.value)), null, 2);
  spec.addEventListener("input", () => { specTouched = true; });
  /** @type {Record<string, HTMLInputElement>} */
  let params = {};

  function renderParams() {
    const ds = o.datasets.find((d) => d.name === dataset.value);
    params = {};
    const entries = Object.entries(ds?.params ?? {});
    setChildren(paramsBox, entries.length ? entries.map(([name, help]) => {
      const input = /** @type {HTMLInputElement} */ (h("input", { type: "text", id: `${uid}-p-${name}`, value: r && r.dataset === dataset.value && r.params?.[name] !== undefined ? String(r.params[name]) : "", readonly: readOnly, placeholder: "default", "aria-describedby": `${uid}-p-${name}-h` }));
      params[name] = input;
      return h("div", { class: "field" }, h("label", { for: input.id }, name), input, h("p", { class: "hint", id: `${uid}-p-${name}-h` }, String(help)));
    }) : h("p", { class: "hint" }, "This dataset has no parameters."));
    if (!specTouched) spec.value = JSON.stringify(templateSpec(ds), null, 2);
  }
  dataset.addEventListener("change", renderParams);
  query.addEventListener("input", () => { const { errors: qe } = parse(query.value); queryError.textContent = qe.length ? `${qe[0].message} (at character ${qe[0].start + 1})` : ""; });
  renderParams();

  function doc() {
    /** @type {any} */
    let parsed;
    try { parsed = JSON.parse(spec.value); } catch (err) { throw new Error(`The spec is not valid JSON: ${String(/** @type {any} */ (err)?.message ?? err)}`, { cause: err }); }
    /** @type {Record<string, unknown>} */
    const p = {};
    for (const [name, input] of Object.entries(params)) {
      const v = input.value.trim();
      if (v !== "") p[name] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === "true" ? true : v === "false" ? false : v;
    }
    return { ...(r?.id ? { id: r.id } : {}), title: title.value.trim(), description: r?.description ?? "", dataset: dataset.value, query: query.value.trim(), params: p, spec: parsed };
  }

  /** @param {string[]} list */
  function showErrors(list) {
    setChildren(errors, list.length ? [h("p", null, h("strong", null, list.length === 1 ? "1 problem:" : `${list.length} problems:`)), h("ul", null, list.map((e) => h("li", null, e)))] : null);
  }

  async function check() {
    try {
      const v = await o.validate(doc());
      showErrors(v.errors);
      if (v.valid) { setChildren(errors, h("p", { class: "ok-text" }, "The report is valid.")); o.announce("The report is valid."); }
      else o.announce(`${v.errors.length} problems in the report.`);
      return v.valid;
    } catch (err) { showErrors([String(/** @type {any} */ (err)?.message ?? err)]); return false; }
  }

  async function save() {
    try {
      const d = doc();
      if (!d.title) { showErrors(["Give the report a title."]); title.focus(); return; }
      const v = await o.validate(d);
      if (!v.valid) { showErrors(v.errors); /** @type {HTMLElement|null} */ (errors.querySelector("li"))?.focus?.(); o.announce(`Not saved: ${v.errors[0]}`); return; }
      await o.save(d);
      dlg.close("saved");
    } catch (err) { showErrors([String(/** @type {any} */ (err)?.message ?? err).replace(/^[a-z_]+:\s*/, "")]); }
  }

  const dlg = o.layers.openDialog({
    title: readOnly ? `Spec: ${r?.title ?? "report"}` : r ? `Edit “${r.title}”` : "New report", size: "lg", className: "report-editor",
    description: "A report is a Vega-Lite (or Vega) chart of one dataset. Its data comes only from the dataset named in the spec; no URLs, links or timers.",
    content: (close) => [
      h("div", { class: "editor-grid" },
        h("div", { class: "field" }, h("label", { for: title.id }, "Title"), title),
        h("div", { class: "field" }, h("label", { for: dataset.id }, "Dataset"), dataset),
        h("div", { class: "field span" }, h("label", { for: query.id }, "Filter (WQL, combined with the view's filter)"), query, queryError)),
      h("fieldset", { class: "props-fieldset" }, h("legend", null, "Parameters"), paramsBox),
      h("div", { class: "field" }, h("label", { for: spec.id }, "Spec (JSON)"), spec,
        h("p", { class: "hint", id: `${uid}-spec-h` }, "Read the rows with { \"data\": { \"name\": \"<dataset>\" } }. Colour schemes workboard-kinds and workboard-series follow the board's theme.")),
      errors,
      h("div", { class: "row end" },
        h("button", { type: "button", class: "btn ghost", onclick: () => close("cancel") }, readOnly ? "Close" : "Cancel"),
        readOnly ? null : h("button", { type: "button", class: "btn", onclick: () => { void check(); } }, "Check"),
        readOnly ? null : h("button", { type: "button", class: "btn primary", onclick: () => { void save(); } }, "Save report"))],
    initialFocus: () => (readOnly ? spec : title),
  });
  return dlg;
}
