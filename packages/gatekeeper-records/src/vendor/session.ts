// The gadget-facing session (see types.d.ts for the contract the agent sees).
//
// Reads act as the binding: the connecting person's rights ∩ the binding's scopes. Every read is
// authorised as an observation before data is returned, and observers who no longer hold read
// access to the datastore are named in `excludeObservers` (the Workshop refuses the read if it
// cannot keep the data from them).
//
// Writes act as the *viewer who asked*, proven by a viewer assertion redeemed through this
// session's own ApprovalQueue for exactly this operation, input and idempotency key. Rights are
// the viewer's ∩ the binding's scopes, checked now (to fail fast) and again when the approved
// action is applied. No viewer identity outlives the call that carried it.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import {
  IdempotencyKeySchema,
  intentDigest,
  parseInput,
  RecordsError,
  type CallerContext,
  type Comment,
  type Issue,
  type MutatingRecordOperation,
  type MutationOutcome,
  type Page,
  type PrincipalRef,
  type Project,
  type Workflow,
} from "@records/contracts";
import { z } from "zod";

import { normaliseEmail, WORKSHOP_ISSUER } from "../domain/registry.js";
import type { RecordsService } from "../domain/service.js";
import type { RecordsBindingInfo } from "./types.js";

export type PendingWrite = {
  operation: MutatingRecordOperation;
  input: unknown;
  idempotencyKey: string;
  principalId: string;
  viewerName: string;
};

/** What the facet provides the session: resolved binding, storage and the action store. */
export interface SessionHost {
  readonly service: RecordsService;
  readonly orgId: string;
  readonly datastoreId: string;
  bindingCaller(): Promise<CallerContext>;
  observerPrincipals(): Map<string, string>;
  nextActionId(): number;
  putPending(action: number, write: PendingWrite): void;
  getOutcome(action: number): MutationOutcome<unknown> | undefined;
  hasPending(action: number): boolean;
  registerHook(callback: unknown, queue: RpcStub<ApprovalQueue>): Promise<void>;
}

const WriteOptionsSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  viewerAssertion: z.string().min(1).max(200),
});

const LABELS: Record<MutatingRecordOperation, string> = {
  createIssue: "Create issue",
  editIssue: "Edit issue",
  transitionIssue: "Move issue",
  addComment: "Comment on issue",
};

export const INTENT_FORMAT =
  'SHA-256 hex of canonical JSON (keys sorted, no whitespace, undefined members dropped) of ' +
  '{ v: 1, service: "records", operation, input, key: idempotencyKey }';

function describeWrite(operation: MutatingRecordOperation, input: unknown, viewer: string): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const lines = [`**${viewer}** asked to ${LABELS[operation].toLowerCase()} in this organisation datastore.`];
  if (typeof i.title === "string") lines.push(`\nTitle: ${i.title}`);
  if (typeof i.toState === "string") lines.push(`\nNew state: \`${i.toState}\``);
  if (typeof i.body === "string") lines.push(`\nComment:\n\n> ${i.body.slice(0, 2000).replaceAll("\n", "\n> ")}`);
  if (i.patch && typeof i.patch === "object") lines.push(`\nFields changed: ${Object.keys(i.patch).join(", ")}`);
  lines.push("\nThe change is attributed to them, and checked against their current permissions when applied.");
  return lines.join("\n");
}

export class RecordsSessionImpl extends RpcTarget {
  readonly #host: SessionHost;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(host: SessionHost, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#host = host;
    this.#queue = queue;
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]();
  }

  // ---------------------------------------------------------------------------------------------
  // Reads

  async #observe<T>(title: string, description: string, read: (caller: CallerContext) => Promise<T>): Promise<T> {
    const caller = await this.#host.bindingCaller();
    const result = await read(caller);
    const observers = this.#host.observerPrincipals();
    const readers = await this.#host.service.registry.readersAmong(this.#host.orgId, this.#host.datastoreId, [...new Set(observers.values())]);
    const excludeObservers = [...observers].filter(([, principal]) => !readers.has(principal)).map(([id]) => id);
    await this.#queue.authorizeObservation({ title, description, ...(excludeObservers.length ? { excludeObservers } : {}) });
    return result;
  }

  async describe(): Promise<RecordsBindingInfo> {
    return this.#observe("Describe Records datastore", "Read the datastore's name and this connection's scopes.", async (caller) => {
      const ds = await this.#host.service.registry.getDatastore(caller, this.#host.datastoreId);
      const binding = await this.#host.service.registry.resolveBinding(this.#host.orgId, caller.bindingId!);
      return {
        datastore: { id: ds.id, name: ds.name, description: ds.description, lifecycle: ds.lifecycle },
        moduleId: "projects" as const,
        apiMajor: 1 as const,
        scopes: binding?.scopes ?? [],
      };
    });
  }

  async intentFormat(): Promise<string> {
    return INTENT_FORMAT;
  }

  async listProjects(): Promise<Project[]> {
    return this.#observe("List projects", "Read the projects in this datastore.", (c) => this.#host.service.projects.listProjects(c, this.#host.datastoreId));
  }

  async getWorkflow(): Promise<Workflow> {
    return this.#observe("Read workflow", "Read the issue workflow of this datastore.", (c) => this.#host.service.projects.getWorkflow(c, this.#host.datastoreId));
  }

  async listIssues(input?: unknown): Promise<Page<Issue>> {
    return this.#observe("List issues", "Read a page of issues from this datastore.", (c) => this.#host.service.projects.listIssues(c, this.#host.datastoreId, input ?? {}));
  }

  async getIssue(issueId: string): Promise<Issue> {
    return this.#observe("Read issue", "Read one issue from this datastore.", (c) => this.#host.service.projects.getIssue(c, this.#host.datastoreId, issueId));
  }

  async listAssignees(): Promise<PrincipalRef[]> {
    return this.#observe("List assignable people", "Read the names of the people who can be assigned issues in this datastore.", (c) => this.#host.service.registry.listAssignees(c, this.#host.datastoreId));
  }

  async listComments(input: unknown): Promise<Page<Comment>> {
    return this.#observe("List comments", "Read comments on one issue in this datastore.", (c) => this.#host.service.projects.listComments(c, this.#host.datastoreId, input));
  }

  // ---------------------------------------------------------------------------------------------
  // Writes

  async #write(operation: MutatingRecordOperation, input: unknown, rawOptions: unknown): Promise<MutationOutcome<unknown>> {
    const options = parseInput(WriteOptionsSchema, rawOptions);
    const digest = await intentDigest({ operation, input, idempotencyKey: options.idempotencyKey });
    // Throws unless this exact intent was asserted by an authenticated viewer of this gadget.
    const viewer = await this.#queue.consumeViewerAssertion(options.viewerAssertion, digest);
    const principal = await this.#host.service.registry.resolveIdentity(WORKSHOP_ISSUER, normaliseEmail(viewer.id));
    if (!principal || principal.orgId !== this.#host.orgId) {
      return { status: "rejected", code: "forbidden", message: "You are not in this organisation's Records directory. Ask a data administrator to add you." };
    }
    const binding = await this.#host.bindingCaller();
    const caller: CallerContext = { orgId: this.#host.orgId, principalId: principal.principalId, via: "gadget", bindingId: binding.bindingId };
    try {
      const access = await this.#host.service.registry.checkAccess(caller, this.#host.datastoreId, operation);
      if (access.lifecycle !== "active") return { status: "rejected", code: "datastore_archived", message: "This datastore is archived and read-only." };
    } catch (err) {
      const code = RecordsError.codeOf(err);
      if (code === "forbidden" || code === "not_found") {
        return { status: "rejected", code, message: `${viewer.displayName} may not ${LABELS[operation].toLowerCase()} through this connection.` };
      }
      throw err;
    }

    const action = this.#host.nextActionId();
    this.#host.putPending(action, { operation, input, idempotencyKey: options.idempotencyKey, principalId: principal.principalId, viewerName: viewer.displayName });
    await this.#queue.submitAction(action, {
      title: `${LABELS[operation]} (${viewer.displayName})`,
      description: describeWrite(operation, input, viewer.displayName),
      implementsRevert: false,
      autoApprovable: true,
      actionKind: { tag: `records.${operation}`, label: `Records: ${LABELS[operation].toLowerCase()}` },
    });
    return this.#outcome(action, options.idempotencyKey);
  }

  #outcome(action: number, idempotencyKey: string): MutationOutcome<unknown> {
    const outcome = this.#host.getOutcome(action);
    if (outcome) return outcome;
    return { status: "pending", actionId: action, idempotencyKey };
  }

  createIssue(input: unknown, options: unknown) { return this.#write("createIssue", input, options); }
  editIssue(input: unknown, options: unknown) { return this.#write("editIssue", input, options); }
  transitionIssue(input: unknown, options: unknown) { return this.#write("transitionIssue", input, options); }
  addComment(input: unknown, options: unknown) { return this.#write("addComment", input, options); }

  async getWriteOutcome(actionId: number): Promise<MutationOutcome<unknown>> {
    if (!Number.isSafeInteger(actionId) || actionId < 1) throw new RecordsError("validation_failed", "Unknown action.");
    const outcome = this.#host.getOutcome(actionId);
    if (outcome) return outcome;
    if (this.#host.hasPending(actionId)) return { status: "pending", actionId, idempotencyKey: "" };
    throw new RecordsError("not_found", "Unknown action.");
  }

  async onChange(callback: unknown): Promise<void> {
    await this.#host.registerHook(callback, this.#queue);
  }
}
