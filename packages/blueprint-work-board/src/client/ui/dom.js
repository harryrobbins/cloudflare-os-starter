// @ts-check
// The rendering core. `h` builds elements with text set through textContent only, so record
// contents can never inject markup. `reconcile` updates a keyed list in place: existing nodes are
// reused (keeping focus, scroll and DOM identity), moved only when out of order, created and
// removed as needed.

export { shortDate } from "../../shared/model/work.js";

/**
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs] `on*` keys add listeners; `class`, `text`, `hidden`,
 *   `disabled`, `value`, `checked`, `selected` are properties; `style` an object; everything else
 *   an attribute (null/false/undefined skipped).
 * @param {...any} children strings, nodes, arrays; null/false skipped
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

/** @param {Element} el @param {Record<string, any>|null|undefined} attrs */
function setAttrs(el, attrs) {
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "class") el.setAttribute("class", value);
    else if (key === "text") el.textContent = String(value);
    else if (key === "style" && typeof value === "object") {
      const style = /** @type {HTMLElement} */ (el).style;
      for (const [k, v] of Object.entries(value)) {
        if (k.startsWith("--")) style.setProperty(k, String(v)); else /** @type {any} */ (style)[k] = v;
      }
    }
    else if (key === "hidden" || key === "disabled" || key === "value" || key === "checked" || key === "selected") /** @type {any} */ (el)[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
}

/** @param {Node} el @param {any[]} children */
function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    el.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
}

const SVGNS = "http://www.w3.org/2000/svg";
/**
 * @param {string} tag @param {Record<string, any>|null} [attrs] @param {...any} children
 * @returns {SVGElement}
 */
export function svg(tag, attrs, ...children) {
  const el = /** @type {SVGElement} */ (document.createElementNS(SVGNS, tag));
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

/** Replaces children only when needed. @param {Element} parent @param {...any} children */
export function setChildren(parent, ...children) {
  parent.replaceChildren();
  append(parent, children);
}

/** @param {Element} el @param {string} text */
export function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * Keyed list reconciliation.
 * @template T
 * @param {Element} parent
 * @param {T[]} items
 * @param {{ key: (item: T) => string, create: (item: T) => Element, update?: (el: Element, item: T) => void, before?: Node|null, after?: Node|null }} opts
 *   `after`: a node the list follows (e.g. a top spacer); `before`: a node the list precedes.
 */
export function reconcile(parent, items, opts) {
  /** @type {Map<string, Element>} */
  const existing = new Map();
  for (let n = opts.after ? opts.after.nextSibling : parent.firstChild; n && n !== (opts.before ?? null); n = n.nextSibling) {
    const k = /** @type {Element} */ (n).getAttribute?.("data-key");
    if (k !== null && k !== undefined) existing.set(k, /** @type {Element} */ (n));
  }
  let cursor = opts.after ? opts.after.nextSibling : parent.firstChild;
  const keep = new Set();
  for (const item of items) {
    const key = opts.key(item);
    keep.add(key);
    let el = existing.get(key);
    if (el) opts.update?.(el, item);
    else {
      el = opts.create(item);
      el.setAttribute("data-key", key);
      opts.update?.(el, item);
    }
    if (el !== cursor) parent.insertBefore(el, cursor ?? opts.before ?? null);
    else cursor = cursor.nextSibling;
  }
  // Every kept node now sits before `cursor`; whatever remains up to `before` is stale.
  while (cursor && cursor !== (opts.before ?? null)) {
    const next = cursor.nextSibling;
    parent.removeChild(cursor);
    cursor = next;
  }
}

/** @param {Element|null} el @returns {el is HTMLElement} */
export function isHTMLElement(el) { return Boolean(el && /** @type {any} */ (el).focus); }

/** Moves focus without scrolling the page when supported. @param {HTMLElement|null|undefined} el */
export function focus(el, { scroll = true } = {}) {
  if (!el) return;
  try { el.focus({ preventScroll: !scroll }); } catch { el.focus(); }
  if (scroll) el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

/** Relative time that reads naturally. @param {number|null|undefined} t @param {number} [now] */
export function relativeTime(t, now = Date.now()) {
  if (t === null || t === undefined || !Number.isFinite(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  if (s < 90) return "1 min ago";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 5400) return "1 h ago";
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 172_800) return "yesterday";
  if (s < 30 * 86_400) return `${Math.round(s / 86_400)} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** A stable DOM id fragment from any string. @param {string} s */
export function domId(s) { return s.replace(/[^A-Za-z0-9_-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`); }
