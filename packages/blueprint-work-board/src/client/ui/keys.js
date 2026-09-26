// @ts-check
// Keyboard shortcuts: one verb grammar for the board, list, peek and palette. Single-character
// shortcuts can be switched off per viewer (WCAG 2.1.4) and never fire while typing; modified
// shortcuts (Ctrl/⌘+K etc.) always work.

/**
 * @typedef {{ id: string, keys: string[], label: string, group: string, single?: boolean, display?: string[], chord?: boolean }} Shortcut
 */

/** @type {Shortcut[]} */
export const SHORTCUTS = [
  { id: "palette", keys: ["Mod+k"], label: "Command palette", group: "General" },
  { id: "create", keys: ["c"], label: "Create item", group: "General", single: true },
  { id: "filter", keys: ["/"], label: "Filter (WQL)", group: "General", single: true },
  { id: "toggleLayout", keys: ["Mod+b"], label: "Switch board / list", group: "General" },
  { id: "help", keys: ["?"], label: "Keyboard shortcuts", group: "General", single: true },
  { id: "undo", keys: ["Mod+z"], label: "Undo your last change", group: "General" },
  { id: "goBoard", keys: ["g", "b"], label: "Go to the board", group: "General", chord: true, display: ["G then B"] },
  { id: "goList", keys: ["g", "l"], label: "Go to the list", group: "General", chord: true, display: ["G then L"] },
  { id: "goInsights", keys: ["g", "i"], label: "Go to insights (reports)", group: "General", chord: true, display: ["G then I"] },
  { id: "goProposals", keys: ["g", "p"], label: "Open proposals", group: "General", chord: true, display: ["G then P"] },
  { id: "down", keys: ["j", "ArrowDown"], label: "Next item", group: "Navigate" },
  { id: "up", keys: ["k", "ArrowUp"], label: "Previous item", group: "Navigate" },
  { id: "left", keys: ["h", "ArrowLeft"], label: "Previous column", group: "Navigate" },
  { id: "right", keys: ["l", "ArrowRight"], label: "Next column", group: "Navigate" },
  { id: "first", keys: ["Home"], label: "First column", group: "Navigate" },
  { id: "last", keys: ["End"], label: "Last column", group: "Navigate" },
  { id: "pageUp", keys: ["PageUp"], label: "Up 10 items", group: "Navigate" },
  { id: "pageDown", keys: ["PageDown"], label: "Down 10 items", group: "Navigate" },
  { id: "open", keys: ["Enter"], label: "Open item", group: "Navigate" },
  { id: "peek", keys: [" "], label: "Peek (toggle details)", group: "Navigate" },
  { id: "close", keys: ["Escape"], label: "Close / clear selection", group: "Navigate" },
  { id: "select", keys: ["x"], label: "Select / deselect", group: "Select", single: true },
  { id: "selectAll", keys: ["Mod+a"], label: "Select all shown", group: "Select" },
  { id: "state", keys: ["s"], label: "Set state", group: "Edit", single: true },
  { id: "assign", keys: ["a"], label: "Assign", group: "Edit", single: true },
  { id: "assignMe", keys: ["i"], label: "Assign to me", group: "Edit", single: true },
  { id: "priority", keys: ["p"], label: "Set priority", group: "Edit", single: true },
  { id: "labels", keys: ["l"], label: "Labels", group: "Edit", single: true },
  { id: "estimate", keys: ["e"], label: "Estimate", group: "Edit", single: true },
  { id: "due", keys: ["d"], label: "Due date", group: "Edit", single: true },
  { id: "move", keys: ["m"], label: "Move to… (menu)", group: "Edit", single: true },
  { id: "moveMode", keys: ["Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown"], label: "Move with the keyboard", group: "Edit", display: ["Shift+Arrows"] },
];

// "l" is both "next column" (vim) and "labels" (Linear). Labels wins; arrows move.
const CONFLICTS = new Set(["h", "l"]);

/** @param {EventTarget|null} target */
export function isTyping(target) {
  const el = /** @type {HTMLElement|null} */ (target);
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = /** @type {HTMLInputElement} */ (el).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(type);
  }
  return false;
}

/**
 * The shortcut an event triggers, or null.
 * @param {KeyboardEvent} event @param {{ singleKeys: boolean }} opts
 */
export function matchShortcut(event, opts) {
  const typing = isTyping(event.target);
  const mod = event.ctrlKey || event.metaKey;
  if (event.altKey) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (mod) {
    if (event.shiftKey) return null;
    if (key === "k") return "palette";
    if (typing) return null;
    if (key === "b") return "toggleLayout";
    if (key === "z") return "undo";
    if (key === "a") return "selectAll";
    return null;
  }
  if (typing) return null;
  if (event.shiftKey && key.startsWith("Arrow")) return "moveMode";
  // Character keys (letters, "/", "?") are the ones a viewer can switch off; Space, Enter,
  // Escape, arrows and paging keys always work.
  if (event.key.length === 1 && event.key !== " " && !opts.singleKeys) return null;
  for (const s of SHORTCUTS) {
    if (s.chord || !s.keys.includes(key) || s.keys.some((k) => k.startsWith("Mod+") || k.startsWith("Shift+"))) continue;
    if (CONFLICTS.has(key) && s.id === "right") continue;
    return s.id;
  }
  return null;
}

/** Display text for a key combination. @param {string} combo @param {boolean} mac */
export function keyLabel(combo, mac) {
  return combo.split("+").map((k) => ({ Mod: mac ? "⌘" : "Ctrl", Shift: "⇧", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Arrows: "arrows", Escape: "Esc", " ": "Space", Enter: "↵", PageUp: "PgUp", PageDown: "PgDn" })[k] ?? (k.length === 1 ? k.toUpperCase() : k)).join(mac ? "" : "+");
}

/** @param {string} id */
export function shortcutFor(id) { return SHORTCUTS.find((s) => s.id === id) ?? null; }
