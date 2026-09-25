// The Cloudflare OS host for the Records service's own RecordsOsBridge
// (packages/records-service/src/cloudflare-os.ts), kept free of `cloudflare:workers` so it runs
// under Node tests.
//
// What the bridge needs and where it comes from here:
//   readClient / resolveViewer  a RecordsClient holding the operator-approved datastore credential
//                               from the Worker secret. The credential is the datastore's service
//                               binding, narrowed by this connection's module/API major/scopes.
//                               The service has no per-person principals yet, so every approved
//                               write runs as that binding; the viewer who asked is established by
//                               the Workshop's one-use viewer assertion and recorded on the action.
//   pending                     the gatekeeper facet's Durable Object storage (atomic allocate).
//   queue                       the session's ApprovalQueue, via an adapter that writes a readable
//                               approval description and lets the owner opt into auto-approval.
//   observers / canRead         observers verified by addObserver(); all Workshop members may read
//                               approved datastores today (see README, "Who can read").

import { RecordsError, RecordsClient } from "@records/service/src/client.ts";
import { RecordsOsBridge, type CommandOutcome, type PendingActionStore, type RecordsApprovalQueue, type RecordsOsHost, type StoredAction } from "@records/service/src/cloudflare-os.ts";
import { scopesFor, type ApprovedDatastore, type DatastoreResource } from "./config.js";
import type { RecordsCommandOutcome, RecordsConnection, RecordsModel, RecordsQuery } from "./types.js";

/** The subset of Durable Object storage the host uses (synchronous SQLite-backed KV). */
export interface SyncStorage {
  kv: {
    get<T>(key: string): T | undefined;
    put<T>(key: string, value: T): void;
    delete(key: string): boolean;
    list<T>(options: { prefix: string }): Iterable<[string, T]>;
  };
  transactionSync<T>(fn: () => T): T;
}

/** The ApprovalQueue members a session uses (structural, so tests can supply a double). */
export interface WorkshopQueue {
  consumeViewerAssertion(assertion: string, intentHash: string): Promise<{ id: string; displayName: string }>;
  authorizeObservation(description: { title: string; description: string; excludeObservers?: string[] }): Promise<void>;
  submitAction(action: number, description: {
    title: string; description: string; implementsRevert: boolean; awaitDecision?: boolean; autoApprovable?: boolean;
    actionKind?: { tag: string; label: string };
  }): Promise<void>;
}

const ACTION_RETENTION = 1000;
const MAX_MODEL_BYTES = 256 * 1024;
const MAX_MODEL_ENTITIES = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTITY = /^[a-z][a-z0-9_]{0,62}$/;

/** Durable pending actions: allocate persists before returning; settle is atomic. */
export function pendingStore(storage: SyncStorage): PendingActionStore {
  const key = (id: number) => `action:${id}`;
  return {
    async allocate(action: StoredAction): Promise<number> {
      return storage.transactionSync(() => {
        const id = (storage.kv.get<number>("counter:action") ?? 0) + 1;
        storage.kv.put("counter:action", id);
        storage.kv.put(key(id), action);
        // Bounded history: forget old actions once settled (pending ones are kept).
        const old = storage.kv.get<StoredAction>(key(id - ACTION_RETENTION));
        if (old?.outcome) storage.kv.delete(key(id - ACTION_RETENTION));
        return id;
      });
    },
    async get(id: number) { return storage.kv.get<StoredAction>(key(id)); },
    async settle(id: number, outcome) {
      storage.transactionSync(() => {
        const stored = storage.kv.get<StoredAction>(key(id));
        if (stored && !stored.outcome) storage.kv.put(key(id), { ...stored, outcome });
      });
    },
  };
}

/** A stable identifier for this gadget connection, created on first use. */
export function bindingId(storage: SyncStorage): string {
  return storage.transactionSync(() => {
    let id = storage.kv.get<string>("binding");
    if (!id) { id = crypto.randomUUID(); storage.kv.put("binding", id); }
    return id;
  });
}

export function observerPrincipal(): string { return "cloudflare-os-member"; }

export function addObserver(storage: SyncStorage, id: string): void {
  storage.kv.put(`observer:${id}`, { principal: observerPrincipal() });
}

export function removeObserver(storage: SyncStorage, id: string): void { storage.kv.delete(`observer:${id}`); }

const clip = (value: unknown, max: number) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** Human description of one stored command, shown in the Workshop's approval UI. */
export function describeAction(stored: StoredAction, label: string): string {
  const { intent } = stored;
  const input = (intent.input && typeof intent.input === "object" ? intent.input : {}) as Record<string, unknown>;
  const lines = [`**${stored.viewerId}** asked to run \`${intent.command}\` on the **${label}** Records datastore.`];
  if (typeof input.id === "string") lines.push(`\nRecord: \`${input.id}\` (revision ${intent.expectedRevision ?? "new"})`);
  for (const [name, value] of Object.entries(input)) {
    if (name === "id") continue;
    lines.push(`\n${name}: ${clip(value, 400).replaceAll("\n", " ")}`);
  }
  lines.push("\nThe exact request is fixed: it cannot change after approval, and applying it twice changes nothing.");
  lines.push(`\n\`\`\`json\n${clip(JSON.stringify(intent, null, 2), 4000)}\n\`\`\``);
  return lines.join("\n");
}

/** The bridge's queue: forwards to the Workshop, with a readable description and auto-approval opt-in. */
export function queueAdapter(queue: WorkshopQueue, pending: PendingActionStore, label: string): RecordsApprovalQueue {
  return {
    consumeViewerAssertion: (assertion, intentHash) => queue.consumeViewerAssertion(assertion, intentHash),
    authorizeObservation: (description) => queue.authorizeObservation(description),
    async submitAction(action, description) {
      const stored = await pending.get(action);
      await queue.submitAction(action, {
        ...description,
        ...(stored ? { description: describeAction(stored, label) } : {}),
        // The owner can opt a command kind into auto-approval; each change is one record, checked
        // against its revision, and never deletes anything.
        autoApprovable: true,
      });
    },
  };
}

/** A queue for trusted callbacks (apply/reject) that never touch the Workshop. */
export const NO_QUEUE: RecordsApprovalQueue = {
  consumeViewerAssertion() { throw new Error("No session is attached to this callback."); },
  authorizeObservation() { throw new Error("No session is attached to this callback."); },
  submitAction() { throw new Error("No session is attached to this callback."); },
};

export interface HostOptions {
  serviceUrl: string;
  resource: DatastoreResource;
  /** Current approved datastore, re-read on every call so removing it from config revokes access. */
  datastore: () => ApprovedDatastore | undefined;
  storage: SyncStorage;
  queue: RecordsApprovalQueue;
  fetch?: typeof fetch;
}

export function recordsHost(options: HostOptions): RecordsOsHost {
  const { resource, storage } = options;
  const client = () => {
    const approved = options.datastore();
    if (!approved) throw new Error("forbidden: This datastore is no longer approved for Cloudflare OS.");
    return new RecordsClient({ url: options.serviceUrl, datastore: approved.id, token: () => approved.key, ...(options.fetch ? { fetch: options.fetch } : {}) });
  };
  return {
    datastore: resource.datastore,
    binding: bindingId(storage),
    requirement: { moduleId: resource.moduleId, apiMajor: resource.apiMajor, scopes: scopesFor(resource.moduleId, resource.access) },
    queue: options.queue,
    pending: pendingStore(storage),
    readClient: async () => client(),
    async resolveViewer(viewerId: string) {
      if (!viewerId || resource.access !== "write" || !options.datastore()) return null;
      return { principal: `cloudflare-os:${viewerId}`, client: client() };
    },
    async observers() {
      return [...storage.kv.list<{ principal: string }>({ prefix: "observer:" })].map(([key, value]) => ({ observerId: key.slice("observer:".length), principal: value.principal }));
    },
    async canRead(principal: string) { return principal === observerPrincipal() && options.datastore() !== undefined; },
  };
}

/** Maps service, network and bridge failures to stable `code: detail` errors for gadgets. */
export function recordsFailure(error: unknown, context: "read" | "changes" | "command" = "read"): Error {
  if (error instanceof RecordsError) {
    const status = error.status;
    if (status === 401 || status === 403) return new Error("forbidden: The Records service refused this connection's credentials or scopes.");
    if (status === 404) return new Error("not_found: That record or module is not available.");
    if (status === 409) return context === "changes"
      ? new Error("reset_required: The datastore's permissions changed. Discard cached records and take a new snapshot.")
      : new Error("conflict: The request conflicts with an earlier one (for example a reused idempotency key).");
    if (status === 412) return new Error("stale_revision: Someone changed this record first. Reload it and try again.");
    if (status === 413) return new Error("too_large: The datastore holds more records than one snapshot allows.");
    if (status === 428) return new Error("revision_required: Updates need the record's current revision.");
    if (status === 400) return new Error("invalid_request: The Records service rejected the request as invalid.");
    return new Error("unavailable: The Records service is temporarily unavailable. Try again shortly.");
  }
  if (error instanceof Error) {
    if (/^[a-z_]+: /.test(error.message)) return error;
    if (error.message === "Invalid command intent") return new Error("invalid_request: The command, idempotency key or revision is malformed.");
    if (error.message === "Viewer is not authorised for this binding") return new Error("forbidden: You cannot change records through this connection.");
    if (error.message.startsWith("Datastore does not satisfy")) return new Error("forbidden: The datastore no longer offers the module, API major or scopes this connection needs.");
    if (error.message === "Unknown Records action") return new Error("not_found: Unknown action.");
    if (error.message === "Command intent must contain only JSON values" || error.message === "Command intent exceeds size limit") return new Error(`invalid_request: ${error.message}.`);
    if (error instanceof TypeError || error instanceof SyntaxError || error.message === "Records request exhausted retries") {
      return new Error("unavailable: The Records service could not be reached. Try again shortly.");
    }
    if (context === "command") return new Error(`forbidden: ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function recordsQuery(query: unknown): RecordsQuery {
  if (query === undefined || query === null) return {};
  if (!plainObject(query)) throw new Error("invalid_request: The query must be an object.");
  const out: RecordsQuery = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (key === "entity" && typeof value === "string" && ENTITY.test(value)) out.entity = value;
    else if ((key === "id" || key === "after") && typeof value === "string" && UUID.test(value.toLowerCase())) out[key] = value.toLowerCase();
    else if (key === "limit" && Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 500) out.limit = value as number;
    else throw new Error(`invalid_request: Unsupported query field ${key}; use entity, id, after (UUIDs) and limit (1-500).`);
  }
  return out;
}

/** The gadget-facing session logic. The Durable Object wraps it in an RpcTarget. */
export class SessionCore {
  readonly #bridge: ReturnType<RecordsOsBridge["session"]>;
  readonly #connection: RecordsConnection;
  readonly #model: () => Promise<RecordsModel>;

  constructor(bridge: RecordsOsBridge, connection: RecordsConnection, model: () => Promise<RecordsModel>) {
    this.#bridge = bridge.session();
    this.#connection = connection;
    this.#model = model;
  }

  async connection(): Promise<RecordsConnection> { return structuredClone(this.#connection); }
  async model(): Promise<RecordsModel> { return this.#model(); }

  async describe() {
    try { return await this.#bridge.describe(); } catch (error) { throw recordsFailure(error); }
  }

  async records(query?: unknown) {
    const parsed = recordsQuery(query);
    try { return await this.#bridge.records(parsed); } catch (error) { throw recordsFailure(error); }
  }

  async snapshot(limit?: unknown) {
    if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 5000)) {
      throw new Error("invalid_request: The snapshot limit must be an integer from 1 to 5000.");
    }
    try { return await this.#bridge.snapshot((limit ?? undefined) as number | undefined); } catch (error) { throw recordsFailure(error); }
  }

  async changes(after?: unknown, epoch?: unknown) {
    for (const value of [after, epoch]) {
      if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || (value as number) < 0)) {
        throw new Error("invalid_request: Change cursors and epochs are non-negative integers.");
      }
    }
    try { return await this.#bridge.changes((after ?? undefined) as number | undefined, (epoch ?? undefined) as number | undefined); }
    catch (error) { throw recordsFailure(error, "changes"); }
  }

  async command(command: unknown, input: unknown, options: unknown): Promise<RecordsCommandOutcome> {
    if (this.#connection.access !== "write") throw new Error("read_only: This connection was granted read access only.");
    if (typeof command !== "string" || !plainObject(input) || !plainObject(options)) {
      throw new Error("invalid_request: command(name, input, { viewerAssertion, idempotencyKey, revision? }) needs a name and two objects.");
    }
    const { viewerAssertion, idempotencyKey, revision } = options;
    if (typeof viewerAssertion !== "string" || typeof idempotencyKey !== "string" || (revision !== undefined && typeof revision !== "number")) {
      throw new Error("invalid_request: A viewer assertion and idempotency key are required.");
    }
    let submitted: CommandOutcome;
    try {
      submitted = await this.#bridge.command(command, input, { viewerAssertion, idempotencyKey, ...(revision === undefined ? {} : { revision }) });
    } catch (error) { throw recordsFailure(error, "command"); }
    // The owner may have pre-approved this kind, in which case it was applied during submission.
    if (submitted.status === "pending") return this.getOutcome(submitted.actionId).catch(() => submitted as RecordsCommandOutcome);
    return submitted as RecordsCommandOutcome;
  }

  async getOutcome(actionId: unknown): Promise<RecordsCommandOutcome> {
    if (!Number.isSafeInteger(actionId) || (actionId as number) < 1) throw new Error("not_found: Unknown action.");
    try { return await this.#bridge.getOutcome(actionId as number) as RecordsCommandOutcome; } catch (error) { throw recordsFailure(error); }
  }
}

/** Public model metadata: the installed profile and each entity's JSON Schema, bounded. */
export async function fetchModel(serviceUrl: string, moduleId: string, apiMajor: number, fetcher: typeof fetch = fetch): Promise<RecordsModel> {
  const get = async (path: string): Promise<unknown> => {
    const response = await fetcher(`${serviceUrl}/v1/models/${encodeURIComponent(moduleId)}/v${apiMajor}/${path}`, { headers: { accept: "application/json" } });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const text = await response.text();
    if (text.length > MAX_MODEL_BYTES) return null;
    try { return JSON.parse(text); } catch { return null; }
  };
  let profile: RecordsModel["profile"] = null;
  try { profile = await get("profile") as RecordsModel["profile"]; } catch { throw new Error("unavailable: The Records service could not be reached. Try again shortly."); }
  const entities = profile && plainObject(profile.entities) ? Object.keys(profile.entities).filter((name) => ENTITY.test(name)).slice(0, MAX_MODEL_ENTITIES) : [];
  const schemas: Record<string, unknown> = {};
  await Promise.all(entities.map(async (entity) => {
    const schema = await get(`schema/${entity}`).catch(() => null);
    if (schema) schemas[entity] = schema;
  }));
  return { moduleId, apiMajor, profile: plainObject(profile) ? profile : null, schemas };
}

export { RecordsOsBridge, RecordsClient };
