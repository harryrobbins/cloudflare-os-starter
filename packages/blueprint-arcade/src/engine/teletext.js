// @ts-check
// A BBC Micro Mode 7 (teletext) page: 40 x 25 character cells with the in-line control codes of
// the SAA5050, drawn onto a Screen. Each cell is 8 x 10 pixels, so the page fills a 320 x 250
// screen (mode "teletext").
//
// A control code occupies a cell and shows as a space (or the held graphic). Codes act from the
// next cell on ("set-after") except background changes, which act at once, as on the real chip.
// Codes are ordinary characters, available as tt.RED, tt.GFX_RED, tt.DOUBLE, tt.FLASH and so on,
// so a line is built by concatenation: tt.YELLOW + "SCORE " + tt.WHITE + score.

const COLOURS = ["BLACK", "RED", "GREEN", "YELLOW", "BLUE", "MAGENTA", "CYAN", "WHITE"];

/** Control codes, as one-character strings. */
export const TT = (() => {
  /** @type {Record<string, string>} */
  const codes = {};
  COLOURS.forEach((name, i) => {
    if (i > 0) codes[name] = String.fromCharCode(0x80 + i);
    if (i > 0) codes[`GFX_${name}`] = String.fromCharCode(0x90 + i);
  });
  Object.assign(codes, {
    FLASH: "\x88", STEADY: "\x89", NORMAL: "\x8c", DOUBLE: "\x8d", CONCEAL: "\x98",
    CONTIGUOUS: "\x99", SEPARATED: "\x9a", BLACK_BG: "\x9c", NEW_BG: "\x9d", HOLD: "\x9e", RELEASE: "\x9f",
  });
  return codes;
})();

/**
 * A mosaic graphic from six cells, top-left to bottom-right in reading order (2 wide, 3 high).
 * block(1,1,0,0,1,1) is the top and bottom rows filled. Use after a GFX_ colour code.
 * @param {...number} bits
 */
export function block(...bits) {
  const weights = [1, 2, 4, 8, 16, 64];
  let v = 0x20;
  bits.slice(0, 6).forEach((b, i) => { if (b) v += weights[i]; });
  return String.fromCharCode(v);
}

export class TeletextPage {
  constructor() {
    /** @type {string[][]} */
    this.cells = Array.from({ length: 25 }, () => new Array(40).fill(" "));
    this.revealed = false;
  }

  cls() { for (const r of this.cells) r.fill(" "); }

  /**
   * Writes text (with control codes) at a row and column; returns the column after it.
   * @param {number} row 0-24 @param {number} col 0-39 @param {string} text
   */
  print(row, col, text) {
    if (row < 0 || row > 24) return col;
    let c = Math.max(0, col);
    for (const ch of String(text)) {
      if (c > 39) break;
      this.cells[row][c++] = ch;
    }
    return c;
  }

  /** Centres plain text on a row, with optional leading control codes. @param {number} row @param {string} text @param {string} [codes] */
  center(row, text, codes = "") {
    const width = codes.length + text.length;
    return this.print(row, Math.max(0, Math.floor((40 - width) / 2)), codes + text);
  }

  /** Fills a row with a solid mosaic block in a colour, like a teletext banner. @param {number} row @param {string} colour e.g. "BLUE" */
  banner(row, colour = "BLUE") {
    this.print(row, 0, TT[colour] + TT.NEW_BG + " ".repeat(38));
  }

  /** @param {number} row @param {number} col */
  get(row, col) { return this.cells[row]?.[col] ?? " "; }

  /**
   * Draws the page. `t` (seconds) drives flashing. Colours are BBC palette indices 0-7.
   * @param {import("./gfx.js").Screen} g @param {number} [t] @param {number} [x] @param {number} [y]
   */
  draw(g, t = 0, x = 0, y = 0) {
    const flashOff = Math.floor(t * 1.5) % 2 === 1;
    // Rows whose double-height top half was drawn on the row above are skipped.
    let skipNext = false;
    for (let row = 0; row < 25; row++) {
      if (skipNext) { skipNext = false; continue; }
      let fg = 7, bg = 0, gfx = false, flash = false, dbl = false, conceal = false, separated = false;
      let held = " ", hold = false;
      let rowHasDouble = false;
      for (let col = 0; col < 40; col++) {
        const ch = this.cells[row][col];
        const code = ch.charCodeAt(0);
        const px = x + col * 8, py = y + row * 10;
        let show = ch;
        let nextFg = fg, nextGfx = gfx, nextFlash = flash, nextDbl = dbl, nextConceal = conceal;
        if (code >= 0x80 && code <= 0x9f) {
          const low = code & 0x0f;
          if (code >= 0x81 && code <= 0x87) { nextFg = low; nextGfx = false; nextConceal = false; }
          else if (code >= 0x91 && code <= 0x97) { nextFg = low; nextGfx = true; nextConceal = false; }
          else if (code === 0x88) nextFlash = true;
          else if (code === 0x89) nextFlash = false;
          else if (code === 0x8c) nextDbl = false;
          else if (code === 0x8d) { nextDbl = true; rowHasDouble = true; }
          else if (code === 0x98) nextConceal = true;
          else if (code === 0x99) separated = false;
          else if (code === 0x9a) separated = true;
          else if (code === 0x9c) bg = 0;
          else if (code === 0x9d) bg = fg;
          else if (code === 0x9e) hold = true;
          else if (code === 0x9f) hold = false;
          show = hold && gfx ? held : " ";
        }
        g.fill(px, py, 8, dbl ? 20 : 10, bg);
        const hidden = (flash && flashOff) || (conceal && !this.revealed);
        if (!hidden && show !== " ") {
          const sc = show.charCodeAt(0);
          if (gfx && ((sc >= 0x20 && sc < 0x40) || (sc >= 0x60 && sc < 0x80))) {
            this.mosaic(g, px, py, sc, fg, dbl, separated);
            held = show;
          } else {
            g.text(show, px, py + 1, fg, { sy: dbl ? 2 : 1 });
          }
        }
        fg = nextFg; gfx = nextGfx; flash = nextFlash; dbl = nextDbl; conceal = nextConceal;
      }
      if (rowHasDouble) skipNext = true;
    }
  }

  /**
   * @param {any} g @param {number} px @param {number} py @param {number} code @param {number} fg
   * @param {boolean} dbl @param {boolean} separated
   */
  mosaic(g, px, py, code, fg, dbl, separated) {
    const bits = code - 0x20; // bits 0-4 and 0x40 are the six cells
    const k = dbl ? 2 : 1;
    const heights = [3 * k, 4 * k, 3 * k];
    let yy = py;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 2; c++) {
        const bit = r * 2 + c;
        const mask = bit === 5 ? 0x40 : 1 << bit;
        if (bits & mask) {
          const s = separated ? 1 : 0;
          g.fill(px + c * 4 + s, yy + s, 4 - s, heights[r] - s, fg);
        }
      }
      yy += heights[r];
    }
  }
}
