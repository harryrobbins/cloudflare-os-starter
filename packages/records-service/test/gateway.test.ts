import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, type Identity } from '../src/gateway.ts';
import { RecordsClient } from '../src/client.ts';
import { HintRelay } from '../src/relay.ts';
import { bindViewer } from '../src/connector.ts';
import { executeApprovedCommand, intentDigest, type ApprovedCommandHost, type CommandIntent } from '../src/approved-command.ts';

const datastore = '11111111-1111-4111-8111-111111111111';
const identity: Identity = { sub: 'person', org_id: 'org', datastore_id: datastore, binding_id: 'binding', scope: ['work.read', 'work.write'], permission_epoch: 1, module_id: 'work' };
function setup() {
  const calls: Request[] = [];
  const handler = createGateway({ postgrest: 'http://private:3000', credentials: { authenticate: async key => key === 'secret' ? identity : null }, sign: async () => 'internal-token', fetch: async (url, init) => {
    calls.push(new Request(url, init)); return Response.json({ records: [] });
  } });
  return { handler, calls };
}
function request(path = 'modules/work/v1/records', init: RequestInit = {}): Request {
  return new Request(`http://gateway/v1/datastores/${datastore}/${path}`, { ...init, headers: { authorization: 'Bearer secret', ...Object.fromEntries(new Headers(init.headers)) } });
}
test('auth and route validation deny before reaching PostgREST', async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(request('modules/work/v1/records', { headers: { authorization: 'Bearer invalid' } }))).status, 401);
  assert.equal((await handler(request('modules/work/v1/records?select=*'))).status, 400);
  assert.equal((await handler(request('modules/work/v1/records?limit=501'))).status, 400);
  assert.equal((await handler(request('modules/work/v1/records?limit=1&limit=2'))).status, 400);
  assert.equal(calls.length, 0);
});
test('gateway constructs private RPC and never forwards caller identity context', async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(request('modules/work/v1/records', { headers: { 'x-user-id': 'attacker', 'content-profile': 'records_private', prefer: 'return=representation' } }))).status, 200);
  const upstream = calls[0]!;
  assert.equal(upstream.url, 'http://private:3000/rpc/read_records');
  assert.equal(upstream.headers.get('authorization'), 'Bearer internal-token');
  assert.equal(upstream.headers.get('content-profile'), 'records_api');
  assert.equal(upstream.headers.get('x-user-id'), null);
  assert.equal(upstream.headers.get('prefer'), null);
  assert.equal((await upstream.json()).datastore_id, datastore);
});
test('write requires idempotency and bounds input before dispatch', async () => {
  const { handler, calls } = setup();
  const path = 'modules/work/v1/rpc/work.update';
  const init = { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'retry-1', 'if-match': '"2"' }, body: '{"title":"hello"}' };
  assert.equal((await handler(request(path, { ...init, headers: { 'content-type': 'application/json' } }))).status, 400);
  assert.equal((await handler(request(path, { ...init, body: JSON.stringify({ big: 'x'.repeat(65536) }) }))).status, 413);
  assert.equal((await handler(request(path, init))).status, 200);
  const args = await calls[0]!.json();
  assert.equal(args.expected_revision, 2); assert.equal(args.idempotency_key, 'retry-1'); assert.equal(args.command, 'work.update');
});
test('SQL errors cannot leak internal details', async () => {
  const handler = createGateway({ postgrest: 'http://private', credentials: { authenticate: async () => identity }, sign: async () => 'token', fetch: async () => Response.json({ message: 'secret relation private.users', details: 'password' }, { status: 500 }) });
  const response = await handler(request()); assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret|password/);
});
test('SDK retries ambiguous writes using exactly the same idempotency key', async () => {
  const keys: string[] = [];
  const client = new RecordsClient({ url: 'http://gateway', datastore, token: () => 'secret', fetch: async (_url, init) => {
    keys.push(new Headers(init?.headers).get('idempotency-key')!);
    if (keys.length === 1) throw new Error('connection lost after commit');
    return Response.json({ revision: 1 });
  } });
  await client.command('work', 1, 'work.create', { title: 'one' });
  assert.equal(keys.length, 2); assert.ok(keys[0]); assert.equal(keys[0], keys[1]);
});
test('blueprint binding rejects incompatible version before exposing module', async () => {
  const client = new RecordsClient({ url: 'http://gateway', datastore, token: () => 'secret', fetch: async () => Response.json({ granted_scopes: ['work.read'], modules: [{ id: 'work', api_majors: [1], scopes: ['work.read', 'work.write'] }] }) });
  await assert.rejects(client.bind({ moduleId: 'work', apiMajor: 2, scopes: [] }), /does not satisfy/);
  await assert.rejects(client.bind({ moduleId: 'work', apiMajor: 1, scopes: ['work.write'] }), /does not satisfy/);
  assert.ok(await client.bind({ moduleId: 'work', apiMajor: 1, scopes: ['work.read'] }));
});
test('relay periodically reconciles lost notifications and closes revoked subscriptions', async () => {
  const relay = new HintRelay({ intervalMs: 10, lifetimeMs: 1000 });
  let allowed = true;
  const response = relay.subscribe(request(), identity, async () => allowed);
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: changes/);
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: changes/);
  allowed = false;
  assert.equal((await reader.read()).done, true);
  relay.close();
});
test('viewer binding rejects a broker credential minted for another subject', async () => {
  const expiresAt = Date.now() / 1000 + 300;
  await assert.rejects(bindViewer({
    url: 'http://gateway', datastore, binding: 'binding', organisation: 'org', issuer: 'os', audience: 'records',
    assertion: async () => 'signed-assertion',
    verify: async () => ({ subject: 'alice', issuer: 'os', audience: 'records', organisation: 'org', expiresAt }),
    exchange: async () => ({ subject: 'bob', datastore, binding: 'binding', expiresAt, token: 'secret' }),
    requirement: { moduleId: 'work', apiMajor: 1, scopes: ['work.read'] },
    fetch: async () => { throw new Error('Invalid grant must never reach transport'); },
  }), /invalid viewer binding/);
});
test('invalid SQL credentials return 401 while infrastructure failure returns 503', async () => {
  const handler = (code: string) => createGateway({ postgrest: 'http://private', sign: async () => 'token', credentials: { authenticate: async () => { throw { code }; } } });
  assert.equal((await handler('PT401')(request())).status, 401);
  assert.equal((await handler('ECONNREFUSED')(request())).status, 503);
});
test('write-only credentials cannot subscribe to datastore hints', async () => {
  let subscribed = false;
  const handler = createGateway({ postgrest: 'http://private', sign: async () => 'token', credentials: { authenticate: async () => ({ ...identity, scope: ['work.write'] }) }, relay: { subscribe: () => { subscribed = true; return new Response(); } } });
  assert.equal((await handler(request('events'))).status, 403);
  assert.equal(subscribed, false);
});
test('public model catalogue and authenticated JSON-LD representation use model registry', async () => {
  const handler = createGateway({ postgrest: 'http://private', sign: async () => 'token', credentials: { authenticate: async key => key === 'secret' ? identity : null },
    models: { term: name => name === 'Project' ? { id: 'https://schema.org/Project' } : undefined, profile: id => ({ id }), schema: (_id, entity) => ({ type: 'object', title: entity }), jsonld: (_module, _entity, data) => ({ '@type': 'urn:records:work:WorkItem', 'https://schema.org/name': data.title }) },
    fetch: async () => Response.json({ records: [{ id: datastore, entity: 'work_item', data: { title: 'Test' }, revision: 1 }], permission_epoch: 1 }),
  });
  assert.equal((await handler(new Request('http://gateway/v1/vocabulary/schemaorg/terms/Project'))).status, 200);
  assert.equal((await handler(new Request('http://gateway/v1/vocabulary/schemaorg/terms/Missing'))).status, 404);
  assert.equal((await handler(new Request('http://gateway/v1/models/work/schema/work_item'))).status, 200);
  assert.equal((await handler(request('modules/work/v1/records?format=jsonld', { headers: { authorization: 'Bearer invalid' } }))).status, 401);
  const response = await handler(request('modules/work/v1/records?format=jsonld'));
  assert.equal(response.headers.get('content-type'), 'application/ld+json');
  const value = await response.json(); assert.equal(value['@graph'][0]['https://schema.org/name'], 'Test');
});
test('snapshot dispatch includes module version and rejects unsafe bounds', async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(request('modules/work/v1/snapshot?limit=5001'))).status, 400);
  assert.equal((await handler(request('modules/work/v1/snapshot?limit=5000'))).status, 200);
  assert.equal(calls[0]!.url, 'http://private:3000/rpc/snapshot_records');
  assert.deepEqual(await calls[0]!.json(), { datastore_id: datastore, module_id: 'work', api_major: 1, limit_count: 5000 });
});
test('public model lookup passes requested API major to asynchronous installed registry', async () => {
  const calls: unknown[] = [];
  const handler = createGateway({ postgrest: 'http://private', sign: async () => 'token', credentials: { authenticate: async () => null }, models: {
    term: () => undefined, jsonld: () => undefined,
    profile: async (module, major) => { calls.push([module, major]); return { id: module }; },
    schema: async (module, entity, major) => { calls.push([module, entity, major]); return { type: 'object' }; },
  } });
  assert.equal((await handler(new Request('http://gateway/v1/models/inventory/v2/profile'))).status, 200);
  assert.equal((await handler(new Request('http://gateway/v1/models/inventory/v2/schema/item'))).status, 200);
  assert.deepEqual(calls, [['inventory', 2], ['inventory', 'item', 2]]);
});
test('blueprint features are enforced in addition to scopes and major', async () => {
  const client = new RecordsClient({ url: 'http://gateway', datastore, token: () => 'secret', fetch: async () => Response.json({ granted_scopes: ['work.read'], modules: [{ id: 'work', api_majors: [1], scopes: ['work.read'], features: ['history'] }] }) });
  await assert.rejects(client.bind({ moduleId: 'work', apiMajor: 1, scopes: [], features: ['relationships'] }), /features/);
  assert.ok(await client.bind({ moduleId: 'work', apiMajor: 1, scopes: ['work.read'], features: ['history'] }));
});
test('slow SSE subscribers are terminated without unbounded queue growth', async () => {
  const relay = new HintRelay({ intervalMs: 1000, lifetimeMs: 1000, maxClients: 1 });
  const response = relay.subscribe(request(), identity, async () => true);
  assert.equal(relay.subscribe(request(), identity, async () => true).status, 503);
  relay.notify(datastore); // Initial hint is still queued: closes and frees capacity.
  const reader = response.body!.getReader();
  assert.equal((await reader.read()).done, false);
  assert.equal((await reader.read()).done, true);
  const next = relay.subscribe(request(), identity, async () => true); assert.equal(next.status, 200);
  await next.body!.cancel(); relay.close();
});
test('SSE credential expiry closes stream during periodic revalidation', async () => {
  const relay = new HintRelay({ intervalMs: 10, lifetimeMs: 1000 });
  let valid = true;
  const handler = createGateway({ postgrest: 'http://private', sign: async () => 'token', credentials: { authenticate: async () => valid ? identity : null }, relay });
  const stream = await handler(request('events')); const reader = stream.body!.getReader();
  assert.equal((await reader.read()).done, false);
  valid = false;
  assert.equal((await reader.read()).done, true);
  assert.equal((await handler(request('events'))).status, 401);
  relay.close();
});
test('SSE scope revocation closes stream even if an authority source fails to bump its epoch', async () => {
  const relay = new HintRelay({ intervalMs: 10, lifetimeMs: 1000 });
  let scopes = ['work.read'];
  const handler = createGateway({ postgrest: 'http://private', sign: async () => 'token', credentials: { authenticate: async () => ({ ...identity, scope: scopes }) }, relay });
  const stream = await handler(request('events')); const reader = stream.body!.getReader();
  await reader.read(); scopes = ['work.write'];
  assert.equal((await reader.read()).done, true);
  relay.close();
});
test('public OpenAPI describes only supported gateway routes; installed contract requires credentials', async () => {
  const handler = createGateway({ postgrest: 'http://private', sign: async () => 'token', credentials: { authenticate: async key => key === 'secret' ? identity : null }, fetch: async () => Response.json({ granted_scopes: ['work.read'], modules: [{ id: 'work', api_majors: [1], commands: ['work.create'], scopes: ['work.read', 'work.write'], profile: { entities: { work_item: {} } }, sql_handler: 'private.hidden' }] }) });
  const publicResponse = await handler(new Request('http://gateway/v1/openapi.json'));
  const document = await publicResponse.json();
  assert.equal(document.openapi, '3.1.0');
  assert.ok(document.paths['/v1/datastores/{datastore}/modules/{module}/v{major}/snapshot']);
  assert.equal((await handler(request('openapi', { headers: { authorization: 'Bearer invalid' } }))).status, 401);
  const installed = await (await handler(request('openapi'))).json();
  assert.deepEqual(installed['x-records-modules'][0].commands, ['work.create']);
  assert.ok(installed['x-records-modules'][0].profile.entities.work_item);
  assert.doesNotMatch(JSON.stringify(installed), /private.hidden|sql_handler/);
});
const intentCommand = { moduleId: 'work', apiMajor: 1, command: 'work.create', input: { title: 'Approved title' }, expectedRevision: null, idempotencyKey: 'approval-1' };
function approvedHost(overrides: Partial<ApprovedCommandHost> = {}): ApprovedCommandHost {
  return {
    datastore, binding: 'binding', organisation: 'org', issuer: 'os', audience: 'records',
    assertion: async (_intent, digest) => digest,
    verifyIntent: async (assertion, digest) => ({ subject: 'alice', issuer: 'os', audience: 'records', organisation: 'org', expiresAt: Date.now() / 1000 + 300, digest: assertion === digest ? digest : 'invalid' }),
    approveIntent: async (viewer, _intent, digest) => ({ subject: viewer.subject, digest, approved: true, expiresAt: viewer.expiresAt }),
    executeIntent: async (_viewer, intent) => intent,
    ...overrides,
  };
}
test('approved command refuses altered signed intent and denied approvals before execution', async () => {
  let executed = false;
  const executeIntent = async () => { executed = true; };
  await assert.rejects(executeApprovedCommand(approvedHost({ assertion: async () => 'other digest', executeIntent }), intentCommand), /exact intent/);
  await assert.rejects(executeApprovedCommand(approvedHost({ approveIntent: async (viewer, _intent, digest) => ({ subject: viewer.subject, digest, approved: false, expiresAt: viewer.expiresAt }), executeIntent }), intentCommand), /approval required/);
  assert.equal(executed, false);
});
test('approved command snapshots intent and binds every execution field into digest', async () => {
  const command = structuredClone(intentCommand);
  const result = await executeApprovedCommand(approvedHost({ approveIntent: async (viewer, intent, digest) => {
    command.input.title = 'Changed while dialog open';
    assert.throws(() => { (intent.input as { title: string }).title = 'Modified'; });
    return { subject: viewer.subject, digest, approved: true, expiresAt: viewer.expiresAt };
  } }), command) as CommandIntent;
  assert.equal((result.input as { title: string }).title, 'Approved title');
  const digest = await intentDigest(result);
  for (const changed of [{ ...result, binding: 'other' }, { ...result, idempotencyKey: 'different' }, { ...result, expectedRevision: 2 }, { ...result, command: 'work.update' }]) assert.notEqual(await intentDigest(changed), digest);
});
