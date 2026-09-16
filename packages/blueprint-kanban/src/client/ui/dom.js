// @ts-check
// Tiny DOM helpers. All user data goes through textContent / attributes, never innerHTML.

/**
 * h("div", {class: "x", onclick: fn, dataset: {id: "1"}}, "text", childEl)
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "dataset") Object.assign(el.dataset, value);
      else if (key === "style" && typeof value === "object") {
        for (const [prop, v] of Object.entries(value)) {
          if (v == null) continue;
          if (prop.startsWith("--")) el.style.setProperty(prop, String(v));
          else /** @type {any} */ (el.style)[prop] = v;
        }
      }
      else if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2), value);
      } else if (key === "value") /** @type {any} */ (el).value = value;
      else if (key === "checked") /** @type {any} */ (el).checked = !!value;
      else if (value === true) el.setAttribute(key, "");
      else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

/**
 * @param {Element} el
 * @param {any[]} children
 */
function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

/** @param {Element} el */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_PATHS = {
  plus: "M12 5v14M5 12h14",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  close: "M6 6l12 12M18 6L6 18",
  chevronLeft: "M15 18l-6-6 6-6",
  chevronRight: "M9 18l6-6-6-6",
  check: "M5 12l5 5L20 7",
  clock: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
  text: "M4 6h16M4 12h16M4 18h10",
  tag: "M20 12l-8 8-9-9V3h8l9 9zM7.5 7.5h.01",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  comment: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  collapse: "M15 18l-6-6 6-6",
  expand: "M9 18l6-6-6-6",
};

/**
 * @param {keyof typeof ICON_PATHS} name
 * @param {number} [size]
 */
export function icon(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICON_PATHS[name]);
  svg.appendChild(path);
  return svg;
}

/** @param {string} name */
export function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return [...parts[0]][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * WCAG relative luminance of a "#rrggbb" colour, or null when it isn't one.
 * @param {string} hex
 */
export function luminance(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio between two luminances.
 * @param {number} a
 * @param {number} b
 */
export function contrastRatio(a, b) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Readable text colour for a "#rrggbb" background: black or white, whichever has the higher
 * WCAG contrast ratio against it.
 * @param {string} hex
 */
export function textOn(hex) {
  const lum = luminance(hex);
  if (lum === null) return "#ffffff";
  return contrastRatio(lum, 0) > contrastRatio(lum, 1) ? "#000000" : "#ffffff";
}

/**
 * @param {string} name
 * @param {string} color
 * @param {string} [extraClass]
 */
export function avatar(name, color, extraClass = "") {
  return h("span", {
    class: "avatar " + extraClass,
    style: { background: color, color: textOn(color) },
    title: name,
    role: "img",
    "aria-label": name,
  }, initials(name));
}

/**
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} ms
 */
export function debounce(fn, ms) {
  /** @type {any} */
  let timer = null;
  /** @type {any[]|null} */
  let lastArgs = null;
  const debounced = (/** @type {any[]} */ ...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; const a = lastArgs; lastArgs = null; fn(...(a || [])); }, ms);
  };
  debounced.flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    const a = lastArgs;
    lastArgs = null;
    fn(...(a || []));
  };
  debounced.cancel = () => { clearTimeout(timer); timer = null; lastArgs = null; };
  debounced.pending = () => timer !== null;
  return debounced;
}

/** Today's date as "YYYY-MM-DD" in local time. */
export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** @param {string} iso "YYYY-MM-DD" */
export function formatDue(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const sameYear = y === new Date().getFullYear();
  return date.toLocaleDateString(undefined, sameYear
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" });
}

/** @param {number} ms */
export function formatTime(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  const diff = Date.now() - ms;
  if (diff >= 0 && diff < 60_000) return "just now";
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff >= 0 && diff < 86_400_000 && date.getDate() === new Date().getDate()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Colours offered for people and labels. */
export const PALETTE = [
  "#c93c3c", "#e8871e", "#c9a100", "#2f9e44", "#0f9d8f",
  "#3b82f6", "#5b5fef", "#9c36b5", "#d6336c", "#6b7280",
];

/** Spoken names for PALETTE, index for index. */
export const PALETTE_NAMES = [
  "Red", "Orange", "Yellow", "Green", "Teal",
  "Blue", "Indigo", "Purple", "Pink", "Grey",
];

/** @param {string} color */
export function colorName(color) {
  const i = PALETTE.indexOf(color);
  return i === -1 ? color : PALETTE_NAMES[i];
}

/** @param {Element} el */
export function isVisible(el) {
  return el.isConnected && el.getClientRects().length > 0;
}

/**
 * Makes every other top-level body child inert (a modal surface is open) and returns a function
 * that undoes exactly what it changed. Live regions and toasts stay reachable.
 * @param {Element[]} keep
 * @returns {() => void}
 */
export function inertOthers(keep) {
  /** @type {HTMLElement[]} */
  const changed = [];
  for (const el of /** @type {HTMLElement[]} */ ([...document.body.children])) {
    if (keep.includes(el) || el.inert || el.matches("script, style, .toasts, .live-region")) continue;
    el.inert = true;
    changed.push(el);
  }
  return () => { for (const el of changed) el.inert = false; };
}

/**
 * Selectors for focusable descendants.
 * @param {Element} root
 * @returns {HTMLElement[]}
 */
export function focusables(root) {
  return /** @type {HTMLElement[]} */ ([...root.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )]).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Keeps Tab focus inside `root`.
 * @param {HTMLElement} root
 * @param {KeyboardEvent} event
 */
export function trapTab(root, event) {
  if (event.key !== "Tab") return;
  const items = focusables(root);
  if (items.length === 0) { event.preventDefault(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * An element that edits a single line of text in place: shows `display`, click → input.
 * @param {object} opts
 * @param {string} opts.className
 * @param {() => string} opts.getValue
 * @param {(value: string) => void} opts.onSave
 * @param {string} opts.label  accessible label
 * @param {number} [opts.maxLength]
 * @param {string} [opts.tag]
 */
export function inlineEditable({ className, getValue, onSave, label, maxLength = 200, tag = "button" }) {
  const wrap = h("span", { class: "inline-edit " + className });
  const display = h(tag, { class: "inline-edit-display", type: tag === "button" ? "button" : null, title: label, "aria-label": `${label}: ${getValue()}` });
  display.textContent = getValue();
  let editing = false;
  wrap.appendChild(display);

  function start() {
    if (editing) return;
    editing = true;
    const input = /** @type {HTMLInputElement} */ (h("input", {
      class: "inline-edit-input", value: getValue(), "aria-label": label, maxlength: maxLength,
    }));
    let done = false;
    const finish = (/** @type {boolean} */ save, /** @type {boolean} */ refocus) => {
      if (done) return;
      done = true;
      editing = false;
      const value = input.value.trim();
      input.replaceWith(display);
      if (save && value && value !== getValue()) onSave(value);
      refresh();
      if (refocus) display.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true, true); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false, true); }
    });
    input.addEventListener("blur", () => finish(true, false));
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    display.replaceWith(input);
    input.focus();
    input.select();
  }

  function refresh() {
    if (editing) return;
    const v = getValue();
    if (display.textContent !== v) display.textContent = v;
    display.setAttribute("aria-label", `${label}: ${v}`);
  }

  display.addEventListener("click", start);
  display.addEventListener("keydown", (e) => { if (e.key === "Enter" && tag !== "button") start(); });
  return { el: wrap, refresh, start, isEditing: () => editing };
}
