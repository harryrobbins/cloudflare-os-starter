// Spike S5: a force layout (d3-force, Barnes-Hut many-body) in a data: module worker. The
// graphology FA2 worker helper builds a blob: URL, which the gadget CSP blocks.
import { forceSimulation, forceManyBody, forceLink, forceX, forceY } from "d3-force";

self.onmessage = (event) => {
  const { x, y, from, to, ticks } = event.data;
  const nodes = Array.from(x, (_, i) => ({ index: i, x: x[i], y: y[i] }));
  const links = Array.from(from, (_, i) => ({ source: from[i], target: to[i] }));
  const t0 = performance.now();
  const sim = forceSimulation(nodes).force("charge", forceManyBody().theta(0.9)).force("link", forceLink(links).distance(30).strength(0.1))
    .force("x", forceX().strength(0.02)).force("y", forceY().strength(0.02)).stop();
  for (let i = 0; i < ticks; i++) sim.tick();
  for (let i = 0; i < nodes.length; i++) { x[i] = nodes[i].x; y[i] = nodes[i].y; }
  self.postMessage({ x, y, ms: performance.now() - t0 }, [x.buffer, y.buffer]);
};
