// The Records service vendor, its auto-provisioned accounts and the datastore picker.
//
// Accounts carry no credentials: the operator approves datastores by putting their credentials in
// the Worker secret, and every account can see that approved list. Connecting a gadget chooses
// one approved datastore and whether the gadget may only read or may also request changes.

import { RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription, AvatarImage, Gatekeeper, GatekeeperConnectCallback, GatekeeperConnectOptions, GatekeeperUser, GatekeeperUserVerifier,
  ResourceConfiguratorFrame, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { DATASTORE_URL_PATTERN, datastoreUrl, parseDatastoreUrl, type Access } from "./config.js";
import { deployment, describeApproved, type RecordsServiceVerifierApi } from "./gatekeeper.js";
import { CONFIGURATOR_HTML, TYPES_CODE } from "./generated.js";
import type { RecordsServiceSession } from "./types.js";

export const RECORDS_SERVICE_ICON: AvatarImage = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='#14532d'/>" +
    "<ellipse cx='16' cy='10' rx='8' ry='3.2' fill='none' stroke='#d9f99d' stroke-width='2'/>" +
    "<path d='M8 10v12c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2V10M8 16c0 1.8 3.6 3.2 8 3.2s8-1.4 8-3.2' fill='none' stroke='#d9f99d' stroke-width='2'/></svg>"),
};

export const DATASTORE_RESOURCE: SupportedResource = {
  urlPattern: DATASTORE_URL_PATTERN,
  title: "Records datastore",
  description: "One operator-approved Records service datastore (for example work items or messages), read-only or with approved changes.",
};

export type ConfiguratorDatastore = {
  id: string; label: string; available: boolean; moduleId?: string; apiMajor?: number; entities?: string[]; commands?: string[]; writable?: boolean;
};

/** Capability behind the datastore picker. Lists approved datastores; never returns credentials. */
export class ConfiguratorApi extends RpcTarget {
  readonly #env: Cloudflare.Env;
  constructor(env: Cloudflare.Env) { super(); this.#env = env; }

  async datastores(): Promise<ConfiguratorDatastore[]> {
    const config = deployment(this.#env);
    return Promise.all(config.all.map(async (entry): Promise<ConfiguratorDatastore> => {
      try {
        const description = await describeApproved(config.url, entry);
        const module = description.modules.find((candidate) => candidate.id === description.module_id) ?? description.modules[0];
        if (!module) return { id: entry.id, label: entry.label, available: false };
        return {
          id: entry.id, label: entry.label, available: true, moduleId: module.id, apiMajor: description.api_major,
          entities: (module.entities ?? []).slice(0, 20), commands: (module.commands ?? []).slice(0, 20),
          writable: description.granted_scopes.includes(`${module.id}.write`),
        };
      } catch {
        return { id: entry.id, label: entry.label, available: false };
      }
    }));
  }

  async resourceUrl(datastore: string, access: string): Promise<string> {
    const chosen = (await this.datastores()).find((entry) => entry.id === datastore);
    if (!chosen?.available || !chosen.moduleId || !chosen.apiMajor) throw new Error("That datastore is not available.");
    const wanted: Access = access === "write" && chosen.writable ? "write" : "read";
    return datastoreUrl(chosen.id, chosen.moduleId, chosen.apiMajor, wanted);
  }
}

@validateRpc()
export class RecordsServiceVerifier extends WorkerEntrypoint<Cloudflare.Env> implements RecordsServiceVerifierApi {
  async recordsServiceMember(): Promise<true> { return true; }
}

@validateRpc()
export class RecordsServiceAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> { return { displayName: "Records", avatar: RECORDS_SERVICE_ICON }; }
  async getSupportedResources(): Promise<SupportedResource[]> { return [DATASTORE_RESOURCE]; }

  @skipRpcValidation()
  async startResourceConfigurator(pattern: string): Promise<ResourceConfiguratorFrame> {
    if (pattern !== DATASTORE_URL_PATTERN) throw new Error(`Unsupported resource pattern: ${pattern}`);
    return { iframeHtml: CONFIGURATOR_HTML, ui: new RpcStub(new ConfiguratorApi(this.env)) as never };
  }

  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<RecordsServiceSession>>; resource: SupportedResource }> {
    const resource = parseDatastoreUrl(url);
    return { class: this.ctx.exports.RecordsServiceGatekeeper({ props: { resourceUrl: resource.url } }) as never, resource: DATASTORE_RESOURCE };
  }

  async ensureResources(patterns: string[]): Promise<{ url?: string }> {
    for (const pattern of patterns) if (pattern !== DATASTORE_URL_PATTERN) throw new Error(`Unsupported resource pattern: ${pattern}`);
    return {};
  }

  async revoke(): Promise<void> {}
  async reconnect(): Promise<{ url: string }> { throw new Error("Records accounts have no credentials to refresh."); }
  async getAuthenticatedEmail(): Promise<null> { return null; }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.RecordsServiceVerifier({}) as never; }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Records",
      url: "https://records.surprisingly.ltd/",
      logo: RECORDS_SERVICE_ICON,
      color: "#ecfccb",
      tagline: "Shared, standards-based app datastores",
      description:
        "Connect gadgets to a Records datastore, such as a shared work tracker. Several boards, reports and explorers can use " +
        "the same datastore at once. Records belong to the datastore, so removing a gadget keeps them, and every change is " +
        "approved and attributed to the person who asked.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> { return this.ctx.exports.RecordsServiceAccount({}) as never; }

  async connectAccount(_callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    throw new Error("Records accounts are created automatically and have no connect flow.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> { return [DATASTORE_RESOURCE]; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}
