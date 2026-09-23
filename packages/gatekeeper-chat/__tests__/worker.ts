// The Worker under test. The pool needs the Durable Object classes exported from `main`, so the
// spike object is re-exported here rather than smuggled into `src/`.
export { default } from "../src/index.js";
export * from "../src/index.js";
export { SpikeFts } from "./spikes/fts-do.js";
export { SpikeWsLocal } from "./spikes/ws-do.js";
// Named, not only covered by the `export *` above: the pool builds `ctx.exports` from the entry's
// statically visible exports and does not follow a star re-export, so without this line the agent
// outbox's `ctx.exports.ChatAgentReply(...)` is undefined under test.
export { ChatAgentReply } from "../src/index.js";
