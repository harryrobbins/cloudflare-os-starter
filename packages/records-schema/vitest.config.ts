import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    globalSetup: ["./src/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
