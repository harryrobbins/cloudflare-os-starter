// @ts-check
// Read-view building blocks for the conversation (stream C1): tiny DOM helpers, the Markdown node
// tree -> DOM builder, and the pure maths the conversation lays threads out with (sibling order,
// collapse counts, paragraph-anchor placement, visible ids). Nothing here touches the store or
// `gadget`; everything that builds elements takes a `document` so unit tests can pass a fake.
// User text only ever becomes text nodes; attributes carry validated values (ids, counts, hrefs
// with a safe scheme).

/** @typedef {import("../../shared/markdown.js").Block} Block */
/** @typedef {import("../../shared/markdown.js").Inline} Inline */
/** @typedef {import("../../shared/protocol.js").Blip} Blip */

const SAFE_HREF_RE = /^(https?:\/\/|mailto:)/i;
const BLIP_ID_RE = /^b_[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------------------------
// DOM helpers (local so the conversation does not depend on the shell's dom.js)
// ---------------------------------------------------------------------------------------------

/**
 * h(document, "div", {class: "x", onclick: fn, "data-bid": id}, "text", childEl). Attributes go
 * through setAttribute (never innerHTML); `onXxx` functions become listeners; `dataset` sets
 * data-* attributes; `true` sets a bare attribute; null/false/undefined skip.
 * @param {any} doc
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(doc, tag, attrs, ...children) {
  const node = doc.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key.startsWith("on") && typeof value === "function") {
        if (typeof node.addEventListener === "function") node.addEventListener(key.slice(2), value);
      } else if (key === "dataset" && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) if (v != null && v !== false) node.setAttribute("data-" + k, String(v));
      } else if (key === "value" && "value" in node) {
        node.value = value;
      } else if (value === true) {
        node.setAttribute(key, "");
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  appendAll(doc, node, children);
  return node;
}

/**
 * @param {any} doc
 * @param {any} parent
 * @param {any[]} children
 */
function appendAll(doc, parent, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) appendAll(doc, parent, child);
    else if (typeof child === "object" && typeof child.nodeType === "number") parent.appendChild(child);
    else parent.appendChild(doc.createTextNode(String(child)));
  }
}

/**
 * Element on the page's document.
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs]
 * @param {...any} children
 */
export function el(tag, attrs, ...children) {
  return h(globalThis.document, tag, attrs, ...children);
}

/** Buttons that carry their own complete look instead of the shared .btn (styles.js). */
const SELF_STYLED = /(^|\s)(bliplink|para-reply-btn)(\s|$)/;

/**
 * A `<button type="button">` on the page's document, with the shared `.btn` class (as dom.js's
 * button gives the shell) so the stylesheet's button rules, including the 44 px phone targets,
 * apply; `attrs.class` is added to it. Inline blip links (`bliplink`) and the paragraph gutter
 * button (`para-reply-btn`) keep only their own classes.
 * @param {string} label
 * @param {(e: MouseEvent) => void} onClick
 * @param {Record<string, any>} [attrs]
 * @returns {HTMLButtonElement}
 */
export function button(label, onClick, attrs = {}) {
  const cls = typeof attrs.class === "string" ? attrs.class.trim() : "";
  const className = SELF_STYLED.test(cls) ? cls : cls ? "btn " + cls : "btn";
  return /** @type {HTMLButtonElement} */ (el("button", { type: "button", ...attrs, class: className, onclick: onClick }, label));
}

/** @param {Element} node */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  robot: "M12 2v3M8 5h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3zM9 11h.01M15 11h.01M9 15h6M3 10v4M21 10v4",
  lock: "M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5zM12 15v2",
  reply: "M9 17l-5-5 5-5M4 12h11a5 5 0 0 1 0 10h-1",
  dot: "M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0",
  back: "M19 12H5M12 19l-7-7 7-7",
  more: "M5 12h.01M12 12h.01M19 12h.01",
};

/**
 * A small inline SVG icon (aria-hidden; pair it with visible or sr-only text).
 * @param {keyof typeof ICONS} name
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
  path.setAttribute("d", ICONS[name] ?? ICONS.dot);
  svg.appendChild(path);
  return svg;
}

// ---------------------------------------------------------------------------------------------
// Markdown node tree -> DOM
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} RenderOptions
 * @property {any} [document]                    defaults to the page's document
 * @property {(id: string) => void} [onBlipLink]  bliplinks become buttons calling this; without
 *   it they are anchors to "#<id>" (export)
 */

/**
 * Short display form of a blip id ("b_3f1e…").
 * @param {string} id
 */
export function shortId(id) {
  return id.length > 6 ? id.slice(0, 6) + "…" : id;
}

/**
 * @param {any} doc
 * @param {Inline[]} nodes
 * @param {RenderOptions} opts
 * @returns {any[]}
 */
function inlineNodes(doc, nodes, opts) {
  /** @type {any[]} */
  const out = [];
  for (const n of nodes) {
    switch (n.type) {
      case "text": out.push(doc.createTextNode(n.text)); break;
      case "break": out.push(h(doc, "br")); break;
      case "code": out.push(h(doc, "code", null, n.text)); break;
      case "bold": out.push(h(doc, "strong", null, ...inlineNodes(doc, n.children, opts))); break;
      case "italic": out.push(h(doc, "em", null, ...inlineNodes(doc, n.children, opts))); break;
      case "link":
        if (SAFE_HREF_RE.test(n.href) && !/[\s<>"'`]/.test(n.href)) {
          out.push(h(doc, "a", { href: n.href, rel: "noopener noreferrer", target: "_blank" }, ...inlineNodes(doc, n.children, opts)));
        } else {
          // Not a scheme we open: the label as text (the parser already turns these into text).
          out.push(...inlineNodes(doc, n.children, opts));
        }
        break;
      case "bliplink":
        if (!BLIP_ID_RE.test(n.id)) { out.push(doc.createTextNode(n.id)); break; }
        if (opts.onBlipLink) {
          const fn = opts.onBlipLink;
          out.push(h(doc, "button", {
            type: "button", class: "bliplink", "data-bid": n.id, title: "Go to " + n.id,
            onclick: (/** @type {Event} */ e) => { e.preventDefault(); e.stopPropagation(); fn(n.id); },
          }, shortId(n.id)));
        } else {
          out.push(h(doc, "a", { class: "bliplink", href: "#" + n.id, "data-bid": n.id }, shortId(n.id)));
        }
        break;
    }
  }
  return out;
}

/**
 * One block as an element. Headings map to h3..h5 (the page and the card head own h1/h2).
 * @param {any} doc
 * @param {Block} b
 * @param {RenderOptions} opts
 */
function blockNode(doc, b, opts) {
  switch (b.type) {
    case "paragraph": return h(doc, "p", null, ...inlineNodes(doc, b.children, opts));
    case "heading": return h(doc, "h" + (b.level + 2), { class: "md-heading md-h" + b.level }, ...inlineNodes(doc, b.children, opts));
    case "code": return h(doc, "pre", null, h(doc, "code", null, b.text));
    case "hr": return h(doc, "hr");
    case "quote": return h(doc, "blockquote", null, ...b.children.map((c) => blockNode(doc, c, opts)));
    case "list": {
      const attrs = b.ordered && Number.isInteger(b.first) && b.first !== 1 ? { start: String(b.first) } : null;
      return h(doc, b.ordered ? "ol" : "ul", attrs,
        ...b.items.map((item) => h(doc, "li", null, ...item.children.map((c) => blockNode(doc, c, opts)))));
    }
    default: return h(doc, "p");
  }
}

/**
 * One element per top-level block, in order (the conversation wraps each with its gutter button
 * and paragraph-reply slot).
 * @param {Block[]} blocks
 * @param {RenderOptions} [opts]
 * @returns {any[]}
 */
export function renderBlocks(blocks, opts = {}) {
  const doc = opts.document ?? globalThis.document;
  return blocks.map((b) => blockNode(doc, b, opts));
}

/**
 * The read view of a node tree: a `div.md` holding one element per block. Never innerHTML.
 * @param {Block[]} blocks
 * @param {RenderOptions} [opts]
 * @returns {HTMLElement}
 */
export function renderMarkdown(blocks, opts = {}) {
  const doc = opts.document ?? globalThis.document;
  return h(doc, "div", { class: "md" }, ...renderBlocks(blocks, opts));
}

// ---------------------------------------------------------------------------------------------
// Thread maths (pure)
// ---------------------------------------------------------------------------------------------

/** How many reply levels show before the rest collapse behind "N more replies" (a root is 1). */
export const VISIBLE_DEPTH = 2;

/**
 * @typedef {object} ThreadNode
 * @property {string} id
 * @property {number} depth        1 for a root
 * @property {ThreadNode[]} children  shown children (end- and para-anchored alike; the card
 *   places para-anchored ones after their paragraph)
 * @property {number} hidden       descendants collapsed behind "N more replies" (0 when none)
 * @property {string[]} hiddenIds  those descendants, depth first
 */

/**
 * Siblings in display order: by `order` key (base-62 strings compare with `<`), then creation
 * time, then id, so two clients never disagree.
 * @param {Blip} a @param {Blip} b
 */
export function compareSiblings(a, b) {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * @typedef {object} TreeOptions
 * @property {Set<string>} [expanded]     ids whose collapsed descendants are shown
 * @property {boolean} [expandAll]        focus view and export: nothing collapses
 * @property {(blip: Blip) => boolean} [visible]  extra filter (History mode hides blips created
 *   after the scrubber position); deleted blips are always skipped
 */

/**
 * Root order with the brief pinned first: `rootOrder` ids that exist and are visible, then any
 * visible root the list misses (sorted by order key), then the brief moved to the front.
 * @param {Record<string, Blip>} blips
 * @param {string[]} rootOrder
 * @param {(blip: Blip) => boolean} visible
 * @returns {string[]}
 */
export function orderedRoots(blips, rootOrder, visible) {
  const seen = new Set();
  /** @type {string[]} */
  const roots = [];
  for (const id of rootOrder || []) {
    const b = blips[id];
    if (!b || b.parentId !== null || seen.has(id) || !visible(b)) continue;
    seen.add(id);
    roots.push(id);
  }
  const missing = Object.values(blips).filter((b) => b.parentId === null && !seen.has(b.id) && visible(b)).sort(compareSiblings);
  for (const b of missing) roots.push(b.id);
  const briefAt = roots.findIndex((id) => blips[id].kind === "brief");
  if (briefAt > 0) roots.unshift(roots.splice(briefAt, 1)[0]);
  return roots;
}

/**
 * The thread trees the conversation renders.
 * @param {Record<string, Blip>} blips
 * @param {string[]} rootOrder
 * @param {TreeOptions} [opts]
 * @returns {ThreadNode[]}
 */
export function threadTree(blips, rootOrder, opts = {}) {
  const expanded = opts.expanded ?? new Set();
  const visible = (/** @type {Blip} */ b) => !b.deleted && (opts.visible ? opts.visible(b) : true);
  /** @type {Map<string, Blip[]>} */
  const kids = new Map();
  for (const b of Object.values(blips)) {
    if (b.parentId === null || !visible(b)) continue;
    if (!blips[b.parentId]) continue;
    let list = kids.get(b.parentId);
    if (!list) kids.set(b.parentId, list = []);
    list.push(b);
  }
  for (const list of kids.values()) list.sort(compareSiblings);

  /** @param {string} id @param {string[]} into @param {Set<string>} guard */
  const collectDescendants = (id, into, guard) => {
    for (const c of kids.get(id) ?? []) {
      if (guard.has(c.id)) continue;
      guard.add(c.id);
      into.push(c.id);
      collectDescendants(c.id, into, guard);
    }
  };

  /** @param {string} id @param {number} depth @param {Set<string>} guard @returns {ThreadNode} */
  const build = (id, depth, guard) => {
    /** @type {ThreadNode} */
    const node = { id, depth, children: [], hidden: 0, hiddenIds: [] };
    const children = kids.get(id) ?? [];
    const showChildren = opts.expandAll || depth < VISIBLE_DEPTH || expanded.has(id);
    if (showChildren) {
      for (const c of children) {
        if (guard.has(c.id)) continue;
        guard.add(c.id);
        node.children.push(build(c.id, depth + 1, guard));
      }
    } else if (children.length) {
      collectDescendants(id, node.hiddenIds, guard);
      node.hidden = node.hiddenIds.length;
    }
    return node;
  };

  const guard = new Set();
  return orderedRoots(blips, rootOrder, visible).map((id) => { guard.add(id); return build(id, 1, guard); });
}

/**
 * Ids of the shown cards in reading order (parent before children; para-anchored children keep
 * sibling order here, which matches the DOM order the card produces as long as paragraph order
 * follows text order).
 * @param {ThreadNode[]} nodes
 * @param {string[]} [into]
 */
export function flattenTree(nodes, into = []) {
  for (const n of nodes) {
    into.push(n.id);
    flattenTree(n.children, into);
  }
  return into;
}

/**
 * Ids of the tree's collapsed descendants that need `expanded` to include an ancestor for `id`
 * to show: every ancestor of `id` at depth >= VISIBLE_DEPTH.
 * @param {Record<string, Blip>} blips
 * @param {string} id
 * @returns {string[]}
 */
export function ancestorsToExpand(blips, id) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set([id]);
  let cur = blips[id]?.parentId ?? null;
  const chain = [];
  while (cur && blips[cur] && !seen.has(cur)) { seen.add(cur); chain.push(cur); cur = blips[cur].parentId; }
  // chain is parent, grandparent, ... root. Depth of chain[i] = chain.length - i.
  for (let i = 0; i < chain.length; i++) if (chain.length - i >= VISIBLE_DEPTH) out.push(chain[i]);
  return out;
}

/**
 * The root of a blip's thread (itself for a root; null for an unknown id).
 * @param {Record<string, Blip>} blips
 * @param {string} id
 */
export function rootOf(blips, id) {
  const seen = new Set();
  let cur = blips[id];
  while (cur && cur.parentId !== null && blips[cur.parentId] && !seen.has(cur.id)) { seen.add(cur.id); cur = blips[cur.parentId]; }
  return cur ? cur.id : null;
}

/**
 * Depth of a blip (root 1); 0 for unknown.
 * @param {Record<string, Blip>} blips
 * @param {string} id
 */
export function depthOf(blips, id) {
  let d = 0;
  const seen = new Set();
  let cur = blips[id];
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); d++; cur = cur.parentId === null ? undefined : blips[cur.parentId]; }
  return d;
}

// ---------------------------------------------------------------------------------------------
// Paragraph-anchor placement (pure)
// ---------------------------------------------------------------------------------------------

/**
 * Where para-anchored replies go among a parent's top-level blocks. `replies[i].index` is the
 * resolved absolute character index of the anchor's relative position in the parent's text:
 * null when it cannot be resolved (the text it pointed at was removed), or undefined when the
 * parent's text is not open yet (unknown). A resolved reply goes after the block whose `start`
 * is the largest one <= index (before the first block when the index precedes every block: it
 * then goes after block 0 too, since "after the paragraph the anchor is in" is the only sensible
 * reading). Replies with no block to attach to (no blocks at all) go to `trailing`; unresolved
 * ones to `orphaned` ("was attached to removed text"); unknown ones to `pending` (shown at the
 * end without a note until the text opens).
 * @param {{start: number, end: number}[]} blocks
 * @param {{id: string, index: number|null|undefined}[]} replies
 * @returns {{byBlock: string[][], trailing: string[], orphaned: string[], pending: string[]}}
 */
export function placeParaReplies(blocks, replies) {
  /** @type {string[][]} */
  const byBlock = blocks.map(() => []);
  /** @type {string[]} */
  const trailing = [];
  /** @type {string[]} */
  const orphaned = [];
  /** @type {string[]} */
  const pending = [];
  for (const r of replies) {
    if (r.index === undefined) { pending.push(r.id); continue; }
    if (r.index === null) { orphaned.push(r.id); continue; }
    if (blocks.length === 0) { trailing.push(r.id); continue; }
    let at = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].start <= r.index) at = i;
      else break;
    }
    byBlock[at].push(r.id);
  }
  return { byBlock, trailing, orphaned, pending };
}

/**
 * Human-readable relative time ("just now", "3 minutes ago", "yesterday", or a date).
 * @param {number} ms
 * @param {number} [now]
 */
export function relativeTime(ms, now = Date.now()) {
  if (!ms) return "";
  const diff = now - ms;
  if (diff < 0) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return min === 1 ? "1 minute ago" : `${min} minutes ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const date = new Date(ms);
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * "Alice is editing" / "Alice and Bob are editing" / "Alice, Bob and 2 others are editing".
 * @param {string[]} names
 */
export function editingLabel(names) {
  const unique = [...new Set(names.map((n) => n || "Someone"))];
  if (unique.length === 0) return "";
  if (unique.length === 1) return `${unique[0]} is editing`;
  if (unique.length === 2) return `${unique[0]} and ${unique[1]} are editing`;
  return `${unique[0]}, ${unique[1]} and ${unique.length - 2} other${unique.length - 2 === 1 ? "" : "s"} are editing`;
}
