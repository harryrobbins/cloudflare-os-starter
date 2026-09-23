// The Data management SPA's component tests (jsdom). Separate from the package's vitest.config.ts,
// which runs the domain suites in Node against embedded Postgres.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    root: import.meta.dirname,
    environment: "jsdom",
    include: ["__tests__/**/*.test.tsx", "__tests__/**/*.test.ts"],
    setupFiles: ["__tests__/setup.ts"],
  },
});
