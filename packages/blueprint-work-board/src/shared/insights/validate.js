// @ts-check
// Report documents and their validation. A report is `{ id, title, dataset, params, query, spec }`:
// a Vega-Lite or Vega spec whose data comes from a named dataset (datasets/). Specs run inside the
// gadget's sandboxed frame with Vega's AST expression interpreter (no eval), but a spec is still
// untrusted input shared with everyone using the board, so the rules are strict:
//
// - Vega-Lite or Vega JSON only (detected from `$schema`, else from the shape);
// - data comes from `{ "name": "<dataset>" }`; inline `values` are allowed up to 1 MB in total;
//   no `url` anywhere (except a `data:image/…` URI), no `loader`, no `href` links;
// - signal and selection event handlers only for pointer, touch, wheel and key events on the
//   view (no `timer`, no `window:` sources);
// - Vega transforms from the standard list only;
// - the whole document at most 256 KiB of JSON.

import { parse } from "../wql/index.js";
import { datasetDef } from "../datasets/index.js";

export const REPORT_LIMITS = Object.freeze({ bytes: 256 * 1024, inlineBytes: 1024 * 1024, title: 120, description: 500, params: 20, depth: 64, reports: 100 });
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SCHEMA = /^https:\/\/vega\.github\.io\/schema\/(vega|vega-lite)\/v[56](?:\.\d+){0,2}\.json$/;
const EVENTS = new Set([
  "click", "dblclick", "mousedown", "mouseup", "mousemove", "mouseover", "mouseout", "wheel", "contextmenu",
  "pointerdown", "pointerup", "pointermove", "pointerover", "pointerout", "touchstart", "touchmove", "touchend",
  "keydown", "keyup", "keypress", "dragenter", "dragleave", "dragover", "focus", "blur",
]);
const EVENT_SOURCES = new Set(["view", "scope"]);
const VEGA_TRANSFORMS = new Set([
  "aggregate", "bin", "collect", "countpattern", "cross", "crossfilter", "density", "dotbin", "extent", "filter", "flatten",
  "fold", "formula", "identifier", "impute", "joinaggregate", "kde", "lookup", "pivot", "project", "quantile", "sample",
  "sequence", "timeunit", "window", "force", "linkpath", "pie", "stack", "wordcloud", "contour", "geojson", "geopath",
  "geopoint", "geoshape", "graticule", "heatmap", "isocontour", "kde2d", "nest", "pack", "partition", "stratify", "tree",
  "treelinks", "treemap", "label", "loess", "regression", "resolvefilter", "voronoi",
]);

/** @param {unknown} v */
const bytes = (v) => new TextEncoder().encode(JSON.stringify(v) ?? "").byteLength;
/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * The kind of a spec: "vega-lite" or "vega".
 * @param {Record<string, any>} spec
 */
export function specKind(spec) {
  const schema = typeof spec.$schema === "string" ? spec.$schema : "";
  if (schema.includes("/vega-lite/")) return "vega-lite";
  if (schema.includes("/vega/")) return "vega";
  return Array.isArray(spec.marks) ? "vega" : "vega-lite";
}

/**
 * Event types named by a Vega event selector ("mousedown, window:mouseup", "[mousedown, mouseup] > mousemove").
 * @param {string} selector @returns {{ source: string, type: string }[]}
 */
function eventsIn(selector) {
  const out = [];
  const cleaned = selector.replace(/\{[^}]*\}/g, " ").replace(/\[[^\]]*\]\s*>/g, (m) => m.replace(/[[\]>]/g, " ")).replace(/\[[^\]]*\]/g, " ");
  for (const m of cleaned.matchAll(/(?:([a-z]+):)?([a-z@#*.\-_]+)/gi)) {
    const type = m[2];
    if (/^[#.]/.test(type) || type.startsWith("@")) { out.push({ source: "view", type: "mark-filter" }); continue; }
    out.push({ source: (m[1] ?? "view").toLowerCase(), type: type.toLowerCase() });
  }
  return out;
}

/**
 * Validates a report document. Never throws; returns every problem found (up to 20).
 * @param {unknown} doc
 * @param {{ requireId?: boolean }} [opts]
 * @returns {{ valid: boolean, errors: string[], kind: "vega-lite"|"vega"|null, bytes: number }}
 */
export function validateReport(doc, opts = {}) {
  /** @type {string[]} */
  const errors = [];
  const add = (/** @type {string} */ e) => { if (errors.length < 20) errors.push(e); };
  if (!isObject(doc)) return { valid: false, errors: ["A report must be an object: { id, title, dataset, params, query, spec }."], kind: null, bytes: 0 };
  const size = bytes(doc);
  if (size > REPORT_LIMITS.bytes) add(`The report is ${Math.round(size / 1024)} KiB; the limit is ${REPORT_LIMITS.bytes / 1024} KiB.`);
  if (opts.requireId !== false || doc.id !== undefined) {
    if (typeof doc.id !== "string" || !ID.test(doc.id)) add("id must be 1–64 lowercase letters, digits, - or _ (starting with a letter or digit).");
  }
  if (typeof doc.title !== "string" || !doc.title.trim()) add("title is required.");
  else if (doc.title.trim().length > REPORT_LIMITS.title) add(`title can be at most ${REPORT_LIMITS.title} characters.`);
  if (doc.description !== undefined && (typeof doc.description !== "string" || doc.description.length > REPORT_LIMITS.description)) add(`description is text of at most ${REPORT_LIMITS.description} characters.`);
  const def = typeof doc.dataset === "string" ? datasetDef(doc.dataset) : null;
  if (!def) add(`dataset must name a dataset (see datasets()); got ${JSON.stringify(doc.dataset ?? null)}.`);
  if (doc.params !== undefined) {
    if (!isObject(doc.params)) add("params must be an object.");
    else {
      const keys = Object.keys(doc.params);
      if (keys.length > REPORT_LIMITS.params) add("params has too many keys.");
      for (const k of keys) {
        const v = doc.params[k];
        if (def && !(k in (def.params ?? {}))) add(`The ${def.name} dataset has no parameter “${k}”.`);
        if (!["string", "number", "boolean"].includes(typeof v) || (typeof v === "string" && v.length > 200)) add(`params.${k} must be a short string, a number or true/false.`);
      }
    }
  }
  if (doc.query !== undefined) {
    if (typeof doc.query !== "string" || doc.query.length > 2000) add("query is WQL text of at most 2,000 characters.");
    else {
      const { errors: qe } = parse(doc.query);
      if (qe.length) add(`query: ${qe[0].message} (at character ${qe[0].start + 1}).`);
    }
  }
  if (!isObject(doc.spec)) {
    add("spec must be a Vega-Lite or Vega specification object.");
    return { valid: false, errors, kind: null, bytes: size };
  }
  const spec = doc.spec;
  if (spec.$schema !== undefined && (typeof spec.$schema !== "string" || !SCHEMA.test(spec.$schema))) add("$schema must be a Vega-Lite or Vega v5/v6 schema URL, e.g. https://vega.github.io/schema/vega-lite/v6.json.");
  const kind = specKind(spec);
  checkSpec(spec, kind, def?.name ?? String(doc.dataset ?? ""), add);
  return { valid: errors.length === 0, errors, kind, bytes: size };
}

/**
 * @param {Record<string, any>} spec @param {"vega"|"vega-lite"} kind @param {string} dataset @param {(e: string) => void} add
 */
function checkSpec(spec, kind, dataset, add) {
  let inline = 0;
  let readsDataset = false;
  const seen = new Set();
  /** @param {unknown} node @param {string} path @param {number} depth */
  const walk = (node, path, depth) => {
    if (depth > REPORT_LIMITS.depth) { add(`${path} is nested too deeply.`); return; }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1)); return; }
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const at = path ? `${path}.${key}` : key;
      if (key === "url") {
        const s = typeof value === "string" ? value : isObject(value) && typeof value.value === "string" ? value.value : null;
        if (!s || !/^data:image\/(png|gif|jpeg|webp|svg\+xml);/i.test(s)) add(`${at}: external data or images (url) are not allowed; charts read their rows from the dataset.`);
        continue;
      }
      if (key === "loader") { add(`${at}: a loader is not allowed.`); continue; }
      if (key === "href") { add(`${at}: links (href) are not allowed in charts.`); continue; }
      if (key === "values" && (path.endsWith("data") || /data\[\d+\]$/.test(path) || path.startsWith("datasets"))) inline += bytes(value);
      if (key === "name" && typeof value === "string" && value === dataset && (/(^|\.)data$/.test(path) || /^data\[\d+\]$/.test(path))) readsDataset = true;
      if (key === "on" && Array.isArray(value)) {
        for (const h of value) checkEvents(isObject(h) ? h.events : h, `${at}`, add, seen);
      } else if (key === "on" && (typeof value === "string" || isObject(value))) {
        checkEvents(value, at, add, seen);
      }
      if (key === "events" && path.includes("stream")) checkEvents(value, at, add, seen);
      if (kind === "vega" && key === "transform" && Array.isArray(value)) {
        for (const t of value) if (isObject(t) && (typeof t.type !== "string" || !VEGA_TRANSFORMS.has(t.type))) add(`${at}: transform type ${JSON.stringify(t.type)} is not allowed.`);
      }
      walk(value, at, depth + 1);
    }
  };
  walk(spec, "", 0);
  if (kind === "vega-lite" && isObject(spec.datasets) && dataset in spec.datasets) add(`datasets.${dataset}: the dataset's rows are supplied by the board; remove it.`);
  if (kind === "vega" && Array.isArray(spec.data)) {
    const main = spec.data.find((d) => isObject(d) && d.name === dataset);
    if (main && (main.values !== undefined || main.source !== undefined)) add(`data “${dataset}” must be a bare { "name": "${dataset}" }; the board supplies its rows.`);
    if (spec.data.length > 50) add("A spec can declare at most 50 data sources.");
  }
  if (!readsDataset) add(`The spec must read its data from { "name": "${dataset}" }.`);
  if (inline > REPORT_LIMITS.inlineBytes) add(`Inline data is ${Math.round(inline / 1024)} KiB; the limit is 1 MB.`);
}

/** @param {unknown} events @param {string} at @param {(e: string) => void} add @param {Set<string>} seen */
function checkEvents(events, at, add, seen) {
  /** @type {{ source: string, type: string }[]} */
  let list = [];
  if (typeof events === "string") list = eventsIn(events);
  else if (Array.isArray(events)) { for (const e of events) checkEvents(e, at, add, seen); return; }
  else if (isObject(events)) {
    if (events.signal !== undefined && Object.keys(events).length === 1) return;
    if (events.merge || events.between || events.stream) {
      for (const k of ["merge", "between"]) if (Array.isArray(events[k])) for (const e of events[k]) checkEvents(e, at, add, seen);
      if (events.stream) checkEvents(events.stream, at, add, seen);
      if (!events.type) return;
    }
    list = [{ source: String(events.source ?? "view"), type: String(events.type ?? "") }];
  } else return;
  for (const { source, type } of list) {
    if (type === "mark-filter") continue;
    const key = `${at}|${source}|${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (type === "timer") add(`${at}: timer events are not allowed.`);
    else if (!EVENT_SOURCES.has(source)) add(`${at}: events from “${source}” are not allowed; use the view.`);
    else if (!EVENTS.has(type)) add(`${at}: the “${type}” event is not allowed.`);
  }
}

/**
 * A report as stored: validated and normalised (unknown keys dropped). Throws `invalid_request:`.
 * @param {any} input
 */
export function normaliseReport(input) {
  const result = validateReport(input);
  if (!result.valid) throw new Error(`invalid_request: ${result.errors.join(" ")}`);
  return {
    id: /** @type {string} */ (input.id), title: String(input.title).trim(), description: typeof input.description === "string" ? input.description.trim() : "",
    dataset: /** @type {string} */ (input.dataset), params: input.params ?? {}, query: typeof input.query === "string" ? input.query.trim() : "",
    spec: input.spec, kind: result.kind,
  };
}
