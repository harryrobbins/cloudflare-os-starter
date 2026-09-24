// @ts-check
// Styles for the canvas. The shell injects CANVAS_CSS once (e.g. into a <style> element).
// Custom properties the shell may set on an ancestor: --wb-accent, --wb-canvas-bg, --wb-grid.

export const CANVAS_CSS = `
.wb-canvas {
  position: relative; overflow: hidden; width: 100%; height: 100%; min-height: 0;
  touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent; outline: none; cursor: default;
  background: var(--wb-canvas-bg, #f7f7f4);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.wb-canvas:focus-visible { outline: 2px solid var(--wb-accent, #2563eb); outline-offset: -2px; box-shadow: none; }
.wb-canvas > svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; overflow: hidden; }
.wb-canvas > svg.wb-presence-svg { pointer-events: none; }
.wb-canvas .wb-bg-dot { fill: var(--wb-grid, #c4c8cf); }
.wb-canvas .wb-bg-line { fill: none; stroke: var(--wb-grid-line, #e3e6ea); stroke-width: 1; }
.wb-canvas[data-tool="hand"], .wb-canvas.wb-space { cursor: grab; }
.wb-canvas.wb-grabbing { cursor: grabbing; }
.wb-canvas[data-tool="sticky"], .wb-canvas[data-tool="rect"], .wb-canvas[data-tool="ellipse"],
.wb-canvas[data-tool="frame"], .wb-canvas[data-tool="connector"], .wb-canvas[data-tool="pen"] { cursor: crosshair; }
.wb-canvas[data-tool="text"] { cursor: text; }
.wb-canvas .wb-obj.wb-editing text { visibility: hidden; }
.wb-canvas .wb-obj.wb-editing text.wb-code-head { visibility: visible; }
.wb-canvas .wb-editor.wb-editor-code { box-shadow: 0 0 0 1px var(--wb-accent, #2563eb); caret-color: currentColor; }
.wb-canvas .wb-obj.wb-flash { animation: wb-flash 1.2s ease-out; }
@keyframes wb-flash {
  0%, 35% { filter: drop-shadow(0 0 4px #f59e0b) drop-shadow(0 0 8px #f59e0b); }
  100% { filter: none; }
}
.wb-canvas .wb-sel-outline, .wb-canvas .wb-hover-outline {
  fill: none; stroke: var(--wb-accent, #2563eb); stroke-width: 1.5; vector-effect: non-scaling-stroke; pointer-events: none;
}
.wb-canvas .wb-hover-outline { stroke-width: 2.5; stroke-dasharray: 6 4; }
.wb-canvas .wb-preview-shape {
  fill: rgba(37, 99, 235, 0.06); stroke: var(--wb-accent, #2563eb); stroke-width: 1.5;
  stroke-dasharray: 6 4; vector-effect: non-scaling-stroke;
}
.wb-canvas .wb-preview-line {
  fill: none; stroke: var(--wb-accent, #2563eb); stroke-width: 2; stroke-dasharray: 6 4; vector-effect: non-scaling-stroke;
}
.wb-canvas .wb-preview-stroke { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.wb-canvas .wb-handle { fill: #ffffff; stroke: var(--wb-accent, #2563eb); stroke-width: 1.5; }
.wb-canvas .wb-rotate-stem { stroke: var(--wb-accent, #2563eb); stroke-width: 1; }
.wb-canvas .wb-group-box { fill: none; stroke: var(--wb-accent, #2563eb); stroke-width: 1; stroke-dasharray: 5 4; }
.wb-canvas .wb-guide { stroke: #db2777; stroke-width: 1; shape-rendering: crispEdges; pointer-events: none; }
.wb-canvas .wb-endpoint-handle { fill: var(--wb-accent, #2563eb); stroke: #ffffff; stroke-width: 2; }
.wb-canvas .wb-marquee { fill: rgba(37, 99, 235, 0.08); stroke: var(--wb-accent, #2563eb); stroke-width: 1; }
.wb-canvas .wb-ghost { opacity: 0.45; }
.wb-canvas .wb-peer-outline { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }
.wb-canvas .wb-peer-stroke { fill: none; stroke-linecap: round; stroke-linejoin: round; opacity: 0.7; }
.wb-canvas .wb-cursor text, .wb-canvas .wb-badge text { font-weight: 600; font-family: inherit; }
.wb-canvas .wb-editor {
  position: absolute; left: 0; top: 0; transform-origin: 0 0; box-sizing: content-box; z-index: 2;
  margin: 0; padding: 0; border: 0; border-radius: 0; outline: none; resize: none; overflow: hidden;
  background: transparent; overflow-wrap: break-word; caret-color: currentColor; user-select: text; -webkit-user-select: text;
  min-height: 0; max-width: none; appearance: none;
}
.wb-canvas .wb-editor-label { background: #ffffff; border-radius: 4px; box-shadow: 0 0 0 1px var(--wb-accent, #2563eb); }
.wb-canvas .wb-editor-frame { background: rgba(255, 255, 255, 0.9); box-shadow: 0 0 0 1px var(--wb-accent, #2563eb); }
.wb-canvas .wb-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.wb-canvas.wb-export { cursor: default; background: #ffffff; }
@media (prefers-reduced-motion: reduce) {
  .wb-canvas .wb-obj.wb-flash { animation-duration: 0.01s; }
}
`;
