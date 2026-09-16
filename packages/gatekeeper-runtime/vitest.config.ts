import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-08",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
        durableObjects: { ACCOUNTS: { className: "RuntimeAccountState", useSQLite: true }, SESSIONS: { className: "FakeRunner", useSQLite: true }, TEST: { className: "TestHarness", useSQLite: true } },
      },
    }),
  ],
  test: { include: ["__tests__/*.test.ts"] },
});
