// @ts-check
// Per-module CSS: each UI module adds its own rules once, so modules stay independent of the
// shell's stylesheet (src/client/ui/styles.js holds the shared tokens and components).

/** @type {Set<string>} */
const added = new Set();

/**
 * Adds `css` to the document once per `id`.
 * @param {string} id @param {string} css
 */
export function ensureStyle(id, css) {
  if (added.has(id)) return;
  added.add(id);
  const style = document.createElement("style");
  style.dataset.module = id;
  style.textContent = css;
  document.head.appendChild(style);
}
