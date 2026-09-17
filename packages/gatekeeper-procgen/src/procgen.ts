import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type { AccountDescription, ApprovalQueue, Gatekeeper, GatekeeperConnectCallback, GatekeeperConnectOptions, GatekeeperUser, GatekeeperUserVerifier, ResourceConfiguratorFrame, ResourceDescription, SupportedResource, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { AggregateRequest, AggregateResult, CollectionSchema, CollectionSummary, DatasetDescription, QueryPage, QueryRequest, SyntheticDataSession } from "./types.js";
import { aggregate, candidateIds, COLLECTION_NAMES, countFor, generateRecord, isCollection, schemaFor, type CollectionName } from "./generator.js";
import { PROCGEN_POLICY } from "./policy.js";
import { parseResourceUrl, type DatasetResource } from "./resource.js";
import { CONFIGURATOR_HTML, TYPES_CODE } from "./generated.js";

export const DATASET_RESOURCE: SupportedResource = { urlPattern: "procgen://commerce/v1/:seed/:profile", title: "Synthetic commerce dataset", description: "A finite deterministic commerce dataset selected by seed and size profile." };
const ICON = { url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232563eb'/%3E%3Cpath d='M8 10h16M8 16h16M8 22h16' stroke='white' stroke-width='3'/%3E%3C/svg%3E" };
type GatekeeperProps = { resourceUrl: string };
class EmptyConfigurator extends RpcTarget {}

function project(record: Record<string, unknown>, schema: CollectionSchema, fields?: string[]): Record<string, unknown> {
  if (!fields) return record;
  if (fields.length === 0 || fields.length > PROCGEN_POLICY.maxSelectedFields || new Set(fields).size !== fields.length) throw new Error(`Select 1-${PROCGEN_POLICY.maxSelectedFields} unique fields.`);
  const valid = new Set(schema.fields.map(field => field.name));
  for (const field of fields) if (!valid.has(field)) throw new Error(`Unknown field ${field}; valid fields: ${[...valid].join(", ")}.`);
  return Object.fromEntries(fields.map(field => [field, record[field]]));
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`procgen-cursor-v1\0${value}`)));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
async function encodeCursor(offset: number, query: unknown, sign: (body: string) => Promise<string>): Promise<string> {
  const payload = { v: 1, offset, expires: Date.now() + 60 * 60_000, query: await digest(stable(query)) };
  const body = btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${body}.${await sign(body)}`;
}
async function decodeCursor(cursor: string, query: unknown, sign: (body: string) => Promise<string>): Promise<number> {
  if (cursor.length > PROCGEN_POLICY.maxCursorBytes) throw new Error("Cursor is too large.");
  const [body, signature, extra] = cursor.split(".");
  if (!body || !signature || extra || await sign(body) !== signature) throw new Error("Cursor is invalid or has been modified.");
  try {
    const payload = JSON.parse(atob(body.replaceAll("-", "+").replaceAll("_", "/"))) as { v: number; offset: number; expires: number; query: string };
    if (payload.v !== 1 || !Number.isSafeInteger(payload.offset) || payload.offset < 0 || payload.expires < Date.now() || payload.query !== await digest(stable(query))) throw new Error();
    return payload.offset;
  } catch { throw new Error("Cursor is expired or does not belong to this query."); }
}
function parseId(id: string): number {
  if (!/^[1-9][0-9]*$/.test(id)) throw new Error("ID must be a positive decimal string.");
  const number = Number(id); if (!Number.isSafeInteger(number)) throw new Error("ID is outside the supported range."); return number;
}

@validateRpc()
export class SyntheticDataGatekeeper extends DurableObject<Cloudflare.Env, GatekeeperProps> implements Gatekeeper<SyntheticDataSession> {
  resource(): DatasetResource { return parseResourceUrl(this.ctx.props.resourceUrl); }
  async describe(): Promise<ResourceDescription> { return { url: this.resource().url, title: "Synthetic commerce data", snippet: "Finite deterministic customers, products, orders, line items, and events.", workspaceReadable: true, suggestedBindingName: "PROCGEN", tsType: "SyntheticDataSession" }; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
  async getAutoApprovableActions(): Promise<[]> { return []; }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<SyntheticDataSession> { return new SyntheticDataSessionImpl(this, this.resource(), queue.dup()); }
  @skipRpcValidation()
  async signCursor(body: string): Promise<string> {
    let secret = this.ctx.storage.kv.get<ArrayBuffer>("cursor-signing-key");
    if (!secret) { secret = crypto.getRandomValues(new Uint8Array(32)).buffer; this.ctx.storage.kv.put("cursor-signing-key", secret); }
    const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    return btoa(String.fromCharCode(...mac)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }
  async addObserver(_id: string, verifier: Fetcher<GatekeeperUserVerifier>): Promise<void> { await (verifier as Fetcher<SyntheticDataVerifier>).verifyPublicSyntheticAccess(); }
  async removeObserver(_id: string): Promise<void> {}
  async applyAction(_sequence: number): Promise<void> { throw new Error("Synthetic Data is read-only."); }
  async rejectAction(_sequence: number): Promise<void> {}
  async revertAction(_sequence: number): Promise<void> { throw new Error("Synthetic Data is read-only."); }
}

export interface SyntheticDataVerifier extends GatekeeperUserVerifier { verifyPublicSyntheticAccess(): Promise<void> }
@validateRpc()
export class ProcgenVerifier extends WorkerEntrypoint<Cloudflare.Env> implements SyntheticDataVerifier { async verifyPublicSyntheticAccess(): Promise<void> {} }

@validateRpc()
export class SyntheticDataSessionImpl extends RpcTarget implements SyntheticDataSession {
  constructor(private gatekeeper: SyntheticDataGatekeeper, private resource: DatasetResource, private queue: RpcStub<ApprovalQueue>) { super(); }
  async observe(operation: string, collection: string, resultCount: number): Promise<void> {
    await this.queue.authorizeObservation({ title: `Read synthetic ${collection}`, description: `Synthetic Data ${this.resource.scenario}/${this.resource.version} ${this.resource.profile}: ${operation}; ${resultCount} result(s).` });
  }
  async describeDataset(): Promise<DatasetDescription> { const result = { resourceUrl: this.resource.url, scenario: this.resource.scenario, version: this.resource.version, seedLabel: this.resource.seed, sizeProfile: this.resource.profile }; await this.observe("describe dataset", "catalog", 1); return result; }
  async listCollections(): Promise<CollectionSummary[]> { const result = COLLECTION_NAMES.map(name => schemaFor(this.resource, name)).map(({ fields: _f, indexes: _i, aggregates: _a, ...summary }) => summary); await this.observe("list collections", "catalog", result.length); return result; }
  async describeCollection(name: string): Promise<CollectionSchema> { if (!isCollection(name)) throw new Error(`Unknown collection ${name}; valid collections: ${COLLECTION_NAMES.join(", ")}.`); const result = schemaFor(this.resource, name); await this.observe("describe collection", name, 1); return result; }
  async getRecord(collection: string, id: string, fields?: string[]): Promise<Record<string, unknown> | null> {
    if (!isCollection(collection)) throw new Error(`Unknown collection ${collection}.`); const numericId = parseId(id); const schema = schemaFor(this.resource, collection);
    const result = numericId <= countFor(this.resource, collection) ? project(generateRecord(this.resource, collection, numericId), schema, fields) : null;
    await this.observe("get record", collection, result ? 1 : 0); return result;
  }
  async query(request: QueryRequest): Promise<QueryPage> {
    if (!request || !isCollection(request.collection)) throw new Error("Query collection is invalid.");
    if ((request.predicates?.length ?? 0) > PROCGEN_POLICY.maxPredicates) throw new Error(`At most ${PROCGEN_POLICY.maxPredicates} predicates are allowed.`);
    const limit = request.limit ?? PROCGEN_POLICY.defaultQueryLimit; if (!Number.isInteger(limit) || limit < 1 || limit > PROCGEN_POLICY.maxQueryLimit) throw new Error(`Query limit must be 1-${PROCGEN_POLICY.maxQueryLimit}.`);
    const schema = schemaFor(this.resource, request.collection); project(generateRecord(this.resource, request.collection, 1), schema, request.fields);
    const normalized = { collection: request.collection, predicates: request.predicates ?? [], fields: request.fields ?? null, limit };
    const sign = (body: string) => this.gatekeeper.signCursor(body);
    const offset = request.cursor ? await decodeCursor(request.cursor, normalized, sign) : 0;
    let ids: number[];
    if (request.predicates?.length) ids = candidateIds(this.resource, request.collection, request.predicates, offset, limit + 1);
    else { const total = countFor(this.resource, request.collection); ids = Array.from({ length: Math.min(limit + 1, Math.max(0, total - offset)) }, (_, i) => offset + i + 1); }
    const pageIds = ids;
    const hasNext = pageIds.length > limit; const records = pageIds.slice(0, limit).map(id => project(generateRecord(this.resource, request.collection as CollectionName, id), schema, request.fields));
    const result: QueryPage = { schema, records, ...(hasNext && { nextCursor: await encodeCursor(offset + limit, normalized, sign) }) };
    await this.observe("query", request.collection, records.length); return result;
  }
  async aggregate(request: AggregateRequest): Promise<AggregateResult> {
    if (!request || request.metrics.length < 1 || request.metrics.length > PROCGEN_POLICY.maxMetrics) throw new Error(`Aggregate requires 1-${PROCGEN_POLICY.maxMetrics} metrics.`);
    const names = request.metrics.map(metric => metric.name); if (new Set(names).size !== names.length || names.some(name => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name))) throw new Error("Metric names must be unique identifiers of at most 64 characters.");
    const limitGroups = request.limitGroups ?? PROCGEN_POLICY.defaultGroupLimit; if (!Number.isInteger(limitGroups) || limitGroups < 1 || limitGroups > PROCGEN_POLICY.maxGroups) throw new Error(`Group limit must be 1-${PROCGEN_POLICY.maxGroups}.`);
    const result = aggregate(this.resource, request); if (result.groups.length > limitGroups) throw new Error(`Result has ${result.groups.length} groups; raise limitGroups within the allowed maximum.`);
    await this.observe("aggregate", request.collection, result.groups.length); return result;
  }
  [Symbol.dispose](): void { this.queue[Symbol.dispose](); }
}

@validateRpc()
export class ProcgenAccount extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> { return { displayName: "Synthetic Data", avatar: ICON }; }
  async getSupportedResources(): Promise<SupportedResource[]> { return [DATASET_RESOURCE]; }
  async startResourceConfigurator(pattern: string): Promise<ResourceConfiguratorFrame> { if (pattern !== DATASET_RESOURCE.urlPattern) throw new Error(`Unsupported resource pattern: ${pattern}`); return { iframeHtml: CONFIGURATOR_HTML, ui: new RpcStub(new EmptyConfigurator()) }; }
  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<SyntheticDataSession>>; resource: SupportedResource }> { const resource = parseResourceUrl(url); return { class: this.ctx.exports.SyntheticDataGatekeeper({ props: { resourceUrl: resource.url } }), resource: DATASET_RESOURCE }; }
  async ensureResources(patterns: string[]): Promise<{ url?: string }> { for (const pattern of patterns) if (pattern !== DATASET_RESOURCE.urlPattern) throw new Error(`Unsupported resource pattern: ${pattern}`); return {}; }
  async revoke(): Promise<void> {}
  async reconnect(): Promise<{ url: string }> { throw new Error("Synthetic Data has no connect flow."); }
  async getAuthenticatedEmail(): Promise<null> { return null; }
  @skipRpcValidation() async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.ProcgenVerifier({}); }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env> {
  async describe(): Promise<VendorDescription> { return { displayName: "Synthetic Data", url: "https://workers.cloudflare.com/", logo: ICON, tagline: "Finite, reproducible demo datasets", description: "Create deterministic commerce datasets for explorers, dashboards, maps, and other Gadgets.", autoProvisionsAccount: true, providesAuth: false }; }
  @skipRpcValidation() async createAccount(): Promise<Fetcher<GatekeeperUser>> { return this.ctx.exports.ProcgenAccount({}); }
  async connectAccount(_callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> { throw new Error("Synthetic Data is auto-provisioned and has no connect flow."); }
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> { return [DATASET_RESOURCE]; }
  async getTypeScriptTypes(): Promise<string> { return TYPES_CODE; }
}
