// Pure-JS tests (core model, client, tools) in plain Node. Server tests: vitest.workers.config.ts.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/core/**/*.test.js", "test/client/**/*.test.js", "test/tools/**/*.test.js"],
    passWithNoTests: true,
  },
});
