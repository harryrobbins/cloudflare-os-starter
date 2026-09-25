import { intentDigest, type CommandIntent } from './approved-command.ts';
import { RecordsError, type RecordsClient, type BlueprintRequirement } from './client.ts';

/** Kernel viewer assertions use the raw lowercase SHA-256 hex digest. */
export async function recordsOsIntentDigest(intent: CommandIntent): Promise<string> { return (await intentDigest(intent)).slice('sha256:'.length); }

/** Structural subset of cloudflare-os workshop-shared ApprovalQueue. No gadget receives this capability. */
export interface RecordsApprovalQueue {
  consumeViewerAssertion(assertion: string, intentHash: string): Promise<{ id: string; displayName: string }>;
  authorizeObservation(description: { title: string; description: string; excludeObservers?: string[] }): Promise<void>;
  submitAction(action: number, description: { title: string; description: string; implementsRevert: boolean; awaitDecision?: boolean; actionKind?: { tag: string; label: string } }): Promise<void>;
}
export type CommandOutcome = { status: 'pending'; actionId: number } | { status: 'applied'; result: unknown } | { status: 'rejected'; reason: string };
export interface StoredAction {
  intent: CommandIntent; digest: string; viewerId: string; principal: string; outcome?: Exclude<CommandOutcome, { status: 'pending' }>;
}
/** Required durable host storage. allocate is atomic and persists BEFORE returning; settle is atomic. */
export interface PendingActionStore {
  allocate(action: StoredAction): Promise<number>;
  get(id: number): Promise<StoredAction | undefined>;
  settle(id: number, outcome: Exclude<CommandOutcome, { status: 'pending' }>): Promise<void>;
}
type Client = Pick<RecordsClient, 'describe' | 'records' | 'snapshot' | 'changes' | 'command' | 'bind'>;
export interface RecordsOsHost {
  datastore: string; binding: string; requirement: BlueprintRequirement;
  queue: RecordsApprovalQueue;
  pending: PendingActionStore;
  /** Mint/resolve current binding credentials on every call; never pass credentials to gadget RPC. */
  readClient(): Promise<Client>;
  /** Resolve enrolled viewer identity to current Records principal and per-viewer binding credentials. */
  resolveViewer(viewerId: string): Promise<{ principal: string; client: Client } | null>;
  /** Persisted observers previously verified by the host's addObserver path. */
  observers(): Promise<{ observerId: string; principal: string }[]>;
  canRead(principal: string): Promise<boolean>;
}

/** Reusable queue adapter. Host registers session methods separately from trusted apply/reject callbacks. */
export class RecordsOsBridge {
  #host: RecordsOsHost;
  constructor(host: RecordsOsHost) { this.#host = host; }
  async #observe<T>(title: string, read: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.#host.readClient();
    await client.bind(this.#host.requirement);
    const result = await read(client);
    const observers = await this.#host.observers();
    const permissions = await Promise.all(observers.map(async observer => ({ ...observer, allowed: await this.#host.canRead(observer.principal) })));
    await this.#host.queue.authorizeObservation({ title, description: `${title} from the ${this.#host.requirement.moduleId} datastore.`, excludeObservers: permissions.filter(observer => !observer.allowed).map(observer => observer.observerId) });
    return result;
  }
  /** Only this object is exposed as the gadget session. applyAction/rejectAction remain host capabilities. */
  session() {
    const host = this.#host;
    return {
      describe: () => this.#observe('Describe Records datastore', client => client.describe()),
      records: (query?: { entity?: string; id?: string; after?: string; limit?: number }) => this.#observe('Read Records records', client => client.records(host.requirement.moduleId, host.requirement.apiMajor, query)),
      snapshot: (limit?: number) => this.#observe('Snapshot Records datastore', client => client.snapshot(host.requirement.moduleId, host.requirement.apiMajor, limit)),
      changes: (after?: number, epoch?: number) => this.#observe('Read Records changes', client => client.changes(after, epoch)),
      command: (command: string, input: unknown, options: { viewerAssertion: string; idempotencyKey: string; revision?: number }) => this.#submit(command, input, options),
      getOutcome: (action: number) => this.#observe('Read Records command outcome', async () => {
        const pending = await host.pending.get(action);
        if (!pending) throw new Error('Unknown Records action');
        return pending.outcome ?? { status: 'pending', actionId: action } as CommandOutcome;
      }),
    };
  }
  async #submit(command: string, input: unknown, options: { viewerAssertion: string; idempotencyKey: string; revision?: number }): Promise<CommandOutcome> {
    const host = this.#host;
    if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(command) || !/^[\x21-\x7e]{1,128}$/.test(options.idempotencyKey) || !options.viewerAssertion || (options.revision !== undefined && (!Number.isSafeInteger(options.revision) || options.revision < 1))) throw new Error('Invalid command intent');
    const intent: CommandIntent = { datastore: host.datastore, binding: host.binding, moduleId: host.requirement.moduleId, apiMajor: host.requirement.apiMajor, command, input, expectedRevision: options.revision ?? null, idempotencyKey: options.idempotencyKey };
    // Snapshot before hashing or asynchronous approval; the original input is app-owned.
    const snapshot: CommandIntent = structuredClone(intent);
    const digest = await recordsOsIntentDigest(snapshot);
    const viewer = await host.queue.consumeViewerAssertion(options.viewerAssertion, digest);
    const identity = await host.resolveViewer(viewer.id);
    if (!identity) throw new Error('Viewer is not authorised for this binding');
    await identity.client.bind(host.requirement);
    const action = await host.pending.allocate({ intent: snapshot, digest, viewerId: viewer.id, principal: identity.principal });
    await host.queue.submitAction(action, {
      title: `Records: ${command} (${viewer.displayName})`,
      description: `Apply this exact command as ${viewer.displayName}.\n\n${JSON.stringify(snapshot, null, 2)}`,
      implementsRevert: false, awaitDecision: true, actionKind: { tag: `records.${host.requirement.moduleId}.${command}`, label: `Records: ${command}` },
    });
    return { status: 'pending', actionId: action };
  }
  /** Called ONLY by the host Gatekeeper applyAction callback after kernel approval. */
  async applyAction(action: number): Promise<void> {
    const host = this.#host;
    const pending = await host.pending.get(action);
    if (!pending) throw new Error('Unknown Records action');
    if (pending.outcome) return;
    if (pending.intent.datastore !== host.datastore || pending.intent.binding !== host.binding || pending.intent.moduleId !== host.requirement.moduleId || pending.intent.apiMajor !== host.requirement.apiMajor || await recordsOsIntentDigest(pending.intent) !== pending.digest) throw new Error('Stored command intent does not match approval');
    const identity = await host.resolveViewer(pending.viewerId);
    if (!identity || identity.principal !== pending.principal) {
      await host.pending.settle(action, { status: 'rejected', reason: 'Viewer authority was revoked or changed' });
      throw new Error('Viewer authority was revoked or changed');
    }
    try {
      await identity.client.bind(host.requirement);
      const result = await identity.client.command(pending.intent.moduleId, pending.intent.apiMajor, pending.intent.command, pending.intent.input, { idempotencyKey: pending.intent.idempotencyKey, ...(pending.intent.expectedRevision === null ? {} : { revision: pending.intent.expectedRevision }) });
      await host.pending.settle(action, { status: 'applied', result });
    } catch (error) {
      // Transient/ambiguous failures remain pending and retry the identical persisted key and body.
      if (error instanceof RecordsError && error.status >= 400 && error.status < 500 && error.status !== 429) await host.pending.settle(action, { status: 'rejected', reason: `Records refused the command (${error.status})` });
      throw error;
    }
  }
  async rejectAction(action: number): Promise<void> {
    const pending = await this.#host.pending.get(action);
    if (!pending) throw new Error('Unknown Records action');
    if (!pending.outcome) await this.#host.pending.settle(action, { status: 'rejected', reason: 'Approval was denied' });
  }
}
