// @ts-check
// How objects look, as a small virtual node tree. The client turns a node into SVG DOM elements
// (one <g> per object, patched per object), and the server serialises the same nodes into the SVG
// export, so an export is the board as drawn. No DOM access here.

import { fmt, center, connectorRoute, penWorldPoints, polylineMidpoint, strokePathD, textLayout, textWidth, fitCamera, boardBounds, rotatedBounds } from "./geometry.js";
import { DEFAULT_TITLE, sortedObjects } from "./protocol.js";
import { getIcon, iconPaths, iconPlacement, iconTextBox, DEFAULT_ICON_STROKE, DEFAULT_INK } from "./icons/registry.js";
import { codeLayout, fitColumns, CODE_FONT_FAMILY, CODE_CHAR_EM } from "./code/layout.js";
import { codeTheme } from "./code/theme.js";
import { truncateText } from "./graphemes.js";
import { routePathD, routeEndDirections, routeMidpoint, createRouteEnv } from "./connectors.js";

/** @typedef {import("./protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("./protocol.js").BoardSnapshot} BoardSnapshot */

/**
 * @typedef {object} VNode
 * @property {string} tag                              SVG element name
 * @property {Record<string, string|number>} attrs     attribute values (already formatted)
 * @property {VNode[]} [children]
 * @property {string} [text]                           text content (for <tspan>, <title>)
 */

export const SVG_NS = "http://www.w3.org/2000/svg";
// The emoji fonts at the end let emoji use the system's colour emoji font everywhere, including a
// downloaded SVG; no emoji images are bundled, so emoji look different on different systems.
export const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'";

/**
 * Looks up an object's geometry by id; the client passes one that prefers ghost transforms, so a
 * connector follows an object being dragged.
 * @typedef {(id: string) => WhiteboardObject|undefined} Resolve
 */

/**
 * @param {string} tag @param {Record<string, string|number|null|undefined>} attrs @param {VNode[]} [children]
 * @returns {VNode}
 */
export function h(tag, attrs, children) {
  /** @type {Record<string, string|number>} */
  const a = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) a[k] = typeof v === "number" ? fmt(v) : v;
  return children ? { tag, attrs: a, children } : { tag, attrs: a };
}

/**
 * Text lines of an object as a <text> node, or null when it has no text.
 * @param {WhiteboardObject} o
 * @returns {VNode|null}
 */
export function textNode(o) {
  if (!o.text || o.type === "pen" || o.type === "connector" || o.type === "code") return null;
  if (o.type === "icon" && !iconTextBox(o)) return null;
  const layout = textLayout(o);
  if (!layout.lines.length) return null;
  const x = layout.anchor === "middle" ? layout.x + layout.w / 2 : layout.anchor === "end" ? layout.x + layout.w : layout.x;
  const color = o.type === "frame" ? "#4b5563" : o.style.textColor;
  return h("text", {
    x, y: layout.firstBaseline, "font-size": o.style.fontSize, "font-family": FONT_FAMILY,
    "font-weight": o.type === "frame" ? "600" : null,
    fill: color, "text-anchor": layout.anchor, style: "white-space:pre",
  }, layout.lines.map((line, i) => ({
    tag: "tspan",
    attrs: { x: fmt(x), ...(i === 0 ? {} : { dy: fmt(layout.lineHeight) }) },
    text: line || " ",
  })));
}

/**
 * The shape (without text) of a non-connector object.
 * @param {WhiteboardObject} o
 * @returns {VNode[]}
 */
function shapeNodes(o) {
  const s = o.style;
  const paint = {
    fill: s.fill, stroke: s.stroke === "none" || !s.strokeWidth ? "none" : s.stroke,
    "stroke-width": s.stroke === "none" || !s.strokeWidth ? null : s.strokeWidth,
  };
  switch (o.type) {
    case "sticky":
      return [
        h("rect", { x: o.x + 2, y: o.y + 4, width: o.w, height: o.h, rx: 6, fill: "#000000", "fill-opacity": "0.12" }),
        h("rect", { x: o.x, y: o.y, width: o.w, height: o.h, rx: 6, ...paint }),
      ];
    case "rect":
      return [h("rect", { x: o.x, y: o.y, width: o.w, height: o.h, rx: 4, ...paint })];
    case "ellipse":
      return [h("ellipse", { cx: o.x + o.w / 2, cy: o.y + o.h / 2, rx: o.w / 2, ry: o.h / 2, ...paint })];
    case "text":
      return s.fill === "none" ? [] : [h("rect", { x: o.x, y: o.y, width: o.w, height: o.h, fill: s.fill })];
    case "frame":
      return [h("rect", { x: o.x, y: o.y, width: o.w, height: o.h, rx: 2, ...paint })];
    case "pen":
      return [h("path", {
        d: strokePathD(penWorldPoints(o)), fill: "none", stroke: s.stroke === "none" ? "#1f2937" : s.stroke,
        "stroke-width": Math.max(0.5, s.strokeWidth), "stroke-linecap": "round", "stroke-linejoin": "round",
      })];
    case "icon":
      return iconNodes(o);
    case "code":
      return codeNodes(o);
    default:
      return [];
  }
}

/**
 * Compiled icon path data placed into world coordinates (see iconPlacement).
 * @param {{cmds: string[], nums: number[]}} p @param {{x: number, y: number, sx: number, sy: number}} at
 */
function placePath(p, at) {
  let d = "";
  let k = 0;
  for (const c of p.cmds) {
    d += c;
    const n = c === "C" ? 6 : c === "Z" ? 0 : 2;
    for (let j = 0; j < n; j += 2, k += 2) {
      d += (j ? " " : "") + fmt(at.x + p.nums[k] * at.sx) + " " + fmt(at.y + p.nums[k + 1] * at.sy);
    }
  }
  return d;
}

/**
 * An icon from its pack's compiled geometry (src/shared/icons/registry.js). Recolouring never
 * touches the geometry: paint roles map to the object's fill and line colours. An icon whose pack
 * or id this build does not know draws as a dashed placeholder box.
 * @param {WhiteboardObject} o
 * @returns {VNode[]}
 */
function iconNodes(o) {
  const e = getIcon(o.packId, o.iconId);
  const s = o.style;
  if (!e) {
    return [h("rect", {
      x: o.x, y: o.y, width: o.w, height: o.h, rx: 4, fill: "none", stroke: "#9ca3af", "stroke-width": 2,
      "stroke-dasharray": "6 4", "data-missing-icon": "1",
    })];
  }
  const at = iconPlacement(e, o);
  const glyph = e.kind === "glyph";
  const ink = s.stroke === "none" ? (glyph ? DEFAULT_INK : "none") : s.stroke;
  const width = glyph ? Math.max(0.25, s.strokeWidth || DEFAULT_ICON_STROKE) * at.sx : s.strokeWidth;
  /** @type {VNode[]} */
  const nodes = [];
  if (glyph && s.fill !== "none") {
    nodes.push(h("rect", { x: o.x, y: o.y, width: o.w, height: o.h, rx: Math.min(o.w, o.h) * 0.16, fill: s.fill }));
  }
  for (const p of iconPaths(e)) {
    const fill = p.paint[0] === "f" ? s.fill : p.paint[0] === "i" ? (s.stroke === "none" ? DEFAULT_INK : s.stroke) : "none";
    const stroked = p.paint[1] === "i" && ink !== "none" && width > 0;
    if (fill === "none" && !stroked) continue;
    nodes.push(h("path", {
      d: placePath(p, at), fill, stroke: stroked ? ink : "none", "stroke-width": stroked ? width : null,
      "stroke-linecap": stroked ? "round" : null, "stroke-linejoin": stroked ? "round" : null,
    }));
  }
  return nodes;
}

/**
 * A code block: body, header strip (file name and language), line numbers and highlighted code
 * inside a nested <svg> that clips it to the body. Token text is only ever text content (escaped
 * by serialize, textContent on the client), never markup.
 * @param {WhiteboardObject} o
 * @returns {VNode[]}
 */
function codeNodes(o) {
  const L = codeLayout(o);
  const { m } = L;
  const th = codeTheme(o.theme);
  const rx = Math.min(6, o.w / 2, o.h / 2);
  /** @type {VNode[]} */
  const nodes = [
    h("rect", { x: o.x, y: o.y, width: o.w, height: o.h, rx, fill: th.background, stroke: th.border, "stroke-width": 1 }),
  ];
  if (m.headerH > 0) {
    const hh = m.headerH;
    nodes.push(h("path", {
      d: `M${fmt(o.x)} ${fmt(o.y + hh)}V${fmt(o.y + rx)}Q${fmt(o.x)} ${fmt(o.y)} ${fmt(o.x + rx)} ${fmt(o.y)}` +
        `H${fmt(o.x + o.w - rx)}Q${fmt(o.x + o.w)} ${fmt(o.y)} ${fmt(o.x + o.w)} ${fmt(o.y + rx)}V${fmt(o.y + hh)}Z`,
      fill: th.header, stroke: th.border, "stroke-width": 1,
    }));
    const headCol = m.headFont * CODE_CHAR_EM;
    const baseline = o.y + hh / 2 + m.headFont * 0.35;
    const room = Math.floor((o.w - 2 * m.pad) / headCol);
    const aside = L.aside ? fitColumns(L.aside, Math.max(0, Math.floor(room / 3))) : "";
    const label = fitColumns(L.label, Math.max(0, room - (aside ? aside.length + 2 : 0)));
    const head = { "font-size": m.headFont, "font-family": CODE_FONT_FAMILY, fill: th.headerText, style: "white-space:pre", class: "wb-code-head" };
    if (label) nodes.push(h("text", { x: o.x + m.pad, y: baseline, ...head, "font-weight": "600" }, [{ tag: "tspan", attrs: {}, text: label }]));
    if (aside) nodes.push(h("text", { x: o.x + o.w - m.pad, y: baseline, ...head, "text-anchor": "end" }, [{ tag: "tspan", attrs: {}, text: aside }]));
  }
  const bodyH = o.y + o.h - m.bodyY;
  if (bodyH <= 0 || !L.rows.length) return nodes;
  /** @type {VNode[]} */
  const clip = [];
  const numbers = o.lineNumbers === false ? [] : L.rows.filter((r) => r.number !== null);
  if (numbers.length) {
    const nx = o.x + m.pad + m.gutterW - m.charW;
    clip.push(h("text", {
      "font-size": m.fontSize, "font-family": CODE_FONT_FAMILY, fill: th.gutter, "text-anchor": "end", "aria-hidden": "true",
    }, numbers.map((r) => ({ tag: "tspan", attrs: { x: fmt(nx), y: fmt(r.y) }, text: String(r.number) }))));
  }
  const lines = L.rows.filter((r) => r.segs.length).map((r) => ({
    tag: "tspan",
    attrs: { x: fmt(m.textX), y: fmt(r.y) },
    children: r.segs.map(([cls, text]) => (cls ? { tag: "tspan", attrs: { fill: th.tokens[cls] }, text } : { tag: "tspan", attrs: {}, text })),
  }));
  if (lines.length) {
    clip.push(h("text", {
      "font-size": m.fontSize, "font-family": CODE_FONT_FAMILY, fill: th.tokens[""], style: "white-space:pre",
      "xml:space": "preserve", class: "wb-code-text",
    }, lines));
  }
  nodes.push(h("svg", {
    x: o.x, y: m.bodyY, width: o.w, height: bodyH,
    viewBox: `${fmt(o.x)} ${fmt(m.bodyY)} ${fmt(o.w)} ${fmt(bodyH)}`, overflow: "hidden",
  }, clip));
  return nodes;
}

/**
 * An arrowhead at `tip`, pointing away from `from`.
 * @param {{x: number, y: number}} from @param {{x: number, y: number}} tip @param {number} width @param {string} color
 */
function arrowHead(from, tip, width, color) {
  const len = Math.max(8, width * 4), half = Math.max(4, width * 2);
  const dx = tip.x - from.x, dy = tip.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  const bx = tip.x - ux * len, by = tip.y - uy * len;
  const pts = [[tip.x, tip.y], [bx - uy * half, by + ux * half], [bx + uy * half, by - ux * half]];
  return h("polygon", { points: pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(" "), fill: color });
}

/**
 * Nodes for a connector, or null when an endpoint cannot be resolved. Curved connectors draw an
 * SVG cubic ("C") and their arrowheads follow the end tangents; labels sit at the halfway point by
 * length (src/shared/connectors.js).
 * @param {WhiteboardObject} o
 * @param {Resolve} resolve
 * @param {import("./connectors.js").RouteEnv} [env]  obstacles for automatic elbow routes
 * @returns {VNode|null}
 */
function connectorNode(o, resolve, env) {
  const from = o.from ? resolve(o.from) : undefined;
  const to = o.to ? resolve(o.to) : undefined;
  if (!from || !to) return null;
  const route = connectorRoute(o, from, to, env);
  const { points } = route;
  const s = o.style;
  const color = s.stroke === "none" ? "#1f2937" : s.stroke;
  const width = Math.max(0.5, s.strokeWidth || 2);
  const d = routePathD(route);
  const dirs = routeEndDirections(route);
  const tipEnd = points[points.length - 1], tipStart = points[0];
  /** @type {VNode[]} */
  const children = [
    // A wide transparent path makes thin connectors easy to hit.
    h("path", { d, fill: "none", stroke: "transparent", "stroke-width": Math.max(12, width + 10), "data-hit": "1" }),
    h("path", { d, fill: "none", stroke: color, "stroke-width": width, "stroke-linejoin": "round" }),
  ];
  if (s.arrowEnd === "arrow" && points.length >= 2) children.push(arrowHead({ x: tipEnd.x - dirs.end.x, y: tipEnd.y - dirs.end.y }, tipEnd, width, color));
  if (s.arrowStart === "arrow" && points.length >= 2) children.push(arrowHead({ x: tipStart.x + dirs.start.x, y: tipStart.y + dirs.start.y }, tipStart, width, color));
  if (o.text) {
    const mid = routeMidpoint(route);
    const fontSize = s.fontSize;
    const w = textWidth(o.text, fontSize) + fontSize;
    const hgt = fontSize * 1.5;
    children.push(h("rect", { x: mid.x - w / 2, y: mid.y - hgt / 2, width: w, height: hgt, rx: 4, fill: "#ffffff" }));
    children.push({
      tag: "text",
      attrs: {
        x: fmt(mid.x), y: fmt(mid.y + fontSize * 0.35), "font-size": fmt(fontSize), "font-family": FONT_FAMILY,
        fill: s.textColor, "text-anchor": "middle", style: "white-space:pre",
      },
      children: [{ tag: "tspan", attrs: { x: fmt(mid.x) }, text: o.text }],
    });
  }
  return h("g", { "data-id": o.id, "data-type": o.type }, children);
}

/**
 * One object as a <g data-id> node, or null (a connector whose endpoint is missing).
 * Rotation is a transform on the group, about the box centre.
 * @param {WhiteboardObject} o
 * @param {Resolve} resolve  used for connector endpoints
 * @param {import("./connectors.js").RouteEnv} [env]  obstacles for automatic elbow connectors
 * @returns {VNode|null}
 */
export function objectNode(o, resolve, env) {
  if (o.type === "connector") return connectorNode(o, resolve, env);
  const children = shapeNodes(o);
  const text = textNode(o);
  if (text) children.push(text);
  const c = center(o);
  return h("g", {
    "data-id": o.id, "data-type": o.type,
    transform: o.rot ? `rotate(${fmt(o.rot)} ${fmt(c.x)} ${fmt(c.y)})` : null,
  }, children);
}

// ---------------------------------------------------------------------------------------------
// Serialisation (server export, client HTML export)
// ---------------------------------------------------------------------------------------------

/** @param {string} s */
export function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    // Characters XML 1.0 forbids even when escaped.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "");
}

/**
 * @param {VNode} node
 * @returns {string}
 */
export function serialize(node) {
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`).join("");
  const inner = (node.text !== undefined ? escapeXml(node.text) : "") + (node.children ?? []).map(serialize).join("");
  return inner ? `<${node.tag}${attrs}>${inner}</${node.tag}>` : `<${node.tag}${attrs}/>`;
}

/**
 * Characters of text (object text, frame names, connector labels) one SVG export lays out in
 * total. Text beyond it is cut and ends with "…", so a board crafted to be expensive to wrap
 * cannot hold the server's mutation queue for long. Far above any board people write by hand.
 */
export const EXPORT_TEXT_BUDGET = 2_000_000;

/**
 * The whole board (or one frame and its members) as a standalone SVG document. At most
 * EXPORT_TEXT_BUDGET characters of text are laid out, in stacking order.
 * @param {BoardSnapshot} board
 * @param {{padding?: number, frameId?: string|null}} [options]
 * @returns {string}
 */
export function boardToSvg(board, { padding = 40, frameId = null } = {}) {
  const all = board.objects ?? {};
  /** @type {Record<string, WhiteboardObject>} */
  let objects = all;
  if (frameId && all[frameId]?.type === "frame") {
    objects = {};
    for (const o of Object.values(all)) {
      if (o.id === frameId || o.frameId === frameId) objects[o.id] = o;
    }
    for (const o of Object.values(all)) {
      if (o.type === "connector" && o.from && o.to && objects[o.from] && objects[o.to]) objects[o.id] = o;
    }
  }
  // Elbow connectors route around the whole board's objects, as on the canvas (a frame export too).
  const env = createRouteEnv(all, { memo: true });
  const bounds = boardBounds(objects, env) ?? { x: 0, y: 0, w: 800, h: 600 };
  // Frame names sit above the frame; leave room for them.
  const top = Math.min(bounds.y, ...Object.values(objects).filter((o) => o.type === "frame").map((f) => f.y - f.style.fontSize * 1.25 - 4));
  const box = { x: bounds.x - padding, y: top - padding, w: bounds.w + 2 * padding, h: bounds.y + bounds.h - top + 2 * padding };
  const resolve = (/** @type {string} */ id) => objects[id];
  /** @type {VNode[]} */
  const children = [
    { tag: "title", attrs: {}, text: board.title || DEFAULT_TITLE },
    h("rect", { x: box.x, y: box.y, width: box.w, height: box.h, fill: "#ffffff" }),
  ];
  let budget = EXPORT_TEXT_BUDGET;
  for (const o of sortedObjects(objects)) {
    const text = typeof o.text === "string" ? o.text : "";
    let shown = o;
    if (text.length > budget) {
      // Never cut inside an emoji or other multi-code-point character.
      const kept = truncateText(text, budget);
      shown = { ...o, text: kept ? kept + "…" : "" };
    }
    budget = Math.max(0, budget - text.length);
    const node = objectNode(shown, resolve, env);
    if (node) children.push(node);
  }
  const root = h("svg", {
    xmlns: SVG_NS, viewBox: `${fmt(box.x)} ${fmt(box.y)} ${fmt(box.w)} ${fmt(box.h)}`,
    width: Math.ceil(box.w), height: Math.ceil(box.h),
  }, children);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(root)}\n`;
}

export { fitCamera, boardBounds, rotatedBounds };
