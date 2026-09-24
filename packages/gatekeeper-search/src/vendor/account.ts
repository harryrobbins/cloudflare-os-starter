// `SearchAccount`: the auto-provisioned account whose only capability is the ambient `SearchSession`.
//
// It holds no credentials and no storage; it exists because the Workshop's model needs one account
// per user. Its `accountId` reaches the facet's `ctx.props` for log attribution only.

import { WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  Gatekeeper,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  SupportedResource,
} from "@gadgets/workshop-shared/gatekeeper";

import type { SearchEnv } from "../env.js";
import type { SearchSession } from "./types.js";
import { SEARCH_ICON } from "./vendor.js";

/** Imbued by `GatekeeperVendor.createAccount()`. */
export type SearchAccountProps = { accountId: string };

export function describeSearchAccount(): AccountDescription {
  return {
    displayName: "Omni-search",
    avatar: SEARCH_ICON,
    singleton: { tsType: "SearchSession" },
  };
}

@validateRpc()
export class SearchAccount
  extends WorkerEntrypoint<SearchEnv, SearchAccountProps>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return describeSearchAccount();
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<SearchSession>>> {
    return this.ctx.exports.SearchGatekeeper({ props: this.ctx.props }) as unknown as DurableObjectClass<
      Gatekeeper<SearchSession>
    >;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("Omni-search has no URL-addressed resources.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Omni-search has no URL-addressed resources.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /**
   * Nothing is deleted: the index belongs to the deployment. Documents a workspace's gadgets indexed
   * stay under that workspace's partition, unreachable once no session can name it.
   */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Omni-search has no credentials to reconnect.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.SearchVerifier({});
  }
}

/** The opaque token `addObserver()` is handed; the public no-op makes it reachable via ctx.exports. */
@validateRpc()
export class SearchVerifier extends WorkerEntrypoint<SearchEnv> implements GatekeeperUserVerifier {
  verify(): void {}
}
