// The Data management capability handed to the Workshop-hosted management page (startAppUi).
//
// Every method acts as the connected account's principal, which was established by the
// Access-verified connect flow. There is no binding narrowing it: this is the person managing
// their organisation's data directly, subject to their own roles. The page itself holds no
// credential; the capability is scoped to this account and dies with it.

import { RpcTarget } from "cloudflare:workers";

import type {
  AuditEvent,
  Binding,
  CallerContext,
  CreatedCredential,
  CredentialInfo,
  DatastoreDetail,
  DatastoreSummary,
  Issue,
  Member,
  Page,
  PrincipalRef,
  Project,
  Workflow,
} from "@records/contracts";

import type { RecordsService } from "../domain/service.js";
import type { Whoami } from "../domain/registry.js";

/** What the management page can do. Mirrors the domain; see packages/records-contracts. */
export interface DataManagementApi {
  whoami(): Promise<Whoami>;
  /** Where external clients call the HTTP API, for the credential dialog. */
  apiBase(): Promise<string>;
  searchDatastores(input: unknown): Promise<Page<DatastoreSummary>>;
  getDatastore(datastoreId: string): Promise<DatastoreSummary | DatastoreDetail>;
  createDatastore(input: unknown): Promise<DatastoreSummary>;
  setLifecycle(datastoreId: string, lifecycle: "active" | "archived"): Promise<void>;
  exportDatastore(datastoreId: string): Promise<Record<string, unknown>>;
  listMembers(datastoreId: string): Promise<Member[]>;
  addMember(datastoreId: string, input: unknown): Promise<void>;
  setMemberRole(datastoreId: string, input: unknown): Promise<void>;
  removeMember(datastoreId: string, input: unknown): Promise<void>;
  transferOwnership(datastoreId: string, input: unknown): Promise<void>;
  searchPrincipals(input: unknown): Promise<(PrincipalRef & { email: string | null })[]>;
  invitePrincipal(input: unknown): Promise<PrincipalRef>;
  setDataAdmin(input: unknown): Promise<void>;
  listDataAdmins(): Promise<PrincipalRef[]>;
  listBindings(datastoreId: string): Promise<Binding[]>;
  revokeBinding(bindingId: string): Promise<void>;
  listCredentials(datastoreId: string): Promise<CredentialInfo[]>;
  createCredential(datastoreId: string, input: unknown): Promise<CreatedCredential>;
  revokeCredential(datastoreId: string, credentialId: string): Promise<void>;
  listAudit(datastoreId: string, input: unknown): Promise<Page<AuditEvent>>;
  listProjects(datastoreId: string): Promise<Project[]>;
  createProject(datastoreId: string, input: unknown): Promise<Project>;
  getWorkflow(datastoreId: string): Promise<Workflow>;
  /** The read-only record inspector. Business edits go through module operations in gadgets. */
  listIssues(datastoreId: string, input: unknown): Promise<Page<Issue>>;
}

export class DataManagement extends RpcTarget implements DataManagementApi {
  readonly #service: RecordsService;
  readonly #caller: CallerContext;
  readonly #apiBase: string;

  constructor(service: RecordsService, account: { orgId: string; principalId: string }, apiBase: string) {
    super();
    this.#service = service;
    this.#caller = { orgId: account.orgId, principalId: account.principalId, via: "management" };
    this.#apiBase = apiBase;
  }

  whoami() { return this.#service.registry.whoami(this.#caller); }
  async apiBase() { return this.#apiBase; }
  searchDatastores(input: unknown) { return this.#service.registry.searchDatastores(this.#caller, input); }
  getDatastore(id: string) { return this.#service.registry.getDatastore(this.#caller, id); }
  createDatastore(input: unknown) { return this.#service.registry.createDatastore(this.#caller, input); }
  setLifecycle(id: string, lifecycle: "active" | "archived") {
    if (lifecycle !== "active" && lifecycle !== "archived") throw new Error("validation_failed: unknown lifecycle");
    return this.#service.registry.setLifecycle(this.#caller, id, lifecycle);
  }
  exportDatastore(id: string) { return this.#service.registry.exportDatastore(this.#caller, id); }
  listMembers(id: string) { return this.#service.registry.listMembers(this.#caller, id); }
  addMember(id: string, input: unknown) { return this.#service.registry.addMember(this.#caller, id, input); }
  setMemberRole(id: string, input: unknown) { return this.#service.registry.setMemberRole(this.#caller, id, input); }
  removeMember(id: string, input: unknown) { return this.#service.registry.removeMember(this.#caller, id, input); }
  transferOwnership(id: string, input: unknown) { return this.#service.registry.transferOwnership(this.#caller, id, input); }
  searchPrincipals(input: unknown) { return this.#service.registry.searchPrincipals(this.#caller, input); }
  invitePrincipal(input: unknown) { return this.#service.registry.invitePrincipal(this.#caller, input); }
  setDataAdmin(input: unknown) { return this.#service.registry.setDataAdmin(this.#caller, input); }
  listDataAdmins() { return this.#service.registry.listDataAdmins(this.#caller); }
  listBindings(id: string) { return this.#service.registry.listBindings(this.#caller, id); }
  revokeBinding(bindingId: string) { return this.#service.registry.revokeBinding(this.#caller, bindingId); }
  listCredentials(id: string) { return this.#service.registry.listCredentials(this.#caller, id); }
  createCredential(id: string, input: unknown) { return this.#service.registry.createCredential(this.#caller, id, input); }
  revokeCredential(id: string, credentialId: string) { return this.#service.registry.revokeCredential(this.#caller, id, credentialId); }
  listAudit(id: string, input: unknown) { return this.#service.registry.listAudit(this.#caller, id, input); }
  listProjects(id: string) { return this.#service.projects.listProjects(this.#caller, id); }
  createProject(id: string, input: unknown) { return this.#service.projects.createProject(this.#caller, id, input); }
  getWorkflow(id: string) { return this.#service.projects.getWorkflow(this.#caller, id); }
  listIssues(id: string, input: unknown) { return this.#service.projects.listIssues(this.#caller, id, input); }
}
