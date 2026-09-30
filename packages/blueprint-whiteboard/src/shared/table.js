// @ts-check
// Tables: layout (shared by the renderer, the export and the in-place editor), the pure edits the
// editor and agents make (rows and columns in and out), and parsing pasted tables (tab-separated
// text from spreadsheets, CSV and Markdown pipe tables).
//
// Rows share the height equally; columns take `colWidths` as relative weights (equal when absent
// or not one per column). Cell text wraps within its cell, and a cell shows only the lines that
// fit, the last cut with "…".

import { wrapText, LINE_HEIGHT } from "./geometry.js";
import { LIMITS } from "./protocol.js";

/** Cell padding as a fraction of the font size. */
const CELL_PAD_EM = 0.5;

/**
 * @typedef {object} CellLayout
 * @property {number} r @property {number} c
 * @property {number} x @property {number} y @property {number} w @property {number} h  text box (padded)
 * @property {number} baseline  of the first line
 * @property {string[]} lines
 * @property {boolean} header
 */

/** @param {{cells?: string[][]}} o @returns {string[][]} */
export function cellsOf(o) {
  return Array.isArray(o.cells) && o.cells.length && Array.isArray(o.cells[0]) && o.cells[0].length ? o.cells : [[""]];
}

/**
 * Relative column widths normalised to fractions summing to 1.
 * @param {{colWidths?: number[]|null}} o @param {number} cols
 */
export function columnFractions(o, cols) {
  const w = Array.isArray(o.colWidths) && o.colWidths.length === cols ? o.colWidths : null;
  const total = w ? w.reduce((a, b) => a + b, 0) : cols;
  return Array.from({ length: cols }, (_, i) => (w ? w[i] : 1) / total);
}

/**
 * @param {{x: number, y: number, w: number, h: number, cells?: string[][], header?: boolean,
 *   colWidths?: number[]|null, style: {fontSize: number}}} o
 */
export function tableLayout(o) {
  const cells = cellsOf(o);
  const rows = cells.length, cols = cells[0].length;
  const fr = columnFractions(o, cols);
  /** @type {number[]} */
  const xs = [o.x];
  for (let c = 0; c < cols; c++) xs.push(xs[c] + fr[c] * o.w);
  const rowH = o.h / rows;
  const fs = o.style.fontSize;
  const lineHeight = fs * LINE_HEIGHT;
  const pad = fs * CELL_PAD_EM;
  /** @type {CellLayout[]} */
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = xs[c] + pad, y = o.y + r * rowH + pad * 0.6;
      const w = Math.max(1, xs[c + 1] - xs[c] - 2 * pad), h = Math.max(1, rowH - pad * 1.2);
      const maxLines = Math.max(1, Math.floor(h / lineHeight));
      const text = cells[r][c] ?? "";
      const lines = text ? wrapText(text, w, fs, maxLines) : [];
      const blockH = lines.length * lineHeight;
      const top = y + Math.max(0, (h - blockH) / 2);
      out.push({ r, c, x, y, w, h, lines, header: !!o.header && r === 0 && rows > 1, baseline: top + (lineHeight - fs) / 2 + fs * 0.8 });
    }
  }
  return { rows, cols, xs, rowH, lineHeight, cells: out };
}

/**
 * The cell under world point p (unrotated: tables never rotate), or null outside the table.
 * @param {Parameters<typeof tableLayout>[0]} o @param {{x: number, y: number}} p
 */
export function cellAt(o, p) {
  if (p.x < o.x || p.y < o.y || p.x > o.x + o.w || p.y > o.y + o.h) return null;
  const L = tableLayout(o);
  const r = Math.min(L.rows - 1, Math.floor((p.y - o.y) / L.rowH));
  let c = 0;
  while (c < L.cols - 1 && p.x >= L.xs[c + 1]) c++;
  return { r, c };
}

// ---------------------------------------------------------------------------------------------
// Edits: each returns the patch fields to write ({cells, colWidths?, h?}), or null when the table
// is already at its limit. Rows keep the row height (the table grows or shrinks), columns keep the
// table's width (the other columns give or take room).
// ---------------------------------------------------------------------------------------------

/**
 * @param {{h: number, cells?: string[][]}} o @param {number} at  index of the new row
 * @returns {{cells: string[][], h: number}|null}
 */
export function insertRow(o, at) {
  const cells = cellsOf(o);
  if (cells.length >= LIMITS.tableRows) return null;
  const i = Math.max(0, Math.min(cells.length, at));
  const next = [...cells.slice(0, i).map((r) => [...r]), cells[0].map(() => ""), ...cells.slice(i).map((r) => [...r])];
  return { cells: next, h: round2(o.h * next.length / cells.length) };
}

/**
 * @param {{h: number, cells?: string[][]}} o @param {number} at
 * @returns {{cells: string[][], h: number}|null}
 */
export function removeRow(o, at) {
  const cells = cellsOf(o);
  if (cells.length <= 1) return null;
  const i = Math.max(0, Math.min(cells.length - 1, at));
  const next = cells.filter((_, k) => k !== i).map((r) => [...r]);
  return { cells: next, h: round2(o.h * next.length / cells.length) };
}

/**
 * @param {{cells?: string[][], colWidths?: number[]|null}} o @param {number} at
 * @returns {{cells: string[][], colWidths: number[]|null}|null}
 */
export function insertColumn(o, at) {
  const cells = cellsOf(o);
  const cols = cells[0].length;
  if (cols >= LIMITS.tableCols) return null;
  const i = Math.max(0, Math.min(cols, at));
  const w = Array.isArray(o.colWidths) && o.colWidths.length === cols ? o.colWidths : null;
  return {
    cells: cells.map((r) => [...r.slice(0, i), "", ...r.slice(i)]),
    colWidths: w ? [...w.slice(0, i), round3(w.reduce((a, b) => a + b, 0) / cols), ...w.slice(i)] : null,
  };
}

/**
 * @param {{cells?: string[][], colWidths?: number[]|null}} o @param {number} at
 * @returns {{cells: string[][], colWidths: number[]|null}|null}
 */
export function removeColumn(o, at) {
  const cells = cellsOf(o);
  const cols = cells[0].length;
  if (cols <= 1) return null;
  const i = Math.max(0, Math.min(cols - 1, at));
  const w = Array.isArray(o.colWidths) && o.colWidths.length === cols ? o.colWidths : null;
  return { cells: cells.map((r) => r.filter((_, k) => k !== i)), colWidths: w ? w.filter((_, k) => k !== i) : null };
}

/**
 * Column weights that fit each column's longest line (approximate text widths), between 1 and 6
 * relative to the narrowest.
 * @param {{cells?: string[][], style: {fontSize: number}}} o
 * @param {(text: string, fontSize: number) => number} measure
 */
export function fitColumns(o, measure) {
  const cells = cellsOf(o);
  const widths = cells[0].map((_, c) => Math.max(measure("MM", o.style.fontSize), ...cells.map((r) => Math.max(...String(r[c] ?? "").split("\n").map((l) => measure(l, o.style.fontSize))))));
  const min = Math.min(...widths);
  return widths.map((w) => round3(Math.min(6, Math.max(1, w / min))));
}

// ---------------------------------------------------------------------------------------------
// Pasted tables
// ---------------------------------------------------------------------------------------------

/**
 * Cells from pasted text: a Markdown pipe table (with its |---| rule), tab-separated rows (what
 * spreadsheets copy) or CSV with quotes. Null when the text is not a table of at least two cells.
 * @param {string} text
 * @returns {{cells: string[][], header: boolean}|null}
 */
export function parseTable(text) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!src.trim()) return null;
  const lines = src.split("\n");
  // Markdown: every line starts or ends with a pipe, and the second line is the rule.
  if (lines.length >= 2 && lines.every((l) => /^\s*\|.*\|\s*$/.test(l)) && /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[1])) {
    const row = (/** @type {string} */ l) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
    const cells = [row(lines[0]), ...lines.slice(2).map(row)];
    return square(cells, true);
  }
  if (src.includes("\t")) {
    const cells = lines.map((l) => l.split("\t"));
    return cells.length * cells[0].length >= 2 && cells.some((r) => r.length > 1) ? square(cells, false) : null;
  }
  const csv = parseCsv(src);
  if (csv && csv.length >= 2 && csv[0].length >= 2 && csv.every((r) => r.length === csv[0].length)) return square(csv, false);
  return null;
}

/** @param {string[][]} cells @param {boolean} header */
function square(cells, header) {
  const rows = cells.slice(0, LIMITS.tableRows);
  const cols = Math.min(LIMITS.tableCols, Math.max(...rows.map((r) => r.length)));
  return { cells: rows.map((r) => Array.from({ length: cols }, (_, i) => String(r[i] ?? "").slice(0, LIMITS.tableCell))), header };
}

/**
 * RFC 4180-style CSV (quoted fields may hold commas, quotes and newlines). Null on a stray quote.
 * @param {string} src
 * @returns {string[][]|null}
 */
function parseCsv(src) {
  if (!src.includes(",")) return null;
  /** @type {string[][]} */
  const rows = [[]];
  let field = "", quoted = false, i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { quoted = true; i++; continue; }
    if (ch === '"') return null;
    if (ch === ",") { rows[rows.length - 1].push(field.trim()); field = ""; i++; continue; }
    if (ch === "\n") { rows[rows.length - 1].push(field.trim()); rows.push([]); field = ""; i++; continue; }
    field += ch; i++;
  }
  if (quoted) return null;
  rows[rows.length - 1].push(field.trim());
  return rows;
}

/** Table cells as Markdown (for copying out and agent summaries). @param {{cells?: string[][], header?: boolean}} o */
export function tableToMarkdown(o) {
  const cells = cellsOf(o);
  const esc = (/** @type {string} */ s) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const line = (/** @type {string[]} */ r) => `| ${r.map(esc).join(" | ")} |`;
  const head = o.header ? cells[0] : cells[0].map(() => "");
  const body = o.header ? cells.slice(1) : cells;
  return [line(head), `|${head.map(() => " --- ").join("|")}|`, ...body.map(line)].join("\n");
}

/** @param {number} v */
const round2 = (v) => Math.round(v * 100) / 100;
/** @param {number} v */
const round3 = (v) => Math.round(v * 1000) / 1000;
