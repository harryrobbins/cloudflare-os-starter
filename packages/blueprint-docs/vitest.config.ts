// Plain Node tests (build and archive). Server tests: vitest.workers.config.ts. Browser: e2e/.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/node/**/*.test.js"],
    passWithNoTests: true,
  },
});
