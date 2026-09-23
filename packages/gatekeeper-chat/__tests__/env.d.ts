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
    }
  }
}
