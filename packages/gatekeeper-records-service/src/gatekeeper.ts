// `RecordsServiceGatekeeper`: the Durable Object facet for one gadget binding to one Records
// service datastore. Its storage holds only this connection's binding ID, verified observers and
// submitted actions; records live in the Records service.
//
// Reads go through the RecordsOsBridge's observed session (every read is authorised as an
// observation first). Writes are exact-intent commands: the gadget sends a one-use viewer
// assertion for the SHA-256 of the complete intent, the bridge persists the pending intent and
// submits an action, and only this facet's applyAction(), called by the Workshop after approval,
// sends the command to Records.

import { DurableObject, RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import { approvedDatastores, parseDatastoreUrl, scopesFor, serviceUrl, type ApprovedDatastore, type DatastoreResource } from "./config.js";
import { TYPES_CODE } from "./generated.js";
import {
  addObserver, bindingId, fetchModel, NO_QUEUE, pendingStore, queueAdapter, RecordsClient, RecordsOsBridge, recordsFailure, recordsHost, removeObserver,
  SessionCore, type SyncStorage, type WorkshopQueue,
} from "./host.js";
import type {
  RecordsChanges, RecordsCommandOutcome, RecordsConnection, RecordsDatastoreDescription, RecordsModel, RecordsPage, RecordsServiceSession, RecordsSnapshot,
} from "./types.js";

export type GatekeeperProps = { resourceUrl: string };

export interface RecordsServiceVerifierApi extends GatekeeperUserVerifier {
  recordsServiceMember(): Promise<true>;
}

/** Everything the facet and the account share: the approved datastore list and service origin. */
export function deployment(env: Cloudflare.Env): { url: string; find(id: string): ApprovedDatastore | undefined; all: ApprovedDatastore[] } {
  const all = approvedDatastores(env.RECORDS_SERVICE_DATASTORES);
  return { url: serviceUrl(env.RECORDS_SERVICE_URL), all, find: (id) => all.find((entry) => entry.id === id) };
}

/** The describe() of an approved datastore, through its own credential. */
export async function describeApproved(url: string, datastore: ApprovedDatastore): Promise<RecordsDatastoreDescription> {
  return await new RecordsClient({ url, datastore: datastore.id, token: () => datastore.key }).describe() as unknown as RecordsDatastoreDescription;
}

@validateRpc()
export class RecordsServiceGatekeeper extends DurableObject<Cloudflare.Env, GatekeeperProps> implements Gatekeeper<RecordsServiceSession> {
  #model?: Promise<RecordsModel>;

  #resource(): DatastoreResource { return parseDatastoreUrl(this.ctx.props.resourceUrl); }

  get #storage(): SyncStorage { return this.ctx.storage as unknown as SyncStorage; }

  #bridge(queue: WorkshopQueue | null): { bridge: RecordsOsBridge; resource: DatastoreResource; label: string } {
    const resource = this.#resource();
    const config = deployment(this.env);
    const label = config.find(resource.datastore)?.label ?? "Records";
    const pending = pendingStore(this.#storage);
    const host = recordsHost({
      serviceUrl: config.url, resource, storage: this.#storage,
      datastore: () => deployment(this.env).find(resource.datastore),
      queue: queue ? queueAdapter(queue, pending, label) : NO_QUEUE,
    });
    return { bridge: new RecordsOsBridge(host), resource, label };
  }

  /** Checks the datastore is approved and satisfies this connection before anything is granted. */
  async describe(): Promise<ResourceDescription> {
    const resource = this.#resource();
    const config = deployment(this.env);
    const approved = config.find(resource.datastore);
    if (!approved) throw new Error("This datastore is not approved for Cloudflare OS. Ask the deployment operator to add it.");
    let description: RecordsDatastoreDescription;
    try { description = await describeApproved(config.url, approved); } catch (error) { throw recordsFailure(error); }
    const module = description.modules.find((candidate) => candidate.id === resource.moduleId && candidate.api_majors.includes(resource.apiMajor));
    const scopes = scopesFor(resource.moduleId, resource.access);
    if (!module || scopes.some((scope) => !description.granted_scopes.includes(scope))) {
      throw new Error(`"${approved.label}" does not offer ${resource.moduleId} v${resource.apiMajor} with ${scopes.join(", ")}.`);
    }
    return {
      url: resource.url,
      title: `${approved.label} (${resource.moduleId} v${resource.apiMajor})`,
      snippet: resource.access === "write"
        ? `Read ${resource.moduleId} records in "${approved.label}", and request changes that are applied after approval, as the person who asked.`
        : `Read ${resource.moduleId} records in "${approved.label}".`,
      suggestedBindingName: "RECORDS",
      tsType: "RecordsServiceSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }

  /** Each module command may be pre-approved per binding; the service still checks every change. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    const resource = this.#resource();
    if (resource.access !== "write") return [];
    const config = deployment(this.env);
    const approved = config.find(resource.datastore);
    if (!approved) return [];
    const description = await describeApproved(config.url, approved).catch(() => null);
    const commands = description?.modules.find((module) => module.id === resource.moduleId)?.commands ?? [];
    return commands.map((command) => ({ tag: `records.${resource.moduleId}.${command}`, label: `Records: ${command}` }));
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<RecordsServiceSession> {
    const queue = approvalQueue.dup();
    const { bridge, resource, label } = this.#bridge(queue as unknown as WorkshopQueue);
    const connection: RecordsConnection = {
      url: resource.url, datastore: resource.datastore, binding: bindingId(this.#storage), label,
      moduleId: resource.moduleId, apiMajor: resource.apiMajor, access: resource.access, scopes: scopesFor(resource.moduleId, resource.access),
    };
    const model = () => (this.#model ??= fetchModel(deployment(this.env).url, resource.moduleId, resource.apiMajor).catch((error) => {
      this.#model = undefined;
      throw error;
    }));
    return new RecordsServiceSessionImpl(new SessionCore(bridge, connection, model), queue) as unknown as RecordsServiceSession;
  }

  /**
   * Every Cloudflare OS member with a Records service account may observe approved datastores
   * (the service has no per-person memberships yet). The verifier proves the account is ours.
   */
  async addObserver(id: string, verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await (verifier as unknown as RecordsServiceVerifierApi).recordsServiceMember();
    if (!deployment(this.env).find(this.#resource().datastore)) throw new Error("This datastore is no longer approved for Cloudflare OS.");
    addObserver(this.#storage, id);
  }

  async removeObserver(id: string): Promise<void> { removeObserver(this.#storage, id); }

  /** Apply an approved command, re-checking the connection and datastore approval now. */
  async applyAction(action: number): Promise<void> {
    try { await this.#bridge(null).bridge.applyAction(action); } catch (error) { throw recordsFailure(error, "command"); }
  }

  async rejectAction(action: number): Promise<void> {
    await this.#bridge(null).bridge.rejectAction(action).catch(() => {});
  }

  async revertAction(_action: number): Promise<{ message: string; canRetry: boolean }> {
    return { message: "Records changes are not reverted automatically. Make a new change to undo it; the journal keeps both.", canRetry: false };
  }
}

/** The gadget-facing RPC surface. It exposes no credentials and no apply/reject capability. */
export class RecordsServiceSessionImpl extends RpcTarget {
  readonly #core: SessionCore;
  readonly #queue: { [Symbol.dispose](): void };

  constructor(core: SessionCore, queue: { [Symbol.dispose](): void }) {
    super();
    this.#core = core;
    this.#queue = queue;
  }

  connection(): Promise<RecordsConnection> { return this.#core.connection(); }
  describe(): Promise<RecordsDatastoreDescription> { return this.#core.describe() as unknown as Promise<RecordsDatastoreDescription>; }
  model(): Promise<RecordsModel> { return this.#core.model(); }
  records(query?: unknown): Promise<RecordsPage> { return this.#core.records(query) as Promise<RecordsPage>; }
  snapshot(limit?: unknown): Promise<RecordsSnapshot> { return this.#core.snapshot(limit) as unknown as Promise<RecordsSnapshot>; }
  changes(after?: unknown, epoch?: unknown): Promise<RecordsChanges> { return this.#core.changes(after, epoch) as unknown as Promise<RecordsChanges>; }
  command(command: unknown, input: unknown, options: unknown): Promise<RecordsCommandOutcome> { return this.#core.command(command, input, options); }
  getOutcome(actionId: unknown): Promise<RecordsCommandOutcome> { return this.#core.getOutcome(actionId); }
  [Symbol.dispose](): void { this.#queue[Symbol.dispose](); }
}
