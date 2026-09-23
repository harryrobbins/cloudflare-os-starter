// The workerd suite: the Gatekeeper facet, session, viewer-assertion redemption and observers,
// running in the real runtime against a real (embedded) Postgres reached through Miniflare's local
// Hyperdrive. The database is created and seeded here, at config time, because Miniflare needs the
// connection strings before any test starts.

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

import { startTestCluster } from "../records-schema/src/testing.ts";
import { seedWorkerdWorld } from "./__tests__/workerd-seed.ts";

const cluster = await startTestCluster();
const { db, ...seed } = await seedWorkerdWorld(cluster.superuserUrl);
const appUrl = db.appUrl;
const publisherUrl = db.publisherUrl;
// Stopped by workerd-teardown.ts (a globalSetup in this same process).
(globalThis as { __recordsTestCluster?: { stop(): Promise<void> } }).__recordsTestCluster = cluster;

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/workerd/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
        // Declared so the pool registers them as Durable Object classes: ctx.exports.X({props}) must
        // yield a DurableObjectClass for ctx.facets, exactly as in production.
        durableObjects: {
          TEST_HOOKS: { className: "TestHooks", useSQLite: true },
          RECORDS_GATEKEEPER: { className: "RecordsGatekeeper", useSQLite: true },
          CONNECT_FLOWS: { className: "RecordsConnectFlow", useSQLite: true },
          FEEDS: { className: "DatastoreFeed", useSQLite: true },
        },
        hyperdrives: { HYPERDRIVE: appUrl, HYPERDRIVE_PUBLISHER: publisherUrl },
        queueProducers: { CHANGES: "records-changes" },
        bindings: {
          CF_ACCESS_ISS: "https://test.cloudflareaccess.example",
          CF_ACCESS_AUD: "workshop-aud",
          RECORDS_API_ACCESS_AUD: "api-aud",
          PUBLIC_BASE_URL: "https://records.example.test",
          TEST_SEED: JSON.stringify(seed),
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/workerd/*.test.ts"],
    globalSetup: ["./__tests__/workerd-teardown.ts"],
    testTimeout: 30_000,
  },
});
