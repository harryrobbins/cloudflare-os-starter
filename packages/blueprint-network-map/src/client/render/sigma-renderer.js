// @ts-check
// The map renderer: sigma v3 (WebGL) over a graphology multigraph. It implements the plan's
// Renderer interface (docs/plans/network-map-blueprint.md §4.1) so another engine can replace it
// locally. It knows nothing about the store: the app hands it render records (sync) and it reports
// pointer gestures through callbacks.
//
// Shapes: circle (NodeCircleProgram, or NodeBorderProgram with a border), square
// (@sigma/node-square), diamond/triangle/hexagon (@sigma/node-image pictograms, tinted with the
// node colour; the images are data: SVGs, allowed by the gadget CSP's img-src data:).
// Edges: straight line/arrow/double arrow; parallel edges and "curved" ones use @sigma/edge-curve,
// fanned out with indexParallelEdgesIndex. Self-links are not drawn on the canvas (sigma has no
// self-loop program); list mode and the profile panel show them.

import Graph from "graphology";
import Sigma from "sigma";
import { EdgeArrowProgram, EdgeRectangleProgram, NodeCircleProgram } from "sigma/rendering";
import { EdgeDoubleArrowProgram } from "sigma/rendering";
import EdgeCurveProgram, { EdgeCurvedArrowProgram, EdgeCurvedDoubleArrowProgram, indexParallelEdgesIndex, DEFAULT_EDGE_CURVATURE } from "@sigma/edge-curve";
import { NodeSquareProgram } from "@sigma/node-square";
import { createNodeImageProgram } from "@sigma/node-image";
import { createNodeBorderProgram } from "@sigma/node-border";

const SHAPE_PATHS = /** @type {Record<string, string>} */ ({
  diamond: "M50 2 L98 50 L50 98 L2 50 Z",
  triangle: "M50 6 L96 92 L4 92 Z",
  hexagon: "M27 5 L73 5 L96 50 L73 95 L27 95 L4 50 Z",
});
/** @param {string} shape */
const shapeImage = (shape) => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="${SHAPE_PATHS[shape]}" fill="#000"/></svg>`);
export const SHAPE_IMAGES = Object.fromEntries(Object.keys(SHAPE_PATHS).map((s) => [s, shapeImage(s)]));

/** @param {string} hex @param {number} alpha */
export function withAlpha(hex, alpha) {
  if (alpha >= 1) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, alpha)).toFixed(2)})`;
}

/**
 * @typedef {object} NodeRecord
 * @property {string} label
 * @property {number} x
 * @property {number} y
 * @property {string} color
 * @property {number} size
 * @property {string} shape
 * @property {number} opacity
 * @property {string|null} border
 * @property {boolean} [labelShown]
 */
/**
 * @typedef {object} EdgeRecord
 * @property {string} from
 * @property {string} to
 * @property {string} color
 * @property {number} width
 * @property {"none"|"forward"|"both"} arrow
 * @property {boolean} curved
 * @property {number} opacity
 * @property {string|null} label
 */

/**
 * @param {HTMLElement} container
 * @param {{onClickNode?: (id: string, e: any) => void, onClickEdge?: (id: string, e: any) => void,
 *   onClickStage?: (e: any) => void, onDoubleClickStage?: (pos: {x: number, y: number}) => void,
 *   onDoubleClickNode?: (id: string) => void, onHover?: (id: string|null) => void,
 *   onDragStart?: (id: string) => boolean, onDrag?: (id: string, pos: {x: number, y: number}) => void,
 *   onDragEnd?: (id: string, pos: {x: number, y: number}) => void, onCamera?: () => void,
 *   onPointer?: (pos: {x: number, y: number}|null) => void,
 *   onConnectEnd?: (fromId: string, toId: string|null, pos: {x: number, y: number}) => void}} handlers
 */
export function createRenderer(container, handlers = {}) {
  const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
  const dark = () => !!scheme?.matches;
  const graph = new Graph({ multi: true, type: "mixed", allowSelfLoops: true });
  const imageProgram = createNodeImageProgram({ drawingMode: "color", keepWithinCircle: false, padding: 0, crossOrigin: null });
  const borderProgram = createNodeBorderProgram({
    borders: [{ size: { value: 0.18 }, color: { attribute: "borderColor" } }, { size: { fill: true }, color: { attribute: "color" } }],
  });
  /** @type {Set<string>} */
  let selected = new Set();
  /** @type {string|null} */
  let hovered = null;
  /** @type {Set<string>} ids highlighted by peers' selections */
  let peerSelected = new Set();
  /** @type {{from: string, x: number, y: number}|null} a connection being drawn */
  let connecting = null;

  const renderer = new Sigma(graph, container, {
    allowInvalidContainer: true,
    renderEdgeLabels: true,
    enableEdgeEvents: true,
    labelRenderedSizeThreshold: 4,
    labelDensity: 0.7,
    labelColor: { color: dark() ? "#e8ebf1" : "#1a1f2b" },
    edgeLabelColor: { color: dark() ? "#b3bac7" : "#4b5363" },
    labelFont: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    edgeLabelFont: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    edgeLabelSize: 11,
    zIndex: true,
    defaultNodeType: "circle",
    defaultEdgeType: "line",
    nodeProgramClasses: {
      circle: NodeCircleProgram, bordered: borderProgram, square: NodeSquareProgram,
      diamond: imageProgram, triangle: imageProgram, hexagon: imageProgram,
    },
    edgeProgramClasses: {
      line: EdgeRectangleProgram, arrow: EdgeArrowProgram, double: EdgeDoubleArrowProgram,
      curve: EdgeCurveProgram, curveArrow: EdgeCurvedArrowProgram, curveDouble: EdgeCurvedDoubleArrowProgram,
    },
    nodeReducer: (node, data) => {
      const res = { ...data };
      if (selected.has(node)) { res.highlighted = true; res.zIndex = 2; }
      else if (peerSelected.has(node)) res.zIndex = 1;
      if (node === hovered) res.zIndex = 3;
      if (!data.labelShown) res.label = selected.has(node) || node === hovered ? data.fullLabel : null;
      return res;
    },
    edgeReducer: (edge, data) => {
      const res = { ...data };
      if (selected.has(edge)) { res.color = "#2563eb"; res.size = Math.max(2, data.size + 1.5); res.zIndex = 2; }
      else if (selected.size && (selected.has(graph.source(edge)) || selected.has(graph.target(edge)))) res.zIndex = 1;
      return res;
    },
  });

  // Labels follow the colour scheme (the canvas background does, through CSS).
  scheme?.addEventListener?.("change", () => {
    renderer.setSetting("labelColor", { color: dark() ? "#e8ebf1" : "#1a1f2b" });
    renderer.setSetting("edgeLabelColor", { color: dark() ? "#b3bac7" : "#4b5363" });
  });

  // --- Records -> graph ---------------------------------------------------------------------

  /** The records last drawn, to skip unchanged items (each graph update costs a sigma event). */
  /** @type {Map<string, NodeRecord>} */
  let drawnNodes = new Map();
  /** @type {Map<string, EdgeRecord>} */
  let drawnEdges = new Map();

  /** @param {NodeRecord} a @param {NodeRecord} b */
  const sameNode = (a, b) => a.label === b.label && a.x === b.x && a.y === b.y && a.color === b.color && a.size === b.size &&
    a.shape === b.shape && a.opacity === b.opacity && a.border === b.border && a.labelShown === b.labelShown;
  /** @param {EdgeRecord} a @param {EdgeRecord} b */
  const sameEdge = (a, b) => a.color === b.color && a.width === b.width && a.arrow === b.arrow && a.curved === b.curved &&
    a.opacity === b.opacity && a.label === b.label;

  /**
   * Replaces the drawn graph with `nodes` and `edges`, touching only what changed. The parallel-edge
   * index is rebuilt only when the set of edges or their endpoints changed.
   * @param {Map<string, NodeRecord>} nodes @param {Map<string, EdgeRecord>} edges
   */
  function sync(nodes, edges) {
    for (const id of drawnNodes.keys()) if (!nodes.has(id) && graph.hasNode(id)) graph.dropNode(id);
    for (const [id, n] of nodes) {
      const old = drawnNodes.get(id);
      if (old && sameNode(old, n) && graph.hasNode(id)) continue;
      const type = n.shape === "circle" ? (n.border ? "bordered" : "circle") : n.shape;
      const attrs = {
        x: n.x, y: n.y, size: n.size, color: withAlpha(n.color, n.opacity), type,
        label: n.labelShown ? n.label : null, fullLabel: n.label, labelShown: n.labelShown !== false,
        borderColor: n.border ?? "#000000", image: SHAPE_IMAGES[n.shape] ?? undefined,
      };
      if (graph.hasNode(id)) graph.mergeNodeAttributes(id, attrs);
      else graph.addNode(id, attrs);
    }
    let topology = false;
    for (const [id, e] of drawnEdges) {
      const next = edges.get(id);
      if (!next || next.from !== e.from || next.to !== e.to || !graph.hasNode(e.from) || !graph.hasNode(e.to)) {
        if (graph.hasEdge(id)) graph.dropEdge(id);
        topology = true;
      }
    }
    /** @type {string[]} */
    const restyled = [];
    for (const [id, e] of edges) {
      if (!graph.hasNode(e.from) || !graph.hasNode(e.to)) continue;
      const attrs = { color: withAlpha(e.color, e.opacity), size: e.width, label: e.label ?? undefined, arrow: e.arrow, curvedWanted: e.curved };
      if (!graph.hasEdge(id)) { graph.addDirectedEdgeWithKey(id, e.from, e.to, attrs); topology = true; continue; }
      const old = drawnEdges.get(id);
      if (old && sameEdge(old, e)) continue;
      graph.mergeEdgeAttributes(id, attrs);
      restyled.push(id);
    }
    drawnNodes = nodes;
    drawnEdges = edges;
    if (topology) {
      indexParallelEdgesIndex(graph, { edgeIndexAttribute: "parallelIndex", edgeMinIndexAttribute: "parallelMinIndex", edgeMaxIndexAttribute: "parallelMaxIndex" });
      graph.forEachEdge((edge, attr) => assignEdgeType(edge, attr));
    } else for (const id of restyled) assignEdgeType(id, graph.getEdgeAttributes(id));
  }

  /**
   * Parallel edges fan out as curves; others follow their record.
   * @param {string} edge @param {any} attr
   */
  function assignEdgeType(edge, attr) {
    const parallel = typeof attr.parallelIndex === "number" && (attr.parallelMaxIndex ?? 0) > (attr.parallelMinIndex ?? 0);
    const curved = parallel || attr.curvedWanted;
    const kind = attr.arrow === "forward" ? "Arrow" : attr.arrow === "both" ? "Double" : "";
    const type = curved ? (kind ? `curve${kind}` : "curve") : kind ? kind.toLowerCase() : "line";
    /** @type {Record<string, unknown>} */
    const next = { type };
    if (curved) {
      const i = attr.parallelIndex ?? 0, min = attr.parallelMinIndex ?? 0, max = attr.parallelMaxIndex ?? 0;
      next.curvature = parallel ? DEFAULT_EDGE_CURVATURE + (3 * DEFAULT_EDGE_CURVATURE * (i - min)) / Math.max(1, max - min) : DEFAULT_EDGE_CURVATURE;
    }
    if (attr.type !== next.type || attr.curvature !== next.curvature) graph.mergeEdgeAttributes(edge, next);
  }

  /**
   * Moves nodes without re-syncing everything (layout animation, drags).
   * @param {Iterable<[string, {x: number, y: number}]>} entries
   */
  function setPositions(entries) {
    for (const [id, p] of entries) if (graph.hasNode(id)) graph.mergeNodeAttributes(id, { x: p.x, y: p.y });
  }

  // --- Interaction --------------------------------------------------------------------------

  /** @type {string|null} */
  let dragging = null;
  let dragMoved = false;

  renderer.on("clickNode", ({ node, event }) => {
    if (dragMoved) return;
    handlers.onClickNode?.(node, event);
  });
  renderer.on("clickEdge", ({ edge, event }) => handlers.onClickEdge?.(edge, event));
  renderer.on("clickStage", ({ event }) => handlers.onClickStage?.(event));
  renderer.on("doubleClickStage", ({ event }) => {
    event.preventSigmaDefault();
    handlers.onDoubleClickStage?.(renderer.viewportToGraph({ x: event.x, y: event.y }));
  });
  renderer.on("doubleClickNode", ({ node, event }) => {
    event.preventSigmaDefault();
    handlers.onDoubleClickNode?.(node);
  });
  renderer.on("enterNode", ({ node }) => { const was = hovered; hovered = node; container.style.cursor = "pointer"; handlers.onHover?.(node); repaint(new Set([node, ...(was ? [was] : [])])); });
  renderer.on("leaveNode", () => { const was = hovered; hovered = null; container.style.cursor = ""; handlers.onHover?.(null); if (was) repaint(new Set([was])); });

  /**
   * Re-applies the reducers to some nodes and edges (theirs, and edges between them) at the next
   * frame, instead of a full synchronous refresh: a selection change at 10k/30k touches a handful.
   * Ids that are edges are repainted as edges.
   * @param {Set<string>} ids
   */
  function repaint(ids) {
    const nodes = [], edges = new Set();
    for (const id of ids) {
      if (graph.hasNode(id)) {
        nodes.push(id);
        if (graph.degree(id) <= 500) for (const e of graph.edges(id)) edges.add(e);
      } else if (graph.hasEdge(id)) edges.add(id);
    }
    try {
      renderer.scheduleRefresh({ partialGraph: { nodes, edges: [...edges] }, skipIndexation: true });
    } catch {
      // Something in the set is not indexed yet (added this frame): a full refresh indexes it.
      renderer.scheduleRefresh();
    }
  }
  renderer.on("downNode", ({ node, event }) => {
    if (event.original instanceof MouseEvent && event.original.shiftKey) {
      // Shift-drag from a node draws a new connection.
      const p = renderer.viewportToGraph({ x: event.x, y: event.y });
      connecting = { from: node, x: p.x, y: p.y };
      renderer.getCamera().disable();
      return;
    }
    if (handlers.onDragStart && !handlers.onDragStart(node)) return;
    dragging = node;
    dragMoved = false;
    renderer.getCamera().disable();
  });
  renderer.getMouseCaptor().on("mousemovebody", (event) => {
    const p = renderer.viewportToGraph({ x: event.x, y: event.y });
    handlers.onPointer?.(p);
    if (connecting) {
      connecting.x = p.x; connecting.y = p.y;
      drawConnecting();
      event.preventSigmaDefault();
      return;
    }
    if (!dragging) return;
    dragMoved = true;
    graph.mergeNodeAttributes(dragging, { x: p.x, y: p.y });
    handlers.onDrag?.(dragging, p);
    event.preventSigmaDefault();
    event.original.preventDefault();
    event.original.stopPropagation();
  });
  const endGesture = (/** @type {any} */ event) => {
    if (connecting) {
      const from = connecting.from;
      const p = event ? renderer.viewportToGraph({ x: event.x, y: event.y }) : { x: connecting.x, y: connecting.y };
      connecting = null;
      clearConnecting();
      renderer.getCamera().enable();
      const target = hovered && hovered !== from ? hovered : null;
      handlers.onConnectEnd?.(from, target, p);
      return;
    }
    if (!dragging) return;
    const id = dragging;
    dragging = null;
    renderer.getCamera().enable();
    if (dragMoved) {
      const a = graph.getNodeAttributes(id);
      handlers.onDragEnd?.(id, { x: a.x, y: a.y });
      // Swallow the click that follows a drag.
      setTimeout(() => { dragMoved = false; }, 0);
    }
  };
  renderer.getMouseCaptor().on("mouseup", endGesture);
  renderer.getMouseCaptor().on("mouseleave", () => { handlers.onPointer?.(null); });
  renderer.getCamera().on("updated", () => handlers.onCamera?.());

  // A dashed line while drawing a connection, on an overlay canvas.
  const overlay = document.createElement("canvas");
  overlay.className = "nm-connect-overlay";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.cssText = "position:absolute;inset:0;pointer-events:none;width:100%;height:100%";
  container.appendChild(overlay);
  function drawConnecting() {
    if (!connecting) return;
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    overlay.width = rect.width * dpr; overlay.height = rect.height * dpr;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    const a = graph.getNodeAttributes(connecting.from);
    const va = renderer.graphToViewport({ x: a.x, y: a.y });
    const vb = renderer.graphToViewport({ x: connecting.x, y: connecting.y });
    ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(va.x, va.y); ctx.lineTo(vb.x, vb.y); ctx.stroke();
  }
  function clearConnecting() {
    overlay.getContext("2d")?.clearRect(0, 0, overlay.width, overlay.height);
  }

  // --- Public -------------------------------------------------------------------------------

  return {
    graph,
    sigma: renderer,
    sync,
    setPositions,
    refresh: () => renderer.refresh(),
    /** @param {Iterable<string>} ids */
    setSelection(ids) {
      const next = new Set(ids);
      /** @type {Set<string>} */
      const changed = new Set();
      for (const id of selected) if (!next.has(id)) changed.add(id);
      for (const id of next) if (!selected.has(id)) changed.add(id);
      selected = next;
      if (changed.size) repaint(changed);
    },
    /** @param {Iterable<string>} ids */
    setPeerSelection(ids) { peerSelected = new Set(ids); },
    getCamera: () => renderer.getCamera().getState(),
    /** @param {{x: number, y: number, ratio: number}} state @param {boolean} [animate] */
    setCamera(state, animate = false) {
      const cam = renderer.getCamera();
      if (animate) cam.animate(state, { duration: 300 });
      else cam.setState(state);
    },
    /** Frames every visible node. */
    fit: () => renderer.getCamera().animatedReset({ duration: 300 }),
    zoomIn: () => renderer.getCamera().animatedZoom({ duration: 200 }),
    zoomOut: () => renderer.getCamera().animatedUnzoom({ duration: 200 }),
    /** Centres on a node. @param {string} id */
    focusNode(id) {
      if (!graph.hasNode(id)) return;
      const d = renderer.getNodeDisplayData(id);
      if (d) renderer.getCamera().animate({ x: d.x, y: d.y }, { duration: 300 });
    },
    /** @param {{x: number, y: number}} p viewport px -> graph coords */
    viewportToGraph: (p) => renderer.viewportToGraph(p),
    /** @param {{x: number, y: number}} p graph coords -> viewport px */
    graphToViewport: (p) => renderer.graphToViewport(p),
    /** The node nearest a viewport point within `radius` px, or null. @param {{x: number, y: number}} p */
    nodeAt(p, radius = 12) {
      let best = null, bestD = radius;
      graph.forEachNode((id) => {
        const d = renderer.getNodeDisplayData(id);
        if (!d || d.hidden) return;
        const v = renderer.framedGraphToViewport({ x: d.x, y: d.y });
        const dist = Math.hypot(v.x - p.x, v.y - p.y);
        if (dist < bestD) { bestD = dist; best = id; }
      });
      return best;
    },
    /**
     * A PNG data URL of the current canvas (edges, nodes and labels composited).
     * @param {string} background
     */
    exportPng(background = "#ffffff") {
      renderer.refresh();
      const canvases = renderer.getCanvases();
      const { width, height } = renderer.getDimensions();
      const dpr = window.devicePixelRatio || 1;
      const out = document.createElement("canvas");
      out.width = width * dpr; out.height = height * dpr;
      const ctx = out.getContext("2d");
      if (!ctx) return null;
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, out.width, out.height);
      for (const key of ["edges", "edgeLabels", "nodes", "labels", "hovers", "hoverNodes"]) {
        const c = canvases[key];
        if (c) ctx.drawImage(c, 0, 0, out.width, out.height);
      }
      return out.toDataURL("image/png");
    },
    destroy() {
      renderer.kill();
      overlay.remove();
    },
  };
}
