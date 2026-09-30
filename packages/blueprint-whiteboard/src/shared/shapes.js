// @ts-check
// Shape variants of the "rect" object type: `style.shape` picks the outline (diamond, triangle,
// cylinder, ...) while the object keeps the rectangle's box, text, rotation, resizing and
// connector behaviour. Pure geometry shared by the renderer, the SVG export, hit testing, text
// layout and connector anchors, so every consumer agrees on one outline.
//
// Each outline is built in the object's local, unrotated frame (0..w, 0..h) from M, L, C and Z
// commands only. Proportions that would look wrong when stretched (corner radii, the cylinder's
// caps, hexagon and chevron points) are derived from the smaller side, so a shape keeps its
// character at any size. "rect" itself is not drawn from here: it stays the plain <rect> it always
// was (and so does every existing board).

/** @typedef {{x: number, y: number}} Point */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */
/** @typedef {(string|number)[]} Cmd  ["M", x, y] | ["L", x, y] | ["C", x1, y1, x2, y2, x, y] | ["Z"] */

/**
 * Shape ids in picker order, with labels and search words.
 * @type {ReadonlyArray<{id: string, label: string, group: string, words: string}>}
 */
export const SHAPES = Object.freeze([
  { id: "rect", label: "Rectangle", group: "Basic", words: "box square process step" },
  { id: "rounded", label: "Rounded rectangle", group: "Basic", words: "box card round" },
  { id: "pill", label: "Pill", group: "Basic", words: "stadium terminator start end capsule" },
  { id: "diamond", label: "Diamond", group: "Basic", words: "decision rhombus choice if condition" },
  { id: "triangle", label: "Triangle", group: "Basic", words: "warning pyramid delta" },
  { id: "rightTriangle", label: "Right triangle", group: "Basic", words: "corner angle" },
  { id: "pentagon", label: "Pentagon", group: "Basic", words: "five" },
  { id: "hexagon", label: "Hexagon", group: "Basic", words: "preparation six" },
  { id: "octagon", label: "Octagon", group: "Basic", words: "stop eight" },
  { id: "parallelogram", label: "Parallelogram", group: "Basic", words: "input output data io slanted" },
  { id: "trapezoid", label: "Trapezoid", group: "Basic", words: "manual operation" },
  { id: "star", label: "Star", group: "Basic", words: "favourite favorite highlight" },
  { id: "cross", label: "Cross", group: "Basic", words: "plus add" },
  { id: "cube", label: "Cube", group: "Basic", words: "box 3d block package" },
  { id: "cylinder", label: "Database", group: "Flowchart", words: "cylinder db storage sql table data store" },
  { id: "queue", label: "Queue", group: "Flowchart", words: "horizontal cylinder stream topic bus direct access storage" },
  { id: "document", label: "Document", group: "Flowchart", words: "page paper report file wave" },
  { id: "multidoc", label: "Multiple documents", group: "Flowchart", words: "documents pages reports files stack" },
  { id: "note", label: "Note", group: "Flowchart", words: "folded corner memo card page" },
  { id: "subprocess", label: "Subprocess", group: "Flowchart", words: "predefined process subroutine function" },
  { id: "manualInput", label: "Manual input", group: "Flowchart", words: "keyboard entry form" },
  { id: "delay", label: "Delay", group: "Flowchart", words: "wait pause d shape" },
  { id: "offpage", label: "Off-page link", group: "Flowchart", words: "connector continue reference" },
  { id: "cloud", label: "Cloud", group: "Flowchart", words: "internet network saas hosting" },
  { id: "callout", label: "Speech bubble", group: "Arrows and callouts", words: "callout comment say chat quote" },
  { id: "arrow", label: "Block arrow", group: "Arrows and callouts", words: "arrow right next direction" },
  { id: "doubleArrow", label: "Double arrow", group: "Arrows and callouts", words: "both ways two way exchange" },
  { id: "chevron", label: "Chevron", group: "Arrows and callouts", words: "step stage phase process arrow" },
]);

/** Default sizes (a click with the tool, the Add menu), chosen so each shape looks like itself. */
const SIZES = /** @type {Record<string, [number, number]>} */ ({
  pill: [200, 80], diamond: [180, 120], triangle: [160, 140], octagon: [140, 140], pentagon: [150, 140],
  parallelogram: [200, 110], trapezoid: [200, 110], cylinder: [140, 160], document: [200, 130], cloud: [220, 140],
  callout: [200, 140], star: [150, 145], cross: [130, 130], arrow: [200, 110], chevron: [180, 100],
  multidoc: [200, 140], note: [160, 160], subprocess: [200, 110], manualInput: [200, 110], delay: [180, 110],
  offpage: [120, 120], queue: [220, 100], cube: [160, 150], rightTriangle: [150, 130], doubleArrow: [220, 100],
});

/** The default size of shape `id` (a rectangle's 200 x 120 for the rest). @param {string} id */
export function shapeSize(id) {
  const s = SIZES[id];
  return s ? { w: s[0], h: s[1] } : { w: 200, h: 120 };
}

/** Shape ids, "rect" first (the default). */
export const SHAPE_IDS = Object.freeze(SHAPES.map((s) => s.id));
const LABELS = new Map(SHAPES.map((s) => [s.id, s.label]));
const K = 0.5523; // Bézier circle constant

/** @param {unknown} v @returns {v is string} */
export function isShape(v) {
  return typeof v === "string" && LABELS.has(v);
}

/** @param {string} id */
export function shapeLabel(id) {
  return LABELS.get(id) ?? "Rectangle";
}

/**
 * The outline an object draws: its `style.shape` for rectangles ("rect" when absent or unknown),
 * null for every other type.
 * @param {{type?: string, style?: {shape?: string}}} o
 * @returns {string|null}
 */
export function shapeOf(o) {
  if (o.type !== "rect") return null;
  const s = o.style?.shape;
  return isShape(s) ? s : "rect";
}

/** True for a rectangle drawn with a non-rectangular outline. @param {{type?: string, style?: {shape?: string}}} o */
export function hasCustomOutline(o) {
  const s = shapeOf(o);
  return s !== null && s !== "rect";
}

/** @param {number[]} pts flat [x0, y0, x1, y1, ...] @returns {Cmd[]} */
function polygon(pts) {
  /** @type {Cmd[]} */
  const cmds = [["M", pts[0], pts[1]]];
  for (let i = 2; i < pts.length; i += 2) cmds.push(["L", pts[i], pts[i + 1]]);
  cmds.push(["Z"]);
  return cmds;
}

/** A rounded rectangle with corner radius r. @param {number} w @param {number} h @param {number} r @returns {Cmd[]} */
function roundedRect(w, h, r) {
  const k = r * K;
  return [
    ["M", r, 0], ["L", w - r, 0], ["C", w - r + k, 0, w, r - k, w, r],
    ["L", w, h - r], ["C", w, h - r + k, w - r + k, h, w - r, h],
    ["L", r, h], ["C", r - k, h, 0, h - r + k, 0, h - r],
    ["L", 0, r], ["C", 0, r - k, r - k, 0, r, 0], ["Z"],
  ];
}

/** A document page (wavy bottom) at (x, y), dw x dh. @param {number} x @param {number} y @param {number} dw @param {number} dh @returns {Cmd[]} */
function docPath(x, y, dw, dh) {
  const a = dh * 0.08;
  return [["M", x, y], ["L", x + dw, y], ["L", x + dw, y + dh - a], ["C", x + dw * 0.7, y + dh - 3 * a, x + dw * 0.3, y + dh + a, x, y + dh - a], ["Z"]];
}

const CLOUD = [
  ["M", 44, 110], ["C", 18, 110, 0, 92, 0, 70], ["C", 0, 50, 16, 34, 36, 32], ["C", 42, 13, 60, 0, 82, 0],
  ["C", 104, 0, 122, 12, 128, 30], ["C", 156, 28, 180, 48, 180, 72], ["C", 180, 94, 162, 110, 140, 110], ["Z"],
];

/**
 * The outline of shape `id` in a w x h box (local coordinates), an optional detail path drawn
 * over it without fill (the cylinder's rim), outlines drawn behind it with the same paint (the
 * pages of a document stack), and the box its text goes in. Hit testing and connector anchors use
 * `cmds` only.
 * @param {string} id @param {number} w @param {number} h
 * @returns {{cmds: Cmd[], detail: Cmd[]|null, text: Rect, behind?: Cmd[][]}}
 */
export function shapeOutline(id, w, h) {
  const m = Math.min(w, h);
  const full = { x: 0, y: 0, w, h };
  switch (id) {
    case "rounded": {
      const r = Math.min(m * 0.18, m / 2);
      return { cmds: roundedRect(w, h, r), detail: null, text: full };
    }
    case "pill": {
      const r = m / 2;
      return { cmds: roundedRect(w, h, r), detail: null, text: { x: r * 0.4, y: 0, w: Math.max(1, w - r * 0.8), h } };
    }
    case "diamond":
      return { cmds: polygon([w / 2, 0, w, h / 2, w / 2, h, 0, h / 2]), detail: null, text: { x: w * 0.22, y: h * 0.22, w: w * 0.56, h: h * 0.56 } };
    case "triangle":
      return { cmds: polygon([w / 2, 0, w, h, 0, h]), detail: null, text: { x: w * 0.25, y: h * 0.45, w: w * 0.5, h: h * 0.52 } };
    case "hexagon": {
      const k = Math.min(w * 0.25, h * 0.289);
      return { cmds: polygon([k, 0, w - k, 0, w, h / 2, w - k, h, k, h, 0, h / 2]), detail: null, text: { x: k * 0.6, y: 0, w: w - k * 1.2, h } };
    }
    case "octagon": {
      const k = m * 0.293;
      return {
        cmds: polygon([k, 0, w - k, 0, w, k, w, h - k, w - k, h, k, h, 0, h - k, 0, k]), detail: null,
        text: { x: k * 0.4, y: k * 0.4, w: w - k * 0.8, h: h - k * 0.8 },
      };
    }
    case "pentagon":
      return {
        cmds: polygon([w / 2, 0, w, h * 0.38, w * 0.81, h, w * 0.19, h, 0, h * 0.38]), detail: null,
        text: { x: w * 0.18, y: h * 0.3, w: w * 0.64, h: h * 0.66 },
      };
    case "parallelogram": {
      const k = Math.min(w * 0.25, h * 0.5);
      return { cmds: polygon([k, 0, w, 0, w - k, h, 0, h]), detail: null, text: { x: k * 0.5, y: 0, w: w - k, h } };
    }
    case "trapezoid": {
      const k = Math.min(w * 0.25, h * 0.5);
      return { cmds: polygon([k, 0, w - k, 0, w, h, 0, h]), detail: null, text: { x: k * 0.5, y: 0, w: w - k, h } };
    }
    case "cylinder": {
      const ry = Math.min(h * 0.15, w * 0.25), rx = w / 2, kx = rx * K, ky = ry * K;
      return {
        cmds: [
          ["M", 0, ry], ["C", 0, ry - ky, rx - kx, 0, rx, 0], ["C", rx + kx, 0, w, ry - ky, w, ry],
          ["L", w, h - ry], ["C", w, h - ry + ky, rx + kx, h, rx, h], ["C", rx - kx, h, 0, h - ry + ky, 0, h - ry], ["Z"],
        ],
        detail: [["M", 0, ry], ["C", 0, ry + ky, rx - kx, 2 * ry, rx, 2 * ry], ["C", rx + kx, 2 * ry, w, ry + ky, w, ry]],
        text: { x: 0, y: 2 * ry, w, h: Math.max(1, h - 3 * ry) },
      };
    }
    case "document": {
      const a = h * 0.08;
      return {
        cmds: [["M", 0, 0], ["L", w, 0], ["L", w, h - a], ["C", w * 0.7, h - 3 * a, w * 0.3, h + a, 0, h - a], ["Z"]],
        detail: null, text: { x: 0, y: 0, w, h: Math.max(1, h - 2 * a) },
      };
    }
    case "multidoc": {
      const o = Math.min(w, h) * 0.07, dw = w - 2 * o, dh = h - 2 * o;
      return {
        cmds: docPath(0, 2 * o, dw, dh), detail: null, behind: [docPath(2 * o, 0, dw, dh), docPath(o, o, dw, dh)],
        text: { x: 0, y: 2 * o, w: dw, h: Math.max(1, dh * 0.84) },
      };
    }
    case "note": {
      const f = Math.min(w, h) * 0.2;
      return {
        cmds: polygon([0, 0, w - f, 0, w, f, w, h, 0, h]), detail: [["M", w - f, 0], ["L", w - f, f], ["L", w, f]],
        text: { x: 0, y: f * 0.5, w, h: Math.max(1, h - f * 0.5) },
      };
    }
    case "subprocess": {
      const k = Math.min(w * 0.12, h * 0.3);
      return {
        cmds: polygon([0, 0, w, 0, w, h, 0, h]), detail: [["M", k, 0], ["L", k, h], ["M", w - k, 0], ["L", w - k, h]],
        text: { x: k, y: 0, w: Math.max(1, w - 2 * k), h },
      };
    }
    case "manualInput":
      return { cmds: polygon([0, h * 0.3, w, 0, w, h, 0, h]), detail: null, text: { x: 0, y: h * 0.25, w, h: h * 0.75 } };
    case "delay": {
      const r = Math.min(h / 2, w / 2), k = r * K;
      return {
        cmds: [["M", 0, 0], ["L", w - r, 0], ["C", w - r + k, 0, w, r - k, w, r], ["L", w, h - r], ["C", w, h - r + k, w - r + k, h, w - r, h], ["L", 0, h], ["Z"]],
        detail: null, text: { x: 0, y: 0, w: Math.max(1, w - r * 0.4), h },
      };
    }
    case "offpage":
      return { cmds: polygon([0, 0, w, 0, w, h * 0.65, w / 2, h, 0, h * 0.65]), detail: null, text: { x: 0, y: 0, w, h: h * 0.68 } };
    case "queue": {
      const ry = h / 2, rx = Math.min(w * 0.15, h * 0.3), kx = rx * K, ky = ry * K;
      return {
        cmds: [
          ["M", rx, 0], ["L", w - rx, 0], ["C", w - rx + kx, 0, w, ry - ky, w, ry], ["C", w, ry + ky, w - rx + kx, h, w - rx, h],
          ["L", rx, h], ["C", rx - kx, h, 0, ry + ky, 0, ry], ["C", 0, ry - ky, rx - kx, 0, rx, 0], ["Z"],
        ],
        detail: [["M", w - rx, 0], ["C", w - rx - kx, 0, w - 2 * rx, ry - ky, w - 2 * rx, ry], ["C", w - 2 * rx, ry + ky, w - rx - kx, h, w - rx, h]],
        text: { x: rx * 0.6, y: 0, w: Math.max(1, w - rx * 2.6), h },
      };
    }
    case "cube": {
      const d = Math.min(w, h) * 0.18;
      return {
        cmds: polygon([0, d, d, 0, w, 0, w, h - d, w - d, h, 0, h]),
        detail: [["M", 0, d], ["L", w - d, d], ["L", w, 0], ["M", w - d, d], ["L", w - d, h]],
        text: { x: 0, y: d, w: w - d, h: h - d },
      };
    }
    case "rightTriangle":
      return { cmds: polygon([0, 0, w, h, 0, h]), detail: null, text: { x: w * 0.04, y: h * 0.5, w: w * 0.55, h: h * 0.47 } };
    case "doubleArrow": {
      const hl = Math.min(w * 0.3, h * 0.6);
      return {
        cmds: polygon([0, h / 2, hl, 0, hl, h * 0.25, w - hl, h * 0.25, w - hl, 0, w, h / 2, w - hl, h, w - hl, h * 0.75, hl, h * 0.75, hl, h]),
        detail: null, text: { x: hl * 0.6, y: h * 0.25, w: Math.max(1, w - hl * 1.2), h: h * 0.5 },
      };
    }
    case "cloud":
      return {
        cmds: CLOUD.map((c) => c.map((v, i) => (typeof v === "number" ? (i % 2 ? v * w / 180 : v * h / 110) : v))),
        detail: null, text: { x: w * 0.14, y: h * 0.34, w: w * 0.72, h: h * 0.56 },
      };
    case "callout": {
      const bh = h * 0.78;
      return {
        cmds: polygon([0, 0, w, 0, w, bh, w * 0.4, bh, w * 0.15, h, w * 0.2, bh, 0, bh]), detail: null,
        text: { x: 0, y: 0, w, h: bh },
      };
    }
    case "star": {
      /** @type {number[]} */
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = (-90 + 36 * i) * Math.PI / 180, r = i % 2 ? 0.382 : 1;
        pts.push((r * Math.cos(a) + 0.951) / 1.902 * w, (r * Math.sin(a) + 1) / 1.809 * h);
      }
      return { cmds: polygon(pts), detail: null, text: { x: w * 0.24, y: h * 0.36, w: w * 0.52, h: h * 0.4 } };
    }
    case "cross": {
      const x1 = w * 0.3, x2 = w * 0.7, y1 = h * 0.3, y2 = h * 0.7;
      return {
        cmds: polygon([x1, 0, x2, 0, x2, y1, w, y1, w, y2, x2, y2, x2, h, x1, h, x1, y2, 0, y2, 0, y1, x1, y1]), detail: null,
        text: { x: 0, y: y1, w, h: y2 - y1 },
      };
    }
    case "arrow": {
      const hl = Math.min(w * 0.4, h * 0.6);
      return {
        cmds: polygon([0, h * 0.25, w - hl, h * 0.25, w - hl, 0, w, h / 2, w - hl, h, w - hl, h * 0.75, 0, h * 0.75]), detail: null,
        text: { x: 0, y: h * 0.25, w: Math.max(1, w - hl * 0.4), h: h * 0.5 },
      };
    }
    case "chevron": {
      const k = Math.min(w * 0.3, h * 0.5);
      return { cmds: polygon([0, 0, w - k, 0, w, h / 2, w - k, h, 0, h, k, h / 2]), detail: null, text: { x: k, y: 0, w: Math.max(1, w - 2 * k), h } };
    }
    default:
      return { cmds: polygon([0, 0, w, 0, w, h, 0, h]), detail: null, text: full };
  }
}

/** @param {number} v */
const f2 = (v) => String(Math.round(v * 100) / 100 + 0);

/**
 * SVG path data of commands offset by (ox, oy), numbers to 2 decimals.
 * @param {Cmd[]} cmds @param {number} [ox] @param {number} [oy] @param {(v: number) => string} [fmt]
 */
export function cmdsToPath(cmds, ox = 0, oy = 0, fmt = f2) {
  let d = "";
  for (const c of cmds) {
    d += c[0];
    for (let i = 1; i < c.length; i += 2) d += (i > 1 ? " " : "") + fmt(/** @type {number} */ (c[i]) + ox) + " " + fmt(/** @type {number} */ (c[i + 1]) + oy);
  }
  return d;
}

/**
 * The outline flattened to a polygon (local coordinates): curves sampled 8 times each.
 * @param {Cmd[]} cmds @returns {Point[]}
 */
export function flattenCmds(cmds) {
  /** @type {Point[]} */
  const out = [];
  let x = 0, y = 0;
  for (const c of cmds) {
    const n = /** @type {number[]} */ (c.slice(1));
    if (c[0] === "M" || c[0] === "L") { x = n[0]; y = n[1]; out.push({ x, y }); }
    else if (c[0] === "C") {
      for (let i = 1; i <= 8; i++) {
        const t = i / 8, u = 1 - t;
        out.push({
          x: u * u * u * x + 3 * u * u * t * n[0] + 3 * u * t * t * n[2] + t * t * t * n[4],
          y: u * u * u * y + 3 * u * u * t * n[1] + 3 * u * t * t * n[3] + t * t * t * n[5],
        });
      }
      x = n[4]; y = n[5];
    }
  }
  return out;
}

/** Polygon cache keyed by shape and size (boards reuse a few sizes). @type {Map<string, Point[]>} */
const polyCache = new Map();

/** @param {string} id @param {number} w @param {number} h @returns {Point[]} */
function localPolygon(id, w, h) {
  const key = `${id}|${w}|${h}`;
  let poly = polyCache.get(key);
  if (!poly) {
    poly = flattenCmds(shapeOutline(id, w, h).cmds);
    if (polyCache.size > 512) polyCache.clear();
    polyCache.set(key, poly);
  }
  return poly;
}

/**
 * Whether local point (x, y) is inside shape `id` of size w x h (even-odd rule).
 * @param {string} id @param {number} w @param {number} h @param {number} x @param {number} y
 */
export function insideShape(id, w, h, x, y) {
  const poly = localPolygon(id, w, h);
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Where a connector meets shape `id` on `side`, in local coordinates: the outermost crossing of
 * the outline on the line from the box centre towards that side's midpoint (so an end never sits
 * inside the shape, and an elbow's stub leaves along the same line). When the outline only meets
 * that line at the centre, the outline point nearest the side's midpoint. Null for an empty outline.
 * @param {string} id @param {number} w @param {number} h @param {"top"|"right"|"bottom"|"left"} side
 * @returns {Point|null}
 */
export function localOutlineAnchor(id, w, h, side) {
  const poly = localPolygon(id, w, h);
  const cx = w / 2, cy = h / 2;
  const horizontal = side === "left" || side === "right";
  const dir = side === "right" || side === "bottom" ? 1 : -1;
  let best = -Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    // Crossing of the edge with the axis line through the centre (y = cy or x = cx).
    const [ua, ub, va, vb, c] = horizontal ? [a.y, b.y, a.x, b.x, cy] : [a.x, b.x, a.y, b.y, cx];
    if ((ua - c) * (ub - c) > 0 || ua === ub) continue;
    const t = (c - ua) / (ub - ua);
    const v = va + t * (vb - va);
    const along = (v - (horizontal ? cx : cy)) * dir;
    if (along > best) best = along;
  }
  if (Number.isFinite(best) && best > 1e-6) return horizontal ? { x: cx + best * dir, y: cy } : { x: cx, y: cy + best * dir };
  // The outline passes through the centre on that side (a right triangle's hypotenuse): the
  // outline point nearest the side's midpoint instead.
  const m = { top: { x: cx, y: 0 }, bottom: { x: cx, y: h }, left: { x: 0, y: cy }, right: { x: w, y: cy } }[side];
  let near = null, nd = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((m.x - a.x) * dx + (m.y - a.y) * dy) / len2)) : 0;
    const p = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(p.x - m.x, p.y - m.y);
    if (d < nd) { nd = d; near = p; }
  }
  return near;
}
