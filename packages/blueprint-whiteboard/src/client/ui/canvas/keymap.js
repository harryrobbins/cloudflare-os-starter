// @ts-check
// Keyboard shortcuts of the canvas, as a pure mapping from a key event to an action.

/** @typedef {import("../ui-contract.js").Tool} Tool */

/**
 * @typedef {{type: "delete"} | {type: "nudge", dx: number, dy: number} | {type: "undo"} | {type: "redo"}
 *   | {type: "duplicate"} | {type: "selectAll"} | {type: "escape"} | {type: "edit"}
 *   | {type: "front"} | {type: "back"} | {type: "tool", tool: Tool}
 *   | {type: "zoomIn"} | {type: "zoomOut"} | {type: "fit"} | {type: "zoomReset"}
 *   | {type: "resize", dw: number, dh: number} | {type: "rotate", deg: number} | {type: "contextMenu"}} KeyAction
 *
 * "nudge" moves the selection by (dx, dy) world units; with nothing selected the canvas pans the
 * view instead (see panStep).
 */

/** Degrees one , or . press rotates by. */
export const ROTATE_STEP = 15;
/** Screen pixels an arrow key pans the view by when nothing is selected (Shift: PAN_STEP_BIG). */
export const PAN_STEP = 40;
export const PAN_STEP_BIG = 200;

/** @type {Record<string, Tool>} */
export const TOOL_KEYS = Object.freeze({
  v: "select", h: "hand", n: "sticky", r: "rect", o: "ellipse", t: "text", f: "frame", c: "connector", p: "pen",
});

/** Shown to screen readers (aria-describedby) and usable as a help text by the shell. */
export const SHORTCUTS_HINT =
  "Whiteboard canvas. Tools: V select, H hand, N sticky note, R rectangle, O ellipse, T text, F frame, " +
  "C connector, P pen. A opens the Add menu, Shift+O the Objects list. " +
  "I opens icons and shapes. " +
  "Arrow keys move the selection (Shift for 10), or pan the view when nothing is selected. " +
  "Alt+Arrow keys resize the selection by 1 (Shift for 10); comma and period rotate it by 15 degrees. " +
  "Enter edits text, Delete removes, Ctrl+D duplicates, Ctrl+A selects all, ] brings to front, " +
  "[ sends to back, Ctrl+Z undoes, Ctrl+Shift+Z redoes. The context menu key or Shift+F10 opens the " +
  "selection's actions. Plus and minus zoom, Shift+1 zooms to fit, Shift+0 resets to 100%. " +
  "Hold Space and drag to pan. Escape cancels or clears the selection.";

/**
 * @param {{key: string, code?: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean}} e
 * @returns {KeyAction|null}
 */
export function keyAction(e) {
  const mod = !!(e.ctrlKey || e.metaKey);
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod) {
    if (e.altKey) return null;
    if (key === "z") return e.shiftKey ? { type: "redo" } : { type: "undo" };
    if (key === "y") return { type: "redo" };
    if (key === "d") return { type: "duplicate" };
    if (key === "a") return { type: "selectAll" };
    if (key === "=" || key === "+") return { type: "zoomIn" };
    if (key === "-" || key === "_") return { type: "zoomOut" };
    return null;
  }
  if (key === "ContextMenu" || (key === "F10" && e.shiftKey && !e.altKey)) return { type: "contextMenu" };
  if (e.altKey) {
    const step = e.shiftKey ? 10 : 1;
    switch (key) {
      case "ArrowLeft": return { type: "resize", dw: -step, dh: 0 };
      case "ArrowRight": return { type: "resize", dw: step, dh: 0 };
      case "ArrowUp": return { type: "resize", dw: 0, dh: -step };
      case "ArrowDown": return { type: "resize", dw: 0, dh: step };
    }
    return null;
  }
  switch (key) {
    case "Delete": case "Backspace": return { type: "delete" };
    case "Escape": return { type: "escape" };
    case "Enter": return { type: "edit" };
    case "ArrowLeft": return { type: "nudge", dx: e.shiftKey ? -10 : -1, dy: 0 };
    case "ArrowRight": return { type: "nudge", dx: e.shiftKey ? 10 : 1, dy: 0 };
    case "ArrowUp": return { type: "nudge", dx: 0, dy: e.shiftKey ? -10 : -1 };
    case "ArrowDown": return { type: "nudge", dx: 0, dy: e.shiftKey ? 10 : 1 };
    case ",": return { type: "rotate", deg: -ROTATE_STEP };
    case ".": return { type: "rotate", deg: ROTATE_STEP };
    case "]": return { type: "front" };
    case "[": return { type: "back" };
    case "+": case "=": return { type: "zoomIn" };
    case "-": case "_": return { type: "zoomOut" };
  }
  if (e.shiftKey && (e.code === "Digit1" || key === "!")) return { type: "fit" };
  if (e.shiftKey && (e.code === "Digit0" || key === ")")) return { type: "zoomReset" };
  if (!e.shiftKey && Object.hasOwn(TOOL_KEYS, key)) return { type: "tool", tool: TOOL_KEYS[key] };
  return null;
}

/**
 * Camera pan in screen pixels for an arrow-key nudge with nothing selected: the view moves the way
 * the arrow points (content moves the other way), so feed the result to panBy.
 * @param {{dx: number, dy: number}} nudge
 * @returns {{x: number, y: number}}
 */
export function panStep({ dx, dy }) {
  const big = Math.abs(dx) > 1 || Math.abs(dy) > 1;
  const step = big ? PAN_STEP_BIG : PAN_STEP;
  return { x: -Math.sign(dx) * step + 0, y: -Math.sign(dy) * step + 0 };
}

/**
 * Spoken direction of a nudge ("right", "up left", ...).
 * @param {number} dx @param {number} dy
 */
export function directionWord(dx, dy) {
  const v = dy < 0 ? "up" : dy > 0 ? "down" : "";
  const hz = dx < 0 ? "left" : dx > 0 ? "right" : "";
  return [v, hz].filter(Boolean).join(" ");
}
