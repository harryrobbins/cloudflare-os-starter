// @ts-check
// Build-time compiler from a strict SVG subset to the whiteboard's inert icon geometry.
//
// Nothing here runs in the gadget. scripts/build-icon-packs.mjs feeds it pinned, declared source
// files; its output (absolute M/L/C/Z path data with a paint role per shape) is what the shared
// renderer draws. Raw SVG never reaches a board, a browser or an export.
//
// Pipeline: a small strict XML tokenizer builds an element tree (no DTDs, entities beyond the five
// predefined and numeric references, CDATA, processing instructions or text content); a validator
// walks it against an element and attribute allowlist; every accepted shape becomes a path of
// absolute moves, lines and cubic curves (arcs, quadratics and shorthand curves are converted
// exactly or, for arcs, to within far less than the output precision), transforms are applied to
// the coordinates, and the result is checked against the complexity limits and the view box.

/** Limits every source must meet. They are deliberately far above what the pinned sources need. */
export const COMPILER_LIMITS = Object.freeze({
  /** Bytes of one source file (UTF-8). */
  sourceBytes: 16 * 1024,
  /** Elements in one source, the root included. */
  elements: 64,
  /** Element nesting depth; the root is depth 1. */
  depth: 5,
  /** Attributes on one element. */
  attributes: 16,
  /** Characters of one attribute value. */
  attributeLength: 8192,
  /** Path segments (M, L, C and Z after normalisation) in one icon. The largest shipped icon has 47. */
  pathCommands: 256,
  /** Numbers (coordinates) in one icon's normalised output. The largest shipped icon has 206. */
  coordinates: 1024,
  /** Largest view box width or height, and largest |min-x| / |min-y|. */
  viewBox: 1024,
  /** How far geometry may reach outside the view box, as a fraction of its width or height. */
  margin: 0.25,
  /** Largest |value| of any number in a source. */
  number: 10_000,
  /** Longest numeric literal. */
  numberLength: 32,
});

export class IconCompileError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "IconCompileError";
  }
}

/** @param {string} message @returns {never} */
function fail(message) {
  throw new IconCompileError(message);
}

export const SVG_NS = "http://www.w3.org/2000/svg";

// ---------------------------------------------------------------------------------------------
// Strict XML tokenizer
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} XmlElement
 * @property {string} name
 * @property {[string, string][]} attrs  in source order, values decoded
 * @property {XmlElement[]} children
 * @property {number} depth
 */

const NAME_RE = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const WS_RE = /[ \t\r\n]*/y;
const XML_DECL_RE = /^<\?xml(?:[ \t\r\n]+[a-z]+[ \t\r\n]*=[ \t\r\n]*(?:"[^"<>]*"|'[^'<>]*'))*[ \t\r\n]*\?>/;
const ENTITY_RE = /&(?:(amp|lt|gt|quot|apos)|#([0-9]{1,7})|#x([0-9a-fA-F]{1,6}));/y;
const PREDEFINED = /** @type {Record<string, string>} */ ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" });

/**
 * Decodes the five predefined entities and numeric character references; anything else fails.
 * @param {string} raw
 */
function decodeEntities(raw) {
  if (!raw.includes("&")) return raw;
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf("&", i);
    if (amp < 0) { out += raw.slice(i); break; }
    out += raw.slice(i, amp);
    ENTITY_RE.lastIndex = amp;
    const m = ENTITY_RE.exec(raw);
    if (!m) fail("unsupported entity reference in an attribute value");
    const code = m[1] ? -1 : m[2] ? parseInt(m[2], 10) : parseInt(m[3], 16);
    if (code === -1) out += PREDEFINED[m[1]];
    else {
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail("invalid character reference");
      out += String.fromCodePoint(code);
    }
    i = ENTITY_RE.lastIndex;
  }
  return out;
}

/**
 * Parses a strict XML subset into an element tree.
 * @param {string} src
 * @returns {XmlElement}
 */
export function parseXml(src) {
  if (typeof src !== "string") fail("source must be text");
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = src.length;
  /** @param {RegExp} re */
  const read = (re) => {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) return null;
    i = re.lastIndex;
    return m[0];
  };
  read(WS_RE);
  if (src.startsWith("<?xml", i)) {
    const m = XML_DECL_RE.exec(src.slice(i));
    if (!m) fail("malformed XML declaration");
    i += m[0].length;
  }
  /** @type {XmlElement[]} */
  const stack = [];
  /** @type {XmlElement|null} */
  let root = null;
  let count = 0;
  while (i < n) {
    const lt = src.indexOf("<", i);
    const text = src.slice(i, lt < 0 ? n : lt);
    if (/[^ \t\r\n]/.test(text)) fail("text content is not allowed");
    if (lt < 0) break;
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      if (end < 0) fail("unterminated comment");
      if (src.slice(i + 4, end).includes("--")) fail("malformed comment");
      i = end + 3;
      continue;
    }
    if (src.startsWith("<!", i)) fail("DOCTYPE, entity declarations and CDATA sections are not allowed");
    if (src.startsWith("<?", i)) fail("processing instructions are not allowed");
    if (src.startsWith("</", i)) {
      i += 2;
      const name = read(NAME_RE);
      read(WS_RE);
      if (!name || src[i] !== ">") fail("malformed closing tag");
      i++;
      const open = stack.pop();
      if (!open || open.name !== name) fail(`mismatched closing tag </${name}>`);
      continue;
    }
    i++;
    const name = read(NAME_RE);
    if (!name) fail("malformed tag");
    /** @type {[string, string][]} */
    const attrs = [];
    let selfClosing = false;
    for (;;) {
      const ws = read(WS_RE);
      if (src[i] === ">") { i++; break; }
      if (src.startsWith("/>", i)) { i += 2; selfClosing = true; break; }
      if (!ws) fail(`malformed attributes on <${name}>`);
      const attr = read(NAME_RE);
      if (!attr) fail(`malformed attribute on <${name}>`);
      read(WS_RE);
      if (src[i] !== "=") fail(`attribute ${attr} has no value`);
      i++;
      read(WS_RE);
      const quote = src[i];
      if (quote !== '"' && quote !== "'") fail(`attribute ${attr} must be quoted`);
      const end = src.indexOf(quote, i + 1);
      if (end < 0) fail(`unterminated attribute ${attr}`);
      const raw = src.slice(i + 1, end);
      if (raw.includes("<")) fail(`"<" in attribute ${attr}`);
      if (raw.length > COMPILER_LIMITS.attributeLength) fail(`attribute ${attr} is longer than ${COMPILER_LIMITS.attributeLength} characters`);
      i = end + 1;
      if (attrs.some(([k]) => k === attr)) fail(`duplicate attribute ${attr}`);
      attrs.push([attr, decodeEntities(raw)]);
      if (attrs.length > COMPILER_LIMITS.attributes) fail(`more than ${COMPILER_LIMITS.attributes} attributes on <${name}>`);
    }
    /** @type {XmlElement} */
    const node = { name, attrs, children: [], depth: stack.length + 1 };
    if (++count > COMPILER_LIMITS.elements) fail(`more than ${COMPILER_LIMITS.elements} elements`);
    if (node.depth > COMPILER_LIMITS.depth) fail(`elements nested deeper than ${COMPILER_LIMITS.depth}`);
    if (!stack.length) {
      if (root) fail("more than one root element");
      root = node;
    } else stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length) fail(`unclosed element <${stack[stack.length - 1].name}>`);
  if (!root) fail("no root element");
  return root;
}

// ---------------------------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------------------------

/** Elements rejected with a specific reason (everything else outside ALLOWED is "unknown"). */
const FORBIDDEN_ELEMENTS = /** @type {Record<string, string>} */ ({
  script: "scripts", style: "stylesheets", foreignObject: "foreign content", image: "images", use: "references",
  a: "links", animate: "animation", animateMotion: "animation", animateTransform: "animation", animateColor: "animation",
  set: "animation", mpath: "animation", filter: "filters", mask: "masks", clipPath: "clip paths", pattern: "patterns",
  linearGradient: "gradients", radialGradient: "gradients", symbol: "symbols", defs: "definitions", marker: "markers",
  text: "text", tspan: "text", textPath: "text", switch: "conditional content", iframe: "frames", feImage: "filters",
});

const PAINT = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"];
/** @type {Record<string, Set<string>>} */
const ALLOWED = {
  svg: new Set(["xmlns", "viewBox", "width", "height", "class", ...PAINT]),
  g: new Set([...PAINT, "transform"]),
  path: new Set(["d", ...PAINT, "transform"]),
  rect: new Set(["x", "y", "width", "height", "rx", "ry", ...PAINT, "transform"]),
  circle: new Set(["cx", "cy", "r", ...PAINT, "transform"]),
  ellipse: new Set(["cx", "cy", "rx", "ry", ...PAINT, "transform"]),
  line: new Set(["x1", "y1", "x2", "y2", ...PAINT, "transform"]),
  polyline: new Set(["points", ...PAINT, "transform"]),
  polygon: new Set(["points", ...PAINT, "transform"]),
};
const REFERENCE_ATTRS = new Set(["filter", "mask", "clip-path", "marker-start", "marker-mid", "marker-end", "cursor"]);

/**
 * @param {string} element @param {string} name @param {string} value
 */
function checkAttribute(element, name, value) {
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) fail(`event attribute ${name} on <${element}>`);
  if (lower === "href" || lower.endsWith(":href")) fail(`link attribute ${name} on <${element}>`);
  if (lower === "style") fail(`inline CSS (style) on <${element}>`);
  if (/url\s*\(|javascript:|data:|expression\s*\(/i.test(value)) fail(`URL or script value in ${name} on <${element}>`);
  if (REFERENCE_ATTRS.has(lower)) fail(`${name} is not allowed (filters, masks, clips and markers)`);
  if (name.includes(":")) fail(`namespaced attribute ${name} on <${element}>`);
  if (name === "class" && element !== "svg") fail(`CSS class on <${element}>`);
  if (!ALLOWED[element].has(name)) fail(`unknown attribute ${name} on <${element}>`);
}

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

const NUMBER_RE = /[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
const WHOLE_NUMBER_RE = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/** @param {string} literal */
function toNumber(literal) {
  if (literal.length > COMPILER_LIMITS.numberLength) fail("numeric literal too long");
  const v = Number(literal);
  if (!Number.isFinite(v) || Math.abs(v) > COMPILER_LIMITS.number) fail(`number out of range: ${literal.slice(0, 20)}`);
  return v;
}

/** @param {string} value @param {string} what */
function attrNumber(value, what) {
  const t = value.trim();
  if (!WHOLE_NUMBER_RE.test(t)) fail(`${what} must be a plain number`);
  return toNumber(t);
}

/**
 * A list of numbers separated by whitespace and/or single commas.
 * @param {string} value @param {string} what
 */
function numberList(value, what) {
  /** @type {number[]} */
  const out = [];
  let i = 0;
  const s = value;
  const skip = () => {
    WS_RE.lastIndex = i; WS_RE.exec(s); i = WS_RE.lastIndex;
    if (s[i] === ",") { i++; WS_RE.lastIndex = i; WS_RE.exec(s); i = WS_RE.lastIndex; }
  };
  WS_RE.lastIndex = 0; WS_RE.exec(s); i = WS_RE.lastIndex;
  while (i < s.length) {
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(s);
    if (!m) fail(`${what} must be a list of numbers`);
    out.push(toNumber(m[0]));
    i = NUMBER_RE.lastIndex;
    skip();
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Geometry: segments, affine transforms, path data
// ---------------------------------------------------------------------------------------------

/**
 * Absolute segments: ["M", x, y], ["L", x, y], ["C", x1, y1, x2, y2, x, y] or ["Z"].
 * @typedef {(string|number)[]} Segment
 */

/** 2D affine matrix [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
/** @typedef {[number, number, number, number, number, number]} Matrix */

/** @type {Matrix} */
const IDENTITY = [1, 0, 0, 1, 0, 0];

/** @param {Matrix} m @param {Matrix} n @returns {Matrix} m then... the product m x n (n applied first) */
function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const TRANSFORM_RE = /([A-Za-z]+)[ \t\r\n]*\(([^()]*)\)[ \t\r\n,]*/y;

/**
 * Parses a transform list (matrix, translate, scale, rotate). Skews and anything else fail.
 * @param {string} value
 * @returns {Matrix}
 */
export function parseTransform(value) {
  /** @type {Matrix} */
  let m = IDENTITY;
  let i = 0;
  WS_RE.lastIndex = 0; WS_RE.exec(value); i = WS_RE.lastIndex;
  if (i >= value.length) fail("empty transform");
  while (i < value.length) {
    TRANSFORM_RE.lastIndex = i;
    const t = TRANSFORM_RE.exec(value);
    if (!t) fail("malformed transform");
    i = TRANSFORM_RE.lastIndex;
    const fn = t[1];
    const args = numberList(t[2], "transform arguments");
    /** @type {Matrix} */
    let next;
    if (fn === "matrix" && args.length === 6) next = /** @type {Matrix} */ (args);
    else if (fn === "translate" && (args.length === 1 || args.length === 2)) next = [1, 0, 0, 1, args[0], args[1] ?? 0];
    else if (fn === "scale" && (args.length === 1 || args.length === 2)) next = [args[0], 0, 0, args[1] ?? args[0], 0, 0];
    else if (fn === "rotate" && (args.length === 1 || args.length === 3)) {
      const a = (args[0] * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
      const [cx, cy] = args.length === 3 ? [args[1], args[2]] : [0, 0];
      next = multiply(multiply([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else fail(`unsupported transform ${fn}(${args.length} arguments)`);
    m = multiply(m, next);
  }
  if (Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-9) fail("degenerate transform");
  return m;
}

const PATH_COMMAND_RE = /[MmLlHhVvCcSsQqTtAaZz]/;
const PARAMS = /** @type {Record<string, number>} */ ({ m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 });

/**
 * Parses SVG path data into absolute M/L/C/Z segments. Arcs become cubic curves; quadratic and
 * shorthand curves become exact cubics.
 * @param {string} d
 * @returns {Segment[]}
 */
export function parsePathData(d) {
  /** @type {Segment[]} */
  const out = [];
  let i = 0;
  const s = d;
  const ws = () => { WS_RE.lastIndex = i; WS_RE.exec(s); i = WS_RE.lastIndex; };
  const sep = () => { ws(); if (s[i] === ",") { i++; ws(); } };
  const num = () => {
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(s);
    if (!m) fail("malformed path data");
    i = NUMBER_RE.lastIndex;
    return toNumber(m[0]);
  };
  const flag = () => {
    const c = s[i];
    if (c !== "0" && c !== "1") fail("malformed arc flag in path data");
    i++;
    return c === "1";
  };
  let x = 0, y = 0, sx = 0, sy = 0;
  /** last cubic control point (for S) and quadratic control point (for T), absolute */
  let lastC = /** @type {[number, number]|null} */ (null);
  let lastQ = /** @type {[number, number]|null} */ (null);
  let commands = 0;
  let started = false;
  ws();
  if (i < s.length && !/[Mm]/.test(s[i])) fail("path data must start with a move");
  let cmd = "";
  while (i < s.length) {
    if (PATH_COMMAND_RE.test(s[i])) { cmd = s[i]; i++; ws(); }
    else if (!cmd || cmd === "z" || cmd === "Z") fail("malformed path data");
    const lower = cmd.toLowerCase();
    const rel = cmd !== cmd.toUpperCase();
    if (++commands > COMPILER_LIMITS.pathCommands) fail(`more than ${COMPILER_LIMITS.pathCommands} path commands`);
    if (lower === "z") {
      out.push(["Z"]);
      x = sx; y = sy; lastC = lastQ = null;
      ws();
      continue;
    }
    if (!started && lower !== "m") fail("path data must start with a move");
    /** @type {number[]} */
    const p = [];
    for (let k = 0; k < PARAMS[lower]; k++) {
      if (k) sep();
      p.push(lower === "a" && (k === 3 || k === 4) ? (flag() ? 1 : 0) : num());
    }
    sep();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (lower) {
      case "m":
        x = ox + p[0]; y = oy + p[1]; sx = x; sy = y; started = true;
        out.push(["M", x, y]);
        cmd = rel ? "l" : "L"; // implicit repeats are lines
        lastC = lastQ = null;
        break;
      case "l":
        x = ox + p[0]; y = oy + p[1];
        out.push(["L", x, y]); lastC = lastQ = null;
        break;
      case "h":
        x = (rel ? x : 0) + p[0];
        out.push(["L", x, y]); lastC = lastQ = null;
        break;
      case "v":
        y = (rel ? y : 0) + p[0];
        out.push(["L", x, y]); lastC = lastQ = null;
        break;
      case "c": {
        const c = [ox + p[0], oy + p[1], ox + p[2], oy + p[3], ox + p[4], oy + p[5]];
        out.push(["C", ...c]);
        lastC = [c[2], c[3]]; lastQ = null; x = c[4]; y = c[5];
        break;
      }
      case "s": {
        const c1 = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
        const c = [c1[0], c1[1], ox + p[0], oy + p[1], ox + p[2], oy + p[3]];
        out.push(["C", ...c]);
        lastC = [c[2], c[3]]; lastQ = null; x = c[4]; y = c[5];
        break;
      }
      case "q": case "t": {
        const q = lower === "q" ? [ox + p[0], oy + p[1]] : lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
        const ex = ox + p[lower === "q" ? 2 : 0], ey = oy + p[lower === "q" ? 3 : 1];
        out.push(["C", x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y), ex + (2 / 3) * (q[0] - ex), ey + (2 / 3) * (q[1] - ey), ex, ey]);
        lastQ = /** @type {[number, number]} */ (q); lastC = null; x = ex; y = ey;
        break;
      }
      case "a": {
        const ex = ox + p[5], ey = oy + p[6];
        for (const c of arcToCubics(x, y, p[0], p[1], p[2], !!p[3], !!p[4], ex, ey)) out.push(c);
        x = ex; y = ey; lastC = lastQ = null;
        break;
      }
    }
  }
  return out;
}

/**
 * Endpoint-parameterised elliptical arc to cubic segments (SVG 1.1 F.6.5/F.6.6), each spanning at
 * most 90 degrees. A zero radius is a straight line; an arc to its own start point is nothing.
 * @returns {Segment[]}
 */
function arcToCubics(/** @type {number} */ x1, /** @type {number} */ y1, /** @type {number} */ rxIn, /** @type {number} */ ryIn,
  /** @type {number} */ phiDeg, /** @type {boolean} */ largeArc, /** @type {boolean} */ sweep, /** @type {number} */ x2, /** @type {number} */ y2) {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
  if (!rx || !ry) return [["L", x2, y2]];
  const phi = (phiDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const k = Math.sqrt(lambda); rx *= k; ry *= k; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (/** @type {number} */ ux, /** @type {number} */ uy, /** @type {number} */ vx, /** @type {number} */ vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / segments;
  const t = (4 / 3) * Math.tan(step / 4);
  /** @type {Segment[]} */
  const out = [];
  let a = theta1;
  const point = (/** @type {number} */ ex, /** @type {number} */ ey) => [cx + cos * rx * ex - sin * ry * ey, cy + sin * rx * ex + cos * ry * ey];
  for (let k = 0; k < segments; k++) {
    const b = a + step;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    const p1 = point(ca - t * sa, sa + t * ca);
    const p2 = point(cb + t * sb, sb - t * cb);
    const p3 = k === segments - 1 ? [x2, y2] : point(cb, sb);
    out.push(["C", p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]]);
    a = b;
  }
  return out;
}

/** Cubic approximation constant for a quarter circle. */
const KAPPA = 0.5522847498307936;

/** @param {number} cx @param {number} cy @param {number} rx @param {number} ry @returns {Segment[]} */
function ellipseSegments(cx, cy, rx, ry) {
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return [
    ["M", cx + rx, cy],
    ["C", cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ["C", cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ["C", cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ["C", cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ["Z"],
  ];
}

/**
 * @param {XmlElement} el @param {Map<string, string>} a
 * @returns {Segment[]}
 */
function shapeSegments(el, a) {
  const n = (/** @type {string} */ k, /** @type {number|null} */ fallback = null) => {
    const v = a.get(k);
    if (v === undefined) {
      if (fallback === null) fail(`<${el.name}> needs ${k}`);
      return fallback;
    }
    return attrNumber(v, `${k} on <${el.name}>`);
  };
  switch (el.name) {
    case "path": {
      const d = a.get("d");
      if (d === undefined) fail("<path> needs d");
      return parsePathData(d);
    }
    case "rect": {
      const x = n("x", 0), y = n("y", 0), w = n("width"), h = n("height");
      if (!(w > 0 && h > 0)) fail("<rect> needs a positive width and height");
      let rx = a.has("rx") ? n("rx") : null, ry = a.has("ry") ? n("ry") : null;
      if (rx !== null && rx < 0) fail("negative rx"); if (ry !== null && ry < 0) fail("negative ry");
      rx = Math.min(w / 2, rx ?? ry ?? 0); ry = Math.min(h / 2, ry ?? rx);
      if (!rx || !ry) return [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]];
      const kx = rx * KAPPA, ky = ry * KAPPA;
      return [
        ["M", x + rx, y], ["L", x + w - rx, y],
        ["C", x + w - rx + kx, y, x + w, y + ry - ky, x + w, y + ry], ["L", x + w, y + h - ry],
        ["C", x + w, y + h - ry + ky, x + w - rx + kx, y + h, x + w - rx, y + h], ["L", x + rx, y + h],
        ["C", x + rx - kx, y + h, x, y + h - ry + ky, x, y + h - ry], ["L", x, y + ry],
        ["C", x, y + ry - ky, x + rx - kx, y, x + rx, y], ["Z"],
      ];
    }
    case "circle": {
      const r = n("r");
      if (!(r > 0)) fail("<circle> needs a positive r");
      return ellipseSegments(n("cx", 0), n("cy", 0), r, r);
    }
    case "ellipse": {
      const rx = n("rx"), ry = n("ry");
      if (!(rx > 0 && ry > 0)) fail("<ellipse> needs positive rx and ry");
      return ellipseSegments(n("cx", 0), n("cy", 0), rx, ry);
    }
    case "line":
      return [["M", n("x1", 0), n("y1", 0)], ["L", n("x2", 0), n("y2", 0)]];
    case "polyline": case "polygon": {
      const pts = numberList(a.get("points") ?? "", "points");
      if (pts.length < 4 || pts.length % 2) fail(`<${el.name}> needs at least two points`);
      /** @type {Segment[]} */
      const segs = [];
      for (let k = 0; k < pts.length; k += 2) segs.push([k ? "L" : "M", pts[k], pts[k + 1]]);
      if (el.name === "polygon") segs.push(["Z"]);
      return segs;
    }
  }
  return fail(`unknown element <${el.name}>`);
}

/** @param {Segment[]} segs @param {Matrix} m @returns {Segment[]} */
function transformSegments(segs, m) {
  if (m === IDENTITY) return segs;
  return segs.map((s) => {
    if (s[0] === "Z") return s;
    const out = [s[0]];
    for (let k = 1; k < s.length; k += 2) {
      const x = /** @type {number} */ (s[k]), y = /** @type {number} */ (s[k + 1]);
      out.push(m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]);
    }
    return out;
  });
}

// ---------------------------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------------------------

/**
 * How a pack's sources map to recolourable paint.
 * @typedef {object} PaintPolicy
 * @property {string|null} fillToken  a colour (e.g. "#ffffff") that means "the object's fill
 *   colour"; null when the pack has no themeable fill
 * @property {number} strokeWidth     the only stroke-width a source may declare
 */

/**
 * One drawable shape: a two-letter paint code and path data. The first letter is the fill role,
 * the second the stroke role: "n" none, "f" the object's fill colour, "i" the object's line (ink)
 * colour. "ni" is an outline, "fi" a filled and outlined body, "in" a solid ink mark.
 * @typedef {[string, string]} CompiledShape
 */

/**
 * @typedef {object} CompiledIcon
 * @property {[number, number]} vb        view box width and height (origin moved to 0,0)
 * @property {CompiledShape[]} shapes
 */

/** Decimals kept in compiled coordinates (a hundredth of a view box unit). */
export const PRECISION = 2;

/**
 * Formats a coordinate compactly: at most PRECISION decimals, no "-0", no leading zero.
 * @param {number} v
 */
export function fmtNum(v) {
  const f = 10 ** PRECISION;
  const r = Math.round(v * f) / f + 0;
  return String(r).replace(/^(-?)0\./, "$1.");
}

/**
 * Path data with numbers separated by a space, or by nothing before a minus sign.
 * @param {Segment[]} segs
 */
function serializeSegments(segs) {
  let d = "";
  for (const s of segs) {
    d += s[0];
    for (let k = 1; k < s.length; k++) {
      const n = fmtNum(/** @type {number} */ (s[k]));
      d += (k > 1 && n[0] !== "-" ? " " : "") + n;
    }
  }
  return d;
}

/**
 * Compiles one SVG source. Throws IconCompileError when the source uses anything outside the
 * allowlist or exceeds a limit.
 * @param {string} source
 * @param {PaintPolicy} policy
 * @returns {CompiledIcon}
 */
export function compileSvg(source, policy) {
  if (typeof source !== "string") fail("source must be text");
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > COMPILER_LIMITS.sourceBytes) fail(`source is ${bytes} bytes; the limit is ${COMPILER_LIMITS.sourceBytes}`);
  const root = parseXml(source);
  if (root.name !== "svg") fail(`root element must be <svg>, not <${root.name}>`);
  const rootAttrs = new Map(root.attrs);
  for (const [k, v] of root.attrs) checkAttribute("svg", k, v);
  if (rootAttrs.get("xmlns") !== SVG_NS) fail("root <svg> must declare the SVG namespace");
  const vbText = rootAttrs.get("viewBox");
  if (vbText === undefined) fail("root <svg> needs a viewBox");
  const vb = numberList(vbText, "viewBox");
  if (vb.length !== 4) fail("viewBox must have four numbers");
  const [minX, minY, vbW, vbH] = vb;
  const V = COMPILER_LIMITS.viewBox;
  if (!(vbW > 0 && vbH > 0 && vbW <= V && vbH <= V && Math.abs(minX) <= V && Math.abs(minY) <= V)) {
    fail(`viewBox must be positive and within ${V}`);
  }
  for (const k of ["width", "height"]) if (rootAttrs.has(k)) attrNumber(/** @type {string} */ (rootAttrs.get(k)), k);
  const cls = rootAttrs.get("class");
  if (cls !== undefined && !/^[A-Za-z0-9_ -]*$/.test(cls)) fail("class on <svg> must be plain names");

  /** @param {string|undefined} v @param {string} what @returns {string|undefined} "n", "f", "i" */
  const paintRole = (v, what) => {
    if (v === undefined) return undefined;
    const t = v.trim();
    if (t === "none") return "n";
    if (t === "currentColor") return "i";
    if (policy.fillToken && t.toLowerCase() === policy.fillToken.toLowerCase() && what === "fill") return "f";
    return fail(`unsupported ${what} paint ${t.slice(0, 20)}: use none, currentColor${policy.fillToken ? ` or ${policy.fillToken}` : ""}`);
  };
  /** @param {Map<string, string>} a */
  const checkStrokeStyle = (a) => {
    if (a.has("stroke-width") && attrNumber(/** @type {string} */ (a.get("stroke-width")), "stroke-width") !== policy.strokeWidth) {
      fail(`stroke-width must be ${policy.strokeWidth}`);
    }
    for (const k of ["stroke-linecap", "stroke-linejoin"]) {
      if (a.has(k) && a.get(k) !== "round") fail(`${k} must be round`);
    }
  };
  checkStrokeStyle(rootAttrs);

  // Every element and attribute is checked before any geometry is read.
  const validate = (/** @type {XmlElement} */ el) => {
    for (const child of el.children) {
      if (Object.hasOwn(FORBIDDEN_ELEMENTS, child.name)) fail(`<${child.name}> is not allowed (${FORBIDDEN_ELEMENTS[child.name]})`);
      if (!Object.hasOwn(ALLOWED, child.name) || child.name === "svg") fail(`unknown element <${child.name}>`);
      for (const [k, v] of child.attrs) checkAttribute(child.name, k, v);
      validate(child);
      if (child.children.length && child.name !== "g") fail(`<${child.name}> cannot have children`);
    }
  };
  validate(root);

  /** @type {CompiledShape[]} */
  const shapes = [];
  let segments = 0, coordinates = 0;
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  const mx = COMPILER_LIMITS.margin * vbW, my = COMPILER_LIMITS.margin * vbH;

  /**
   * @param {XmlElement} el @param {{fill: string, stroke: string}} paint @param {Matrix} matrix
   */
  const walk = (el, paint, matrix) => {
    for (const child of el.children) {
      const a = new Map(child.attrs);
      checkStrokeStyle(a);
      const next = {
        fill: paintRole(a.get("fill"), "fill") ?? paint.fill,
        stroke: paintRole(a.get("stroke"), "stroke") ?? paint.stroke,
      };
      if (next.stroke === "f") fail("stroke cannot use the fill colour");
      const m = a.has("transform") ? multiply(matrix, parseTransform(/** @type {string} */ (a.get("transform")))) : matrix;
      if (child.name === "g") {
        walk(child, next, m);
        continue;
      }
      const segs = transformSegments(shapeSegments(child, a), m);
      segments += segs.length;
      if (segments > COMPILER_LIMITS.pathCommands) fail(`more than ${COMPILER_LIMITS.pathCommands} path commands`);
      const code = next.fill + next.stroke;
      if (code === "nn") continue; // invisible (e.g. Tabler's bounding-box helper path)
      for (const s of segs) {
        for (let k = 1; k < s.length; k += 2) {
          const x = /** @type {number} */ (s[k]), y = /** @type {number} */ (s[k + 1]);
          if (!Number.isFinite(x) || !Number.isFinite(y)) fail("non-finite coordinate");
          if (x < minX - mx || x > minX + vbW + mx || y < minY - my || y > minY + vbH + my) {
            fail("geometry reaches too far outside the viewBox");
          }
          bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
        }
        coordinates += s.length - 1;
      }
      if (coordinates > COMPILER_LIMITS.coordinates) fail(`more than ${COMPILER_LIMITS.coordinates} coordinates`);
      const moved = transformSegments(segs, [1, 0, 0, 1, -minX, -minY]);
      const d = serializeSegments(moved);
      const last = shapes[shapes.length - 1];
      // Outlines may share one path element; filled shapes stay separate so their fills do not interact.
      if (last && last[0] === code && code[0] === "n") last[1] += d;
      else shapes.push([code, d]);
    }
  };
  walk(root, {
    fill: paintRole(rootAttrs.get("fill"), "fill") ?? "i", // SVG's initial fill is black: the ink
    stroke: paintRole(rootAttrs.get("stroke"), "stroke") ?? "n",
  }, IDENTITY);
  if (!shapes.length) fail("no visible geometry");
  return { vb: [vbW, vbH], shapes };
}
