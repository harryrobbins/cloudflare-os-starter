import { defineConfig } from "vitest/config";

// Domain, database and HTTP adapter tests run in Node against a real embedded Postgres; the
// Workers-runtime tests (Gatekeeper facets, notification DO) live in vitest.worker.config.ts.
export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    exclude: ["__tests__/*.worker.test.ts"],
    environment: "node",
    globalSetup: ["../records-schema/src/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
