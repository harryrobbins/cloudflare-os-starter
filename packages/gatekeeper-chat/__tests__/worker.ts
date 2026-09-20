// The Worker under test. The pool needs the Durable Object classes exported from `main`, so the
// spike object is re-exported here rather than smuggled into `src/`.
export { default } from "../src/index.js";
export * from "../src/index.js";
export { SpikeFts } from "./spikes/fts-do.js";
export { SpikeWsLocal } from "./spikes/ws-do.js";
