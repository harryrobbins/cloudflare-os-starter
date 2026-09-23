// Capability behind the resource configurator (the datastore picker in the Workshop's connect
// modal). It lists only datastores the person can read, and the scopes they could grant on each.

import { RpcTarget } from "cloudflare:workers";
import { effectivePermissions, RECORD_SCOPES, type CallerContext, type DatastoreSummary, type Page, type RecordScope } from "@records/contracts";

import type { RecordsService } from "../domain/service.js";
import { datastoreUrl } from "./resource.js";

export class ConfiguratorApi extends RpcTarget {
  readonly #service: RecordsService;
  readonly #caller: CallerContext;

  constructor(service: RecordsService, account: { orgId: string; principalId: string }) {
    super();
    this.#service = service;
    this.#caller = { orgId: account.orgId, principalId: account.principalId, via: "management" };
  }

  /** Compatible (Projects v1), active datastores the person is a member of. */
  searchDatastores(query: string, cursor?: string): Promise<Page<DatastoreSummary>> {
    return this.#service.registry.searchDatastores(this.#caller, { query: String(query ?? "").slice(0, 200), moduleId: "projects", apiMajor: 1, limit: 20, ...(cursor ? { cursor } : {}) });
  }

  /** The scopes the person could grant a gadget on this datastore (their role's record scopes). */
  async grantableScopes(datastoreId: string): Promise<RecordScope[]> {
    const access = await this.#service.registry.checkAccess(this.#caller, datastoreId, "listProjects");
    const permissions = effectivePermissions(access.role, undefined);
    return RECORD_SCOPES.filter((s) => permissions.has(s));
  }

  async resourceUrl(datastoreId: string, scopes: RecordScope[]): Promise<string> {
    const grantable = await this.grantableScopes(datastoreId);
    const chosen = scopes.filter((s) => grantable.includes(s));
    if (!chosen.includes("projects.read")) chosen.push("projects.read");
    return datastoreUrl(datastoreId, chosen);
  }
}
