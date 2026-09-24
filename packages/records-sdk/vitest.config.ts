import { defineConfig } from "vitest/config";

// The SDK tests run against a real Node server (records-node) over an embedded Postgres, started
// per file from records-node's contract world; the Python tests run as a child process against it.
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    globalSetup: ["../records-schema/src/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
