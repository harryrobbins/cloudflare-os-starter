// Tests run inside workerd via @cloudflare/vitest-pool-workers, on the same compatibility date and
// flags as wrangler.jsonc, like packages/gatekeeper-chat.
//
// No AI or VECTORS binding: Miniflare cannot run either locally. The dense half is the deterministic
// fake in __tests__/support/fake-dense.ts, installed by the test entry (__tests__/worker.ts) through
// `overrideDenseIndexFactory()`. The EMBED queue has a producer only; tests drive the consumer
// directly (`consumeEmbedBatch`, `embedChunks`) so they can hand it the fake.
//
// Assets come from a tiny fixture rather than app/dist, so the SPA-serving tests do not depend on
// the SPA having been built.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

const COMPATIBILITY_DATE = "2026-08-04";
const COMPATIBILITY_FLAGS = ["allow_irrevocable_stub_storage", "nodejs_compat"];

// Miniflare's equivalent of wrangler.jsonc's `assets.run_worker_first`.
const ASSET_ROUTER = { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } as const;

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: COMPATIBILITY_FLAGS,
        durableObjects: {
          SEARCH_INDEX: { className: "SearchIndex", useSQLite: true },
        },
        queueProducers: { EMBED: { queueName: "cfos-search-embed-test" } },
        bindings: {
          CF_ACCESS_ISS: "https://test.cloudflareaccess.example",
          CF_ACCESS_AUD: "test-aud",
          ADMINS: '["admin@example.test"]',
          PUBLIC_BASE_URL: "https://search.example.test",
          AI_GATEWAY: "",
          RERANK: "0",
        },
        assets: { directory: "./__tests__/fixtures/app-dist", binding: "ASSETS", routerConfig: ASSET_ROUTER },
      },
    }),
  ],
  // Only this package's own suites: not the capnweb-validate copy under .wrangler/validate/, and not
  // the SPA's (app/ has its own vitest config).
  test: {
    include: ["__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", ".wrangler/**", "app/**"],
  },
});
