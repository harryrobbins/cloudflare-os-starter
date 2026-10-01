// Pure-JS tests (count, rules, store, the Gadget class and its describeGadget()) in plain Node.
// Server tests in workerd: vitest.workers.config.ts.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "cloudflare:workers": fileURLToPath(new URL("./test/support/cloudflare-workers.js", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["test/core/**/*.test.js", "test/gadget/**/*.test.js"],
  },
});
