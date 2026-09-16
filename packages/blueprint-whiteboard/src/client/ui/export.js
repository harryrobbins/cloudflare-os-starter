// @ts-check
// Static whiteboard for the platform's HTML/PDF export: only the board, fitted to the page, no
// chrome, no presence. It draws the same SVG the server's exportSvg() returns (src/shared/render.js),
// so the HTML/PDF capture and the SVG export always agree, and nothing depends on layout timing.

import { boardToSvg, SVG_NS } from "../../shared/render.js";
import { DEFAULT_TITLE } from "../../shared/protocol.js";

/** @typedef {import("../../shared/protocol.js").BoardSnapshot} BoardSnapshot */

const EXPORT_CSS = `
html, body { margin: 0; height: auto; background: #ffffff; color-scheme: light; }
body.export-mode { overflow: auto; font: 14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; }
.wb-export { padding: 16px; }
.wb-export h1 { margin: 0 0 12px; font-size: 20px; }
.wb-export-board { display: block; width: 100%; height: auto; max-height: calc(100vh - 80px); }
.wb-export-empty { color: #555; }
@media print {
  .wb-export { padding: 0; }
  .wb-export-board { max-height: none; page-break-inside: avoid; }
}
`;

/**
 * @param {HTMLElement} root
 * @param {BoardSnapshot} board
 */
export async function renderExport(root, board) {
  const style = document.createElement("style");
  style.textContent = EXPORT_CSS;
  document.head.appendChild(style);
  document.body.classList.add("export-mode");
  const title = board?.title || DEFAULT_TITLE;
  document.title = title;

  const main = document.createElement("main");
  main.className = "wb-export";
  const heading = document.createElement("h1");
  heading.textContent = title;
  main.appendChild(heading);

  const objects = board?.objects ?? {};
  if (!Object.keys(objects).length) {
    const p = document.createElement("p");
    p.className = "wb-export-empty";
    p.textContent = "This whiteboard is empty.";
    main.appendChild(p);
  } else {
    const svgText = boardToSvg(board);
    const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
    const svg = /** @type {SVGSVGElement} */ (document.importNode(parsed.documentElement, true));
    if (svg.namespaceURI === SVG_NS && svg.localName === "svg") {
      svg.classList.add("wb-export-board");
      svg.setAttribute("preserveAspectRatio", "xMidYMin meet");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", title);
      // The viewBox scales it; drop the fixed size so it fits the page width.
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      main.appendChild(svg);
    }
  }
  root.replaceChildren(main);
  // Let the browser lay it out once before the capture.
  // (rAF does not run in a hidden page, so a timeout bounds the wait.)
  await new Promise((resolve) => { requestAnimationFrame(() => resolve(undefined)); setTimeout(resolve, 50); });
}
