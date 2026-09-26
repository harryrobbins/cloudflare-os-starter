// @ts-check
// Charts under the gadget CSP (no eval): Vega-Lite compiled to Vega, parsed to an AST and run with
// Vega's expression interpreter and the SVG renderer, as in packages/blueprint-procgen-explorer.
// Specs are validated report documents (shared/insights/validate.js) whose rows are supplied here
// from the named dataset; nothing is ever loaded from a URL.
//
// Theme: two named colour schemes registered for the current light/dark theme
// (`workboard-kinds`: a colour per state kind in fixed order; `workboard-series`: categorical
// series), a Vega config (fonts, axes, legends), and signals specs may use for colours:
// ink, muted, surface, line, linkHot, linkCold. Palettes were checked with the dataviz validator
// (CVD and normal-vision separation, both themes); every chart also has a data table.

import { View, parse, scheme } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { compile } from "vega-lite";
import { specKind } from "../../shared/insights/validate.js";
import { h } from "./dom.js";

/** @typedef {"light"|"dark"} Theme */

export const THEMES = {
  light: {
    ink: "#16181d", muted: "#5a6170", surface: "#ffffff", line: "#c9ced6", grid: "#eceef1", linkHot: "#c2410c", linkCold: "#858c99",
    // triage, backlog, unstarted, started, completed, canceled. Hues follow the board's default
    // states where it has a hue (Triage orange, In Progress yellow, Done blue); the order passes the
    // dataviz validator's adjacent-pair CVD (≥ 8, worst 13.2) and normal-vision (≥ 15) checks in
    // both themes, so neighbouring bands in a stack stay distinguishable.
    kinds: ["#eb6834", "#4a3aa7", "#e87ba4", "#eda100", "#2a78d6", "#1baf7a"],
    series: ["#2a78d6", "#eb6834", "#1baf7a"],
  },
  dark: {
    ink: "#eceef2", muted: "#a0a7b4", surface: "#16191f", line: "#3b414c", grid: "#242933", linkHot: "#fb923c", linkCold: "#6d7482",
    kinds: ["#d95926", "#9085e9", "#d55181", "#c98500", "#3987e5", "#199e70"],
    series: ["#3987e5", "#d95926", "#199e70"],
  },
};

/** The current theme from the platform's colour scheme. @param {Window} [win] @returns {Theme} */
export function currentTheme(win = window) {
  return win.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** @param {Theme} theme */
function registerSchemes(theme) {
  const t = THEMES[theme];
  scheme("workboard-kinds", t.kinds);
  scheme("workboard-series", t.series);
  scheme("workboard-plan", [t.series[0], t.muted, t.series[0], t.series[1]]);
}

/** @param {Theme} theme @param {number} [width] */
function config(theme, width = 600) {
  const t = THEMES[theme];
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  return {
    background: null, font, padding: 4,
    view: { stroke: null },
    axis: { labelColor: t.muted, titleColor: t.muted, gridColor: t.grid, domainColor: t.line, tickColor: t.line, labelFontSize: 11, titleFontSize: 11, titleFontWeight: 500, labelFont: font, titleFont: font, labelPadding: 4 },
    legend: { labelColor: t.ink, titleColor: t.muted, labelFontSize: 11, titleFontSize: 11, labelFont: font, titleFont: font, orient: "bottom", direction: "horizontal", symbolSize: 90, columnPadding: 12, ...(width < 460 ? { columns: 3 } : {}) },
    title: { color: t.ink, font },
    text: { fill: t.ink, font },
    range: { category: t.series },
    line: { strokeWidth: 2 }, point: { filled: true },
    mark: { color: t.series[0] },
  };
}

/**
 * A spec ready to run: rows injected under the dataset's name, size and theme applied, compiled to
 * Vega when it is Vega-Lite. Pure apart from the global scheme registry; exported for tests.
 * @param {Record<string, any>} spec @param {string} dataset @param {Record<string, unknown>[]} rows
 * @param {{ width: number, height: number, theme: Theme }} opts
 */
export function prepare(spec, dataset, rows, opts) {
  registerSchemes(opts.theme);
  const t = THEMES[opts.theme];
  const values = rows.map((r) => ({ ...r }));
  const narrow = opts.width < 440;
  /** @type {any} */
  let vega;
  if (specKind(spec) === "vega-lite") {
    const lite = structuredClone(spec);
    presentKinds(lite, values, t.kinds);
    if (narrow) fewerTicks(lite);
    lite.datasets = { ...lite.datasets, [dataset]: values };
    if (lite.width === undefined || lite.width === "container") lite.width = opts.width;
    if (lite.height === undefined || lite.height === "container") lite.height = opts.height;
    lite.autosize = lite.autosize ?? { type: "fit", contains: "padding" };
    lite.config = mergeConfig(config(opts.theme, opts.width), lite.config ?? {});
    vega = compile(/** @type {any} */ (lite)).spec;
  } else {
    vega = structuredClone(spec);
    for (const d of vega.data ?? []) if (d?.name === dataset && d.source === undefined) d.values = values;
    vega.width = opts.width;
    vega.height = opts.height;
    vega.config = mergeConfig(config(opts.theme, opts.width), vega.config ?? {});
  }
  const defined = new Set((vega.signals ?? []).map((/** @type {any} */ s) => s.name));
  const themeSignals = { ink: t.ink, muted: t.muted, surface: t.surface, line: t.line, linkHot: t.linkHot, linkCold: t.linkCold };
  vega.signals = [...(vega.signals ?? []), ...Object.entries(themeSignals).filter(([n]) => !defined.has(n)).map(([name, value]) => ({ name, value }))];
  return vega;
}

const KIND_KEYS = ["triage", "backlog", "unstarted", "started", "completed", "canceled"];
const KIND_NAMES = ["Triage", "Backlog", "Unstarted", "Started", "Completed", "Canceled"];

/**
 * Legends list only the kinds present, while each kind keeps its colour: a `workboard-kinds`
 * scale with an explicit domain gets the domain filtered to values in the rows and an explicit
 * matching range.
 * @param {any} node @param {Record<string, unknown>[]} rows @param {string[]} colors
 */
function presentKinds(node, rows, colors) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) presentKinds(n, rows, colors); return; }
  if (typeof node.field === "string" && node.scale?.scheme === "workboard-kinds" && Array.isArray(node.scale.domain)) {
    const present = new Set(rows.map((r) => r[node.field]));
    const domain = node.scale.domain.filter((/** @type {string} */ v) => present.has(v));
    const index = (/** @type {string} */ v) => Math.max(KIND_NAMES.indexOf(v), KIND_KEYS.indexOf(v));
    if (domain.length && domain.every((/** @type {string} */ v) => index(v) >= 0)) {
      const { scheme: _s, ...rest } = node.scale;
      node.scale = { ...rest, domain, range: domain.map((/** @type {string} */ v) => colors[index(v)]) };
    }
  }
  for (const v of Object.values(node)) presentKinds(v, rows, colors);
}

/** Fewer axis ticks on narrow charts (phones). @param {any} node */
function fewerTicks(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) fewerTicks(n); return; }
  for (const [k, v] of Object.entries(node)) {
    if (k === "axis" && v && typeof v === "object") { v.tickCount = Math.min(Number(v.tickCount) || 4, 4); v.labelFontSize = 10; }
    else fewerTicks(v);
  }
}

/** Deep merge where `b` wins. @param {Record<string, any>} a @param {Record<string, any>} b @returns {Record<string, any>} */
function mergeConfig(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? mergeConfig(a[k], v) : v;
  return out;
}

/**
 * Renders a chart into `container` (SVG). Returns the view and a cleanup function.
 * @param {HTMLElement} container
 * @param {{ spec: Record<string, any>, dataset: string, rows: Record<string, unknown>[], width: number, height: number, theme: Theme,
 *   tooltipHost?: HTMLElement, onClick?: (datum: any) => void }} opts
 */
export async function renderChart(container, opts) {
  const vegaSpec = prepare(opts.spec, opts.dataset, opts.rows, opts);
  const runtime = parse(vegaSpec, undefined, { ast: true });
  const view = new View(runtime, { expr: /** @type {any} */ (expressionInterpreter), renderer: "svg", container, hover: true });
  const tip = opts.tooltipHost ? tooltip(opts.tooltipHost) : null;
  if (tip) view.tooltip(tip.handler);
  if (opts.onClick) view.addEventListener("click", (_e, item) => { const d = /** @type {any} */ (item)?.datum; if (d) opts.onClick?.(d); });
  await view.runAsync();
  const svgEl = container.querySelector("svg");
  if (svgEl) { svgEl.setAttribute("focusable", "false"); svgEl.removeAttribute("aria-roledescription"); }
  return { view, destroy: () => { tip?.hide(); view.finalize(); } };
}

/**
 * A tooltip handler that renders Vega's tooltip value as text (never markup) in a positioned box.
 * @param {HTMLElement} host positioned ancestor of the chart
 */
function tooltip(host) {
  const box = h("div", { class: "chart-tip", role: "presentation", hidden: true });
  host.append(box);
  const hide = () => { box.hidden = true; };
  /** @param {any} _handler @param {MouseEvent} event @param {any} _item @param {any} value */
  const handler = (_handler, event, _item, value) => {
    if (value === null || value === undefined || value === "") { hide(); return; }
    box.replaceChildren();
    if (typeof value === "object") {
      const { title, ...rest } = value;
      if (title) box.append(h("div", { class: "chart-tip-title" }, String(title)));
      const dl = h("dl");
      for (const [k, v] of Object.entries(rest)) dl.append(h("dt", null, k), h("dd", null, formatValue(v)));
      box.append(dl);
    } else box.append(String(value));
    box.hidden = false;
    const r = host.getBoundingClientRect();
    const x = event.clientX - r.left, y = event.clientY - r.top;
    const w = box.offsetWidth || 180;
    box.style.left = `${Math.max(4, Math.min(x + 12, r.width - w - 4))}px`;
    box.style.top = `${Math.max(4, y + 14)}px`;
  };
  host.addEventListener("mouseleave", hide);
  return { handler, hide };
}

/** @param {unknown} v */
function formatValue(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

/**
 * Zooms a rendered graph to its content: the SVG's viewBox is fitted around its marks with
 * padding, up to `maxScale` times larger (small graphs fill the space; big ones shrink to fit).
 * @param {HTMLElement} container @param {{ pad?: number, maxScale?: number }} [opts]
 */
export function fitToContent(container, opts = {}) {
  const svgEl = container.querySelector("svg");
  if (!svgEl) return false;
  const pad = opts.pad ?? 28, maxScale = opts.maxScale ?? 2.2;
  const box = svgEl.getBoundingClientRect();
  const W = Number(svgEl.getAttribute("width")) || box.width, H = Number(svgEl.getAttribute("height")) || box.height;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of svgEl.querySelectorAll("g.mark-symbol path, g.mark-text text, g.mark-path path")) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    x0 = Math.min(x0, r.left - box.left); y0 = Math.min(y0, r.top - box.top); x1 = Math.max(x1, r.right - box.left); y1 = Math.max(y1, r.bottom - box.top);
  }
  if (!Number.isFinite(x0) || !W || !H || !box.width) return false;
  // Client pixels to SVG user units (the SVG may already be scaled by CSS).
  const k = W / box.width;
  const bw = (x1 - x0) * k + pad * 2, bh = (y1 - y0) * k + pad * 2;
  const scale = Math.min(W / bw, H / bh, maxScale);
  const vw = W / scale, vh = H / scale;
  const cx = ((x0 + x1) / 2) * k, cy = ((y0 + y1) / 2) * k;
  svgEl.setAttribute("viewBox", `${(cx - vw / 2).toFixed(1)} ${(cy - vh / 2).toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}`);
  svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
  return true;
}

/** The Vega datum behind a rendered SVG element. @param {Element} el */
const datum = (el) => /** @type {any} */ (el).__data__.datum;

/**
 * Makes the dependency graph's nodes keyboard-operable: one tab stop, arrow keys move between
 * items (in key order), Enter or Space opens the focused item.
 * @param {HTMLElement} container @param {{ label: (datum: any) => string, open: (datum: any) => void, onFocus?: (datum: any|null) => void }} opts
 * @returns {number} how many nodes were made focusable
 */
export function focusableNodes(container, opts) {
  const nodes = /** @type {SVGElement[]} */ ([...container.querySelectorAll("g.mark-symbol.nodes path")])
    .filter((el) => /** @type {any} */ (el).__data__?.datum?.key);
  // Only the nodes speak: Vega's own roles on marks and groups would be unlabelled images.
  const nodeSet = new Set(nodes);
  for (const el of container.querySelectorAll("svg [role], svg [aria-roledescription]")) {
    if (nodeSet.has(/** @type {SVGElement} */ (el))) continue;
    el.removeAttribute("role"); el.removeAttribute("aria-roledescription"); el.removeAttribute("aria-label");
  }
  for (const g of container.querySelectorAll("svg g.mark-path, svg g.mark-text, svg g.mark-symbol:not(.nodes)")) g.setAttribute("aria-hidden", "true");
  nodes.sort((a, b) => String(datum(a).key).localeCompare(String(datum(b).key), undefined, { numeric: true }));
  nodes.forEach((el, i) => {
    el.setAttribute("tabindex", i === 0 ? "0" : "-1");
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", opts.label(datum(el)));
    el.setAttribute("class", `${el.getAttribute("class") ?? ""} dep-node`.trim());
    el.addEventListener("focus", () => opts.onFocus?.(datum(el)));
    el.addEventListener("blur", () => opts.onFocus?.(null));
    el.addEventListener("keydown", (e) => {
      const k = /** @type {KeyboardEvent} */ (e).key;
      let next = -1;
      if (k === "ArrowRight" || k === "ArrowDown") next = Math.min(nodes.length - 1, i + 1);
      else if (k === "ArrowLeft" || k === "ArrowUp") next = Math.max(0, i - 1);
      else if (k === "Home") next = 0;
      else if (k === "End") next = nodes.length - 1;
      else if (k === "Enter" || k === " ") { e.preventDefault(); e.stopPropagation(); opts.open(datum(el)); return; }
      if (next === -1) return;
      e.preventDefault();
      e.stopPropagation();
      for (const n of nodes) n.setAttribute("tabindex", "-1");
      nodes[next].setAttribute("tabindex", "0");
      /** @type {any} */ (nodes[next]).focus();
    });
  });
  return nodes.length;
}
