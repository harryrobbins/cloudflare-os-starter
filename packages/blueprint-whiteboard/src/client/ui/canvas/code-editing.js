// @ts-check
// Editing helpers for the code block editor (a <textarea>): indent unit detection, Tab/Shift+Tab
// indent and outdent of the selected lines, and Enter keeping the current line's indentation.
// Pure: each returns the edit to make (a range and its replacement) plus the new selection, so the
// editor can apply it with the browser's own undo (execCommand("insertText")).

import { defaultIndent } from "../../../shared/code/languages.js";
import { TAB_WIDTH } from "../../../shared/code/layout.js";

/**
 * @typedef {object} Edit
 * @property {number} from   replace value[from, to) ...
 * @property {number} to
 * @property {string} insert ... with this
 * @property {number} selStart  selection afterwards
 * @property {number} selEnd
 */

/**
 * The indent one Tab adds: a tab when the code indents with tabs, else the smallest indent its
 * lines use (2 to 8 spaces), else the language's default.
 * @param {string} text @param {string} language
 */
export function indentUnitOf(text, language) {
  let tabs = 0;
  let min = Infinity;
  let lines = 0;
  for (const line of text.split("\n", 2000)) {
    if (!line.trim()) continue;
    lines++;
    if (line[0] === "\t") tabs++;
    let n = 0;
    while (n < line.length && line[n] === " ") n++;
    if (n > 0 && n < min) min = n;
  }
  if (tabs > 0 && tabs * 2 >= lines / 4) return "\t";
  if (min >= 2 && min <= 8) return " ".repeat(min);
  return defaultIndent(language);
}

/** Start of the line holding `pos`. @param {string} value @param {number} pos */
const lineStart = (value, pos) => value.lastIndexOf("\n", pos - 1) + 1;

/**
 * Tab (indent) or Shift+Tab (outdent). A collapsed selection inside a line's indentation or on a
 * blank line indents at the caret; otherwise every line the selection touches moves.
 * @param {string} value @param {number} selStart @param {number} selEnd @param {string} unit
 * @param {boolean} outdent
 * @returns {Edit|null}  null when nothing changes (outdent of unindented lines)
 */
export function indentEdit(value, selStart, selEnd, unit, outdent) {
  if (!outdent && selStart === selEnd) {
    return { from: selStart, to: selEnd, insert: unit, selStart: selStart + unit.length, selEnd: selStart + unit.length };
  }
  const from = lineStart(value, selStart);
  // A selection ending at the very start of a line does not include that line.
  const last = selEnd > selStart && selEnd > 0 && value[selEnd - 1] === "\n" ? selEnd - 1 : selEnd;
  const nl = value.indexOf("\n", last);
  const to = nl < 0 ? value.length : nl;
  const lines = value.slice(from, to).split("\n");
  let first = 0;
  let total = 0;
  const out = lines.map((line, i) => {
    let delta;
    let next;
    if (outdent) {
      let n = 0;
      const max = unit === "\t" ? TAB_WIDTH : unit.length; // a tab unit also removes a tab stop of spaces
      if (line[0] === "\t") n = 1;
      else while (n < max && n < line.length && line[n] === " ") n++;
      next = line.slice(n);
      delta = -n;
    } else {
      next = line.trim() || lines.length === 1 ? unit + line : line;
      delta = next.length - line.length;
    }
    if (i === 0) first = delta;
    total += delta;
    return next;
  }).join("\n");
  if (out === value.slice(from, to)) return null;
  const startAt = Math.max(from, selStart + first);
  return {
    from, to, insert: out,
    selStart: selStart === selEnd ? startAt : Math.max(from, selStart + first),
    selEnd: selStart === selEnd ? startAt : Math.max(from, selEnd + total),
  };
}

/**
 * Enter: a newline followed by the current line's leading whitespace (up to the caret).
 * @param {string} value @param {number} selStart @param {number} selEnd
 * @returns {Edit}
 */
export function newlineEdit(value, selStart, selEnd) {
  const from = lineStart(value, selStart);
  let n = from;
  while (n < selStart && (value[n] === " " || value[n] === "\t")) n++;
  const insert = "\n" + value.slice(from, n);
  return { from: selStart, to: selEnd, insert, selStart: selStart + insert.length, selEnd: selStart + insert.length };
}

/**
 * Applies `edit` to a textarea through the browser's editing commands, so Ctrl+Z undoes it, with
 * a direct value change as the fallback.
 * @param {HTMLTextAreaElement} ta @param {Edit} edit
 */
export function applyEdit(ta, edit) {
  ta.setSelectionRange(edit.from, edit.to);
  let done = false;
  try {
    done = typeof document.execCommand === "function" && document.execCommand("insertText", false, edit.insert);
  } catch {
    done = false;
  }
  if (!done || ta.value.slice(edit.from, edit.from + edit.insert.length) !== edit.insert) {
    ta.setRangeText(edit.insert, edit.from, edit.to, "end");
    ta.dispatchEvent(new Event("input"));
  }
  ta.setSelectionRange(edit.selStart, edit.selEnd);
}
