// @ts-check
// DOM helpers for the app shell, plus the pure helpers the shell's unit tests cover (the polite
// announcer's rate limiter, the window.name carry codec, time and size formatting). Nothing here
// touches `document` at module level, so tests can import it in plain Node. All user data goes
// through textContent / attributes, never innerHTML.

import { LIMITS } from "../../shared/protocol.js";

/**
 * el("div", {class: "x", onclick: fn, "data-bid": id, "aria-label": "…"}, "text", childEl)
 *   class / className   the class attribute
 *   dataset: {k: v}     data-* attributes; "data-*" keys work too
 *   on<event>: fn       addEventListener(event) (lower-cased)
 *   style: {} | string  inline style properties (custom properties allowed) or cssText
 *   value, checked, disabled, hidden, selected, readOnly  set as properties
 *   true                a bare attribute; null / undefined / false skip the attribute
 * Children: nodes, strings (text nodes), arrays, or null/false (skipped).
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === "class" || key === "className") node.className = String(value);
      else if (key === "dataset") { for (const [k, v] of Object.entries(value)) if (v != null) node.dataset[k] = String(v); }
      else if (key === "style" && typeof value === "object") {
        for (const [prop, v] of Object.entries(value)) {
          if (v == null) continue;
          if (prop.startsWith("--")) node.style.setProperty(prop, String(v));
          else /** @type {any} */ (node.style)[prop] = v;
        }
      } else if (key === "style") node.style.cssText = String(value);
      else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === "value" || key === "checked" || key === "disabled" || key === "hidden" || key === "selected"
        || key === "readOnly" || key === "indeterminate") /** @type {any} */ (node)[key] = value;
      else if (key === "readonly") /** @type {any} */ (node).readOnly = !!value;
      else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

/** The whiteboard's name for el(); kept so its patterns port over unchanged. */
export const h = el;

/**
 * @param {Element} node
 * @param {any[]} children
 */
function append(node, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

/**
 * A type="button" button. `label` may be a string, a node or an array of both.
 * @param {any} label
 * @param {((e: MouseEvent) => void)|null} [onClick]
 * @param {Record<string, any>} [attrs]
 */
export function button(label, onClick = null, attrs = {}) {
  const b = el("button", { type: "button", class: "btn", ...attrs, onclick: onClick ?? attrs.onclick });
  append(b, [label]);
  return b;
}

/** @param {Element} node */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_PATHS = {
  close: "M6 6l12 12M18 6L6 18",
  check: "M5 12l5 5L20 7",
  chevronDown: "M6 9l6 6 6-6",
  chevronUp: "M6 15l6-6 6 6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  robot: "M12 3v3M8 6h8a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3zM9 12h.01M15 12h.01M9 16h6M3 11v3M21 11v3",
  lock: "M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z",
  history: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 8v4l3 2",
  download: "M12 4v12M6 11l6 6 6-6M4 20h16",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  people: "M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 4a4 4 0 0 1 0 8M22 21a7 7 0 0 0-5-6.7",
  reply: "M9 17l-5-5 5-5M4 12h10a6 6 0 0 1 6 6v2",
  edit: "M4 20h4L19 9l-4-4L4 16zM13 7l4 4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  arrowLeft: "M19 12H5M12 19l-7-7 7-7",
  arrowRight: "M5 12h14M12 5l7 7-7 7",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  flag: "M5 21V4M5 4h12l-2 4 2 4H5",
  warn: "M12 3l10 18H2zM12 10v5M12 18h.01",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  plus: "M12 5v14M5 12h14",
  play: "M6 4l14 8-14 8z",
  stop: "M6 6h12v12H6z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  sparkle: "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2zM5 3v3M3.5 4.5h3M19 17v3M17.5 18.5h3",
  layout: "M4 4h16v16H4zM14 4v16M4 10h10",
};

/**
 * @param {keyof typeof ICON_PATHS} name
 * @param {number} [size]
 */
export function svgIcon(name, size = 16) {
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
  path.setAttribute("d", ICON_PATHS[name] ?? ICON_PATHS.more);
  svg.appendChild(path);
  return svg;
}

/** The whiteboard's name for svgIcon(). */
export const icon = svgIcon;

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

/** @param {string} name */
export function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return [...parts[0]][0].toUpperCase();
  return ([...parts[0]][0] + [...parts[parts.length - 1]][0]).toUpperCase();
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

/** @param {number} a @param {number} b */
export function contrastRatio(a, b) {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Readable text colour on a "#rrggbb" background: black or white, whichever contrasts more.
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
  return el("span", {
    class: "avatar " + extraClass,
    style: { background: color, color: textOn(color) },
    title: name,
    role: "img",
    "aria-label": name,
  }, initials(name));
}

/** Colours offered for people. */
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

// ---------------------------------------------------------------------------------------------
// Formatting (pure)
// ---------------------------------------------------------------------------------------------

/** @param {number} ms @param {number} [now] */
export function formatTime(ms, now = Date.now()) {
  if (!ms) return "";
  const date = new Date(ms);
  const diff = now - ms;
  if (diff >= 0 && diff < 60_000) return "just now";
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff >= 0 && diff < 86_400_000 && date.getDate() === new Date(now).getDate()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "0 B", "512 B", "12.3 KiB", "2.0 MiB". @param {number} bytes */
export function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/** "850 ms", "4.2 s", "1 min 5 s". @param {number} ms */
export function formatDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`;
  const m = Math.floor(n / 60_000);
  const s = Math.round((n - m * 60_000) / 1000);
  return s ? `${m} min ${s} s` : `${m} min`;
}

/**
 * A short label for a blip from its preview: the first line without Markdown heading marks,
 * cut to `max` characters. The brief is "the brief"; an empty blip is "an empty <kind>".
 * @param {import("../../shared/protocol.js").Blip|null|undefined} blip
 * @param {number} [max]
 */
export function blipTitle(blip, max = 48) {
  if (!blip) return "a blip";
  if (blip.kind === "brief") return "the brief";
  const raw = String(blip.preview || "").replace(/^\s*#{1,3}\s*/, "").replace(/\s+/g, " ").trim();
  if (!raw) return blip.kind === "decision" ? "a decision" : blip.kind === "agent" ? "agent output" : blip.kind === "proposal" ? "a proposal" : "an empty note";
  const chars = [...raw];
  return chars.length > max ? chars.slice(0, max - 1).join("").trimEnd() + "…" : raw;
}

/** "3 here" / "1 here" / "Only you". @param {number} others  peers other than the viewer */
export function hereLabel(others) {
  return others <= 0 ? "Only you" : `${others + 1} here`;
}

// ---------------------------------------------------------------------------------------------
// The polite announcer (pure logic; the DOM element is injected)
// ---------------------------------------------------------------------------------------------

/** Gap between announcements of other people's changes. */
export const ANNOUNCE_INTERVAL_MS = 2000;
/** Blank-then-set gap so an identical message is announced again. */
const ANNOUNCE_RESET_MS = 60;

/**
 * Rate-limited announcer: at most one message per `intervalMs`. Messages arriving inside the
 * window are coalesced into the newest one plus "and N more changes" (N counts distinct
 * messages; repeating the same message, as typing does, never inflates it). Never per keystroke.
 * @param {{set: (text: string) => void}|HTMLElement} target
 * @param {{intervalMs?: number, now?: () => number, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout}} [opts]
 * @returns {{announce: (message: string) => void, flush: () => void, pending: () => number}}
 */
export function createAnnouncer(target, {
  intervalMs = ANNOUNCE_INTERVAL_MS, now = Date.now, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout,
} = {}) {
  const set = "set" in target && typeof target.set === "function"
    ? /** @type {(t: string) => void} */ (target.set)
    : (/** @type {string} */ t) => { /** @type {HTMLElement} */ (target).textContent = t; };
  /** @type {string[]} */
  let queue = [];
  /** @type {any} */
  let timer = null;
  /** @type {any} */
  let resetTimer = null;
  let lastAt = -Infinity;

  function flush() {
    if (timer !== null) { ct(timer); timer = null; }
    if (!queue.length) return;
    const last = queue[queue.length - 1];
    const extra = queue.length - 1;
    queue = [];
    lastAt = now();
    const text = extra ? `${last}, and ${extra} more ${extra === 1 ? "change" : "changes"}` : last;
    if (resetTimer !== null) ct(resetTimer);
    set("");
    resetTimer = st(() => { resetTimer = null; set(text); }, ANNOUNCE_RESET_MS);
  }

  return {
    announce(message) {
      const text = String(message || "").trim();
      if (!text) return;
      if (queue[queue.length - 1] === text) return;
      queue = queue.filter((m) => m !== text);
      queue.push(text);
      if (timer !== null) return;
      const wait = Math.max(0, lastAt + intervalMs - now());
      timer = st(() => { timer = null; flush(); }, wait);
    },
    flush,
    pending: () => queue.length,
  };
}

// ---------------------------------------------------------------------------------------------
// window.name carry (pure)
// ---------------------------------------------------------------------------------------------

/** The only key the Wave writes into window.name (which other pages in the tab could read). */
export const CARRY_PREFIX = "wave:";
/** Bound on the unsaved editor text carried across a self-reload (UTF-8 bytes). */
export const CARRY_TEXT_MAX_BYTES = 16 * 1024;
/**
 * Bound on the carried unacknowledged Yjs update (base64 characters, about 256 KiB decoded). A
 * larger one is dropped: the text alone is then handed back to copy, never appended.
 */
export const CARRY_UPDATE_MAX_CHARS = 344 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const PARTICIPANT_RE = /^[A-Za-z0-9:_-]{1,64}$/;
const BLIP_RE = /^b_[0-9a-f]{12}$/;

/**
 * @typedef {object} Carry
 * @property {string|null} name
 * @property {string|null} color
 * @property {string|null} participantId
 * @property {number|null} sinceSeq
 * @property {number[]} reloads        timestamps of recent self-reloads
 * @property {{blipId: string, text: string, update: string|null}|null} pending  unsaved editor
 *   text (to show) and the unacknowledged local Yjs edits (base64, to re-apply); update is null
 *   when there was none or it was too large
 */

/** @param {string} s */
function utf8Length(s) {
  let n = 0;
  for (const ch of s) {
    const c = /** @type {number} */ (ch.codePointAt(0));
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * Cuts `text` so its UTF-8 size is at most `maxBytes` (never splitting a code point).
 * @param {string} text @param {number} [maxBytes]
 */
export function boundText(text, maxBytes = CARRY_TEXT_MAX_BYTES) {
  let s = String(text ?? "");
  if (utf8Length(s) <= maxBytes) return s;
  const chars = [...s];
  let lo = 0, hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Length(chars.slice(0, mid).join("")) <= maxBytes) lo = mid; else hi = mid - 1;
  }
  return chars.slice(0, lo).join("");
}

/** @param {unknown} update */
function carriedUpdate(update) {
  return typeof update === "string" && update.length <= CARRY_UPDATE_MAX_CHARS && update.length % 4 === 0 && BASE64_RE.test(update)
    ? update
    : null;
}

/**
 * @param {Partial<Carry>} data
 * @returns {string}
 */
export function encodeCarry(data) {
  const pending = data.pending && BLIP_RE.test(data.pending.blipId) && data.pending.text
    ? { blipId: data.pending.blipId, text: boundText(data.pending.text), update: carriedUpdate(data.pending.update) }
    : null;
  return CARRY_PREFIX + JSON.stringify({
    name: data.name || null,
    color: data.color && COLOR_RE.test(data.color) ? data.color.toLowerCase() : null,
    participantId: data.participantId && PARTICIPANT_RE.test(data.participantId) ? data.participantId : null,
    sinceSeq: Number.isInteger(data.sinceSeq) && /** @type {number} */ (data.sinceSeq) >= 0 ? data.sinceSeq : null,
    reloads: (data.reloads ?? []).filter((t) => typeof t === "number" && Number.isFinite(t)).slice(-10),
    pending,
  });
}

/**
 * Never throws; anything malformed becomes the empty carry.
 * @param {unknown} raw
 * @returns {Carry}
 */
export function decodeCarry(raw) {
  /** @type {Carry} */
  const empty = { name: null, color: null, participantId: null, sinceSeq: null, reloads: [], pending: null };
  try {
    if (typeof raw !== "string" || !raw.startsWith(CARRY_PREFIX)) return empty;
    const data = JSON.parse(raw.slice(CARRY_PREFIX.length));
    if (!data || typeof data !== "object") return empty;
    const name = typeof data.name === "string" ? data.name.trim().slice(0, LIMITS.displayName) : "";
    const p = data.pending;
    const pending = p && typeof p === "object" && typeof p.blipId === "string" && BLIP_RE.test(p.blipId)
      && typeof p.text === "string" && p.text
      ? { blipId: p.blipId, text: boundText(p.text), update: carriedUpdate(p.update) }
      : null;
    return {
      name: name || null,
      color: typeof data.color === "string" && COLOR_RE.test(data.color) ? data.color.toLowerCase() : null,
      participantId: typeof data.participantId === "string" && PARTICIPANT_RE.test(data.participantId) ? data.participantId : null,
      sinceSeq: Number.isInteger(data.sinceSeq) && data.sinceSeq >= 0 ? data.sinceSeq : null,
      reloads: Array.isArray(data.reloads) ? data.reloads.filter((/** @type {unknown} */ t) => typeof t === "number" && Number.isFinite(t)) : [],
      pending,
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------------------------
// Focus helpers
// ---------------------------------------------------------------------------------------------

/** @param {Element} node */
export function isVisible(node) {
  return node.isConnected && node.getClientRects().length > 0;
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
  for (const node of /** @type {HTMLElement[]} */ ([...document.body.children])) {
    if (keep.includes(node) || node.inert || node.matches("script, style, .toasts, .live-region")) continue;
    node.inert = true;
    changed.push(node);
  }
  return () => { for (const node of changed) node.inert = false; };
}

/**
 * Focusable descendants, in DOM order.
 * @param {Element} root
 * @returns {HTMLElement[]}
 */
export function focusables(root) {
  return /** @type {HTMLElement[]} */ ([...root.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )]).filter((node) => node.offsetParent !== null || node === document.activeElement);
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
 * Roving tabindex for a toolbar or tab strip: one Tab stop; arrow keys (either axis), Home and
 * End move focus between its buttons. Text inputs inside keep their own Tab stop and arrow keys.
 * Call refresh() after rebuilding the buttons.
 * @param {HTMLElement} container
 * @param {{items?: () => HTMLElement[], onMove?: (el: HTMLElement) => void}} [opts]
 */
export function rovingFocus(container, { items, onMove } = {}) {
  const list = () => (items ? items() : /** @type {HTMLElement[]} */ ([...container.querySelectorAll("button")]))
    .filter((node) => node.isConnected && !node.hidden && !(/** @type {HTMLButtonElement} */ (node).disabled) && node.getClientRects().length > 0);
  /** @param {HTMLElement} current */
  const setCurrent = (current) => {
    for (const node of container.querySelectorAll("button")) node.setAttribute("tabindex", node === current ? "0" : "-1");
  };
  container.addEventListener("keydown", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (e.ctrlKey || e.metaKey || e.altKey || t.closest("input, textarea, select")) return;
    const all = list();
    const i = all.indexOf(t);
    if (i < 0) return;
    const n = all.length;
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n
        : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setCurrent(all[next]);
    all[next].focus();
    onMove?.(all[next]);
  });
  container.addEventListener("focusin", (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    if (t instanceof HTMLButtonElement && container.contains(t)) setCurrent(t);
  });
  return {
    /** Keeps exactly one Tab stop: the focused button, else the current, else `preferred`, else the first. @param {HTMLElement|null} [preferred] */
    refresh(preferred = null) {
      const all = list();
      const buttons = /** @type {HTMLElement[]} */ ([...container.querySelectorAll("button")]);
      const active = /** @type {HTMLElement|null} */ (document.activeElement);
      const current = (preferred && all.includes(preferred) ? preferred : null)
        || (active && buttons.includes(active) && active)
        || all.find((node) => node.getAttribute("tabindex") === "0")
        || all[0] || buttons[0];
      if (current) setCurrent(current);
    },
    first: () => list()[0] ?? null,
  };
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

/** @param {EventTarget|null} target */
export function isTextField(target) {
  const t = /** @type {HTMLElement|null} */ (target);
  const field = !!t && typeof t.closest === "function"
    ? t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']") : null;
  if (!field) return false;
  // Range sliders (the History scrubber), checkboxes and buttons take keys but hold no text:
  // Escape and undo there belong to the app.
  if (String(field.tagName).toUpperCase() === "INPUT") return TEXT_INPUT_TYPES.has(String(/** @type {HTMLInputElement} */ (field).type || "text").toLowerCase());
  return true;
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number", "date", "datetime-local", "month", "time", "week"]);

/**
 * Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y as "undo" / "redo", else null. Pure.
 * @param {{key: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean}} e
 * @returns {"undo"|"redo"|null}
 */
export function undoAction(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = (e.key || "").toLowerCase();
  if (k === "z") return e.shiftKey ? "redo" : "undo";
  if (k === "y" && !e.shiftKey) return "redo";
  return null;
}

/** The phone layout breakpoint (see styles.js). */
export const PHONE_QUERY = "(max-width: 720px)";

export function isPhone() {
  return typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;
}
