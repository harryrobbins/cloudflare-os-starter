// The SPA's unit tests. Separate from the package's `vitest.config.ts`, which runs everything inside
// workerd through @cloudflare/vitest-pool-workers: the store is plain TypeScript and needs jsdom's
// `localStorage`, `document` and timers, which the workers pool does not provide. `test:run` runs
// both configs in sequence.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  define: { __CHAT_MOCK__: "true", __DEV_BUILD__: "true" },
  test: {
    root: import.meta.dirname,
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
