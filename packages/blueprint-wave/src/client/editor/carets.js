// @ts-check
// Remote carets over a <textarea>. A mirror <div> behind the textarea copies its computed font,
// padding, border, width and wrapping (white-space: pre-wrap; word-wrap: break-word), so a
// character index in the text lands at the same pixel in both. To place a caret the mirror is
// rebuilt as text nodes with a marker <span> at each index; the marker's offset gives the caret
// bar's position. Selections (anchor != head) are highlighted in the mirror itself; bars and name
// tags live in an overlay above the textarea. Everything is pointer-events: none. Recomputed on
// update, scroll and resize, at most once per animation frame. No innerHTML.
//
// A name tag sits just above its caret, where it covers part of the line above, so it is shown only
// while that peer is active: for CARET_TAG_MS after their caret last moved (their encoded head or
// anchor changed; an index shift from someone else's typing does not count) or their name
// changed. On the first line it drops below the caret instead of being clipped.
//
// The UI gives the textarea a transparent background so the mirror's highlights show through,
// and positions `host` (position: relative) around the textarea.

import * as Y from "yjs";
import { decodeBytes } from "../../shared/protocol.js";

const COPIED_STYLES = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "lineHeight", "letterSpacing", "wordSpacing",
  "textTransform", "textIndent", "tabSize", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "boxSizing", "direction",
];

/** How long a peer's name tag stays up after their caret last moved. */
export const CARET_TAG_MS = 2500;

/**
 * Tracks when each peer's caret last moved, to decide whether its name tag shows. Pure (time is
 * passed in).
 */
export function createCaretActivity() {
  /** @type {Map<string, {key: string, at: number}>} */
  const seen = new Map();
  return {
    /**
     * Records the peers' current positions; forgets peers no longer listed.
     * @param {{clientId: string, name?: string, anchor?: string|null, head?: string|null}[]} peers
     * @param {number} now
     */
    touch(peers, now) {
      const live = new Set();
      for (const p of peers) {
        if (!p || typeof p.clientId !== "string") continue;
        live.add(p.clientId);
        const key = `${p.head ?? ""}|${p.anchor ?? ""}|${p.name ?? ""}`;
        const prev = seen.get(p.clientId);
        if (!prev || prev.key !== key) seen.set(p.clientId, { key, at: now });
      }
      for (const id of [...seen.keys()]) if (!live.has(id)) seen.delete(id);
    },
    /** @param {string} clientId @param {number} now */
    tagVisible(clientId, now) {
      const s = seen.get(clientId);
      return !!s && now - s.at < CARET_TAG_MS;
    },
    /** Milliseconds until the next visible tag should hide, or null. @param {number} now */
    nextHide(now) {
      let soonest = null;
      for (const { at } of seen.values()) {
        const left = at + CARET_TAG_MS - now;
        if (left > 0 && (soonest === null || left < soonest)) soonest = left;
      }
      return soonest;
    },
  };
}

/**
 * Decodes a base64 relative position into an index of `text`, or null when it is malformed, points
 * into another type, or no longer resolves.
 * @param {unknown} encoded
 * @param {Y.Doc} doc
 * @param {Y.Text} text
 * @returns {number|null}
 */
export function indexOf(encoded, doc, text) {
  const bytes = typeof encoded === "string" ? decodeBytes(encoded, 512) : null;
  if (!bytes || !bytes.length) return null;
  let rel;
  try {
    rel = Y.decodeRelativePosition(bytes);
  } catch {
    return null;
  }
  if (!rel || (rel.type === null && rel.tname === null && rel.item === null)) return null;
  let abs;
  try {
    abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
  } catch {
    return null;
  }
  if (!abs || abs.type !== text) return null;
  return Math.max(0, Math.min(abs.index, text.length));
}

/**
 * @typedef {{clientId: string, name: string, color: string, anchor: string|null, head: string|null}} PeerCaret
 */

/**
 * Resolves peers' relative positions to indexes, skipping malformed ones. Pure.
 * @param {PeerCaret[]} peers
 * @param {Y.Doc} doc
 * @param {Y.Text} text
 * @returns {{clientId: string, name: string, color: string, anchor: number, head: number}[]}
 */
export function resolveCarets(peers, doc, text) {
  /** @type {{clientId: string, name: string, color: string, anchor: number, head: number}[]} */
  const out = [];
  for (const p of Array.isArray(peers) ? peers : []) {
    if (!p || typeof p !== "object" || typeof p.clientId !== "string") continue;
    const head = indexOf(p.head, doc, text);
    if (head === null) continue;
    const anchor = indexOf(p.anchor, doc, text) ?? head;
    out.push({ clientId: p.clientId, name: typeof p.name === "string" ? p.name : "", color: typeof p.color === "string" ? p.color : "#888888", anchor, head });
  }
  return out;
}

/**
 * @param {any} textarea
 * @param {any} host   an element positioned relative, containing the textarea
 * @param {{doc: Y.Doc, text: Y.Text, document?: any, requestAnimationFrame?: ((fn: () => void) => any)|null}} options
 */
export function createCaretLayer(textarea, host, options) {
  const { doc, text } = options;
  const document = options.document ?? textarea.ownerDocument ?? globalThis.document;
  const win = document?.defaultView ?? globalThis;
  const raf = options.requestAnimationFrame === undefined
    ? (typeof win.requestAnimationFrame === "function" ? win.requestAnimationFrame.bind(win) : (/** @type {() => void} */ fn) => win.setTimeout(fn, 16))
    : options.requestAnimationFrame ?? ((/** @type {() => void} */ fn) => win.setTimeout(fn, 16));

  const mirror = document.createElement("div");
  mirror.className = "wave-caret-mirror";
  mirror.setAttribute("aria-hidden", "true");
  Object.assign(mirror.style, {
    position: "absolute", top: "0", left: "0", overflow: "hidden", pointerEvents: "none", whiteSpace: "pre-wrap",
    wordWrap: "break-word", overflowWrap: "break-word", color: "transparent", zIndex: "0", margin: "0",
  });
  const overlay = document.createElement("div");
  overlay.className = "wave-caret-overlay";
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, { position: "absolute", top: "0", left: "0", overflow: "hidden", pointerEvents: "none", zIndex: "2" });
  host.insertBefore(mirror, host.firstChild);
  host.appendChild(overlay);

  /** @type {PeerCaret[]} */
  let peers = [];
  let scheduled = false;
  let destroyed = false;
  const activity = createCaretActivity();
  /** @type {any} */
  let hideTimer = null;

  function copyStyles() {
    const cs = win.getComputedStyle ? win.getComputedStyle(textarea) : null;
    if (cs) for (const prop of COPIED_STYLES) mirror.style[prop] = cs[prop];
    const width = textarea.offsetWidth + "px";
    const height = textarea.offsetHeight + "px";
    mirror.style.width = width;
    mirror.style.height = height;
    mirror.style.top = textarea.offsetTop + "px";
    mirror.style.left = textarea.offsetLeft + "px";
    overlay.style.width = width;
    overlay.style.height = height;
    overlay.style.top = textarea.offsetTop + "px";
    overlay.style.left = textarea.offsetLeft + "px";
  }

  /** @param {Element} el */
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function render() {
    scheduled = false;
    if (destroyed) return;
    copyStyles();
    clear(mirror);
    clear(overlay);
    const carets = resolveCarets(peers, doc, text);
    const value = text.toString();
    if (hideTimer !== null) { win.clearTimeout(hideTimer); hideTimer = null; }
    if (!carets.length) return;
    const now = Date.now();

    // Cut points: every caret index and selection bound, ascending.
    const points = [...new Set(carets.flatMap((c) => [c.anchor, c.head]))].sort((a, b) => a - b);
    /** @type {Map<number, HTMLElement>} */
    const markers = new Map();
    let cursor = 0;
    for (const p of points) {
      if (p > cursor) mirror.appendChild(segment(value.slice(cursor, p), cursor, p, carets));
      const marker = document.createElement("span");
      marker.className = "wave-caret-marker";
      marker.textContent = "\u200b";
      mirror.appendChild(marker);
      markers.set(p, marker);
      cursor = p;
    }
    if (cursor < value.length) mirror.appendChild(segment(value.slice(cursor), cursor, value.length, carets));
    else mirror.appendChild(document.createTextNode("\u200b"));

    const scrollTop = textarea.scrollTop ?? 0;
    const scrollLeft = textarea.scrollLeft ?? 0;
    for (const c of carets) {
      const marker = markers.get(c.head);
      if (!marker) continue;
      const top = marker.offsetTop - scrollTop;
      const left = marker.offsetLeft - scrollLeft;
      const bar = document.createElement("div");
      bar.className = "wave-caret remote-caret"; // .remote-caret: SEL.remoteCaret (ui-contract.js)
      bar.dataset.clientId = c.clientId;
      Object.assign(bar.style, {
        position: "absolute", top: top + "px", left: left + "px", width: "2px", height: (marker.offsetHeight || 16) + "px",
        background: c.color, pointerEvents: "none",
      });
      if (activity.tagVisible(c.clientId, now)) {
        const tag = document.createElement("span");
        tag.className = "wave-caret-name caret-tag";
        tag.textContent = c.name;
        // Above the caret; below it on the first line, where above would be clipped.
        const below = top < 16;
        Object.assign(tag.style, {
          position: "absolute", left: "0", background: c.color, color: "#ffffff", fontSize: "11px",
          lineHeight: "1.3", padding: "0 4px", whiteSpace: "nowrap", pointerEvents: "none",
          borderRadius: below ? "0 3px 3px 3px" : "3px 3px 3px 0",
          ...(below ? { top: "100%" } : { bottom: "100%" }),
        });
        bar.appendChild(tag);
      }
      overlay.appendChild(bar);
    }
    const wait = activity.nextHide(now);
    if (wait !== null) hideTimer = win.setTimeout(() => { hideTimer = null; schedule(); }, wait + 20);
  }

  /**
   * A text segment of the mirror, wrapped in a highlight span for every selection covering it.
   * @param {string} str
   * @param {number} from
   * @param {number} to
   * @param {ReturnType<typeof resolveCarets>} carets
   */
  function segment(str, from, to, carets) {
    /** @type {Node} */
    let node = document.createTextNode(str);
    for (const c of carets) {
      const lo = Math.min(c.anchor, c.head);
      const hi = Math.max(c.anchor, c.head);
      if (lo === hi || from < lo || to > hi) continue;
      const span = document.createElement("span");
      span.className = "wave-caret-selection";
      span.style.background = c.color;
      span.style.opacity = "0.25";
      span.appendChild(node);
      node = span;
    }
    return node;
  }

  function schedule() {
    if (scheduled || destroyed) return;
    scheduled = true;
    raf(render);
  }

  const onScroll = () => schedule();
  textarea.addEventListener?.("scroll", onScroll);
  textarea.addEventListener?.("input", onScroll);
  win.addEventListener?.("resize", onScroll);
  /** @type {any} */
  let observer = null;
  if (typeof win.ResizeObserver === "function") {
    observer = new win.ResizeObserver(onScroll);
    observer.observe(textarea);
  }

  return {
    /** @param {PeerCaret[]} next */
    update(next) {
      peers = Array.isArray(next) ? next : [];
      activity.touch(peers, Date.now());
      schedule();
    },
    /** Re-measures now (tests and the UI after a remote text change). */
    refresh: schedule,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (hideTimer !== null) win.clearTimeout(hideTimer);
      textarea.removeEventListener?.("scroll", onScroll);
      textarea.removeEventListener?.("input", onScroll);
      win.removeEventListener?.("resize", onScroll);
      observer?.disconnect?.();
      mirror.remove?.();
      overlay.remove?.();
    },
  };
}
