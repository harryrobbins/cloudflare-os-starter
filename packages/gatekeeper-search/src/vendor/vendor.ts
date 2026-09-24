// The `GatekeeperVendor` entrypoint: what the Workshop binds when `search.agentAccess` is on.
//
// Auto-provisioned, like team chat: the index is part of this deployment, so there is nothing to
// connect. The Workshop mints one account per user with `createAccount()`, and that account's only
// capability is the ambient `SearchSession`.

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

import type { SearchEnv } from "../env.js";
import { APP_BASE } from "../shared/contract.js";
import TYPES_CODE from "./types-code.js";

/** Magnifying glass, inline so the vendor card needs no asset. */
export const SEARCH_ICON: AvatarImage = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' " +
        "stroke='currentColor' stroke-width='16' stroke-linecap='round' stroke-linejoin='round'>" +
        "<circle cx='112' cy='112' r='72'/><path d='M163 163l53 53'/></svg>",
    ),
};

export function searchHomeUrl(env: Pick<SearchEnv, "PUBLIC_BASE_URL">): string {
  try {
    return new URL(APP_BASE, env.PUBLIC_BASE_URL).toString();
  } catch {
    return "https://github.com/cloudflare/cloudflare-os-starter";
  }
}

export function describeSearchVendor(url: string): VendorDescription {
  return {
    displayName: "Omni-search",
    url,
    logo: SEARCH_ICON,
    color: "#f1f0ff",
    tagline: "Find anything shared in this deployment, by meaning and by words",
    description:
      "Gives every workspace an ambient, read-mostly capability on this deployment's omni-search " +
      "index. The agent can search, count and read deployment-public content -- public chat " +
      "channels and public Context collections -- plus documents this workspace's own gadgets " +
      "indexed, and offers a /find command. The agent has no identity of its own here, so private " +
      "channels, direct messages and other people's private documents are never visible to it. " +
      "Indexing a gadget's document is an auto-approvable action that only affects that workspace's " +
      "own results.",
    autoProvisionsAccount: true,
    providesAuth: false,
  };
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<SearchEnv> {
  async describe(): Promise<VendorDescription> {
    return describeSearchVendor(searchHomeUrl(this.env));
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.SearchAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Omni-search is auto-provisioned and has no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
