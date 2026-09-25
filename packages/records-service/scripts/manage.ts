import { readFile, readdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { preparePublication, validateUpgrade, type ModuleManifest } from '@records/model';
import { migrate } from './migrate.ts';
import { assertTransactionalSql } from './sql-policy.ts';
import { getBundledCatalogue } from '@records/model/bundled';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function publish(sql: Sql, directory: string): Promise<void> {
  const root = await realpath(directory);
  const manifest: ModuleManifest = JSON.parse(await readFile(resolve(root, 'module.json'), 'utf8'));
  // Resolve only validated logical migration IDs, never paths supplied by a manifest.
  const files = await readdir(resolve(root, 'migrations'));
  const sources: Record<string, string> = {};
  for (const filename of files) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(filename)) throw new Error('Invalid migration filename');
    const path = await realpath(resolve(root, 'migrations', filename));
    if (!path.startsWith(root + sep)) throw new Error('Migration escapes module package');
    sources[filename.slice(0, -4)] = await readFile(path, 'utf8');
  }
  const prepared = preparePublication(manifest, sources, getBundledCatalogue());
  for (const command of Object.values(manifest.commands)) if (!command.handler) throw new Error('Every executable command needs a reviewed SQL handler');
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(717823020)`;
    await tx`CREATE TABLE IF NOT EXISTS records_private.module_migrations(module_id text,api_major int,id text,checksum text,PRIMARY KEY(module_id,api_major,id))`;
    const bundled = await tx`SELECT 1 FROM records_private.modules WHERE id=${manifest.id} AND NOT manifest ? 'publication'`;
    if (bundled.length) throw new Error('Module name belongs to a bundled module');
    const [previous] = await tx`SELECT manifest FROM records_private.modules WHERE id=${manifest.id} AND api_major=${manifest.apiMajor} FOR UPDATE`;
    if (previous) {
      if (canonical(previous.manifest.publication) === canonical(manifest)) return;
      if (!previous.manifest.publication) throw new Error('Module name already belongs to a bundled module');
      const errors = validateUpgrade(previous.manifest.publication, manifest);
      if (errors.length) throw new Error(errors.join('; '));
    }
    for (const migration of prepared.migrations) {
      const [old] = await tx`SELECT checksum FROM records_private.module_migrations WHERE module_id=${manifest.id} AND api_major=${manifest.apiMajor} AND id=${migration.id}`;
      if (old) {
        if (old.checksum !== migration.sha256) throw new Error('Previously applied module migration changed');
        continue;
      }
      // Trusted reviewed SQL, but transaction control must stay with the installer.
      assertTransactionalSql(migration.sql);
      await tx.unsafe(migration.sql);
      await tx`INSERT INTO records_private.module_migrations VALUES(${manifest.id},${manifest.apiMajor},${migration.id},${migration.sha256})`;
    }
    const stored = {
      id: manifest.id, version: manifest.version, api_majors: [manifest.apiMajor],
      scopes: manifest.scopes, entities: Object.keys(manifest.profile.entities),
      commands: Object.keys(manifest.commands), profile: manifest.profile, publication: manifest,
    };
    await tx`INSERT INTO records_private.modules VALUES(${manifest.id},${manifest.apiMajor},${tx.json(JSON.parse(JSON.stringify(stored)))}) ON CONFLICT(id,api_major) DO UPDATE SET manifest=excluded.manifest`;
    for (const [name, command] of Object.entries(manifest.commands)) {
      await tx`INSERT INTO records_private.commands VALUES(${manifest.id},${manifest.apiMajor},${name},${command.scope},${command.handler!}::regprocedure)
        ON CONFLICT(module_id,api_major,command) DO UPDATE SET required_scope=excluded.required_scope,handler=excluded.handler`;
    }
    await tx`SELECT pg_notify('pgrst','reload schema')`;
  });
}

export async function provision(sql: Sql, module: string, output: string): Promise<void> {
  const orgId = randomUUID(), principalId = randomUUID(), datastoreId = randomUUID(), bindingId = randomUUID();
  const key = `rk_${randomBytes(32).toString('base64url')}`;
  const [installed] = await sql`SELECT manifest FROM records_private.modules WHERE id=${module} AND api_major=1`;
  if (!installed) throw new Error('Module API major 1 is not installed');
  // Reserve the credential file before any database commit; never overwrite another credential.
  await writeFile(output, '', { flag: 'wx', mode: 0o600 });
  await sql.begin(async tx => {
    await tx`INSERT INTO records_private.organisations(id,name) VALUES(${orgId},'Records organisation')`;
    await tx`INSERT INTO records_private.principals(id) VALUES(${principalId})`;
    await tx`INSERT INTO records_private.memberships(org_id,id) VALUES(${orgId},${principalId})`;
    await tx`INSERT INTO records_private.datastores(id,org_id,module_id,api_major) VALUES(${datastoreId},${orgId},${module},1)`;
    await tx`INSERT INTO records_private.bindings(id,datastore_id,principal_id,scopes) VALUES(${bindingId},${datastoreId},${principalId},${installed.manifest.scopes})`;
    await tx`INSERT INTO records_private.service_credentials(key_hash,binding_id,expires_at) VALUES(${createHash('sha256').update(key).digest()},${bindingId},now()+interval '90 days')`;
    // Write while transaction can still roll back; a failed commit can leave an unusable key only.
    await writeFile(output, JSON.stringify({ orgId, principalId, datastoreId, bindingId, module, apiMajor: 1, key }, null, 2), { mode: 0o600 });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const url = process.env.RECORDS_MIGRATION_URL;
  if (!url) throw new Error('RECORDS_MIGRATION_URL is required; use only the dedicated new-service database');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const command = process.argv[2];
    if (command === 'migrate') await migrate(sql);
    else if (command === 'publish' && process.argv[3]) await publish(sql, process.argv[3]);
    else if (command === 'bootstrap' && process.argv[3] && process.argv[4]) await provision(sql, process.argv[3], resolve(process.argv[4]));
    else throw new Error('Usage: manage.ts migrate | publish <module-dir> | bootstrap <module> <new-credential-file>');
    console.log(`Records ${command} completed. Credentials, if created, are in the requested file.`);
  } finally { await sql.end(); }
}
