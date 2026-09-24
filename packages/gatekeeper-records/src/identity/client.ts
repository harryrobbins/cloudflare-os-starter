// The in-process datastore client the gadget gatekeeper calls the domain through (canonical plan
// §5, §9). The gatekeeper mints a delegated token; `open()` verifies it with the ServiceAuthenticator
// (signature, issuer, audience, lifetime, datastore, single use, then the binding and principal
// against fresh state) and returns a handle whose every call acts as the caller derived from those
// verified claims. Vendor code never builds a CallerContext for a record operation.
//
// This is the seam where an HTTP client goes once the datastore service runs in its own Worker:
// the handle's methods mirror the native API, except `syncPush`'s approval gate, which only an
// in-process caller can supply.

import type { CallerContext, Comment, DatastoreSummary, DatastoreDetail, DomainOperation, Issue, MutatingRecordOperation, Page, PrincipalRef, Project, PullResponse, PushResponse, Workflow } from "@records/contracts";
import type { Idempotent, PullOptions, PushOptions, RecordsService } from "@records/core";

import type { ServiceAuthenticator } from "./authenticator.js";

export type DatastoreWriteResult = Idempotent<unknown>;

export class DatastoreHandle {
  readonly #caller: CallerContext;
  readonly #service: RecordsService;
  readonly datastoreId: string;

  constructor(caller: CallerContext, service: RecordsService, datastoreId: string) {
    this.#caller = caller;
    this.#service = service;
    this.datastoreId = datastoreId;
  }

  /** The principal the verified token speaks for. */
  get principalId(): string {
    return this.#caller.principalId;
  }

  getDatastore(): Promise<DatastoreSummary | DatastoreDetail> {
    return this.#service.registry.getDatastore(this.#caller, this.datastoreId);
  }

  /** The binding's stored scopes (empty once it is gone). */
  async bindingScopes(): Promise<string[]> {
    if (!this.#caller.bindingId) return [];
    return (await this.#service.registry.resolveBinding(this.#caller.orgId, this.#caller.bindingId))?.scopes ?? [];
  }

  /** Which of `principalIds` (in the caller's organisation) can read this datastore now. */
  readersAmong(principalIds: string[]): Promise<Set<string>> {
    return this.#service.registry.readersAmong(this.#caller.orgId, this.datastoreId, principalIds);
  }

  checkAccess(operation: DomainOperation): Promise<{ lifecycle: "active" | "archived" }> {
    return this.#service.registry.checkAccess(this.#caller, this.datastoreId, operation);
  }

  listProjects(): Promise<Project[]> {
    return this.#service.projects.listProjects(this.#caller, this.datastoreId);
  }

  getWorkflow(): Promise<Workflow> {
    return this.#service.projects.getWorkflow(this.#caller, this.datastoreId);
  }

  listIssues(input: unknown): Promise<Page<Issue>> {
    return this.#service.projects.listIssues(this.#caller, this.datastoreId, input);
  }

  getIssue(issueId: string): Promise<Issue> {
    return this.#service.projects.getIssue(this.#caller, this.datastoreId, issueId);
  }

  listAssignees(): Promise<PrincipalRef[]> {
    return this.#service.registry.listAssignees(this.#caller, this.datastoreId);
  }

  listComments(input: unknown): Promise<Page<Comment>> {
    return this.#service.projects.listComments(this.#caller, this.datastoreId, input);
  }

  write(operation: MutatingRecordOperation, input: unknown, idempotencyKey: string): Promise<DatastoreWriteResult> {
    const projects = this.#service.projects;
    switch (operation) {
      case "createIssue":
        return projects.createIssue(this.#caller, this.datastoreId, input, idempotencyKey);
      case "editIssue":
        return projects.editIssue(this.#caller, this.datastoreId, input, idempotencyKey);
      case "transitionIssue":
        return projects.transitionIssue(this.#caller, this.datastoreId, input, idempotencyKey);
      case "addComment":
        return projects.addComment(this.#caller, this.datastoreId, input, idempotencyKey);
    }
  }

  syncPush(request: unknown, options?: PushOptions): Promise<PushResponse> {
    return this.#service.sync.push(this.#caller, this.datastoreId, request, options);
  }

  syncPull(request: unknown, options?: PullOptions): Promise<PullResponse> {
    return this.#service.sync.pull(this.#caller, this.datastoreId, request, options);
  }
}

export class DelegatedDatastoreClient {
  readonly #authenticator: ServiceAuthenticator;
  readonly #service: RecordsService;

  constructor(authenticator: ServiceAuthenticator, service: RecordsService) {
    this.#authenticator = authenticator;
    this.#service = service;
  }

  /** Verify `token` for `datastoreId` (claiming its single use) and return a handle acting as it. */
  async open(token: string, datastoreId: string): Promise<DatastoreHandle> {
    const caller = await this.#authenticator.verifyDelegated(token, datastoreId);
    return new DatastoreHandle(caller, this.#service, datastoreId);
  }
}
