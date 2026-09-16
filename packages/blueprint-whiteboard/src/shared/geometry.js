// @ts-check
// Pure geometry shared by the client renderer, hit testing, the server's SVG export and the agent
// convenience methods: rotated bounds, connector endpoints and routes, pen paths, approximate text
// wrapping and camera fitting. No DOM, no measurement: the same input gives the same output on the
// server and in every browser, which is what keeps an SVG export identical to the board.

/** @typedef {import("./protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("./protocol.js").Side} Side */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */

const DEG = Math.PI / 180;

/** @param {Rect} r @returns {Point} */
export function center(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/**
 * Rotates `p` by `deg` degrees clockwise (screen coordinates, y down) about `c`.
 * @param {Point} p @param {Point} c @param {number} deg
 * @returns {Point}
 */
export function rotatePoint(p, c, deg) {
  if (!deg) return { x: p.x, y: p.y };
  const a = deg * DEG, cos = Math.cos(a), sin = Math.sin(a);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/**
 * The four corners of an object's (possibly rotated) box: top-left, top-right, bottom-right,
 * bottom-left of the unrotated box, each rotated.
 * @param {{x: number, y: number, w: number, h: number, rot?: number}} o
 * @returns {Point[]}
 */
export function corners(o) {
  const c = center(o);
  const rot = o.rot ?? 0;
  return [
    { x: o.x, y: o.y }, { x: o.x + o.w, y: o.y }, { x: o.x + o.w, y: o.y + o.h }, { x: o.x, y: o.y + o.h },
  ].map((p) => rotatePoint(p, c, rot));
}

/**
 * Axis-aligned bounds of a set of points.
 * @param {Point[]} points
 * @returns {Rect}
 */
export function pointsBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Axis-aligned world bounds of any non-connector object, rotation included.
 * @param {{x: number, y: number, w: number, h: number, rot?: number}} o
 * @returns {Rect}
 */
export function rotatedBounds(o) {
  return o.rot ? pointsBounds(corners(o)) : { x: o.x, y: o.y, w: o.w, h: o.h };
}

/** @param {Rect[]} rects @returns {Rect|null} */
export function unionRects(rects) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  }
  return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** @param {Rect} a @param {Rect} b */
export function rectsIntersect(a, b) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** @param {Rect} outer @param {Rect} inner */
export function rectContains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/** @param {Rect} r @param {Point} p */
export function rectContainsPoint(r, p) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * True when world point `p` is inside the object's rotated box (ellipses use the ellipse).
 * Pens and connectors use distance to their path instead (see distanceToPolyline).
 * @param {{type?: string, x: number, y: number, w: number, h: number, rot?: number}} o
 * @param {Point} p
 */
export function pointInObjectBox(o, p) {
  const local = rotatePoint(p, center(o), -(o.rot ?? 0));
  if (o.type === "ellipse") {
    const rx = o.w / 2, ry = o.h / 2;
    const dx = (local.x - (o.x + rx)) / rx, dy = (local.y - (o.y + ry)) / ry;
    return dx * dx + dy * dy <= 1;
  }
  return rectContainsPoint(o, local);
}

/**
 * Shortest distance from `p` to a polyline given as a flat [x0, y0, x1, y1, ...] array.
 * @param {Point} p @param {number[]} flat
 */
export function distanceToPolyline(p, flat) {
  let best = Infinity;
  if (flat.length === 2) return Math.hypot(p.x - flat[0], p.y - flat[1]);
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const ax = flat[i], ay = flat[i + 1], bx = flat[i + 2], by = flat[i + 3];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.x - ax) * dx + (p.y - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy)));
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Pen strokes
// ---------------------------------------------------------------------------------------------

/**
 * World coordinates of a pen object's normalised points.
 * @param {{x: number, y: number, w: number, h: number, points?: number[]}} o
 * @returns {number[]}
 */
export function penWorldPoints(o) {
  const pts = o.points ?? [];
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    out[i] = o.x + pts[i] * o.w;
    out[i + 1] = o.y + pts[i + 1] * o.h;
  }
  return out;
}

/**
 * Turns WORLD stroke points into a pen object's box and normalised points (the inverse of
 * penWorldPoints). The box is at least 1x1; `pad` world units are added on every side so a thick
 * stroke's box covers its ink.
 * @param {number[]} flat
 * @param {number} [pad]
 * @returns {{x: number, y: number, w: number, h: number, points: number[]}}
 */
export function normalizeStroke(flat, pad = 0) {
  /** @type {Point[]} */
  const pts = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pts.push({ x: flat[i], y: flat[i + 1] });
  const b = pointsBounds(pts);
  const x = b.x - pad, y = b.y - pad;
  const w = Math.max(1, b.w + 2 * pad), h = Math.max(1, b.h + 2 * pad);
  const r4 = (/** @type {number} */ v) => Math.min(1, Math.max(0, Math.round(v * 10000) / 10000));
  const points = [];
  for (const p of pts) points.push(r4((p.x - x) / w), r4((p.y - y) / h));
  return { x: round2(x), y: round2(y), w: round2(w), h: round2(h), points };
}

/**
 * SVG path data for a stroke through WORLD points, smoothed with quadratic segments through
 * midpoints. A single point becomes a zero-length segment (drawn as a dot with round caps).
 * @param {number[]} flat
 */
export function strokePathD(flat) {
  const n = Math.floor(flat.length / 2);
  if (n === 0) return "";
  const f = (/** @type {number} */ v) => fmt(v);
  if (n === 1) return `M${f(flat[0])} ${f(flat[1])}l0 0`;
  if (n === 2) return `M${f(flat[0])} ${f(flat[1])}L${f(flat[2])} ${f(flat[3])}`;
  let d = `M${f(flat[0])} ${f(flat[1])}`;
  for (let i = 1; i < n - 1; i++) {
    const x = flat[2 * i], y = flat[2 * i + 1];
    const mx = (x + flat[2 * i + 2]) / 2, my = (y + flat[2 * i + 3]) / 2;
    d += `Q${f(x)} ${f(y)} ${f(mx)} ${f(my)}`;
  }
  d += `L${f(flat[2 * n - 2])} ${f(flat[2 * n - 1])}`;
  return d;
}

// ---------------------------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------------------------

/**
 * The midpoint of one side of an object's rotated box, and the outward unit normal there.
 * @param {{x: number, y: number, w: number, h: number, rot?: number}} o
 * @param {"top"|"right"|"bottom"|"left"} side
 * @returns {{point: Point, normal: Point}}
 */
export function anchor(o, side) {
  const c = center(o);
  const local = {
    top: { point: { x: c.x, y: o.y }, normal: { x: 0, y: -1 } },
    right: { point: { x: o.x + o.w, y: c.y }, normal: { x: 1, y: 0 } },
    bottom: { point: { x: c.x, y: o.y + o.h }, normal: { x: 0, y: 1 } },
    left: { point: { x: o.x, y: c.y }, normal: { x: -1, y: 0 } },
  }[side];
  const rot = o.rot ?? 0;
  return {
    point: rotatePoint(local.point, c, rot),
    normal: rotatePoint(local.normal, { x: 0, y: 0 }, rot),
  };
}

/**
 * Picks the side of `o` facing `toward` (by the dominant axis between centres, in o's rotated frame).
 * @param {{x: number, y: number, w: number, h: number, rot?: number}} o
 * @param {Point} toward
 * @returns {"top"|"right"|"bottom"|"left"}
 */
export function facingSide(o, toward) {
  const c = center(o);
  const p = rotatePoint(toward, c, -(o.rot ?? 0));
  const dx = (p.x - c.x) / Math.max(1, o.w), dy = (p.y - c.y) / Math.max(1, o.h);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

/**
 * The route of a connector between two object boxes (use ghost geometry while dragging).
 * Returns world points, first at `from`, last at `to`, plus the sides actually used.
 * @param {{fromSide?: Side, toSide?: Side, routing?: "straight"|"elbow"}} conn
 * @param {{x: number, y: number, w: number, h: number, rot?: number}} from
 * @param {{x: number, y: number, w: number, h: number, rot?: number}} to
 * @returns {{points: Point[], fromSide: "top"|"right"|"bottom"|"left", toSide: "top"|"right"|"bottom"|"left"}}
 */
export function connectorRoute(conn, from, to) {
  const fromSide = !conn.fromSide || conn.fromSide === "auto" ? facingSide(from, center(to)) : conn.fromSide;
  const toSide = !conn.toSide || conn.toSide === "auto" ? facingSide(to, center(from)) : conn.toSide;
  const a = anchor(from, fromSide), b = anchor(to, toSide);
  if (conn.routing !== "elbow") return { points: [a.point, b.point], fromSide, toSide };
  return { points: elbowPoints(a, b), fromSide, toSide };
}

/**
 * Orthogonal route between two anchors: leave each anchor along its normal by a stub, then join
 * with at most two bends. Normals of rotated objects are snapped to the nearest axis.
 * @param {{point: Point, normal: Point}} a
 * @param {{point: Point, normal: Point}} b
 * @returns {Point[]}
 */
export function elbowPoints(a, b) {
  const STUB = 24;
  const snap = (/** @type {Point} */ n) =>
    Math.abs(n.x) >= Math.abs(n.y) ? { x: Math.sign(n.x) || 1, y: 0 } : { x: 0, y: Math.sign(n.y) || 1 };
  const na = snap(a.normal), nb = snap(b.normal);
  const p0 = a.point, p3 = b.point;
  const p1 = { x: p0.x + na.x * STUB, y: p0.y + na.y * STUB };
  const p2 = { x: p3.x + nb.x * STUB, y: p3.y + nb.y * STUB };
  /** @type {Point[]} */
  let mid;
  const aHorizontal = na.x !== 0, bHorizontal = nb.x !== 0;
  if (aHorizontal && bHorizontal) {
    const mx = (p1.x + p2.x) / 2;
    mid = [{ x: mx, y: p1.y }, { x: mx, y: p2.y }];
  } else if (!aHorizontal && !bHorizontal) {
    const my = (p1.y + p2.y) / 2;
    mid = [{ x: p1.x, y: my }, { x: p2.x, y: my }];
  } else if (aHorizontal) {
    mid = [{ x: p2.x, y: p1.y }];
  } else {
    mid = [{ x: p1.x, y: p2.y }];
  }
  /** @type {Point[]} */
  const out = [];
  for (const p of [p0, p1, ...mid, p2, p3]) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > 0.01 || Math.abs(last.y - p.y) > 0.01) out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * The point halfway along a polyline, for connector labels.
 * @param {Point[]} points
 * @returns {Point}
 */
export function polylineMidpoint(points) {
  if (points.length === 0) return { x: 0, y: 0 };
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  let half = total / 2;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (seg >= half && seg > 0) {
      const t = half / seg;
      return { x: points[i - 1].x + t * (points[i].x - points[i - 1].x), y: points[i - 1].y + t * (points[i].y - points[i - 1].y) };
    }
    half -= seg;
  }
  return points[points.length - 1];
}

/**
 * Axis-aligned bounds of a connector, from its route.
 * @param {WhiteboardObject} conn
 * @param {Record<string, WhiteboardObject>} objects
 * @returns {Rect|null} null when an endpoint is missing
 */
export function connectorBounds(conn, objects) {
  const from = conn.from ? objects[conn.from] : undefined;
  const to = conn.to ? objects[conn.to] : undefined;
  if (!from || !to) return null;
  return pointsBounds(connectorRoute(conn, from, to).points);
}

/**
 * World bounds of any object; connectors from their endpoints (null when an endpoint is missing).
 * @param {WhiteboardObject} o
 * @param {Record<string, WhiteboardObject>} objects
 * @returns {Rect|null}
 */
export function objectBounds(o, objects) {
  return o.type === "connector" ? connectorBounds(o, objects) : rotatedBounds(o);
}

/**
 * Bounds of all objects (or null for an empty board).
 * @param {Record<string, WhiteboardObject>} objects
 */
export function boardBounds(objects) {
  /** @type {Rect[]} */
  const rects = [];
  for (const o of Object.values(objects)) {
    const r = objectBounds(o, objects);
    if (r) rects.push(r);
  }
  return unionRects(rects);
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/** Average advance of a Latin glyph in the UI font, as a fraction of the font size. */
export const CHAR_WIDTH_EM = 0.56;
/** Line height as a multiple of the font size. */
export const LINE_HEIGHT = 1.25;
/** Inner padding of text inside shapes and stickies, as a fraction of the font size. */
export const TEXT_PAD_EM = 0.6;

const NARROW = " il.,:;'|!ftjI";
const WIDE = "mwMW@";
/** Widths of the ASCII range, precomputed (same values as the rules in charWidth). */
const ASCII_WIDTH = Array.from({ length: 128 }, (_, code) => {
  const ch = String.fromCharCode(code);
  if (NARROW.includes(ch)) return 0.32;
  if (WIDE.includes(ch)) return 0.9;
  if (ch >= "A" && ch <= "Z") return 0.68;
  return CHAR_WIDTH_EM;
});

/** @param {number} code a code point */
function codeWidth(code) {
  if (code < 128) return ASCII_WIDTH[code];
  // CJK, Hangul, fullwidth forms and emoji are roughly square.
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60) || code >= 0x1f300) return 1;
  return CHAR_WIDTH_EM;
}

/** @param {string} ch one code point */
function charWidth(ch) {
  return codeWidth(ch.codePointAt(0) ?? 0);
}

/**
 * Approximate width of `text` at `fontSize`.
 * @param {string} text @param {number} fontSize
 */
export function textWidth(text, fontSize) {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const code = /** @type {number} */ (text.codePointAt(i));
    if (code > 0xffff) i++;
    w += codeWidth(code);
  }
  return w * fontSize;
}

/** Most lines a text object lays out; beyond this the last line ends with "…". */
export const MAX_TEXT_LINES = 400;

/**
 * Greedy word wrap using the approximate glyph widths above. Explicit newlines are kept; words
 * wider than the line are broken by character. Deterministic on server and client alike.
 *
 * Linear in the text length: the width of the current line is kept as a running sum (added in
 * the same order as textWidth would, so results are bit-identical), and wrapping stops as soon
 * as more than `maxLines` lines exist.
 * @param {string} text
 * @param {number} maxWidth  world units available for text
 * @param {number} fontSize
 * @param {number} [maxLines]  lines beyond this are dropped and the last line ends with "…"
 * @returns {string[]}
 */
export function wrapText(text, maxWidth, fontSize, maxLines = Infinity) {
  const width = Math.max(fontSize, maxWidth);
  /** @type {string[]} */
  const lines = [];
  const full = () => lines.length > maxLines;
  paragraphs: for (const para of String(text).split("\n")) {
    let line = "";
    let lineUnits = 0; // sum of charWidth over `line`, in order
    // split with a capture group alternates words (even indexes) and whitespace runs (odd).
    const tokens = para.split(/(\s+)/);
    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t];
      if (token === "") continue;
      if (t % 2 === 1) {
        if (line !== "") {
          line += token;
          for (let i = 0; i < token.length; i++) {
            const code = /** @type {number} */ (token.codePointAt(i));
            if (code > 0xffff) i++;
            lineUnits += codeWidth(code);
          }
        }
        continue;
      }
      let joined = lineUnits, alone = 0;
      for (let i = 0; i < token.length; i++) {
        const code = /** @type {number} */ (token.codePointAt(i));
        if (code > 0xffff) i++;
        const cw = codeWidth(code);
        joined += cw;
        alone += cw;
      }
      if (joined * fontSize <= width) {
        line += token;
        lineUnits = joined;
        continue;
      }
      if (line.trim() !== "") {
        lines.push(line.trimEnd());
        if (full()) break paragraphs;
      }
      line = "";
      lineUnits = 0;
      if (alone * fontSize <= width) {
        line = token;
        lineUnits = alone;
        continue;
      }
      // A single word wider than the line: break it by character.
      for (const ch of token) {
        const cw = charWidth(ch);
        if (line && (lineUnits + cw) * fontSize > width) {
          lines.push(line);
          if (full()) break paragraphs;
          line = "";
          lineUnits = 0;
        }
        line += ch;
        lineUnits += cw;
      }
    }
    lines.push(line.trimEnd());
    if (full()) break;
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, Math.max(1, maxLines));
    kept[kept.length - 1] = kept[kept.length - 1].replace(/\s*\S?$/, "") + "…";
    return kept;
  }
  return lines;
}

/**
 * Where an object's text goes: the inner box (world, unrotated) and wrapped lines that fit it.
 * Sticky, rect, ellipse: centred vertically in the padded box (ellipses use the inscribed
 * rectangle). Text objects: top-aligned, no padding. Frames: their name sits above the frame
 * (one line). Connectors: see connector labels in render.js. Stickies and shapes lay out only the
 * lines that fit the box, text objects at most MAX_TEXT_LINES.
 * @param {WhiteboardObject} o
 * @returns {{x: number, y: number, w: number, h: number, lines: string[], lineHeight: number,
 *   anchor: "start"|"middle"|"end", firstBaseline: number}}
 */
export function textLayout(o) {
  const fontSize = o.style.fontSize;
  const lineHeight = fontSize * LINE_HEIGHT;
  let box;
  if (o.type === "frame") {
    box = { x: o.x, y: o.y - lineHeight - 4, w: o.w, h: lineHeight };
  } else if (o.type === "text") {
    box = { x: o.x, y: o.y, w: o.w, h: o.h };
  } else {
    const inset = o.type === "ellipse" ? (1 - Math.SQRT1_2) / 2 : 0;
    const pad = fontSize * TEXT_PAD_EM;
    box = {
      x: o.x + o.w * inset + pad, y: o.y + o.h * inset + pad,
      w: Math.max(1, o.w * (1 - 2 * inset) - 2 * pad), h: Math.max(1, o.h * (1 - 2 * inset) - 2 * pad),
    };
  }
  const maxLines = o.type === "frame" ? 1 : o.type === "text" ? MAX_TEXT_LINES : Math.max(1, Math.floor(box.h / lineHeight));
  const lines = o.text ? wrapText(o.text, box.w, fontSize, maxLines) : [];
  const align = o.type === "frame" ? "left" : o.style.align;
  const anchorName = align === "center" ? "middle" : align === "right" ? "end" : "start";
  const blockH = lines.length * lineHeight;
  const top = o.type === "text" || o.type === "frame" ? box.y : box.y + Math.max(0, (box.h - blockH) / 2);
  // Baseline of the first line: roughly 0.8 of the line box below its top.
  const firstBaseline = top + (lineHeight - fontSize) / 2 + fontSize * 0.8;
  return { ...box, lines, lineHeight, anchor: anchorName, firstBaseline };
}

/**
 * Height a text object needs for its content at its width (for auto-grow while typing).
 * @param {string} text @param {number} w @param {number} fontSize
 */
export function textObjectHeight(text, w, fontSize) {
  const lines = Math.max(1, wrapText(text, w, fontSize).length);
  return Math.ceil(lines * fontSize * LINE_HEIGHT);
}

// ---------------------------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------------------------

/**
 * Camera {x, y, zoom} that fits world rect `r` into a view of `viewW` x `viewH` screen pixels with
 * `padding` pixels to spare. The camera maps world to screen as screen = (world - {x, y}) * zoom.
 * @param {Rect} r @param {number} viewW @param {number} viewH
 * @param {{padding?: number, minZoom?: number, maxZoom?: number}} [opts]
 * @returns {{x: number, y: number, zoom: number}}
 */
export function fitCamera(r, viewW, viewH, { padding = 40, minZoom = 0.05, maxZoom = 20 } = {}) {
  const availW = Math.max(1, viewW - 2 * padding), availH = Math.max(1, viewH - 2 * padding);
  const zoom = Math.min(maxZoom, Math.max(minZoom, Math.min(availW / Math.max(1, r.w), availH / Math.max(1, r.h))));
  const c = center(r);
  return { x: c.x - viewW / 2 / zoom, y: c.y - viewH / 2 / zoom, zoom };
}

// ---------------------------------------------------------------------------------------------

/** @param {number} v */
function round2(v) {
  return Math.round(v * 100) / 100 + 0;
}

/** Compact number formatting for SVG attributes (at most 2 decimals, no "-0"). @param {number} v */
export function fmt(v) {
  const r = Math.round(v * 100) / 100 + 0;
  return String(r);
}
