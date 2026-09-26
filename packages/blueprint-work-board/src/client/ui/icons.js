// @ts-check
// Icons as DOM-built SVG (no markup strings). Workflow-state and priority icons differ by SHAPE,
// not only colour, so meaning never depends on colour alone.

import { svg } from "./dom.js";

const PATHS = {
  plus: "M8 3v10M3 8h10",
  search: "M7 12.5A5.5 5.5 0 1 0 7 1.5a5.5 5.5 0 0 0 0 11ZM11 11l3.5 3.5",
  close: "M4 4l8 8M12 4l-8 8",
  chevronDown: "M4 6l4 4 4-4",
  chevronRight: "M6 4l4 4-4 4",
  board: "M2.5 3h3v10h-3zM6.5 3h3v7h-3zM10.5 3h3v5h-3z",
  list: "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5",
  filter: "M2 3.5h12L9.5 9v4l-3 1.5V9z",
  settings: "M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  check: "M3 8.5l3 3 7-7",
  comment: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z",
  subtask: "M4 2.5v6.5a2 2 0 0 0 2 2h5M9 8.5l2.5 2.5L9 13.5",
  calendar: "M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2.5v3M10.5 2.5v3",
  user: "M8 8a2.7 2.7 0 1 0 0-5.4A2.7 2.7 0 0 0 8 8ZM3 14c.6-2.6 2.6-4 5-4s4.4 1.4 5 4",
  tag: "M2.5 2.5h5.5l6 6-5.5 5.5-6-6zM5.5 5.5h.01",
  estimate: "M5.5 2.5l-1 11M11.5 2.5l-1 11M2.5 6h11M2 10.5h11",
  blocked: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM3.8 12.2l8.4-8.4",
  blocking: "M8 2l6.5 11.5h-13zM8 6.5v3.5M8 12h.01",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  drag: "M6 3.5h.01M10 3.5h.01M6 8h.01M10 8h.01M6 12.5h.01M10 12.5h.01",
  undo: "M5 5.5H10a3.5 3.5 0 0 1 0 7H6M5 5.5l2.5-2.5M5 5.5l2.5 2.5",
  keyboard: "M1.5 4h13v8h-13zM4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M4.5 9.5h7",
  link: "M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1",
  project: "M2.5 5.5h11v8h-11zM5.5 5.5V3h5v2.5",
  cycle: "M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5",
  archive: "M2 3h12v3H2zM3 6v7.5h10V6M6.5 9h3",
  save: "M3 2.5h8l2.5 2.5v8.5h-10.5zM5.5 2.5v3.5h5v-3.5M5 13.5v-4h6v4",
  refresh: "M13.5 8A5.5 5.5 0 1 1 12 4.2M13.5 2v3h-3",
  eye: "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  lanes: "M2.5 3h11M2.5 8h11M2.5 13h11M5 3v10",
  arrowRight: "M3 8h10M9 4l4 4-4 4",
  collapse: "M9.5 3.5L5 8l4.5 4.5",
  expand: "M6.5 3.5L11 8l-4.5 4.5",
  bolt: "M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z",
  sparkle: "M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3z",
  inbox: "M2 9.5l2-6h8l2 6v4H2zM2 9.5h3.5l1 1.5h3l1-1.5H14",
  offline: "M2 2l12 12M5.2 8.8a4 4 0 0 1 3.1-1.2M3 6.5a7 7 0 0 1 2.4-1.4M10.5 5.2a7 7 0 0 1 2.5 1.3M8 12.5h.01",
};

/** @typedef {keyof typeof PATHS} IconName */

/**
 * A 16px line icon, hidden from assistive technology (label the control instead).
 * @param {IconName} name @param {{ size?: number, class?: string }} [opts]
 */
export function icon(name, opts = {}) {
  const size = opts.size ?? 16;
  return svg("svg", { class: `icon ${opts.class ?? ""}`, width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
    svg("path", { d: PATHS[name], fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" }));
}

/**
 * Workflow-state icon by kind (Linear's shapes): triage ◇, backlog dashed ○, unstarted ○,
 * started ◑ (fill grows with position among started states), completed ✓●, canceled ✕●.
 * @param {string} kind @param {string} color @param {{ progress?: number, size?: number }} [opts]
 */
export function stateIcon(kind, color, opts = {}) {
  const size = opts.size ?? 14;
  const box = { class: "icon state-icon", width: size, height: size, viewBox: "0 0 14 14", "aria-hidden": "true", focusable: "false", style: themed(color) };
  const ring = (/** @type {Record<string, any>} */ extra = {}) => svg("circle", { cx: 7, cy: 7, r: 5.5, fill: "none", stroke: "currentColor", "stroke-width": 1.5, ...extra });
  switch (kind) {
    case "triage":
      return svg("svg", box, svg("path", { d: "M7 1.3L12.7 7 7 12.7 1.3 7z", fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linejoin": "round" }),
        svg("path", { d: "M7 4.6L9.4 7 7 9.4 4.6 7z", fill: "currentColor" }));
    case "backlog":
      return svg("svg", box, ring({ "stroke-dasharray": "2 1.6" }));
    case "started": {
      const p = Math.max(0.25, Math.min(0.75, opts.progress ?? 0.5));
      const a = p * 2 * Math.PI;
      const x = 7 + 3 * Math.sin(a), y = 7 - 3 * Math.cos(a);
      return svg("svg", box, ring(), svg("path", { d: `M7 7V4A3 3 0 ${p > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z`, fill: "currentColor" }));
    }
    case "completed":
      return svg("svg", box, svg("circle", { cx: 7, cy: 7, r: 6.2, fill: "currentColor" }),
        svg("path", { d: "M4.3 7.2l1.9 1.9 3.6-3.8", fill: "none", stroke: "var(--surface)", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    case "canceled":
      return svg("svg", box, svg("circle", { cx: 7, cy: 7, r: 6.2, fill: "currentColor" }),
        svg("path", { d: "M5 5l4 4M9 5l-4 4", fill: "none", stroke: "var(--surface)", "stroke-width": 1.6, "stroke-linecap": "round" }));
    default:
      return svg("svg", box, ring());
  }
}

/** @param {string} hex @returns {[number, number, number]} */
function rgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
/** @param {[number, number, number]} c */
function luminance(c) {
  const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** @param {[number, number, number]} a @param {[number, number, number]} b */
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
/** @param {[number, number, number]} c */
const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** @type {Map<string, { light: string, dark: string }>} */
const themedCache = new Map();
/**
 * A user-chosen colour made legible as an icon (≥ 3:1, WCAG 1.4.11) on the light and the dark
 * surface: mixed toward black (light theme) or white (dark theme) only as far as needed.
 * @param {string} color
 */
export function themed(color) {
  let t = themedCache.get(color);
  if (!t) {
    const base = /^#[0-9a-f]{6}$/i.test(color) ? rgb(color) : [128, 128, 128];
    /** @param {[number, number, number]} bg @param {number} target */
    const adjust = (bg, target) => {
      for (let k = 0; k <= 1.0001; k += 0.05) {
        const c = /** @type {[number, number, number]} */ (base.map((v, i) => v + (target - v) * k));
        if (contrast(c, bg) >= 3.1) return hex(c);
      }
      return hex([target, target, target]);
    };
    t = { light: adjust([255, 255, 255], 0), dark: adjust([22, 25, 31], 255) };
    themedCache.set(color, t);
  }
  return { "--c-light": t.light, "--c-dark": t.dark };
}

/**
 * Priority icon: urgent is a filled square with "!", high/medium/low are 3/2/1 filled bars of 3,
 * none is three dashes.
 * @param {number} priority
 */
export function priorityIcon(priority) {
  const box = { class: `icon priority-icon p${priority}`, width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true", focusable: "false" };
  if (priority === 1) {
    return svg("svg", box, svg("rect", { x: 1, y: 1, width: 12, height: 12, rx: 3, fill: "currentColor" }),
      svg("path", { d: "M7 3.6v4.2M7 10.1v.3", stroke: "var(--surface)", "stroke-width": 1.8, "stroke-linecap": "round" }));
  }
  if (priority === 0) {
    return svg("svg", box, ...[2.5, 6, 9.5].map((x) => svg("rect", { x, y: 6.3, width: 2.4, height: 1.4, rx: 0.7, fill: "currentColor", opacity: 0.7 })));
  }
  const filled = priority === 2 ? 3 : priority === 3 ? 2 : 1;
  return svg("svg", box, ...[0, 1, 2].map((i) => svg("rect", {
    x: 1.5 + i * 4, y: 9 - i * 3, width: 3, height: 3 + i * 3, rx: 1, fill: "currentColor", opacity: i < filled ? 1 : 0.25,
  })));
}
