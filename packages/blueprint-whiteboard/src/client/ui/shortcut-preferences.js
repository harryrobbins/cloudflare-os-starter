// @ts-check
// Viewer-local, session-only: opaque-origin sandbox storage is not a persistence guarantee.
let characterShortcuts = true;
export function characterShortcutsEnabled() { return characterShortcuts; }
/** @param {boolean} enabled */
export function setCharacterShortcutsEnabled(enabled) { characterShortcuts = !!enabled; }
/**
 * Shift alone still produces a character shortcut. Space remains a navigation key.
 * @param {{key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean}} event
 */
export function shortcutAllowed(event) {
  return characterShortcuts || event.key.length !== 1 || event.key.trim() === "" ||
    !!(event.ctrlKey || event.metaKey || event.altKey);
}
