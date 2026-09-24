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
//
// Every domain call goes through a DatastoreHandle (../identity/client.ts): the facet mints a
// 60-second, single-use delegated token for the principal the call acts as (the binding owner for
// reads, the verified viewer for writes and sync pushes), and the handle is opened only after the
// ServiceAuthenticator verified that token. This session never builds a CallerContext itself.
//
// Sync (canonical plan §6):
//   syncPush(request, options[])  every mutation carries its own viewer assertion, for the intent
//                                 { operation: name minus "projects.", input: args,
//                                   idempotencyKey: syncIdempotencyKey(clientId, id) }; all must be
//                                 from one viewer. Core push runs with an approval gate: each new
//                                 mutation is checked (fail fast) and submitted to the approval
//                                 queue exactly like a single write. If the Workshop applied it at
//                                 once (a pre-approved kind), the outcome is `applied` with its seq;
//                                 otherwise `pending` with the actionId. Either way the mutation is
//                                 processed (lastMutationId advances) and its outcome saved, so a
//                                 replayed id returns it. The approved command later runs in
//                                 applyAction under the viewer, with the same checks, and arrives
//                                 by pull.
//   syncPull(request)             read as the binding (observed like every read); the group's
//                                 lastMutationIds are those of the viewer who pushed into it
//                                 through this connection (remembered per group in the facet).
//   syncApprovals(actionIds)      approval status for `pending` outcomes.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import {
  IdempotencyKeySchema,
  intentDigest,
  parseInput,
  PullRequestSchema,
  PushRequestSchema,
  RecordsError,
  type Comment,
  type Issue,
  type MutatingRecordOperation,
  type MutationOutcome,
  type Page,
  type PrincipalRef,
  type Project,
  type PullResponse,
  type PushResponse,
  type Workflow,
} from "@records/contracts";
import { z } from "zod";

import { normaliseEmail, PROJECTS_HANDLERS, syncIdempotencyKey, WORKSHOP_ISSUER, type SettledPushOutcome, type SyncGate } from "@records/core";
import type { RecordsService } from "@records/core";
import type { DatastoreHandle } from "../identity/client.js";
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
  /** Identity lookups only (viewer e-mail → principal, before a token is minted). */
  readonly service: RecordsService;
  readonly orgId: string;
  readonly datastoreId: string;
  /**
   * Mint a delegated token through this gadget's binding for `principalId` (default: the binding
   * owner, the person who connected it) and open the datastore with it.
   */
  datastore(principalId?: string): Promise<DatastoreHandle>;
  observerPrincipals(): Map<string, string>;
  nextActionId(): number;
  putPending(action: number, write: PendingWrite): void;
  getOutcome(action: number): MutationOutcome<unknown> | undefined;
  hasPending(action: number): boolean;
  /** The seq an applied action committed at, when known. */
  actionSeq(action: number): number | undefined;
  /** The principal who pushed into a sync client group through this connection, if any. */
  syncGroupOwner(clientGroupId: string): string | undefined;
  claimSyncGroup(clientGroupId: string, principalId: string): void;
  registerHook(callback: unknown, queue: RpcStub<ApprovalQueue>, deliver: "changes" | "pokes"): Promise<void>;
}

export type ApprovalStatus = { actionId: number; status: "pending" | "approved" | "rejected" | "expired"; message?: string };

const ViewerAssertionSchema = z.string().min(1).max(200);

const WriteOptionsSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  viewerAssertion: ViewerAssertionSchema,
});

const SyncWriteOptionsSchema = z.array(z.object({ viewerAssertion: ViewerAssertionSchema })).max(100);

const OnChangeOptionsSchema = z.object({ deliver: z.enum(["changes", "pokes"]).optional() }).optional();

const ActionIdsSchema = z.array(z.number().int().min(1)).max(100);

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

  async #observe<T>(title: string, description: string, read: (datastore: DatastoreHandle) => Promise<T>): Promise<T> {
    const datastore = await this.#host.datastore();
    const result = await read(datastore);
    const observers = this.#host.observerPrincipals();
    const readers = await datastore.readersAmong([...new Set(observers.values())]);
    const excludeObservers = [...observers].filter(([, principal]) => !readers.has(principal)).map(([id]) => id);
    await this.#queue.authorizeObservation({ title, description, ...(excludeObservers.length ? { excludeObservers } : {}) });
    return result;
  }

  async describe(): Promise<RecordsBindingInfo> {
    return this.#observe("Describe Records datastore", "Read the datastore's name and this connection's scopes.", async (d) => {
      const ds = await d.getDatastore();
      const scopes = await d.bindingScopes();
      return {
        datastore: { id: ds.id, name: ds.name, description: ds.description, lifecycle: ds.lifecycle },
        moduleId: "projects" as const,
        apiMajor: 1 as const,
        scopes,
      };
    });
  }

  async intentFormat(): Promise<string> {
    return INTENT_FORMAT;
  }

  async listProjects(): Promise<Project[]> {
    return this.#observe("List projects", "Read the projects in this datastore.", (d) => d.listProjects());
  }

  async getWorkflow(): Promise<Workflow> {
    return this.#observe("Read workflow", "Read the issue workflow of this datastore.", (d) => d.getWorkflow());
  }

  async listIssues(input?: unknown): Promise<Page<Issue>> {
    return this.#observe("List issues", "Read a page of issues from this datastore.", (d) => d.listIssues(input ?? {}));
  }

  async getIssue(issueId: string): Promise<Issue> {
    return this.#observe("Read issue", "Read one issue from this datastore.", (d) => d.getIssue(issueId));
  }

  async listAssignees(): Promise<PrincipalRef[]> {
    return this.#observe("List assignable people", "Read the names of the people who can be assigned issues in this datastore.", (d) => d.listAssignees());
  }

  async listComments(input: unknown): Promise<Page<Comment>> {
    return this.#observe("List comments", "Read comments on one issue in this datastore.", (d) => d.listComments(input));
  }

  // ---------------------------------------------------------------------------------------------
  // Writes

  /** The Records principal of a verified viewer, or a rejection when they have none here. */
  async #viewerPrincipal(viewerId: string): Promise<string | null> {
    const principal = await this.#host.service.registry.resolveIdentity(WORKSHOP_ISSUER, normaliseEmail(viewerId));
    return principal && principal.orgId === this.#host.orgId ? principal.principalId : null;
  }

  /** Fail fast on rights the viewer lacks now (they are checked again when applied). */
  async #precheck(datastore: DatastoreHandle, operation: MutatingRecordOperation, viewerName: string): Promise<{ status: "rejected"; code: string; message: string } | null> {
    try {
      const access = await datastore.checkAccess(operation);
      if (access.lifecycle !== "active") return { status: "rejected", code: "datastore_archived", message: "This datastore is archived and read-only." };
    } catch (err) {
      return refusal(err, operation, viewerName);
    }
    return null;
  }

  /** Queue the write for approval; the Workshop may apply it before this returns. */
  async #submit(operation: MutatingRecordOperation, input: unknown, idempotencyKey: string, principalId: string, viewerName: string): Promise<number> {
    const action = this.#host.nextActionId();
    this.#host.putPending(action, { operation, input, idempotencyKey, principalId, viewerName });
    await this.#queue.submitAction(action, {
      title: `${LABELS[operation]} (${viewerName})`,
      description: describeWrite(operation, input, viewerName),
      implementsRevert: false,
      autoApprovable: true,
      actionKind: { tag: `records.${operation}`, label: `Records: ${LABELS[operation].toLowerCase()}` },
    });
    return action;
  }

  async #write(operation: MutatingRecordOperation, input: unknown, rawOptions: unknown): Promise<MutationOutcome<unknown>> {
    const options = parseInput(WriteOptionsSchema, rawOptions);
    const digest = await intentDigest({ operation, input, idempotencyKey: options.idempotencyKey });
    // Throws unless this exact intent was asserted by an authenticated viewer of this gadget.
    const viewer = await this.#queue.consumeViewerAssertion(options.viewerAssertion, digest);
    const principalId = await this.#viewerPrincipal(viewer.id);
    if (!principalId) {
      return { status: "rejected", code: "forbidden", message: "You are not in this organisation's Records directory. Ask a data administrator to add you." };
    }
    // The viewer's delegated token: their rights ∩ the binding's scopes. A revoked binding or an
    // inactive viewer is this write's rejection, as when the precheck refuses it.
    let datastore: DatastoreHandle;
    try {
      datastore = await this.#host.datastore(principalId);
    } catch (err) {
      return refusal(err, operation, viewer.displayName);
    }
    const refused = await this.#precheck(datastore, operation, viewer.displayName);
    if (refused) return refused;
    const action = await this.#submit(operation, input, options.idempotencyKey, principalId, viewer.displayName);
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

  async onChange(callback: unknown, options?: unknown): Promise<void> {
    const parsed = parseInput(OnChangeOptionsSchema, options);
    await this.#host.registerHook(callback, this.#queue, parsed?.deliver ?? "changes");
  }

  // ---------------------------------------------------------------------------------------------
  // Sync

  async syncPush(rawRequest: unknown, rawOptions: unknown): Promise<PushResponse> {
    const request = parseInput(PushRequestSchema, rawRequest);
    const options = parseInput(SyncWriteOptionsSchema, rawOptions);
    if (options.length !== request.mutations.length) {
      throw new RecordsError("validation_failed", "Send one viewer assertion per mutation, in the same order.");
    }
    // Redeem every assertion first: one push speaks for one viewer.
    let viewer: { id: string; displayName: string } | undefined;
    for (const [i, m] of request.mutations.entries()) {
      const digest = await intentDigest({ operation: operationOf(m.name), input: m.args, idempotencyKey: syncIdempotencyKey(request.clientId, m.id) });
      const v = await this.#queue.consumeViewerAssertion(options[i]!.viewerAssertion, digest);
      if (viewer && v.id !== viewer.id) throw new RecordsError("validation_failed", "Every mutation in one push must come from the same viewer.");
      viewer = v;
    }
    const who = viewer!;
    const principalId = await this.#viewerPrincipal(who.id);
    if (!principalId) throw new RecordsError("forbidden", "You are not in this organisation's Records directory. Ask a data administrator to add you.");
    const owner = this.#host.syncGroupOwner(request.clientGroupId);
    if (owner !== undefined && owner !== principalId) throw new RecordsError("forbidden", "This sync client group belongs to another viewer; start a new one.");
    this.#host.claimSyncGroup(request.clientGroupId, principalId);
    const datastore = await this.#host.datastore(principalId);

    const gate: SyncGate = async (m, { idempotencyKey }) => {
      const operation = operationOf(m.name);
      // Malformed args are this mutation's rejection (validation_failed), not an approver's problem.
      // Thrown RecordsErrors become the outcome; the command checks everything again when applied.
      PROJECTS_HANDLERS[m.name].parse(m.args);
      const refused = await this.#precheck(datastore, operation, who.displayName);
      if (refused) return { kind: "settled", outcome: refused };
      const action = await this.#submit(operation, m.args, idempotencyKey, principalId, who.displayName);
      return { kind: "settled", outcome: this.#pushOutcome(action) };
    };
    return datastore.syncPush(request, { gate, via: "gadget" });
  }

  #pushOutcome(action: number): SettledPushOutcome {
    const outcome = this.#host.getOutcome(action);
    if (!outcome || outcome.status === "pending") return { status: "pending", actionId: action };
    if (outcome.status === "applied") return { status: "applied", seq: this.#host.actionSeq(action) ?? 0 };
    return outcome;
  }

  async syncPull(rawRequest: unknown): Promise<PullResponse> {
    const request = parseInput(PullRequestSchema, rawRequest);
    const owner = this.#host.syncGroupOwner(request.clientGroupId);
    return this.#observe("Sync records", "Read the records in this datastore that changed since the gadget last synced.", (d) =>
      d.syncPull(request, { clientsOf: owner ?? null }));
  }

  async syncApprovals(rawActionIds: unknown): Promise<ApprovalStatus[]> {
    const ids = parseInput(ActionIdsSchema, rawActionIds);
    return ids.map((actionId): ApprovalStatus => {
      const outcome = this.#host.getOutcome(actionId);
      if (!outcome) return this.#host.hasPending(actionId) ? { actionId, status: "pending" } : { actionId, status: "expired" };
      if (outcome.status === "applied") return { actionId, status: "approved" };
      if (outcome.status === "pending") return { actionId, status: "pending" };
      return { actionId, status: "rejected", message: outcome.message };
    });
  }
}

/** A forbidden or not_found refusal as a rejected outcome; anything else is rethrown. */
function refusal(err: unknown, operation: MutatingRecordOperation, viewerName: string): { status: "rejected"; code: string; message: string } {
  const code = RecordsError.codeOf(err);
  if (code === "forbidden" || code === "not_found") {
    return { status: "rejected", code, message: `${viewerName} may not ${LABELS[operation].toLowerCase()} through this connection.` };
  }
  throw err;
}

function operationOf(name: string): MutatingRecordOperation {
  return name.slice("projects.".length) as MutatingRecordOperation;
}
