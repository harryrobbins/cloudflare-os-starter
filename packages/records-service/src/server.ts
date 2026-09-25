import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { importPKCS8, SignJWT } from 'jose';
import postgres from 'postgres';
import { getBundledCatalogue } from '@records/model/bundled';
import { recordJsonSchema, toJsonLd, type Profile } from '@records/model';
import { createGateway, type Identity } from './gateway.ts';
import { HintRelay } from './relay.ts';
import { requiredSecret, secretSetting } from './config.ts';
import { pipeResponseBody } from './node-stream.ts';
import { loadSite } from './site.ts';

function required(name: string): string {
  const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value;
}
const key = await importPKCS8(await readFile(required('RECORDS_SIGNING_KEY_FILE'), 'utf8'), 'ES256');
const kid = await requiredSecret('RECORDS_SIGNING_KID');
const sql = postgres(await requiredSecret('RECORDS_AUTH_DATABASE_URL'), { max: 5, idle_timeout: 20, connect_timeout: 5 });
const modelCache = new Map<string, { expires: number; value: Promise<Profile | undefined> }>();
async function getProfile(module: string, major = 1): Promise<Profile | undefined> {
  const key = `${module}:${major}`;
  const cached = modelCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (modelCache.size >= 256) modelCache.delete(modelCache.keys().next().value!);
  const value = (async () => {
    const rows = await sql`select records.get_model(${module}, ${major}) as profile`;
    return (rows[0]?.profile as Profile | null) ?? undefined;
  })();
  modelCache.set(key, { value, expires: Date.now() + 5000 });
  try { return await value; } catch (error) { modelCache.delete(key); throw error; }
}
const relay = new HintRelay();
const listenerUrl = await secretSetting('RECORDS_LISTENER_DATABASE_URL');
const listener = listenerUrl ? postgres(listenerUrl, { max: 1, connect_timeout: 5 }) : null;
if (listener) await listener.listen('records_changes', payload => {
  try { const value: unknown = JSON.parse(payload); if (value && typeof value === 'object' && 'datastore_id' in value && typeof value.datastore_id === 'string') relay.notify(value.datastore_id); }
  catch { /* Invalid notifications are ignored; the periodic hint recovers missed notifications. */ }
});
const handler = createGateway({
  postgrest: required('POSTGREST_URL'), relay,
  models: {
    term: name => getBundledCatalogue().resolve(`https://schema.org/${name}`),
    profile: (module, major) => getProfile(module, major),
    schema: async (module, entity, major) => { const profile = await getProfile(module, major); return profile?.entities[entity] ? recordJsonSchema(profile, entity) : undefined; },
    jsonld: async (module, entity, data, major) => { const profile = await getProfile(module, major); if (!profile) throw new Error('Unknown model'); return toJsonLd(profile, entity, data); },
  },
  credentials: { async authenticate(apiKey, datastore) {
    try {
      const rows = await sql`select records.authenticate_api_key(${apiKey}, ${datastore}::uuid) as identity`;
      const identity = rows[0]?.identity;
      return identity ? { ...identity, sub: identity.subject } as Identity : null;
    } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'PT401') return null; throw error; }
  } },
  sign: identity => new SignJWT({ ...identity, role: 'records_runtime' }).setProtectedHeader({ alg: 'ES256', kid }).setIssuer('records-gateway').setAudience('records').setIssuedAt().setExpirationTime('60s').sign(key),
});
const site = process.env.RECORDS_SITE_DIR ? await loadSite(process.env.RECORDS_SITE_DIR) : undefined;
const server = createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  outgoing.on('close', () => controller.abort());
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(',') : value);
    const request = new Request(new URL(incoming.url ?? '/', 'http://records.internal'), {
      method: incoming.method, headers, signal: controller.signal,
      ...(incoming.method !== 'GET' && incoming.method !== 'HEAD' ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
    });
    const response = site?.(request) ?? await handler(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) pipeResponseBody(response.body, outgoing);
    else outgoing.end();
  } catch { if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end(); }
});
server.requestTimeout = 20000; server.headersTimeout = 10000;
server.listen(Number(process.env.RECORDS_PORT ?? '8788'), process.env.RECORDS_HOST ?? '127.0.0.1');
async function shutdown(): Promise<void> {
  relay.close(); server.close();
  await Promise.all([sql.end({ timeout: 5 }), listener?.end({ timeout: 5 })]);
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
