// Server tests: run inside workerd via @cloudflare/vitest-pool-workers, matching the production
// gadget facet (compat date 2026-02-01, allow_irrevocable_stub_storage, no nodejs_compat).
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/server/worker.js",
      wrangler: { configPath: "./test/server/wrangler.jsonc" },
      miniflare: {
        compatibilityDate: "2026-02-01",
        compatibilityFlags: ["allow_irrevocable_stub_storage"],
      },
    }),
  ],
  test: { include: ["test/server/**/*.test.js"] },
});
