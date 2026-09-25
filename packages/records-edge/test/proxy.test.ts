import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyRecords } from '../src/index.ts';
const env = { RECORDS_ORIGIN: 'https://origin.example', ORIGIN_AUTH_MODE: 'access', CF_ACCESS_CLIENT_ID: 'server-id', CF_ACCESS_CLIENT_SECRET: 'server-secret' };
const path = '/v1/datastores/11111111-1111-4111-8111-111111111111/modules/work/v1/records';
const request = (pathname = path, init?: RequestInit) => new Request(`https://edge.example${pathname}`, init);
test('origin and Access config fail closed before fetch', async () => {
  let called = false; const transport: typeof fetch = async () => { called = true; return Response.json({}); };
  for (const origin of ['', 'http://origin.example', 'https://user:pass@origin.example', 'https://origin.example/path', 'https://origin.example?x=1']) assert.equal((await proxyRecords(request(), { ...env, RECORDS_ORIGIN: origin }, transport)).status, 503);
  assert.equal((await proxyRecords(request(), { ...env, CF_ACCESS_CLIENT_SECRET: undefined }, transport)).status, 503);
  assert.equal(called, false);
});
test('proxy preserves Records auth but overwrites private Access headers and strips caller context', async () => {
  await proxyRecords(request(path + '?limit=5', { headers: { authorization: 'Bearer records-key', 'CF-Access-Client-Secret': 'forged', 'x-user-id': 'spoofed', cookie: 'sensitive=1', 'content-profile': 'records_private' } }), env, async (url, init) => {
    assert.equal(String(url), 'https://origin.example' + path + '?limit=5');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer records-key'); assert.equal(headers.get('cf-access-client-secret'), 'server-secret');
    assert.equal(headers.get('x-user-id'), null); assert.equal(headers.get('cookie'), null); assert.equal(headers.get('content-profile'), null);
    return Response.json({}, { headers: { 'set-cookie': 'origin=secret', 'cf-access-client-secret': 'secret' } });
  }).then(response => { assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('cf-access-client-secret'), null); });
});
test('origin redirects never leak credentials to a second destination', async () => {
  let calls = 0;
  const response = await proxyRecords(request(), env, async (_url, init) => { calls++; assert.equal(init?.redirect, 'manual'); return new Response(null, { status: 302, headers: { location: 'https://attacker.example' } }); });
  assert.equal(response.status, 502); assert.equal(response.headers.get('location'), null); assert.equal(calls, 1);
});
test('SSE is streamed without waiting for the origin body to finish', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const response = await proxyRecords(request('/v1/datastores/11111111-1111-4111-8111-111111111111/events'), env, async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body!.getReader(); controller.enqueue(new TextEncoder().encode('event: changes\ndata: {}\n\n'));
  assert.match(new TextDecoder().decode((await reader.read()).value), /changes/); controller.close(); assert.equal((await reader.read()).done, true);
});
test('unsupported paths, methods, oversized known bodies and HTML origin failures are rejected', async () => {
  const transport: typeof fetch = async () => new Response('Access login', { headers: { 'content-type': 'text/html' } });
  assert.equal((await proxyRecords(request('/rpc/execute_command'), env, transport)).status, 404);
  assert.equal((await proxyRecords(request(path, { method: 'DELETE' }), env, transport)).status, 405);
  assert.equal((await proxyRecords(request(path, { headers: { 'content-length': '65537' } }), env, transport)).status, 413);
  assert.equal((await proxyRecords(request(), env, transport)).status, 502);
});
