// @ts-check
// The layout worker, bundled on its own and loaded from a data: URL (the gadget CSP allows data:
// scripts; the blob: URLs other layout libraries use are blocked). Protocol:
//   in:  {type: "start", x, y, pinned, from, to, maxTicks, batch}   out: {type: "tick", x, y, alpha, ticks} ... {type: "done"}
//   in:  {type: "stop"}

import { createForce } from "./force-core.js";

/** @type {any} */
let running = null;

self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "stop") { running = null; return; }
  if (msg.type !== "start") return;
  const force = createForce(msg);
  const token = {};
  running = token;
  let ticks = 0;
  const loop = () => {
    if (running !== token) return;
    const alpha = force.step(msg.batch);
    ticks += msg.batch;
    const done = alpha < force.alphaMin() || ticks >= msg.maxTicks;
    self.postMessage({ type: "tick", x: msg.x, y: msg.y, alpha, ticks, done });
    if (done) { running = null; return; }
    setTimeout(loop, 0);
  };
  loop();
};
