// The Workers half of the contract run (canonical plan §11.8): the contract suite inside workerd,
// against the Worker's own adapters (gatekeeper-records http/api.ts, jira/handler.ts, http/openapi.ts)
// reaching Postgres through Miniflare's local Hyperdrive.
//
// Not run on its own: __tests__/workerd.test.ts creates the world, starts the Node server over the
// same database, and runs this config as a child process with RECORDS_CONTRACT_WORKERD describing
// that database, the test Access issuer and the credentials. Both runtimes therefore serve one
// database instance in one run.

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const raw = process.env.RECORDS_CONTRACT_WORKERD;
if (!raw) throw new Error("vitest.workerd.config.ts is started by __tests__/workerd.test.ts (RECORDS_CONTRACT_WORKERD is not set).");
const contract = JSON.parse(raw) as { appUrl: string; issuer: string; audience: string; target: Record<string, unknown> };

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-04",
        compatibilityFlags: ["nodejs_compat"],
        hyperdrives: { HYPERDRIVE: contract.appUrl },
        bindings: {
          CF_ACCESS_ISS: contract.issuer,
          RECORDS_API_ACCESS_AUD: contract.audience,
          CONTRACT_TARGET: JSON.stringify(contract.target),
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    testTimeout: 30_000,
    // postgres.js's Workers socket polyfill rejects its read loop with "Stream was cancelled" when
    // the pool ends a request's I/O context while the per-request client's end() is still pending
    // in waitUntil. It is teardown noise after the response was sent, not a contract failure; any
    // other unhandled error still fails the run.
    onUnhandledError(error) {
      const text = `${error.message ?? ""}\n${error.stack ?? ""}`;
      if (/Stream was cancelled/.test(text) && /postgres\/cf\/polyfills/.test(text)) return false;
    },
  },
});
