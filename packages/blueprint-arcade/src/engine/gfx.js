// @ts-check
// The screen: a palette-indexed framebuffer (one byte per pixel) with pixel-exact drawing. It needs
// no canvas, so games run headless in tests; the host copies it to a canvas once per frame.

import { FONT8X8 } from "../shared/font8x8.js";

/** Palettes as "#rrggbb" lists. Index 0 is the usual background. */
export const PALETTES = {
  // BBC Micro: 8 colours, then 8 "flashing" colours that alternate with their complement.
  bbc: ["#000000", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"],
  // RM Nimbus-style 16 colours (CGA-like ordering: dark then bright).
  nimbus: ["#000000", "#0000aa", "#aa0000", "#aa00aa", "#00aa00", "#00aaaa", "#aa5500", "#aaaaaa",
    "#555555", "#5555ff", "#ff5555", "#ff55ff", "#55ff55", "#55ffff", "#ffff55", "#ffffff"],
  cga: ["#000000", "#55ffff", "#ff55ff", "#ffffff"],
  zx: ["#000000", "#0000d8", "#d80000", "#d800d8", "#00d800", "#00d8d8", "#d8d800", "#d8d8d8",
    "#000000", "#0000ff", "#ff0000", "#ff00ff", "#00ff00", "#00ffff", "#ffff00", "#ffffff"],
  c64: ["#000000", "#ffffff", "#68372b", "#70a4b2", "#6f3d86", "#588d43", "#352879", "#b8c76f",
    "#6f4f25", "#433900", "#9a6759", "#444444", "#6c6c6c", "#9ad284", "#6c5eb5", "#959595"],
  pico: ["#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f", "#c2c3c7", "#fff1e8",
    "#ff004d", "#ffa300", "#ffec27", "#00e436", "#29adff", "#83769c", "#ff77a8", "#ffccaa"],
  arcade: ["#000000", "#ffffff", "#ff3b3b", "#3bff5a", "#3b8cff", "#ffe93b", "#ff3bf2", "#3bf2ff",
    "#ff8c1a", "#8a8a8a", "#2a2a2a", "#9d5cff", "#1a7f2e", "#7f1a1a", "#1a3a7f", "#ffc0cb"],
  green: ["#001a00", "#33ff66", "#1f9940", "#0d4d20"],
  amber: ["#1a0f00", "#ffb000", "#b37b00", "#4d3500"],
  gameboy: ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"],
};

/** Colour names, resolved against the current palette's nearest entry. */
const NAMED = {
  black: "#000000", white: "#ffffff", red: "#ff0000", green: "#00ff00", blue: "#0000ff", yellow: "#ffff00",
  magenta: "#ff00ff", cyan: "#00ffff", grey: "#888888", gray: "#888888", orange: "#ff8800", pink: "#ffaacc",
  brown: "#884400", purple: "#8800cc",
};

/** Screen modes: size, pixel shape and palette in one word. */
export const MODES = {
  default: { width: 320, height: 256, pixelAspect: 1, palette: "arcade" },
  arcade: { width: 224, height: 256, pixelAspect: 1, palette: "arcade" },
  bbc0: { width: 640, height: 256, pixelAspect: 0.5, palette: "bbc" },
  bbc1: { width: 320, height: 256, pixelAspect: 1, palette: "bbc" },
  bbc2: { width: 160, height: 256, pixelAspect: 2, palette: "bbc" },
  teletext: { width: 320, height: 250, pixelAspect: 1.2, palette: "bbc" },
  nimbus: { width: 320, height: 250, pixelAspect: 1, palette: "nimbus" },
  nimbushi: { width: 640, height: 250, pixelAspect: 0.5, palette: "nimbus" },
  vector: { width: 320, height: 240, pixelAspect: 1, palette: "green" },
  gameboy: { width: 160, height: 144, pixelAspect: 1, palette: "gameboy" },
};

export const TRANSPARENT = 255;

/** @param {string} hex @returns {[number, number, number]} */
export function hexToRgb(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * @typedef {{w: number, h: number, data: Uint8Array}} Sprite  data holds palette indices, 255 transparent
 * @typedef {number|string} Color  a palette index, "#rgb"/"#rrggbb", or a name like "red"
 */

export class Screen {
  /** @param {number} width @param {number} height @param {string|string[]} palette */
  constructor(width, height, palette = "arcade") {
    this.W = Math.max(8, Math.min(1024, Math.round(width)));
    this.H = Math.max(8, Math.min(1024, Math.round(height)));
    this.pixels = new Uint8Array(this.W * this.H);
    this.camX = 0;
    this.camY = 0;
    /** Screen-shake offset the engine adds to the camera for one frame. */
    this.shakeX = 0;
    this.shakeY = 0;
    /** @type {Map<string, number>} */
    this.colorCache = new Map();
    this.setPalette(palette);
  }

  /** @param {string|string[]} palette a PALETTES name or a list of "#rrggbb" */
  setPalette(palette) {
    const list = Array.isArray(palette) ? palette : PALETTES[/** @type {keyof typeof PALETTES} */ (palette)] ?? PALETTES.arcade;
    this.paletteName = Array.isArray(palette) ? "custom" : palette;
    /** @type {[number, number, number][]} */
    this.rgb = list.slice(0, 250).map(hexToRgb);
    this.colorCache.clear();
    // The BBC's flashing colours 8-15: each alternates between colour n-8 and its complement.
    this.flashing = this.paletteName === "bbc";
  }

  /** The brightest "normal text" colour: 7, or the palette's last colour when it has fewer than 8. */
  get white() { return Math.min(7, this.rgb.length - 1); }

  /** How many colours the palette has (not counting BBC flashing colours). */
  get colors() { return this.rgb.length; }

  /** Resolves a colour to a palette index: nearest palette entry for names and hex strings. @param {Color} c */
  color(c) {
    if (typeof c === "number") return c | 0;
    if (typeof c !== "string") return 1 % this.rgb.length;
    const hit = this.colorCache.get(c);
    if (hit !== undefined) return hit;
    const key = c.toLowerCase();
    const hex = key.startsWith("#") ? key : NAMED[/** @type {keyof typeof NAMED} */ (key)];
    if (!hex) throw new Error(`Unknown colour "${c}": use a palette number, "#rrggbb" or one of ${Object.keys(NAMED).join(", ")}`);
    const [r, g, b] = hexToRgb(hex);
    let best = 0;
    let bestD = Infinity;
    this.rgb.forEach(([pr, pg, pb], i) => {
      const d = (pr - r) ** 2 * 3 + (pg - g) ** 2 * 4 + (pb - b) ** 2 * 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    this.colorCache.set(c, best);
    return best;
  }

  /** Offsets every later drawing call by (-x, -y), for scrolling and screen shake. */
  camera(x = 0, y = 0) { this.camX = Math.round(x + this.shakeX); this.camY = Math.round(y + this.shakeY); }

  /** @param {Color} [c] */
  cls(c = 0) { this.pixels.fill(this.color(c)); }

  /** @param {number} x @param {number} y @param {Color} c */
  pset(x, y, c) {
    x = Math.floor(x) - this.camX; y = Math.floor(y) - this.camY;
    if (x >= 0 && y >= 0 && x < this.W && y < this.H) this.pixels[y * this.W + x] = this.color(c);
  }

  /** @param {number} x @param {number} y */
  pget(x, y) {
    x = Math.floor(x) - this.camX; y = Math.floor(y) - this.camY;
    return x >= 0 && y >= 0 && x < this.W && y < this.H ? this.pixels[y * this.W + x] : 0;
  }

  /** Raw horizontal span, already in screen space. @param {number} x0 @param {number} x1 @param {number} y @param {number} ci */
  span(x0, x1, y, ci) {
    if (y < 0 || y >= this.H) return;
    const a = Math.max(0, Math.ceil(x0));
    const b = Math.min(this.W - 1, Math.floor(x1));
    if (b >= a) this.pixels.fill(ci, y * this.W + a, y * this.W + b + 1);
  }

  /** @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {Color} c */
  line(x0, y0, x1, y1, c) {
    const ci = this.color(c);
    x0 = Math.round(x0) - this.camX; y0 = Math.round(y0) - this.camY;
    x1 = Math.round(x1) - this.camX; y1 = Math.round(y1) - this.camY;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let n = 0; n < 4096; n++) {
      if (x0 >= 0 && y0 >= 0 && x0 < this.W && y0 < this.H) this.pixels[y0 * this.W + x0] = ci;
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  /** Outline. @param {number} x @param {number} y @param {number} w @param {number} h @param {Color} c */
  rect(x, y, w, h, c) {
    if (w <= 0 || h <= 0) return;
    this.line(x, y, x + w - 1, y, c); this.line(x, y + h - 1, x + w - 1, y + h - 1, c);
    this.line(x, y, x, y + h - 1, c); this.line(x + w - 1, y, x + w - 1, y + h - 1, c);
  }

  /** Filled rectangle. @param {number} x @param {number} y @param {number} w @param {number} h @param {Color} c */
  fill(x, y, w, h, c) {
    const ci = this.color(c);
    x = Math.round(x) - this.camX; y = Math.round(y) - this.camY;
    for (let yy = Math.max(0, y); yy < Math.min(this.H, y + Math.round(h)); yy++) this.span(x, x + Math.round(w) - 1, yy, ci);
  }

  /** @param {number} cx @param {number} cy @param {number} r @param {Color} c */
  circ(cx, cy, r, c) {
    let x = Math.round(r), y = 0, err = 1 - x;
    while (x >= y) {
      for (const [px, py] of [[x, y], [y, x], [-y, x], [-x, y], [-x, -y], [-y, -x], [y, -x], [x, -y]]) this.pset(cx + px, cy + py, c);
      y++;
      if (err < 0) err += 2 * y + 1; else { x--; err += 2 * (y - x) + 1; }
    }
  }

  /** Filled circle. @param {number} cx @param {number} cy @param {number} r @param {Color} c */
  disc(cx, cy, r, c) {
    const ci = this.color(c);
    cx = Math.round(cx) - this.camX; cy = Math.round(cy) - this.camY;
    for (let dy = -Math.round(r); dy <= Math.round(r); dy++) {
      const dx = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
      this.span(cx - dx, cx + dx, cy + dy, ci);
    }
  }

  /** Closed outline through points given as [x0, y0, x1, y1, ...] or [[x, y], ...]. @param {number[]|number[][]} pts @param {Color} c */
  poly(pts, c) {
    const p = flat(pts);
    for (let i = 0; i < p.length; i += 2) {
      const j = (i + 2) % p.length;
      this.line(p[i], p[i + 1], p[j], p[j + 1], c);
    }
  }

  /** Filled polygon (even-odd scanline). @param {number[]|number[][]} pts @param {Color} c */
  polyfill(pts, c) {
    const ci = this.color(c);
    const p = flat(pts).map((v, i) => v - (i % 2 ? this.camY : this.camX));
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < p.length; i += 2) { minY = Math.min(minY, p[i]); maxY = Math.max(maxY, p[i]); }
    for (let y = Math.max(0, Math.ceil(minY)); y <= Math.min(this.H - 1, Math.floor(maxY)); y++) {
      const xs = [];
      for (let i = 0; i < p.length; i += 2) {
        const j = (i + 2) % p.length;
        const [x0, y0, x1, y1] = [p[i], p[i + 1], p[j], p[j + 1]];
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) this.span(Math.round(xs[k]), Math.round(xs[k + 1]), y, ci);
    }
  }

  /**
   * Text in the 8x8 font. Returns the width drawn. `\n` starts a new line.
   * @param {string|number} str @param {number} x @param {number} y @param {Color} [c]
   * @param {{scale?: number, sx?: number, sy?: number, align?: "left"|"center"|"right", shadow?: Color, bg?: Color}} [opts]
   *   scale multiplies both axes; sx/sy stretch one axis (sy: 2 is BBC double height)
   */
  text(str, x, y, c = this.white, opts = {}) {
    const s = String(str);
    const sx = Math.max(1, Math.round(opts.sx ?? opts.scale ?? 1));
    const sy = Math.max(1, Math.round(opts.sy ?? opts.scale ?? 1));
    const lines = s.split("\n");
    let widest = 0;
    lines.forEach((line, li) => {
      const w = line.length * 8 * sx;
      widest = Math.max(widest, w);
      let lx = Math.round(x);
      if (opts.align === "center") lx -= Math.floor(w / 2);
      else if (opts.align === "right") lx -= w;
      const ly = Math.round(y) + li * 9 * sy;
      if (opts.bg !== undefined) this.fill(lx, ly - 1, w, 9 * sy, opts.bg);
      if (opts.shadow !== undefined) this.glyphs(line, lx + sx, ly + sy, opts.shadow, sx, sy);
      this.glyphs(line, lx, ly, c, sx, sy);
    });
    return widest;
  }

  /** @param {string} line @param {number} x @param {number} y @param {Color} c @param {number} sx @param {number} sy */
  glyphs(line, x, y, c, sx, sy) {
    const ci = this.color(c);
    for (let k = 0; k < line.length; k++) {
      const code = line.charCodeAt(k);
      const hex = FONT8X8[code - 32] ?? FONT8X8[31]; // unknown characters draw as "?"
      if (code === 32) continue;
      for (let row = 0; row < 8; row++) {
        const bits = parseInt(hex.slice(row * 2, row * 2 + 2), 16);
        if (!bits) continue;
        for (let col = 0; col < 8; col++) {
          if (!(bits & (0x80 >> col))) continue;
          const px = x + (k * 8 + col) * sx - this.camX;
          const py = y + row * sy - this.camY;
          for (let yy = 0; yy < sy; yy++) this.span(px, px + sx - 1, py + yy, ci);
        }
      }
    }
  }

  /** Width in pixels of `str` at a scale. @param {string|number} str @param {number} [scale] */
  textWidth(str, scale = 1) { return Math.max(...String(str).split("\n").map((l) => l.length)) * 8 * scale; }

  /**
   * Draws a sprite (from sprite()). `color` recolours every opaque pixel; `scale` is whole-number.
   * @param {Sprite} spr @param {number} x @param {number} y
   * @param {{flipX?: boolean, flipY?: boolean, scale?: number, color?: Color, center?: boolean}} [opts]
   */
  sprite(spr, x, y, opts = {}) {
    if (!spr?.data) throw new Error("g.sprite needs a sprite made with a.sprite([...rows])");
    const s = Math.max(1, Math.round(opts.scale ?? 1));
    const tint = opts.color === undefined ? -1 : this.color(opts.color);
    let ox = Math.round(x) - this.camX, oy = Math.round(y) - this.camY;
    if (opts.center) { ox -= Math.floor((spr.w * s) / 2); oy -= Math.floor((spr.h * s) / 2); }
    for (let row = 0; row < spr.h; row++) {
      const sr = opts.flipY ? spr.h - 1 - row : row;
      for (let col = 0; col < spr.w; col++) {
        const v = spr.data[sr * spr.w + (opts.flipX ? spr.w - 1 - col : col)];
        if (v === TRANSPARENT) continue;
        const ci = tint >= 0 ? tint : v;
        const px = ox + col * s, py = oy + row * s;
        for (let yy = 0; yy < s; yy++) this.span(px, px + s - 1, py + yy, ci);
      }
    }
  }

  /**
   * RGBA bytes for the frame, resolving BBC flashing colours at time `t` (seconds).
   * @param {Uint8ClampedArray} out @param {number} t
   */
  toRgba(out, t = 0) {
    const flashOn = this.flashing && Math.floor(t * 2.5) % 2 === 1;
    const lut = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let rgb;
      if (this.flashing && i >= 8 && i < 16) {
        const base = this.rgb[(i - 8) % this.rgb.length];
        rgb = flashOn ? base.map((v) => 255 - v) : base;
      } else rgb = this.rgb[i % this.rgb.length];
      lut[i] = (255 << 24) | (rgb[2] << 16) | (rgb[1] << 8) | rgb[0];
    }
    const out32 = new Uint32Array(out.buffer, out.byteOffset, this.W * this.H);
    for (let i = 0; i < this.pixels.length; i++) out32[i] = lut[this.pixels[i]];
  }
}

/** @param {number[]|number[][]} pts */
function flat(pts) {
  return Array.isArray(pts[0]) ? /** @type {number[][]} */ (pts).flat() : /** @type {number[]} */ (pts);
}

/**
 * Makes a sprite from rows of characters. "." and " " are transparent; 0-9 and a-f are palette
 * indices (hex); any other character uses `key` (e.g. {X: 2, o: "yellow"}) or else colour 7.
 * Colour names in `key` are resolved against `screen`'s palette when given.
 * @param {string[]|string} rows @param {Record<string, Color>} [key] @param {Screen} [screen]
 * @returns {Sprite}
 */
export function makeSprite(rows, key = {}, screen) {
  const lines = (Array.isArray(rows) ? rows : String(rows).split("\n")).map((r) => r.replace(/\s+$/, "")).filter((r, i, all) => r.length || (i > 0 && i < all.length - 1));
  const w = Math.max(1, ...lines.map((r) => r.length));
  const h = Math.max(1, lines.length);
  const data = new Uint8Array(w * h).fill(TRANSPARENT);
  lines.forEach((r, y) => {
    for (let x = 0; x < r.length; x++) {
      const ch = r[x];
      if (ch === "." || ch === " ") continue;
      let v;
      if (ch in key) {
        const k = key[ch];
        v = typeof k === "number" ? k : screen ? screen.color(k) : 7;
      } else if (/[0-9a-f]/.test(ch)) v = parseInt(ch, 16);
      else v = 7;
      data[y * w + x] = v;
    }
  });
  return { w, h, data };
}
