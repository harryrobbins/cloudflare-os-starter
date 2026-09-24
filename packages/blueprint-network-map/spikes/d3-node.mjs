import { forceSimulation, forceManyBody, forceLink, forceX, forceY } from "d3-force";
const [N, M] = [Number(process.argv[2]), Number(process.argv[3])];
const nodes = Array.from({ length: N }, (_, i) => ({ index: i, x: Math.random() * 1000, y: Math.random() * 1000 }));
const links = Array.from({ length: M }, () => ({ source: Math.floor(Math.random() * N), target: Math.floor(Math.pow(Math.random(), 2) * N) }));
const sim = forceSimulation(nodes).force("charge", forceManyBody().theta(0.9)).force("link", forceLink(links).distance(30).strength(0.1)).force("x", forceX().strength(0.02)).force("y", forceY().strength(0.02)).stop();
for (let i = 0; i < 10; i++) sim.tick();
const t = performance.now();
for (let i = 0; i < 20; i++) sim.tick();
console.log(N, M, "d3 ms/tick", ((performance.now() - t) / 20).toFixed(1));
