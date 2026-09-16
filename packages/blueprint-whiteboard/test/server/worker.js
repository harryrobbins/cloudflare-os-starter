// Test entry for @cloudflare/vitest-pool-workers: exposes the gadget classes as the `main` worker.
export { Gadget, ExportHandler } from "../../src/server/index.js";

export default {
  async fetch() {
    return new Response("blueprint-whiteboard test worker");
  },
};
