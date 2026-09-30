// @ts-check
// Game helpers with no dependence on the screen: random numbers, maths, collision, timers,
// particles, vector shapes, and the falling-block well.

// --- Random ----------------------------------------------------------------------------------

/** A seedable random number generator (mulberry32). @param {number} [seed] */
export function makeRng(seed) {
  let s = (seed ?? Math.floor(Math.random() * 2 ** 32)) >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    /** A float in [0, n), n defaults to 1. @param {number} [n] */
    rnd: (n = 1) => next() * n,
    /** A whole number from lo to hi inclusive. @param {number} lo @param {number} hi */
    rndi: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    /** True with probability p. @param {number} p */
    chance: (p) => next() < p,
    /** @template T @param {T[]} list @returns {T} */
    pick: (list) => list[Math.floor(next() * list.length)],
    /** Shuffles a copy. @template T @param {T[]} list @returns {T[]} */
    shuffle: (list) => {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    /** @param {number} n */
    seed: (n) => { s = n >>> 0; },
  };
}

// --- Maths -----------------------------------------------------------------------------------

export const math = {
  /** @param {number} v @param {number} lo @param {number} hi */
  clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
  /** @param {number} a @param {number} b @param {number} t */
  lerp: (a, b, t) => a + (b - a) * t,
  /** @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 */
  dist: (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1),
  /** Angle in radians from (x1, y1) towards (x2, y2); 0 is right, PI/2 is down. @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 */
  angle: (x1, y1, x2, y2) => Math.atan2(y2 - y1, x2 - x1),
  /** Wraps v into [0, max). @param {number} v @param {number} max */
  wrap: (v, max) => ((v % max) + max) % max,
  /** Moves v towards target by at most step. @param {number} v @param {number} target @param {number} step */
  approach: (v, target, step) => (v < target ? Math.min(v + step, target) : Math.max(v - step, target)),
  sign: Math.sign,
};

/** Easing curves for t in [0, 1]. */
export const ease = {
  /** @param {number} t */ linear: (t) => t,
  /** @param {number} t */ inQuad: (t) => t * t,
  /** @param {number} t */ outQuad: (t) => 1 - (1 - t) * (1 - t),
  /** @param {number} t */ inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  /** @param {number} t */ outBack: (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  /** @param {number} t */ outBounce: (t) => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

// --- Collision -------------------------------------------------------------------------------

/**
 * @typedef {{x: number, y: number, w: number, h: number}} Box
 * @typedef {{x: number, y: number, r: number}} Circle
 */
export const hit = {
  /** Two boxes overlap. @param {Box} a @param {Box} b */
  rects: (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h,
  /** Two circles overlap. @param {Circle} a @param {Circle} b */
  circles: (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 < (a.r + b.r) ** 2,
  /** @param {number} px @param {number} py @param {Box} b */
  point: (px, py, b) => px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h,
  /** A circle and a box overlap. @param {Circle} c @param {Box} b */
  circleRect: (c, b) => {
    const nx = Math.max(b.x, Math.min(c.x, b.x + b.w));
    const ny = Math.max(b.y, Math.min(c.y, b.y + b.h));
    return (c.x - nx) ** 2 + (c.y - ny) ** 2 < c.r * c.r;
  },
  /** Point inside a polygon [x0, y0, x1, y1, ...]. @param {number} px @param {number} py @param {number[]} poly */
  inPoly: (px, py, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
      const [xi, yi, xj, yj] = [poly[i], poly[i + 1], poly[j], poly[j + 1]];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  },
  /** A segment and a circle touch. @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2 @param {Circle} c */
  segCircle: (x1, y1, x2, y2, c) => {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((c.x - x1) * dx + (c.y - y1) * dy) / len2));
    return (x1 + t * dx - c.x) ** 2 + (y1 + t * dy - c.y) ** 2 <= c.r * c.r;
  },
  /** A polygon [x0, y0, ...] and a circle touch. @param {number[]} poly @param {Circle} c */
  polyCircle: (poly, c) => {
    if (hit.inPoly(c.x, c.y, poly)) return true;
    for (let i = 0; i < poly.length; i += 2) {
      const j = (i + 2) % poly.length;
      if (hit.segCircle(poly[i], poly[i + 1], poly[j], poly[j + 1], c)) return true;
    }
    return false;
  },
};

// --- Vector shapes ---------------------------------------------------------------------------

/**
 * Rotates, scales and moves a shape given as [x0, y0, x1, y1, ...] around its origin.
 * @param {number[]} pts @param {number} x @param {number} y @param {number} [angle] radians @param {number} [scale]
 */
export function shape(pts, x, y, angle = 0, scale = 1) {
  const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    out[i] = x + pts[i] * c - pts[i + 1] * s;
    out[i + 1] = y + pts[i] * s + pts[i + 1] * c;
  }
  return out;
}

/**
 * A lumpy rock outline of radius about r. @param {number} r @param {() => number} rnd 0..1
 * @param {number} [points]
 */
export function rock(r, rnd, points = 11) {
  const out = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const rr = r * (0.72 + rnd() * 0.36);
    out.push(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  return out;
}

// --- Timers and particles --------------------------------------------------------------------

export class Timers {
  constructor() { /** @type {{at: number, every: number, fn: Function, dead?: boolean}[]} */ this.list = []; this.frame = 0; }
  /** Runs fn once after `frames` frames; returns a cancel function. @param {number} frames @param {Function} fn */
  after(frames, fn) { const t = { at: this.frame + Math.max(1, frames), every: 0, fn }; this.list.push(t); return () => { t.dead = true; }; }
  /** Runs fn every `frames` frames; returns a cancel function. @param {number} frames @param {Function} fn */
  every(frames, fn) { const t = { at: this.frame + Math.max(1, frames), every: Math.max(1, frames), fn }; this.list.push(t); return () => { t.dead = true; }; }
  tick() {
    this.frame++;
    for (const t of this.list.slice()) {
      if (t.dead || t.at > this.frame) continue;
      t.fn();
      if (t.every) t.at += t.every; else t.dead = true;
    }
    this.list = this.list.filter((t) => !t.dead);
  }
  clear() { this.list = []; }
}

/** @param {() => number} rnd */
export function makeParticles(rnd) {
  /** @type {{x: number, y: number, vx: number, vy: number, life: number, max: number, color: any, gravity: number, size: number}[]} */
  const list = [];
  return {
    list,
    /**
     * @param {number} x @param {number} y
     * @param {{count?: number, color?: any, colors?: any[], speed?: number, life?: number, gravity?: number, size?: number, angle?: number, spread?: number}} [o]
     */
    burst(x, y, o = {}) {
      const n = Math.min(400 - list.length, o.count ?? 16);
      for (let i = 0; i < n; i++) {
        const a = (o.angle ?? 0) + (rnd() - 0.5) * (o.spread ?? Math.PI * 2);
        const sp = (o.speed ?? 2) * (0.3 + rnd() * 0.7);
        const life = Math.round((o.life ?? 30) * (0.5 + rnd() * 0.5));
        const color = o.colors ? o.colors[Math.floor(rnd() * o.colors.length)] : o.color ?? 7;
        list.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life, max: life, color, gravity: o.gravity ?? 0, size: o.size ?? 1 });
      }
    },
    update() {
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        p.x += p.vx; p.y += p.vy; p.vy += p.gravity;
        if (--p.life <= 0) list.splice(i, 1);
      }
    },
    /** @param {{pset: Function, fill: Function}} g */
    draw(g) {
      for (const p of list) {
        if (p.size > 1) g.fill(p.x, p.y, p.size, p.size, p.color);
        else g.pset(p.x, p.y, p.color);
      }
    },
    clear() { list.length = 0; },
  };
}

// --- Grids and falling blocks ----------------------------------------------------------------

/**
 * A 2D grid of values with bounds-checked access.
 * @template T @param {number} cols @param {number} rows @param {T} fillValue
 */
export function makeGrid(cols, rows, fillValue) {
  const cells = Array.from({ length: rows }, () => new Array(cols).fill(fillValue));
  return {
    cols, rows, cells,
    /** @param {number} x @param {number} y */
    inside: (x, y) => x >= 0 && y >= 0 && x < cols && y < rows,
    /** @param {number} x @param {number} y @returns {T|undefined} */
    get: (x, y) => (x >= 0 && y >= 0 && x < cols && y < rows ? cells[y][x] : undefined),
    /** @param {number} x @param {number} y @param {T} v */
    set: (x, y, v) => { if (x >= 0 && y >= 0 && x < cols && y < rows) cells[y][x] = v; },
    /** @param {(v: T, x: number, y: number) => void} fn */
    each: (fn) => { for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) fn(cells[y][x], x, y); },
    /** @param {T} v */
    fill: (v) => { for (const r of cells) r.fill(v); },
  };
}

/**
 * The seven tetrominoes with Super Rotation System rotations: each rotation is four [x, y] cells
 * in a 4x4 (I), 2x2 (O) or 3x3 box, y down. Colours are palette-agnostic names.
 */
export const TETROMINOES = (() => {
  /** @param {string[]} rows */
  const cells = (rows) => rows.flatMap((r, y) => [...r].flatMap((ch, x) => (ch === "#" ? [[x, y]] : [])));
  /** @param {number[][]} cs @param {number} n */
  const rotate = (cs, n) => cs.map(([x, y]) => [n - 1 - y, x]);
  /** @param {string[]} rows */
  const all = (rows) => {
    const n = rows.length;
    const r0 = cells(rows);
    const r1 = rotate(r0, n), r2 = rotate(r1, n), r3 = rotate(r2, n);
    return [r0, r1, r2, r3];
  };
  return {
    I: { color: "cyan", rotations: all(["....", "####", "....", "...."]) },
    O: { color: "yellow", rotations: all(["##", "##"]) },
    T: { color: "magenta", rotations: all([".#.", "###", "..."]) },
    S: { color: "green", rotations: all([".##", "##.", "..."]) },
    Z: { color: "red", rotations: all(["##.", ".##", "..."]) },
    J: { color: "blue", rotations: all(["#..", "###", "..."]) },
    L: { color: "orange", rotations: all(["..#", "###", "..."]) },
  };
})();

// SRS wall kicks, [dx, dy] with y down, for rotating from state `from` to `from + 1` (clockwise).
const KICKS_JLSTZ = [
  [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
];
const KICKS_I = [
  [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
];

/** The kick offsets to try when rotating `type` from `from` by `dir` (1 clockwise, -1 anticlockwise). @param {string} type @param {number} from @param {number} dir */
export function kicks(type, from, dir) {
  if (type === "O") return [[0, 0]];
  const table = type === "I" ? KICKS_I : KICKS_JLSTZ;
  if (dir > 0) return table[((from % 4) + 4) % 4];
  const to = (((from - 1) % 4) + 4) % 4;
  return table[to].map(([x, y]) => [-x, -y]);
}

/** The "7-bag" randomiser: every piece once in each run of seven. @param {() => number} rnd */
export function makeBag(rnd) {
  /** @type {string[]} */
  let bag = [];
  const refill = () => {
    const b = ["I", "O", "T", "S", "Z", "J", "L"];
    for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
    bag.push(...b);
  };
  return {
    next() { if (bag.length < 8) refill(); return /** @type {string} */ (bag.shift()); },
    /** The next n pieces, without taking them. @param {number} n */
    peek(n = 1) { while (bag.length < n) refill(); return bag.slice(0, n); },
    reset() { bag = []; },
  };
}

/**
 * The falling-block well: `cells[y][x]` is null or a colour. Pieces are {type, x, y, rot}.
 * @param {number} cols @param {number} rows
 */
export function makeWell(cols = 10, rows = 20) {
  const g = makeGrid(cols, rows, /** @type {any} */ (null));
  /** @param {{type: string, x: number, y: number, rot: number}} p */
  const cellsOf = (p) => TETROMINOES[/** @type {keyof typeof TETROMINOES} */ (p.type)].rotations[((p.rot % 4) + 4) % 4].map(([cx, cy]) => [p.x + cx, p.y + cy]);
  const well = {
    ...g,
    cellsOf,
    /** Does the piece fit here (inside the walls and floor, not overlapping)? Rows above the top are allowed. @param {{type: string, x: number, y: number, rot: number}} p */
    fits: (p) => cellsOf(p).every(([x, y]) => x >= 0 && x < cols && y < rows && (y < 0 || g.cells[y][x] === null)),
    /**
     * Rotates with SRS wall kicks; returns the moved piece or null when nothing fits.
     * @param {{type: string, x: number, y: number, rot: number}} p @param {number} dir 1 or -1
     */
    rotate: (p, dir) => {
      for (const [dx, dy] of kicks(p.type, p.rot, dir)) {
        const q = { ...p, x: p.x + dx, y: p.y + dy, rot: (((p.rot + dir) % 4) + 4) % 4 };
        if (well.fits(q)) return q;
      }
      return null;
    },
    /** Where the piece would land if dropped. @param {{type: string, x: number, y: number, rot: number}} p */
    dropPosition: (p) => { let q = p; while (well.fits({ ...q, y: q.y + 1 })) q = { ...q, y: q.y + 1 }; return q; },
    /** Writes the piece into the well; returns false when any part is above the top (game over). @param {{type: string, x: number, y: number, rot: number}} p @param {any} [color] */
    place: (p, color) => {
      const c = color ?? TETROMINOES[/** @type {keyof typeof TETROMINOES} */ (p.type)].color;
      let ok = true;
      for (const [x, y] of cellsOf(p)) { if (y < 0) ok = false; else g.cells[y][x] = c; }
      return ok;
    },
    /** Full rows' indices, top to bottom. */
    fullRows: () => g.cells.flatMap((r, y) => (r.every((v) => v !== null) ? [y] : [])),
    /** Removes full rows, shifting the rest down; returns how many were cleared. */
    clearLines: () => {
      const keep = g.cells.filter((r) => r.some((v) => v === null));
      const n = rows - keep.length;
      g.cells.splice(0, rows, ...Array.from({ length: n }, () => new Array(cols).fill(null)), ...keep);
      return n;
    },
    reset: () => g.fill(null),
  };
  return well;
}

// --- Menus -----------------------------------------------------------------------------------

/**
 * A vertical menu driven by up/down and fire. update(input) returns the chosen index once.
 * @param {string[]} items
 */
export function makeMenu(items) {
  const m = {
    items,
    index: 0,
    /** @param {{btnp: (a: string, r?: number) => boolean}} input */
    update(input) {
      if (input.btnp("up", 8)) m.index = (m.index + items.length - 1) % items.length;
      if (input.btnp("down", 8)) m.index = (m.index + 1) % items.length;
      if (input.btnp("fire") || input.btnp("start")) return m.index;
      return -1;
    },
    /** @param {any} g @param {number} x @param {number} y @param {{color?: any, active?: any, gap?: number, align?: any, scale?: number}} [o] */
    draw(g, x, y, o = {}) {
      const scale = o.scale ?? 1;
      items.forEach((it, i) => {
        const on = i === m.index;
        g.text((on ? "> " : "  ") + it, x, y + i * (o.gap ?? 12) * scale, on ? o.active ?? 3 : o.color ?? 7, { align: o.align, scale });
      });
    },
  };
  return m;
}
