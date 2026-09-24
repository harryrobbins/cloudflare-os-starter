// The test environment's bindings, as vitest.config.ts configures them, on top of the generated
// `Cloudflare.Env` (worker-configuration.d.ts).
declare global {
  namespace Cloudflare {
    interface Env {
      SEARCH_INDEX: DurableObjectNamespace<import("../src/search-index.js").SearchIndex>;
    }
  }
}
export {};
