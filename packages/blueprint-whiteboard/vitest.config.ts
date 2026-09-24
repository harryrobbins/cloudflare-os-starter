// Pure-JS tests (shared contract, core rules, client, tools, performance proxies) in plain Node. Server tests: vitest.workers.config.ts.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/shared/**/*.test.js", "test/core/**/*.test.js", "test/client/**/*.test.js", "test/tools/**/*.test.js", "test/performance/**/*.test.js"],
    passWithNoTests: true,
  },
});
