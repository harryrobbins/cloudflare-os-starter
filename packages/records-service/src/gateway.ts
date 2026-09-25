export interface Identity {
  sub: string; org_id: string; datastore_id: string; binding_id: string;
  scope: string[]; permission_epoch: number; module_id?: string;
}
export interface ModelRegistry {
  term(name: string): unknown | Promise<unknown>;
  profile(module: string, major?: number): unknown | Promise<unknown>;
  schema(module: string, entity: string, major?: number): unknown | Promise<unknown>;
  jsonld(module: string, entity: string, data: Record<string, unknown>, major?: number): unknown | Promise<unknown>;
}
export interface CredentialStore { authenticate(key: string, datastore: string): Promise<Identity | null> }
export interface GatewayOptions {
  credentials: CredentialStore;
  sign(identity: Identity): Promise<string>;
  postgrest: string;
  fetch?: typeof fetch;
  relay?: { subscribe(request: Request, identity: Identity, revalidate: () => Promise<boolean>): Response };
  maxBodyBytes?: number;
  models?: ModelRegistry;
}
export function problem(status: number, detail: string): Response {
  return Response.json({ type: 'about:blank', title: detail, status }, { status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function integer(value: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error('Invalid integer');
  return Number(value);
}
async function body(request: Request, limit: number): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('JSON content type required');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('JSON object required');
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new RangeError('Request too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object required');
  return parsed;
}
export function createGateway(options: GatewayOptions): (request: Request) => Promise<Response> {
  const transport = options.fetch ?? fetch;
  return async request => {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' && request.method === 'GET') return Response.json({ status: 'ok' });
    if (url.pathname === '/v1/openapi.json' && request.method === 'GET') return Response.json(publicOpenApi());
    const modelRoute = /^\/v1\/(?:vocabulary\/schemaorg\/terms\/([A-Za-z][A-Za-z0-9]*)|models\/([a-z][a-z0-9_-]{0,62})(?:\/v([1-9]\d{0,3}))?(?:\/(profile|schema)(?:\/([a-z][a-z0-9_]{0,62}))?)?)$/.exec(url.pathname);
    if (modelRoute) {
      if (request.method !== 'GET') return problem(405, 'Method not allowed');
      if (!options.models) return problem(404, 'Model catalogue unavailable');
      try {
        const major = Number(modelRoute[3] ?? '1');
        const value = await (modelRoute[1] ? options.models.term(modelRoute[1]) : modelRoute[4] === 'schema' ? (modelRoute[5] ? options.models.schema(modelRoute[2]!, modelRoute[5], major) : undefined) : options.models.profile(modelRoute[2]!, major));
        return value ? Response.json(value, { headers: { 'cache-control': 'public, max-age=300' } }) : problem(404, 'Model definition not found');
      } catch { return problem(404, 'Model definition not found'); }
    }
    const match = /^\/v1\/datastores\/([^/]+)\/(?:modules\/([a-z][a-z0-9_-]{0,62})\/v([1-9]\d{0,3})\/(records|snapshot|rpc\/([a-z][a-z0-9_.-]{0,127}))|(changes|describe|events|openapi))$/.exec(url.pathname);
    if (!match || !uuid.test(match[1]!)) return problem(404, 'Route not found');
    const [, datastore, module, major, action, command, globalAction] = match;
    const write = Boolean(command);
    if (request.method !== (write ? 'POST' : 'GET')) return problem(405, 'Method not allowed');
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ') || authorization.length > 2048) return problem(401, 'Credentials required');
    const key = authorization.slice(7);
    let identity: Identity | null;
    try { identity = await options.credentials.authenticate(key, datastore!); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'PT401') return problem(401, 'Invalid or revoked credentials');
      return problem(503, 'Authentication temporarily unavailable');
    }
    if (!identity || identity.datastore_id !== datastore) return problem(401, 'Invalid or revoked credentials');
    if (globalAction === 'events') {
      if (!identity.module_id || !identity.scope.includes(`${identity.module_id}.read`)) return problem(403, 'Read permission required');
      if (!options.relay) return problem(404, 'Event stream unavailable; use changes');
      const original = identity;
      return options.relay.subscribe(request, identity, async () => {
        const current = await options.credentials.authenticate(key, datastore!);
        return Boolean(current && current.permission_epoch === original.permission_epoch && current.binding_id === original.binding_id && current.sub === original.sub && current.module_id === original.module_id && current.scope.includes(`${original.module_id}.read`));
      });
    }
    let rpc: string; let args: Record<string, unknown> = { datastore_id: datastore };
    try {
      const allowed = globalAction === 'changes' ? ['after', 'limit', 'epoch'] : action === 'records' ? ['entity', 'id', 'limit', 'after', 'format'] : action === 'snapshot' ? ['limit'] : [];
      for (const name of url.searchParams.keys()) if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) throw new Error('Unsupported query parameter');
      if (url.searchParams.has('format') && url.searchParams.get('format') !== 'jsonld') throw new Error('Unsupported format');
      if (url.searchParams.get('format') === 'jsonld' && !options.models) return problem(406, 'JSON-LD representation unavailable');
      if (write) {
        const idempotency = request.headers.get('idempotency-key');
        if (!idempotency || !/^[\x21-\x7e]{1,128}$/.test(idempotency)) return problem(400, 'A bounded Idempotency-Key is required');
        const revision = request.headers.get('if-match');
        if (revision !== null && !/^"[1-9]\d*"$/.test(revision)) return problem(400, 'If-Match must contain one quoted revision');
        const input = await body(request, options.maxBodyBytes ?? 65536);
        rpc = 'execute_command';
        args = { ...args, module_id: module, api_major: Number(major), command, input, idempotency_key: idempotency, expected_revision: revision === null ? null : integer(revision.slice(1, -1), 0) };
      } else if (action === 'snapshot') {
        rpc = 'snapshot_records';
        args = { ...args, module_id: module, api_major: Number(major), limit_count: integer(url.searchParams.get('limit'), 1000, 5000) };
      } else if (globalAction === 'changes') {
        rpc = 'pull_changes';
        args = { ...args, after_seq: integer(url.searchParams.get('after'), 0), limit_count: integer(url.searchParams.get('limit'), 100, 500), permission_epoch: url.searchParams.has('epoch') ? integer(url.searchParams.get('epoch'), 0) : null };
      } else if (globalAction === 'describe' || globalAction === 'openapi') rpc = 'describe_datastore';
      else {
        rpc = 'read_records';
        const id = url.searchParams.get('id'); const after = url.searchParams.get('after');
        if ((id && !uuid.test(id)) || (after && !uuid.test(after))) throw new Error('Invalid record identifier');
        args = { ...args, module_id: module, api_major: Number(major), entity: url.searchParams.get('entity'), record_id: id, limit_count: integer(url.searchParams.get('limit'), 100, 500), after_id: after };
      }
    } catch (error) { return problem(error instanceof RangeError ? 413 : 400, error instanceof RangeError ? 'Request too large' : 'Invalid request'); }
    try {
      const token = await options.sign(identity);
      const response = await transport(new URL(`/rpc/${rpc}`, options.postgrest), {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-profile': 'records_api', 'accept-profile': 'records_api' },
        body: JSON.stringify(args), signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const safe: Record<number, string> = { 400: 'Invalid request', 401: 'Invalid or revoked credentials', 403: 'Operation forbidden', 404: 'Record or module not found', 409: 'Conflicting request or reset required', 412: 'Revision does not match', 413: 'Snapshot exceeds requested bound', 428: 'Revision precondition required' };
        return problem(safe[response.status] ? response.status : 502, safe[response.status] ?? 'Datastore temporarily unavailable');
      }
      if (globalAction === 'openapi') {
        const description = await response.json() as { modules: PublicModule[]; granted_scopes: string[] };
        return Response.json(publicOpenApi(description.modules, description.granted_scopes), { headers: { 'cache-control': 'no-store' } });
      }
      if (url.searchParams.get('format') === 'jsonld') {
        const page = await response.json() as { records: { id: string; entity: string; revision: number; data: Record<string, unknown> }[]; permission_epoch: number };
        const graph = await Promise.all(page.records.map(async record => ({ ...(await options.models!.jsonld(module!, record.entity, record.data, Number(major)) as object), '@id': `urn:records:datastore:${datastore}:record:${record.id}`, 'urn:records:revision': record.revision })));
        return Response.json({ '@graph': graph, 'urn:records:permissionEpoch': page.permission_epoch }, { headers: { 'content-type': 'application/ld+json', 'cache-control': 'no-store' } });
      }
      return new Response(response.body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    } catch { return problem(503, 'Datastore temporarily unavailable'); }
  };
}
import { publicOpenApi, type PublicModule } from './openapi.ts';
