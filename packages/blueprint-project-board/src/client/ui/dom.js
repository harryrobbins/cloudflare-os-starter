// @ts-check
// A tiny element builder. Text is always set with textContent; nothing here parses HTML, so
// record contents can never inject markup.

/**
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs] `on*` keys add listeners; `class`, `text`, `hidden`,
 *   `disabled`, `value` are properties; everything else becomes an attribute (null/false skipped).
 * @param {...(Node|string|null|undefined|false)[]|(Node|string|null|undefined|false)} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "text") el.textContent = String(value);
    else if (key === "hidden" || key === "disabled" || key === "value" || key === "checked" || key === "selected") {
      /** @type {any} */ (el)[key] = value;
    } else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

/** @param {string|null|undefined} iso */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** @param {string} value */
export function option(value, label, selected = false) {
  return h("option", { value, selected }, label);
}
