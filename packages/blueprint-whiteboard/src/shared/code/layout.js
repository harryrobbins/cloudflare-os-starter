// @ts-check
// Code block layout: a header strip (language and file name), a line-number gutter and the code in
// a monospace font, one row per line, wrapped at the box width or clipped at it. Columns, not
// measured widths: tabs expand to TAB_WIDTH columns, wide characters (CJK, emoji) take two, and a
// column is CODE_CHAR_EM of the font size. Pure and deterministic, so the canvas, the editor and
// the server's export agree.

import { tokenize } from "./lexer.js";
import { languageLabel } from "./languages.js";

/** @typedef {import("../protocol.js").WhiteboardObject} WhiteboardObject */
/** @typedef {import("./lexer.js").TokenClass} TokenClass */

export const CODE_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace";
/** Advance of one column as a fraction of the font size (typical of monospace fonts). */
export const CODE_CHAR_EM = 0.6;
/** Line height as a multiple of the font size. */
export const CODE_LINE_HEIGHT = 1.5;
/** Columns a tab advances to (the next multiple of). */
export const TAB_WIDTH = 4;

/**
 * @typedef {object} CodeMetrics
 * @property {number} fontSize
 * @property {number} charW       one column, world units
 * @property {number} lineH
 * @property {number} headerH     header strip height (clamped to the box)
 * @property {number} headFont    header font size
 * @property {number} pad         inner padding of the body
 * @property {number} gutterW     line-number gutter width (0 without line numbers)
 * @property {number} textX       left of the code text
 * @property {number} bodyY       top of the body (below the header)
 * @property {number} cols        columns that fit the text width
 * @property {number} lineCount   lines of code (at least 1)
 */

/** @param {number} v */
const r2 = (v) => Math.round(v * 100) / 100 + 0;

/**
 * @param {Pick<WhiteboardObject, "x"|"y"|"w"|"h"|"text"|"style"> & {lineNumbers?: boolean}} o
 * @returns {CodeMetrics}
 */
export function codeMetrics(o) {
  const fontSize = o.style.fontSize;
  const charW = fontSize * CODE_CHAR_EM;
  const lineH = fontSize * CODE_LINE_HEIGHT;
  const headerH = Math.min(o.h, r2(fontSize * 2.2));
  const headFont = Math.max(8, Math.round(fontSize * 0.85));
  const pad = fontSize * 0.75;
  const lineCount = countLines(o.text);
  const gutterW = o.lineNumbers === false ? 0 : (String(lineCount).length + 1.5) * charW;
  const textX = o.x + pad + gutterW;
  const cols = Math.max(1, Math.floor((o.w - 2 * pad - gutterW) / charW + 1e-9));
  return { fontSize, charW, lineH, headerH, headFont, pad, gutterW, textX, bodyY: o.y + headerH, cols, lineCount };
}

/** @param {string} text */
function countLines(text) {
  let n = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** Columns a code point takes. @param {number} code */
export function columnsOf(code) {
  if (code < 0x1100) return 1;
  if ((code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)) return 2;
  return 1;
}

/**
 * @typedef {object} CodeRow
 * @property {number|null} number   the line number, on a line's first row only
 * @property {number} y             baseline
 * @property {[TokenClass, string][]} segs  tabs expanded
 */

/**
 * Splits token lines into visual rows (wrapped at `cols`, or clipped just past it). Calls
 * `onRow(line, segs)` per row in order; stops when it returns false.
 * @param {[TokenClass, string][]} tokens
 * @param {number} cols @param {boolean} wrap
 * @param {(line: number, first: boolean, segs: [TokenClass, string][]) => boolean} onRow
 */
function rows(tokens, cols, wrap, onRow) {
  let line = 1;
  let first = true;
  /** @type {[TokenClass, string][]} */
  let segs = [];
  let col = 0;
  let clipped = false;
  let cls = /** @type {TokenClass} */ ("");
  let buf = "";
  const flushSeg = () => {
    if (buf) {
      const last = segs[segs.length - 1];
      if (last && last[0] === cls) last[1] += buf;
      else segs.push([cls, buf]);
    }
    buf = "";
  };
  const endRow = () => {
    flushSeg();
    const go = onRow(line, first, segs);
    segs = [];
    col = 0;
    first = false;
    return go;
  };
  for (const [tc, text] of tokens) {
    if (tc !== cls) { flushSeg(); cls = tc; }
    for (let i = 0; i < text.length; i++) {
      let code = text.charCodeAt(i);
      if (code === 10) {
        if (!endRow()) return;
        line++;
        first = true;
        clipped = false;
        continue;
      }
      let ch = text[i];
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        const cp = /** @type {number} */ (text.codePointAt(i));
        if (cp > 0xffff) { ch = text.slice(i, i + 2); code = cp; i++; }
      }
      if (clipped) continue;
      let w;
      if (code === 9) {
        w = TAB_WIDTH - (col % TAB_WIDTH);
        ch = " ".repeat(w);
      } else {
        w = columnsOf(code);
      }
      if (col + w > cols && col > 0) {
        if (wrap) {
          if (!endRow()) return;
          if (code === 9) { w = TAB_WIDTH; ch = " ".repeat(w); }
        } else if (col >= cols + 1) {
          clipped = true;
          continue;
        }
      }
      buf += ch;
      col += w;
    }
  }
  endRow();
}

/**
 * Number of visual rows `o`'s code takes at its width.
 * @param {Pick<WhiteboardObject, "x"|"y"|"w"|"h"|"text"|"style"> & {lineNumbers?: boolean, wrap?: boolean}} o
 */
export function codeRowCount(o) {
  if (!o.wrap) return countLines(o.text);
  const m = codeMetrics(o);
  let n = 0;
  rows([["", o.text]], m.cols, true, () => { n++; return true; });
  return Math.max(1, n);
}

/**
 * Height the block needs to show all its code (auto-grow while editing, and after style changes).
 * @param {Pick<WhiteboardObject, "x"|"y"|"w"|"h"|"text"|"style"> & {lineNumbers?: boolean, wrap?: boolean}} o
 */
export function codeHeight(o) {
  const fontSize = o.style.fontSize;
  const header = r2(fontSize * 2.2);
  return Math.ceil(header + 2 * fontSize * 0.75 + codeRowCount(o) * fontSize * CODE_LINE_HEIGHT);
}

/**
 * @typedef {object} CodeLayout
 * @property {CodeMetrics} m
 * @property {string} label      header text: the file name, else the language
 * @property {string} [aside]    the language, at the right, when there is a file name
 * @property {CodeRow[]} rows    only the rows that fall inside the box
 * @property {boolean} degraded  highlighting hit its work cap (the rest is plain)
 */

/**
 * The rows of a code block that fall inside its box, highlighted.
 * @param {WhiteboardObject} o
 * @returns {CodeLayout}
 */
export function codeLayout(o) {
  const m = codeMetrics(o);
  const language = o.language ?? "plain";
  const { tokens, degraded } = tokenize(language, o.text);
  const bodyH = Math.max(0, o.y + o.h - m.bodyY);
  const maxRows = Math.max(0, Math.ceil((bodyH - m.pad) / m.lineH) + 1);
  /** @type {CodeRow[]} */
  const out = [];
  const firstBaseline = m.bodyY + m.pad + (m.lineH - m.fontSize) / 2 + m.fontSize * 0.8;
  if (maxRows > 0) {
    rows(/** @type {[TokenClass, string][]} */ (tokens.length ? tokens : [["", ""]]), m.cols, !!o.wrap, (line, first, segs) => {
      out.push({ number: first ? line : null, y: firstBaseline + out.length * m.lineH, segs });
      return out.length < maxRows;
    });
  }
  const label = languageLabel(language);
  return o.filename ? { m, label: o.filename, aside: label, rows: out, degraded } : { m, label, rows: out, degraded };
}

/**
 * `text` cut to at most `cols` columns, ending with "…" when cut.
 * @param {string} text @param {number} cols
 */
export function fitColumns(text, cols) {
  let col = 0;
  let out = "";
  for (const ch of text) {
    const w = columnsOf(/** @type {number} */ (ch.codePointAt(0)));
    if (col + w > cols) return cols >= 1 ? trimTo(out, cols - 1) + "…" : "";
    out += ch;
    col += w;
  }
  return out;
}

/** @param {string} s @param {number} cols */
function trimTo(s, cols) {
  let col = 0;
  let out = "";
  for (const ch of s) {
    const w = columnsOf(/** @type {number} */ (ch.codePointAt(0)));
    if (col + w > cols) break;
    out += ch;
    col += w;
  }
  return out;
}
