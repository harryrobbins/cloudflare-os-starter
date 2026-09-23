// `RecordsAccount`: one person's connection to their organisation's Records service.
//
// Created only by the Access-verified connect flow (connect.ts), which binds the account to the
// principal mapped from the person's verified sign-in e-mail. The account is a route into
// organisation resources, not their owner: revoking it revokes the gadget bindings made through
// it and leaves every record in place.

import { WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  AppUiContext,
  Gatekeeper,
  GatekeeperUiFrame,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ResourceConfiguratorFrame,
  SupportedResource,
} from "@gadgets/workshop-shared/gatekeeper";

import { APP_HTML } from "../generated/app.js";
import { CONFIGURATOR_HTML } from "../configurator/html.js";
import { apiBase, recordsService } from "../runtime.js";
import { ConfiguratorApi } from "./configurator.js";
import { DataManagement } from "./management.js";
import { DATASTORE_RESOURCE, DATASTORE_URL_PATTERN, parseDatastoreUrl } from "./resource.js";
import type { RecordsSession } from "./types.js";
import { RECORDS_ICON } from "./vendor.js";

export type RecordsAccountProps = { accountId: string; orgId: string; principalId: string; displayName: string; email: string };

@validateRpc()
export class RecordsAccount extends WorkerEntrypoint<Cloudflare.Env, RecordsAccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: this.ctx.props.displayName,
      uniqueName: this.ctx.props.email,
      avatar: RECORDS_ICON,
      providesUi: { title: "Data", icon: RECORDS_ICON },
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [DATASTORE_RESOURCE];
  }

  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<RecordsSession>>; resource: SupportedResource }> {
    const { datastoreId, scopes } = parseDatastoreUrl(url);
    const { accountId, orgId, principalId } = this.ctx.props;
    return {
      class: this.ctx.exports.RecordsGatekeeper({ props: { accountId, orgId, principalId, datastoreId, scopes } }) as never,
      resource: DATASTORE_RESOURCE,
    };
  }

  @skipRpcValidation()
  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern !== DATASTORE_URL_PATTERN) throw new Error(`Unsupported resource pattern: ${resourceUrlPattern}`);
    return { iframeHtml: CONFIGURATOR_HTML, ui: new ConfiguratorApi(recordsService(this.env), this.ctx.props) as never };
  }

  /** The Data management page. `isAdmin` (deployment admin) deliberately confers nothing here. */
  @skipRpcValidation()
  async startAppUi(_context: AppUiContext): Promise<GatekeeperUiFrame> {
    return { iframeHtml: APP_HTML, ui: new DataManagement(recordsService(this.env), this.ctx.props, apiBase(this.env)) as never };
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Revoke the gadget bindings made through this connection. Records are kept. */
  async revoke(): Promise<void> {
    const { orgId, principalId, accountId } = this.ctx.props;
    await recordsService(this.env).registry.revokeConnection({ orgId, principalId, via: "management" }, accountId);
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("Records connections have no credentials to refresh. Remove and connect again if your identity changed.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.RecordsVerifier({ props: { orgId: this.ctx.props.orgId, principalId: this.ctx.props.principalId } }) as never;
  }
}
