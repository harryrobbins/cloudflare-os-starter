import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The host logic runs under Node; `cloudflare:workers` resolves to a minimal stand-in.
export default defineConfig({
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./__tests__/workers-stub.ts", import.meta.url)) } },
  test: { include: ["__tests__/**/*.test.ts"] },
});
