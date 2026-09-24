// Bindings that exist only under vitest (vitest.config.ts), added to the generated `Cloudflare.Env`.
import type { SpikeFts } from "./spikes/fts-do.js";
import type { SpikeWsLocal } from "./spikes/ws-do.js";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Spike 1: the FTS5 Durable Object, called over RPC. */
      SPIKE_FTS: DurableObjectNamespace<SpikeFts>;
      /** Spike 2, eviction half: hosted by the main Worker so it can be evicted. */
      SPIKE_WS_LOCAL: DurableObjectNamespace<SpikeWsLocal>;
      /** Upload cap from deployment.jsonc; lowered under test so the fallback is distinguishable. */
      MAX_UPLOAD_BYTES: number;
      /** Dev-entry vars, configured under test so the production bypass test has something to ignore. */
      DEV_IDENTITIES: string;
      DEV_IDENTITY_SECRET: string;
      /** Spikes 2 and 3: the router-shaped auxiliary Worker. */
      ROUTER: Fetcher;
      /** The mock Workshop's `Control` entrypoint (__tests__/aux/workshop-gateway.js). */
      WORKSHOP_CONTROL: Fetcher & {
        calls(prefix: string): Promise<Array<Record<string, unknown>>>;
        respond(messageKey: string, text: string): Promise<void>;
      };
      /**
       * The mock search Worker's `Control` entrypoint (__tests__/aux/search-service.js). Bound only in
       * the `omni-search` project; undefined in `chat`.
       */
      SEARCH_CONTROL: Fetcher & {
        ingests(marker: string): Promise<Array<{ source: string; batch: import("../src/search-client.js").IngestBatch }>>;
        failedAttempts(marker: string): Promise<number>;
        failIngest(marker: string, times: number, skip?: number, message?: string): Promise<void>;
        healIngest(marker: string): Promise<void>;
        script(
          text: string,
          result:
            | { hits?: import("../src/search-client.js").DenseRecallHit[]; dense?: string; hangMs?: number }
            | { error: string },
        ): Promise<void>;
        recalls(text: string): Promise<Array<import("../src/search-client.js").DenseRecallRequest & { source: string }>>;
      };
    }
  }
}
