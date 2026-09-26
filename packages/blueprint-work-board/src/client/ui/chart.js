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
    // triage, backlog, unstarted, started, completed, canceled
    kinds: ["#e87ba4", "#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7"],
    series: ["#2a78d6", "#eb6834", "#1baf7a"],
  },
  dark: {
    ink: "#eceef2", muted: "#a0a7b4", surface: "#16191f", line: "#3b414c", grid: "#242933", linkHot: "#fb923c", linkCold: "#6d7482",
    kinds: ["#d55181", "#3987e5", "#199e70", "#c98500", "#008300", "#9085e9"],
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
}

/** @param {Theme} theme */
function config(theme) {
  const t = THEMES[theme];
  const font = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  return {
    background: null, font, padding: 4,
    view: { stroke: null },
    axis: { labelColor: t.muted, titleColor: t.muted, gridColor: t.grid, domainColor: t.line, tickColor: t.line, labelFontSize: 11, titleFontSize: 11, titleFontWeight: 500, labelFont: font, titleFont: font, labelPadding: 4 },
    legend: { labelColor: t.ink, titleColor: t.muted, labelFontSize: 11, titleFontSize: 11, labelFont: font, titleFont: font, orient: "bottom", direction: "horizontal", symbolSize: 90, columnPadding: 12 },
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
  /** @type {any} */
  let vega;
  if (specKind(spec) === "vega-lite") {
    const lite = structuredClone(spec);
    lite.datasets = { ...(lite.datasets ?? {}), [dataset]: values };
    if (lite.width === undefined || lite.width === "container") lite.width = opts.width;
    if (lite.height === undefined || lite.height === "container") lite.height = opts.height;
    lite.autosize = lite.autosize ?? { type: "fit", contains: "padding" };
    lite.config = mergeConfig(config(opts.theme), lite.config ?? {});
    vega = compile(/** @type {any} */ (lite)).spec;
  } else {
    vega = structuredClone(spec);
    for (const d of vega.data ?? []) if (d?.name === dataset && d.source === undefined) d.values = values;
    vega.width = opts.width;
    vega.height = opts.height;
    vega.config = mergeConfig(config(opts.theme), vega.config ?? {});
  }
  const defined = new Set((vega.signals ?? []).map((/** @type {any} */ s) => s.name));
  const themeSignals = { ink: t.ink, muted: t.muted, surface: t.surface, line: t.line, linkHot: t.linkHot, linkCold: t.linkCold };
  vega.signals = [...(vega.signals ?? []), ...Object.entries(themeSignals).filter(([n]) => !defined.has(n)).map(([name, value]) => ({ name, value }))];
  return vega;
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
 * Makes the dependency graph's nodes keyboard-operable: one tab stop, arrow keys move between
 * items (in key order), Enter or Space opens the focused item.
 * @param {HTMLElement} container @param {{ label: (datum: any) => string, open: (datum: any) => void }} opts
 * @returns {number} how many nodes were made focusable
 */
export function focusableNodes(container, opts) {
  const nodes = /** @type {SVGElement[]} */ ([...container.querySelectorAll("g.mark-symbol.nodes path")])
    .filter((el) => /** @type {any} */ (el).__data__?.datum?.key);
  const datum = (/** @type {Element} */ el) => /** @type {any} */ (el).__data__.datum;
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
