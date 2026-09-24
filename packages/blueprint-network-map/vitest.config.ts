import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["test/shared/**/*.test.js", "test/core/**/*.test.js", "test/client/**/*.test.js"], passWithNoTests: true } });
