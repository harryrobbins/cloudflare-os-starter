// Pure-JS tests (shared contract, core rules, client, tools, performance proxies) in plain Node. Server tests: vitest.workers.config.ts.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Node tests that construct the real Gadget (describeGadget, evals) get a stand-in module.
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./test/fixtures/cloudflare-workers.js", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["test/shared/**/*.test.js", "test/core/**/*.test.js", "test/client/**/*.test.js", "test/tools/**/*.test.js", "test/performance/**/*.test.js"],
    passWithNoTests: true,
  },
});
