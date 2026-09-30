// Pure-JS tests (music, engine, cartridges, rules, store) in plain Node. Server tests: vitest.workers.config.ts.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/core/**/*.test.js", "test/engine/**/*.test.js"],
  },
});
