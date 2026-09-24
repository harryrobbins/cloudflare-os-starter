import { defineConfig } from "vitest/config";

// Node suites against one embedded Postgres cluster (records-schema's globalSetup). The Workers half
// of the contract run (vitest.workerd.config.ts) is started from __tests__/workerd.test.ts as a
// child process pointed at the same database, never directly by this config.
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    globalSetup: ["@records/schema/global-setup"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
