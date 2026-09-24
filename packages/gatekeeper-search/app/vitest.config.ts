// The SPA's unit tests, separate from the package's workerd-pool config: the app needs jsdom's
// `document`, `DOMParser`, `history` and timers. `test:run` runs both configs in sequence.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  define: { __SEARCH_MOCK__: "true" },
  test: {
    root: import.meta.dirname,
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
