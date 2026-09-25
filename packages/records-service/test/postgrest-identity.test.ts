import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { importPKCS8, SignJWT } from 'jose';
import postgres from 'postgres';

test('private PostgREST enforces signature and mandatory identity claims', { skip: process.env.RECORDS_IDENTITY_TEST !== '1' }, async () => {
  const client = JSON.parse(await readFile(new URL('../.eval/client.json', import.meta.url), 'utf8'));
  const sql = postgres(process.env.RECORDS_AUTH_DATABASE_URL!, { max: 1 });
  try {
    const [row] = await sql`SELECT records.authenticate_api_key(${client.work.key},${client.work.datastoreId}::uuid) AS identity`;
    const identity = row.identity;
    const privateKey = await importPKCS8(await readFile(process.env.RECORDS_SIGNING_KEY_FILE!, 'utf8'), 'ES256');
    const now = Math.floor(Date.now() / 1000);
    const claims = { ...identity, sub: identity.subject, role: 'records_runtime', iss: 'records-gateway', aud: 'records', exp: now + 60, iat: now };
    const call = async (changes: Record<string, unknown>, kid = process.env.RECORDS_SIGNING_KID) => {
      const token = await new SignJWT({ ...claims, ...changes }).setProtectedHeader({ alg: 'ES256', kid }).sign(privateKey);
      const r = await fetch(`${process.env.POSTGREST_URL}/rpc/describe_datastore`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-profile': 'records_api' }, body: JSON.stringify({ datastore_id: client.work.datastoreId }) });
      await r.body?.cancel(); return r.status;
    };
    assert.equal(await call({}), 200);
    for (const change of [{ iss: undefined }, { iss: 'another-service' }, { aud: undefined }, { aud: 'other' }, { aud: [] }, { exp: undefined }, { exp: now - 90 }, { sub: undefined }]) {
      assert([401, 403].includes(await call(change)), 'invalid claim must fail authentication or authorization');
    }
    assert.equal(await call({}, 'unknown-key'), 401);
    assert.equal(await call({ sub: crypto.randomUUID() }), 403);
    assert.equal(await call({ datastore_id: crypto.randomUUID() }), 403);
    assert.equal(await call({ scope: [] }), 200); // metadata available; record access still denied
    const noToken = await fetch(`${process.env.POSTGREST_URL}/rpc/describe_datastore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ datastore_id: client.work.datastoreId }) });
    assert.equal(noToken.status, 401); await noToken.body?.cancel();
  } finally { await sql.end(); }
});
