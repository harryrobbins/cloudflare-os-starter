import { defineConfig } from "vitest/config";

// The clock spike (bench/clock.bench.ts). Not part of `vitest run`: it starts its own durable
// embedded Postgres and takes about a minute.
export default defineConfig({
  test: {
    include: ["bench/*.bench.ts"],
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 120_000,
    silent: false,
  },
});
