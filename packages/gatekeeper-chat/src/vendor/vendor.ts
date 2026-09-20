// The `GatekeeperVendor` entrypoint: what the Workshop binds when `chat.agentAccess` is on.
//
// There is no OAuth flow and nothing to connect. Chat is part of this deployment, everyone who can
// reach the Workshop can already reach chat, and the agent acts as the built-in `agent` account
// rather than as a person. So the vendor auto-provisions: the Workshop mints one account per user
// with `createAccount()`, and that account's only capability is the ambient `ChatSession`.

import { WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AvatarImage,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperUser,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";

import type { ChatEnv } from "../env.js";
import { APP_BASE } from "../shared/routes.js";
import TYPES_CODE from "./types-code.js";

/** Speech bubble, drawn inline so the vendor card needs no asset from anywhere. */
export const CHAT_ICON: AvatarImage = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' " +
        "stroke='currentColor' stroke-width='16' stroke-linecap='round' stroke-linejoin='round'>" +
        "<path d='M45 196a96 96 0 1 1 39 31l-47 13a8 8 0 0 1-10-10l13-47Z'/>" +
        "<path d='M96 112h64M96 144h40'/></svg>",
    ),
};

/** Where the chat app lives, for the vendor card's link. */
export function chatHomeUrl(env: Pick<ChatEnv, "PUBLIC_BASE_URL">): string {
  try {
    return new URL(APP_BASE, env.PUBLIC_BASE_URL).toString();
  } catch {
    // An unset or malformed PUBLIC_BASE_URL must not break the connectors page over a link.
    return "https://github.com/cloudflare/cloudflare-os-starter";
  }
}

export function describeChatVendor(url: string): VendorDescription {
  return {
    displayName: "Team chat",
    url,
    logo: CHAT_ICON,
    color: "#eef5ff",
    tagline: "Read, search and post in this deployment's chat",
    description:
      "Gives every workspace an ambient capability on this deployment's team chat. The agent can " +
      "list the public channels, read their history and threads, and search them; posting a " +
      "message is an action you approve first. Private channels, group conversations and direct " +
      "messages are never visible to the agent.",
    // One account per user, no connect flow: chat is part of this deployment, not a third party.
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  /** Describes the auto-provisioned team-chat vendor. */
  async describe(): Promise<VendorDescription> {
    return describeChatVendor(chatHomeUrl(this.env));
  }

  /** Mints one opaque chat account. Carries no identity: the agent is always the `agent` account. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.ChatAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  /** Rejects interactive connection: there is nothing to authorize. */
  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Team chat is auto-provisioned and has no connect flow.");
  }

  /** Returns no URL-addressed resources: the only capability is the ambient session. */
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  /** Returns the complete agent-facing team-chat declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
