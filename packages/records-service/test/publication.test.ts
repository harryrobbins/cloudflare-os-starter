import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { publish } from '../scripts/manage.ts';
// @ts-ignore Embedded database helper is intentionally shared with the JavaScript integration suite.
import { startDatabase } from './database-helpers.mjs';
import type { Sql, TransactionSql } from 'postgres';

test('real publication lifecycle: install, replay, additive upgrade, rollback and runtime dispatch', async () => {
  const db = await startDatabase(); const sql: Sql = db.sql;
  const directory = await mkdtemp(join(tmpdir(), 'records-publication-'));
  const original = new URL('../../records-model/examples/inventory/', import.meta.url);
  try {
    await cp(original, directory, { recursive: true });
    const manifest = JSON.parse(await readFile(join(directory, 'module.json'), 'utf8'));
    const save = (value: unknown) => writeFile(join(directory, 'module.json'), JSON.stringify(value));
    const count = async () => Number((await sql`select count(*) n from records_private.datastores`)[0].n);
    const before = await count();
    await publish(sql, directory);
    assert.equal(await count(), before, 'publication must not grant/create datastores');
    await publish(sql, directory); // PostgreSQL jsonb reorders keys: semantic replay must survive this.
    assert.equal(Number((await sql`select count(*) n from records_private.module_migrations where module_id='inventory'`)[0].n), 1);
    const installed = (await sql`select manifest from records_private.modules where id='inventory'`)[0].manifest;
    assert.deepEqual(installed.entities, ['asset']); assert.ok(installed.scopes.includes('inventory.read'));
    const upgradeSql = 'ALTER TABLE records_inventory.assets ADD COLUMN installation_note text;';
    const upgraded = structuredClone(manifest); upgraded.version = '1.1.0';
    upgraded.migrations.push({ id: '0002_note', sha256: createHash('sha256').update(upgradeSql).digest('hex') });
    await writeFile(join(directory, 'migrations/0002_note.sql'), upgradeSql); await save(upgraded);
    await publish(sql, directory);
    assert.equal((await sql`select manifest->>'version' v from records_private.modules where id='inventory'`)[0].v, '1.1.0');
    await writeFile(join(directory, 'migrations/0002_note.sql'), upgradeSql + ' ');
    await assert.rejects(publish(sql, directory), /checksum/);
    await writeFile(join(directory, 'migrations/0002_note.sql'), upgradeSql);
    const failedSql = 'CREATE TABLE records_inventory.must_rollback(id int); SELECT records_inventory.no_such_function();';
    const failed = structuredClone(upgraded); failed.version = '1.2.0';
    failed.migrations.push({ id: '0003_failure', sha256: createHash('sha256').update(failedSql).digest('hex') });
    await writeFile(join(directory, 'migrations/0003_failure.sql'), failedSql); await save(failed);
    await assert.rejects(publish(sql, directory));
    assert.equal((await sql`select to_regclass('records_inventory.must_rollback') object`)[0].object, null);
    assert.equal((await sql`select manifest->>'version' v from records_private.modules where id='inventory'`)[0].v, '1.1.0');
    assert.equal(Number((await sql`select count(*) n from records_private.module_migrations where module_id='inventory'`)[0].n), 2);
    // Applied migration edits must fail even with a newly matching file checksum.
    await rm(join(directory, 'migrations/0003_failure.sql'));
    const drifted = structuredClone(upgraded); drifted.version = '1.2.0';
    const changed = upgradeSql + ' -- altered applied migration';
    drifted.migrations[1].sha256 = createHash('sha256').update(changed).digest('hex');
    await writeFile(join(directory, 'migrations/0002_note.sql'), changed); await save(drifted);
    await assert.rejects(publish(sql, directory), /applied migration changed/);
    await writeFile(join(directory, 'migrations/0002_note.sql'), upgradeSql);
    const bundled = structuredClone(upgraded); bundled.id = 'work'; bundled.apiMajor = 2;
    bundled.scopes = ['work.read','work.write'];
    bundled.commands = {'work.register':{entity:'asset',scope:'work.write',handler:'records_inventory.apply(uuid,text,jsonb,bigint,bigint)'}};
    await save(bundled); await assert.rejects(publish(sql, directory), /bundled module/);
    await save(null); await assert.rejects(publish(sql, directory), /module must be an object/);
    await save(upgraded);
    const org = randomUUID(), principal = randomUUID(), datastore = randomUUID(), binding = randomUUID();
    await sql`insert into records_private.organisations(id,name) values(${org},'publication test')`;
    await sql`insert into records_private.principals(id) values(${principal})`;
    await sql`insert into records_private.memberships(org_id,id) values(${org},${principal})`;
    await sql`insert into records_private.datastores(id,org_id,module_id,api_major) values(${datastore},${org},'inventory',1)`;
    await sql`insert into records_private.bindings(id,datastore_id,principal_id,scopes) values(${binding},${datastore},${principal},ARRAY['inventory.read','inventory.write'])`;
    const claims = { iss:'records-gateway', aud:'records', sub:principal, org_id:org, datastore_id:datastore, binding_id:binding, scope:['inventory.read','inventory.write'], exp:Math.floor(Date.now()/1000)+300 };
    const runtime = <T>(run: (tx: TransactionSql) => Promise<T>) => sql.begin(async tx => {
      await tx.unsafe('set local role records_runtime');
      await tx`select set_config('request.jwt.claims',${JSON.stringify(claims)},true)`;
      return run(tx);
    });
    const outcome = await runtime(async tx => (await tx`select records_api.execute_command(${datastore}::uuid,'inventory',1,'inventory.register','{"label":"Laptop","serial":"INV-42"}'::jsonb,'publication-command',null) result`)[0].result);
    assert.equal(outcome.record.entity, 'asset'); assert.equal(outcome.seq, 1);
    assert.equal(outcome.record.data.serial, 'INV-42');
    const read = await runtime(async tx => (await tx`select records_api.read_records(${datastore}::uuid,'inventory',1) result`)[0].result);
    assert.ok(JSON.stringify(read).includes('INV-42'));
    assert.equal(Number((await sql`select count(*) n from records_private.journal where datastore_id=${datastore}`)[0].n),1);
  } finally { await db.stop(); await rm(directory, { recursive:true, force:true }); }
});
