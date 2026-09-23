// `RecordsGatekeeper`: the Durable Object facet for one gadget binding to one datastore.
//
// Props are imbued by `RecordsAccount.getGatekeeperClassFor()`: the connecting person's
// organisation and principal (from the Access-verified connect flow), the connector account ID,
// and the requested datastore and scopes. The facet's own storage holds only the Records binding
// ID, its verified observers and its submitted actions; business data lives in Postgres.

import { DurableObject, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type {
  ActionKind,
  AgentCatalog,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperUserVerifier,
  ObservationAuthorizer,
  ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { boundAgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import {
  MUTATING_RECORD_OPERATIONS,
  RecordsError,
  type CallerContext,
  type MutationOutcome,
  type RecordScope,
} from "@records/contracts";

import type { RecordsService } from "../domain/service.js";
import { recordsService } from "../runtime.js";
import { datastoreUrl } from "./resource.js";
import { RecordsSessionImpl, type PendingWrite, type SessionHost } from "./session.js";
import TYPES_CODE from "./types-code.js";
import type { RecordsSession } from "./types.js";
import type { VerifiedIdentity } from "./verifier.js";

export type RecordsGatekeeperProps = {
  accountId: string;
  orgId: string;
  principalId: string;
  datastoreId: string;
  scopes: RecordScope[];
};

type StoredObserver = { principalId: string };

const LABELS: Record<string, string> = {
  createIssue: "create issues",
  editIssue: "edit issues",
  transitionIssue: "move issues",
  addComment: "comment on issues",
};

@validateRpc()
export class RecordsGatekeeper
  extends DurableObject<Cloudflare.Env, RecordsGatekeeperProps>
  implements Gatekeeper<RecordsSession>
{
  #service?: RecordsService;

  get #records(): RecordsService {
    return (this.#service ??= recordsService(this.env));
  }

  /** Describes the datastore, confirming the connecting person can read it before anything is granted. */
  async describe(): Promise<ResourceDescription> {
    const { orgId, principalId, datastoreId, scopes } = this.ctx.props;
    const caller: CallerContext = { orgId, principalId, via: "gadget" };
    const ds = await this.#records.registry.getDatastore(caller, datastoreId);
    const writes = scopes.filter((s) => !s.endsWith(".read"));
    return {
      url: datastoreUrl(datastoreId, scopes),
      title: ds.name,
      snippet: writes.length
        ? `Read and change records in "${ds.name}" (${writes.join(", ")}), as whoever uses the gadget.`
        : `Read records in "${ds.name}".`,
      suggestedBindingName: "RECORDS",
      tsType: "RecordsSession",
      hookTsType: "RecordsChangeHook",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Every write kind may be pre-approved per binding; the service still enforces permissions. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return MUTATING_RECORD_OPERATIONS.map((op) => ({ tag: `records.${op}`, label: `Records: ${LABELS[op]}` }));
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<RecordsSession> {
    await this.#ensureBinding();
    return new RecordsSessionImpl(this.#host(), approvalQueue.dup()) as unknown as RecordsSession;
  }

  /** The projects in the bound datastore, so an agent knows what it can read. */
  async getAgentCatalog(authorizer: RpcStub<ObservationAuthorizer>): Promise<AgentCatalog | null> {
    const caller = await this.#bindingCaller();
    const projects = await this.#records.projects.listProjects(caller, this.ctx.props.datastoreId);
    await authorizer.authorizeObservation({
      title: "List Records projects",
      description: `Read the names of ${projects.length} project(s) in the bound datastore.`,
    });
    return boundAgentCatalog(projects.slice(0, 50).map((p) => ({ id: p.id, title: `${p.key} — ${p.name}`, description: p.description || `Project ${p.key}` })));
  }

  /**
   * A new viewer may see everything this gadget has read. Allowed only if they are a current
   * member of the datastore with read access, in the same organisation. A share link alone is
   * never enough. Re-run by the Workshop to catch revocations.
   */
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    const identity = await (user as unknown as { identity(): Promise<VerifiedIdentity> }).identity();
    if (identity.orgId !== this.ctx.props.orgId) throw new Error("That person is not in this datastore's organisation.");
    try {
      await this.#records.registry.checkAccess({ orgId: identity.orgId, principalId: identity.principalId, via: "gadget" }, this.ctx.props.datastoreId, "listIssues");
    } catch {
      throw new Error("That person cannot read this organisation datastore. Ask its owner to add them as a member first.");
    }
    this.ctx.storage.kv.put<StoredObserver>(`observer:${id}`, { principalId: identity.principalId });
  }

  async removeObserver(id: string): Promise<void> {
    this.ctx.storage.kv.delete(`observer:${id}`);
  }

  /** Apply an approved write as the viewer who asked, re-authorising against current state. */
  async applyAction(action: number): Promise<void> {
    const pending = this.ctx.storage.kv.get<PendingWrite>(`pending:${action}`);
    if (!pending) {
      if (this.ctx.storage.kv.get(`outcome:${action}`)) return;
      throw new Error("This Records action is no longer available.");
    }
    const binding = await this.#bindingCaller();
    const caller: CallerContext = { orgId: this.ctx.props.orgId, principalId: pending.principalId, via: "gadget", bindingId: binding.bindingId };
    const ds = this.ctx.props.datastoreId;
    let outcome: MutationOutcome<unknown>;
    try {
      const projects = this.#records.projects;
      const result =
        pending.operation === "createIssue" ? await projects.createIssue(caller, ds, pending.input, pending.idempotencyKey)
        : pending.operation === "editIssue" ? await projects.editIssue(caller, ds, pending.input, pending.idempotencyKey)
        : pending.operation === "transitionIssue" ? await projects.transitionIssue(caller, ds, pending.input, pending.idempotencyKey)
        : await projects.addComment(caller, ds, pending.input, pending.idempotencyKey);
      outcome = { status: "applied", record: result.record, replayed: result.replayed };
    } catch (err) {
      const code = RecordsError.codeOf(err);
      // Transient failures stay pending so the approver can retry.
      if (!code || code === "unavailable" || code === "internal") throw err;
      const message = err instanceof RecordsError ? err.detail : String(err);
      outcome = code === "revision_conflict" || code === "workflow_conflict"
        ? { status: "conflict", code, message, ...(err instanceof RecordsError && err.currentRevision !== undefined ? { currentRevision: err.currentRevision } : {}) }
        : { status: "rejected", code, message };
      this.#settle(action, outcome);
      throw err;
    }
    this.#settle(action, outcome);
    this.ctx.waitUntil(this.#kickPublisher());
  }

  async rejectAction(action: number): Promise<void> {
    if (this.ctx.storage.kv.get(`pending:${action}`)) {
      this.#settle(action, { status: "rejected", code: "rejected_by_approver", message: "The change was not approved." });
    }
  }

  /** Records changes are not reverted automatically; make a compensating change instead. */
  async revertAction(_action: number): Promise<{ message: string; canRetry: boolean }> {
    return { message: "Records changes are not reverted automatically. Make a new change to undo it; the history keeps both.", canRetry: false };
  }

  // ---------------------------------------------------------------------------------------------

  #settle(action: number, outcome: MutationOutcome<unknown>): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.kv.delete(`pending:${action}`);
      this.ctx.storage.kv.put(`outcome:${action}`, outcome);
      // Keep a bounded outcome window for polling clients.
      this.ctx.storage.kv.delete(`outcome:${action - 256}`);
    });
  }

  async #kickPublisher(): Promise<void> {
    try {
      await this.ctx.exports.default.publishNow();
    } catch {
      // The cron backstop publishes anything left pending.
    }
  }

  #binding?: Promise<string>;

  /**
   * Create the Records binding on first use (after the Workshop committed the connection).
   * Concurrent first calls share one promise; a failure is not cached, so a later call retries.
   * (Not blockConcurrencyWhile: a rejection there resets the object, and this waits on the network.)
   */
  #ensureBinding(): Promise<string> {
    const existing = this.ctx.storage.kv.get<string>("binding");
    if (existing) return Promise.resolve(existing);
    this.#binding ??= (async () => {
      const { orgId, principalId, datastoreId, scopes, accountId } = this.ctx.props;
      const binding = await this.#records.registry.createGadgetBinding(
        { orgId, principalId, via: "gadget" }, datastoreId, { label: "Gadget connection", scopes }, accountId);
      this.ctx.storage.kv.put("binding", binding.id);
      return binding.id;
    })().finally(() => {
      this.#binding = undefined;
    });
    return this.#binding;
  }

  async #bindingCaller(): Promise<CallerContext> {
    const bindingId = await this.#ensureBinding();
    return { orgId: this.ctx.props.orgId, principalId: this.ctx.props.principalId, via: "gadget", bindingId };
  }

  #host(): SessionHost {
    const kv = this.ctx.storage.kv;
    return {
      service: this.#records,
      orgId: this.ctx.props.orgId,
      datastoreId: this.ctx.props.datastoreId,
      bindingCaller: () => this.#bindingCaller(),
      observerPrincipals: () => {
        const out = new Map<string, string>();
        for (const [key, value] of kv.list<StoredObserver>({ prefix: "observer:" })) out.set(key.slice("observer:".length), value.principalId);
        return out;
      },
      nextActionId: () => {
        const next = (kv.get<number>("counter:action") ?? 0) + 1;
        kv.put("counter:action", next);
        return next;
      },
      putPending: (action, write) => kv.put(`pending:${action}`, write),
      getOutcome: (action) => kv.get<MutationOutcome<unknown>>(`outcome:${action}`),
      hasPending: (action) => kv.get(`pending:${action}`) !== undefined,
      registerHook: async (callback, queue) => {
        const bindingId = await this.#ensureBinding();
        const controller = this.ctx.exports.RecordsHookController({
          props: { orgId: this.ctx.props.orgId, datastoreId: this.ctx.props.datastoreId, bindingId },
        });
        await queue.bindHook(controller as never, callback as never, {
          title: "Records change notifications",
          description: "Tell this gadget when issues, comments or projects change in its organisation datastore (identifiers only; it refetches through its own connection).",
        });
      },
    };
  }
}
