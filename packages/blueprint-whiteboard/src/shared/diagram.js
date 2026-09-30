// @ts-check
// Diagram objects: D2 or Mermaid source drawn by the MermaiD2 renderer (the `mermaid2://renderer`
// connector, packages/gatekeeper-mermaid2). The board stores only the source and its options;
// the rendered SVG is cached by the server beside the board, keyed by diagramHash, and shown as an
// image (a data: URL in an <image>), so rendered markup never enters the page's DOM and cannot run
// script or load anything. Without a connected renderer the object draws as a placeholder.

/** Source languages. */
export const SYNTAXES = /** @type {const} */ (["d2", "mermaid"]);
/** Layout engines the renderer offers. */
export const LAYOUTS = /** @type {const} */ (["tala", "dagre", "elk"]);

/** Fields a diagram takes when a create leaves them out. */
export const DIAGRAM_DEFAULTS = Object.freeze({ syntax: "d2", layout: "dagre", sketch: false, theme: "light" });

/** Starter sources for a new diagram. */
export const DIAGRAM_EXAMPLES = Object.freeze({
  d2: "user: User {shape: person}\napp: Web app\ndb: Database {shape: cylinder}\n\nuser -> app: uses\napp -> db: reads and writes\n",
  mermaid: "flowchart LR\n  user([User]) --> app[Web app]\n  app --> db[(Database)]\n",
});

/** Renderer theme ids for the board's light and dark diagram themes. */
export const RENDER_THEMES = Object.freeze({ light: 0, dark: 200 });

/** Largest rendered SVG kept (characters); a bigger result shows as an error. */
export const MAX_RENDER_CHARS = 2_000_000;
/** Longest wait for the renderer before a render counts as failed. */
export const RENDER_TIMEOUT_MS = 60_000;
/** A failed render is retried after this long (failures are never stored). */
export const RENDER_ERROR_TTL_MS = 60_000;
/** Most drawing characters (base64) one SVG export inlines; diagrams beyond it are placeholders. */
export const EXPORT_IMAGES_CHARS = 8_000_000;

/** @param {string} s FNV-1a, 32-bit, as 8 hex digits */
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * What a render depends on, as a short hash: two objects with the same hash draw the same image.
 * @param {{text?: string, syntax?: string, layout?: string, sketch?: boolean, theme?: string}} o
 */
export function diagramHash(o) {
  const key = [o.syntax ?? "d2", o.layout ?? "dagre", o.sketch ? 1 : 0, o.theme ?? "light", o.text ?? ""].join("\u0000");
  return fnv(key) + fnv(key.split("").toReversed().join("")) + key.length.toString(16);
}

/**
 * The request for the MermaiD2 connector's render() for a diagram object.
 * @param {{text?: string, syntax?: string, layout?: string, sketch?: boolean, theme?: string}} o
 */
export function renderRequest(o) {
  return {
    source: o.text ?? "", language: o.syntax === "mermaid" ? "mermaid" : "d2",
    layout: o.layout && /** @type {readonly string[]} */ (LAYOUTS).includes(o.layout) ? o.layout : "dagre",
    theme: RENDER_THEMES[o.theme === "dark" ? "dark" : "light"], sketch: !!o.sketch, format: "svg",
  };
}

/**
 * A cached render as stored and sent to clients.
 * @typedef {object} DiagramRender
 * @property {string} hash     diagramHash of the source it was made from
 * @property {"ok"|"error"|"unavailable"} status  unavailable: no renderer is connected
 * @property {string} [svg]    status ok: the SVG markup (shown only as an image)
 * @property {string} [error]  status error: one line for people
 * @property {number} [w] @property {number} [h]  the SVG's intrinsic size, when it states one
 */

/**
 * Base64 data: URL of an SVG, for an <image href>.
 * @param {string} svg
 */
export function svgDataUrl(svg) {
  const bytes = new TextEncoder().encode(svg);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "data:image/svg+xml;base64," + btoa(bin);
}

/**
 * The intrinsic size an SVG states (width/height attributes, else its viewBox), or null.
 * @param {string} svg
 * @returns {{w: number, h: number}|null}
 */
export function svgSize(svg) {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!open) return null;
  const num = (/** @type {string} */ name) => {
    const m = new RegExp(`\\s${name}="([0-9.]+)(px)?"`, "i").exec(open);
    return m ? Number(m[1]) : NaN;
  };
  let w = num("width"), h = num("height");
  if (!(w > 0 && h > 0)) {
    const vb = /viewBox="\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*"/i.exec(open);
    if (vb) { w = Number(vb[1]); h = Number(vb[2]); }
  }
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * Checks renderer output before it is stored: an SVG document, within MAX_RENDER_CHARS.
 * @param {unknown} data  Uint8Array or string
 * @returns {string|null} the SVG text, or null when unusable
 */
export function acceptSvg(data) {
  const text = typeof data === "string" ? data : data instanceof Uint8Array ? new TextDecoder().decode(data) : null;
  if (!text || text.length > MAX_RENDER_CHARS) return null;
  return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg\b/i.test(text) ? text : null;
}

/** One line for people from a renderer error. @param {unknown} e */
export function renderErrorMessage(e) {
  const msg = e instanceof Error ? e.message : String(e ?? "Render failed");
  return msg.replace(/\s+/g, " ").trim().slice(0, 300) || "Render failed";
}
