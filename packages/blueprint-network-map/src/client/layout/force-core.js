// @ts-check
// The force layout (d3-force: Barnes-Hut many-body, links, gentle centring), shared by the layout
// worker and the in-thread fallback. Spike S5 (docs/plans/network-map-blueprint.md) chose d3-force
// over graphology's ForceAtlas2, whose Barnes-Hut mode measured ~176 ms per iteration at 1k nodes
// and ~16 s at 10k; d3-force measured ~7 ms and ~105 ms per tick.

import { forceLink, forceManyBody, forceSimulation, forceX, forceY } from "d3-force";

/**
 * @param {{x: Float64Array, y: Float64Array, pinned: Uint8Array, from: Uint32Array, to: Uint32Array}} input
 */
export function createForce({ x, y, pinned, from, to }) {
  const nodes = Array.from(x, (_, i) => /** @type {any} */ ({ index: i, x: x[i], y: y[i], ...(pinned[i] ? { fx: x[i], fy: y[i] } : {}) }));
  const links = Array.from(from, (_, i) => ({ source: from[i], target: to[i] }));
  const n = nodes.length;
  const sim = forceSimulation(nodes)
    .force("charge", forceManyBody().strength(-60).theta(0.9).distanceMax(2000))
    .force("link", forceLink(links).distance(60).strength(0.25))
    .force("x", forceX().strength(0.03))
    .force("y", forceY().strength(0.03))
    .alphaDecay(n > 5000 ? 0.04 : 0.025)
    .stop();
  return {
    /** Runs `ticks` ticks and writes positions back into x and y. @param {number} ticks */
    step(ticks) {
      for (let i = 0; i < ticks; i++) sim.tick();
      for (let i = 0; i < n; i++) { x[i] = nodes[i].x; y[i] = nodes[i].y; }
      return sim.alpha();
    },
    alphaMin: () => sim.alphaMin(),
  };
}
