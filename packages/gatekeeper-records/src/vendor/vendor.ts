// `GatekeeperVendor` for organisation Records. Connecting is an Access-verified flow (connect.ts):
// the Workshop opens a same-origin page, the person confirms, and the account is bound to the
// directory entry of their verified sign-in e-mail. Nothing is auto-provisioned, and connecting
// grants no datastore access by itself: memberships do.

import { WorkerEntrypoint } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  AvatarImage,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";

import { startConnectFlow } from "../connect.js";
import { DATASTORE_RESOURCE } from "./resource.js";
import TYPES_CODE from "./types-code.js";

export const RECORDS_ICON: AvatarImage = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='none' stroke='currentColor' " +
        "stroke-width='16' stroke-linecap='round' stroke-linejoin='round'>" +
        "<ellipse cx='128' cy='64' rx='80' ry='32'/><path d='M48 64v64c0 18 36 32 80 32s80-14 80-32V64'/>" +
        "<path d='M48 128v64c0 18 36 32 80 32s80-14 80-32v-64'/></svg>",
    ),
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Organisation records",
      url: this.env.PUBLIC_BASE_URL || "https://developers.cloudflare.com/hyperdrive/",
      logo: RECORDS_ICON,
      color: "#eef7f1",
      tagline: "Shared, organisation-owned project data",
      description:
        "Connect gadgets to your organisation's datastores. Records belong to the organisation, not " +
        "to any gadget or person: replacing a gadget or removing a connection keeps every record. " +
        "Changes are made as the person using the gadget, within their own permissions.",
      autoProvisionsAccount: false,
      providesAuth: false,
    };
  }

  async connectAccount(callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    return startConnectFlow(this.env, this.ctx.exports, callback);
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [DATASTORE_RESOURCE];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
