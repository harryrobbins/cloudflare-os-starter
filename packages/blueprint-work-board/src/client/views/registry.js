// @ts-check
// Layouts the board can show for a view. Board and List ship here; the Insights brief registers a
// Reports layout the same way (and the gadget server's documents.js `registerLayout`).
//
// A layout is created once and updated with the app's model; it owns its DOM and keyboard
// navigation and reports back through `onAction`.

/**
 * @typedef {{
 *   el: HTMLElement,
 *   navigate: (dir: string) => boolean,
 *   focusCurrent: (opts?: { scroll?: boolean }) => boolean,
 * }} LayoutInstance
 * @typedef {{ id: string, label: string, icon: string, shortcut?: string,
 *   create: (deps: { doc: Document, onAction: (type: string, payload?: any) => void }) => LayoutInstance & Record<string, any> }} LayoutDef
 */

/** @type {Map<string, LayoutDef>} */
const layouts = new Map();

/** @param {LayoutDef} def */
export function registerLayout(def) { layouts.set(def.id, def); }
/** @param {string} id */
export function layoutDef(id) { return layouts.get(id) ?? null; }
export function allLayouts() { return [...layouts.values()]; }
