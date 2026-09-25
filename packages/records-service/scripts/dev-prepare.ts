import { generateKeyPair, exportJWK, exportPKCS8, calculateJwkThumbprint } from 'jose';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';

const dir = new URL('../.eval/', import.meta.url);
await mkdir(dir, { recursive: true, mode: 0o700 });
try {
  await access(new URL('compose.env', dir));
  console.log('Local configuration already exists; retaining keys and datastore identities.');
} catch {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  const admin = randomBytes(24).toString('hex');
  const auth = randomBytes(24).toString('hex');
  const gateway = randomBytes(24).toString('hex');
  const listener = randomBytes(24).toString('hex');
  const client = {
    baseUrl: 'http://127.0.0.1:8788',
    orgId: randomUUID(), principalId: randomUUID(),
    work: { datastoreId: randomUUID(), bindingId: randomUUID(), key: `rk_${randomBytes(32).toString('base64url')}` },
    messaging: { datastoreId: randomUUID(), bindingId: randomUUID(), key: `rk_${randomBytes(32).toString('base64url')}` },
  };
  await writeFile(new URL('signing.pem', dir), await exportPKCS8(privateKey), { mode: 0o600 });
  await writeFile(new URL('jwks.json', dir), JSON.stringify({ keys: [{ ...jwk, kid, alg: 'ES256', use: 'sig' }] }), { mode: 0o600 });
  await writeFile(new URL('client.json', dir), JSON.stringify(client, null, 2), { mode: 0o600 });
  await writeFile(new URL('compose.env', dir), [
    `POSTGRES_PASSWORD=${admin}`, `POSTGREST_PASSWORD=${auth}`, `GATEWAY_PASSWORD=${gateway}`, `LISTENER_PASSWORD=${listener}`,
    `RECORDS_SIGNING_KID=${kid}`,
    `RECORDS_MIGRATION_URL=postgres://postgres:${admin}@db:5432/records`,
    `PGRST_DB_URI=postgres://records_authenticator:${auth}@db:5432/records`,
    `RECORDS_AUTH_DATABASE_URL=postgres://records_gateway:${gateway}@db:5432/records`,
    `RECORDS_LISTENER_DATABASE_URL=postgres://records_listener:${listener}@db:5432/records`,
    '',
  ].join('\n'), { mode: 0o600 });
  console.log('Generated local-only configuration in .eval/. Credentials are stored in client.json, not printed.');
}
