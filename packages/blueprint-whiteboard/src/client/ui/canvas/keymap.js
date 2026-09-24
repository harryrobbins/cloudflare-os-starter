// @ts-check
// Keyboard shortcuts, as ONE table (COMMANDS) read both by the key handling (keyAction: a pure
// mapping from a key event to an action) and by the shortcuts dialog (src/client/ui/help.js), so
// the help cannot drift from what the keys do.

/** @typedef {import("../ui-contract.js").Tool} Tool */

/**
 * @typedef {{type: "delete"} | {type: "nudge", dx: number, dy: number} | {type: "undo"} | {type: "redo"}
 *   | {type: "duplicate"} | {type: "selectAll"} | {type: "escape"} | {type: "edit"}
 *   | {type: "front"} | {type: "back"} | {type: "tool", tool: Tool}
 *   | {type: "zoomIn"} | {type: "zoomOut"} | {type: "fit"} | {type: "zoomReset"}
 *   | {type: "resize", dw: number, dh: number} | {type: "rotate", deg: number} | {type: "contextMenu"}
 *   | {type: "command", command: ShellCommand}
 *   | {type: "present", step: "next"|"previous"|"first"|"last"|"exit"}} KeyAction
 *
 * "nudge" moves the selection by (dx, dy) world units; with nothing selected the canvas pans the
 * view instead (see panStep). "command" actions belong to the app shell: the canvas passes them on
 * as a "command" event. "present" actions apply only while presenting (scope "presentation").
 */

/** @typedef {"addMenu"|"outline"|"icons"|"help"|"present"|"emoji"} ShellCommand */

/**
 * How a key event matches: `key` (one-character keys compared lower-cased) or `code`. `mod` (Ctrl
 * or ⌘) defaults to false and `alt` to false; `shift` must equal the event's when given. An
 * explicit `alt: undefined` accepts either.
 * @typedef {{key?: string, code?: string, mod?: boolean, shift?: boolean, alt?: boolean}} KeyMatch
 */

/**
 * One command. `keys` are what the help shows ("Mod" reads Ctrl, or ⌘ on a Mac). A command
 * without `match` is listed in the help only: the browser's own copy/cut/paste events, pointer
 * gestures and keys a text field handles. A command without `label` is a key variant of the one
 * before it and is not listed.
 * @typedef {object} Command
 * @property {string} id
 * @property {string} group   help section
 * @property {string} label   what it does, as the help says it
 * @property {string[]} keys  display form, alternatives
 * @property {KeyMatch[]} [match]
 * @property {KeyAction|((e: KeyEventLike) => KeyAction)} [action]
 * @property {"canvas"|"presentation"|"text"} [scope]  default "canvas"; "text": while typing in
 *   the inline text editor (text-editor.js)
 */

/** @typedef {{key: string, code?: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean}} KeyEventLike */

/** Degrees one , or . press rotates by. */
export const ROTATE_STEP = 15;
/** Screen pixels an arrow key pans the view by when nothing is selected (Shift: PAN_STEP_BIG). */
export const PAN_STEP = 40;
export const PAN_STEP_BIG = 200;

/** @type {Record<string, Tool>} */
export const TOOL_KEYS = Object.freeze({
  v: "select", h: "hand", n: "sticky", r: "rect", o: "ellipse", t: "text", f: "frame", c: "connector", p: "pen",
});

/** @type {Record<Tool, string>} */
const TOOL_LABELS = {
  select: "Select", hand: "Hand (pan)", sticky: "Sticky note", rect: "Rectangle", ellipse: "Ellipse",
  text: "Text", frame: "Frame", connector: "Connector", pen: "Pen",
};

/** @param {-1|1} sign @param {"x"|"y"} axis @returns {(e: KeyEventLike) => KeyAction} */
const nudge = (sign, axis) => (e) => {
  const step = sign * (e.shiftKey ? 10 : 1);
  return { type: "nudge", dx: axis === "x" ? step : 0, dy: axis === "y" ? step : 0 };
};
/** @param {-1|1} sign @param {"w"|"h"} axis @returns {(e: KeyEventLike) => KeyAction} */
const grow = (sign, axis) => (e) => {
  const step = sign * (e.shiftKey ? 10 : 1);
  return { type: "resize", dw: axis === "w" ? step : 0, dh: axis === "h" ? step : 0 };
};
/** A key variant of the command listed before it. @param {string} id @param {KeyMatch} match @param {Command["action"]} action @returns {Command} */
const variant = (id, match, action) => ({ id, group: "", label: "", keys: [], match: [match], action });

const SELECT = "Select and arrange";

/**
 * Every shortcut, in the order the help lists them and keyAction tries them (first match wins).
 * @type {readonly Command[]}
 */
export const COMMANDS = Object.freeze([
  // Tools
  ...Object.entries(TOOL_KEYS).map(([k, tool]) => /** @type {Command} */ ({
    id: `tool-${tool}`, group: "Tools", label: `${TOOL_LABELS[tool]} tool`, keys: [k.toUpperCase()],
    match: [{ key: k, shift: false }], action: { type: "tool", tool },
  })),
  { id: "add-menu", group: "Tools", label: "Add menu: add an object at the centre of the view", keys: ["A"], match: [{ key: "a", shift: false }], action: { type: "command", command: "addMenu" } },

  // Edit
  { id: "edit", group: "Edit", label: "Edit the selected object's text", keys: ["Enter"], match: [{ key: "Enter" }], action: { type: "edit" } },
  { id: "finish-edit", group: "Edit", label: "Finish editing text", keys: ["Mod+Enter", "Escape"] },
  { id: "delete", group: "Edit", label: "Delete the selection", keys: ["Delete", "Backspace"], match: [{ key: "Delete" }, { key: "Backspace" }], action: { type: "delete" } },
  { id: "duplicate", group: "Edit", label: "Duplicate", keys: ["Mod+D"], match: [{ key: "d", mod: true }], action: { type: "duplicate" } },
  { id: "copy", group: "Edit", label: "Copy", keys: ["Mod+C"] },
  { id: "cut", group: "Edit", label: "Cut", keys: ["Mod+X"] },
  { id: "paste", group: "Edit", label: "Paste objects, or one sticky note per line of text", keys: ["Mod+V"] },
  { id: "undo", group: "Edit", label: "Undo", keys: ["Mod+Z"], match: [{ key: "z", mod: true, shift: false }], action: { type: "undo" } },
  { id: "redo", group: "Edit", label: "Redo", keys: ["Mod+Shift+Z", "Mod+Y"], match: [{ key: "z", mod: true, shift: true }, { key: "y", mod: true }], action: { type: "redo" } },

  // Selection and arrangement
  { id: "select-all", group: SELECT, label: "Select all", keys: ["Mod+A"], match: [{ key: "a", mod: true }], action: { type: "selectAll" } },
  { id: "escape", group: SELECT, label: "Cancel a gesture, clear the selection, or go back to Select", keys: ["Escape"], match: [{ key: "Escape" }], action: { type: "escape" } },
  { id: "nudge", group: SELECT, label: "Move the selection by 1 (Shift: 10), or pan the view when nothing is selected", keys: ["Arrow keys", "Shift+Arrow keys"] },
  variant("nudge-left", { key: "ArrowLeft" }, nudge(-1, "x")),
  variant("nudge-right", { key: "ArrowRight" }, nudge(1, "x")),
  variant("nudge-up", { key: "ArrowUp" }, nudge(-1, "y")),
  variant("nudge-down", { key: "ArrowDown" }, nudge(1, "y")),
  { id: "resize", group: SELECT, label: "Make the selection wider, narrower, taller or shorter by 1 (Shift: 10)", keys: ["Alt+Arrow keys"] },
  variant("resize-left", { key: "ArrowLeft", alt: true }, grow(-1, "w")),
  variant("resize-right", { key: "ArrowRight", alt: true }, grow(1, "w")),
  variant("resize-up", { key: "ArrowUp", alt: true }, grow(-1, "h")),
  variant("resize-down", { key: "ArrowDown", alt: true }, grow(1, "h")),
  { id: "rotate-ccw", group: SELECT, label: `Rotate ${ROTATE_STEP}° anticlockwise`, keys: [","], match: [{ key: "," }], action: { type: "rotate", deg: -ROTATE_STEP } },
  { id: "rotate-cw", group: SELECT, label: `Rotate ${ROTATE_STEP}° clockwise`, keys: ["."], match: [{ key: "." }], action: { type: "rotate", deg: ROTATE_STEP } },
  { id: "front", group: SELECT, label: "Bring to front", keys: ["]"], match: [{ key: "]" }], action: { type: "front" } },
  { id: "back", group: SELECT, label: "Send to back", keys: ["["], match: [{ key: "[" }], action: { type: "back" } },
  { id: "context-menu", group: SELECT, label: "Actions menu for the selection", keys: ["Context menu key", "Shift+F10"],
    match: [{ key: "ContextMenu", alt: undefined }, { key: "F10", shift: true }], action: { type: "contextMenu" } },

  // View
  { id: "zoom-in", group: "View", label: "Zoom in", keys: ["+"], match: [{ key: "+" }, { key: "=" }, { key: "+", mod: true }, { key: "=", mod: true }], action: { type: "zoomIn" } },
  { id: "zoom-out", group: "View", label: "Zoom out", keys: ["-"], match: [{ key: "-" }, { key: "_" }, { key: "-", mod: true }, { key: "_", mod: true }], action: { type: "zoomOut" } },
  { id: "fit", group: "View", label: "Zoom to fit everything", keys: ["Shift+1"], match: [{ code: "Digit1", shift: true }, { key: "!", shift: true }], action: { type: "fit" } },
  { id: "zoom-reset", group: "View", label: "Reset the zoom to 100%", keys: ["Shift+0"], match: [{ code: "Digit0", shift: true }, { key: ")", shift: true }], action: { type: "zoomReset" } },
  { id: "pan", group: "View", label: "Pan the view", keys: ["Space+drag", "Shift+scroll"] },
  { id: "outline", group: "View", label: "Objects list", keys: ["Shift+O"], match: [{ key: "o", shift: true }], action: { type: "command", command: "outline" } },
  { id: "present", group: "View", label: "Present the frames one at a time", keys: ["Shift+P"], match: [{ key: "p", shift: true }], action: { type: "command", command: "present" } },
  { id: "icons", group: "Tools", label: "Icons and shapes", keys: ["I"], match: [{ key: "i", shift: false }], action: { type: "command", command: "icons" } },
  { id: "emoji", group: "Tools", label: "Emoji and symbols (while typing, inserts at the caret)", keys: ["Mod+."], match: [{ key: ".", mod: true }], action: { type: "command", command: "emoji" } },
  { id: "emoji-text", group: "", label: "", keys: [], scope: "text", match: [{ key: ".", mod: true }], action: { type: "command", command: "emoji" } },
  { id: "help", group: "View", label: "Show these keyboard shortcuts", keys: ["?"], match: [{ key: "?" }], action: { type: "command", command: "help" } },

  // While presenting
  { id: "present-next", group: "Presenting", scope: "presentation", label: "Next frame", keys: ["→", "Page Down", "Space"],
    match: [{ key: "ArrowRight" }, { key: "ArrowDown" }, { key: "PageDown" }, { key: " " }], action: { type: "present", step: "next" } },
  { id: "present-previous", group: "Presenting", scope: "presentation", label: "Previous frame", keys: ["←", "Page Up"],
    match: [{ key: "ArrowLeft" }, { key: "ArrowUp" }, { key: "PageUp" }], action: { type: "present", step: "previous" } },
  { id: "present-first", group: "Presenting", scope: "presentation", label: "First frame", keys: ["Home"], match: [{ key: "Home" }], action: { type: "present", step: "first" } },
  { id: "present-last", group: "Presenting", scope: "presentation", label: "Last frame", keys: ["End"], match: [{ key: "End" }], action: { type: "present", step: "last" } },
  { id: "present-exit", group: "Presenting", scope: "presentation", label: "Stop presenting", keys: ["Escape"], match: [{ key: "Escape" }], action: { type: "present", step: "exit" } },
]);

/** Shown to screen readers (aria-describedby) and usable as a help text by the shell. */
export const SHORTCUTS_HINT =
  "Whiteboard canvas. Tools: V select, H hand, N sticky note, R rectangle, O ellipse, T text, F frame, " +
  "C connector, P pen. A opens the Add menu, Shift+O the Objects list. " +
  "I opens icons and shapes, Ctrl+period emoji and symbols. " +
  "Arrow keys move the selection (Shift for 10), or pan the view when nothing is selected. " +
  "Alt+Arrow keys resize the selection by 1 (Shift for 10); comma and period rotate it by 15 degrees. " +
  "Enter edits text, Delete removes, Ctrl+D duplicates, Ctrl+A selects all, ] brings to front, " +
  "[ sends to back, Ctrl+Z undoes, Ctrl+Shift+Z redoes. The context menu key or Shift+F10 opens the " +
  "selection's actions. Plus and minus zoom, Shift+1 zooms to fit, Shift+0 resets to 100%. " +
  "Hold Space and drag to pan. Escape cancels or clears the selection. Question mark lists every shortcut.";

/**
 * @param {KeyEventLike} e @param {string} key normalised @param {KeyMatch} m
 */
function matches(e, key, m) {
  if (!!(e.ctrlKey || e.metaKey) !== !!m.mod) return false;
  if (m.shift !== undefined && !!e.shiftKey !== m.shift) return false;
  const alt = "alt" in m ? m.alt : false;
  if (alt !== undefined && !!e.altKey !== alt) return false;
  return m.code !== undefined ? e.code === m.code : m.key === key;
}

/**
 * The action of a key event, from COMMANDS, or null.
 * @param {KeyEventLike} e
 * @param {"canvas"|"presentation"|"text"} [scope]
 * @returns {KeyAction|null}
 */
export function keyAction(e, scope = "canvas") {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  for (const c of COMMANDS) {
    if (!c.match || !c.action || (c.scope ?? "canvas") !== scope) continue;
    if (c.match.some((m) => matches(e, key, m))) return typeof c.action === "function" ? c.action(e) : c.action;
  }
  return null;
}

/**
 * The commands the help lists, grouped, in table order.
 * @returns {{group: string, commands: Command[]}[]}
 */
export function helpGroups() {
  /** @type {Map<string, Command[]>} */
  const groups = new Map();
  for (const c of COMMANDS) {
    if (!c.label || !c.group) continue;
    const list = groups.get(c.group) ?? [];
    list.push(c);
    groups.set(c.group, list);
  }
  return [...groups].map(([group, commands]) => ({ group, commands }));
}

/**
 * A key as the help shows it: "Mod+" reads "Ctrl+", or "⌘" on a Mac.
 * @param {string} keys @param {boolean} [mac]
 */
export function formatKeys(keys, mac = false) {
  return keys.replace(/Mod\+/g, mac ? "⌘" : "Ctrl+");
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
