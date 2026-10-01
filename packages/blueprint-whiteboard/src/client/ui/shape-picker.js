// @ts-check
// Pickers for the drawing vocabulary: shapes (the toolbar's Shapes tool, the Add menu and the
// style bar's Shape button), connector end markers and line patterns. Each is a small grid
// popover of icon buttons drawn from the same geometry as the board (src/shared/shapes.js and
// arrowMarker in src/shared/render.js), so a choice looks like what it draws.
//
// Keyboard: focus starts on the current choice; arrow keys move (up and down by a row), Enter or
// Space picks, Escape or Tab closes and returns focus to the button that opened it.

import { h } from "./dom.js";
import { SHAPES, shapeOutline, cmdsToPath, shapeSize, shapeLabel } from "../../shared/shapes.js";
import { arrowMarker } from "../../shared/render.js";
import { buildNode, svgEl } from "./canvas/layers.js";

/** Shape choices in picker order: the rectangle variants with the ellipse (its own type) third. */
export const SHAPE_CHOICES = Object.freeze([
  ...SHAPES.slice(0, 2).map((s) => ({ value: s.id, label: s.label, group: s.group })),
  { value: "ellipse", label: "Ellipse", group: "Basic" },
  ...SHAPES.slice(2).map((s) => ({ value: s.id, label: s.label, group: s.group })),
]);

/** Marker choices for connector ends, in picker order. */
export const MARKER_CHOICES = Object.freeze([
  { value: "none", label: "No marker" },
  { value: "arrow", label: "Arrow" },
  { value: "open", label: "Open arrow" },
  { value: "triangle", label: "Hollow triangle" },
  { value: "diamond", label: "Filled diamond" },
  { value: "diamondOpen", label: "Hollow diamond" },
  { value: "circle", label: "Dot" },
  { value: "bar", label: "Bar" },
  { value: "crow", label: "Crow's foot (many)" },
]);

/** Line pattern choices. */
export const DASH_CHOICES = Object.freeze([
  { value: "solid", label: "Solid line" },
  { value: "dashed", label: "Dashed line" },
  { value: "dotted", label: "Dotted line" },
]);

/** @param {string} value */
export function shapeChoiceLabel(value) {
  return value === "ellipse" ? "Ellipse" : shapeLabel(value);
}

/** @param {number} size */
function iconSvg(size) {
  const svg = svgEl("svg", { viewBox: "0 0 24 24", width: size, height: size, fill: "none", "aria-hidden": "true" });
  svg.classList.add("icon");
  return svg;
}

/**
 * A 24-unit icon of shape `id` ("ellipse" too), outlined in the current colour.
 * @param {string} id @param {number} [size]
 */
export function shapeIcon(id, size = 20) {
  const svg = iconSvg(size);
  const paint = { fill: "none", stroke: "currentColor", "stroke-width": 1.75, "stroke-linejoin": "round" };
  if (id === "ellipse") {
    svg.appendChild(svgEl("ellipse", { cx: 12, cy: 12, rx: 9, ry: 6.5, ...paint }));
    return svg;
  }
  // The shape's own proportions, fitted into 19 x 17 and centred.
  const d = shapeSize(id);
  const k = Math.min(19 / d.w, 17 / d.h);
  const w = d.w * k, hh = d.h * k, x = 12 - w / 2, y = 12 - hh / 2;
  if (id === "rect") {
    svg.appendChild(svgEl("rect", { x, y, width: w, height: hh, rx: 1, ...paint }));
    return svg;
  }
  const g = shapeOutline(id, w, hh);
  for (const b of g.behind ?? []) svg.appendChild(svgEl("path", { d: cmdsToPath(b, x, y), ...paint }));
  svg.appendChild(svgEl("path", { d: cmdsToPath(g.cmds, x, y), ...paint }));
  if (g.detail) svg.appendChild(svgEl("path", { d: cmdsToPath(g.detail, x, y), ...paint }));
  return svg;
}

/**
 * An icon of end marker `kind` at the end (pointing right) or start (pointing left) of a line.
 * @param {string} kind @param {"start"|"end"} end @param {number} [size]
 */
export function markerIcon(kind, end, size = 20) {
  const svg = iconSvg(size);
  const right = end === "end";
  const tip = { x: right ? 21 : 3, y: 12 };
  const mark = arrowMarker(kind, tip, { x: right ? 1 : -1, y: 0 }, 1.75, "currentColor");
  const inset = kind === "none" ? 0 : mark.inset;
  svg.appendChild(svgEl("path", {
    d: right ? `M3 12H${21 - inset}` : `M21 12H${3 + inset}`, stroke: "currentColor", "stroke-width": 1.75, "stroke-linecap": "round",
  }));
  for (const n of mark.nodes) {
    const el = buildNode(n);
    // Hollow markers are filled white on the board; in an icon they stay see-through.
    if (el.getAttribute("fill") === "#ffffff") el.setAttribute("fill", "none");
    svg.appendChild(el);
  }
  return svg;
}

/** A line in pattern `dash`. @param {string} dash @param {number} [size] */
export function dashIcon(dash, size = 20) {
  const svg = iconSvg(size);
  svg.appendChild(svgEl("path", {
    d: "M3 12H21", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round",
    ...(dash === "dashed" ? { "stroke-dasharray": "5 3.5", "stroke-linecap": "butt" } : dash === "dotted" ? { "stroke-dasharray": "0 4" } : {}),
  }));
  return svg;
}

/** @type {{el: HTMLElement, cleanup: () => void}|null} */
let open = null;

/** Closes the open picker, if any. */
export function closePicker() {
  if (!open) return;
  open.cleanup();
  open.el.remove();
  open = null;
}

/**
 * Opens a grid popover of icon choices next to `anchor`.
 * @param {HTMLElement} anchor
 * @param {{label: string, choices: ReadonlyArray<{value: string, label: string, group?: string}>, current: string|null,
 *   icon: (value: string) => Element, onPick: (value: string) => void, columns?: number, className?: string}} opts
 */
export function openPicker(anchor, { label, choices, current, icon, onPick, columns = 4, className = "" }) {
  closePicker();
  const buttons = choices.map((c) => h("button", {
    type: "button", class: "btn icon-only picker-choice", title: c.label, "aria-label": c.label,
    "aria-pressed": String(c.value === current), dataset: { value: c.value },
    onclick: () => { closePicker(); anchor.focus({ preventScroll: true }); onPick(c.value); },
  }, icon(c.value)));
  // Choices with a `group` get a heading before each group (spanning the grid).
  /** @type {HTMLElement[]} */
  const cells = [];
  let group = /** @type {string|null} */ (null);
  choices.forEach((c, i) => {
    const g = /** @type {{group?: string}} */ (c).group;
    if (g && g !== group) {
      group = g;
      cells.push(h("div", { class: "picker-heading", "aria-hidden": "true" }, g));
    }
    cells.push(buttons[i]);
  });
  const pop = h("div", {
    class: "wb-float picker-pop " + className, role: "group", "aria-label": label,
    style: { position: "fixed", zIndex: "45", gridTemplateColumns: `repeat(${columns}, auto)` },
  }, cells);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  // Beside a vertical toolbar, else below (or above when there is no room).
  const beside = anchor.closest("[aria-orientation='vertical']");
  if (beside) {
    pop.style.left = Math.min(r.right + 8, window.innerWidth - pw - 8) + "px";
    pop.style.top = Math.max(8, Math.min(r.top, window.innerHeight - ph - 8)) + "px";
  } else {
    const below = r.bottom + 6 + ph < window.innerHeight;
    pop.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - ph - 6)) + "px";
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8)) + "px";
  }
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault(); e.stopPropagation();
      closePicker(); anchor.focus({ preventScroll: true });
      return;
    }
    const i = buttons.indexOf(/** @type {any} */ (document.activeElement));
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, i + step))]?.focus();
  });
  const onDown = (/** @type {Event} */ e) => {
    if (!pop.contains(/** @type {Node} */ (e.target)) && !anchor.contains(/** @type {Node} */ (e.target))) closePicker();
  };
  setTimeout(() => document.addEventListener("pointerdown", onDown, true));
  open = { el: pop, cleanup: () => document.removeEventListener("pointerdown", onDown, true) };
  (buttons.find((b) => b.getAttribute("aria-pressed") === "true") ?? buttons[0])?.focus();
  return pop;
}
