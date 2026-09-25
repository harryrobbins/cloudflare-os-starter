// Node tests for the pure modules (server proxy, change feed, write tracker, model); the UI tests
// opt into jsdom per file with `// @vitest-environment jsdom`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.js"] },
});
