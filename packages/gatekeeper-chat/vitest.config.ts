// Tests run inside workerd via @cloudflare/vitest-pool-workers, on the same compatibility date and
// flags as wrangler.jsonc so a passing test says something about production.
//
// The first two auxiliary workers exist for the spikes; the third stands in for the Workshop's
// ExternalMessageGateway in the agent suites. They are plain JavaScript on purpose: auxiliary
// workers are handed straight to Miniflare and never see Vite, so they cannot import TypeScript or a
// workspace package. Their job is to be *other Workers*, which is the only way to exercise the thing
// the router actually does -- reach this Worker over a service binding, WebSocket upgrade included.
//
// The pool's own runner Worker gets a generated, per-project name, so an auxiliary Worker cannot bind
// back to it. The chain therefore runs main -> ROUTER (aux) -> CHAT (aux), which is one hop more than
// production and proves the same property.
//
// Two projects share that setup. `chat` is every existing suite, with no SEARCH binding -- exactly a
// deployment with omni-search off, so none of those suites sees an outbox, a backfill or fusion.
// `omni-search` is the same Worker plus SEARCH, bound to a mock `SearchService`
// (__tests__/aux/search-service.js) the way deploy.ts binds the real one, and runs only
// __tests__/omni-search/. Separate projects rather than one config because a binding changes the
// Durable Object's behaviour for every test that touches it.
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { configDefaults, defineConfig } from "vitest/config";

const COMPATIBILITY_DATE = "2026-08-04";
const COMPATIBILITY_FLAGS = ["allow_irrevocable_stub_storage", "nodejs_compat"];

// Miniflare's equivalent of wrangler.jsonc's `assets.run_worker_first`: without it the asset server
// answers first and `/gatekeeper/chat/ws` 404s before the Worker ever sees it.
const ASSET_ROUTER = { has_user_worker: true, invoke_user_worker_ahead_of_assets: true } as const;

const SEARCH_SUITES = "__tests__/omni-search/**/*.test.ts";

function chatProject(name: string, search: boolean) {
  return {
    extends: false as const,
    plugins: [
      capnwebValidate(),
      cloudflareTest({
        main: "./__tests__/worker.ts",
        miniflare: {
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: COMPATIBILITY_FLAGS,

          durableObjects: {
            CHAT_WORKSPACE: { className: "ChatWorkspace", useSQLite: true },
            SPIKE_FTS: { className: "SpikeFts", useSQLite: true },
            SPIKE_WS_LOCAL: { className: "SpikeWsLocal" },
          },
          r2Buckets: ["FILES"],
          bindings: {
            CF_ACCESS_ISS: "https://test.cloudflareaccess.example",
            CF_ACCESS_AUD: "test-aud",
            ADMINS: '["admin@example.test"]',
            PUBLIC_BASE_URL: "https://chat.example.test",
            MAX_UPLOAD_BYTES: 4 * 1024 * 1024,
            // Present so the "production ignores the dev bypass" test is meaningful: even with the dev
            // vars configured, src/index.ts has no code path that reads them.
            DEV_IDENTITIES:
              '[{"id":"dev-admin","email":"admin@example.test","name":"Dev Admin"},{"id":"dev-user","email":"user@example.test"}]',
            DEV_IDENTITY_SECRET: "test-dev-secret",
          },
          assets: { directory: "./app/dist", binding: "ASSETS", routerConfig: ASSET_ROUTER },

          serviceBindings: {
            ROUTER: "spike-router",
            // The agent suites: the Workshop's gateway as deploy.ts binds it, and a side door that
            // lets a test deliver the answer the way the Overseer would (__tests__/aux/workshop-gateway.js).
            WORKSHOP_GATEWAY: {
              name: "mock-workshop",
              entrypoint: "ExternalMessageGateway",
              props: { source: "chat" },
            },
            WORKSHOP_CONTROL: { name: "mock-workshop", entrypoint: "Control" },
            ...(search
              ? {
                  SEARCH: { name: "mock-search", entrypoint: "SearchService", props: { source: "chat" } },
                  SEARCH_CONTROL: { name: "mock-search", entrypoint: "Control" },
                }
              : {}),
          },

          workers: [
            {
              name: "spike-router",
              modules: true,
              scriptPath: "./__tests__/spikes/aux/router.js",
              compatibilityDate: COMPATIBILITY_DATE,
              compatibilityFlags: COMPATIBILITY_FLAGS,
              serviceBindings: { CHAT: "spike-chat" },
            },
            {
              name: "spike-chat",
              modules: true,
              scriptPath: "./__tests__/spikes/aux/chat.js",
              compatibilityDate: COMPATIBILITY_DATE,
              compatibilityFlags: COMPATIBILITY_FLAGS,
              durableObjects: { SPIKE_WS: { className: "SpikeWs" } },
              assets: { directory: "./app/dist", binding: "ASSETS", routerConfig: ASSET_ROUTER },
            },
            {
              name: "mock-workshop",
              modules: true,
              scriptPath: "./__tests__/aux/workshop-gateway.js",
              compatibilityDate: COMPATIBILITY_DATE,
              compatibilityFlags: COMPATIBILITY_FLAGS,
              durableObjects: { TARGETS: { className: "TargetStore", useSQLite: true } },
            },
            ...(search
              ? [
                  {
                    name: "mock-search",
                    modules: true,
                    scriptPath: "./__tests__/aux/search-service.js",
                    compatibilityDate: COMPATIBILITY_DATE,
                    compatibilityFlags: COMPATIBILITY_FLAGS,
                  },
                ]
              : []),
          ],
        },
      }),
    ],
    test: search
      ? { name, include: [SEARCH_SUITES] }
      : { name, include: ["__tests__/**/*.test.ts"], exclude: [...configDefaults.exclude, SEARCH_SUITES] },
  };
}

export default defineConfig({
  test: { projects: [chatProject("chat", false), chatProject("omni-search", true)] },
});
