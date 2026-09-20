// `ChatAccount`: the auto-provisioned account whose only capability is the ambient `ChatSession`.
//
// It holds no credentials and no storage. The account exists because the Workshop's model needs one
// per user, and its `accountId` is carried into the singleton facet's `ctx.props` so a failed post
// can be attributed in the chat Worker's logs. Nothing about what the agent may read or post depends
// on which account it is: chat authorizes the built-in `agent` identity, deployment-wide.

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

import type { ChatSession } from "./types.js";
import { CHAT_ICON } from "./vendor.js";

/** Imbued by `GatekeeperVendor.createAccount()`. */
export type ChatAccountProps = { accountId: string };

/**
 * Describes the account.
 *
 * `singleton` is the whole point: it tells the Workshop to install this account's gatekeeper into
 * every one of the owner's gadgets and hand the agent its session unasked. There is no `providesUi`
 * -- the management UI for chat is the chat app itself, at `/gatekeeper/chat/`.
 */
export function describeChatAccount(): AccountDescription {
  return {
    displayName: "Team chat",
    avatar: CHAT_ICON,
    singleton: { tsType: "ChatSession" },
  };
}

@validateRpc()
export class ChatAccount
  extends WorkerEntrypoint<Cloudflare.Env, ChatAccountProps>
  implements GatekeeperUser
{
  /** Describes the auto-provisioned team-chat account. */
  async describe(): Promise<AccountDescription> {
    return describeChatAccount();
  }

  /** Returns the account-imbued ambient chat facet class. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<ChatSession>>> {
    return this.ctx.exports.ChatGatekeeper({ props: this.ctx.props });
  }

  /** Returns no URL-addressed resources. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  /** Rejects URL resource lookup: team chat is ambient-only. */
  getGatekeeperClassFor(_url: string): never {
    throw new Error("Team chat has no URL-addressed resources.");
  }

  /** Rejects resource configuration: team chat is ambient-only. */
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Team chat has no URL-addressed resources.");
  }

  /** Confirms there are no grantable resource scopes to expand. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /**
   * Drops the account.
   *
   * Nothing is deleted: the chat history belongs to the deployment and its people, not to this
   * account, and the account itself stores nothing. Revoking simply means the Workshop stops
   * offering the session; any post still awaiting approval dies with the facet.
   */
  async revoke(): Promise<void> {}

  /** Rejects reconnect: there are no credentials. */
  reconnect(): Promise<{ url: string }> {
    throw new Error("Team chat has no credentials to reconnect.");
  }

  /** Returns no sign-in identity: chat is not an identity provider. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the trivial verifier the low-stakes observer policy uses. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.ChatVerifier({});
  }
}

/**
 * The opaque token `addObserver()` is handed.
 *
 * `ChatGatekeeper.addObserver()` accepts every observer, so nothing is ever asked of it; it exists
 * because the Workshop mints one per open. The public no-op method is what makes it reachable
 * through `ctx.exports` -- an entrypoint with no methods is not registered.
 */
@validateRpc()
export class ChatVerifier
  extends WorkerEntrypoint<Cloudflare.Env>
  implements GatekeeperUserVerifier
{
  verify(): void {}
}
